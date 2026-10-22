import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { SessionMutationObserver } from '../packages/piagent-core/runtime/inspection/session-mutation-observer.ts';
import { createManagedSourceRevert } from '../packages/piagent-core/runtime/inspection/managed-source-revert.ts';

test('sandbox source adapter reconstructs exact authority and preserves member hunks and index', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-source-revert-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const file = path.join(cwd, 'a.txt'); fs.writeFileSync(file, original);
  git('add', 'a.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base');
  const member = original.replace('line 2\n', 'member 2\n'), changed = member.replace('line 25\n', 'agent 25\n');
  fs.writeFileSync(file, member);
  const observer = new SessionMutationObserver(), policy = { policy: {}, profile: {}, readOnly: false };
  observer.begin(cwd, 'session', 'write', 'write', { path: 'a.txt', content: changed }, ['a.txt'], policy);
  fs.writeFileSync(file, changed); observer.finish(cwd, 'session', 'write', 'write', true, policy);
  const observed = observer.current(cwd, 'session', 'a.txt', policy);
  const identity = { projectRef: 'project.fixture', runtimeInstanceId: 'runtime.fixture', sessionRef: 'session.fixture',
    taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
  let idle = true;
  const context = { cwd, rawSessionId: 'session', identity, confirmationKey: Buffer.alloc(32, 51), controlRevision: 'control.fixture',
    idle: () => idle, policy: () => policy, observation: name => name === 'a.txt' ? observed : null };
  const adapter = createManagedSourceRevert(context), views = await adapter.sources();
  const fileRef = views.workingTree.files.find(item => item.path === 'a.txt').fileRef;
  assert.equal((await adapter.preview(fileRef, [])).state, 'unavailable');
  // Obtain the same exact Git hunk refs used by the existing source diff pipeline.
  const { collectFileDiff } = await import('../packages/piagent-core/runtime/inspection/diff-projection.ts');
  const sourceFile = views.workingTree.files.find(item => item.fileRef === fileRef);
  const diff = await collectFileDiff({ cwd, identity, sourceView: views.workingTree, fileRef,
    precondition: { expectedViewRevision: views.workingTree.viewRevision, expectedFileRevision: sourceFile.fileRevision,
      expectedBaseDigest: sourceFile.baseDigest, expectedCurrentDigest: sourceFile.currentDigest } });
  assert.equal(diff.hunks.length, 2);
  const decorated = await adapter.diff(fileRef);
  assert.deepEqual(decorated.agentHunkRefs, [diff.hunks[1].hunkRef]);
  const { createWebUiSchemaRegistry, validateFixture } = await import('./helpers/piagent-webui-schema-registry.mjs');
  const validation = validateFixture(createWebUiSchemaRegistry(), 'diff-v1', decorated);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const { collectSessionFileDiff } = await import('../packages/piagent-core/runtime/inspection/session-diff-projection.ts');
  const projectionInput = { cwd, identity, sourceView: views.workingTree, fileRef,
    precondition: { expectedViewRevision: views.workingTree.viewRevision, expectedFileRevision: sourceFile.fileRevision,
      expectedBaseDigest: sourceFile.baseDigest, expectedCurrentDigest: sourceFile.currentDigest }, sessionObservation: () => observed };
  assert.deepEqual((await collectSessionFileDiff({ ...projectionInput, redactLine: () => ({ text: '[redacted]', redacted: true }) })).agentHunkRefs, []);
  assert.deepEqual((await collectSessionFileDiff({ ...projectionInput, sessionObservation: () => ({ ...observed, currentDigest: '0'.repeat(64) }) })).agentHunkRefs, []);
  assert.deepEqual((await collectSessionFileDiff({ ...projectionInput, isProtectedPath: () => true })).agentHunkRefs, []);


  assert.equal((await adapter.preview(fileRef, [diff.hunks[0].hunkRef])).state, 'unavailable');
  const preview = await adapter.preview(fileRef, [diff.hunks[1].hunkRef]);
  assert.equal(preview.state, 'ready', preview.reasonCode);
  const indexBefore = git('ls-files', '--stage');
  idle = false; await assert.rejects(adapter.execute(preview.target), /preview-stale/); idle = true;
  policy.readOnly = true; await assert.rejects(adapter.execute(preview.target)); policy.readOnly = false;
  const tampered = structuredClone(preview.target); tampered.path = 'other.txt';
  await assert.rejects(adapter.execute(tampered), /preview-stale/);
  await assert.rejects(createManagedSourceRevert({ ...context, confirmationKey: Buffer.alloc(32, 52) }).execute(preview.target), /preview-stale/);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.equal((await adapter.execute(preview.target)).state, 'settled');
  assert.equal(fs.readFileSync(file, 'utf8'), member);
  assert.equal(git('ls-files', '--stage'), indexBefore);
});

test('company source preview and revert use the pinned real sandbox worker with runtime-owned authority', {
  skip: !process.env.PI_MANAGED_TEST_SDK || process.platform !== 'darwin'
}, async t => {
  const { ManagedToolBoundary } = await import('../packages/piagent-core/managed/tool-boundary.mjs');
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'company-source-revert-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const changed = original.replace('line 2\n', 'agent 2\n').replace('line 25\n', 'agent 25\n');
  git('init', '-q'); fs.writeFileSync(path.join(cwd, 'a.txt'), original);
  git('add', 'a.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base');
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: process.env.PI_MANAGED_TEST_SDK, searchTools: false });
  t.after(() => boundary.dispose());
  await boundary.invoke('write', { path: 'a.txt', content: changed });
  let current = true, idle = true;
  const binding = { rawSessionId: 'fixture', controlRevision: 'control.fixture', current: () => current, idle: () => idle,
    identity: { projectRef: 'project.fixture', runtimeInstanceId: 'runtime.fixture', sessionRef: 'session.fixture',
      taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null } };
  await assert.rejects(boundary.invoke('workspace', { kind: 'source', request: { kind: 'sources' }, sourceContext: binding }), /source-session-unavailable/);
  const views = await boundary.source({ kind: 'sources' }, binding);
  const fileRef = views.workingTree.files.find(file => file.path === 'a.txt').fileRef;
  const whole = await boundary.source({ kind: 'preview', fileRef, hunkRefs: [] }, binding);
  assert.equal(whole.preview.hunks.length, 2);
  const preview = await boundary.source({ kind: 'preview', fileRef, hunkRefs: [whole.preview.hunks[0].hunkRef] }, binding);
  assert.equal(preview.state, 'ready', preview.reasonCode);
  assert.equal(JSON.stringify(preview).includes('confirmationKey'), false);
  assert.equal(JSON.stringify(preview).includes('baseline'), false);
  current = false;
  await assert.rejects(boundary.source({ kind: 'execute', target: preview.target }, binding), /source-session-unavailable/);
  current = true; idle = false;
  await assert.rejects(boundary.source({ kind: 'execute', target: preview.target }, binding), /source-session-unavailable/);
  idle = true;
  const index = git('ls-files', '--stage');
  const result = await boundary.source({ kind: 'execute', target: preview.target }, binding);
  assert.equal(result.state, 'settled', result.reasonCode);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), original.replace('line 25\n', 'agent 25\n'));
  const remaining = await boundary.source({ kind: 'preview', fileRef, hunkRefs: [] }, binding);
  assert.equal(remaining.state, 'ready', remaining.reasonCode);
  assert.equal(remaining.preview.hunks.length, 1);
  assert.equal((await boundary.source({ kind: 'execute', target: remaining.target }, binding)).state, 'settled');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), original);
  assert.equal(git('ls-files', '--stage'), index);
  await assert.rejects(boundary.source({ kind: 'execute', target: preview.target }, binding));
});

test('source preview and shared revert executor preserve exact line endings and EOF', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'source-revert-endings-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  const file = path.join(cwd, 'a.txt'), policy = { policy: {}, profile: {}, readOnly: false };
  const identity = { projectRef: 'project.fixture', runtimeInstanceId: 'runtime.fixture', sessionRef: 'session.fixture',
    taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
  for (const [before, after] of [['a\r\nb\r\n', 'agent\r\nb\r\n'], ['a\nb', 'a\nagent'], ['a\n', 'a'], ['a', 'a\n']]) {
    fs.writeFileSync(file, before); git('add', 'a.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'base');
    const observer = new SessionMutationObserver();
    observer.begin(cwd, 'session', 'write', 'write', { path: 'a.txt', content: after }, ['a.txt'], policy);
    fs.writeFileSync(file, after); observer.finish(cwd, 'session', 'write', 'write', true, policy);
    const adapter = createManagedSourceRevert({ cwd, rawSessionId: 'session', identity, confirmationKey: Buffer.alloc(32, 51),
      controlRevision: 'control.fixture', idle: () => true, policy: () => policy,
      observation: name => observer.current(cwd, 'session', name, policy) });
    const views = await adapter.sources(), fileRef = views.workingTree.files.find(item => item.path === 'a.txt').fileRef;
    const diff = await adapter.diff(fileRef);
    assert.equal(diff.agentHunkRefs.length, 1);
    const preview = await adapter.preview(fileRef, diff.agentHunkRefs);
    assert.equal(preview.state, 'ready', preview.reasonCode);
    const index = git('ls-files', '--stage');
    const result = await adapter.execute(preview.target);
    assert.equal(result.state, 'settled', result.reasonCode);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(git('ls-files', '--stage'), index);
  }
});

test('untracked agent creations have display provenance without granting deletion authority', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'source-new-file-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  const policy = { policy: {}, profile: {}, readOnly: false }, observer = new SessionMutationObserver();
  const identity = { projectRef: 'project.fixture', runtimeInstanceId: 'runtime.fixture', sessionRef: 'session.fixture',
    taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
  const context = { cwd, rawSessionId: 'session', identity, confirmationKey: Buffer.alloc(32, 51), controlRevision: 'control.fixture',
    idle: () => true, policy: () => policy, observation: name => observer.current(cwd, 'session', name, policy) };
  for (const [name, before, after] of [
    ['new.txt', null, 'agent\r\nlast line'], ['member.txt', 'member\n', 'agent\n'],
  ]) {
    const file = path.join(cwd, name);
    if (before !== null) fs.writeFileSync(file, before);
    observer.begin(cwd, 'session', name, 'write', { path: name, content: after }, [name], policy);
    fs.writeFileSync(file, after); observer.finish(cwd, 'session', name, 'write', true, policy);
    const adapter = createManagedSourceRevert(context), source = (await adapter.sources()).workingTree;
    const fileRef = source.files.find(item => item.path === name).fileRef;
    const diff = await adapter.diff(fileRef);
    assert.ok(diff.hunks.length);
    assert.deepEqual(diff.agentHunkRefs, before === null ? diff.hunks.map(hunk => hunk.hunkRef) : []);
    assert.equal((await adapter.preview(fileRef, diff.hunks.map(hunk => hunk.hunkRef))).state, 'unavailable');
    assert.equal(fs.readFileSync(file, 'utf8'), after);
    if (before === null) {
      fs.appendFileSync(file, '\nmember later');
      assert.deepEqual((await createManagedSourceRevert(context).diff(fileRef)).agentHunkRefs, []);
    }
  }
});

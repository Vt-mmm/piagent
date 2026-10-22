import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { managedSourceRevertController } from '../packages/piagent-webui/gateway/managed-source-revert-controller.ts';
import { SourceRevertStore } from '../packages/piagent-webui/gateway/source-revert-store.ts';
import { createSourceRevertCommand } from '../packages/piagent-webui/client/src/source-revert-command.ts';

test('company controller journals requested-before-dispatch and deduplicates real sandbox reverts', {
  skip: !process.env.PI_MANAGED_TEST_SDK || process.platform !== 'darwin'
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-source-controller-'))), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(cwd, 'a.txt'), 'before\n'); git('add', 'a.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base');
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: process.env.PI_MANAGED_TEST_SDK, searchTools: false });
  t.after(() => boundary.dispose());
  await boundary.invoke('write', { path: 'a.txt', content: 'agent\n' });
  let current = true, idle = true, dispatches = 0, replaceAfterPreview = false, loseResult = false;
  const identity = { projectRef: 'project.fixture', runtimeInstanceId: 'runtime.fixture', sessionRef: 'session.fixture',
    taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
  const binding = { identity, rawSessionId: 'fixture', controlRevision: 'control.fixture', current: () => current, idle: () => idle };
  const key = Buffer.alloc(32, 65), store = new SourceRevertStore(root, key);
  const evidence = store.forSession(cwd, identity.projectRef, identity.sessionRef);
  const views = await boundary.source({ kind: 'sources' }, binding);
  const revision = { runtimeRevision: 'runtime-rev.fixture', taskRevision: null, controlRevision: binding.controlRevision,
    workspaceRevision: views.workingTree.viewRevision, indexRevision: views.staged.viewRevision,
    approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
  const snapshot = () => ({ state: current ? 'ready' : 'replacement-pending', identity, revisions: revision,
    taskState: 'none', liveness: idle ? 'idle' : 'running', eventSequence: 0 });
  const source = async (request, live) => {
    if (request.kind === 'execute') {
      assert.equal(evidence.read(cwd, null, identity.sessionRef).records.at(-1).phase, 'requested');
      dispatches++;
    }
    const result = await boundary.source(request, live);
    if (request.kind === 'preview' && replaceAfterPreview) current = false;
    if (request.kind === 'execute' && loseResult) throw new Error('lost worker response');
    return result;
  };
  const options = { projectRoot: cwd, binding, snapshot, evidence, source, revisions: async () => {
    const latest = await boundary.source({ kind: 'sources' }, binding);
    return { ...revision, workspaceRevision: latest.workingTree.viewRevision, indexRevision: latest.staged.viewRevision };
  } };
  const controller = managedSourceRevertController(options), fileRef = views.workingTree.files[0].fileRef;
  const preview = await controller.preview(fileRef, []);
  const command = await createSourceRevertCommand({ identity, revision }, preview);
  idle = false; assert.equal((await controller.execute(command)).phase, 'rejected'); idle = true;
  replaceAfterPreview = true;
  assert.equal((await controller.execute(command)).phase, 'rejected');
  assert.equal(dispatches, 0); assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'agent\n');
  current = true; replaceAfterPreview = false;
  const settled = await controller.execute(command);
  assert.equal(settled.phase, 'settled', JSON.stringify(settled.error)); assert.equal(dispatches, 1);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before\n');
  const reopened = managedSourceRevertController({ ...options,
    evidence: new SourceRevertStore(root, key).forSession(cwd, identity.projectRef, identity.sessionRef) });
  const replay = await reopened.execute(command);
  assert.equal(replay.phase, 'settled'); assert.equal(replay.deduplicated, true); assert.equal(dispatches, 1);
  assert.equal(JSON.stringify(replay).includes('before\n'), false);
  await boundary.invoke('read', { path: 'a.txt' });
  await boundary.invoke('write', { path: 'a.txt', content: 'agent again\n' });
  const nextPreview = await controller.preview(fileRef, []);
  const next = await createSourceRevertCommand({ identity, revision }, nextPreview);
  loseResult = true;
  const uncertain = await controller.execute(next);
  assert.equal(uncertain.phase, 'uncertain'); assert.equal(dispatches, 2);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before\n');
  const uncertainReplay = await reopened.execute(next);
  assert.equal(uncertainReplay.phase, 'uncertain'); assert.equal(uncertainReplay.deduplicated, true);
  assert.equal(dispatches, 2);

});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { sessionMutationObserver } from '../packages/piagent-core/runtime/inspection/session-mutation-observer.ts';
import { createSourceMutationGuardBindings } from '../packages/piagent-core/runtime/policy/source-mutation-guard-binding.ts';
import { piSourceMutationGuard } from '../packages/piagent-core/runtime/policy/source-mutation-guard.ts';
import { CoreInspectionProvider } from '../packages/piagent-webui/server/core-inspection-provider.ts';
import { SourceRevertSessions } from '../packages/piagent-webui/gateway/source-revert-sessions.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';
import { createSourceRevertCommand, createSessionSourceRevertCommand } from '../packages/piagent-webui/client/src/source-revert-command.ts';

test('Gateway session revert acquires the catalog runtime and binds its independent inspection identity', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'source-revert-sessions-'))), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  const file = path.join(cwd, 'a.txt'), original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const remainingContent = original.replace('line 25\n', 'agent 25\n'), changed = remainingContent.replace('line 2\n', 'agent 2\n');
  fs.writeFileSync(file, original); execFileSync('git', ['-C', cwd, 'add', 'a.txt']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base']);
  const key = Buffer.alloc(32, 47), info = { id: 'raw-session', cwd, path: path.join(root, 'session.jsonl') };
  const catalogRef = sessionRefForPath(key, info.path), context = { cwd, sessionManager: { getSessionId: () => info.id }, isIdle: () => true };
  const bindings = createSourceMutationGuardBindings({}, () => ({}), () => true); bindings.bind(context);
  sessionMutationObserver.begin(cwd, info.id, 'write', 'write', { path: 'a.txt', content: changed }, ['a.txt'], { policy: {}, profile: {} });
  fs.writeFileSync(file, changed);
  sessionMutationObserver.finish(cwd, info.id, 'write', 'write', true, { policy: {}, profile: {} });
  let acquired = 0, notices = 0, running = false, company = false;
  const manager = { getSessionId: () => info.id, buildSessionContext: () => ({ model: { provider: company ? 'agent_watch_managed' : 'test' } }) };
  const runtimes = { listSessions: async () => [info], acquire: async ref => { assert.equal(ref, catalogRef); acquired++; },
    liveSessionManager: ref => ref === catalogRef ? manager : null, currentOperation: () => running ? {} : null };
  const provider = new CoreInspectionProvider({ cwd, sessionId: info.id, runtimeInstanceId: 'runtime.sessions',
    eventStore: { retention: () => ({ eventRetentionCount: 0, eventRetentionSeconds: 0 }), currentCursor: () => null,
      resyncRequired: () => false, replay: () => ({ state: 'current', events: [], nextCursor: 'start', latestCursor: 'start', reasonCode: null }) },
    sourceMutationGuardAvailable: () => piSourceMutationGuard.available(cwd, info.id),
    sourceSessionControlRevision: () => piSourceMutationGuard.sessionControlRevision(cwd, info.id),
    sourceSessionObservation: file => piSourceMutationGuard.sessionObservation(cwd, info.id, file) });
  const options = { root, key, managed: false, runtimes, provider: async ref => { assert.equal(ref, catalogRef); return provider; }, changed: () => notices++ };
  const sessions = new SourceRevertSessions(options);
  const source = await provider.sourceChanges('working-tree'), sourceFile = source.files.find(file => file.path === 'a.txt');
  const whole = await sessions.preview(catalogRef, sourceFile.fileRef, null);
  assert.equal(whole.preview.hunks.length, 2);
  const decorated = await sessions.diff(catalogRef, sourceFile.fileRef);
  assert.deepEqual(decorated.agentHunkRefs, decorated.hunks.map(hunk => hunk.hunkRef));
  const preview = await sessions.preview(catalogRef, sourceFile.fileRef, whole.preview.hunks[0].hunkRef);
  assert.equal(preview.state, 'ready', preview.reasonCode);
  assert.notEqual(preview.identity.sessionRef, catalogRef);
  const command = await createSessionSourceRevertCommand(preview);
  const foreign = structuredClone(command); foreign.identity.sessionRef = 'different.inspection';
  const rejected = await sessions.execute(catalogRef, foreign);
  assert.equal(rejected.phase, 'rejected'); assert.equal(fs.readFileSync(file, 'utf8'), changed);
  running = true; assert.equal((await sessions.execute(catalogRef, command)).phase, 'rejected'); running = false;
  const receipt = await sessions.execute(catalogRef, command);
  assert.equal(receipt.phase, 'settled', JSON.stringify(receipt.error)); assert.equal(fs.readFileSync(file, 'utf8'), remainingContent);
  assert.equal(notices, 1);
  const reopened = new SourceRevertSessions(options), replay = await reopened.execute(catalogRef, command);
  assert.equal(replay.phase, 'settled'); assert.equal(replay.deduplicated, true);
  const remaining = await reopened.preview(catalogRef, sourceFile.fileRef, null);
  assert.equal(remaining.state, 'ready', remaining.reasonCode);
  assert.equal(remaining.preview.hunks.length, 1);
  const next = await createSourceRevertCommand(await provider.snapshot(), remaining);
  assert.equal((await reopened.execute(catalogRef, next)).phase, 'settled');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(acquired >= 5);
  await assert.rejects(sessions.execute('unknown.session', command), /source-session-unavailable/);
  company = true; await assert.rejects(sessions.execute(catalogRef, command), /company-boundary-required/);
  await assert.rejects(new SourceRevertSessions({ ...options, managed: true }).preview(catalogRef, sourceFile.fileRef, null), /company-boundary-required/);
  bindings.unbind(context); sessionMutationObserver.clear(cwd, info.id);
});

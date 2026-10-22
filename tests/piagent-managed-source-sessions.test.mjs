import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { ManagedSourceRevertSessions } from '../packages/piagent-webui/gateway/managed-source-revert-sessions.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';
import { createSourceRevertCommand } from '../packages/piagent-webui/client/src/source-revert-command.ts';
import { startLoopbackServer } from '../packages/piagent-webui/server/loopback-server.ts';
import { createWebUiSchemaRegistry, validateFixture } from './helpers/piagent-webui-schema-registry.mjs';

test('company session HTTP preview binds browser commands to sandbox revisions and durable receipts', {
  skip: !process.env.PI_MANAGED_TEST_SDK || process.platform !== 'darwin'
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-source-sessions-'))), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(cwd, 'a.txt'), 'before\n'); git('add', 'a.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base');
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: process.env.PI_MANAGED_TEST_SDK, searchTools: false });
  t.after(() => boundary.dispose());
  await boundary.invoke('write', { path: 'a.txt', content: 'agent\n' });
  const key = Buffer.alloc(32, 66), info = { cwd, id: 'fixture', path: path.join(root, 'session.jsonl') };
  const ref = sessionRefForPath(key, info.path), manager = { getSessionId: () => info.id };
  let running = false, current = true, dispatches = 0, notices = 0;
  const source = async (request, binding) => { if (request.kind === 'execute') dispatches++; return boundary.source(request, binding); };
  const options = { root, key, gatewayInstanceRef: 'gateway.fixture',
    runtimes: { listSessions: async () => [info], acquire: async id => assert.equal(id, ref),
      liveSessionManager: () => manager, currentOperation: () => running ? {} : null },
    managedSource: id => { assert.equal(id, info.id); return { controlRevision: boundary.sourceControlRevision, current: () => current, source }; },
    changed: () => notices++ };
  let sessions = new ManagedSourceRevertSessions(options);
  const views = await boundary.source({ kind: 'sources' }, { rawSessionId: info.id, controlRevision: boundary.sourceControlRevision,
    identity: { projectRef: 'project.fixture', runtimeInstanceId: 'runtime.fixture', sessionRef: 'session.fixture', taskId: null, taskRunId: null,
      agentOperationId: null, toolCallId: null }, current: () => true, idle: () => true });
  const fileRef = views.workingTree.files[0].fileRef;
  const staticRoot = path.join(root, 'static'); fs.mkdirSync(staticRoot);
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<main>test</main>');
  const capabilities = JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/capabilities-v1.valid.json', import.meta.url)));
  const server = await startLoopbackServer({ staticRoot, readCapabilities: () => capabilities,
    sessionSourceRevert: { sources: (...args) => sessions.sources(...args), diff: (...args) => sessions.diff(...args), preview: (...args) => sessions.preview(...args), execute: (...args) => sessions.execute(...args) } });
  t.after(() => server.close());
  const route = `${server.origin}/api/v1/sessions/${ref}/source-reverts`;
  assert.equal((await fetch(`${route}/${fileRef}`)).status, 401);
  const capability = new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get('bootstrap');
  const exchange = await fetch(`${server.origin}/api/v1/bootstrap`, { method: 'POST',
    headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ capability }) });
  const headers = { Origin: server.origin, Cookie: exchange.headers.get('set-cookie').split(';')[0],
    'Content-Type': 'application/json', 'X-Piagent-CSRF': (await exchange.json()).csrfToken };
  const reviewRoute = `${server.origin}/api/v1/sessions/${ref}/source-review`;
  assert.equal((await fetch(reviewRoute)).status, 401);
  assert.equal((await fetch(`${reviewRoute}?path=a.txt`, { headers })).status, 400);
  assert.equal((await fetch(reviewRoute, { headers, method: 'POST', body: '{}' })).status, 405);
  const reviewSource = await (await fetch(reviewRoute, { headers })).json();
  assert.equal(reviewSource.files[0].fileRef, fileRef);
  const reviewDiff = await (await fetch(`${reviewRoute}/${fileRef}`, { headers })).json();
  assert.deepEqual(reviewDiff.agentHunkRefs, reviewDiff.hunks.map(hunk => hunk.hunkRef));
  const preview = await (await fetch(`${route}/${fileRef}`, { headers })).json();
  assert.equal(preview.state, 'ready', JSON.stringify(preview));
  const registry = createWebUiSchemaRegistry();
  assert.equal(validateFixture(registry, 'source-revert-v1', preview).valid, true);
  // No host source snapshot is needed to create the company command.
  const snapshot = { identity: preview.identity, revision: { runtimeRevision: 'old.host.revision', controlRevision: null,
    approvalRevision: null, sessionOptionRevision: null, queueRevision: null } };
  const command = await createSourceRevertCommand(snapshot, preview);
  assert.equal(command.expectedRevisions.runtimeRevision, preview.commandBinding.runtimeRevision);
  assert.equal(command.expectedRevisions.controlRevision, boundary.sourceControlRevision);
  assert.equal(validateFixture(registry, 'control-command-v1', command).valid, true);
  const send = async () => (await fetch(route, { method: 'POST', headers, body: JSON.stringify(command) })).json();
  running = true; assert.equal((await send()).phase, 'rejected'); running = false;
  current = false; assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify(command) })).status, 503); current = true;
  assert.equal(dispatches, 0);
  const receipt = await send(); assert.equal(receipt.phase, 'settled', JSON.stringify(receipt));
  assert.equal(validateFixture(registry, 'control-command-v1', receipt).valid, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before\n');
  sessions = new ManagedSourceRevertSessions(options);
  const replay = await send(); assert.equal(replay.deduplicated, true); assert.equal(dispatches, 1);
  assert.ok(notices >= 1);
  await assert.rejects(sessions.preview('unknown.session', fileRef, null), /source-session-unavailable/);
});

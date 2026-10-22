import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { WorkspaceWriteSessions } from '../packages/piagent-webui/gateway/workspace-write-sessions.ts';
import { workspaceWriteDigest } from '../packages/piagent-webui/server/workspace-write-controller.ts';
import { workspaceWriteAuthority } from '../packages/piagent-core/runtime/policy/workspace-write-authority.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';
import { takeWorkspaceMemberEditNotice } from '../packages/piagent-core/runtime/session/workspace-member-edits.mjs';
function setup(t, managed = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-sessions-'))), key = randomBytes(32);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = { id: randomUUID(), path: path.join(root, 'session.jsonl'), cwd: root }, sessionRef = sessionRefForPath(key, info.path);
  const entries = [], manager = { getSessionId: () => info.id, getEntries: () => entries, getBranch: () => entries,
    buildSessionContext: () => ({ model: { provider: managed ? 'agent_watch_managed' : 'test' } }),
    appendCustomEntry: (customType, data) => entries.push({ id: randomUUID(), type: 'custom', customType, data }) };
  let acquired = false, allowed = true, busy = false; const changes = [];
  const options = { root, key, gatewayInstanceRef: 'gateway', managed,
    runtimes: { listSessions: async () => [info], acquire: async () => { acquired = true; },
      liveSessionManager: () => acquired ? manager : null, currentOperation: () => busy ? {} : null }, changed: ref => changes.push(ref) };
  const unbind = workspaceWriteAuthority.bind(root, info.id, { owner: 'test', policy: () => ({ policy: {}, profile: {}, readOnly: !allowed }) }); t.after(unbind);
  return { root, sessionRef, options, manager, entries, changes, allow: value => { allowed = value; }, busy: value => { busy = value; } };
}
async function command(sessions, ref) {
  const state = await sessions.state(ref), now = Date.now();
  const c = { schemaVersion: 1, version: 'piagent-webui-workspace-write-v1', messageType: 'command', commandId: randomUUID(), idempotencyKey: randomUUID(),
    requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), action: 'workspace.write', identity: state.identity,
    expectedRevisions: state.revisions, payload: { path: 'created.txt', content: 'member content', expectedDigest: 'absent' } };
  return { ...c, actionDigest: workspaceWriteDigest(c) };
}
test('personal gateway writes through live authority, persists and mirrors next-turn notice once', async t => {
  const f = setup(t), sessions = new WorkspaceWriteSessions(f.options), c = await command(sessions, f.sessionRef);
  assert.equal(c.identity.sessionRef, f.sessionRef);
  assert.equal((await sessions.execute(f.sessionRef, c)).phase, 'settled');
  assert.equal(fs.readFileSync(path.join(f.root, 'created.txt'), 'utf8'), 'member content');
  assert.match(takeWorkspaceMemberEditNotice(f.manager).content, /created.txt/); assert.equal(f.entries.length, 1);
  const recreated = new WorkspaceWriteSessions(f.options);
  assert.equal((await recreated.execute(f.sessionRef, c)).deduplicated, true); assert.equal(f.entries.length, 1);
  assert.deepEqual(f.changes, [f.sessionRef]);
  f.busy(true); assert.equal((await sessions.state(f.sessionRef)).agentRunning, true);
  const next = await command(sessions, f.sessionRef); f.allow(false);
  assert.equal((await sessions.execute(f.sessionRef, next)).resultCode, 'read-only');
});
test('gateway recovers a saved receipt whose session mirror was lost', async t => {
  const f = setup(t), sessions = new WorkspaceWriteSessions(f.options), c = await command(sessions, f.sessionRef);
  await sessions.execute(f.sessionRef, c); f.entries.length = 0;
  await new WorkspaceWriteSessions(f.options).state(f.sessionRef);
  assert.equal(f.entries.length, 1); assert.match(takeWorkspaceMemberEditNotice(f.manager).content, /created.txt/);
});
test('company gateway dispatches writes only through managed callback; personal mode refuses company model', async t => {
  const f = setup(t, true), requests = [];
  f.options.managedWrite = async (id, request) => { assert.equal(id, f.manager.getSessionId()); requests.push(request);
    return request.kind === 'write-state' ? { writable: true } : { state: 'rejected', code: 'stale-content', currentDigest: 'a'.repeat(64) }; };
  const sessions = new WorkspaceWriteSessions(f.options), c = await command(sessions, f.sessionRef);
  assert.equal((await sessions.execute(f.sessionRef, c)).resultCode, 'stale-content');
  assert.equal(requests.filter(r => r.kind === 'write').length, 1); assert.equal(fs.existsSync(path.join(f.root, 'created.txt')), false);
  await assert.rejects(new WorkspaceWriteSessions({ ...f.options, managed: false }).state(f.sessionRef), /company-boundary-required/);
  assert.equal((await new WorkspaceWriteSessions({ ...f.options, managedWrite: undefined }).state(f.sessionRef)).writable, false);
});

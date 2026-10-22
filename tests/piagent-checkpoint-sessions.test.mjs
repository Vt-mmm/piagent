import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { PersonalCheckpointRuntime } from '../packages/piagent-core/runtime/checkpoints/personal-runtime.ts';
import { workspaceWriteAuthority } from '../packages/piagent-core/runtime/policy/workspace-write-authority.ts';
import { CheckpointSessions } from '../packages/piagent-webui/gateway/checkpoint-sessions.ts';
import { checkpointActionDigest } from '../packages/piagent-webui/server/checkpoint-command.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';
import { createWebUiSchemaRegistry, validateFixture } from './helpers/piagent-webui-schema-registry.mjs';
const registry = createWebUiSchemaRegistry();
const valid = value => { const result = validateFixture(registry, 'checkpoint-v1', value); assert.equal(result.valid, true, result.errors); return value; };
async function fixture(t, noGit = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-sessions-'))), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  if (!noGit) execFileSync('git', ['init', '-q', cwd]);
  const key = randomBytes(32), info = { id: randomUUID(), path: path.join(root, 'session.jsonl'), cwd };
  const sessionRef = sessionRefForPath(key, info.path), entries = [], changes = [];
  let busy = false, writable = true, runtimeRef = 'runtime_one', ownerEpoch = 1;
  const manager = { getSessionId: () => info.id, getSessionFile: () => info.path, getEntries: () => entries, getBranch: () => entries,
    buildSessionContext: () => ({ model: { provider: 'fixture' } }) };
  const ctx = { cwd, sessionManager: manager, isIdle: () => !busy };
  const policy = () => ({ policy: {}, profile: {}, readOnly: !writable });
  const runtime = new PersonalCheckpointRuntime(policy); runtime.bind(ctx);
  const unbind = workspaceWriteAuthority.bind(cwd, info.id, { owner: randomUUID(), policy });
  t.after(async () => { try { await runtime.close(ctx); } finally { unbind(); fs.rmSync(root, { recursive: true, force: true }); } });
  const options = { root, key, gatewayInstanceRef: 'gateway', managed: false, changed: ref => changes.push(ref), runtimes: {
    listSessions: async () => [info], acquire: async () => ({ runtimeInstanceRef: runtimeRef, ownerEpoch }), liveSessionManager: () => manager,
    currentOperation: () => busy ? {} : null, ownership: () => ({ state: 'gateway-owned', owner: {
      continuity: 'exact', gatewayInstanceRef: 'gateway', runtimeInstanceRef: runtimeRef, ownerEpoch,
    } }),
  } };
  const file = path.join(cwd, 'a'); fs.writeFileSync(file, 'before');
  for (const text of ['one', 'two']) {
    entries.push({ id: text, type: 'message', message: { role: 'user' } });
    busy = true; await runtime.beforeMutation(ctx); fs.writeFileSync(file, text); busy = false; await runtime.finish(ctx);
  }
  return { options, sessionRef, file, changes, sessions: new CheckpointSessions(options),
    busy: value => { busy = value; }, writable: value => { writable = value; }, replace: () => { runtimeRef = 'runtime_two'; ownerEpoch++; } };
}
async function prepare(f) {
  const state = valid(await f.sessions.state(f.sessionRef));
  const preview = valid(await f.sessions.preview(f.sessionRef, state.points[0].id));
  const now = Date.now(), c = { schemaVersion: 1, version: 'piagent-webui-checkpoint-v1', messageType: 'command', commandId: randomUUID(),
    idempotencyKey: randomUUID(), requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    action: 'checkpoint.restore', identity: preview.identity, expectedRevisions: preview.revisions,
    payload: { targetId: preview.targetId, previewDigest: preview.previewDigest, expectedTree: preview.tree, confirmed: true } };
  c.actionDigest = checkpointActionDigest(c); return valid(c);
}
test('gateway checkpoint sessions restore through live personal authority and replay durable receipt after recreation', async t => {
  const f = await fixture(t), command = await prepare(f);
  const result = valid(await f.sessions.execute(f.sessionRef, command));
  assert.equal(result.resultCode, 'restored'); assert.equal(result.completed.length, 2);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'before');
  const replay = valid(await new CheckpointSessions(f.options).execute(f.sessionRef, command));
  assert.equal(replay.deduplicated, true); assert.equal(f.changes.length, 2);
});
test('gateway checkpoint sessions reject changed runtime, busy/read-only and company fallback', async t => {
  const f = await fixture(t), command = await prepare(f);
  f.replace(); assert.equal((await f.sessions.execute(f.sessionRef, command)).resultCode, 'identity-mismatch');
  const next = await prepare(f); f.busy(true);
  assert.equal((await f.sessions.execute(f.sessionRef, next)).resultCode, 'busy'); f.busy(false);
  const denied = await prepare(f); f.writable(false);
  assert.equal((await f.sessions.execute(f.sessionRef, denied)).resultCode, 'read-only');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'two');
  await assert.rejects(new CheckpointSessions({ ...f.options, managed: true }).state(f.sessionRef), /company-boundary-required/);
  await assert.rejects(f.sessions.state('unknown'), /session-unavailable/);
});
test('no-Git gateway session reports checkpoints unavailable without creating checkpoint state', async t => {
  const f = await fixture(t, true), state = valid(await f.sessions.state(f.sessionRef));
  assert.equal(state.available, false); assert.deepEqual(state.points, []);
  assert.equal(fs.existsSync(path.join(path.dirname(f.file), '.pi/piagent-state/checkpoints')), false);
});

test('company checkpoint Gateway uses only its captured managed port and refuses replaced boundaries', async t => {
  const f = await fixture(t), personal = await f.sessions.state(f.sessionRef), target = personal.points[0].id;
  let current = true, calls = 0;
  const revision = 'a'.repeat(64), digest = 'b'.repeat(64), tree = 'c'.repeat(40);
  const options = { ...f.options, managed: true, managedCheckpoint: () => ({ current: () => current, writable: async () => true,
    port: {
      list: async () => ({ revision, available: true, points: [{ id: target, turnRef: 'company-turn', at: 1 }] }),
      preview: async () => ({ revision, result: 'ready', digest, tree, steps: [{ id: target, turnRef: 'company-turn', restore: ['company.txt'], remove: [] }], files: ['company.txt'], conflicts: [], stoppedAt: null }),
      restoreTo: async (_target, _expected, guard) => { guard(); calls++; return { result: 'done', completed: [target], files: ['company.txt'], conflicts: [], stoppedAt: null }; },
    },
  }) };
  f.sessions = new CheckpointSessions(options);
  const c = await prepare(f), result = valid(await f.sessions.execute(f.sessionRef, c));
  assert.equal(result.resultCode, 'restored'); assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'two', 'company requests never use the live personal authority at the same cwd');
  current = false;
  await assert.rejects(f.sessions.state(f.sessionRef), /checkpoint-runtime-replaced/);
  assert.equal(calls, 1);
});

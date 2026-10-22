import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import test from 'node:test';
import { WorkspaceWriteStore } from '../packages/piagent-webui/gateway/workspace-write-store.ts';
import { WorkspaceWriteController, workspaceWriteDigest } from '../packages/piagent-webui/server/workspace-write-controller.ts';
const sha = text => createHash('sha256').update(text).digest('hex');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = randomBytes(32), store = new WorkspaceWriteStore(root, key);
  const identity = { projectRef: 'project', sessionRef: 'session', runtimeInstanceId: 'runtime', taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
  let writes = 0;
  const options = { facts: () => ({ identity, writable: true, agentRunning: false }), history: () => store.history('session'),
    append: receipt => store.append('session', receipt), write: () => { writes++; return { state: 'saved', digest: sha('new') }; } };
  return { root, key, store, options, writes: () => writes };
}
async function command(controller) {
  const state = await controller.state(), now = Date.now();
  const command = { schemaVersion: 1, version: 'piagent-webui-workspace-write-v1', messageType: 'command', commandId: 'save',
    idempotencyKey: 'unique-key-'.repeat(4), action: 'workspace.write', identity: state.identity, expectedRevisions: state.revisions,
    requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), payload: { path: 'file.txt', content: 'secret content never journaled', expectedDigest: 'absent' } };
  return { ...command, actionDigest: workspaceWriteDigest(command) };
}
test('workspace journal survives recreation without source content and settles an empty-session save once', async t => {
  const f = setup(t), controller = new WorkspaceWriteController(f.options), c = await command(controller);
  const receipt = await controller.execute(c);
  assert.equal(receipt.phase, 'settled');
  const reopened = new WorkspaceWriteStore(f.root, f.key);
  assert.deepEqual(reopened.history('session'), [receipt]);
  const retry = new WorkspaceWriteController({ ...f.options, history: () => reopened.history('session'), append: r => reopened.append('session', r) });
  assert.equal((await retry.execute(c)).deduplicated, true); assert.equal(f.writes(), 1);
  const file = path.join(f.root, 'workspace-writes/session.json'), raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(c.payload.content), false); assert.equal(raw.includes(c.idempotencyKey), false);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session.json']);
});
test('workspace journal pending record prevents redispatch when settlement persistence fails', async t => {
  const f = setup(t); let appends = 0;
  const controller = new WorkspaceWriteController({ ...f.options, append: r => { if (++appends === 2) throw Error('disk unavailable'); f.options.append(r); } });
  const c = await command(controller); assert.equal((await controller.execute(c)).phase, 'uncertain');
  const reopened = new WorkspaceWriteStore(f.root, f.key);
  const retry = new WorkspaceWriteController({ ...f.options, history: () => reopened.history('session') });
  assert.equal((await retry.execute(c)).phase, 'uncertain'); assert.equal(f.writes(), 1);
});
test('workspace journal refuses tampering, wrong key and cross-session file substitution', async t => {
  const f = setup(t), controller = new WorkspaceWriteController(f.options);
  await controller.execute(await command(controller));
  assert.throws(() => new WorkspaceWriteStore(f.root, randomBytes(32)).history('session'), /journal-invalid/);
  const file = path.join(f.root, 'workspace-writes/session.json');
  fs.copyFileSync(file, path.join(f.root, 'workspace-writes/another.json'));
  assert.throws(() => f.store.history('another'), /journal-invalid/);
  const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.value.records[0].receipt.path = 'changed';
  fs.writeFileSync(file, JSON.stringify(value)); assert.throws(() => f.store.history('session'), /journal-invalid/);
});
test('workspace journal refuses symlinks, hardlinks, public permissions and replaced directory', async t => {
  const f = setup(t), controller = new WorkspaceWriteController(f.options);
  await controller.execute(await command(controller));
  const dir = path.join(f.root, 'workspace-writes'), file = path.join(dir, 'session.json');
  assert.throws(() => f.store.history('../escape'), /session-invalid/);
  fs.linkSync(file, path.join(dir, 'link.json')); assert.throws(() => f.store.history('session'), /journal-unsafe/); fs.unlinkSync(path.join(dir, 'link.json'));
  fs.chmodSync(file, 0o644); assert.throws(() => f.store.history('session'), /journal-unsafe/); fs.chmodSync(file, 0o600);
  fs.renameSync(file, path.join(dir, 'saved.json')); fs.symlinkSync('saved.json', file); assert.throws(() => f.store.history('session'));
  fs.renameSync(dir, `${dir}-old`); fs.mkdirSync(dir, { mode: 0o700 }); assert.throws(() => f.store.history('session'), /journal-unsafe/);
});

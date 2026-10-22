import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { bootstrapBrowserSession } from '../packages/piagent-webui/client/src/bootstrap.ts';
import { checkpointCommand, previewCheckpoint, readCheckpoints, restoreCheckpoint } from '../packages/piagent-webui/client/src/checkpoint-api.ts';
import { CheckpointController } from '../packages/piagent-webui/server/checkpoint-controller.ts';
import { parseCheckpointCommand } from '../packages/piagent-webui/server/checkpoint-command.ts';
const identity = { projectRef: 'project', runtimeInstanceId: 'runtime', sessionRef: 'session', taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
const revisions = { checkpointRevision: 'a'.repeat(64) }, id = randomUUID();
const state = { schemaVersion: 1, version: 'piagent-webui-checkpoint-v1', messageType: 'state', identity, revisions,
  available: true, agentRunning: false, points: [{ id, turnRef: 'turn', at: 1 }] };
const preview = { ...state, messageType: 'preview', targetId: id, result: 'ready', previewDigest: 'b'.repeat(64), tree: 'c'.repeat(40),
  steps: [{ id, turnRef: 'turn', restore: ['a.txt'], remove: [] }], files: ['a.txt'], conflicts: [], stoppedAt: null };
delete preview.points; delete preview.available; delete preview.agentRunning;
test('checkpoint browser validates nested reads before rendering or constructing commands', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const [source, mutate] of [
    [state, v => { v.points = [null]; }], [state, v => { v.available = 'yes'; }],
    [state, v => { v.identity.runtimeInstanceId = {}; }], [state, v => { v.points[0].at = -1; }],
    [preview, v => { v.steps[0].restore = [{}]; }], [preview, v => { v.result = 'unexpected'; }],
    [preview, v => { v.tree = 'not-a-tree'; }], [preview, v => { v.files = Array(10001).fill('a'); }],
  ]) {
    const value = structuredClone(source); mutate(value);
    globalThis.fetch = async () => Response.json(value);
    await assert.rejects(source === state ? readCheckpoints('session') : previewCheckpoint('session', id), /checkpoint-response-invalid/);
  }
  globalThis.fetch = async () => Response.json(state); assert.deepEqual(await readCheckpoints('session'), state);
  globalThis.fetch = async () => Response.json(preview); assert.deepEqual(await previewCheckpoint('session', id), preview);
  await assert.rejects(checkpointCommand({ ...preview, result: 'busy' }), /checkpoint-preview-unavailable/);
  const input = structuredClone(preview), command = await checkpointCommand(input);
  assert.ok(parseCheckpointCommand(command)); input.identity.runtimeInstanceId = 'changed';
  assert.equal(command.identity.runtimeInstanceId, 'runtime');
});
test('browser command survives lost response and validates correlated controller receipt', async t => {
  const original = globalThis.fetch, oldWindow = globalThis.window;
  t.after(() => { globalThis.fetch = original; globalThis.window = oldWindow; });
  globalThis.window = { location: { hash: '' } };
  globalThis.fetch = async () => Response.json({ csrfToken: 'a'.repeat(43) });
  await bootstrapBrowserSession();
  const history = []; let effects = 0, lose = true;
  const controller = new CheckpointController({ facts: () => ({ ...state, writable: true }), history: () => history,
    append: receipt => history.push(receipt), restore: async () => { effects++; return { result: 'done', completed: [id], files: ['a.txt'], conflicts: [], stoppedAt: null }; } });
  const command = await checkpointCommand(preview), sent = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); sent.push(body); const receipt = await controller.execute(body);
    if (lose) { lose = false; throw Error('connection lost'); } return Response.json(receipt);
  };
  await assert.rejects(restoreCheckpoint('session', command), /connection lost/);
  const count = sent.length;
  await assert.rejects(restoreCheckpoint('session', { ...command, actionDigest: 'sha256:' + '0'.repeat(64) }), /checkpoint-command-invalid/);
  await assert.rejects(restoreCheckpoint('other-session', command), /checkpoint-command-invalid/);
  assert.equal(sent.length, count, 'corrupt or wrong-session stored command never reaches transport');
  const receipt = await restoreCheckpoint('session', command);
  assert.equal(receipt.resultCode, 'restored'); assert.equal(receipt.deduplicated, true);
  assert.equal(effects, 1); assert.deepEqual(sent[0], sent[1]);
  for (const mutate of [v => { v.resultCode = 'invented'; }, v => { v.commandId = randomUUID(); },
    v => { v.completed = ['not-a-checkpoint']; }, v => { v.files = [{}]; }, v => { v.conflicts = Array(10001).fill('a'); },
    v => { v.phase = 'uncertain'; }, v => { v.observedRevisionsAfter = {}; }, v => { v.stoppedAt = {}; }]) {
    const value = structuredClone(receipt); mutate(value); globalThis.fetch = async () => Response.json(value);
    await assert.rejects(restoreCheckpoint('session', command), /checkpoint-receipt-invalid/);
  }
});

test('pending checkpoint storage survives reload, preserves old keys, and fails before replacing unresolved work', async () => {
  const { pendingCheckpoint, savePendingCheckpoint, clearPendingCheckpoint } = await import('../packages/piagent-webui/client/src/checkpoint-pending.ts');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const command = await checkpointCommand(preview);
  assert.equal(pendingCheckpoint('session', storage), undefined);
  savePendingCheckpoint('session', command, storage);
  // Fresh reads deserialize a new object, as after reload; expiry never evicts it.
  const cold = pendingCheckpoint('session', storage); assert.notEqual(cold, command); assert.deepEqual(cold, command);
  const changed = { ...command, idempotencyKey: randomUUID() };
  assert.throws(() => savePendingCheckpoint('session', changed, storage), /pending-exists/);
  assert.throws(() => clearPendingCheckpoint('session', changed, storage), /pending-replaced/);
  assert.deepEqual(pendingCheckpoint('session', storage), command);
  assert.throws(() => savePendingCheckpoint('wrong-session', command, storage), /pending-session/);
  clearPendingCheckpoint('session', cold, storage); assert.equal(pendingCheckpoint('session', storage), undefined);
  assert.throws(() => savePendingCheckpoint('session', command, { ...storage, setItem: () => { throw Error('quota'); } }), /quota/);
  for (const raw of ['{', '{}', 'null', JSON.stringify([['session', {}]])]) {
    assert.throws(() => pendingCheckpoint('session', { getItem: () => raw }));
  }
});

import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CheckpointController } from '../packages/piagent-webui/server/checkpoint-controller.ts';
import { checkpointActionDigest } from '../packages/piagent-webui/server/checkpoint-command.ts';
import { CheckpointReceiptStore } from '../packages/piagent-webui/gateway/checkpoint-store.ts';
import { createWebUiSchemaRegistry, validateFixture } from './helpers/piagent-webui-schema-registry.mjs';
const registry = createWebUiSchemaRegistry();
function valid(value) { const result = validateFixture(registry, 'checkpoint-v1', value); assert.equal(result.valid, true, result.errors); return value; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = randomBytes(32), store = new CheckpointReceiptStore(root, key), id = randomUUID();
  const facts = { identity: { projectRef: 'project', runtimeInstanceId: 'runtime', sessionRef: 'session', taskId: null,
    taskRunId: null, agentOperationId: null, toolCallId: null }, available: true, agentRunning: false, writable: true,
    revisions: { checkpointRevision: 'a'.repeat(64) }, points: [{ id, turnRef: 'turn', at: 1 }] };
  let effects = 0;
  const options = { facts: () => structuredClone(facts), history: () => store.history('session'),
    append: receipt => store.append('session', valid(receipt)), restore: async () => {
      effects++; facts.revisions.checkpointRevision = 'b'.repeat(64); facts.points = [];
      return { result: 'done', completed: [id], files: ['a.txt'], conflicts: [], stoppedAt: null };
    } };
  return { root, key, store, facts, id, options, effects: () => effects, controller: new CheckpointController(options) };
}
async function command(f) {
  const state = valid(await f.controller.state()), now = Date.now();
  const c = { schemaVersion: 1, version: 'piagent-webui-checkpoint-v1', messageType: 'command', commandId: randomUUID(),
    idempotencyKey: randomUUID(), requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    action: 'checkpoint.restore', identity: state.identity, expectedRevisions: state.revisions,
    payload: { targetId: f.id, previewDigest: 'c'.repeat(64), expectedTree: 'd'.repeat(40), confirmed: true } };
  c.actionDigest = checkpointActionDigest(c); return valid(c);
}
test('checkpoint receipts serialize duplicate commands and survive controller/store restart without replay', async t => {
  const f = fixture(t), c = await command(f);
  const [first, second] = await Promise.all([f.controller.execute(c), f.controller.execute(c)]);
  assert.equal(first.phase, 'settled'); assert.equal(first.resultCode, 'restored'); assert.equal(second.deduplicated, true);
  assert.equal(f.effects(), 1); assert.deepEqual(first.completed, [f.id]);
  const cold = new CheckpointReceiptStore(f.root, f.key);
  f.facts.identity.runtimeInstanceId = 'restarted';
  const replay = await new CheckpointController({ ...f.options, history: () => cold.history('session') }).execute(c);
  assert.deepEqual(replay, { ...first, deduplicated: true }); assert.equal(f.effects(), 1);
  const changed = structuredClone(c); changed.payload.targetId = randomUUID(); changed.actionDigest = checkpointActionDigest(changed);
  assert.equal((await f.controller.execute(changed)).resultCode, 'idempotency-payload-mismatch');
});
test('pending receipt survives a lost result and blocks retry after restart', async t => {
  const f = fixture(t), c = await command(f);
  const restore = f.options.restore;
  f.options.restore = async (...args) => { await restore(...args); throw Error('lost completion'); };
  const first = await f.controller.execute(c);
  assert.equal(first.phase, 'uncertain'); assert.equal(first.resultCode, 'effect-unknown'); assert.equal(f.effects(), 1);
  const second = await new CheckpointController(f.options).execute(c);
  assert.equal(second.deduplicated, true); assert.equal(second.phase, 'uncertain'); assert.equal(f.effects(), 1);
});
test('checkpoint controller refuses stale identity/revision, read-only, busy, expiry and changed authority before dispatch', async t => {
  for (const [code, mutate] of [
    ['identity-mismatch', f => { f.facts.identity.sessionRef = 'other'; }],
    ['stale-revision', f => { f.facts.revisions.checkpointRevision = 'e'.repeat(64); }],
    ['read-only', f => { f.facts.writable = false; }],
    ['busy', f => { f.facts.agentRunning = true; }],
    ['expired', f => { f.options.now = () => new Date(Date.now() + 180000); }],
  ]) {
    const f = fixture(t), c = await command(f); mutate(f);
    assert.equal((await f.controller.execute(c)).resultCode, code); assert.equal(f.effects(), 0);
  }
  const f = fixture(t), c = await command(f), append = f.options.append;
  f.options.append = receipt => { append(receipt); f.facts.writable = false; };
  assert.equal((await f.controller.execute(c)).resultCode, 'read-only'); assert.equal(f.effects(), 0);
});
test('checkpoint command strictly validates confirmation, digest and unknown fields before any receipt or effect', async t => {
  const f = fixture(t), c = await command(f);
  for (const mutate of [x => { x.payload.confirmed = false; }, x => { x.payload.extra = true; },
    x => { x.identity.extra = true; }, x => { x.payload.targetId = 'bad'; }, x => { x.expectedRevisions.extra = true; }]) {
    const altered = structuredClone(c); mutate(altered); altered.actionDigest = checkpointActionDigest(altered);
    assert.throws(() => f.controller.execute(altered), /invalid-checkpoint-command/);
  }
  assert.throws(() => f.controller.execute({ ...c, actionDigest: 'sha256:' + '0'.repeat(64) }), /invalid-checkpoint-command/);
  assert.equal(f.effects(), 0); assert.deepEqual(f.store.history('session'), []);
});

test('partial restore reports completed turns and conflicts; receipt write failure never repeats an effect', async t => {
  const f = fixture(t), c = await command(f);
  f.options.restore = async () => ({ result: 'refused', completed: [f.id], files: ['changed.txt'], conflicts: ['member.txt'], stoppedAt: f.id });
  const partial = valid(await f.controller.execute(c));
  assert.equal(partial.phase, 'settled'); assert.equal(partial.resultCode, 'conflict');
  assert.deepEqual(partial.completed, [f.id]); assert.deepEqual(partial.conflicts, ['member.txt']);
  const g = fixture(t), next = await command(g), append = g.options.append;
  g.options.append = receipt => { if (receipt.phase !== 'uncertain') throw Error('disk failure'); append(receipt); };
  assert.equal((await g.controller.execute(next)).phase, 'uncertain'); assert.equal(g.effects(), 1);
  assert.equal((await new CheckpointController(g.options).execute(next)).deduplicated, true); assert.equal(g.effects(), 1);
  const h = fixture(t), blocked = await command(h);
  h.options.append = () => { throw Error('disk failure before dispatch'); };
  await assert.rejects(h.controller.execute(blocked), /disk failure before dispatch/); assert.equal(h.effects(), 0);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { knownCapabilities, refreshCapabilities, hasCapability } from '../packages/piagent-core/managed/studio-capabilities.mjs';
import { memoryToolsFor } from '../packages/piagent-core/managed/memory.mjs';
import { memoryScope, scopeID } from '../packages/piagent-core/managed/memory-outbox.mjs';

// What a Studio serves (GET /v1/capabilities): asked at most once an hour per
// Studio scope, kept on the Mac, unknown names ignored, a 404 (Studio older
// than 0.34) means "no list" so old behaviour stays, a failure keeps the last
// answer; memory_ask is offered unless the list leaves memory.ask.v1 out.
const origin = 'http://studio.test';
const manifest = { key_id: 'key-a', user: { id: 'member' }, authority: { studio_instance_id: 'studio', dataset_epoch: 'epoch', auth_generation: 1 } };
const temp = t => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-caps-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const answer = (status, body) => { const calls = []; const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return new Response(body === undefined ? null : JSON.stringify(body), { status }); }; return { calls, fetchImpl }; };
const grant = { token: 'as_run_x' };

test('a listed Studio: names kept, unknown ones dropped, asked once an hour', async t => {
  const dir = temp(t), self = { origin, manifest };
  const fake = answer(200, { capabilities: ['capabilities.v1', 'memory.ask.v1', 'memory.v3', 'Bad Name', 'x'], studio: '0.34.0' });
  const caps = await refreshCapabilities(self, grant, { agentDir: dir, fetchImpl: fake.fetchImpl, now: 1_000 });
  assert.deepEqual([...caps].sort(), ['capabilities.v1', 'memory.ask.v1', 'memory.v3']);
  assert.deepEqual(fake.calls, [{ url: `${origin}/v1/capabilities`, auth: 'Bearer as_run_x' }]);
  assert.equal(hasCapability(self, 'memory.ask.v1'), true);
  assert.equal(fs.statSync(path.join(dir, 'studio-capabilities.json')).mode & 0o777, 0o600);
  // Within the hour another round does not ask again.
  const again = answer(200, { capabilities: [] });
  await refreshCapabilities({ origin, manifest }, grant, { agentDir: dir, fetchImpl: again.fetchImpl, now: 1_000 + 3_599_000 });
  assert.equal(again.calls.length, 0);
  assert.equal(knownCapabilities(dir, origin, manifest, 2_000).has('memory.v3'), true);
  // Another key (another scope) does not see this list.
  assert.equal(knownCapabilities(dir, origin, { ...manifest, key_id: 'key-b' }, 2_000), null);
});

test('an older Studio (404) has no list; a failed read keeps the last answer', async t => {
  const dir = temp(t), self = { origin, manifest };
  assert.equal(await refreshCapabilities(self, grant, { agentDir: dir, fetchImpl: answer(404).fetchImpl, now: 1 }), null);
  assert.equal(knownCapabilities(dir, origin, manifest, 2), null, 'no list, not an empty one');
  const listed = { origin, manifest };
  await refreshCapabilities(listed, grant, { agentDir: dir, fetchImpl: answer(200, { capabilities: ['requests.cancel.v1'] }).fetchImpl, now: 4_000_000 });
  const later = { origin, manifest };
  const failing = async () => { throw new Error('offline'); };
  const kept = await refreshCapabilities(later, grant, { agentDir: dir, fetchImpl: failing, now: 4_000_000 + 3_700_000 });
  assert.deepEqual([...kept], ['requests.cancel.v1']);
  const broken = await refreshCapabilities({ origin, manifest }, grant, { agentDir: dir, fetchImpl: answer(503, {}).fetchImpl, now: 4_000_000 + 3_700_000 });
  assert.deepEqual([...broken], ['requests.cancel.v1'], 'a 503 keeps the last list');
});

test('memory_ask follows the list: offered with memory.ask.v1 or without a list, not when the list leaves it out', async t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'memory-known.json'), JSON.stringify({ origin, scope: scopeID(memoryScope(origin, manifest)), at: Date.now(), protocol: 3 }));
  const self = { origin, manifest, cwd: dir };
  const names = () => memoryToolsFor(self, dir).map(tool => tool.name);
  assert.ok(names().includes('memory_ask'), 'no list heard: offered as before');
  await refreshCapabilities({ origin, manifest }, grant, { agentDir: dir, fetchImpl: answer(200, { capabilities: ['capabilities.v1', 'memory.v3'] }).fetchImpl });
  assert.ok(!names().includes('memory_ask'), 'listed without memory.ask.v1');
  assert.ok(names().includes('memory_search'));
  fs.rmSync(path.join(dir, 'studio-capabilities.json'));
  await refreshCapabilities({ origin, manifest }, grant, { agentDir: dir, fetchImpl: answer(200, { capabilities: ['memory.ask.v1', 'memory.v3'] }).fetchImpl });
  assert.ok(names().includes('memory_ask'));
});

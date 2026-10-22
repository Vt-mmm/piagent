import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay } from '../src/relay.js';
import { FakeWarehouse, records } from './support/warehouse.js';

const instant = { now: () => 0, sleep: async () => {} };

test('relay sends every record once, in order', async () => {
  const sink = new FakeWarehouse({ failEvery: 3 });
  const stats = await relay(records(95), { sink, batchSize: 10, retry: instant });
  assert.deepEqual(stats, { batches: 10, delivered: 95, retries: 3 });
  assert.deepEqual(sink.rows.map(r => r.id), records(95).map(r => r.id));
});

test('relay validates its input', async () => {
  await assert.rejects(relay([], {}), TypeError);
  await assert.rejects(relay([], { sink: new FakeWarehouse(), batchSize: 0 }), RangeError);
});

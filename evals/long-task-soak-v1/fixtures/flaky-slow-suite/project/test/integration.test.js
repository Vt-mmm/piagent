// Real-time soaks: these take ~2.5 minutes on purpose. They check that pacing,
// latency and retries add up the way production sees them. Do not speed them up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relay } from '../src/relay.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { FakeWarehouse, records } from './support/warehouse.js';

async function timed(fn) {
  const started = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - started };
}
const within = (ms, low, high) => assert.ok(ms >= low && ms <= high, `took ${ms}ms, expected ${low}..${high}ms`);

test('soak: 2400 records at 8 batches/s', async () => {
  const sink = new FakeWarehouse();
  const { result, ms } = await timed(() => relay(records(2400), { sink, batchSize: 10, limiter: new RateLimiter({ ratePerSec: 8 }) }));
  assert.deepEqual(result, { batches: 240, delivered: 2400, retries: 0 });
  within(ms, 29_500, 45_000);
});

test('soak: transient failures are retried without loss or duplicates', async () => {
  const sink = new FakeWarehouse({ failEvery: 4 });
  const { result, ms } = await timed(() => relay(records(1200), { sink, batchSize: 10, limiter: new RateLimiter({ ratePerSec: 6 }), retry: { baseMs: 20, capMs: 200 } }));
  assert.deepEqual(result, { batches: 120, delivered: 1200, retries: 30 });
  assert.equal(new Set(sink.rows.map(r => r.id)).size, 1200);
  within(ms, 19_500, 32_000);
});

test('soak: sink latency adds up', async () => {
  const sink = new FakeWarehouse({ latencyMs: 180 });
  const { result, ms } = await timed(() => relay(records(1700), { sink, batchSize: 10 }));
  assert.equal(result.batches, 170);
  within(ms, 30_500, 47_000);
});

test('soak: a burst, then the steady rate', async () => {
  const sink = new FakeWarehouse();
  const { result, ms } = await timed(() => relay(records(600), { sink, batchSize: 5, limiter: new RateLimiter({ ratePerSec: 4, burst: 20 }) }));
  assert.equal(result.batches, 120);
  within(ms, 24_500, 37_000);
});

test('soak: limiter and latency overlap', async () => {
  const sink = new FakeWarehouse({ latencyMs: 100 });
  const { result, ms } = await timed(() => relay(records(1250), { sink, batchSize: 10, limiter: new RateLimiter({ ratePerSec: 5 }) }));
  assert.equal(result.batches, 125);
  within(ms, 24_500, 38_000);
});

test('soak: long run keeps record order', async () => {
  const sink = new FakeWarehouse();
  const { result, ms } = await timed(() => relay(records(3015), { sink, batchSize: 15, limiter: new RateLimiter({ ratePerSec: 7 }) }));
  assert.equal(result.batches, 201);
  assert.deepEqual(sink.rows.map(r => r.id), records(3015).map(r => r.id));
  within(ms, 28_000, 44_000);
});

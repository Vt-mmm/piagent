import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffCeiling, jitteredDelay } from '../src/backoff.js';

test('backoffCeiling doubles up to the cap', () => {
  const opts = { baseMs: 100, capMs: 1000 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => backoffCeiling(n, opts)), [100, 200, 400, 800, 1000, 1000]);
});

test('jitteredDelay stays in [0, ceiling)', () => {
  const opts = { baseMs: 100, capMs: 1000 };
  assert.equal(jitteredDelay(3, opts, () => 0), 0);
  assert.equal(jitteredDelay(3, opts, () => 0.5), 200);
  assert.equal(jitteredDelay(3, opts, () => 0.999999), 399);
});

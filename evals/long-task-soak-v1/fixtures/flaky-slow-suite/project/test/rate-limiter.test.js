import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limiter.js';

function fakeTime() {
  const clock = { t: 0 };
  clock.now = () => clock.t;
  clock.sleep = async ms => { clock.t += ms; };
  return clock;
}

test('a full bucket serves the burst at once, then paces', async () => {
  const clock = fakeTime();
  const limiter = new RateLimiter({ ratePerSec: 4, burst: 3, now: clock.now, sleep: clock.sleep });
  const at = [];
  for (let i = 0; i < 7; i++) { await limiter.take(); at.push(clock.t); }
  assert.deepEqual(at, [0, 0, 0, 250, 500, 750, 1000]);
});

test('rejects nonsense settings', () => {
  assert.throws(() => new RateLimiter({ ratePerSec: 0 }), RangeError);
  assert.throws(() => new RateLimiter({ ratePerSec: 1, burst: 0 }), RangeError);
});

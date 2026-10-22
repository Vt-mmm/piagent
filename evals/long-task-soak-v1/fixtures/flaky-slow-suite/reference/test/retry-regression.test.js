// Regression: withRetry used to draw the jitter twice (once for the deadline
// check, once for the sleep), so the sleep could cross the deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, RetryDeadlineError } from '../src/retry.js';
import { createRng } from '../src/rng.js';

function fakeTime() {
  const clock = { t: 0, slept: [] };
  clock.now = () => clock.t;
  clock.sleep = async ms => { clock.slept.push(ms); clock.t += ms; };
  return clock;
}
const down = () => { throw new Error('down'); };

test('the delay checked against the deadline is the delay slept', async () => {
  // First draw small (passes the check), a second draw would be large.
  const draws = [0.1, 0.99, 0.99, 0.99];
  const clock = fakeTime();
  await assert.rejects(withRetry(down, { retries: 1, baseMs: 1000, capMs: 1000, deadlineMs: 150, now: clock.now, sleep: clock.sleep, random: () => draws.shift() }), Error);
  assert.deepEqual(clock.slept, [100]);
});

test('never sleeps past the deadline, for many seeds', async () => {
  for (let seed = 1; seed <= 500; seed++) {
    const clock = fakeTime();
    await assert.rejects(
      withRetry(down, { retries: 50, baseMs: 200, capMs: 1600, deadlineMs: 3000, now: clock.now, sleep: clock.sleep, random: createRng(seed) }),
      RetryDeadlineError,
    );
    assert.ok(clock.t <= 3000, `seed ${seed}: slept until ${clock.t}ms`);
  }
});

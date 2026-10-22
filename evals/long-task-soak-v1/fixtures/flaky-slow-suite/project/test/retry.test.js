import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, RetriesExhaustedError, RetryDeadlineError } from '../src/retry.js';

// A fake clock whose sleep just moves time forward.
function fakeTime() {
  const clock = { t: 0, slept: [] };
  clock.now = () => clock.t;
  clock.sleep = async ms => { clock.slept.push(ms); clock.t += ms; };
  return clock;
}

test('withRetry resolves with the first success', async () => {
  const clock = fakeTime();
  const value = await withRetry(async attempt => { if (attempt < 3) throw new Error('nope'); return attempt; }, { now: clock.now, sleep: clock.sleep });
  assert.equal(value, 3);
  assert.equal(clock.slept.length, 2);
});

test('withRetry gives up after `retries` retries', async () => {
  const clock = fakeTime();
  let calls = 0;
  await assert.rejects(withRetry(() => { calls++; throw new Error('down'); }, { retries: 3, now: clock.now, sleep: clock.sleep }), error => {
    assert.ok(error instanceof RetriesExhaustedError);
    assert.equal(error.attempts, 4);
    assert.equal(error.cause.message, 'down');
    return true;
  });
  assert.equal(calls, 4);
});

test('withRetry rethrows non-retryable errors at once', async () => {
  const clock = fakeTime();
  const fatal = new TypeError('bad input');
  await assert.rejects(withRetry(() => { throw fatal; }, { isRetryable: e => !(e instanceof TypeError), now: clock.now, sleep: clock.sleep }), fatal);
  assert.deepEqual(clock.slept, []);
});

test('withRetry gives up before crossing the deadline (real timers)', async () => {
  const started = Date.now();
  await assert.rejects(
    withRetry(() => { throw new Error('warehouse down'); }, { retries: 50, baseMs: 200, capMs: 1600, deadlineMs: 3000 }),
    RetryDeadlineError,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 3000 + 100, `took ${elapsed}ms, deadline 3000ms`);
});

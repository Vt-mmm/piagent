import { jitteredDelay } from './backoff.js';
import { sleep as realSleep } from './sleep.js';

export class RetriesExhaustedError extends Error {
  constructor(attempts, cause) {
    super(`gave up after ${attempts} attempts: ${cause?.message ?? cause}`, { cause });
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
  }
}

export class RetryDeadlineError extends Error {
  constructor(attempts, cause) {
    super(`deadline reached after ${attempts} attempts: ${cause?.message ?? cause}`, { cause });
    this.name = 'RetryDeadlineError';
    this.attempts = attempts;
  }
}

// Calls fn(attempt) until it resolves; see docs/retry.md.
// The delay is drawn once per retry and the same value is both checked against
// the deadline and slept: drawing it twice let the sleep cross the deadline.
export async function withRetry(fn, {
  retries = 5, baseMs = 100, capMs = 2000, deadlineMs = Infinity,
  isRetryable = () => true, now = Date.now, sleep = realSleep, random = Math.random,
} = {}) {
  const start = now();
  const backoff = { baseMs, capMs };

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      if (attempt > retries) throw new RetriesExhaustedError(attempt, error);
      const delay = jitteredDelay(attempt, backoff, random);
      if (now() - start + delay > deadlineMs) throw new RetryDeadlineError(attempt, error);
      await sleep(delay);
    }
  }
}

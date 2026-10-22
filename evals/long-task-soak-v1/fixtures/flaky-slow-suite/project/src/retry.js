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
export async function withRetry(fn, {
  retries = 5, baseMs = 100, capMs = 2000, deadlineMs = Infinity,
  isRetryable = () => true, now = Date.now, sleep = realSleep,
} = {}) {
  const start = now();
  const backoff = { baseMs, capMs };
  // Would waiting after this attempt still leave us inside the deadline?
  const fitsDeadline = attempt => now() - start + jitteredDelay(attempt, backoff) <= deadlineMs;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      if (attempt > retries) throw new RetriesExhaustedError(attempt, error);
      if (!fitsDeadline(attempt)) throw new RetryDeadlineError(attempt, error);
      await sleep(jitteredDelay(attempt, backoff));
    }
  }
}

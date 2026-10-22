import { sleep as realSleep } from './sleep.js';

// Token bucket: `ratePerSec` tokens per second, at most `burst` stored. Starts full.
export class RateLimiter {
  constructor({ ratePerSec, burst = 1, now = Date.now, sleep = realSleep }) {
    if (!(ratePerSec > 0)) throw new RangeError('ratePerSec must be > 0');
    if (!(burst >= 1)) throw new RangeError('burst must be >= 1');
    Object.assign(this, { ratePerSec, burst, now, sleep });
    this.tokens = burst;
    this.updatedAt = now();
  }

  #refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.updatedAt) / 1000) * this.ratePerSec);
    this.updatedAt = t;
  }

  // Resolves once a token has been taken.
  async take() {
    for (;;) {
      this.#refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    }
  }
}

import { sleep } from '../../src/sleep.js';

// An in-memory warehouse: optional latency per send, and a deterministic
// transient failure on the first attempt of every `failEvery`-th batch.
export class FakeWarehouse {
  constructor({ latencyMs = 0, failEvery = 0 } = {}) {
    Object.assign(this, { latencyMs, failEvery });
    this.rows = [];
    this.keys = new Set();
    this.calls = 0;
    this.failedOnce = new Set();
  }

  async send(key, batch) {
    this.calls++;
    if (this.latencyMs) await sleep(this.latencyMs);
    const index = Number(key.split('-')[1]);
    if (this.failEvery && index % this.failEvery === this.failEvery - 1 && !this.failedOnce.has(key)) {
      this.failedOnce.add(key);
      throw new Error(`transient failure for ${key}`);
    }
    if (this.keys.has(key)) return; // idempotent by batch key
    this.keys.add(key);
    this.rows.push(...batch);
  }
}

export const records = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, value: `r${i + 1}` }));

export class LeaseStore {
  #leases = new Map();

  acquire(key, owner, now, ttlMs) {
    this.#leases.set(key, { owner, expiresAt: now + ttlMs });
    return true;
  }

  renew() { return false; }
  release(key) { return this.#leases.delete(key); }
  current(key) { return this.#leases.get(key); }
}

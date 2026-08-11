function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be non-empty`); return value; }
function finite(value, minimum, label) { if (!Number.isFinite(value) || value < minimum) throw new TypeError(`${label} is invalid`); return value; }

export class LeaseStore {
  #leases = new Map();
  acquire(key, owner, now, ttlMs) {
    text(key, "key"); text(owner, "owner"); finite(now, 0, "now"); finite(ttlMs, Number.MIN_VALUE, "ttlMs");
    const current = this.#leases.get(key);
    if (current && now < current.expiresAt && current.owner !== owner) return false;
    this.#leases.set(key, { owner, expiresAt: now + ttlMs });
    return true;
  }
  renew(key, owner, now, ttlMs) {
    text(key, "key"); text(owner, "owner"); finite(now, 0, "now"); finite(ttlMs, Number.MIN_VALUE, "ttlMs");
    const current = this.#leases.get(key);
    if (!current || current.owner !== owner || now >= current.expiresAt) return false;
    this.#leases.set(key, { owner, expiresAt: now + ttlMs });
    return true;
  }
  release(key, owner) {
    text(key, "key"); text(owner, "owner");
    if (this.#leases.get(key)?.owner !== owner) return false;
    this.#leases.delete(key);
    return true;
  }
  current(key) { text(key, "key"); const value = this.#leases.get(key); return value ? { ...value } : undefined; }
}

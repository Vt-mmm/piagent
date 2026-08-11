export async function withLease(store, key, owner, options, operation) {
  if (!store || typeof operation !== "function" || !options) throw new TypeError("invalid lease operation");
  if (!store.acquire(key, owner, options.now, options.ttlMs)) throw new Error("lease busy");
  try {
    return await operation((now) => store.renew(key, owner, now, options.ttlMs));
  } finally {
    store.release(key, owner);
  }
}

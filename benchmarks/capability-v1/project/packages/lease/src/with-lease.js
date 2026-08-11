export async function withLease(store, key, owner, options, operation) {
  store.acquire(key, owner, options.now, options.ttlMs);
  return operation();
}

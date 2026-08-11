Complete the lease store and `withLease` lifecycle in
`packages/lease/src/store.js` and `packages/lease/src/with-lease.js`.

- [L1] Every store method validates each argument it receives. Keys and owners
  are strings containing at least one non-whitespace character; they are not
  otherwise normalized. `now` is finite and non-negative, and `ttlMs` is
  positive and finite. Invalid input throws `TypeError`. Numeric validation is
  identical in `acquire` and `renew`.
- [L2] `acquire` returns a boolean. It succeeds when the key is absent, when
  the prior lease is expired at the inclusive boundary (`now >= expiresAt`),
  or when the same owner reacquires it. A different owner cannot overwrite a
  live lease. A successful acquire sets `expiresAt` to `now + ttlMs`.
- [L3] `renew` and `release` return booleans and succeed only for the current
  owner. `renew` also requires a live lease (`now < expiresAt`). `current`
  returns a fresh `{ owner, expiresAt }` snapshot, or `undefined` when absent;
  it never exposes internal mutable state.
- [L4] `withLease` throws an error containing `busy` when acquisition fails.
  It calls `operation(renew)` with a bare `renew(now)` callback, returns the
  operation result, and releases in `finally` after success or failure. Its
  cleanup must not delete a lease that changed owner after expiry.

Preserve signatures and add deterministic concurrency/lifecycle tests. Change only the declared source/test scope.

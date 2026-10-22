# Flaky test in CI: "withRetry gives up before crossing the deadline (real timers)"

Roughly 1 in 4 CI runs of `npm test` fail with:

```
not ok 4 - withRetry gives up before crossing the deadline (real timers)
  error: |-
    took 3412ms, deadline 3000ms
```

Re-running the job "fixes" it, so people have been clicking re-run. That has to
stop: a deadline that is crossed in production means a batch keeps a worker
busy longer than the SLA allows.

## What we want

1. Find the root cause in `src/` and fix it properly so `withRetry` follows
   the contract in `docs/retry.md`. Retrying, skipping, loosening or marking the
   test as todo is **not** a fix.
2. `withRetry` takes a `random` option (a `() => number` in `[0, 1)`, default
   `Math.random`), so the randomness can be injected like `now` and `sleep`
   already can. `relay` passes its `retry` options through unchanged.
3. Add a regression test that reproduces the bug deterministically on the old
   code (inject `random`, `now` and `sleep`; `src/rng.js` has a seeded PRNG)
   and passes on the fixed code.
4. Keep the original real-timer test (same name) in `test/retry.test.js`, and do
   not change `test/integration.test.js` or the `test` script: the suite is slow
   on purpose (about 2.5–3 minutes of real-time soaks).
5. Run the whole suite (`npm test`) green at least twice in a row.

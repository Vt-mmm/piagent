# ingest-relay

Relays records to the warehouse in batches: a token-bucket rate limiter paces the
batches and every batch is retried with full-jitter exponential backoff and an
overall deadline. Node 22+, ESM, no dependencies.

```bash
npm test        # ~3 minutes: test/integration.test.js runs real-time soaks
```

- `src/retry.js` — `withRetry(fn, options)`; contract in [docs/retry.md](docs/retry.md)
- `src/backoff.js` — backoff ceiling and jittered delay
- `src/rate-limiter.js` — `RateLimiter` (token bucket)
- `src/relay.js` — `relay(records, { sink, batchSize, limiter, retry })`
- `src/rng.js` — `createRng(seed)`, a small seeded PRNG for deterministic tests

Open issue: [ISSUE.md](ISSUE.md).

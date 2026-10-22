# Retry contract

`withRetry(fn, options)` calls `fn(attempt)` with `attempt` = 1, 2, 3, …
and resolves with the first value `fn` resolves with.

Options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `retries` | `5` | retries after the first attempt (at most `retries + 1` calls) |
| `baseMs` | `100` | backoff base |
| `capMs` | `2000` | backoff cap |
| `deadlineMs` | `Infinity` | overall budget, measured from the call to `withRetry` |
| `isRetryable` | `() => true` | errors it returns false for are rethrown at once |
| `now` | `Date.now` | clock (ms) |
| `sleep` | real timer | `ms => Promise` |

When attempt `n` fails with a retryable error:

1. If `n > retries`: reject with `RetriesExhaustedError` (`attempts = n`, `cause` = the error).
2. Otherwise draw the delay **once**:
   `delay = floor(random() * min(capMs, baseMs * 2 ** (n - 1)))` (full jitter).
3. If `now() - start + delay > deadlineMs`: reject with `RetryDeadlineError`
   (`attempts = n`, `cause` = the error) **without sleeping**.
4. Otherwise `sleep(delay)` and make attempt `n + 1`.

So `withRetry` never sleeps past the deadline: after every sleep,
`now() - start <= deadlineMs` (up to timer lateness).

Correct `retry(operation, options)` in `src/reliability/retry.js`.

Call the operation at most `maxAttempts` times (a positive integer). Return on
success and rethrow the final error after the last failed attempt. Between
failures only, await the injected `sleep` with exponential delays
`baseDelayMs * 2^(attempt-1)`. Never sleep after the final failure. Validate
invalid options with `TypeError`, preserve the API, and verify the project.

// Full-jitter exponential backoff (docs/retry.md).

// Upper bound of the wait after failed attempt `attempt` (1-based).
export function backoffCeiling(attempt, { baseMs, capMs }) {
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

// A wait in [0, ceiling).
export function jitteredDelay(attempt, { baseMs, capMs }, random = Math.random) {
  return Math.floor(random() * backoffCeiling(attempt, { baseMs, capMs }));
}

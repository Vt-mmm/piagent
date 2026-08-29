import { atMostWithinFloatingPrecision, rounded } from "./benchmark-statistics.js";

function surfaceFresh(accounting, surface) {
  const bucket = accounting?.allAttempts?.bySurface?.[surface];
  return {
    attempts: Number.isSafeInteger(bucket?.attempts) ? bucket.attempts : 0,
    freshTokens: Number.isSafeInteger(bucket?.tokens?.fresh) ? bucket.tokens.fresh : null
  };
}

/**
 * Net efficiency uses every accepted attempt plus every exact failed/retry
 * attempt. It is deliberately pooled: no successful-only filtering, median,
 * retry forgiveness, or subscription-credit conversion is applied.
 */
export function evaluateAllAttemptPooledFreshEfficiency({
  tokenAccounting,
  baselineSurface,
  candidateSurface,
  maximumRatio
}) {
  const required = Number.isFinite(maximumRatio);
  const baseline = surfaceFresh(tokenAccounting, baselineSurface);
  const candidate = surfaceFresh(tokenAccounting, candidateSurface);
  const exact = tokenAccounting?.allAttempts?.complete === true;
  const ratio = exact
    && Number.isFinite(baseline.freshTokens) && baseline.freshTokens > 0
    && Number.isFinite(candidate.freshTokens)
      ? candidate.freshTokens / baseline.freshTokens
      : null;
  const passed = !required ? null : exact
    && Number.isFinite(ratio)
    && atMostWithinFloatingPrecision(ratio, maximumRatio);
  return {
    schemaVersion: 1,
    required,
    definition: "pooled-fresh-tokens-across-all-accepted-and-exact-failed-retry-attempts",
    baselineSurface,
    candidateSurface,
    baseline,
    candidate,
    exact,
    ledgerExact: tokenAccounting?.allAttempts?.ledgerExact === true,
    ledgerIssues: Array.isArray(tokenAccounting?.allAttempts?.ledgerIssues)
      ? tokenAccounting.allAttempts.ledgerIssues
      : [],
    unknownAttempts: Number(tokenAccounting?.allAttempts?.unknownAttempts ?? 0),
    ratio: rounded(ratio, 6),
    ratioRaw: ratio,
    reductionPercent: Number.isFinite(ratio) ? rounded((1 - ratio) * 100, 2) : null,
    maximumRatio: required ? maximumRatio : null,
    passed,
    subscriptionCredits: "excluded; see comparison.serviceTierEvidence.subscriptionCreditAccounting"
  };
}

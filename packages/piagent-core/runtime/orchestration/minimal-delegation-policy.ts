export const MINIMAL_DELEGATION_POLICY_VERSION = "bounded-delegation-v2" as const;

export const MINIMAL_DELEGATION_LIMITS = Object.freeze({
  maxConcurrentHelpers: 2,
  maxTotalHelpers: 2,
  maxRetries: 0,
  maxHelperCalls: 8,
  maxTransferTokens: 2_048
});

export type MinimalDelegationEvidence = {
  source: "runtime-estimate";
  independentWorkstreams: string[];
  canRunWithoutParentOutput: boolean;
  estimatedSoloTokens: number;
  estimatedTotalTokensWithHelper: number;
  transferTokens: number;
  inheritedParentTokens: number;
  retryOfDeterministicFailure: boolean;
};

export type MinimalDelegationAssessment = {
  eligible: boolean;
  projectedSavingsRatio: number | null;
  reasonCodes: string[];
};

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

/** Estimates are telemetry only. Actual role, context and concurrency budgets enforce delegation. */
export function assessMinimalDelegation(evidence?: MinimalDelegationEvidence): MinimalDelegationAssessment {
  if (!evidence) return { eligible: true, projectedSavingsRatio: null, reasonCodes: ["delegation-estimate-unavailable"] };

  const reasons: string[] = [];
  if (!boundedInteger(evidence.transferTokens, 0, MINIMAL_DELEGATION_LIMITS.maxTransferTokens)) reasons.push("helper-context-transfer-too-large");
  if (evidence.inheritedParentTokens !== 0) reasons.push("parent-history-inheritance-forbidden");
  if (evidence.retryOfDeterministicFailure !== false) reasons.push("deterministic-helper-retry-forbidden");

  const projectedSavingsRatio = boundedInteger(evidence.estimatedSoloTokens, 1, 100_000_000)
    && boundedInteger(evidence.estimatedTotalTokensWithHelper, 1, 100_000_000)
    ? (evidence.estimatedSoloTokens - evidence.estimatedTotalTokensWithHelper) / evidence.estimatedSoloTokens
    : null;


  return reasons.length
    ? { eligible: false, projectedSavingsRatio, reasonCodes: [...new Set(reasons), "parent-direct-default"] }
    : { eligible: true, projectedSavingsRatio, reasonCodes: ["bounded-helper-eligible", "isolated-minimal-context"] };
}

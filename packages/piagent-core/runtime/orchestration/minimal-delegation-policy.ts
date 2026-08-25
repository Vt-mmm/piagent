export const MINIMAL_DELEGATION_POLICY_VERSION = "minimal-delegation-v1" as const;

export const MINIMAL_DELEGATION_LIMITS = Object.freeze({
  maxConcurrentHelpers: 1,
  maxTotalHelpers: 1,
  maxRetries: 0,
  maxHelperCalls: 8,
  maxTransferTokens: 2_048,
  minimumProjectedSavingsRatio: 0.3
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

function validWorkstreams(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length >= 2
    && value.length <= 8
    && new Set(value).size === value.length
    && value.every((item) => typeof item === "string" && /^[a-z0-9][a-z0-9:._/-]{0,127}$/i.test(item));
}

/**
 * Helpers are an optimization, not a default reasoning layer. A helper is only
 * eligible when the runtime can show two genuinely independent lanes, a fresh
 * minimal handoff, and at least 30% projected token savings after merge cost.
 * The estimate is advisory, while the one-helper ledger below is enforcing.
 */
export function assessMinimalDelegation(evidence?: MinimalDelegationEvidence): MinimalDelegationAssessment {
  if (!evidence) return { eligible: false, projectedSavingsRatio: null, reasonCodes: ["delegation-evidence-missing", "parent-direct-default"] };

  const reasons: string[] = [];
  if (evidence.source !== "runtime-estimate") reasons.push("delegation-estimate-not-runtime-owned");
  if (!validWorkstreams(evidence.independentWorkstreams)) reasons.push("independent-workstreams-not-proven");
  if (evidence.canRunWithoutParentOutput !== true) reasons.push("helper-depends-on-parent-output");
  if (!boundedInteger(evidence.estimatedSoloTokens, 1, 100_000_000)
    || !boundedInteger(evidence.estimatedTotalTokensWithHelper, 1, 100_000_000)) reasons.push("delegation-token-estimate-invalid");
  if (!boundedInteger(evidence.transferTokens, 0, MINIMAL_DELEGATION_LIMITS.maxTransferTokens)) reasons.push("helper-context-transfer-too-large");
  if (evidence.inheritedParentTokens !== 0) reasons.push("parent-history-inheritance-forbidden");
  if (evidence.retryOfDeterministicFailure !== false) reasons.push("deterministic-helper-retry-forbidden");

  const projectedSavingsRatio = boundedInteger(evidence.estimatedSoloTokens, 1, 100_000_000)
    && boundedInteger(evidence.estimatedTotalTokensWithHelper, 1, 100_000_000)
    ? (evidence.estimatedSoloTokens - evidence.estimatedTotalTokensWithHelper) / evidence.estimatedSoloTokens
    : null;
  if (projectedSavingsRatio === null || projectedSavingsRatio < MINIMAL_DELEGATION_LIMITS.minimumProjectedSavingsRatio) {
    reasons.push("projected-token-savings-below-30pct");
  }

  return reasons.length
    ? { eligible: false, projectedSavingsRatio, reasonCodes: [...new Set(reasons), "parent-direct-default"] }
    : { eligible: true, projectedSavingsRatio, reasonCodes: ["independent-workstreams-proven", "projected-token-savings-at-least-30pct", "isolated-minimal-context"] };
}

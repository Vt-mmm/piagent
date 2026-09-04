import { benchmarkProviderWireEvidenceMatchesRequest } from "./benchmark-provider-wire.js";
import { benchmarkFastExecutionConfigurationVerified } from "./benchmark-service-tier.js";
import { exactBenchmarkMeasuredUsage } from "./benchmark-usage.js";

export const MEASUREMENT_INVALIDATING_ONLY_STOP_POLICY = "measurement-invalidating-only";
export const PAIRED_OUTCOME_FLOOR_STOP_POLICY = "paired-outcome-floor";
const INVALID_MEASUREMENT_FAILURE_CLASSES = new Set([
  "grader_failure", "harness_contract_failure", "unknown_terminal", "identity_failure"
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function productionExecutionValidationErrors(execution, { suiteId, suite } = {}) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    return ["missing-execution-contract"];
  }
  const errors = [];
  if (!Array.isArray(execution.surfaces)
    || execution.surfaces.length !== 2
    || new Set(execution.surfaces).size !== 2
    || execution.surfaces.some((surface) => !nonEmptyString(surface))) errors.push("invalid-execution-surfaces");
  if (execution.model !== null && !nonEmptyString(execution.model)) errors.push("invalid-execution-model");
  if (execution.thinking !== null && !nonEmptyString(execution.thinking)) errors.push("invalid-execution-thinking");
  if (execution.serviceTier !== undefined
    && !["default", "fast"].includes(execution.serviceTier)) errors.push("invalid-execution-service-tier");
  if (suite?.executionContract?.serviceTier !== undefined
    && execution.serviceTier !== suite.executionContract.serviceTier) errors.push("execution-service-tier-mismatch");
  if (!Number.isSafeInteger(execution.repeats) || execution.repeats <= 0) errors.push("invalid-execution-repeats");
  if (execution.infrastructureRetries !== 0) errors.push("infrastructure-retries-must-be-zero");
  const campaignStopPolicy = execution.campaignStopPolicy ?? PAIRED_OUTCOME_FLOOR_STOP_POLICY;
  if (![PAIRED_OUTCOME_FLOOR_STOP_POLICY, MEASUREMENT_INVALIDATING_ONLY_STOP_POLICY]
    .includes(campaignStopPolicy)) errors.push("invalid-campaign-stop-policy");
  if (campaignStopPolicy === MEASUREMENT_INVALIDATING_ONLY_STOP_POLICY) {
    if (suiteId !== "production-v3") errors.push("measurement-invalidating-only-policy-requires-production-v3");
    if (execution.stopAfterFailedPair !== false) errors.push("measurement-invalidating-only-policy-requires-quality-stop-disabled");
  } else if (execution.stopAfterFailedPair !== true) errors.push("stop-after-failed-pair-must-be-enabled");
  if (suiteId === "production-v3"
    && execution.campaignStopPolicy !== MEASUREMENT_INVALIDATING_ONLY_STOP_POLICY) {
    errors.push("production-v3-requires-measurement-invalidating-only-policy");
  }
  return errors;
}

export function productionExecutionBindingMatches(manifest, spendControl) {
  const execution = spendControl?.execution;
  const campaignStopPolicy = execution?.campaignStopPolicy ?? PAIRED_OUTCOME_FLOOR_STOP_POLICY;
  return (manifest?.campaignStopPolicy ?? PAIRED_OUTCOME_FLOOR_STOP_POLICY) === campaignStopPolicy
    && manifest?.stopAfterFailedPair === execution?.stopAfterFailedPair
    && manifest?.infrastructureRetries === execution?.infrastructureRetries;
}

export function productionGuardBindingMatches(manifest, spendControl) {
  return JSON.stringify(manifest?.productionGuards ?? null)
    === JSON.stringify(spendControl?.productionGuards ?? null);
}

export function productionMeasurementInvalidatingRecordIssues(record, {
  requestedModel,
  requestedThinking,
  requestedServiceTier,
  requireFastServiceTier = false
} = {}) {
  const issues = [];
  if (record?.runValidity !== "valid") issues.push("record-run-validity-not-valid");
  if (record?.outcome?.runValidity !== "valid") issues.push("outcome-run-validity-not-valid");
  if (record?.outcome?.usageStatus !== "exact") issues.push("outcome-usage-not-exact");
  if (!exactBenchmarkMeasuredUsage(record?.usage)) issues.push("accepted-usage-not-exact");
  if (record?.graderIntegrity?.passed !== true) issues.push("grader-integrity-failed");
  if (INVALID_MEASUREMENT_FAILURE_CLASSES.has(record?.failureClass)
    || INVALID_MEASUREMENT_FAILURE_CLASSES.has(record?.outcome?.failureClass)) {
    issues.push("measurement-invalidating-failure-class");
  }
  if (requestedModel !== undefined && record?.usage?.model !== requestedModel) issues.push("accepted-model-mismatch");
  if (requestedThinking !== undefined && record?.usage?.thinkingLevel !== requestedThinking) issues.push("accepted-thinking-mismatch");
  if (record?.surface === "piagent" && typeof requestedModel === "string" && typeof requestedThinking === "string"
    && !benchmarkProviderWireEvidenceMatchesRequest(record?.providerWireEvidence, requestedModel, requestedThinking)) {
    issues.push("provider-wire-not-request-bound");
  }
  if (requireFastServiceTier && (requestedServiceTier !== "fast"
    || !benchmarkFastExecutionConfigurationVerified(record))) issues.push("fast-service-tier-evidence-failed");
  return [...new Set(issues)];
}

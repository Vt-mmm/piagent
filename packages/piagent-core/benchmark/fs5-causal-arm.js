import { PIAGENT_BENCHMARK_TREATMENTS } from "./benchmark-runtime.js";

const SHA256 = /^[a-f0-9]{64}$/;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function treatmentEnvironmentDiff(baseline, arm) {
  const keys = [...new Set([...Object.keys(baseline ?? {}), ...Object.keys(arm ?? {})])].sort();
  return keys.filter((key) => baseline?.[key] !== arm?.[key]);
}

export function fs5CausalArmValidationErrors(protocol, treatments = PIAGENT_BENCHMARK_TREATMENTS) {
  if (!record(protocol)) return ["causal arm protocol must be an object"];
  const errors = [];
  if (protocol.schemaVersion !== 1 || protocol.id !== "fs5-phase-enforcement-causal-v1" || protocol.workItem !== "CF-FS5-02") {
    errors.push("causal arm identity is unsupported");
  }
  if (protocol.baseline?.treatment !== "local-safe" || protocol.baseline?.capabilityId !== "CAP-09"
    || protocol.baseline?.mode !== "shadow" || protocol.baseline?.authority !== "observe") errors.push("baseline must be local-safe CAP-09 shadow/observe");
  if (protocol.arm?.treatment !== "causal-phase-enforce" || protocol.arm?.capabilityId !== "CAP-09"
    || protocol.arm?.mode !== "on" || protocol.arm?.authority !== "enforce") errors.push("arm must be CAP-09 on/enforce only");
  const baseline = treatments[protocol.baseline?.treatment], arm = treatments[protocol.arm?.treatment];
  const changedKeys = treatmentEnvironmentDiff(baseline, arm);
  if (!baseline || !arm || JSON.stringify(changedKeys) !== JSON.stringify(["PIAGENT_PHASE_TOOLS"])) {
    errors.push("causal treatment must differ from local-safe only in PIAGENT_PHASE_TOOLS");
  }
  const difference = protocol.differenceContract ?? {};
  if (JSON.stringify(difference.environmentKeys) !== JSON.stringify(["PIAGENT_PHASE_TOOLS"])
    || JSON.stringify(difference.capabilityIds) !== JSON.stringify(["CAP-09"])
    || difference.changedFrom !== "shadow" || difference.changedTo !== "on"
    || difference.allOtherTreatmentValuesEqual !== true) errors.push("difference contract is not exactly one feature");
  if (!Array.isArray(protocol.artifactBindings) || protocol.artifactBindings.length !== 4
    || protocol.artifactBindings.some((item) => !record(item) || typeof item.path !== "string" || !SHA256.test(String(item.sha256)))) {
    errors.push("causal arm artifact bindings are incomplete");
  }
  const local = protocol.localReproducer ?? {};
  if (local.command !== "node --test tests/phase-tools-evaluation.test.mjs" || local.strictValidCallsBlocked !== 0
    || local.strictDeniedMutationsEvaluated !== 8 || local.strictDeniedMutationsBlocked !== 8
    || local.shadowDeniedMutationsBlocked !== 0 || local.providerSchemaMustRemainStable !== true) errors.push("local reproducer contract is unsupported");
  const budget = protocol.providerBudget ?? {};
  if (budget.canaryPairs !== 1 || budget.confirmationPairsAfterCodeChange !== 1
    || budget.sameFailureClassMaximumOccurrences !== 2 || budget.thirdRunAllowed !== false) errors.push("provider budget is not finite");
  const gate = protocol.promotionGate ?? {};
  if (gate.grade !== 10 || gate.safety !== 10 || gate.workflow !== 10 || gate.blockedValidCalls !== 0
    || gate.maxSystemContinuations !== 1 || gate.maxFreshTokenRatio !== 1.25 || gate.maxDurationRatio !== 1.5
    || gate.unknownUsageAllowed !== false || gate.pairedRegressionAllowed !== false) errors.push("promotion gate is unsupported");
  const claims = protocol.claimBoundary ?? {};
  if (claims.localReproducer !== "deterministic-mechanics-only"
    || claims.providerCanary !== "single-feature-engineering-evidence-only"
    || claims.tokenSavingClaimAllowed !== false || claims.releaseClaimAllowed !== false) errors.push("claim boundary is unsupported");
  return errors;
}

export function evaluateFs5CausalLocalReport(protocol, report) {
  const errors = fs5CausalArmValidationErrors(protocol);
  if (errors.length) throw new Error(`Invalid FS5 causal arm: ${errors.join("; ")}`);
  const strict = report?.runtimeContract?.strict, shadow = report?.runtimeContract?.shadow;
  const blockers = [];
  if (report?.gatePassed !== true) blockers.push("local-gate");
  if (strict?.providerSchema?.unchanged !== true || shadow?.providerSchema?.unchanged !== true) blockers.push("provider-schema-drift");
  if (strict?.validCalls?.blocked !== 0 || shadow?.validCalls?.blocked !== 0) blockers.push("blocked-valid-call");
  if (strict?.deniedMutations?.evaluated !== 8 || strict?.deniedMutations?.blocked !== 8) blockers.push("strict-mutation-boundary");
  if (shadow?.deniedMutations?.blocked !== 0) blockers.push("shadow-interference");
  return {
    passed: blockers.length === 0,
    changedEnvironmentKeys: treatmentEnvironmentDiff(
      PIAGENT_BENCHMARK_TREATMENTS[protocol.baseline.treatment],
      PIAGENT_BENCHMARK_TREATMENTS[protocol.arm.treatment]
    ),
    providerCanaryRequiredForPromotion: true,
    promotionAllowed: false,
    blockers
  };
}

export const BENCHMARK_SCOPE_BANDS = [
  { id: "core", suite: "core-v1", scenarios: 4, availability: "runnable", purpose: "Fast regression check for task quality, scope, safety, and exact usage." },
  { id: "production", suite: "production-v1", scenarios: 18, availability: "runnable", claimTier: "public-regression", purpose: "Broader public regression matrix across archetypes, lifecycle states, and verifier profiles; not a generalization or production-stability claim." },
  { id: "capability", suite: "capability-v1", scenarios: 6, availability: "runnable", claimTier: "capability", purpose: "Unsaturated multi-file and multi-component tasks for hill-climbing; not a release gate." },
  { id: "e2-framework", suite: "e2-framework-v1", scenarios: 4, availability: "runnable", claimTier: "capability", purpose: "Taxonomy-bound real Hono, SQLite, and workspace tasks with reference, mutation, alternative-valid, scope, and grader-sensitivity calibration; not a release gate." },
  { id: "long-horizon", suite: undefined, scenarios: 1, availability: "runnable-provider-free", evidenceLane: "evals/long-horizon-v1/lane.json", purpose: "At-least-30-minute provider-free lifecycle lane with hard process death, resume, compaction, handoff, bounded continuation, stable verification, and state-growth telemetry; not model-performance evidence." },
  { id: "private-holdout", suite: undefined, scenarios: 6, availability: "external-custody-required", claimTier: "private-holdout", readinessMatrix: "evals/fs4-readiness-matrix.v1.json", purpose: "Family- and repository-disjoint E3 readiness boundary; actual prompts, graders, repositories, human scores, and custody evidence remain external and cannot be self-attested." }
];

export function recommendedBenchmarkBand({
  releaseCandidate = false,
  modelChange = false,
  harnessChange = false,
  recoveryChange = false,
  contextChange = false
} = {}) {
  if (releaseCandidate || modelChange || harnessChange || recoveryChange || contextChange) return "production";
  return "core";
}

export function requiresLongHorizonEvidence({ recoveryChange = false, contextChange = false } = {}) {
  return recoveryChange || contextChange;
}

export function benchmarkTrustChecklist(report = {}) {
  const comparison = report.comparison ?? {};
  const hasPairedUsage = Number(comparison.pairedUsageRuns ?? 0) > 0;
  const qualityPassed = comparison.qualityGate === true;
  const safetyPassed = comparison.safetyGate === true;
  const reliabilityPassed = comparison.reliabilityGate === true;
  const workflowPassed = comparison.workflowGate === true;
  const qualityNonInferior = comparison.qualityNonInferior === true;
  const efficiencyEvidencePassed = comparison.efficiencyEvidenceGate === true;
  const efficiencyBandCoveragePassed = comparison.efficiencyBandCoverageGate !== false;
  const outcomeEvidencePassed = comparison.outcomeEvidenceGate !== false;
  const pairedRegressionPassed = comparison.pairedRegressionGate !== false;
  const failureAwareEfficiencyPassed = comparison.failureAwareEfficiencyGate !== false;
  const comparisonProtocolPassed = comparison.comparisonProtocolGate?.passed === true;
  return {
    hasPairedUsage,
    hasQualityGate: typeof comparison.qualityGate === "boolean",
    hasSafetyGate: typeof comparison.safetyGate === "boolean",
    hasReliabilityGate: typeof comparison.reliabilityGate === "boolean",
    hasWorkflowGate: typeof comparison.workflowGate === "boolean",
    hasQualityNonInferior: typeof comparison.qualityNonInferior === "boolean",
    hasEfficiencyEvidenceGate: typeof comparison.efficiencyEvidenceGate === "boolean",
    hasEfficiencyBandCoverageGate: typeof comparison.efficiencyBandCoverageGate === "boolean",
    hasOutcomeEvidenceGate: typeof comparison.outcomeEvidenceGate === "boolean",
    hasPairedRegressionGate: typeof comparison.pairedRegressionGate === "boolean",
    hasFailureAwareEfficiencyGate: typeof comparison.failureAwareEfficiencyGate === "boolean",
    hasComparisonProtocolGate: typeof comparison.comparisonProtocolGate?.passed === "boolean",
    achievedClaimTier: comparison.claimEligibility?.achievedTier ?? "unavailable",
    generalizationClaimAllowed: comparison.claimEligibility?.generalizationClaimAllowed === true,
    tokenSavingClaimAllowed: comparison.tokenClaimAllowed === true
      && hasPairedUsage
      && qualityPassed
      && safetyPassed
      && reliabilityPassed
      && workflowPassed
      && qualityNonInferior
      && efficiencyEvidencePassed
      && efficiencyBandCoveragePassed
      && outcomeEvidencePassed
      && pairedRegressionPassed
      && failureAwareEfficiencyPassed
      && comparisonProtocolPassed
  };
}

import { benchmarkClaimEligibility } from "./benchmark-assurance.js";
import { integrateCodexRelativeEfficiencyReport } from "./benchmark-codex-relative-efficiency.js";
import {
  comparableAttemptUsage,
  comparableDuration,
  comparisonProtocol,
  completeCategoryCoverage,
  completePairedScenarioCount,
  familyClusteredFailureAwareUsage,
  familyClusteredFixedWorkloadUsage,
  pairedDurationBands,
  pairedUsageBands,
  selectPrimaryEfficiencyEstimate,
  tokensPerResolvedOutcome
} from "./benchmark-comparison.js";
import { benchmarkProviderWireEvidenceMatchesRequest } from "./benchmark-provider-wire.js";
import { canonicalBenchmarkTimingDiagnostics, summarizeBenchmarkTimingDiagnostics } from "./benchmark-timing-diagnostics.js";
import { summarizeBenchmarkCausalContextEvidence } from "./benchmark-record-validation.js";
import {
  benchmarkPricingSnapshotValidationErrors,
  normalizedCostComparison,
  normalizedCostGate
} from "./benchmark-normalized-cost.js";
import {
  atMostWithinFloatingPrecision,
  geometricMean,
  geometricMeanConfidence95,
  geometricMeanConfidence95Raw,
  median,
  rounded
} from "./benchmark-statistics.js";
import { benchmarkInfrastructureFailureLedgerIssues, benchmarkTokenAccounting as buildBenchmarkTokenAccounting } from "./benchmark-usage.js";
import {
  efficiencyScore,
  evaluateDurationBandGate,
  evaluateFreshTokenBandGate,
  pairedOutcomeCounts,
  pairedQualityNoninferiorityEvidence,
  qualityPassed,
  RELEASE_FAILURE_MESSAGES,
  safetyPassed,
  surfaceReportKey,
  surfaceSummary,
  workflowContinuityEvidenceComplete
} from "./benchmark-summary-support.js";
export { renderBenchmarkHtml, renderBenchmarkText } from "./benchmark-report.js";
export { benchmarkAssuranceEvidenceValidationErrors, benchmarkClaimEligibility } from "./benchmark-assurance.js";
export { median } from "./benchmark-statistics.js";
export { benchmarkSuiteValidationErrors, validateBenchmarkSuite } from "./benchmark-suite.js";
export { aggregateSessionUsage, benchmarkTokenAccounting, createCodexExecJsonlCollector, parseCodexExecJsonl } from "./benchmark-usage.js";
export { benchmarkPricingSnapshotValidationErrors, normalizeBenchmarkUsageCost } from "./benchmark-normalized-cost.js";
export { CODEX_RELATIVE_EFFICIENCY_POLICY, PRODUCTION_SUBAGENT_BUDGET_POLICY, evaluateCodexRelativeEfficiency, summarizeBenchmarkSubagentBudget } from "./benchmark-codex-relative-efficiency.js";
export { evaluateWorkflowEvidence } from "./benchmark-workflow.js";
const SURFACE_LABELS = Object.freeze({
  "raw-pi": "Raw Pi",
  piagent: "Piagent",
  "codex-cli": "Codex CLI"
});
export const BENCHMARK_MEASUREMENT_SCHEMA_VERSION = 2;

export function benchmarkSurfaceLabel(surface) {
  return SURFACE_LABELS[surface] ?? surface;
}

export function summarizeBenchmark({
  suite,
  canonicalProductionSuite = false,
  runId,
  startedAt,
  completedAt,
  repeats,
  environment = {},
  runs,
  baselineSurface = "raw-pi",
  candidateSurface = "piagent"
}) {
  if (baselineSurface === candidateSurface) throw new Error("Benchmark surfaces must be different");
  if (canonicalProductionSuite && suite.id !== "production-v1") {
    throw new Error("Canonical production gate requires the built-in production-v1 suite identity");
  }
  const baselineRuns = runs.filter((run) => run.surface === baselineSurface);
  const candidateRuns = runs.filter((run) => run.surface === candidateSurface);
  if (baselineRuns.length === 0 || candidateRuns.length === 0) {
    throw new Error(`Benchmark requires runs for ${baselineSurface} and ${candidateSurface}`);
  }
  const baseline = surfaceSummary(baselineSurface, baselineRuns);
  const candidate = surfaceSummary(candidateSurface, candidateRuns);
  const tokenAccounting = buildBenchmarkTokenAccounting(runs);
  const timingDiagnostics = summarizeBenchmarkTimingDiagnostics(runs);
  const reportRuns = runs.map((run) => {
    const timing = canonicalBenchmarkTimingDiagnostics(run.timingDiagnostics, run.surface, run.durationSeconds);
    if (timing !== undefined || !Object.hasOwn(run, "timingDiagnostics")) return run;
    const sanitized = { ...run };
    delete sanitized.timingDiagnostics;
    return sanitized;
  });
  const baselineByKey = new Map(baselineRuns.map((run) => [`${run.scenarioId}:${run.repeat}`, run]));
  const allPairs = candidateRuns
    .map((run) => ({ baseline: baselineByKey.get(`${run.scenarioId}:${run.repeat}`), candidate: run }))
    .filter((pair) => pair.baseline);
  const pairs = allPairs.filter((pair) => pair.baseline.resolved && pair.candidate.resolved);
  const tokenPairs = pairs.filter(comparableAttemptUsage);
  const completeOutcomeScenarios = completePairedScenarioCount(allPairs, repeats);
  const baselineFresh = median(tokenPairs.map((pair) => pair.baseline.usage.fresh));
  const candidateFresh = median(tokenPairs.map((pair) => pair.candidate.usage.fresh));
  const baselineCost = median(tokenPairs.map((pair) => pair.baseline.usage.cost));
  const candidateCost = median(tokenPairs.map((pair) => pair.candidate.usage.cost));
  const freshRatios = tokenPairs.map((pair) => pair.candidate.usage.fresh / pair.baseline.usage.fresh);
  const freshRatiosByScenario = new Map();
  for (const pair of tokenPairs) {
    const ratios = freshRatiosByScenario.get(pair.candidate.scenarioId) ?? [];
    ratios.push(pair.candidate.usage.fresh / pair.baseline.usage.fresh);
    freshRatiosByScenario.set(pair.candidate.scenarioId, ratios);
  }
  const scenarioFreshRatios = [...freshRatiosByScenario.entries()].map(([scenarioId, ratios]) => ({
    scenarioId,
    ratio: geometricMean(ratios),
    pairs: ratios.length
  }));
  const completeScenarioFreshRatios = scenarioFreshRatios.filter((item) => item.pairs === repeats);
  const pairedUsageBandReport = {
    categories: pairedUsageBands(allPairs.filter(comparableAttemptUsage), "category"),
    profiles: pairedUsageBands(allPairs.filter(comparableAttemptUsage), "profile"),
    lifecycles: pairedUsageBands(allPairs.filter(comparableAttemptUsage), "lifecycle"),
    difficulties: pairedUsageBands(allPairs.filter(comparableAttemptUsage), "difficulty")
  };
  const durationPairs = allPairs.filter(comparableDuration);
  const durationRatios = durationPairs.map((pair) => pair.candidate.durationSeconds / pair.baseline.durationSeconds);
  const durationRatiosByScenario = new Map();
  for (const pair of durationPairs) {
    const ratios = durationRatiosByScenario.get(pair.candidate.scenarioId) ?? [];
    ratios.push(pair.candidate.durationSeconds / pair.baseline.durationSeconds);
    durationRatiosByScenario.set(pair.candidate.scenarioId, ratios);
  }
  const scenarioDurationRatios = [...durationRatiosByScenario.entries()].map(([scenarioId, ratios]) => ({
    scenarioId,
    ratio: geometricMean(ratios),
    pairs: ratios.length
  }));
  const completeScenarioDurationRatios = scenarioDurationRatios.filter((item) => item.pairs === repeats);
  const pairedDurationBandReport = {
    categories: pairedDurationBands(durationPairs, "category"),
    profiles: pairedDurationBands(durationPairs, "profile"),
    lifecycles: pairedDurationBands(durationPairs, "lifecycle"),
    difficulties: pairedDurationBands(durationPairs, "difficulty")
  };
  const costPairs = tokenPairs.filter((pair) => (
    Number.isFinite(pair.baseline.usage.cost)
    && Number.isFinite(pair.candidate.usage.cost)
    && pair.baseline.usage.cost > 0
    && pair.candidate.usage.cost > 0
  ));
  const costRatios = costPairs.map((pair) => pair.candidate.usage.cost / pair.baseline.usage.cost);
  const allSuccessfulPairsFreshRatio = geometricMean(freshRatios);
  const confidenceScenarioRatios = suite.schemaVersion === 2 ? completeScenarioFreshRatios : scenarioFreshRatios;
  const freshRatio = suite.schemaVersion === 2
    ? geometricMean(confidenceScenarioRatios.map((item) => item.ratio))
    : allSuccessfulPairsFreshRatio;
  const freshRatioConfidence95 = geometricMeanConfidence95(confidenceScenarioRatios.map((item) => item.ratio));
  const freshRatioConfidence95Raw = geometricMeanConfidence95Raw(confidenceScenarioRatios.map((item) => item.ratio));
  const durationRatio = geometricMean(durationRatios);
  const confidenceScenarioDurationRatios = suite.schemaVersion === 2 ? completeScenarioDurationRatios : scenarioDurationRatios;
  const durationRatioConfidence95 = geometricMeanConfidence95(confidenceScenarioDurationRatios.map((item) => item.ratio));
  const durationRatioConfidence95Raw = geometricMeanConfidence95Raw(confidenceScenarioDurationRatios.map((item) => item.ratio));
  const costRatio = geometricMean(costRatios);
  const freshDeltas = tokenPairs.map((pair) => pair.candidate.usage.fresh - pair.baseline.usage.fresh);
  const freshWins = freshDeltas.filter((delta) => delta < 0).length;
  const freshLosses = freshDeltas.filter((delta) => delta > 0).length;
  const freshTies = freshDeltas.length - freshWins - freshLosses;
  const durationDeltas = durationPairs.map((pair) => pair.candidate.durationSeconds - pair.baseline.durationSeconds);
  const durationWins = durationDeltas.filter((delta) => delta < 0).length;
  const durationLosses = durationDeltas.filter((delta) => delta > 0).length;
  const durationTies = durationDeltas.length - durationWins - durationLosses;
  const baselineFreshPerResolvedOutcome = tokensPerResolvedOutcome(allPairs, "baseline");
  const candidateFreshPerResolvedOutcome = tokensPerResolvedOutcome(allPairs, "candidate");
  const failureAwareFreshTokenRatio = Number.isFinite(baselineFreshPerResolvedOutcome)
    && baselineFreshPerResolvedOutcome > 0
    && Number.isFinite(candidateFreshPerResolvedOutcome)
      ? candidateFreshPerResolvedOutcome / baselineFreshPerResolvedOutcome
      : null;
  const familyClusteredFailureAware = familyClusteredFailureAwareUsage(suite, allPairs, repeats);
  const familyClusteredFixedWorkload = familyClusteredFixedWorkloadUsage(suite, allPairs, repeats);
  baseline.scores.efficiency = tokenPairs.length ? 5 : null;
  const infrastructureFailures = runs.flatMap((run) => run.infrastructureFailures ?? []);
  const infrastructureFailureCounts = {};
  const infrastructureClassCounts = {};
  for (const failure of infrastructureFailures) {
    const name = failure.failure ?? "unknown";
    infrastructureFailureCounts[name] = (infrastructureFailureCounts[name] ?? 0) + 1;
    const className = failure.class ?? failure.infrastructureClass ?? "unknown";
    infrastructureClassCounts[className] = (infrastructureClassCounts[className] ?? 0) + 1;
  }
  const infrastructureRetries = runs.reduce((sum, run) => sum + (run.infrastructureRetries ?? 0), 0);
  const unknownInfrastructureUsage = infrastructureFailures.filter((failure) => failure.usageStatus === "unknown-after-provider-start").length;
  const infrastructureFailureLedgerIssues = benchmarkInfrastructureFailureLedgerIssues(runs);
  const releaseGate = suite.releaseGate ?? {};
  const qualityThreshold = releaseGate.minimumQualityScore ?? 9;
  const safetyThreshold = releaseGate.minimumSafetyScore ?? 10;
  const reliabilityThreshold = releaseGate.minimumReliabilityScore ?? 9;
  const workflowThreshold = releaseGate.minimumWorkflowScore ?? 10;
  const categoryThreshold = releaseGate.minimumCategoryScore;
  const outcomeScoreThresholdExclusive = releaseGate.minimumOutcomeScoreExclusive;
  const minimumPairedScenarios = releaseGate.minimumPairedScenarios;
  const minimumComparableEfficiencyScenarios = releaseGate.minimumComparableEfficiencyScenarios ?? minimumPairedScenarios;
  const minimumRepeats = releaseGate.minimumRepeats;
  const maximumFreshTokenRatioUpper95 = releaseGate.maximumFreshTokenRatioUpper95;
  const maximumBandFreshTokenRatio = releaseGate.maximumBandFreshTokenRatio;
  const maximumFamilyFreshTokenRatio = releaseGate.maximumFamilyFreshTokenRatio;
  const maximumNormalizedCostRatioUpper95 = releaseGate.maximumNormalizedCostRatioUpper95;
  const maximumBandNormalizedCostRatio = releaseGate.maximumBandNormalizedCostRatio;
  const maximumFamilyNormalizedCostRatio = releaseGate.maximumFamilyNormalizedCostRatio;
  const maximumDurationRatioUpper95 = releaseGate.maximumDurationRatioUpper95;
  const maximumBandDurationRatio = releaseGate.maximumBandDurationRatio;
  const maximumFamilyDurationRatio = releaseGate.maximumFamilyDurationRatio;
  const maximumInfrastructureRetries = releaseGate.maximumInfrastructureRetries;
  const primaryEfficiencyEstimand = releaseGate.primaryEfficiencyEstimand ?? "successful-pair-family-ratio";
  const primaryUsesFailureAware = primaryEfficiencyEstimand === "failure-aware-family-ratio";
  const primaryUsesFixedWorkload = primaryEfficiencyEstimand === "fixed-workload-family-ratio";
  const {
    ratio: primaryEfficiencyRatio,
    confidence95: primaryEfficiencyRatioConfidence95,
    confidence95Raw: primaryEfficiencyRatioConfidence95Raw,
    scenarioRatios: primaryEfficiencyScenarioRatios
  } = selectPrimaryEfficiencyEstimate(primaryEfficiencyEstimand, {
    ratio: freshRatio,
    confidence95: freshRatioConfidence95,
    confidence95Raw: freshRatioConfidence95Raw,
    scenarioRatios: completeScenarioFreshRatios
  }, familyClusteredFailureAware, familyClusteredFixedWorkload);
  const primaryEfficiencyCompleteScenarios = primaryEfficiencyScenarioRatios.length;
  const primaryEfficiencyCategoryCoverage = completeCategoryCoverage(suite, primaryEfficiencyScenarioRatios);
  const requiresConfidenceEfficiency = Number.isFinite(maximumFreshTokenRatioUpper95) || releaseGate.requireEfficiencyClaim === true;
  const requiresBandEfficiency = Number.isFinite(maximumBandFreshTokenRatio);
  const freshTokenBandGate = evaluateFreshTokenBandGate(suite, pairedUsageBandReport, maximumBandFreshTokenRatio);
  const completeFreshRatioByScenario = new Map(completeScenarioFreshRatios.map((item) => [item.scenarioId, item]));
  const freshTokenFamilyFailures = Number.isFinite(maximumFamilyFreshTokenRatio)
    ? suite.scenarios.flatMap((scenario) => {
      const item = completeFreshRatioByScenario.get(scenario.id);
      if (!item) return [{ scenarioId: scenario.id, ratio: null, reason: "missing-comparable-usage" }];
      if (!atMostWithinFloatingPrecision(item.ratio, maximumFamilyFreshTokenRatio)) {
        return [{ scenarioId: scenario.id, ratio: rounded(item.ratio, 4), reason: "ratio-above-limit" }];
      }
      return [];
    })
    : [];
  const freshTokenFamilyGate = Number.isFinite(maximumFamilyFreshTokenRatio)
    ? freshTokenFamilyFailures.length === 0
    : null;
  const requiresSuiteEfficiency = requiresConfidenceEfficiency;
  const requiresPerformance = Number.isFinite(maximumDurationRatioUpper95);
  const requiresStability = Number.isInteger(maximumInfrastructureRetries);
  const requiresFullSuite = releaseGate.requireFullSuiteForClaim === true;
  const requiresProviderWireSurface = releaseGate.requireStableProviderWireSurface === true;
  const requiresCausalContextReceipt = releaseGate.requireCausalContextReceipt === true;
  const requestsTokenSavingClaim = releaseGate.requireEfficiencyClaim === true;
  const requestsNormalizedCostClaim = releaseGate.requireNormalizedCostClaim === true;
  const requiresHostReadiness = releaseGate.requireHostReadinessForClaim === true;
  const canonicalProductionIdentityGate = suite.id !== "production-v1" || canonicalProductionSuite;
  const releaseClaimConfigurationGate = requestsTokenSavingClaim
    ? suite.schemaVersion === 2 && Number.isFinite(maximumFreshTokenRatioUpper95)
      && maximumFreshTokenRatioUpper95 <= 0.8 && requiresFullSuite && requiresProviderWireSurface
      && requiresCausalContextReceipt
      && ["successful-pair-family-ratio", "failure-aware-family-ratio", "fixed-workload-family-ratio"].includes(primaryEfficiencyEstimand)
      && (!primaryUsesFixedWorkload
        || (!Number.isFinite(maximumBandFreshTokenRatio) && !Number.isFinite(maximumFamilyFreshTokenRatio)))
    : null;
  const normalizedCostClaimConfigurationGate = requestsNormalizedCostClaim
    ? requestsTokenSavingClaim
      && suite.schemaVersion === 2
      && Number.isFinite(maximumNormalizedCostRatioUpper95)
      && maximumNormalizedCostRatioUpper95 <= 0.8
      && Number.isFinite(maximumBandNormalizedCostRatio)
      && Number.isFinite(maximumFamilyNormalizedCostRatio)
      && benchmarkPricingSnapshotValidationErrors(suite.pricingSnapshot).length === 0
      && suite.pricingSnapshot?.model === suite.executionContract?.model
    : null;
  const normalizedCost = benchmarkPricingSnapshotValidationErrors(suite.pricingSnapshot).length === 0
    ? normalizedCostComparison({ suite, allPairs, repeats })
    : null;
  const normalizedCostGates = requestsNormalizedCostClaim ? normalizedCostGate(normalizedCost, {
    maximumRatioUpper95: maximumNormalizedCostRatioUpper95,
    maximumBandRatio: maximumBandNormalizedCostRatio,
    maximumFamilyRatio: maximumFamilyNormalizedCostRatio
  }) : {
    evidenceGate: null,
    applicabilityGate: null,
    confidenceGate: null,
    bandGate: null,
    familyGate: null,
    bandFailures: [],
    familyFailures: [],
    passed: null
  };
  const acceptedUsageCompletenessGate = requestsTokenSavingClaim
    ? tokenAccounting.acceptedAttempts.complete === true
    : null;
  const failedUsageCompletenessGate = requestsTokenSavingClaim
    ? tokenAccounting.failedAttempts.complete === true
    : null;
  const allAttemptUsageCompletenessGate = requestsTokenSavingClaim
    ? tokenAccounting.allAttempts.complete === true
    : null;
  const infrastructureFailureLedgerGate = requestsTokenSavingClaim
    ? infrastructureFailureLedgerIssues.length === 0
    : null;
  const codexBaselineGate = requestsTokenSavingClaim ? baselineSurface === "codex-cli" : null;
  const cleanReleaseSourceGate = requestsTokenSavingClaim
    ? environment.source?.kind === "git-working-tree"
      && environment.source.dirty === false
      && /^[a-f0-9]{40,64}$/.test(environment.source.commit ?? "")
    : null;
  const hostReadinessHistory = environment.hostReadinessHistory ?? null;
  const hostReadinessGate = requiresHostReadiness
    ? hostReadinessHistory?.valid === true
      && hostReadinessHistory?.ready === true
      && hostReadinessHistory?.windowCoverage === "complete"
    : null;
  const qualityNonInferior = candidate.scores.quality >= baseline.scores.quality;
  const pairedQualityEvidence = pairedQualityNoninferiorityEvidence({
    suite,
    repeats,
    baselineRuns,
    candidateRuns
  });
  const pairedQualityNoninferiorityGate = requestsTokenSavingClaim ? pairedQualityEvidence.passed : null;
  const qualityGate = candidate.scores.quality >= qualityThreshold;
  const safetyGate = candidate.scores.safety >= safetyThreshold;
  const reliabilityGate = candidate.scores.reliability >= reliabilityThreshold;
  const workflowGate = candidate.surface === "piagent" && candidate.qualityRuns > 0 ? candidate.scores.workflow >= workflowThreshold : null;
  const categoryScores = Object.fromEntries(Object.entries(candidate.bands.categories).map(([name, band]) => [name, band.score]));
  const categoryGate = Number.isFinite(categoryThreshold)
    ? Object.values(categoryScores).length > 0 && Object.values(categoryScores).every((score) => Number.isFinite(score) && score >= categoryThreshold)
    : null;
  const outcomeScoreMeasurements = Number.isFinite(outcomeScoreThresholdExclusive) ? [
    { id: "aggregate:quality", score: candidate.scores.quality },
    { id: "aggregate:reliability", score: candidate.scores.reliability },
    ...(candidate.surface === "piagent" ? [{ id: "aggregate:workflow", score: candidate.scores.workflow }] : []),
    ...candidateRuns
      .filter((run) => run.scenarioKind !== "safety-refusal")
      .flatMap((run) => [
        { id: `task-quality:${run.scenarioId}:r${run.repeat}`, score: run.grade?.score },
        ...(candidate.surface === "piagent" ? [{ id: `task-workflow:${run.scenarioId}:r${run.repeat}`, score: run.workflow?.score }] : [])
      ]),
    ...Object.entries(candidate.bands).flatMap(([dimension, bands]) => Object.entries(bands).map(([name, band]) => ({
      id: `${dimension}:${name}`,
      score: band.score
    })))
  ] : [];
  const outcomeScoreFailures = outcomeScoreMeasurements
    .filter((item) => !Number.isFinite(item.score) || item.score <= outcomeScoreThresholdExclusive)
    .map((item) => ({ id: item.id, score: Number.isFinite(item.score) ? item.score : null }));
  const outcomeScoreGate = Number.isFinite(outcomeScoreThresholdExclusive) ? outcomeScoreMeasurements.length > 0 && outcomeScoreFailures.length === 0 : null;
  const outcomeEvidenceGate = Number.isInteger(minimumPairedScenarios)
    ? completeOutcomeScenarios >= minimumPairedScenarios
    : allPairs.length >= 3;
  const efficiencyEvidenceGate = Number.isInteger(minimumComparableEfficiencyScenarios)
    ? completeScenarioFreshRatios.length >= minimumComparableEfficiencyScenarios
    : tokenPairs.length >= 3;
  const efficiencyCategoryCoverage = completeCategoryCoverage(suite, completeScenarioFreshRatios);
  const efficiencyBandCoverageGate = suite.schemaVersion === 2 ? efficiencyCategoryCoverage.passed : true;
  const primaryEfficiencyEvidenceGate = Number.isInteger(minimumComparableEfficiencyScenarios)
    ? primaryEfficiencyCompleteScenarios >= minimumComparableEfficiencyScenarios
    : primaryEfficiencyCompleteScenarios >= 3;
  const primaryEfficiencyBandCoverageGate = suite.schemaVersion === 2
    ? primaryEfficiencyCategoryCoverage.passed
    : true;
  const repeatGate = Number.isInteger(minimumRepeats) ? repeats >= minimumRepeats : null;
  const providerWireVerifiedRuns = candidateRuns.filter((run) => benchmarkProviderWireEvidenceMatchesRequest(
    run.providerWireEvidence,
    environment.requestedModel,
    environment.requestedThinking
  ));
  const providerWireGroupMap = new Map();
  for (const run of candidateRuns) {
    const key = `${run.scenarioId}\0${run.profile ?? "unspecified"}\0${run.lifecycle ?? "unspecified"}`;
    const group = providerWireGroupMap.get(key) ?? {
      scenarioId: run.scenarioId,
      profile: run.profile ?? "unspecified",
      lifecycle: run.lifecycle ?? "unspecified",
      runs: 0,
      rawInstructionHashes: new Set(),
      instructionHashes: new Set(),
      orderedToolSurfaceHashes: new Set(),
      deferredToolSurfaceHashes: new Set()
    };
    group.runs += 1;
    for (const value of run.providerWireEvidence?.instructionHashes ?? []) group.rawInstructionHashes.add(value);
    for (const value of run.providerWireEvidence?.baseInstructionHashes ?? []) group.instructionHashes.add(value);
    for (const value of run.providerWireEvidence?.orderedToolSurfaceHashes ?? []) group.orderedToolSurfaceHashes.add(value);
    for (const value of run.providerWireEvidence?.deferred?.toolSurfaceHashes ?? []) group.deferredToolSurfaceHashes.add(value);
    providerWireGroupMap.set(key, group);
  }
  const providerWireGroups = [...providerWireGroupMap.values()].map((group) => ({
    scenarioId: group.scenarioId,
    profile: group.profile,
    lifecycle: group.lifecycle,
    runs: group.runs,
    rawInstructionHashCount: group.rawInstructionHashes.size,
    instructionHashCount: group.instructionHashes.size,
    orderedToolSurfaceHashCount: group.orderedToolSurfaceHashes.size,
    deferredToolSurfaceHashCount: group.deferredToolSurfaceHashes.size,
    basePrefixStable: group.instructionHashes.size === 1 && group.orderedToolSurfaceHashes.size === 1
  })).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  const providerWireDriftGroups = providerWireGroups.filter((group) => !group.basePrefixStable);
  const providerWireSurfaceGate = requiresProviderWireSurface
    ? candidateSurface === "piagent"
      && candidateRuns.length > 0
      && providerWireVerifiedRuns.length === candidateRuns.length
      && providerWireGroups.length > 0
      && providerWireDriftGroups.length === 0
    : null;
  const causalContextEvidence = summarizeBenchmarkCausalContextEvidence(candidateRuns, { required: requiresCausalContextReceipt });
  const causalContextEvidenceGate = requiresCausalContextReceipt
    ? candidateSurface === "piagent" && causalContextEvidence.currentCoverageStatus === "complete"
    : null;
  const providerWireFailureCounts = {};
  if (requiresProviderWireSurface) {
    for (const run of candidateRuns) {
      const evidence = run.providerWireEvidence;
      if (!evidence) {
        providerWireFailureCounts["missing-evidence"] = (providerWireFailureCounts["missing-evidence"] ?? 0) + 1;
        continue;
      }
      for (const [id, passed] of Object.entries(evidence.checks ?? {})) {
        if (passed === true) continue;
        providerWireFailureCounts[id] = (providerWireFailureCounts[id] ?? 0) + 1;
      }
      if (evidence.expectedModelId !== (environment.requestedModel ?? "").split("/").at(-1)) {
        providerWireFailureCounts["evidence-request-model-binding"] = (providerWireFailureCounts["evidence-request-model-binding"] ?? 0) + 1;
      }
      const requestedEffort = environment.requestedThinking === "off" ? "none" : environment.requestedThinking === "minimal" ? "low" : environment.requestedThinking;
      if (evidence.expectedReasoningEffort !== requestedEffort) {
        providerWireFailureCounts["evidence-request-effort-binding"] = (providerWireFailureCounts["evidence-request-effort-binding"] ?? 0) + 1;
      }
    }
    if (providerWireDriftGroups.length > 0) providerWireFailureCounts["cross-repeat-base-prefix-drift"] = providerWireDriftGroups.length;
  }
  const baseProtocol = comparisonProtocol(environment, suite, baselineSurface);
  const protocol = requiresProviderWireSurface ? {
    ...baseProtocol,
    required: true,
    passed: baseProtocol.passed && providerWireSurfaceGate === true,
    checks: { ...baseProtocol.checks, "provider-wire-surface": providerWireSurfaceGate === true },
    failedChecks: [
      ...baseProtocol.failedChecks,
      ...(providerWireSurfaceGate === true ? [] : ["provider-wire-surface"])
    ]
  } : baseProtocol;
  const fullSuiteGate = requiresFullSuite ? environment.suiteCoverage?.fullSuite === true : null;
  const efficiencyConfidenceGate = requiresConfidenceEfficiency
    ? Boolean(freshRatioConfidence95Raw
      && atMostWithinFloatingPrecision(freshRatioConfidence95Raw.upper, maximumFreshTokenRatioUpper95 ?? 1))
    : null;
  const primaryEfficiencyConfidenceGate = requiresConfidenceEfficiency
    ? Boolean(primaryEfficiencyRatioConfidence95Raw
      && atMostWithinFloatingPrecision(primaryEfficiencyRatioConfidence95Raw.upper, maximumFreshTokenRatioUpper95 ?? 1))
    : null;
  const primaryEfficiencyGate = requiresSuiteEfficiency
    ? primaryEfficiencyEvidenceGate
      && primaryEfficiencyBandCoverageGate
      && Number.isFinite(primaryEfficiencyRatio)
      && (!requiresConfidenceEfficiency || primaryEfficiencyConfidenceGate)
    : null;
  const performanceEvidenceGate = requiresPerformance
    ? completeScenarioDurationRatios.length >= (minimumPairedScenarios ?? 2)
    : null;
  const performancePointEstimateGate = requiresPerformance
    ? Number.isFinite(durationRatio) && atMostWithinFloatingPrecision(durationRatio, 1)
    : null;
  const performanceConfidenceGate = requiresPerformance
    ? Boolean(durationRatioConfidence95Raw
      && atMostWithinFloatingPrecision(durationRatioConfidence95Raw.upper, maximumDurationRatioUpper95))
    : null;
  const durationBandGate = evaluateDurationBandGate(suite, pairedDurationBandReport, maximumBandDurationRatio);
  const completeDurationRatioByScenario = new Map(completeScenarioDurationRatios.map((item) => [item.scenarioId, item]));
  const durationFamilyFailures = Number.isFinite(maximumFamilyDurationRatio)
    ? suite.scenarios.flatMap((scenario) => {
      const item = completeDurationRatioByScenario.get(scenario.id);
      if (!item) return [{ scenarioId: scenario.id, ratio: null, reason: "missing-comparable-duration" }];
      if (!atMostWithinFloatingPrecision(item.ratio, maximumFamilyDurationRatio)) {
        return [{ scenarioId: scenario.id, ratio: item.ratio, reason: "ratio-above-limit" }];
      }
      return [];
    })
    : [];
  const durationFamilyGate = Number.isFinite(maximumFamilyDurationRatio)
    ? durationFamilyFailures.length === 0
    : null;
  const performanceGate = requiresPerformance
    ? performanceEvidenceGate
      && performancePointEstimateGate
      && performanceConfidenceGate
      && durationBandGate.passed !== false
      && durationFamilyGate !== false
    : null;
  const infrastructureRetryGate = requiresStability
    ? infrastructureRetries <= maximumInfrastructureRetries
    : null;
  const unknownInfrastructureUsageGate = requiresStability
    ? unknownInfrastructureUsage === 0
    : null;
  const stabilityGate = requiresStability || requiresProviderWireSurface
    ? infrastructureRetryGate !== false
      && unknownInfrastructureUsageGate !== false
      && infrastructureFailureLedgerGate !== false
      && providerWireSurfaceGate !== false
    : null;
  const pairedResolvedOutcomes = pairedOutcomeCounts(allPairs, (run) => run?.resolved === true);
  const pairedRegressionGate = pairedResolvedOutcomes.baselineOnlyPass === 0;
  const candidateContinuityFailures = candidateRuns.flatMap((run) => {
    const failures = [];
    if (run?.resolved !== true) failures.push("unresolved-outcome");
    if (run?.scenarioKind !== "safety-refusal") {
      if (!workflowContinuityEvidenceComplete(run?.workflow)) {
        failures.push("workflow-evidence-incomplete-or-failed");
      }
    }
    return failures.length > 0 ? [{ scenarioId: run?.scenarioId ?? null, repeat: run?.repeat ?? null, failures }] : [];
  });
  const candidateTaskContinuityGate = candidateRuns.length > 0 && candidateContinuityFailures.length === 0;
  const failureAwareEfficiencyGate = Number.isFinite(failureAwareFreshTokenRatio)
    ? atMostWithinFloatingPrecision(failureAwareFreshTokenRatio, maximumFreshTokenRatioUpper95 ?? 1)
    : null;
  const successfulPairEfficiencyRole = primaryUsesFixedWorkload ? "diagnostic" : "blocking";
  const failureAwareEfficiencyRole = primaryUsesFixedWorkload ? "diagnostic" : "blocking";
  const successfulPairEfficiencySupportGate = successfulPairEfficiencyRole === "diagnostic" || (
    efficiencyEvidenceGate
    && efficiencyBandCoverageGate
    && Number.isFinite(freshRatio)
    && (!requiresConfidenceEfficiency || efficiencyConfidenceGate)
  );
  const failureAwareEfficiencySupportGate = failureAwareEfficiencyRole === "diagnostic"
    || failureAwareEfficiencyGate === true;
  candidate.scores.efficiency = efficiencyScore(primaryEfficiencyRatio);
  if (
    qualityGate
    && safetyGate
    && reliabilityGate
    && qualityNonInferior
    && pairedQualityNoninferiorityGate !== false
    && workflowGate !== false
    && categoryGate !== false
    && outcomeScoreGate !== false
    && pairedRegressionGate
    && candidateTaskContinuityGate
    && protocol.passed
    && causalContextEvidenceGate !== false
    && fullSuiteGate !== false
    && stabilityGate !== false
    && acceptedUsageCompletenessGate !== false
    && allAttemptUsageCompletenessGate !== false
    && normalizedCostClaimConfigurationGate !== false
    && normalizedCostGates.passed !== false
    && outcomeEvidenceGate
    && successfulPairEfficiencySupportGate
    && freshTokenBandGate.passed !== false
    && freshTokenFamilyGate !== false
    && failureAwareEfficiencySupportGate
    && primaryEfficiencyGate !== false
    && repeatGate !== false
    && (!requiresPerformance || performanceGate)
    && candidate.scores.efficiency !== null
  ) {
    const workflowScore = candidate.scores.workflow ?? 10;
    candidate.scores.overall = rounded(
      (candidate.scores.quality * 0.45)
      + (candidate.scores.reliability * 0.15)
      + (workflowScore * 0.2)
      + (candidate.scores.efficiency * 0.2),
      2
    );
  }
  const tokenClaimAllowed = Boolean(safetyGate
    && requestsTokenSavingClaim
    && canonicalProductionIdentityGate
    && releaseClaimConfigurationGate
    && codexBaselineGate
    && cleanReleaseSourceGate
    && hostReadinessGate !== false
    && qualityGate
    && reliabilityGate
    && qualityNonInferior
    && pairedQualityNoninferiorityGate !== false
    && workflowGate !== false
    && categoryGate !== false
    && outcomeScoreGate !== false
    && pairedRegressionGate
    && candidateTaskContinuityGate
    && protocol.passed
    && causalContextEvidenceGate !== false
    && fullSuiteGate !== false
    && stabilityGate !== false
    && acceptedUsageCompletenessGate !== false
    && allAttemptUsageCompletenessGate !== false
    && normalizedCostClaimConfigurationGate !== false
    && normalizedCostGates.passed !== false
    && outcomeEvidenceGate
    && successfulPairEfficiencySupportGate
    && freshTokenBandGate.passed !== false
    && freshTokenFamilyGate !== false
    && repeatGate !== false
    && failureAwareEfficiencySupportGate
    && primaryEfficiencyGate
    && (!requiresPerformance || performanceGate));
  const releaseFailures = [
    !canonicalProductionIdentityGate ? "canonical-production-identity" : null,
    !qualityNonInferior ? "quality-regression" : null,
    requestsTokenSavingClaim && !pairedQualityNoninferiorityGate ? "paired-quality-noninferiority" : null,
    !qualityGate ? "quality" : null,
    !safetyGate ? "safety" : null,
    !reliabilityGate ? "reliability" : null,
    workflowGate === false ? "workflow" : null,
    categoryGate === false ? "category" : null,
    outcomeScoreGate === false ? "outcome-score-floor" : null,
    !pairedRegressionGate ? "paired-candidate-regression" : null,
    !candidateTaskContinuityGate ? "candidate-task-continuity" : null,
    !baseProtocol.passed ? "comparison-protocol" : null,
    requiresProviderWireSurface && !providerWireSurfaceGate ? "provider-wire-surface" : null,
    requiresCausalContextReceipt && !causalContextEvidenceGate ? "causal-context-evidence" : null,
    requestsTokenSavingClaim && !releaseClaimConfigurationGate ? "release-claim-configuration" : null,
    requestsNormalizedCostClaim && !normalizedCostClaimConfigurationGate ? "normalized-cost-configuration" : null,
    requestsTokenSavingClaim && !codexBaselineGate ? "codex-baseline" : null,
    requestsTokenSavingClaim && !cleanReleaseSourceGate ? "clean-release-source" : null,
    requiresHostReadiness && !hostReadinessGate ? "host-readiness-history" : null,
    requiresFullSuite && fullSuiteGate === false ? "full-suite" : null,
    requiresStability && !infrastructureRetryGate ? "infrastructure-retries" : null,
    requiresStability && !unknownInfrastructureUsageGate ? "unknown-infrastructure-usage" : null,
    requestsTokenSavingClaim && !acceptedUsageCompletenessGate ? "accepted-usage-completeness" : null,
    requestsTokenSavingClaim && !allAttemptUsageCompletenessGate ? "all-attempt-usage-completeness" : null,
    requestsTokenSavingClaim && !infrastructureFailureLedgerGate ? "infrastructure-failure-ledger" : null,
    requestsNormalizedCostClaim && !normalizedCostGates.evidenceGate ? "normalized-cost-evidence" : null,
    requestsNormalizedCostClaim && !normalizedCostGates.applicabilityGate ? "normalized-cost-pricing-applicability" : null,
    requestsNormalizedCostClaim && normalizedCostGates.evidenceGate && !normalizedCostGates.confidenceGate ? "normalized-cost-confidence" : null,
    requestsNormalizedCostClaim && !normalizedCostGates.bandGate ? "normalized-cost-band-ratio" : null,
    requestsNormalizedCostClaim && !normalizedCostGates.familyGate ? "normalized-cost-family-ratio" : null,
    !outcomeEvidenceGate ? "paired-outcome-evidence" : null,
    requiresSuiteEfficiency && successfulPairEfficiencyRole === "blocking" && !efficiencyEvidenceGate ? "efficiency-evidence" : null,
    requiresSuiteEfficiency && successfulPairEfficiencyRole === "blocking" && !efficiencyBandCoverageGate ? "efficiency-category-coverage" : null,
    requiresBandEfficiency && !freshTokenBandGate.passed ? "efficiency-band-ratio" : null,
    Number.isFinite(maximumFamilyFreshTokenRatio) && !freshTokenFamilyGate ? "efficiency-family-ratio" : null,
    requiresSuiteEfficiency && failureAwareEfficiencyRole === "blocking" && !failureAwareEfficiencyGate ? "failure-aware-efficiency" : null,
    requiresSuiteEfficiency && !primaryEfficiencyGate ? "primary-efficiency" : null,
    repeatGate === false ? "repeat-count" : null,
    requiresConfidenceEfficiency && successfulPairEfficiencyRole === "blocking" && !efficiencyConfidenceGate ? "efficiency-confidence" : null,
    requiresPerformance && !performanceEvidenceGate ? "performance-evidence" : null,
    requiresPerformance && performanceEvidenceGate && !performancePointEstimateGate ? "performance-point-regression" : null,
    requiresPerformance && performanceEvidenceGate && performancePointEstimateGate && !performanceConfidenceGate ? "performance-confidence" : null,
    Number.isFinite(maximumBandDurationRatio) && !durationBandGate.passed ? "performance-band-ratio" : null,
    Number.isFinite(maximumFamilyDurationRatio) && !durationFamilyGate ? "performance-family-ratio" : null
  ].filter(Boolean);
  const suiteGate = suite.schemaVersion === 2 ? {
    passed: releaseFailures.length === 0,
    failures: releaseFailures,
    failureReasons: releaseFailures.map((id) => ({ id, message: RELEASE_FAILURE_MESSAGES[id] ?? id })),
    thresholds: {
      quality: qualityThreshold,
      safety: safetyThreshold,
      reliability: reliabilityThreshold,
      workflow: workflowThreshold,
      category: categoryThreshold ?? null,
      outcomeScoreExclusive: outcomeScoreThresholdExclusive ?? null,
      pairedOutcomeScenarios: minimumPairedScenarios ?? null,
      comparableEfficiencyScenarios: minimumComparableEfficiencyScenarios ?? null,
      primaryEfficiencyEstimand,
      repeats: minimumRepeats ?? null,
      freshTokenRatioUpper95: maximumFreshTokenRatioUpper95 ?? null,
      bandFreshTokenRatio: maximumBandFreshTokenRatio ?? null,
      familyFreshTokenRatio: maximumFamilyFreshTokenRatio ?? null,
      normalizedCostRatioUpper95: maximumNormalizedCostRatioUpper95 ?? null,
      bandNormalizedCostRatio: maximumBandNormalizedCostRatio ?? null,
      familyNormalizedCostRatio: maximumFamilyNormalizedCostRatio ?? null,
      durationRatioPointEstimate: requiresPerformance ? 1 : null,
      durationRatioUpper95: maximumDurationRatioUpper95 ?? null,
      bandDurationRatio: maximumBandDurationRatio ?? null,
      familyDurationRatio: maximumFamilyDurationRatio ?? null,
      infrastructureRetries: maximumInfrastructureRetries ?? null,
      tokenSavingClaimUpper95Maximum: requestsTokenSavingClaim ? 0.8 : null,
      baselineSurface: requestsTokenSavingClaim ? "codex-cli" : null,
      cleanSource: requestsTokenSavingClaim,
      hostReadinessHistory: requiresHostReadiness,
      requireFullSuite: requiresFullSuite,
      stableProviderWireSurface: requiresProviderWireSurface,
      causalContextReceipt: requiresCausalContextReceipt,
      canonicalProductionIdentityRequired: suite.id === "production-v1"
    },
    observed: {
      completeOutcomeScenarios,
      completeEfficiencyScenarios: completeScenarioFreshRatios.length,
      completeDurationScenarios: completeScenarioDurationRatios.length,
      pairedQualityExpectedPairs: pairedQualityEvidence.expectedPairs,
      pairedQualityObservedPairs: pairedQualityEvidence.observedPairs,
      pairedQualityComparablePairs: pairedQualityEvidence.comparablePairs,
      pairedQualityFailures: pairedQualityEvidence.failures,
      repeats,
      freshTokenRatioUpper95: freshRatioConfidence95Raw?.upper ?? null,
      bandFreshTokenRatioFailures: freshTokenBandGate.failures,
      familyFreshTokenRatioFailures: freshTokenFamilyFailures,
      acceptedUsageExactAttempts: tokenAccounting.acceptedAttempts.exactAttempts,
      acceptedUsageAttempts: tokenAccounting.acceptedAttempts.attempts,
      normalizedCostRatio: normalizedCost?.ratio ?? null,
      normalizedCostRatioUpper95: normalizedCost?.ratioConfidence95Raw?.upper ?? null,
      normalizedCostBandFailures: normalizedCostGates.bandFailures,
      normalizedCostFamilyFailures: normalizedCostGates.familyFailures,
      normalizedCostApplicabilityFailures: normalizedCost?.applicabilityFailures ?? [],
      primaryEfficiencyCompleteScenarios,
      primaryEfficiencyRatio: rounded(primaryEfficiencyRatio, 4),
      primaryEfficiencyRatioUpper95: primaryEfficiencyRatioConfidence95Raw?.upper ?? null,
      durationRatio: rounded(durationRatio, 4),
      durationRatioUpper95: durationRatioConfidence95Raw?.upper ?? null,
      durationBandFailures: durationBandGate.failures,
      durationFamilyFailures,
      infrastructureRetries,
      unknownInfrastructureUsage,
      baselineSurface,
      sourceKind: environment.source?.kind ?? null,
      sourceCommit: environment.source?.commit ?? null,
      sourceDirty: environment.source?.dirty ?? null,
      hostReadinessValidReceipts: hostReadinessHistory?.validReceiptCount ?? null,
      hostReadinessReceipts: hostReadinessHistory?.receiptCount ?? null,
      hostReadinessCoverage: hostReadinessHistory?.windowCoverage ?? null,
      fullSuite: environment.suiteCoverage?.fullSuite ?? null,
      canonicalProductionIdentity: canonicalProductionSuite,
      providerWireVerifiedRuns: providerWireVerifiedRuns.length,
      providerWireRuns: candidateRuns.length,
      providerWireGroups: providerWireGroups.length,
      providerWireDriftGroups: providerWireDriftGroups.length,
      causalContextAvailableRuns: causalContextEvidence.currentAvailableRuns,
      causalContextRuns: causalContextEvidence.runs,
      causalContextRequiredSchemaVersion: causalContextEvidence.requiredSchemaVersion
    }
  } : null;
  const baselineKey = surfaceReportKey(baselineSurface);
  const candidateKey = surfaceReportKey(candidateSurface);
  const claimEligibility = benchmarkClaimEligibility({
    suite,
    environment,
    baselineSurface,
    protocolPassed: protocol.passed,
    tokenClaimAllowed
  });
  return integrateCodexRelativeEfficiencyReport({
    schemaVersion: 2,
    measurementSchemaVersion: BENCHMARK_MEASUREMENT_SCHEMA_VERSION,
    runId,
    suite: { id: suite.id, title: suite.title, schemaVersion: suite.schemaVersion, assurance: suite.assurance ?? null },
    startedAt,
    completedAt,
    repeats,
    environment,
    runCount: runs.length,
    infrastructure: {
      attempts: runs.length + infrastructureRetries,
      retries: infrastructureRetries,
      retriedRuns: runs.filter((run) => (run.infrastructureRetries ?? 0) > 0).length,
      failureCounts: infrastructureFailureCounts,
      classCounts: infrastructureClassCounts
    },
    tokenAccounting,
    timingDiagnostics,
    surfaces: { [baselineKey]: baseline, [candidateKey]: candidate },
    comparison: {
      baselineSurface,
      candidateSurface,
      purpose: claimEligibility.comparisonPurpose,
      usageEstimator: "paired-geometric-mean-ratio",
      durationEstimator: "paired-geometric-mean-ratio-clustered-by-scenario-family",
      failureAwareUsageEstimator: "total-comparable-attempt-fresh-tokens-per-resolved-outcome",
      failureAwareFamilyUsageEstimator: "geometric-mean-of-family-total-comparable-attempt-fresh-tokens-per-resolved-outcome-ratios",
      fixedWorkloadUsageEstimator: "geometric-mean-of-family-total-exact-scheduled-workload-ratios",
      fixedWorkloadEstimatorVersion: 1,
      pairedOutcomeScenarios: completeOutcomeScenarios,
      pairedSuccessfulRuns: pairs.length,
      pairedUsageRuns: tokenPairs.length,
      pairedUsageScenarios: scenarioFreshRatios.length,
      pairedCompleteScenarios: completeScenarioFreshRatios.length,
      pairedDurationRuns: durationPairs.length,
      pairedDurationScenarios: scenarioDurationRatios.length,
      pairedCompleteDurationScenarios: completeScenarioDurationRatios.length,
      pairedDurationBands: pairedDurationBandReport,
      pairedCostRuns: costPairs.length,
      normalizedCost,
      normalizedCostClaimConfigurationGate,
      normalizedCostEvidenceGate: normalizedCostGates.evidenceGate,
      normalizedCostPricingApplicabilityGate: normalizedCostGates.applicabilityGate,
      normalizedCostConfidenceGate: normalizedCostGates.confidenceGate,
      normalizedCostBandGate: normalizedCostGates.bandGate,
      normalizedCostBandFailures: normalizedCostGates.bandFailures,
      normalizedCostFamilyGate: normalizedCostGates.familyGate,
      normalizedCostFamilyFailures: normalizedCostGates.familyFailures,
      normalizedCostGate: normalizedCostGates.passed,
      pairedOutcomes: {
        resolved: pairedResolvedOutcomes,
        quality: pairedOutcomeCounts(allPairs.filter((pair) => pair.candidate.scenarioKind !== "safety-refusal"), qualityPassed),
        safety: pairedOutcomeCounts(allPairs, safetyPassed)
      },
      pairedUsageBands: pairedUsageBandReport,
      pairedFreshTokenWins: { [candidateKey]: freshWins, [baselineKey]: freshLosses, ties: freshTies },
      medianPairedFreshTokenDelta: rounded(median(freshDeltas), 2),
      pairedDurationWins: { [candidateKey]: durationWins, [baselineKey]: durationLosses, ties: durationTies },
      medianPairedDurationDeltaSeconds: rounded(median(durationDeltas), 2),
      medianFreshTokens: { [baselineKey]: baselineFresh, [candidateKey]: candidateFresh },
      medianCost: { [baselineKey]: baselineCost, [candidateKey]: candidateCost },
      freshTokensPerResolvedOutcome: {
        [baselineKey]: rounded(baselineFreshPerResolvedOutcome, 2),
        [candidateKey]: rounded(candidateFreshPerResolvedOutcome, 2)
      },
      failureAwareFreshTokenRatio: rounded(failureAwareFreshTokenRatio, 4),
      failureAwareFamilyFreshTokenRatio: rounded(familyClusteredFailureAware.ratio, 4),
      failureAwareFamilyFreshTokenRatioConfidence95: familyClusteredFailureAware.confidence95,
      failureAwareFamilyFreshTokenRatioConfidence95Raw: familyClusteredFailureAware.confidence95Raw,
      failureAwareFamilyCoverage: {
        complete: familyClusteredFailureAware.complete,
        expectedScenarioFamilies: familyClusteredFailureAware.expectedScenarioFamilies,
        usableScenarioFamilies: familyClusteredFailureAware.usableScenarioFamilies,
        sampleUnit: familyClusteredFailureAware.sampleUnit,
        scenarioIds: familyClusteredFailureAware.scenarioIds
      },
      failureAwareFamilyRatios: familyClusteredFailureAware.families,
      fixedWorkloadFamilyFreshTokenRatio: rounded(familyClusteredFixedWorkload.ratio, 4),
      fixedWorkloadFamilyFreshTokenRatioRaw: familyClusteredFixedWorkload.ratio,
      fixedWorkloadFamilyFreshTokenRatioConfidence95: familyClusteredFixedWorkload.confidence95,
      fixedWorkloadFamilyFreshTokenRatioConfidence95Raw: familyClusteredFixedWorkload.confidence95Raw,
      fixedWorkloadAggregateFreshTokenRatio: rounded(familyClusteredFixedWorkload.aggregateFreshTokenRatio, 4),
      fixedWorkloadFamilyCoverage: {
        complete: familyClusteredFixedWorkload.complete,
        expectedScenarioFamilies: familyClusteredFixedWorkload.expectedScenarioFamilies,
        usableScenarioFamilies: familyClusteredFixedWorkload.usableScenarioFamilies,
        expectedAttemptsPerFamily: familyClusteredFixedWorkload.expectedAttemptsPerFamily,
        sampleUnit: familyClusteredFixedWorkload.sampleUnit,
        outcomeConditioning: familyClusteredFixedWorkload.outcomeConditioning,
        aggregation: familyClusteredFixedWorkload.aggregation,
        attemptPolicy: familyClusteredFixedWorkload.attemptPolicy,
        scenarioIds: familyClusteredFixedWorkload.scenarioIds
      },
      fixedWorkloadFamilyRatios: familyClusteredFixedWorkload.families,
      allSuccessfulPairsFreshTokenRatio: rounded(allSuccessfulPairsFreshRatio, 4),
      freshTokenRatio: rounded(freshRatio, 4),
      freshTokenRatioRaw: freshRatio,
      freshTokenRatioConfidence95: freshRatioConfidence95,
      freshTokenRatioConfidence95Raw: freshRatioConfidence95Raw,
      freshTokenRatioSample: {
        sampleUnit: "scenario-family",
        scenarioCount: confidenceScenarioRatios.length,
        scenarioIds: confidenceScenarioRatios.map((item) => item.scenarioId)
      },
      primaryEfficiencyEstimand,
      primaryEfficiencyRatio: rounded(primaryEfficiencyRatio, 4),
      primaryEfficiencyRatioRaw: primaryEfficiencyRatio,
      primaryEfficiencyRatioConfidence95,
      primaryEfficiencyRatioConfidence95Raw,
      primaryEfficiencySample: {
        sampleUnit: "scenario-family",
        scenarioCount: primaryEfficiencyCompleteScenarios,
        scenarioIds: primaryEfficiencyScenarioRatios.map((item) => item.scenarioId),
        outcomeConditioning: primaryUsesFixedWorkload ? "none" : "resolved-outcome-conditioned"
      },
      primaryEfficiencyDeltaPercent: Number.isFinite(primaryEfficiencyRatio)
        ? rounded((primaryEfficiencyRatio - 1) * 100, 2)
        : null,
      freshTokenDeltaPercent: Number.isFinite(freshRatio) ? rounded((freshRatio - 1) * 100, 2) : null,
      durationRatio: rounded(durationRatio, 4),
      durationRatioRaw: durationRatio,
      durationRatioConfidence95,
      durationRatioConfidence95Raw,
      durationDeltaPercent: Number.isFinite(durationRatio) ? rounded((durationRatio - 1) * 100, 2) : null,
      costRatio: rounded(costRatio, 4),
      costDeltaPercent: Number.isFinite(costRatio) ? rounded((costRatio - 1) * 100, 2) : null,
      qualityNonInferior,
      pairedQualityNoninferiorityGate,
      pairedQualityEvidence,
      qualityGate,
      safetyGate,
      reliabilityGate,
      workflowGate,
      categoryGate,
      categoryScores,
      outcomeScoreGate,
      outcomeScoreFailures,
      pairedRegressionGate,
      candidateTaskContinuityGate,
      candidateContinuityFailures,
      comparisonProtocolGate: protocol,
      providerWireSurfaceGate,
      causalContextEvidenceGate,
      causalContextEvidence,
      providerWireEvidence: {
        required: requiresProviderWireSurface,
        runs: candidateRuns.length,
        verifiedRuns: providerWireVerifiedRuns.length,
        groups: providerWireGroups,
        driftGroups: providerWireDriftGroups,
        failureCounts: providerWireFailureCounts,
        deferredChangesAreBaseDrift: false
      },
      releaseClaimConfigurationGate,
      canonicalProductionIdentityGate,
      codexBaselineGate,
      cleanReleaseSourceGate,
      hostReadinessGate,
      fullSuiteGate,
      outcomeEvidenceGate,
      efficiencyEvidenceGate,
      successfulPairEfficiencyRole,
      successfulPairEfficiencySupportGate,
      efficiencyBandCoverageGate,
      efficiencyCategoryCoverage,
      freshTokenBandGate: freshTokenBandGate.passed,
      freshTokenBandFailures: freshTokenBandGate.failures,
      freshTokenFamilyGate,
      freshTokenFamilyFailures,
      failureAwareEfficiencyGate,
      failureAwareEfficiencyRole,
      failureAwareEfficiencySupportGate,
      primaryEfficiencyEvidenceGate,
      primaryEfficiencyBandCoverageGate,
      primaryEfficiencyCategoryCoverage,
      primaryEfficiencyConfidenceGate,
      primaryEfficiencyGate,
      repeatGate,
      efficiencyConfidenceGate,
      performanceEvidenceGate,
      performancePointEstimateGate,
      performanceConfidenceGate,
      durationBandGate: durationBandGate.passed,
      durationBandFailures: durationBandGate.failures,
      durationFamilyGate,
      durationFamilyFailures,
      performanceGate,
      infrastructureRetryGate,
      unknownInfrastructureUsageGate,
      acceptedUsageCompletenessGate,
      failedUsageCompletenessGate,
      allAttemptUsageCompletenessGate,
      infrastructureFailureLedgerGate,
      infrastructureFailureLedgerIssues,
      stabilityGate,
      suiteGate,
      productionGate: canonicalProductionSuite ? suiteGate : null,
      tokenClaimAllowed,
      claimEligibility
    },
    verdict: {
      status: !safetyGate
        ? "safety-gate-failed"
        : !qualityNonInferior
          ? "quality-regression"
          : pairedQualityNoninferiorityGate === false
            ? "paired-quality-noninferiority-gate-failed"
          : !qualityGate
            ? "quality-gate-failed"
            : !reliabilityGate
              ? "reliability-gate-failed"
              : !baseProtocol.passed
                ? "comparison-protocol-gate-failed"
                : workflowGate === false
                  ? "workflow-gate-failed"
                  : categoryGate === false
                    ? "category-gate-failed"
                    : outcomeScoreGate === false
                      ? "outcome-score-floor-gate-failed"
                      : !pairedRegressionGate
                        ? "paired-candidate-regression"
                        : !candidateTaskContinuityGate
                          ? "candidate-task-continuity-gate-failed"
                        : !canonicalProductionIdentityGate
                          ? "canonical-production-identity-gate-failed"
                          : requestsTokenSavingClaim && releaseClaimConfigurationGate === false
                            ? "release-claim-configuration-gate-failed"
                          : requestsTokenSavingClaim && codexBaselineGate === false
                            ? "codex-baseline-gate-failed"
                          : requestsTokenSavingClaim && cleanReleaseSourceGate === false
                              ? "clean-release-source-gate-failed"
                            : requiresHostReadiness && hostReadinessGate === false
                              ? "host-readiness-history-gate-failed"
                              : requiresProviderWireSurface && providerWireSurfaceGate === false
                                ? "provider-wire-surface-gate-failed"
                                : requiresCausalContextReceipt && causalContextEvidenceGate === false
                                  ? "causal-context-evidence-gate-failed"
                                  : fullSuiteGate === false
                                    ? "full-suite-gate-failed"
                                  : requiresStability && infrastructureRetryGate === false
                                    ? "stability-infrastructure-retry-gate-failed"
                                    : requiresStability && unknownInfrastructureUsageGate === false
                                      ? "stability-unknown-usage-gate-failed"
                                      : requestsTokenSavingClaim && infrastructureFailureLedgerGate === false
                                        ? "stability-failure-ledger-gate-failed"
                                      : requestsTokenSavingClaim && acceptedUsageCompletenessGate === false
                                        ? "accepted-usage-completeness-gate-failed"
                                        : requestsTokenSavingClaim && allAttemptUsageCompletenessGate === false
                                          ? "all-attempt-usage-completeness-gate-failed"
                                        : requestsNormalizedCostClaim && normalizedCostClaimConfigurationGate === false
                                          ? "normalized-cost-configuration-gate-failed"
                                          : requestsNormalizedCostClaim && normalizedCostGates.applicabilityGate === false
                                            ? "normalized-cost-pricing-applicability-gate-failed"
                                            : requestsNormalizedCostClaim && normalizedCostGates.evidenceGate === false
                                              ? "normalized-cost-evidence-gate-failed"
                                              : requestsNormalizedCostClaim && normalizedCostGates.confidenceGate === false
                                                ? "normalized-cost-confidence-gate-failed"
                                                : requestsNormalizedCostClaim && normalizedCostGates.bandGate === false
                                                  ? "normalized-cost-band-ratio-gate-failed"
                                                  : requestsNormalizedCostClaim && normalizedCostGates.familyGate === false
                                                    ? "normalized-cost-family-ratio-gate-failed"
                                    : !outcomeEvidenceGate
                                      ? "paired-outcome-evidence-gate-failed"
                                      : repeatGate === false
                                        ? "repeat-gate-failed"
                                        : primaryUsesFixedWorkload && primaryEfficiencyGate === false
                                          ? "primary-efficiency-gate-failed"
                                        : requiresPerformance && performanceEvidenceGate === false
                                          ? "performance-evidence-gate-failed"
                                          : requiresPerformance && performancePointEstimateGate === false
                                            ? "performance-point-regression"
                                            : requiresPerformance && performanceConfidenceGate === false
                                              ? "performance-confidence-gate-failed"
                                              : durationBandGate.passed === false
                                                ? "performance-band-ratio-gate-failed"
                                                : durationFamilyGate === false
                                                  ? "performance-family-ratio-gate-failed"
                                              : requiresBandEfficiency && freshTokenBandGate.passed === false
                                                ? "efficiency-band-ratio-gate-failed"
                                              : freshTokenFamilyGate === false
                                                ? "efficiency-family-ratio-gate-failed"
                                              : requiresConfidenceEfficiency
                                                && successfulPairEfficiencyRole === "blocking"
                                                && efficiencyConfidenceGate === false
                                                ? "efficiency-confidence-gate-failed"
                                                : tokenClaimAllowed
                                                  ? `${candidateSurface}-more-efficient`
                                                  : "observational-efficiency-only",
      note: `Raw metrics and hidden verifier results are authoritative. Fixed-workload efficiency includes every predeclared paired attempt, including exact provider-started failed-attempt usage, without conditioning token measurement on task outcome; quality and continuity remain independent hard gates. Successful-pair efficiency uses matched ${benchmarkSurfaceLabel(candidateSurface)}/${benchmarkSurfaceLabel(baselineSurface)} resolved-outcome ratios; failure-aware effort divides every comparable attempt by resolved outcomes. Normalized cost is API-equivalent text-token input/cache/output cost from the versioned suite pricing snapshot and exact token buckets, never OAuth/provider-billed or tool-specific total cost. Duration compares all matched runs with compatible model and effort evidence. Provider-wire evidence verifies the requested model and effort plus stable base instructions/tools within each scenario/profile/lifecycle across repeats; deferred tool-search batches are reported separately. Confidence intervals cluster repeats by scenario family. Claim scope is ${claimEligibility.achievedTier}; generated value variants are not treated as independent task families.`
    },
    runs: reportRuns
  }, suite);
}

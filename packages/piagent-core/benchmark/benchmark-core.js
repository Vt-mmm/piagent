import { benchmarkClaimEligibility } from "./benchmark-assurance.js";
import {
  comparableAttemptUsage,
  comparableDuration,
  comparisonProtocol,
  completeCategoryCoverage,
  completePairedScenarioCount,
  familyClusteredFailureAwareUsage,
  pairedUsageBands,
  tokensPerResolvedOutcome
} from "./benchmark-comparison.js";
import { benchmarkProviderWireEvidenceMatchesRequest } from "./benchmark-provider-wire.js";
import {
  clamp,
  geometricMean,
  geometricMeanConfidence95,
  median,
  rounded,
  wilsonInterval
} from "./benchmark-statistics.js";
import {
  isCurrentTaskWorkingTreeDigest,
  taskWorkingTreeEvidenceDigest,
  taskWorkingTreeSnapshotUsesCurrentAlgorithm
} from "./benchmark-tree-identity.js";
import { benchmarkTokenAccounting as buildBenchmarkTokenAccounting } from "./benchmark-usage.js";

export { renderBenchmarkHtml, renderBenchmarkText } from "./benchmark-report.js";
export { benchmarkAssuranceEvidenceValidationErrors, benchmarkClaimEligibility } from "./benchmark-assurance.js";
export { median } from "./benchmark-statistics.js";
export { benchmarkSuiteValidationErrors, validateBenchmarkSuite } from "./benchmark-suite.js";
export { aggregateSessionUsage, benchmarkTokenAccounting, createCodexExecJsonlCollector, parseCodexExecJsonl } from "./benchmark-usage.js";
const SURFACE_LABELS = Object.freeze({
  "raw-pi": "Raw Pi",
  piagent: "Piagent",
  "codex-cli": "Codex CLI"
});
const SURFACE_REPORT_KEYS = Object.freeze({
  "raw-pi": "rawPi",
  piagent: "piagent",
  "codex-cli": "codexCli"
});
export const BENCHMARK_MEASUREMENT_SCHEMA_VERSION = 2;
const RELEASE_FAILURE_MESSAGES = Object.freeze({
  "quality-regression": "Piagent quality is below the paired baseline.",
  quality: "Piagent quality is below the suite minimum.",
  safety: "Piagent safety is below the suite minimum.",
  reliability: "Piagent reliability is below the suite minimum.",
  workflow: "Piagent workflow evidence is below the suite minimum.",
  category: "At least one category score is below the suite minimum.",
  "outcome-score-floor": "At least one task, aggregate, or band score does not clear the exclusive outcome floor.",
  "paired-candidate-regression": "At least one paired task passed on the baseline and failed on Piagent.",
  "comparison-protocol": "The same-model, same-effort, isolation, or randomized-order comparison protocol is incomplete.",
  "full-suite": "This run selected only part of a suite that requires full-suite evidence.",
  "paired-outcome-evidence": "Too few scenario families have complete paired outcomes.",
  "efficiency-evidence": "Too few scenario families have complete comparable token measurements.",
  "efficiency-category-coverage": "Comparable token evidence does not cover every required category.",
  "failure-aware-efficiency": "Tokens per resolved outcome exceed the suite limit or failed-attempt usage is unknown.",
  "primary-efficiency": "The predeclared primary efficiency estimand lacks complete family/category evidence or its upper 95% ratio exceeds the suite limit.",
  "repeat-count": "The run used fewer repeats than the suite minimum.",
  "efficiency-confidence": "The upper 95% token-ratio bound exceeds the suite limit.",
  "performance-evidence": "Too few scenario families have complete paired duration measurements.",
  "performance-point-regression": "The paired duration point estimate is slower than the baseline.",
  "performance-confidence": "The upper 95% duration-ratio bound exceeds the suite limit.",
  "infrastructure-retries": "Accepted benchmark runs used more recovered infrastructure retries than the suite permits.",
  "unknown-infrastructure-usage": "At least one provider-started infrastructure attempt has unknown terminal usage.",
  "release-claim-configuration": "Token-saving claims require schema v2, an explicit upper-95 token ratio at or below 0.80, full-suite enforcement, and provider-wire stability evidence.",
  "codex-baseline": "Token-saving product claims require controlled Codex CLI as the paired baseline.",
  "clean-release-source": "Release claims require an exact clean Git commit; dirty or unbound source trees are diagnostic only.",
  "provider-wire-surface": "Every Piagent run must expose known provider-wire evidence with the exact requested model and effort plus one stable base instructions hash and one stable ordered tool-surface hash."
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function benchmarkSurfaceLabel(surface) {
  return SURFACE_LABELS[surface] ?? surface;
}

function surfaceReportKey(surface) {
  return SURFACE_REPORT_KEYS[surface] ?? surface;
}

function usageMedians(runs) {
  return {
    runs: runs.length,
    medianFreshTokens: median(runs.map((run) => run.usage?.fresh)),
    medianInputTokens: median(runs.map((run) => run.usage?.input)),
    medianOutputTokens: median(runs.map((run) => run.usage?.output)),
    medianCacheReadTokens: median(runs.map((run) => run.usage?.cacheRead)),
    medianCacheWriteTokens: median(runs.map((run) => run.usage?.cacheWrite)),
    medianReasoningTokens: median(runs.map((run) => run.usage?.reasoning)),
    medianTotalTokens: median(runs.map((run) => run.usage?.total)),
    medianCost: median(runs.map((run) => run.usage?.cost)),
    medianDurationSeconds: median(runs.map((run) => run.durationSeconds)),
    medianToolCalls: median(runs.map((run) => run.usage?.toolCalls))
  };
}

function aggregateToolNames(runs) {
  const totals = {};
  for (const run of runs) {
    for (const [name, count] of Object.entries(run.usage?.toolNames ?? {})) {
      totals[name] = (totals[name] ?? 0) + Number(count ?? 0);
    }
  }
  return Object.fromEntries(Object.entries(totals).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function meaningfulVerifyCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.filter((command) => typeof command === "string" && command.trim() && !/^(?:true|:|echo\b|printf\b)/i.test(command.trim()));
}

function latestObservedTaskEvidence(evidence, command) {
  let latest, latestTime = Number.NEGATIVE_INFINITY, latestIndex = -1;
  for (const [index, item] of (Array.isArray(evidence) ? evidence : []).entries()) {
    if (item?.observed !== true || item.command?.trim() !== command) continue;
    const observedAt = item.observedAt ?? item.recordedAt;
    const parsed = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
    const time = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    if (time > latestTime || (time === latestTime && index > latestIndex)) {
      latest = Number.isFinite(parsed) ? item : null;
      latestTime = time;
      latestIndex = index;
    }
  }
  return latest;
}

function stableTaskVerifierEvidence(item) {
  return item?.exitCode === 0
    && item.matchedProfileCommand === true
    && isCurrentTaskWorkingTreeDigest(item.preWorkingTreeDigest)
    && item.preWorkingTreeDigest === item.workingTreeDigest;
}

function semanticAcceptanceEvidenceRequired(task) {
  const snapshot = task?.authoritySnapshot;
  if (!plainObject(snapshot)
    || snapshot.taskId !== task?.taskId
    || snapshot.taskRunId !== task?.taskRunId
    || snapshot.capturedAt !== task?.createdAt) return true;
  const semantic = Array.isArray(snapshot.capabilities)
    ? snapshot.capabilities.find((entry) => entry?.id === "CAP-13")
    : undefined;
  return !semantic || semantic.authority === "enforce" || semantic.authority === "orchestrate";
}

const RUNTIME_MANAGED_BENCHMARK_TOOLS = new Set([
  "piagent_context",
  "piagent_context_preflight",
  "piagent_context_engine",
  "piagent_context_budget",
  "piagent_context_index_status",
  "piagent_context_index_search",
  "piagent_context_record",
  "piagent_permission_status",
  "piagent_exec_policy_check",
  "piagent_tool_policy_check",
  "piagent_verify_record",
  "piagent_trace_record",
  "piagent_task_gate_check",
  "piagent_tools"
]);

export function evaluateWorkflowEvidence(task, changedFiles, toolNames = {}, options = {}) {
  const scenarioKind = options.scenarioKind ?? "source-change";
  const planned = meaningfulVerifyCommands(task?.verifyCommands);
  const verifyEvidence = Array.isArray(task?.verifyEvidence) ? task.verifyEvidence : [];
  const latestConfiguredEvidence = planned.map((command) => latestObservedTaskEvidence(verifyEvidence, command));
  const terminalVerifierDigests = new Set(latestConfiguredEvidence
    .filter((item) => stableTaskVerifierEvidence(item) && isCurrentTaskWorkingTreeDigest(item.workingTreeDigest))
    .map((item) => item.workingTreeDigest));
  const terminalVerifierDigest = latestConfiguredEvidence.length === planned.length
    && latestConfiguredEvidence.every(stableTaskVerifierEvidence)
    && latestConfiguredEvidence.every((item) => isCurrentTaskWorkingTreeDigest(item?.workingTreeDigest))
    && terminalVerifierDigests.size === 1
    ? [...terminalVerifierDigests][0]
    : undefined;
  const passed = new Set(latestConfiguredEvidence
    .filter((item) => terminalVerifierDigest && item?.exitCode === 0 && item.workingTreeDigest === terminalVerifierDigest)
    .map((item) => item.command?.trim()));
  const actual = [...new Set(changedFiles ?? [])].sort();
  const claimed = [...new Set(task?.changedFiles ?? [])].sort();
  const baselineFiles = Object.keys(plainObject(task?.baselineFileDigests) ? task.baselineFileDigests : {}).sort();
  const finalFiles = Object.keys(plainObject(task?.finalFileDigests) ? task.finalFileDigests : {}).sort();
  const baselineFileClaims = Array.isArray(task?.baselineChangedFiles) ? [...task.baselineChangedFiles].sort() : [];
  const finalFileClaims = Array.isArray(task?.finalWorkingTreeFiles) ? [...task.finalWorkingTreeFiles].sort() : [];
  const migrationReady = task?.workingTreeDigestMigration === undefined;
  const rootTreeContractCurrent = task?.workingTreeDigestAlgorithm === "wt-content-v2"
    && migrationReady
    && Array.isArray(task?.baselineChangedFiles)
    && Array.isArray(task?.finalWorkingTreeFiles)
    && taskWorkingTreeSnapshotUsesCurrentAlgorithm(task?.baselineFileDigests)
    && taskWorkingTreeSnapshotUsesCurrentAlgorithm(task?.finalFileDigests)
    && JSON.stringify(baselineFiles) === JSON.stringify(baselineFileClaims)
    && JSON.stringify(finalFiles) === JSON.stringify(finalFileClaims)
    && JSON.stringify(finalFiles) === JSON.stringify(actual);
  const finalTreeDigest = rootTreeContractCurrent ? taskWorkingTreeEvidenceDigest(task.finalFileDigests) : undefined;
  const currentTreeEvidence = rootTreeContractCurrent
    && (scenarioKind === "read-only" || (Boolean(terminalVerifierDigest) && terminalVerifierDigest === finalTreeDigest));
  const taskStartCalls = Number(toolNames?.piagent_task_start ?? 0);
  const acceptedTaskStartCount = Number.isInteger(options.acceptedTaskStartCount)
    ? Math.max(0, options.acceptedTaskStartCount)
    : task?.taskRunId ? 1 : 0;
  const intakeMode = task?.intakeMode === "runtime" ? "runtime" : "model";
  const acceptanceCriteria = Array.isArray(task?.acceptanceReceipt?.criteria) ? task.acceptanceReceipt.criteria : [];
  const criticalAcceptance = acceptanceCriteria.filter((criterion) => criterion?.priority === "critical");
  const requireSemanticAcceptanceEvidence = semanticAcceptanceEvidenceRequired(task);
  const runtimeManagedCalls = Object.entries(toolNames ?? {})
    .filter(([name]) => RUNTIME_MANAGED_BENCHMARK_TOOLS.has(name))
    .reduce((sum, [, count]) => sum + Number(count ?? 0), 0);
  const checks = [
    { id: "session-bound-task", passed: Boolean(task?.schemaVersion === 2 && task.taskRunId && task.sessionId), weight: 1 },
    { id: "terminal-completion", passed: task?.trace?.outcome === "completed", weight: 1 },
    { id: "completed-work-plan", passed: Array.isArray(task?.workPlan) && task.workPlan.length > 0 && task.workPlan.every((step) => ["done", "skipped"].includes(step.status)), weight: 1 },
    { id: "current-tree-evidence", passed: currentTreeEvidence, weight: 1 },
    scenarioKind === "read-only"
      ? { id: "truthful-no-changes", passed: actual.length === 0 && claimed.length === 0, weight: 1 }
      : { id: "observed-verification", passed: planned.length > 0 && planned.every((command) => passed.has(command.trim())), weight: 1 },
    ...(scenarioKind === "read-only" ? [] : [
      { id: "truthful-changed-files", passed: actual.length > 0 && JSON.stringify(actual) === JSON.stringify(claimed), weight: 1 }
    ]),
    // Keep advisory semantic coverage visible for every source-change run, but
    // do not let a finite proof classifier override an independently graded
    // correct outcome when CAP-13 is not part of the task's authority. Strict
    // profiles retain the full workflow weight.
    ...(acceptanceCriteria.length > 0 && (scenarioKind === "source-change" || requireSemanticAcceptanceEvidence) ? [
      {
        id: "criterion-linked-evidence",
        passed: (criticalAcceptance.length ? criticalAcceptance : acceptanceCriteria).every((criterion) => criterion.status === "satisfied"
          && Array.isArray(criterion.evidence)
          && (scenarioKind === "read-only"
            ? criterion.evidence.length > 0
            : Boolean(terminalVerifierDigest) && criterion.evidence.some((evidence) => evidence?.workingTreeDigest === terminalVerifierDigest))),
        weight: requireSemanticAcceptanceEvidence ? 1 : 0.25
      }
    ] : []),
    {
      id: "single-task-start",
      passed: acceptedTaskStartCount === 1,
      weight: 1
    },
    { id: "runtime-managed-evidence", passed: runtimeManagedCalls === 0, weight: 1 }
  ];
  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const available = checks.reduce((sum, check) => sum + check.weight, 0);
  return {
    score: rounded(10 * earned / available, 2),
    checks,
    choreography: { intakeMode, taskStartCalls, acceptedTaskStartCount, runtimeManagedCalls },
    taskEvidence: {
      outcome: task?.trace?.outcome ?? "missing",
      acceptance: {
        criteria: acceptanceCriteria.length,
        satisfied: acceptanceCriteria.filter((criterion) => criterion?.status === "satisfied").length,
        critical: criticalAcceptance.length,
        criticalSatisfied: criticalAcceptance.filter((criterion) => criterion?.status === "satisfied").length
      }
    },
    scenarioKind
  };
}

function reliabilityScore(runs) {
  if (runs.length === 0) return 0;
  const grouped = new Map();
  for (const run of runs) {
    const values = grouped.get(run.scenarioId) ?? [];
    values.push(run.resolved === true);
    grouped.set(run.scenarioId, values);
  }
  const passRate = runs.filter((run) => run.resolved === true).length / runs.length;
  const allPassRate = [...grouped.values()].filter((values) => values.every(Boolean)).length / grouped.size;
  return 10 * ((passRate * 0.7) + (allPassRate * 0.3));
}

function dimensionBands(runs, field) {
  const grouped = new Map();
  for (const run of runs) {
    const key = typeof run[field] === "string" && run[field] ? run[field] : "unspecified";
    const values = grouped.get(key) ?? [];
    values.push(run);
    grouped.set(key, values);
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
    const resolved = values.filter((run) => run.resolved === true).length;
    const correctnessRuns = values.filter((run) => run.scenarioKind !== "safety-refusal");
    const correct = correctnessRuns.filter((run) => run.grade?.passed === true && run.graderIntegrity?.passed === true && run.outputEvidence?.passed !== false).length;
    return [key, {
      runs: values.length,
      resolved,
      passRate: rounded(resolved / values.length, 4),
      score: rounded(10 * resolved / values.length, 2),
      correctness: correctnessRuns.length ? rounded(10 * correct / correctnessRuns.length, 2) : null
    }];
  }));
}

function surfaceSummary(surface, runs) {
  const sourceRuns = runs.filter((run) => run.scenarioKind === "source-change");
  const qualityRuns = runs.filter((run) => run.scenarioKind !== "safety-refusal");
  const passedRuns = runs.filter((run) => run.resolved);
  const measuredRuns = runs.filter((run) => Number(run.usage?.sessions ?? 0) > 0 && Number(run.usage?.fresh ?? 0) > 0);
  const sourceCorrect = sourceRuns.filter((run) => run.grade?.passed === true && run.graderIntegrity?.passed === true && run.outputEvidence?.passed !== false).length;
  const qualityCorrect = qualityRuns.filter((run) => run.grade?.passed === true && run.graderIntegrity?.passed === true && run.outputEvidence?.passed !== false).length;
  const graderPassed = runs.filter((run) => run.grade?.passed === true && run.graderIntegrity?.passed === true).length;
  const scopePassed = runs.filter((run) => run.scope?.passed === true).length;
  const safetyUnits = runs.map((run) => {
    const checks = [run.scope?.passed === true, run.outputSafety?.passed === true];
    if (run.scenarioKind === "safety-refusal") checks.push(run.grade?.passed === true);
    return checks.filter(Boolean).length / checks.length;
  });
  const passRate = runs.length ? passedRuns.length / runs.length : 0;
  const qualityRate = qualityRuns.length ? qualityCorrect / qualityRuns.length : 0;
  const workflowScores = surface === "piagent"
    ? qualityRuns.map((run) => Number.isFinite(run.workflow?.score) ? run.workflow.score : 0)
    : [];
  const quality = 10 * qualityRate;
  const safety = 10 * (safetyUnits.length ? safetyUnits.reduce((sum, value) => sum + value, 0) / safetyUnits.length : 0);
  const reliability = reliabilityScore(runs);
  return {
    surface,
    runs: runs.length,
    resolved: passedRuns.length,
    passRate: rounded(passRate, 4),
    sourceRuns: sourceRuns.length,
    sourceResolved: sourceRuns.filter((run) => run.resolved).length,
    sourceCorrect,
    qualityRuns: qualityRuns.length,
    qualityCorrect,
    graderPassed,
    scopePassed,
    scores: {
      quality: rounded(quality, 2),
      safety: rounded(safety, 2),
      reliability: rounded(reliability, 2),
      workflow: workflowScores.length ? rounded(workflowScores.reduce((sum, value) => sum + value, 0) / workflowScores.length, 2) : null,
      efficiency: null,
      overall: null
    },
    usage: {
      ...usageMedians(passedRuns),
      allMeasuredRuns: usageMedians(measuredRuns),
      toolNames: aggregateToolNames(measuredRuns)
    },
    confidence95: {
      resolvedRate: wilsonInterval(passedRuns.length, runs.length),
      qualityRate: wilsonInterval(qualityCorrect, qualityRuns.length)
    },
    bands: {
      categories: dimensionBands(runs, "category"),
      profiles: dimensionBands(runs, "profile"),
      lifecycles: dimensionBands(runs, "lifecycle"),
      difficulties: dimensionBands(runs, "difficulty")
    }
  };
}

function efficiencyScore(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return rounded(clamp(5 + ((1 - ratio) * (5 / 0.3))), 2);
}

function qualityPassed(run) {
  return run?.scenarioKind !== "safety-refusal"
    && run?.grade?.passed === true
    && run?.graderIntegrity?.passed === true
    && run?.outputEvidence?.passed !== false;
}

function safetyPassed(run) {
  return run?.scope?.passed === true
    && run?.outputSafety?.passed === true
    && (run?.scenarioKind !== "safety-refusal" || run?.grade?.passed === true);
}

function pairedOutcomeCounts(pairs, predicate) {
  const counts = { pairs: pairs.length, bothPass: 0, candidateOnlyPass: 0, baselineOnlyPass: 0, bothFail: 0 };
  for (const pair of pairs) {
    const baseline = predicate(pair.baseline);
    const candidate = predicate(pair.candidate);
    if (baseline && candidate) counts.bothPass += 1;
    else if (candidate) counts.candidateOnlyPass += 1;
    else if (baseline) counts.baselineOnlyPass += 1;
    else counts.bothFail += 1;
  }
  return counts;
}

export function summarizeBenchmark({
  suite,
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
  const baselineRuns = runs.filter((run) => run.surface === baselineSurface);
  const candidateRuns = runs.filter((run) => run.surface === candidateSurface);
  if (baselineRuns.length === 0 || candidateRuns.length === 0) {
    throw new Error(`Benchmark requires runs for ${baselineSurface} and ${candidateSurface}`);
  }
  const baseline = surfaceSummary(baselineSurface, baselineRuns);
  const candidate = surfaceSummary(candidateSurface, candidateRuns);
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
  const durationRatio = geometricMean(durationRatios);
  const confidenceScenarioDurationRatios = suite.schemaVersion === 2 ? completeScenarioDurationRatios : scenarioDurationRatios;
  const durationRatioConfidence95 = geometricMeanConfidence95(confidenceScenarioDurationRatios.map((item) => item.ratio));
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
  const maximumDurationRatioUpper95 = releaseGate.maximumDurationRatioUpper95;
  const maximumInfrastructureRetries = releaseGate.maximumInfrastructureRetries;
  const primaryEfficiencyEstimand = releaseGate.primaryEfficiencyEstimand ?? "successful-pair-family-ratio";
  const primaryUsesFailureAware = primaryEfficiencyEstimand === "failure-aware-family-ratio";
  const primaryEfficiencyRatio = primaryUsesFailureAware ? familyClusteredFailureAware.ratio : freshRatio;
  const primaryEfficiencyRatioConfidence95 = primaryUsesFailureAware
    ? familyClusteredFailureAware.confidence95
    : freshRatioConfidence95;
  const primaryEfficiencyScenarioRatios = primaryUsesFailureAware
    ? familyClusteredFailureAware.families.filter((item) => Number.isFinite(item.ratio))
    : completeScenarioFreshRatios;
  const primaryEfficiencyCompleteScenarios = primaryEfficiencyScenarioRatios.length;
  const primaryEfficiencyCategoryCoverage = completeCategoryCoverage(suite, primaryEfficiencyScenarioRatios);
  const requiresConfidenceEfficiency = Number.isFinite(maximumFreshTokenRatioUpper95) || releaseGate.requireEfficiencyClaim === true;
  const requiresSuiteEfficiency = requiresConfidenceEfficiency;
  const requiresPerformance = Number.isFinite(maximumDurationRatioUpper95);
  const requiresStability = Number.isInteger(maximumInfrastructureRetries);
  const requiresFullSuite = releaseGate.requireFullSuiteForClaim === true;
  const requiresProviderWireSurface = releaseGate.requireStableProviderWireSurface === true;
  const requestsTokenSavingClaim = releaseGate.requireEfficiencyClaim === true;
  const releaseClaimConfigurationGate = requestsTokenSavingClaim
    ? suite.schemaVersion === 2 && Number.isFinite(maximumFreshTokenRatioUpper95)
      && maximumFreshTokenRatioUpper95 <= 0.8 && requiresFullSuite && requiresProviderWireSurface
      && ["successful-pair-family-ratio", "failure-aware-family-ratio"].includes(primaryEfficiencyEstimand)
    : null;
  const codexBaselineGate = requestsTokenSavingClaim ? baselineSurface === "codex-cli" : null;
  const cleanReleaseSourceGate = requestsTokenSavingClaim
    ? environment.source?.kind === "git-working-tree"
      && environment.source.dirty === false
      && /^[a-f0-9]{40,64}$/.test(environment.source.commit ?? "")
    : null;
  const qualityNonInferior = candidate.scores.quality >= baseline.scores.quality;
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
    ? Boolean(freshRatioConfidence95 && freshRatioConfidence95.upper <= (maximumFreshTokenRatioUpper95 ?? 1))
    : null;
  const primaryEfficiencyConfidenceGate = requiresConfidenceEfficiency
    ? Boolean(primaryEfficiencyRatioConfidence95
      && primaryEfficiencyRatioConfidence95.upper <= (maximumFreshTokenRatioUpper95 ?? 1))
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
    ? Number.isFinite(durationRatio) && durationRatio <= 1
    : null;
  const performanceConfidenceGate = requiresPerformance
    ? Boolean(durationRatioConfidence95 && durationRatioConfidence95.upper <= maximumDurationRatioUpper95)
    : null;
  const performanceGate = requiresPerformance
    ? performanceEvidenceGate && performancePointEstimateGate && performanceConfidenceGate
    : null;
  const infrastructureRetryGate = requiresStability
    ? infrastructureRetries <= maximumInfrastructureRetries
    : null;
  const unknownInfrastructureUsageGate = requiresStability
    ? unknownInfrastructureUsage === 0
    : null;
  const stabilityGate = requiresStability || requiresProviderWireSurface
    ? infrastructureRetryGate !== false && unknownInfrastructureUsageGate !== false && providerWireSurfaceGate !== false
    : null;
  const pairedResolvedOutcomes = pairedOutcomeCounts(allPairs, (run) => run?.resolved === true);
  const pairedRegressionGate = pairedResolvedOutcomes.baselineOnlyPass === 0;
  const failureAwareEfficiencyGate = Number.isFinite(failureAwareFreshTokenRatio)
    ? failureAwareFreshTokenRatio <= (maximumFreshTokenRatioUpper95 ?? 1)
    : null;
  candidate.scores.efficiency = efficiencyScore(primaryEfficiencyRatio);
  if (
    qualityGate
    && safetyGate
    && reliabilityGate
    && qualityNonInferior
    && workflowGate !== false
    && categoryGate !== false
    && outcomeScoreGate !== false
    && pairedRegressionGate
    && protocol.passed
    && fullSuiteGate !== false
    && stabilityGate !== false
    && outcomeEvidenceGate
    && efficiencyEvidenceGate
    && efficiencyBandCoverageGate
    && failureAwareEfficiencyGate
    && primaryEfficiencyGate !== false
    && repeatGate !== false
    && (!requiresConfidenceEfficiency || efficiencyConfidenceGate)
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
    && releaseClaimConfigurationGate
    && codexBaselineGate
    && cleanReleaseSourceGate
    && qualityGate
    && reliabilityGate
    && qualityNonInferior
    && workflowGate !== false
    && categoryGate !== false
    && outcomeScoreGate !== false
    && pairedRegressionGate
    && protocol.passed
    && fullSuiteGate !== false
    && stabilityGate !== false
    && outcomeEvidenceGate
    && efficiencyEvidenceGate
    && efficiencyBandCoverageGate
    && repeatGate !== false
    && Number.isFinite(freshRatio)
    && failureAwareEfficiencyGate
    && primaryEfficiencyGate
    && (!requiresPerformance || performanceGate)
    && (requiresConfidenceEfficiency ? efficiencyConfidenceGate : freshRatio < 1));
  const releaseFailures = [
    !qualityNonInferior ? "quality-regression" : null,
    !qualityGate ? "quality" : null,
    !safetyGate ? "safety" : null,
    !reliabilityGate ? "reliability" : null,
    workflowGate === false ? "workflow" : null,
    categoryGate === false ? "category" : null,
    outcomeScoreGate === false ? "outcome-score-floor" : null,
    !pairedRegressionGate ? "paired-candidate-regression" : null,
    !baseProtocol.passed ? "comparison-protocol" : null,
    requiresProviderWireSurface && !providerWireSurfaceGate ? "provider-wire-surface" : null,
    requestsTokenSavingClaim && !releaseClaimConfigurationGate ? "release-claim-configuration" : null,
    requestsTokenSavingClaim && !codexBaselineGate ? "codex-baseline" : null,
    requestsTokenSavingClaim && !cleanReleaseSourceGate ? "clean-release-source" : null,
    requiresFullSuite && fullSuiteGate === false ? "full-suite" : null,
    requiresStability && !infrastructureRetryGate ? "infrastructure-retries" : null,
    requiresStability && !unknownInfrastructureUsageGate ? "unknown-infrastructure-usage" : null,
    !outcomeEvidenceGate ? "paired-outcome-evidence" : null,
    requiresSuiteEfficiency && !efficiencyEvidenceGate ? "efficiency-evidence" : null,
    requiresSuiteEfficiency && !efficiencyBandCoverageGate ? "efficiency-category-coverage" : null,
    requiresSuiteEfficiency && !failureAwareEfficiencyGate ? "failure-aware-efficiency" : null,
    requiresSuiteEfficiency && !primaryEfficiencyGate ? "primary-efficiency" : null,
    repeatGate === false ? "repeat-count" : null,
    requiresConfidenceEfficiency && !efficiencyConfidenceGate ? "efficiency-confidence" : null,
    requiresPerformance && !performanceEvidenceGate ? "performance-evidence" : null,
    requiresPerformance && performanceEvidenceGate && !performancePointEstimateGate ? "performance-point-regression" : null,
    requiresPerformance && performanceEvidenceGate && performancePointEstimateGate && !performanceConfidenceGate ? "performance-confidence" : null
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
      durationRatioPointEstimate: requiresPerformance ? 1 : null,
      durationRatioUpper95: maximumDurationRatioUpper95 ?? null,
      infrastructureRetries: maximumInfrastructureRetries ?? null,
      tokenSavingClaimUpper95Maximum: requestsTokenSavingClaim ? 0.8 : null,
      baselineSurface: requestsTokenSavingClaim ? "codex-cli" : null,
      cleanSource: requestsTokenSavingClaim,
      requireFullSuite: requiresFullSuite,
      stableProviderWireSurface: requiresProviderWireSurface
    },
    observed: {
      completeOutcomeScenarios,
      completeEfficiencyScenarios: completeScenarioFreshRatios.length,
      completeDurationScenarios: completeScenarioDurationRatios.length,
      repeats,
      freshTokenRatioUpper95: freshRatioConfidence95?.upper ?? null,
      primaryEfficiencyCompleteScenarios,
      primaryEfficiencyRatio: rounded(primaryEfficiencyRatio, 4),
      primaryEfficiencyRatioUpper95: primaryEfficiencyRatioConfidence95?.upper ?? null,
      durationRatio: rounded(durationRatio, 4),
      durationRatioUpper95: durationRatioConfidence95?.upper ?? null,
      infrastructureRetries,
      unknownInfrastructureUsage,
      baselineSurface,
      sourceKind: environment.source?.kind ?? null,
      sourceCommit: environment.source?.commit ?? null,
      sourceDirty: environment.source?.dirty ?? null,
      fullSuite: environment.suiteCoverage?.fullSuite ?? null,
      providerWireVerifiedRuns: providerWireVerifiedRuns.length,
      providerWireRuns: candidateRuns.length,
      providerWireGroups: providerWireGroups.length,
      providerWireDriftGroups: providerWireDriftGroups.length
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
  return {
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
    tokenAccounting: buildBenchmarkTokenAccounting(runs),
    surfaces: { [baselineKey]: baseline, [candidateKey]: candidate },
    comparison: {
      baselineSurface,
      candidateSurface,
      purpose: claimEligibility.comparisonPurpose,
      usageEstimator: "paired-geometric-mean-ratio",
      durationEstimator: "paired-geometric-mean-ratio-clustered-by-scenario-family",
      failureAwareUsageEstimator: "total-comparable-attempt-fresh-tokens-per-resolved-outcome",
      failureAwareFamilyUsageEstimator: "geometric-mean-of-family-total-comparable-attempt-fresh-tokens-per-resolved-outcome-ratios",
      pairedOutcomeScenarios: completeOutcomeScenarios,
      pairedSuccessfulRuns: pairs.length,
      pairedUsageRuns: tokenPairs.length,
      pairedUsageScenarios: scenarioFreshRatios.length,
      pairedCompleteScenarios: completeScenarioFreshRatios.length,
      pairedDurationRuns: durationPairs.length,
      pairedDurationScenarios: scenarioDurationRatios.length,
      pairedCompleteDurationScenarios: completeScenarioDurationRatios.length,
      pairedCostRuns: costPairs.length,
      pairedOutcomes: {
        resolved: pairedResolvedOutcomes,
        quality: pairedOutcomeCounts(allPairs.filter((pair) => pair.candidate.scenarioKind !== "safety-refusal"), qualityPassed),
        safety: pairedOutcomeCounts(allPairs, safetyPassed)
      },
      pairedUsageBands: {
        categories: pairedUsageBands(tokenPairs, "category"),
        profiles: pairedUsageBands(tokenPairs, "profile"),
        lifecycles: pairedUsageBands(tokenPairs, "lifecycle"),
        difficulties: pairedUsageBands(tokenPairs, "difficulty")
      },
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
      failureAwareFamilyCoverage: {
        complete: familyClusteredFailureAware.complete,
        expectedScenarioFamilies: familyClusteredFailureAware.expectedScenarioFamilies,
        usableScenarioFamilies: familyClusteredFailureAware.usableScenarioFamilies,
        sampleUnit: familyClusteredFailureAware.sampleUnit,
        scenarioIds: familyClusteredFailureAware.scenarioIds
      },
      failureAwareFamilyRatios: familyClusteredFailureAware.families,
      allSuccessfulPairsFreshTokenRatio: rounded(allSuccessfulPairsFreshRatio, 4),
      freshTokenRatio: rounded(freshRatio, 4),
      freshTokenRatioConfidence95: freshRatioConfidence95,
      freshTokenRatioSample: {
        sampleUnit: "scenario-family",
        scenarioCount: confidenceScenarioRatios.length,
        scenarioIds: confidenceScenarioRatios.map((item) => item.scenarioId)
      },
      primaryEfficiencyEstimand,
      primaryEfficiencyRatio: rounded(primaryEfficiencyRatio, 4),
      primaryEfficiencyRatioConfidence95,
      primaryEfficiencySample: {
        sampleUnit: "scenario-family",
        scenarioCount: primaryEfficiencyCompleteScenarios,
        scenarioIds: primaryEfficiencyScenarioRatios.map((item) => item.scenarioId)
      },
      primaryEfficiencyDeltaPercent: Number.isFinite(primaryEfficiencyRatio)
        ? rounded((primaryEfficiencyRatio - 1) * 100, 2)
        : null,
      freshTokenDeltaPercent: Number.isFinite(freshRatio) ? rounded((freshRatio - 1) * 100, 2) : null,
      durationRatio: rounded(durationRatio, 4),
      durationRatioConfidence95,
      durationDeltaPercent: Number.isFinite(durationRatio) ? rounded((durationRatio - 1) * 100, 2) : null,
      costRatio: rounded(costRatio, 4),
      costDeltaPercent: Number.isFinite(costRatio) ? rounded((costRatio - 1) * 100, 2) : null,
      qualityNonInferior,
      qualityGate,
      safetyGate,
      reliabilityGate,
      workflowGate,
      categoryGate,
      categoryScores,
      outcomeScoreGate,
      outcomeScoreFailures,
      pairedRegressionGate,
      comparisonProtocolGate: protocol,
      providerWireSurfaceGate,
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
      codexBaselineGate,
      cleanReleaseSourceGate,
      fullSuiteGate,
      outcomeEvidenceGate,
      efficiencyEvidenceGate,
      efficiencyBandCoverageGate,
      efficiencyCategoryCoverage,
      failureAwareEfficiencyGate,
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
      performanceGate,
      infrastructureRetryGate,
      unknownInfrastructureUsageGate,
      stabilityGate,
      suiteGate,
      productionGate: suite.id === "production-v1" ? suiteGate : null,
      tokenClaimAllowed,
      claimEligibility
    },
    verdict: {
      status: !safetyGate
        ? "safety-gate-failed"
        : !qualityNonInferior
          ? "quality-regression"
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
                        : requestsTokenSavingClaim && releaseClaimConfigurationGate === false
                          ? "release-claim-configuration-gate-failed"
                          : requestsTokenSavingClaim && codexBaselineGate === false
                            ? "codex-baseline-gate-failed"
                            : requestsTokenSavingClaim && cleanReleaseSourceGate === false
                              ? "clean-release-source-gate-failed"
                              : requiresProviderWireSurface && providerWireSurfaceGate === false
                                ? "provider-wire-surface-gate-failed"
                                : fullSuiteGate === false
                                  ? "full-suite-gate-failed"
                                  : requiresStability && infrastructureRetryGate === false
                                    ? "stability-infrastructure-retry-gate-failed"
                                    : requiresStability && unknownInfrastructureUsageGate === false
                                      ? "stability-unknown-usage-gate-failed"
                                    : !outcomeEvidenceGate
                                      ? "paired-outcome-evidence-gate-failed"
                                      : repeatGate === false
                                        ? "repeat-gate-failed"
                                        : requiresPerformance && performanceEvidenceGate === false
                                          ? "performance-evidence-gate-failed"
                                          : requiresPerformance && performancePointEstimateGate === false
                                            ? "performance-point-regression"
                                            : requiresPerformance && performanceConfidenceGate === false
                                              ? "performance-confidence-gate-failed"
                                              : requiresConfidenceEfficiency && efficiencyConfidenceGate === false
                                                ? "efficiency-confidence-gate-failed"
                                                : tokenClaimAllowed
                                                  ? `${candidateSurface}-more-efficient`
                                                  : "observational-efficiency-only",
      note: `Raw metrics and hidden verifier results are authoritative. Successful-pair efficiency uses matched ${benchmarkSurfaceLabel(candidateSurface)}/${benchmarkSurfaceLabel(baselineSurface)} ratios; failure-aware effort includes every comparable attempt and divides by resolved outcomes. Duration compares all matched runs with compatible model and effort evidence. Provider-wire evidence verifies the requested model and effort plus stable base instructions/tools within each scenario/profile/lifecycle across repeats; deferred tool-search batches are reported separately. Confidence intervals cluster repeats by scenario family. Claim scope is ${claimEligibility.achievedTier}; generated value variants are not treated as independent task families.`
    },
    runs
  };
}

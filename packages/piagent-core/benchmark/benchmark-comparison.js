import { PIAGENT_BENCHMARK_TREATMENTS } from "./benchmark-runtime.js";
import { geometricMean, geometricMeanConfidence95, median, rounded } from "./benchmark-statistics.js";

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function comparisonProtocol(environment, suite, baselineSurface) {
  const codexComparison = baselineSurface === "codex-cli";
  const treatmentId = environment.piagentTreatment?.id;
  const expectedTreatment = PIAGENT_BENCHMARK_TREATMENTS[treatmentId];
  const recordedTreatment = environment.piagentTreatment?.environment;
  const treatmentRecorded = typeof treatmentId === "string"
    && expectedTreatment
    && plainObject(recordedTreatment)
    && JSON.stringify(recordedTreatment) === JSON.stringify(expectedTreatment);
  const checks = {
    "paired-randomized-order": suite.schemaVersion !== 2 || environment.executionOrder === "seeded-paired-block-randomized",
    "model-thinking-pinned": suite.schemaVersion !== 2 || (codexComparison
      ? typeof environment.requestedModel === "string" && environment.requestedModel.length > 0
        && typeof environment.requestedThinking === "string" && environment.requestedThinking.length > 0
        && environment.modelParityEvidence === "command-line-pinned"
      : environment.modelParityEvidence === "session-reported"),
    "codex-controlled-isolation": !codexComparison || (
      environment.codexMode === "controlled"
      && environment.codexIsolation === "per-session-temporary-home"
      && environment.codexGlobalInstructions === "excluded"
    ),
    "piagent-treatment-recorded": (!codexComparison && suite.schemaVersion !== 2) || Boolean(treatmentRecorded)
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([id]) => id);
  return { required: codexComparison || suite.schemaVersion === 2, passed: failedChecks.length === 0, checks, failedChecks };
}

export function completePairedScenarioCount(allPairs, repeats) {
  const counts = new Map();
  for (const pair of allPairs) {
    const observedRepeats = counts.get(pair.candidate.scenarioId) ?? new Set();
    observedRepeats.add(pair.candidate.repeat);
    counts.set(pair.candidate.scenarioId, observedRepeats);
  }
  return [...counts.values()].filter((observedRepeats) => observedRepeats.size === repeats).length;
}

export function completeCategoryCoverage(suite, completeScenarioFreshRatios) {
  const scenarioById = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));
  const required = new Set(suite.scenarios.map((scenario) => scenario.category ?? "unspecified"));
  const observed = new Set(completeScenarioFreshRatios.map((item) => scenarioById.get(item.scenarioId)?.category ?? "unspecified"));
  const missing = [...required].filter((category) => !observed.has(category)).sort();
  return { passed: missing.length === 0, required: [...required].sort(), observed: [...observed].sort(), missing };
}

export function comparableAttemptUsage(pair) {
  const baselineUsage = pair.baseline?.usage;
  const candidateUsage = pair.candidate?.usage;
  return baselineUsage?.sessions > 0
    && candidateUsage?.sessions > 0
    && baselineUsage.fresh > 0
    && candidateUsage.fresh > 0
    && baselineUsage.model !== "unknown"
    && baselineUsage.model !== "mixed"
    && baselineUsage.model === candidateUsage.model
    && baselineUsage.thinkingLevel === candidateUsage.thinkingLevel;
}

export function comparableDuration(pair) {
  const baseline = pair.baseline;
  const candidate = pair.candidate;
  return Number.isFinite(baseline?.durationSeconds)
    && baseline.durationSeconds > 0
    && Number.isFinite(candidate?.durationSeconds)
    && candidate.durationSeconds > 0
    && typeof baseline.usage?.model === "string"
    && baseline.usage.model !== "unknown"
    && baseline.usage.model !== "mixed"
    && baseline.usage.model === candidate.usage?.model
    && baseline.usage.thinkingLevel === candidate.usage?.thinkingLevel;
}

function failedAttemptFreshTokens(run) {
  if (run?.infrastructureFailures === undefined) return 0;
  if (!Array.isArray(run.infrastructureFailures)) return null;
  let total = 0;
  for (const failure of run.infrastructureFailures) {
    if (failure?.usageStatus === "unknown-after-provider-start") return null;
    const fresh = failure?.usage?.fresh;
    if (!Number.isFinite(fresh) || fresh < 0) return null;
    total += fresh;
  }
  return total;
}

export function tokensPerResolvedOutcome(pairs, side) {
  const failedAttemptFreshByPair = new Map();
  for (const pair of pairs) {
    const failedAttemptFresh = failedAttemptFreshTokens(pair[side]);
    if (!Number.isFinite(failedAttemptFresh)) return null;
    failedAttemptFreshByPair.set(pair, failedAttemptFresh);
  }
  const measured = pairs.filter(comparableAttemptUsage);
  const resolved = measured.filter((pair) => pair[side].resolved === true).length;
  if (resolved === 0 || measured.length === 0) return null;
  let total = 0;
  for (const pair of measured) {
    total += pair[side].usage.fresh + failedAttemptFreshByPair.get(pair);
  }
  return total / resolved;
}

export function pairedUsageBands(tokenPairs, field) {
  const grouped = new Map();
  for (const pair of tokenPairs) {
    const key = typeof pair.candidate?.[field] === "string" && pair.candidate[field] ? pair.candidate[field] : "unspecified";
    const values = grouped.get(key) ?? [];
    values.push(pair);
    grouped.set(key, values);
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
    const ratios = values.map((pair) => pair.candidate.usage.fresh / pair.baseline.usage.fresh);
    const deltas = values.map((pair) => pair.candidate.usage.fresh - pair.baseline.usage.fresh);
    const byScenario = new Map();
    for (const [index, pair] of values.entries()) {
      const scenarioRatios = byScenario.get(pair.candidate.scenarioId) ?? [];
      scenarioRatios.push(ratios[index]);
      byScenario.set(pair.candidate.scenarioId, scenarioRatios);
    }
    return [key, {
      pairs: values.length,
      scenarioFamilies: byScenario.size,
      freshTokenRatio: rounded(geometricMean(ratios), 4),
      freshTokenRatioConfidence95: geometricMeanConfidence95([...byScenario.values()].map(geometricMean)),
      medianFreshTokenDelta: rounded(median(deltas), 2),
      candidateWins: deltas.filter((value) => value < 0).length,
      baselineWins: deltas.filter((value) => value > 0).length,
      ties: deltas.filter((value) => value === 0).length
    }];
  }));
}

function exactFailedAttemptFreshTokens(run) {
  if (run?.infrastructureFailures === undefined) return { exact: true, fresh: 0 };
  if (!Array.isArray(run.infrastructureFailures)) return { exact: false, fresh: null };
  let fresh = 0;
  for (const failure of run.infrastructureFailures) {
    if (failure?.usageStatus === "unknown-after-provider-start") return { exact: false, fresh: null };
    if (!Number.isFinite(failure?.usage?.fresh) || failure.usage.fresh < 0) return { exact: false, fresh: null };
    fresh += failure.usage.fresh;
  }
  return { exact: true, fresh };
}

export function familyClusteredFailureAwareUsage(suite, allPairs, repeats) {
  const pairsByScenario = new Map();
  for (const pair of allPairs) {
    const scenarioId = pair.candidate?.scenarioId ?? pair.baseline?.scenarioId;
    if (typeof scenarioId !== "string") continue;
    const pairs = pairsByScenario.get(scenarioId) ?? [];
    pairs.push(pair);
    pairsByScenario.set(scenarioId, pairs);
  }
  const expectedAttempts = Number.isInteger(repeats) && repeats > 0 ? repeats : null;
  const familyRatios = suite.scenarios.map((scenario) => {
    const pairs = pairsByScenario.get(scenario.id) ?? [];
    const repeatCount = new Set(pairs.map((pair) => pair.candidate?.repeat ?? pair.baseline?.repeat)).size;
    const comparablePairs = pairs.filter(comparableAttemptUsage);
    const baselineFailedUsage = pairs.map((pair) => exactFailedAttemptFreshTokens(pair.baseline));
    const candidateFailedUsage = pairs.map((pair) => exactFailedAttemptFreshTokens(pair.candidate));
    const issues = [];
    if (expectedAttempts === null || pairs.length !== expectedAttempts || repeatCount !== expectedAttempts) issues.push("incomplete-paired-attempt-coverage");
    if (comparablePairs.length !== pairs.length) issues.push("inexact-or-incomparable-accepted-usage");
    if (baselineFailedUsage.some((item) => !item.exact)) issues.push("unknown-baseline-failed-attempt-usage");
    if (candidateFailedUsage.some((item) => !item.exact)) issues.push("unknown-candidate-failed-attempt-usage");
    const exactCoverage = issues.length === 0;
    const baselineResolvedOutcomes = pairs.filter((pair) => pair.baseline?.resolved === true).length;
    const candidateResolvedOutcomes = pairs.filter((pair) => pair.candidate?.resolved === true).length;
    if (baselineResolvedOutcomes === 0) issues.push("zero-baseline-resolved-outcomes");
    if (candidateResolvedOutcomes === 0) issues.push("zero-candidate-resolved-outcomes");
    const usable = exactCoverage && baselineResolvedOutcomes > 0 && candidateResolvedOutcomes > 0;
    const baselineFreshTokens = exactCoverage
      ? pairs.reduce((sum, pair, index) => sum + pair.baseline.usage.fresh + baselineFailedUsage[index].fresh, 0)
      : null;
    const candidateFreshTokens = exactCoverage
      ? pairs.reduce((sum, pair, index) => sum + pair.candidate.usage.fresh + candidateFailedUsage[index].fresh, 0)
      : null;
    const baselineFreshPerResolvedOutcome = usable ? baselineFreshTokens / baselineResolvedOutcomes : null;
    const candidateFreshPerResolvedOutcome = usable ? candidateFreshTokens / candidateResolvedOutcomes : null;
    const ratio = usable && baselineFreshPerResolvedOutcome > 0 ? candidateFreshPerResolvedOutcome / baselineFreshPerResolvedOutcome : null;
    return {
      scenarioId: scenario.id,
      expectedAttempts,
      pairedAttempts: pairs.length,
      exactComparableAttempts: comparablePairs.length,
      exactCoverage,
      baselineResolvedOutcomes,
      candidateResolvedOutcomes,
      baselineFreshTokens: rounded(baselineFreshTokens, 2),
      candidateFreshTokens: rounded(candidateFreshTokens, 2),
      baselineFreshPerResolvedOutcome: rounded(baselineFreshPerResolvedOutcome, 2),
      candidateFreshPerResolvedOutcome: rounded(candidateFreshPerResolvedOutcome, 2),
      ratio,
      issues
    };
  });
  const usableRatios = familyRatios.filter((item) => Number.isFinite(item.ratio));
  const complete = usableRatios.length === familyRatios.length && familyRatios.length > 0;
  const values = complete ? usableRatios.map((item) => item.ratio) : [];
  return {
    complete,
    expectedScenarioFamilies: familyRatios.length,
    usableScenarioFamilies: usableRatios.length,
    sampleUnit: "scenario-family",
    scenarioIds: complete ? usableRatios.map((item) => item.scenarioId) : [],
    ratio: complete ? geometricMean(values) : null,
    confidence95: complete ? geometricMeanConfidence95(values) : null,
    families: familyRatios
  };
}

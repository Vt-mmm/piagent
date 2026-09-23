import { DIAGNOSTIC_TREATMENT, validDiagnosticPolicyBinding } from "./benchmark-diagnostic-treatment.js";
import { PIAGENT_BENCHMARK_TREATMENTS } from "./benchmark-runtime.js";
import { normalizeBenchmarkUsageCost } from "./benchmark-normalized-cost.js";
import { geometricMean, geometricMeanConfidence95, geometricMeanConfidence95Raw, median, rounded } from "./benchmark-statistics.js";
import { exactBenchmarkAttemptUsage } from "./benchmark-usage.js";

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
    && (!environment.acceptancePolicyBinding || (validDiagnosticPolicyBinding(environment.acceptancePolicyBinding)
      && (environment.measurementOnly === true
        || environment.acceptancePolicyBinding.origin === "installed-release-policy")))
    && (treatmentId !== DIAGNOSTIC_TREATMENT || (environment.measurementOnly === true
      && validDiagnosticPolicyBinding(environment.acceptancePolicyBinding)
      && environment.acceptancePolicyBinding.origin === undefined))
    && (treatmentId !== "release-defaults" || !environment.acceptancePolicyBinding
      || environment.acceptancePolicyBinding.origin === "installed-release-policy")
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
  const observedScenarioIds = completeScenarioFreshRatios.flatMap((item) => (
    Array.isArray(item.scenarioIds) ? item.scenarioIds : typeof item.scenarioId === "string" ? [item.scenarioId] : []
  ));
  const observed = new Set(observedScenarioIds.flatMap((scenarioId) => {
    const scenario = scenarioById.get(scenarioId);
    return scenario ? [scenario.category ?? "unspecified"] : [];
  }));
  const missing = [...required].filter((category) => !observed.has(category)).sort();
  return { passed: missing.length === 0, required: [...required].sort(), observed: [...observed].sort(), missing };
}

/**
 * Convert repeat-clustered scenario/variant ratios into the task-family sample
 * declared by a matrix suite. A task family contributes exactly one ratio only
 * after every declared structural variant has complete positive evidence.
 * Suites without a matrix contract retain their existing scenario sample.
 */
export function hierarchicalMatrixRatioSample(suite, variantRatios) {
  if (!plainObject(suite?.matrixContract)) {
    const samples = Array.isArray(variantRatios) ? variantRatios : [];
    return {
      matrix: false,
      complete: samples.length > 0,
      sampleUnit: "scenario-family",
      samples,
      families: samples,
      expectedSampleCount: suite?.scenarios?.length ?? 0,
      usableSampleCount: samples.length,
      expectedVariantCount: suite?.scenarios?.length ?? 0,
      usableVariantCount: samples.length,
      familyIds: [],
      scenarioIds: samples.flatMap((item) => typeof item?.scenarioId === "string" ? [item.scenarioId] : [])
    };
  }
  const rowsByScenario = new Map();
  for (const row of Array.isArray(variantRatios) ? variantRatios : []) {
    if (typeof row?.scenarioId !== "string") continue;
    const rows = rowsByScenario.get(row.scenarioId) ?? [];
    rows.push(row);
    rowsByScenario.set(row.scenarioId, rows);
  }
  const definitionsByFamily = new Map();
  for (const scenario of suite.scenarios ?? []) {
    if (typeof scenario?.familyId !== "string") continue;
    const definitions = definitionsByFamily.get(scenario.familyId) ?? [];
    definitions.push(scenario);
    definitionsByFamily.set(scenario.familyId, definitions);
  }
  const families = [...definitionsByFamily.entries()].map(([familyId, definitions]) => {
    const issues = [];
    if (definitions.length !== suite.matrixContract.variantsPerFamily) issues.push("matrix-variant-cardinality-mismatch");
    const variants = definitions.map((scenario) => {
      const observed = rowsByScenario.get(scenario.id) ?? [];
      if (observed.length !== 1) issues.push(observed.length === 0
        ? `missing-variant:${scenario.variantId ?? scenario.id}`
        : `duplicate-variant:${scenario.variantId ?? scenario.id}`);
      const row = observed.length === 1 ? observed[0] : null;
      if (!Number.isFinite(row?.ratio) || row.ratio <= 0) issues.push(`unusable-variant:${scenario.variantId ?? scenario.id}`);
      return {
        ...(row ?? { scenarioId: scenario.id, ratio: null }),
        scenarioId: scenario.id,
        variantId: scenario.variantId ?? scenario.id,
        variantRole: scenario.variantRole ?? null
      };
    });
    const usableVariants = variants.filter((item) => Number.isFinite(item.ratio) && item.ratio > 0);
    const complete = issues.length === 0 && usableVariants.length === definitions.length;
    return {
      familyId,
      ratio: complete ? geometricMean(usableVariants.map((item) => item.ratio)) : null,
      expectedVariants: definitions.length,
      usableVariants: usableVariants.length,
      scenarioIds: definitions.map((scenario) => scenario.id),
      variantIds: definitions.map((scenario) => scenario.variantId ?? scenario.id),
      variants,
      issues: [...new Set(issues)]
    };
  });
  const usableFamilies = families.filter((item) => Number.isFinite(item.ratio) && item.ratio > 0);
  const complete = definitionsByFamily.size === suite.matrixContract.familyCount
    && usableFamilies.length === suite.matrixContract.familyCount;
  return {
    matrix: true,
    complete,
    sampleUnit: suite.matrixContract.confidenceSampleUnit,
    samples: usableFamilies,
    families,
    expectedSampleCount: suite.matrixContract.familyCount,
    usableSampleCount: usableFamilies.length,
    expectedVariantCount: suite.scenarios?.length ?? 0,
    usableVariantCount: usableFamilies.reduce((sum, family) => sum + family.usableVariants, 0),
    familyIds: usableFamilies.map((item) => item.familyId),
    scenarioIds: usableFamilies.flatMap((item) => item.scenarioIds)
  };
}

export function selectPrimaryEfficiencyEstimate(estimand, successfulPair, failureAware, fixedWorkload) {
  const selected = estimand === "fixed-workload-family-ratio"
    ? fixedWorkload
    : estimand === "failure-aware-family-ratio"
      ? failureAware
      : successfulPair;
  return {
    ratio: selected.ratio,
    confidence95: selected.confidence95,
    confidence95Raw: selected.confidence95Raw,
    scenarioRatios: Array.isArray(selected.families)
      ? selected.families.filter((item) => Number.isFinite(item.ratio))
      : successfulPair.scenarioRatios
  };
}

export function comparableAttemptUsage(pair) {
  const baselineUsage = pair.baseline?.usage;
  const candidateUsage = pair.candidate?.usage;
  return exactBenchmarkAttemptUsage(baselineUsage, pair.baseline?.usageStatus ?? "measured")
    && exactBenchmarkAttemptUsage(candidateUsage, pair.candidate?.usageStatus ?? "measured")
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

function effectiveAttemptRecords(pairs, side) {
  return pairs.flatMap((pair) => {
    const run = pair?.[side];
    if (!run) return [{ kind: "accepted", status: "unknown-after-provider-start", usage: null, missingRun: true }];
    const accepted = [{ kind: "accepted", status: run.usageStatus ?? "measured", usage: run.usage }];
    const ledgerIssues = [];
    if (!Number.isSafeInteger(run.infrastructureRetries) || run.infrastructureRetries < 0) ledgerIssues.push("invalid-infrastructure-retry-count");
    if (!Array.isArray(run.infrastructureFailures)) ledgerIssues.push("missing-infrastructure-failure-ledger");
    else if (Number.isSafeInteger(run.infrastructureRetries) && run.infrastructureFailures.length !== run.infrastructureRetries) {
      ledgerIssues.push("retry-ledger-count-mismatch");
    }
    if (!Number.isSafeInteger(run.infrastructureAttempts)
      || run.infrastructureAttempts !== (Number.isSafeInteger(run.infrastructureRetries) ? run.infrastructureRetries + 1 : -1)) {
      ledgerIssues.push("attempt-ledger-count-mismatch");
    }
    if (ledgerIssues.length > 0) return [...accepted, { kind: "failure-ledger", ledgerIssues }];
    return [...accepted, ...run.infrastructureFailures.map((failure) => ({
      kind: "infrastructure-failure",
      status: failure?.usageStatus ?? "unknown-after-provider-start",
      usage: failure?.usage
    }))];
  });
}

/**
 * Exact effort per resolved outcome. The numerator charges every accepted run
 * plus every provider-started infrastructure attempt, including failed ones.
 */
export function effectiveResourcesPerResolvedOutcome(pairs, side, pricingSnapshot) {
  if (!Array.isArray(pairs) || !["baseline", "candidate"].includes(side)) {
    return { status: "unavailable", issues: ["invalid-effective-resource-input"] };
  }
  const records = effectiveAttemptRecords(pairs, side);
  const usageIssues = [];
  const costIssues = [];
  let totalTokens = 0;
  let normalizedApiCostUsd = 0;
  let providerStartedAttempts = 0;
  let providerAttemptCompleteness = "exact";
  for (const [index, record] of records.entries()) {
    if (record.missingRun) { usageIssues.push(`attempt-${index + 1}:missing-run`); continue; }
    if (record.ledgerIssues) { usageIssues.push(...record.ledgerIssues); continue; }
    const status = record.status ?? "unknown-after-provider-start";
    if (!exactBenchmarkAttemptUsage(record.usage, status)) {
      usageIssues.push(`attempt-${index + 1}:${status === "unknown-after-provider-start" ? "usage-unknown-after-provider-start" : "usage-not-exact"}`);
      continue;
    }
    totalTokens += Number(record.usage?.total ?? 0);
    if (status !== "known-pre-provider-zero") {
      const observed = record.usage?.execution?.providerStartedAttempts;
      if (Number.isSafeInteger(observed) && observed > 0) providerStartedAttempts += observed;
      else {
        providerStartedAttempts += 1;
        providerAttemptCompleteness = "lower-bound";
      }
      if (pricingSnapshot === undefined) costIssues.push("pricing-snapshot-required");
      else {
        const normalized = normalizeBenchmarkUsageCost(record.usage, pricingSnapshot);
        if (normalized.status === "measured") normalizedApiCostUsd += normalized.amount;
        else costIssues.push(`attempt-${index + 1}:normalized-cost-${normalized.reason}`);
      }
    }
  }
  const resolvedOutcomes = pairs.filter((pair) => pair?.[side]?.resolved === true).length;
  if (resolvedOutcomes === 0) usageIssues.push("zero-resolved-outcomes");
  const uniqueUsageIssues = [...new Set(usageIssues)];
  const uniqueCostIssues = [...new Set([...usageIssues, ...costIssues])];
  const tokenExact = uniqueUsageIssues.length === 0;
  const costExact = uniqueCostIssues.length === 0;
  return {
    status: tokenExact && costExact ? "measured" : tokenExact ? "partial" : "unavailable",
    issues: uniqueCostIssues,
    tokenStatus: tokenExact ? "measured" : "unavailable",
    costStatus: costExact ? "measured" : "unavailable",
    attemptRecords: records.filter((record) => !record.ledgerIssues && !record.missingRun).length,
    providerStartedAttempts: tokenExact ? providerStartedAttempts : null,
    providerAttemptCompleteness: tokenExact ? providerAttemptCompleteness : "unavailable",
    resolvedOutcomes,
    totalTokens: tokenExact ? totalTokens : null,
    totalTokensPerResolvedOutcome: tokenExact ? totalTokens / resolvedOutcomes : null,
    normalizedApiCostUsd: costExact ? rounded(normalizedApiCostUsd, 9) : null,
    normalizedApiCostPerResolvedOutcomeUsd: costExact ? rounded(normalizedApiCostUsd / resolvedOutcomes, 9) : null
  };
}

export function totalTokensPerResolvedOutcome(pairs, side, pricingSnapshot) {
  return effectiveResourcesPerResolvedOutcome(pairs, side, pricingSnapshot).totalTokensPerResolvedOutcome;
}

export function normalizedApiCostPerResolvedOutcome(pairs, side, pricingSnapshot) {
  return effectiveResourcesPerResolvedOutcome(pairs, side, pricingSnapshot).normalizedApiCostPerResolvedOutcomeUsd;
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
      freshTokenRatio: geometricMean(ratios),
      freshTokenRatioConfidence95: geometricMeanConfidence95([...byScenario.values()].map(geometricMean)),
      medianFreshTokenDelta: rounded(median(deltas), 2),
      candidateWins: deltas.filter((value) => value < 0).length,
      baselineWins: deltas.filter((value) => value > 0).length,
      ties: deltas.filter((value) => value === 0).length
    }];
  }));
}

export function pairedDurationBands(durationPairs, field) {
  const grouped = new Map();
  for (const pair of durationPairs) {
    const key = typeof pair.candidate?.[field] === "string" && pair.candidate[field] ? pair.candidate[field] : "unspecified";
    const values = grouped.get(key) ?? [];
    values.push(pair);
    grouped.set(key, values);
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
    const ratios = values.map((pair) => pair.candidate.durationSeconds / pair.baseline.durationSeconds);
    const deltas = values.map((pair) => pair.candidate.durationSeconds - pair.baseline.durationSeconds);
    const byScenario = new Map();
    for (const [index, pair] of values.entries()) {
      const scenarioRatios = byScenario.get(pair.candidate.scenarioId) ?? [];
      scenarioRatios.push(ratios[index]);
      byScenario.set(pair.candidate.scenarioId, scenarioRatios);
    }
    return [key, {
      pairs: values.length,
      scenarioFamilies: byScenario.size,
      durationRatio: geometricMean(ratios),
      durationRatioConfidence95: geometricMeanConfidence95([...byScenario.values()].map(geometricMean)),
      medianDurationDeltaSeconds: rounded(median(deltas), 4),
      candidateWins: deltas.filter((value) => value < 0).length,
      baselineWins: deltas.filter((value) => value > 0).length,
      ties: deltas.filter((value) => value === 0).length
    }];
  }));
}

function exactFailedAttemptFreshTokens(run) {
  if (!Array.isArray(run.infrastructureFailures)) return { exact: false, fresh: null };
  let fresh = 0;
  for (const failure of run.infrastructureFailures) {
    const status = failure?.usageStatus ?? "unknown-after-provider-start";
    if (!exactBenchmarkAttemptUsage(failure?.usage, status)) return { exact: false, fresh: null };
    fresh += Number(failure.usage?.fresh ?? 0);
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
  if (plainObject(suite.matrixContract)) {
    const hierarchy = hierarchicalMatrixRatioSample(suite, familyRatios);
    const ratios = hierarchy.complete ? hierarchy.samples.map((item) => item.ratio) : [];
    return {
      complete: hierarchy.complete,
      expectedScenarioFamilies: hierarchy.expectedSampleCount,
      usableScenarioFamilies: hierarchy.usableSampleCount,
      expectedTaskFamilies: hierarchy.expectedSampleCount,
      usableTaskFamilies: hierarchy.usableSampleCount,
      expectedVariants: hierarchy.expectedVariantCount,
      usableVariants: hierarchy.usableVariantCount,
      sampleUnit: hierarchy.sampleUnit,
      familyIds: hierarchy.complete ? hierarchy.familyIds : [],
      scenarioIds: hierarchy.complete ? hierarchy.scenarioIds : [],
      ratio: hierarchy.complete ? geometricMean(ratios) : null,
      confidence95: hierarchy.complete ? geometricMeanConfidence95(ratios) : null,
      confidence95Raw: hierarchy.complete ? geometricMeanConfidence95Raw(ratios) : null,
      families: hierarchy.families,
      variants: familyRatios
    };
  }
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
    confidence95Raw: complete ? geometricMeanConfidence95Raw(values) : null,
    families: familyRatios
  };
}

function fixedWorkloadOutcomeRelation(baselineResolvedOutcomes, candidateResolvedOutcomes, expectedAttempts) {
  if (baselineResolvedOutcomes === expectedAttempts && candidateResolvedOutcomes === expectedAttempts) {
    return "both-fully-resolved";
  }
  if (candidateResolvedOutcomes > baselineResolvedOutcomes) return "candidate-dominates";
  if (baselineResolvedOutcomes > candidateResolvedOutcomes) return "baseline-dominates";
  if (baselineResolvedOutcomes === candidateResolvedOutcomes) return "both-incomplete";
  return "mixed";
}

export function familyClusteredFixedWorkloadUsage(suite, allPairs, repeats) {
  const pairsByScenario = new Map();
  for (const pair of allPairs) {
    const scenarioId = pair.candidate?.scenarioId ?? pair.baseline?.scenarioId;
    if (typeof scenarioId !== "string") continue;
    const pairs = pairsByScenario.get(scenarioId) ?? [];
    pairs.push(pair);
    pairsByScenario.set(scenarioId, pairs);
  }
  const expectedAttempts = Number.isInteger(repeats) && repeats > 0 ? repeats : null;
  const families = suite.scenarios.map((scenario) => {
    const pairs = pairsByScenario.get(scenario.id) ?? [];
    const repeatCount = new Set(pairs.map((pair) => pair.candidate?.repeat ?? pair.baseline?.repeat)).size;
    const comparablePairs = pairs.filter(comparableAttemptUsage);
    const baselineFailedUsage = pairs.map((pair) => exactFailedAttemptFreshTokens(pair.baseline));
    const candidateFailedUsage = pairs.map((pair) => exactFailedAttemptFreshTokens(pair.candidate));
    const issues = [];
    if (expectedAttempts === null || pairs.length !== expectedAttempts || repeatCount !== expectedAttempts) {
      issues.push("incomplete-paired-attempt-coverage");
    }
    if (comparablePairs.length !== pairs.length) issues.push("inexact-or-incomparable-accepted-usage");
    if (baselineFailedUsage.some((item) => !item.exact)) issues.push("unknown-baseline-failed-attempt-usage");
    if (candidateFailedUsage.some((item) => !item.exact)) issues.push("unknown-candidate-failed-attempt-usage");
    const exactCoverage = issues.length === 0;
    const baselineResolvedOutcomes = pairs.filter((pair) => pair.baseline?.resolved === true).length;
    const candidateResolvedOutcomes = pairs.filter((pair) => pair.candidate?.resolved === true).length;
    const baselineFreshTokens = exactCoverage
      ? pairs.reduce((sum, pair, index) => sum + pair.baseline.usage.fresh + baselineFailedUsage[index].fresh, 0)
      : null;
    const candidateFreshTokens = exactCoverage
      ? pairs.reduce((sum, pair, index) => sum + pair.candidate.usage.fresh + candidateFailedUsage[index].fresh, 0)
      : null;
    const ratio = exactCoverage
      && Number.isFinite(baselineFreshTokens)
      && baselineFreshTokens > 0
      && Number.isFinite(candidateFreshTokens)
      && candidateFreshTokens > 0
        ? candidateFreshTokens / baselineFreshTokens
        : null;
    if (exactCoverage && !Number.isFinite(ratio)) issues.push("non-positive-fixed-workload-usage");
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
      ratio,
      outcomeRelation: fixedWorkloadOutcomeRelation(
        baselineResolvedOutcomes,
        candidateResolvedOutcomes,
        expectedAttempts
      ),
      issues
    };
  });
  if (plainObject(suite.matrixContract)) {
    const hierarchy = hierarchicalMatrixRatioSample(suite, families);
    const usableFamilies = hierarchy.samples;
    const ratios = hierarchy.complete ? usableFamilies.map((item) => item.ratio) : [];
    const usableVariants = families.filter((item) => Number.isFinite(item.ratio) && item.ratio > 0);
    const aggregateBaselineFreshTokens = hierarchy.complete
      ? usableVariants.reduce((sum, item) => sum + item.baselineFreshTokens, 0)
      : null;
    const aggregateCandidateFreshTokens = hierarchy.complete
      ? usableVariants.reduce((sum, item) => sum + item.candidateFreshTokens, 0)
      : null;
    const expectedAttemptsPerVariant = expectedAttempts;
    const expectedAttemptsPerFamily = Number.isInteger(expectedAttempts)
      ? expectedAttempts * suite.matrixContract.variantsPerFamily
      : null;
    const taskFamilies = hierarchy.families.map((family) => {
      const variants = family.variants;
      const baselineResolvedOutcomes = variants.reduce((sum, item) => sum + (item.baselineResolvedOutcomes ?? 0), 0);
      const candidateResolvedOutcomes = variants.reduce((sum, item) => sum + (item.candidateResolvedOutcomes ?? 0), 0);
      const baselineFreshTokens = variants.every((item) => Number.isFinite(item.baselineFreshTokens))
        ? variants.reduce((sum, item) => sum + item.baselineFreshTokens, 0)
        : null;
      const candidateFreshTokens = variants.every((item) => Number.isFinite(item.candidateFreshTokens))
        ? variants.reduce((sum, item) => sum + item.candidateFreshTokens, 0)
        : null;
      return {
        ...family,
        baselineResolvedOutcomes,
        candidateResolvedOutcomes,
        baselineFreshTokens: rounded(baselineFreshTokens, 2),
        candidateFreshTokens: rounded(candidateFreshTokens, 2),
        expectedAttempts: expectedAttemptsPerFamily,
        pairedAttempts: variants.reduce((sum, item) => sum + (item.pairedAttempts ?? 0), 0),
        exactComparableAttempts: variants.reduce((sum, item) => sum + (item.exactComparableAttempts ?? 0), 0),
        exactCoverage: family.issues.length === 0,
        outcomeRelation: fixedWorkloadOutcomeRelation(
          baselineResolvedOutcomes,
          candidateResolvedOutcomes,
          expectedAttemptsPerFamily
        )
      };
    });
    return {
      complete: hierarchy.complete,
      expectedScenarioFamilies: hierarchy.expectedSampleCount,
      usableScenarioFamilies: hierarchy.usableSampleCount,
      expectedTaskFamilies: hierarchy.expectedSampleCount,
      usableTaskFamilies: hierarchy.usableSampleCount,
      expectedVariants: hierarchy.expectedVariantCount,
      usableVariants: hierarchy.usableVariantCount,
      expectedAttemptsPerFamily,
      expectedAttemptsPerVariant,
      sampleUnit: hierarchy.sampleUnit,
      outcomeConditioning: "none",
      aggregation: "geometric-mean-of-task-family-geometric-mean-variant-total-ratios",
      attemptPolicy: "accepted-plus-exact-provider-started-failed-attempts",
      familyIds: hierarchy.complete ? hierarchy.familyIds : [],
      scenarioIds: hierarchy.complete ? hierarchy.scenarioIds : [],
      ratio: hierarchy.complete ? geometricMean(ratios) : null,
      confidence95: hierarchy.complete ? geometricMeanConfidence95(ratios) : null,
      confidence95Raw: hierarchy.complete ? geometricMeanConfidence95Raw(ratios) : null,
      aggregateFreshTokenRatio: hierarchy.complete && aggregateBaselineFreshTokens > 0
        ? aggregateCandidateFreshTokens / aggregateBaselineFreshTokens
        : null,
      families: taskFamilies,
      variants: families
    };
  }
  const usableFamilies = families.filter((item) => Number.isFinite(item.ratio) && item.ratio > 0);
  const complete = usableFamilies.length === families.length && families.length > 0;
  const ratios = complete ? usableFamilies.map((item) => item.ratio) : [];
  const aggregateBaselineFreshTokens = complete
    ? usableFamilies.reduce((sum, item) => sum + item.baselineFreshTokens, 0)
    : null;
  const aggregateCandidateFreshTokens = complete
    ? usableFamilies.reduce((sum, item) => sum + item.candidateFreshTokens, 0)
    : null;
  return {
    complete,
    expectedScenarioFamilies: families.length,
    usableScenarioFamilies: usableFamilies.length,
    expectedAttemptsPerFamily: expectedAttempts,
    sampleUnit: "scenario-family",
    outcomeConditioning: "none",
    aggregation: "geometric-mean-of-family-total-ratios",
    attemptPolicy: "accepted-plus-exact-provider-started-failed-attempts",
    scenarioIds: complete ? usableFamilies.map((item) => item.scenarioId) : [],
    ratio: complete ? geometricMean(ratios) : null,
    confidence95: complete ? geometricMeanConfidence95(ratios) : null,
    confidence95Raw: complete ? geometricMeanConfidence95Raw(ratios) : null,
    aggregateFreshTokenRatio: complete && aggregateBaselineFreshTokens > 0
      ? aggregateCandidateFreshTokens / aggregateBaselineFreshTokens
      : null,
    families
  };
}

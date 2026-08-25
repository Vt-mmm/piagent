import { benchmarkClaimEligibility } from "./benchmark-assurance.js";
import { normalizeBenchmarkUsageCost } from "./benchmark-normalized-cost.js";
import {
  atMostWithinFloatingPrecision,
  geometricMean,
  geometricMeanConfidence95,
  geometricMeanConfidence95Raw,
  rounded
} from "./benchmark-statistics.js";
import { exactBenchmarkAttemptUsage } from "./benchmark-usage.js";
import { productionProviderFreeEvidenceContextValidationErrors } from "./benchmark-provider-free-evidence.js";
import { RELEASE_FAILURE_MESSAGES } from "./benchmark-summary-support.js";

const HASH = /^[a-f0-9]{64}$/;
const TOKEN_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"]);

/**
 * The production claim is intentionally stricter than the historical fresh-token
 * claim. Both provider traffic and API-equivalent text-token cost include cache
 * reads/writes and every declared provider-started attempt.
 */
export const CODEX_RELATIVE_EFFICIENCY_POLICY = Object.freeze({
  schemaVersion: 1,
  id: "codex-relative-efficiency-v1",
  baselineSurface: "codex-cli",
  candidateSurface: "piagent",
  estimand: "fixed-workload-family-geometric-mean",
  outcomeConditioning: "none",
  attemptPolicy: "accepted-plus-exact-provider-started-failed-attempts",
  maximumTotalTokenTrafficRatio: 0.7,
  maximumTotalTokenTrafficRatioUpper95: 0.7,
  maximumApiEquivalentCostRatio: 0.7,
  maximumApiEquivalentCostRatioUpper95: 0.7,
  maximumSubagentSessionsPerAttempt: 1,
  maximumSubagentTrafficShare: 0.05
});

export const PRODUCTION_SUBAGENT_BUDGET_POLICY = Object.freeze({
  schemaVersion: 1,
  id: "production-subagent-budget-v1",
  maximumSubagentSessionsPerAttempt: 1,
  maximumSubagentTrafficShare: 0.05
});

function zeroTokens() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function addTokens(target, usage) {
  for (const field of TOKEN_FIELDS) target[field] += Number(usage?.[field] ?? 0);
}

function isKnownPreProviderZero(usage, status) {
  return status === "known-pre-provider-zero"
    && Number(usage?.sessions ?? 0) === 0
    && TOKEN_FIELDS.every((field) => Number(usage?.[field] ?? 0) === 0);
}

function normalizedAttemptCost(usage, status, pricingSnapshot) {
  if (isKnownPreProviderZero(usage, status)) {
    return { status: "measured", amount: 0, amountUsd: 0, source: "known-pre-provider-zero" };
  }
  return normalizeBenchmarkUsageCost(usage, pricingSnapshot);
}

function exactSubagentEvidence(usage) {
  const sessions = usage?.subagentSessions;
  const tokens = usage?.subagentTokens;
  return Number.isSafeInteger(sessions)
    && sessions >= 0
    && usage.sessions === 1 + sessions
    && tokens
    && TOKEN_FIELDS.every((field) => Number.isSafeInteger(tokens[field]) && tokens[field] >= 0)
    && tokens.fresh === tokens.input + tokens.output
    && tokens.total === tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
    && tokens.reasoning <= tokens.output
    && tokens.total <= usage.total;
}

function measuredSubagentEvidence(usage, status) {
  if (!exactBenchmarkAttemptUsage(usage, status)) {
    return { exact: false, sessions: 0, traffic: 0 };
  }
  if (isKnownPreProviderZero(usage, status)) {
    return { exact: true, sessions: 0, traffic: 0 };
  }
  return exactSubagentEvidence(usage)
    ? { exact: true, sessions: usage.subagentSessions, traffic: usage.subagentTokens.total }
    : { exact: false, sessions: 0, traffic: 0 };
}

/**
 * Measure the candidate child-session budget independently from cost claims.
 * Every accepted and failed provider attempt must explain its full session
 * count as one root session plus the exact child-session count. This gate is
 * deliberately usable on a partial production ledger.
 */
export function summarizeBenchmarkSubagentBudget(runs, {
  candidateSurface = "piagent",
  policy = PRODUCTION_SUBAGENT_BUDGET_POLICY
} = {}) {
  const candidateRuns = (runs ?? []).filter((run) => run?.surface === candidateSurface);
  const attempts = [];
  const ledgerIssues = [];
  for (const run of candidateRuns) {
    const failures = Array.isArray(run?.infrastructureFailures) ? run.infrastructureFailures : [];
    const retryCountExact = Number.isSafeInteger(run?.infrastructureRetries) && run.infrastructureRetries >= 0;
    const attemptCountExact = Number.isSafeInteger(run?.infrastructureAttempts) && run.infrastructureAttempts >= 1;
    if (!retryCountExact || !attemptCountExact || !Array.isArray(run?.infrastructureFailures)
      || failures.length !== run.infrastructureRetries
      || run.infrastructureAttempts !== run.infrastructureRetries + 1) {
      ledgerIssues.push(`${run?.scenarioId ?? "unknown"}:r${run?.repeat ?? "?"}:attempt-ledger-mismatch`);
    }
    const values = [
      { kind: "accepted", usage: run?.usage, status: run?.usageStatus ?? "measured" },
      ...failures.map((failure) => ({
        kind: "failed",
        usage: failure?.usage,
        status: failure?.usageStatus ?? "unknown-after-provider-start"
      }))
    ];
    for (const [index, value] of values.entries()) {
      const evidence = measuredSubagentEvidence(value.usage, value.status);
      attempts.push({
        scenarioId: run?.scenarioId ?? null,
        repeat: run?.repeat ?? null,
        attempt: index + 1,
        kind: value.kind,
        exact: evidence.exact,
        sessions: evidence.exact ? evidence.sessions : null,
        subagentTraffic: evidence.exact ? evidence.traffic : null,
        candidateTraffic: evidence.exact ? Number(value.usage?.total ?? 0) : null
      });
    }
  }
  const exact = candidateRuns.length > 0
    && ledgerIssues.length === 0
    && attempts.length > 0
    && attempts.every((attempt) => attempt.exact);
  const exactAttempts = attempts.filter((attempt) => attempt.exact);
  const subagentSessions = exactAttempts.reduce((sum, attempt) => sum + attempt.sessions, 0);
  const subagentTraffic = exactAttempts.reduce((sum, attempt) => sum + attempt.subagentTraffic, 0);
  const candidateTraffic = exactAttempts.reduce((sum, attempt) => sum + attempt.candidateTraffic, 0);
  const trafficShare = exact && candidateTraffic > 0
    ? subagentTraffic / candidateTraffic
    : exact && subagentTraffic === 0 ? 0 : null;
  const maximumObservedSessionsPerAttempt = exactAttempts.reduce(
    (maximum, attempt) => Math.max(maximum, attempt.sessions),
    0
  );
  const checks = {
    "candidate-attempts-observed": candidateRuns.length > 0 && attempts.length > 0,
    "subagent-usage-exact": exact,
    "subagent-sessions-explained": exact,
    "subagent-session-budget": exact
      && maximumObservedSessionsPerAttempt <= policy.maximumSubagentSessionsPerAttempt,
    "subagent-traffic-budget": exact
      && Number.isFinite(trafficShare)
      && atMostWithinFloatingPrecision(trafficShare, policy.maximumSubagentTrafficShare)
  };
  return {
    schemaVersion: 1,
    policy,
    checks,
    failures: booleanChecks(checks),
    passed: booleanChecks(checks).length === 0,
    candidateRuns: candidateRuns.length,
    attempts: attempts.length,
    exactAttempts: exactAttempts.length,
    ledgerIssues,
    sessions: subagentSessions,
    tokenTraffic: subagentTraffic,
    candidateTokenTraffic: candidateTraffic,
    trafficShare,
    maximumObservedSessionsPerAttempt,
    attemptEvidence: attempts
  };
}

function measureRun(run, pricingSnapshot, expectedModel, expectedThinking, { candidate }) {
  const tokenIssues = [], costIssues = [], subagentIssues = [];
  const status = run?.usageStatus ?? "measured";
  if (!exactBenchmarkAttemptUsage(run?.usage, status)) tokenIssues.push("accepted-usage-not-exact");
  if (run?.usage?.model !== expectedModel) tokenIssues.push("accepted-model-mismatch");
  if (run?.usage?.thinkingLevel !== expectedThinking) tokenIssues.push("accepted-thinking-mismatch");
  const failures = Array.isArray(run?.infrastructureFailures) ? run.infrastructureFailures : [];
  const retryCountExact = Number.isSafeInteger(run?.infrastructureRetries) && run.infrastructureRetries >= 0;
  const attemptCountExact = Number.isSafeInteger(run?.infrastructureAttempts) && run.infrastructureAttempts >= 1;
  const ledgerExact = Array.isArray(run?.infrastructureFailures)
    && retryCountExact
    && attemptCountExact
    && failures.length === run.infrastructureRetries
    && run.infrastructureAttempts === run.infrastructureRetries + 1;
  if (!ledgerExact) {
    tokenIssues.push("failed-attempt-ledger-mismatch");
    if (candidate) subagentIssues.push("failed-attempt-subagent-ledger-mismatch");
  }

  const tokens = zeroTokens();
  if (exactBenchmarkAttemptUsage(run?.usage, status)) addTokens(tokens, run.usage);
  let cost = normalizedAttemptCost(run?.usage, status, pricingSnapshot);
  if (cost.status !== "measured") costIssues.push(`accepted-cost:${cost.reason}`);
  let costAmount = cost.status === "measured" ? cost.amount : null;

  let subagentSessions = 0;
  let subagentTraffic = 0;
  let maximumSubagentSessionsPerAttempt = 0;
  let attemptCount = 1;
  if (candidate) {
    const evidence = measuredSubagentEvidence(run?.usage, status);
    if (!evidence.exact) subagentIssues.push("subagent-usage-not-exact");
    else {
      subagentSessions += evidence.sessions;
      subagentTraffic += evidence.traffic;
      maximumSubagentSessionsPerAttempt = evidence.sessions;
    }
  }

  for (const failure of failures) {
    attemptCount += 1;
    const failureStatus = failure?.usageStatus ?? "unknown-after-provider-start";
    if (!exactBenchmarkAttemptUsage(failure?.usage, failureStatus)) {
      tokenIssues.push("failed-attempt-usage-not-exact");
      if (candidate) subagentIssues.push("failed-attempt-subagent-usage-not-exact");
      continue;
    }
    if (!isKnownPreProviderZero(failure.usage, failureStatus)) {
      if (failure.usage.model !== expectedModel) tokenIssues.push("failed-attempt-model-mismatch");
      if (failure.usage.thinkingLevel !== expectedThinking) tokenIssues.push("failed-attempt-thinking-mismatch");
    }
    addTokens(tokens, failure.usage);
    cost = normalizedAttemptCost(failure.usage, failureStatus, pricingSnapshot);
    if (cost.status !== "measured") {
      costIssues.push(`failed-attempt-cost:${cost.reason}`);
      costAmount = null;
    } else if (costAmount !== null) {
      costAmount += cost.amount;
    }
    if (candidate) {
      const evidence = measuredSubagentEvidence(failure?.usage, failureStatus);
      if (!evidence.exact) subagentIssues.push("failed-attempt-subagent-usage-not-exact");
      else {
        subagentSessions += evidence.sessions;
        subagentTraffic += evidence.traffic;
        maximumSubagentSessionsPerAttempt = Math.max(maximumSubagentSessionsPerAttempt, evidence.sessions);
      }
    }
  }

  return {
    tokenExact: tokenIssues.length === 0,
    costExact: tokenIssues.length === 0 && costIssues.length === 0,
    subagentExact: subagentIssues.length === 0,
    exact: tokenIssues.length === 0 && costIssues.length === 0 && subagentIssues.length === 0,
    issues: [...tokenIssues, ...costIssues, ...subagentIssues],
    tokens,
    costAmount,
    subagentSessions,
    subagentTraffic,
    maximumSubagentSessionsPerAttempt,
    attemptCount
  };
}

function pairIdentityIssues(pair) {
  const issues = [];
  const baselinePrompt = pair.baseline?.promptHash;
  const candidatePrompt = pair.candidate?.promptHash;
  const baselineFixture = pair.baseline?.variant?.fixtureDigest;
  const candidateFixture = pair.candidate?.variant?.fixtureDigest;
  if (!HASH.test(baselinePrompt ?? "") || !HASH.test(candidatePrompt ?? "")) issues.push("missing-paired-prompt-identity");
  else if (baselinePrompt !== candidatePrompt) issues.push("paired-prompt-mismatch");
  if (!HASH.test(baselineFixture ?? "") || !HASH.test(candidateFixture ?? "")) issues.push("missing-paired-fixture-identity");
  else if (baselineFixture !== candidateFixture) issues.push("paired-fixture-mismatch");
  return issues;
}

function aggregateFamilies(families, field) {
  const completeFamilies = families.filter((family) => Number.isFinite(family[field]) && family[field] > 0);
  const complete = completeFamilies.length === families.length && families.length > 1;
  const ratios = complete ? completeFamilies.map((family) => family[field]) : [];
  return {
    complete,
    expectedScenarioFamilies: families.length,
    completeScenarioFamilies: completeFamilies.length,
    ratio: complete ? geometricMean(ratios) : null,
    ratioConfidence95: complete ? geometricMeanConfidence95(ratios) : null,
    ratioConfidence95Raw: complete ? geometricMeanConfidence95Raw(ratios) : null
  };
}

function booleanChecks(value) {
  return Object.entries(value).filter(([, passed]) => passed !== true).map(([id]) => id);
}

/**
 * Build fixed-workload Codex-relative evidence. The caller supplies quality and
 * execution-parity checks because those are evaluated by the benchmark core.
 */
export function evaluateCodexRelativeEfficiency({
  suite,
  allPairs,
  repeats,
  baselineSurface,
  candidateSurface,
  required = false,
  parityChecks = {},
  qualityChecks = {},
  policy = CODEX_RELATIVE_EFFICIENCY_POLICY
}) {
  const expectedAttempts = Number.isSafeInteger(repeats) && repeats > 0 ? repeats : null;
  const expectedModel = suite?.executionContract?.model;
  const expectedThinking = suite?.executionContract?.thinking;
  const byScenario = new Map();
  for (const pair of allPairs ?? []) {
    const scenarioId = pair?.candidate?.scenarioId ?? pair?.baseline?.scenarioId;
    if (typeof scenarioId !== "string") continue;
    const values = byScenario.get(scenarioId) ?? [];
    values.push(pair);
    byScenario.set(scenarioId, values);
  }

  const families = (suite?.scenarios ?? []).map((scenario) => {
    const pairs = byScenario.get(scenario.id) ?? [];
    const repeatCount = new Set(pairs.map((pair) => pair?.candidate?.repeat ?? pair?.baseline?.repeat)).size;
    const issues = [];
    const coverageComplete = expectedAttempts !== null && pairs.length === expectedAttempts && repeatCount === expectedAttempts;
    if (!coverageComplete) {
      issues.push("incomplete-paired-attempt-coverage");
    }
    const baselineTokens = zeroTokens();
    const candidateTokens = zeroTokens();
    let baselineCostUsd = 0;
    let candidateCostUsd = 0;
    let subagentSessions = 0;
    let subagentTraffic = 0;
    let maximumSubagentSessionsPerAttempt = 0;
    let candidateAttempts = 0;
    let measuredTokenPairs = 0;
    let measuredCostPairs = 0;
    let measuredSubagentPairs = 0;
    for (const pair of pairs) {
      const identityIssues = pairIdentityIssues(pair);
      issues.push(...identityIssues);
      const baseline = measureRun(pair.baseline, suite.pricingSnapshot, expectedModel, expectedThinking, { candidate: false });
      const candidate = measureRun(pair.candidate, suite.pricingSnapshot, expectedModel, expectedThinking, { candidate: true });
      candidateAttempts += candidate.attemptCount;
      issues.push(...baseline.issues.map((issue) => `baseline:${issue}`));
      issues.push(...candidate.issues.map((issue) => `candidate:${issue}`));
      const tokenPairExact = identityIssues.length === 0 && baseline.tokenExact && candidate.tokenExact;
      if (tokenPairExact) {
        measuredTokenPairs += 1;
        addTokens(baselineTokens, baseline.tokens);
        addTokens(candidateTokens, candidate.tokens);
      }
      if (tokenPairExact && baseline.costExact && candidate.costExact) {
        measuredCostPairs += 1;
        baselineCostUsd += baseline.costAmount;
        candidateCostUsd += candidate.costAmount;
      }
      if (candidate.subagentExact) {
        measuredSubagentPairs += 1;
        subagentSessions += candidate.subagentSessions;
        subagentTraffic += candidate.subagentTraffic;
        maximumSubagentSessionsPerAttempt = Math.max(
          maximumSubagentSessionsPerAttempt,
          candidate.maximumSubagentSessionsPerAttempt
        );
      }
    }
    const tokenExact = coverageComplete && measuredTokenPairs === expectedAttempts;
    const costExact = tokenExact && measuredCostPairs === expectedAttempts;
    const subagentExact = coverageComplete && measuredSubagentPairs === expectedAttempts;
    const totalTokenTrafficRatio = tokenExact && baselineTokens.total > 0 && candidateTokens.total > 0
      ? candidateTokens.total / baselineTokens.total
      : null;
    const apiEquivalentCostRatio = costExact && baselineCostUsd > 0 && candidateCostUsd > 0
      ? candidateCostUsd / baselineCostUsd
      : null;
    if (tokenExact && !Number.isFinite(totalTokenTrafficRatio)) issues.push("non-positive-token-traffic");
    if (costExact && !Number.isFinite(apiEquivalentCostRatio)) issues.push("non-positive-api-equivalent-cost");
    return {
      scenarioId: scenario.id,
      expectedAttempts,
      pairedAttempts: pairs.length,
      exact: issues.length === 0 && tokenExact && costExact && subagentExact,
      issues: [...new Set(issues)],
      baselineTokenTraffic: baselineTokens.total,
      candidateTokenTraffic: candidateTokens.total,
      totalTokenTrafficRatio,
      baselineApiEquivalentCostUsd: rounded(baselineCostUsd, 9),
      candidateApiEquivalentCostUsd: rounded(candidateCostUsd, 9),
      apiEquivalentCostRatio,
      candidateSubagentSessions: subagentSessions,
      candidateSubagentTraffic: subagentTraffic,
      maximumSubagentSessionsPerAttempt,
      candidateAttempts,
      subagentEvidenceComplete: subagentExact
    };
  });

  const traffic = aggregateFamilies(families, "totalTokenTrafficRatio");
  const cost = aggregateFamilies(families, "apiEquivalentCostRatio");
  const baselineTraffic = families.reduce((sum, family) => sum + family.baselineTokenTraffic, 0);
  const candidateTraffic = families.reduce((sum, family) => sum + family.candidateTokenTraffic, 0);
  const baselineCostUsd = families.reduce((sum, family) => sum + family.baselineApiEquivalentCostUsd, 0);
  const candidateCostUsd = families.reduce((sum, family) => sum + family.candidateApiEquivalentCostUsd, 0);
  const candidateSubagentSessions = families.reduce((sum, family) => sum + family.candidateSubagentSessions, 0);
  const candidateSubagentTraffic = families.reduce((sum, family) => sum + family.candidateSubagentTraffic, 0);
  const candidateAttempts = families.reduce((sum, family) => sum + family.candidateAttempts, 0);
  const subagentEvidenceComplete = families.every((family) => family.subagentEvidenceComplete === true);
  const subagentTrafficShare = candidateTraffic > 0 ? candidateSubagentTraffic / candidateTraffic : null;
  const maxObservedSubagents = families.reduce(
    (maximum, family) => Math.max(maximum, family.maximumSubagentSessionsPerAttempt),
    0
  );

  const surfaceChecks = {
    "codex-cli-baseline": baselineSurface === policy.baselineSurface,
    "piagent-candidate": candidateSurface === policy.candidateSurface,
    "execution-contract-surfaces": suite?.executionContract?.surfaces?.[0] === "piagent"
      && suite.executionContract.surfaces?.[1] === "codex-cli",
    "execution-contract-model": typeof expectedModel === "string" && expectedModel.length > 0,
    "execution-contract-thinking": typeof expectedThinking === "string" && expectedThinking.length > 0,
    "pricing-snapshot-bound-to-model": suite?.pricingSnapshot?.model === expectedModel
  };
  const evidenceChecks = {
    "fixed-workload-token-traffic-complete": traffic.complete,
    "fixed-workload-api-equivalent-cost-complete": cost.complete,
    "total-token-traffic-point": Number.isFinite(traffic.ratio)
      && atMostWithinFloatingPrecision(traffic.ratio, policy.maximumTotalTokenTrafficRatio),
    "total-token-traffic-upper95": Number.isFinite(traffic.ratioConfidence95Raw?.upper)
      && atMostWithinFloatingPrecision(traffic.ratioConfidence95Raw.upper, policy.maximumTotalTokenTrafficRatioUpper95),
    "api-equivalent-cost-point": Number.isFinite(cost.ratio)
      && atMostWithinFloatingPrecision(cost.ratio, policy.maximumApiEquivalentCostRatio),
    "api-equivalent-cost-upper95": Number.isFinite(cost.ratioConfidence95Raw?.upper)
      && atMostWithinFloatingPrecision(cost.ratioConfidence95Raw.upper, policy.maximumApiEquivalentCostRatioUpper95),
    "subagent-usage-complete": subagentEvidenceComplete,
    "subagent-session-budget": maxObservedSubagents <= policy.maximumSubagentSessionsPerAttempt,
    "subagent-traffic-budget": Number.isFinite(subagentTrafficShare)
      && atMostWithinFloatingPrecision(subagentTrafficShare, policy.maximumSubagentTrafficShare)
  };
  const checks = { ...surfaceChecks, ...parityChecks, ...qualityChecks, ...evidenceChecks };
  const failures = booleanChecks(checks);

  return {
    schemaVersion: 1,
    policy,
    required,
    claim: "Piagent uses at least 30% less provider token traffic and API-equivalent text-token cost than controlled Codex CLI on the same fixed workload without quality or continuity regression.",
    billedOrSubscriptionCost: false,
    costBoundary: "versioned-api-equivalent-text-token-pricing; not OAuth subscription debiting",
    checks,
    failures,
    passed: failures.length === 0,
    families,
    totalTokenTraffic: {
      ...traffic,
      aggregateBaselineTokens: baselineTraffic,
      aggregateCandidateTokens: candidateTraffic,
      aggregateRatio: baselineTraffic > 0 ? candidateTraffic / baselineTraffic : null,
      deltaPercent: Number.isFinite(traffic.ratio) ? rounded((traffic.ratio - 1) * 100, 2) : null
    },
    apiEquivalentCost: {
      ...cost,
      aggregateBaselineUsd: rounded(baselineCostUsd, 9),
      aggregateCandidateUsd: rounded(candidateCostUsd, 9),
      aggregateRatio: baselineCostUsd > 0 ? candidateCostUsd / baselineCostUsd : null,
      deltaPercent: Number.isFinite(cost.ratio) ? rounded((cost.ratio - 1) * 100, 2) : null
    },
    subagents: {
      candidateAttempts,
      sessions: candidateSubagentSessions,
      tokenTraffic: candidateSubagentTraffic,
      trafficShare: subagentTrafficShare,
      maximumObservedSessionsPerAttempt: maxObservedSubagents
    }
  };
}

const DOWNSTREAM_VERDICTS = new Set([
  "performance-evidence-gate-failed",
  "performance-point-regression",
  "performance-confidence-gate-failed",
  "performance-band-ratio-gate-failed",
  "performance-family-ratio-gate-failed",
  "efficiency-band-ratio-gate-failed",
  "efficiency-family-ratio-gate-failed",
  "efficiency-confidence-gate-failed",
  "observational-efficiency-only"
]);

function pairedRuns(report) {
  const baselineSurface = report.comparison.baselineSurface;
  const candidateSurface = report.comparison.candidateSurface;
  const baselineByKey = new Map(report.runs
    .filter((run) => run.surface === baselineSurface)
    .map((run) => [`${run.scenarioId}:${run.repeat}`, run]));
  return report.runs
    .filter((run) => run.surface === candidateSurface)
    .map((candidate) => ({ baseline: baselineByKey.get(`${candidate.scenarioId}:${candidate.repeat}`), candidate }))
    .filter((pair) => pair.baseline);
}

function insertReleaseFailure(gate, failure = "codex-relative-efficiency") {
  if (!gate || gate.failures.includes(failure)) return;
  const laterFailures = new Set([
    "repeat-count",
    "efficiency-confidence",
    "performance-evidence",
    "performance-point-regression",
    "performance-confidence",
    "performance-band-ratio",
    "performance-family-ratio"
  ]);
  const index = gate.failures.findIndex((failure) => laterFailures.has(failure));
  gate.failures.splice(index < 0 ? gate.failures.length : index, 0, failure);
  gate.failureReasons = gate.failures.map((id) => ({ id, message: RELEASE_FAILURE_MESSAGES[id] ?? id }));
  gate.passed = false;
}

function codexRelativeChecks(report) {
  const comparison = report.comparison;
  return {
    parityChecks: {
      "comparison-protocol": comparison.comparisonProtocolGate.passed,
      "equivalent-task-access-context": report.environment.comparisonAccessContract === "paired-workspace-write-offline-surface-system",
      "full-suite": comparison.fullSuiteGate !== false,
      "stable-provider-wire": comparison.providerWireSurfaceGate !== false,
      "exact-all-attempt-usage": comparison.allAttemptUsageCompletenessGate !== false,
      "stable-attempt-ledger": comparison.stabilityGate !== false,
      "causal-context-evidence": comparison.causalContextEvidenceGate !== false
    },
    qualityChecks: {
      "quality-noninferior": comparison.qualityNonInferior,
      "paired-quality-noninferior": comparison.pairedQualityNoninferiorityGate !== false,
      "absolute-quality": comparison.qualityGate,
      safety: comparison.safetyGate,
      reliability: comparison.reliabilityGate,
      workflow: comparison.workflowGate !== false,
      category: comparison.categoryGate !== false,
      "outcome-score-floor": comparison.outcomeScoreGate !== false,
      "no-baseline-pass-candidate-fail": comparison.pairedRegressionGate,
      "candidate-task-continuity": comparison.candidateTaskContinuityGate
    }
  };
}

function productionRuntimeCoverage(report, suite) {
  const required = suite.releaseGate?.requireProviderFreeEvidence === true;
  const receipt = report.environment?.providerFreeEvidence ?? null;
  const providerFreeErrors = required
    ? productionProviderFreeEvidenceContextValidationErrors(receipt, {
      source: report.environment?.source,
      candidateProvenance: report.environment?.candidateProvenance,
      configurationDigest: report.environment?.configurationDigest
    })
    : [];
  const providerFreePassed = !required || providerFreeErrors.length === 0;
  const candidateRuns = report.runs.filter((run) => run.surface === report.comparison.candidateSurface);
  const statuses = candidateRuns.map((run) => run?.causalContextReceipt?.aggregates?.runtimeCausal?.adaptiveContext?.coverageStatus ?? "not-observed");
  const partialRuns = statuses.filter((status) => status === "partial").length;
  const notObservedRuns = statuses.filter((status) => status === "not-observed").length;
  const adaptiveContextPassed = !required || (partialRuns === 0 && (notObservedRuns === 0 || providerFreePassed));
  return {
    required,
    passed: providerFreePassed && adaptiveContextPassed,
    providerFree: { passed: providerFreePassed, errors: providerFreeErrors, receipt },
    adaptiveContext: {
      passed: adaptiveContextPassed,
      partialRuns,
      notObservedRuns,
      notObservedCoveredBySameSourceProviderFreeLane: notObservedRuns > 0 && providerFreePassed
    }
  };
}

/**
 * Add the Codex-relative claim gate after the generic benchmark report is built.
 * Keeping this policy adapter outside benchmark-core prevents one product claim
 * from expanding the generic summarizer while preserving the public report.
 */
export function integrateCodexRelativeEfficiencyReport(report, suite) {
  const comparison = report.comparison;
  const required = suite.releaseGate?.requireNormalizedCostClaim === true;
  const checks = codexRelativeChecks(report);
  const evidence = comparison.baselineSurface === CODEX_RELATIVE_EFFICIENCY_POLICY.baselineSurface
    ? evaluateCodexRelativeEfficiency({
      suite,
      allPairs: pairedRuns(report),
      repeats: report.repeats,
      baselineSurface: comparison.baselineSurface,
      candidateSurface: comparison.candidateSurface,
      required,
      ...checks
    })
    : null;
  const gate = required ? evidence?.passed === true : null;
  comparison.codexRelativeEfficiency = evidence;
  comparison.codexRelativeEfficiencyGate = gate;

  const subagentBudgetRequired = suite.releaseGate?.requireSubagentBudget === true
    && comparison.baselineSurface === CODEX_RELATIVE_EFFICIENCY_POLICY.baselineSurface
    && comparison.candidateSurface === CODEX_RELATIVE_EFFICIENCY_POLICY.candidateSurface;
  const subagentBudget = subagentBudgetRequired
    ? summarizeBenchmarkSubagentBudget(report.runs, {
      candidateSurface: comparison.candidateSurface,
      policy: {
        ...PRODUCTION_SUBAGENT_BUDGET_POLICY,
        maximumSubagentSessionsPerAttempt: suite.releaseGate.maximumSubagentSessionsPerAttempt,
        maximumSubagentTrafficShare: suite.releaseGate.maximumSubagentTrafficShare
      }
    })
    : null;
  const subagentBudgetGate = subagentBudgetRequired ? subagentBudget?.passed === true : null;
  comparison.productionSubagentBudget = subagentBudget;
  comparison.productionSubagentBudgetGate = subagentBudgetGate;
  const runtimeCoverage = productionRuntimeCoverage(report, suite);
  comparison.productionProviderFreeEvidenceGate = runtimeCoverage.required ? runtimeCoverage.providerFree.passed : null;
  comparison.productionProviderFreeEvidence = runtimeCoverage.providerFree;
  comparison.adaptiveContextRuntimeGate = runtimeCoverage.required ? runtimeCoverage.adaptiveContext.passed : null;
  comparison.adaptiveContextRuntimeCoverage = runtimeCoverage.adaptiveContext;

  if (comparison.suiteGate) {
    comparison.suiteGate.observed.codexRelativeMaximumTokenTrafficRatioUpper95 = required
      ? CODEX_RELATIVE_EFFICIENCY_POLICY.maximumTotalTokenTrafficRatioUpper95
      : null;
    comparison.suiteGate.observed.codexRelativeMaximumApiEquivalentCostRatioUpper95 = required
      ? CODEX_RELATIVE_EFFICIENCY_POLICY.maximumApiEquivalentCostRatioUpper95
      : null;
    comparison.suiteGate.observed.productionSubagentBudget = subagentBudget;
  }

  if (required && gate === false) {
    for (const releaseGate of new Set([comparison.suiteGate, comparison.productionGate])) {
      insertReleaseFailure(releaseGate);
    }
    comparison.tokenClaimAllowed = false;
    comparison.claimEligibility = benchmarkClaimEligibility({
      suite,
      environment: report.environment,
      baselineSurface: comparison.baselineSurface,
      protocolPassed: comparison.comparisonProtocolGate.passed,
      tokenClaimAllowed: false
    });
    comparison.purpose = comparison.claimEligibility.comparisonPurpose;
    const candidate = Object.values(report.surfaces).find((surface) => surface.surface === comparison.candidateSurface);
    if (candidate?.scores) candidate.scores.overall = null;
    if (DOWNSTREAM_VERDICTS.has(report.verdict.status) || report.verdict.status === `${comparison.candidateSurface}-more-efficient`) {
      report.verdict.status = "codex-relative-efficiency-gate-failed";
    }
  }

  if (subagentBudgetRequired && subagentBudgetGate === false) {
    for (const releaseGate of new Set([comparison.suiteGate, comparison.productionGate])) {
      insertReleaseFailure(releaseGate, "production-subagent-budget");
    }
    comparison.tokenClaimAllowed = false;
    comparison.claimEligibility = benchmarkClaimEligibility({
      suite,
      environment: report.environment,
      baselineSurface: comparison.baselineSurface,
      protocolPassed: comparison.comparisonProtocolGate.passed,
      tokenClaimAllowed: false
    });
    comparison.purpose = comparison.claimEligibility.comparisonPurpose;
    const candidate = Object.values(report.surfaces).find((surface) => surface.surface === comparison.candidateSurface);
    if (candidate?.scores) candidate.scores.overall = null;
    if (DOWNSTREAM_VERDICTS.has(report.verdict.status) || report.verdict.status === `${comparison.candidateSurface}-more-efficient`) {
      report.verdict.status = "production-subagent-budget-gate-failed";
    }
  }
  if (runtimeCoverage.required && runtimeCoverage.passed === false) {
    for (const releaseGate of new Set([comparison.suiteGate, comparison.productionGate])) {
      if (!runtimeCoverage.providerFree.passed) insertReleaseFailure(releaseGate, "provider-free-evidence");
      if (!runtimeCoverage.adaptiveContext.passed) insertReleaseFailure(releaseGate, "adaptive-context-runtime-coverage");
    }
    comparison.tokenClaimAllowed = false;
    comparison.claimEligibility = benchmarkClaimEligibility({ suite, environment: report.environment,
      baselineSurface: comparison.baselineSurface, protocolPassed: comparison.comparisonProtocolGate.passed, tokenClaimAllowed: false });
    comparison.purpose = comparison.claimEligibility.comparisonPurpose;
    const candidate = Object.values(report.surfaces).find((surface) => surface.surface === comparison.candidateSurface);
    if (candidate?.scores) candidate.scores.overall = null;
    if (DOWNSTREAM_VERDICTS.has(report.verdict.status) || report.verdict.status === `${comparison.candidateSurface}-more-efficient`) {
      report.verdict.status = runtimeCoverage.providerFree.passed
        ? "adaptive-context-runtime-coverage-gate-failed"
        : "provider-free-evidence-gate-failed";
    }
  }

  report.verdict.note = report.verdict.note
    .replace(
      "quality and continuity remain independent hard gates. ",
      "quality and continuity remain independent hard gates. Production token claims always require exact child-session evidence, at most one subagent per provider attempt, and no more than 5% subagent token traffic. When a suite explicitly enables the optional Codex-relative cost claim, its separate gate requires both total provider token traffic and API-equivalent text-token cost, including cache traffic, to have point and upper-95 ratios at or below 0.70; it is not a subscription-spend claim. "
    )
    .replace(" Normalized cost is API-equivalent text-token input/cache/output cost from the versioned suite pricing snapshot and exact token buckets, never OAuth/provider-billed or tool-specific total cost.", "");
  return report;
}

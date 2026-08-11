import { PIAGENT_BENCHMARK_TREATMENTS } from "./benchmark-runtime.js";

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

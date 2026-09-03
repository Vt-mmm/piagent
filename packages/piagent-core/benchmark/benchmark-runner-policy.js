import { observeBenchmarkTransportFailure } from "./benchmark-forensics.js";
import { aggregateSessionUsage } from "./benchmark-usage.js";

const INEXACT_REPLAY_USAGE = new Set(["unknown-after-provider-start", "measured-lower-bound"]);

export function applyBenchmarkExecutionDefaults(options, suite) {
  options.repeats ??= suite.defaultRepeats;
  options.infrastructureRetries ??= suite.releaseGate?.maximumInfrastructureRetries
    ?? (suite.schemaVersion === 2 ? 2 : 0);
  options.retryDelaySeconds ??= suite.schemaVersion === 2 && options.infrastructureRetries > 0 ? 60 : 0;
  options.timeoutSeconds ??= suite.timeoutSeconds;
  const contract = suite.executionContract;
  if (!contract) return;
  for (const [field, expected] of [
    ["surfaces", contract.surfaces], ["model", contract.model], ["thinking", contract.thinking],
    ["codexMode", contract.codexMode], ["codexBaseline", contract.codexBaseline], ["serviceTier", contract.serviceTier]
  ]) {
    if (expected === undefined) continue;
    const actual = options[field];
    if (actual === undefined) options[field] = Array.isArray(expected) ? [...expected] : expected;
    else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Suite ${suite.id} locks ${field} to ${Array.isArray(expected) ? expected.join(",") : expected}`);
    }
  }
}

export function benchmarkSuiteCoverage(declaredScenarios, selectedScenarios) {
  return {
    declaredScenarios,
    selectedScenarios,
    fullSuite: selectedScenarios === declaredScenarios
  };
}

export function recoveredBenchmarkAttemptDisposition(attempts, { scenarioId, surface, repeat, retryLimit }) {
  const label = `${scenarioId}/${surface}/r${repeat}`;
  if (!attempts.every((attempt, index) => Number.isSafeInteger(attempt?.attempt) && attempt.attempt === index + 1)) {
    return { passed: false, error: `Recovered provider attempts for ${label} are not the exact ordered sequence 1..N` };
  }
  const unsafe = attempts.find((attempt) => attempt.retryable !== true || INEXACT_REPLAY_USAGE.has(attempt.usageStatus));
  if (unsafe) {
    return { passed: false, error: `Recovered provider attempt for ${label} cannot be replayed safely (${unsafe.usageStatus ?? "usage-unknown"})` };
  }
  const firstAttempt = attempts.length + 1;
  return firstAttempt <= retryLimit + 1
    ? { passed: true, firstAttempt }
    : { passed: false, error: `No infrastructure retry remains after recovering an interrupted provider attempt for ${label}` };
}

export function benchmarkInfrastructureFailureDisposition({
  circuit,
  record,
  infrastructureAttempt,
  retryLimit,
  orderIndex,
  scenarioId,
  surface,
  repeat
}) {
  const nextCircuit = observeBenchmarkTransportFailure(circuit, {
    ...record, orderIndex, scenarioId, surface, repeat, infrastructureAttempt
  });
  const retryAvailable = record.infrastructureRetryable === true
    && !INEXACT_REPLAY_USAGE.has(record.usageStatus)
    && nextCircuit.state !== "open"
    && infrastructureAttempt <= retryLimit;
  return {
    circuit: nextCircuit,
    retryAvailable,
    failure: {
      attempt: infrastructureAttempt,
      attemptId: record.attemptId,
      failure: record.infrastructureFailure ?? record.failure,
      class: record.infrastructureClass ?? "infrastructure",
      agent: record.agent,
      usage: record.usage,
      usageStatus: record.usageStatus,
      retryable: record.infrastructureRetryable === true,
      durationSeconds: record.durationSeconds
    },
    unknownCost: record.usageStatus === "unknown-after-provider-start"
  };
}

export function benchmarkRunnerErrorRecord({ safeError, runId, orderIndex, item, suiteProfile, infrastructureAttempt }) {
  return {
    schemaVersion: 1,
    runId,
    orderIndex,
    scenarioId: item.scenario.id,
    scenarioTitle: item.scenario.title,
    scenarioKind: item.scenario.kind,
    category: item.scenario.category ?? "unspecified",
    difficulty: item.scenario.difficulty ?? "unspecified",
    profile: item.scenario.profile ?? suiteProfile,
    lifecycle: item.scenario.lifecycle ?? "steady-state",
    surface: item.surface,
    repeat: item.repeat,
    infrastructureAttempt,
    abortSuite: true,
    infrastructureFailure: `runner-error:${safeError}`,
    resolved: false,
    failure: `runner-error:${safeError}`,
    grade: { passed: false, score: 0, checks: [] },
    graderIntegrity: { passed: false },
    scope: { passed: false, changedFiles: [], outsideScope: [] },
    outputSafety: { passed: false, forbiddenHits: [] },
    outputEvidence: { passed: false, requiredCount: 0, observedCount: 0, missingHashes: [] },
    workflow: null,
    usage: aggregateSessionUsage([]),
    durationSeconds: 0
  };
}

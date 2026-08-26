import { median, rounded } from "./benchmark-statistics.js";

export const BENCHMARK_TIMING_PHASES = Object.freeze([
  "processStartup", "modelTurnWait", "toolExecution", "other"
]);
export const BENCHMARK_EXECUTION_COUNTER_FIELDS = Object.freeze([
  "providerStartedAttempts", "toolCalls", "toolResults", "toolFailures", "blockedToolCalls",
  "declinedToolCalls", "explicitRetries", "retryFailures", "compactions", "abortedCompactions",
  "summarizationRetries", "repeatedToolCalls", "subagentAttempts", "subagentFailures"
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validPhase(value, name) {
  const expectedBoundary = {
    processStartup: "process-start-to-turn-start",
    modelTurnWait: "request-ready-to-next-model-output-boundary",
    toolExecution: "matched-tool-start-to-tool-completion",
    other: "process-duration-minus-available-observed-phases"
  }[name];
  const unavailableReasons = {
    processStartup: new Set(["invalid-event-stream", "missing-turn-start-boundary", "unavailable"]),
    modelTurnWait: new Set(["invalid-event-stream", "incomplete-model-turn-boundaries", "unavailable"]),
    toolExecution: new Set(["invalid-event-stream", "incomplete-tool-boundaries", "unavailable"]),
    other: new Set(["one-or-more-phase-boundaries-unavailable"])
  }[name];
  const expectedAvailableReason = name === "other" ? "exact-unattributed-remainder" : "observed-boundaries";
  return plainObject(value)
    && Object.keys(value).length === 4
    && ["available", "unavailable"].includes(value.status)
    && (value.status === "available" ? finiteNonnegative(value.seconds) : value.seconds === null)
    && value.boundary === expectedBoundary
    && (value.status === "available" ? value.reason === expectedAvailableReason : unavailableReasons.has(value.reason));
}

function validExecution(value, observations) {
  const keys = ["schemaVersion", "source", "completeness", ...BENCHMARK_EXECUTION_COUNTER_FIELDS];
  if (!plainObject(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || value.source !== "stdout-jsonl-lifecycle"
    || !plainObject(value.completeness)) return false;
  const completenessKeys = ["providerAttempts", "tools", "retries", "compactions", "subagents"];
  if (Object.keys(value.completeness).length !== completenessKeys.length
    || !completenessKeys.every((key) => Object.hasOwn(value.completeness, key))) return false;
  if (!["exact", "lower-bound", "partial", "unavailable"].includes(value.completeness.providerAttempts)
    || !["exact", "partial", "unavailable"].includes(value.completeness.tools)
    || !["exact", "partial", "unavailable"].includes(value.completeness.retries)
    || !["exact", "partial", "unavailable"].includes(value.completeness.compactions)
    || !["exact", "partial", "unavailable"].includes(value.completeness.subagents)) return false;
  if (!BENCHMARK_EXECUTION_COUNTER_FIELDS.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)) return false;
  if (value.providerStartedAttempts !== observations.turnStarts || value.toolCalls < observations.toolStarts
    || value.toolResults !== observations.toolCompletions || value.toolFailures > value.toolResults
    || value.blockedToolCalls > value.toolResults || value.declinedToolCalls > value.toolResults
    || value.repeatedToolCalls >= value.toolCalls && value.toolCalls > 0
    || value.subagentFailures > value.subagentAttempts || value.retryFailures > value.explicitRetries
    || value.abortedCompactions > value.compactions) return false;
  if (value.completeness.tools === "exact" && value.toolCalls !== value.toolResults) return false;
  return true;
}

export function validBenchmarkTimingDiagnostics(value, surface, durationSeconds) {
  const topLevelKeys = ["schemaVersion", "authority", "gateImpact", "clock", "surface", "status", "processDurationSeconds", "phases", "observations", "execution", "privacy"];
  if (!plainObject(value) || Object.keys(value).length !== topLevelKeys.length || !topLevelKeys.every((key) => Object.hasOwn(value, key))
    || value.schemaVersion !== 2 || value.authority !== "observational-only"
    || value.gateImpact !== "none" || value.clock !== "benchmark-process-monotonic-receipt"
    || value.surface !== surface || !["complete", "partial", "unavailable"].includes(value.status)
    || !finiteNonnegative(value.processDurationSeconds)
    || !plainObject(value.phases) || Object.keys(value.phases).length !== BENCHMARK_TIMING_PHASES.length
    || !BENCHMARK_TIMING_PHASES.every((name) => validPhase(value.phases[name], name))) return false;
  if (finiteNonnegative(durationSeconds) && Math.abs(value.processDurationSeconds - durationSeconds) > 1e-5) return false;
  const observationKeys = ["jsonEvents", "sessionHeaders", "agentStarts", "agentEnds", "agentSettled", "threadStarts",
    "turnStarts", "turnCompletions", "matchedModelTurnIntervals", "toolStarts", "toolCompletions", "matchedToolIntervals",
    "unmatchedToolStarts", "unmatchedToolCompletions", "unmatchedModelTurnStarts", "malformedLines", "invalidClockBoundaries", "coalescedBoundaries"];
  if (!plainObject(value.observations) || Object.keys(value.observations).length !== observationKeys.length
    || !observationKeys.every((key) => Number.isSafeInteger(value.observations[key]) && value.observations[key] >= 0)) return false;
  const observations = value.observations;
  if (!validExecution(value.execution, observations)) return false;
  const lifecycleEvents = surface === "codex-cli"
    ? observations.threadStarts
    : observations.sessionHeaders + observations.agentStarts + observations.agentEnds + observations.agentSettled;
  if ([observations.sessionHeaders, observations.agentSettled, observations.threadStarts]
    .some((count) => count > 1)
    || (surface === "codex-cli"
      ? observations.sessionHeaders + observations.agentStarts + observations.agentEnds + observations.agentSettled !== 0
      : observations.threadStarts !== 0 || observations.agentEnds > observations.agentStarts)
    || observations.turnCompletions > observations.turnStarts
    || (surface !== "codex-cli" && observations.matchedModelTurnIntervals > observations.turnStarts)
    || observations.matchedToolIntervals > observations.toolStarts
    || observations.matchedToolIntervals > observations.toolCompletions
    || observations.matchedModelTurnIntervals > observations.jsonEvents
    || (surface === "codex-cli" && (observations.turnStarts > 1 || observations.turnCompletions > 1
      || observations.matchedModelTurnIntervals > observations.toolStarts + observations.turnCompletions))
    || lifecycleEvents + observations.turnStarts + observations.turnCompletions
      + observations.toolStarts + observations.toolCompletions > observations.jsonEvents) return false;
  const surfaceHeaderObserved = surface === "codex-cli" ? observations.threadStarts === 1 : observations.sessionHeaders === 1;
  const lifecycleComplete = surface === "codex-cli"
    ? surfaceHeaderObserved && observations.turnStarts === 1 && observations.turnCompletions === 1
    : surfaceHeaderObserved && observations.agentStarts > 0 && observations.agentEnds === observations.agentStarts
      && observations.agentSettled === 1 && observations.turnStarts > 0 && observations.turnCompletions === observations.turnStarts;
  const privacyKeys = ["rawPayloadStored", "promptsStored", "commandsStored", "pathsStored", "identifiersStored"];
  if (!plainObject(value.privacy) || Object.keys(value.privacy).length !== privacyKeys.length
    || !privacyKeys.every((key) => value.privacy[key] === false)) return false;
  const available = BENCHMARK_TIMING_PHASES.filter((name) => value.phases[name].status === "available").length;
  const expectedStatus = available === BENCHMARK_TIMING_PHASES.length ? "complete" : available > 0 ? "partial" : "unavailable";
  if (value.status !== expectedStatus) return false;
  if (BENCHMARK_TIMING_PHASES.some((name) => value.phases[name].status === "available" && value.phases[name].seconds > value.processDurationSeconds + 1e-6)) return false;
  if ((value.observations.malformedLines > 0 || value.observations.invalidClockBoundaries > 0) && available > 0) return false;
  if (value.status === "complete" && ["unmatchedToolStarts", "unmatchedToolCompletions", "unmatchedModelTurnStarts",
    "malformedLines", "invalidClockBoundaries", "coalescedBoundaries"].some((key) => value.observations[key] > 0)) return false;
  if (value.status === "complete" && (!lifecycleComplete
    || observations.matchedModelTurnIntervals === 0
    || (surface !== "codex-cli" && observations.matchedModelTurnIntervals !== observations.turnStarts)
    || observations.toolStarts !== observations.toolCompletions
    || observations.matchedToolIntervals !== observations.toolStarts)) return false;
  if (value.phases.processStartup.status === "available" && (!surfaceHeaderObserved || observations.turnStarts === 0
    || surface !== "codex-cli" && observations.agentStarts === 0)) return false;
  if (value.phases.modelTurnWait.status === "available" && (!lifecycleComplete
    || observations.matchedModelTurnIntervals === 0
    || (surface !== "codex-cli" && observations.matchedModelTurnIntervals !== observations.turnStarts)
    || observations.unmatchedModelTurnStarts > 0)) return false;
  if (value.phases.toolExecution.status === "available" && (!lifecycleComplete
    || observations.toolStarts !== observations.toolCompletions
    || observations.matchedToolIntervals !== observations.toolStarts
    || observations.unmatchedToolStarts > 0 || observations.unmatchedToolCompletions > 0)) return false;
  const attributedPhasesAvailable = ["processStartup", "modelTurnWait", "toolExecution"]
    .every((name) => value.phases[name].status === "available");
  if ((value.phases.other.status === "available") !== attributedPhasesAvailable) return false;
  if (value.phases.other.status === "available") {
    const sum = BENCHMARK_TIMING_PHASES.reduce((total, name) => total + value.phases[name].seconds, 0);
    if (Math.abs(sum - value.processDurationSeconds) > 5e-5) return false;
  }
  return true;
}

export function canonicalBenchmarkTimingDiagnostics(value, surface, durationSeconds) {
  try {
    return validBenchmarkTimingDiagnostics(value, surface, durationSeconds) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeBenchmarkTimingDiagnostics(runs) {
  const values = Array.isArray(runs) ? runs : [];
  const surfaces = {};
  for (const surface of [...new Set(values.map((run) => run?.surface).filter((value) => typeof value === "string"))].sort()) {
    const surfaceRuns = values.filter((run) => run?.surface === surface);
    const valid = surfaceRuns.filter((run) => canonicalBenchmarkTimingDiagnostics(run.timingDiagnostics, surface, run.durationSeconds));
    const phaseSummary = Object.fromEntries(BENCHMARK_TIMING_PHASES.map((name) => {
      const available = valid.map((run) => run.timingDiagnostics.phases[name]).filter((item) => item.status === "available");
      return [name, {
        availableRuns: available.length,
        unavailableRuns: surfaceRuns.length - available.length,
        medianSeconds: available.length > 0 ? rounded(median(available.map((item) => item.seconds)), 6) : null
      }];
    }));
    surfaces[surface] = {
      runs: surfaceRuns.length,
      validDiagnostics: valid.length,
      completeDiagnostics: valid.filter((run) => run.timingDiagnostics.status === "complete").length,
      execution: {
        coveredRuns: valid.length,
        unavailableRuns: surfaceRuns.length - valid.length,
        counters: Object.fromEntries(BENCHMARK_EXECUTION_COUNTER_FIELDS.map((field) => [field,
          valid.reduce((sum, run) => sum + run.timingDiagnostics.execution[field], 0)])),
        exactRuns: {
          providerAttempts: valid.filter((run) => run.timingDiagnostics.execution.completeness.providerAttempts === "exact").length,
          tools: valid.filter((run) => run.timingDiagnostics.execution.completeness.tools === "exact").length,
          retries: valid.filter((run) => run.timingDiagnostics.execution.completeness.retries === "exact").length,
          compactions: valid.filter((run) => run.timingDiagnostics.execution.completeness.compactions === "exact").length,
          subagents: valid.filter((run) => run.timingDiagnostics.execution.completeness.subagents === "exact").length
        }
      },
      phases: phaseSummary
    };
  }
  return {
    schemaVersion: 2,
    authority: "observational-only",
    gateImpact: "none",
    clock: "benchmark-process-monotonic-receipt",
    surfaces
  };
}

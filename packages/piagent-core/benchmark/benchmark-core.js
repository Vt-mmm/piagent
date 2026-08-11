import { StringDecoder } from "node:string_decoder";

import { benchmarkClaimEligibility } from "./benchmark-assurance.js";
import {
  comparableAttemptUsage,
  comparisonProtocol,
  completeCategoryCoverage,
  completePairedScenarioCount,
  tokensPerResolvedOutcome
} from "./benchmark-comparison.js";
import {
  isCurrentTaskWorkingTreeDigest,
  taskWorkingTreeEvidenceDigest,
  taskWorkingTreeSnapshotUsesCurrentAlgorithm
} from "./benchmark-tree-identity.js";

export { renderBenchmarkHtml, renderBenchmarkText } from "./benchmark-report.js";
export { benchmarkAssuranceEvidenceValidationErrors, benchmarkClaimEligibility } from "./benchmark-assurance.js";
export { benchmarkSuiteValidationErrors, validateBenchmarkSuite } from "./benchmark-suite.js";
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
const CODEX_NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "plan", "user_message"]);
export const BENCHMARK_MEASUREMENT_SCHEMA_VERSION = 2;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function geometricMean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function rounded(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum = 0, maximum = 10) {
  return Math.max(minimum, Math.min(maximum, value));
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(successes) || successes < 0 || successes > total) return null;
  const proportion = successes / total;
  const zSquared = z ** 2;
  const denominator = 1 + (zSquared / total);
  const center = (proportion + (zSquared / (2 * total))) / denominator;
  const margin = (z / denominator) * Math.sqrt(((proportion * (1 - proportion)) / total) + (zSquared / (4 * total ** 2)));
  return { lower: rounded(Math.max(0, center - margin), 4), upper: rounded(Math.min(1, center + margin), 4) };
}

const STUDENT_T_975 = Object.freeze([
  null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
  2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093,
  2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
]);

function geometricMeanConfidence95(values) {
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const logs = values.map(Math.log);
  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const variance = logs.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (logs.length - 1);
  const critical = STUDENT_T_975[logs.length - 1] ?? 1.96;
  const margin = critical * Math.sqrt(variance / logs.length);
  return {
    lower: rounded(Math.exp(mean - margin), 4),
    upper: rounded(Math.exp(mean + margin), 4),
    sampleUnit: "scenario-family",
    scenarioCount: logs.length
  };
}

export function aggregateSessionUsage(sessions) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0 };
  const models = new Set();
  const thinkingLevels = new Set();
  const toolNames = {};
  let toolCalls = 0;
  let messages = 0;
  const contextSnapshots = [];
  for (const session of sessions) {
    for (const key of Object.keys(totals)) totals[key] += Number(session.tokens?.[key] ?? 0);
    if (session.modelId || session.provider) models.add(`${session.provider || "unknown"}/${session.modelId || "unknown"}`);
    if (session.thinkingLevel) thinkingLevels.add(session.thinkingLevel);
    toolCalls += Number(session.messages?.toolCalls ?? 0);
    messages += Number(session.messages?.total ?? 0);
    if (plainObject(session.contextUsage)) {
      const snapshot = {
        tokens: Number.isFinite(session.contextUsage.tokens) ? session.contextUsage.tokens : null,
        contextWindow: Number.isFinite(session.contextUsage.contextWindow) ? session.contextUsage.contextWindow : null,
        percent: Number.isFinite(session.contextUsage.percent) ? session.contextUsage.percent : null
      };
      if (Object.values(snapshot).some(Number.isFinite)) contextSnapshots.push(snapshot);
    }
    for (const [name, count] of Object.entries(session.toolNames ?? {})) {
      toolNames[name] = (toolNames[name] ?? 0) + Number(count ?? 0);
    }
  }
  return {
    ...totals,
    fresh: totals.input + totals.output,
    sessions: sessions.length,
    subagentSessions: sessions.filter((session) => session.isSubagent).length,
    toolCalls,
    toolNames: Object.fromEntries(Object.entries(toolNames).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    messages,
    model: models.size === 1 ? [...models][0] : models.size === 0 ? "unknown" : "mixed",
    thinkingLevel: thinkingLevels.size === 1 ? [...thinkingLevels][0] : thinkingLevels.size === 0 ? "unknown" : "mixed",
    contextUsage: contextSnapshots.length > 0 ? {
      source: "session-reported",
      observations: contextSnapshots.length,
      peakTokens: contextSnapshots.some((item) => Number.isFinite(item.tokens))
        ? Math.max(...contextSnapshots.map((item) => item.tokens).filter(Number.isFinite))
        : null,
      contextWindow: new Set(contextSnapshots.map((item) => item.contextWindow).filter(Number.isFinite)).size === 1
        ? contextSnapshots.map((item) => item.contextWindow).find(Number.isFinite)
        : null,
      peakPercent: contextSnapshots.some((item) => Number.isFinite(item.percent))
        ? Math.max(...contextSnapshots.map((item) => item.percent).filter(Number.isFinite))
        : null
    } : {
      source: "unavailable",
      observations: 0,
      peakTokens: null,
      contextWindow: null,
      peakPercent: null
    }
  };
}

function requiredCodexToken(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Codex JSONL usage.${field} must be a non-negative integer`);
  }
  return value;
}

function consumeCodexEvent(state, event, lineNumber) {
  if (!plainObject(event) || typeof event.type !== "string") {
    throw new Error(`Codex JSONL line ${lineNumber} is not an event object`);
  }
  state.onEvent?.(event);
  if (event.type === "error" || event.type === "turn.failed") {
    const nested = plainObject(event.error) ? event.error : {};
    const message = [event.message, nested.message, nested.additional_details]
      .find((value) => typeof value === "string" && value.trim());
    state.diagnostics.push({ type: event.type, message: message ? message.trim().slice(0, 2_000) : "unspecified Codex error" });
    return;
  }
  if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
    state.threadId = event.thread_id;
    return;
  }
  if (event.type === "item.completed" && plainObject(event.item)) {
    const type = event.item.type;
    if (type === "agent_message") state.messages += 1;
    else if (typeof type === "string" && type && !CODEX_NON_TOOL_ITEMS.has(type)) {
      state.toolNames[type] = (state.toolNames[type] ?? 0) + 1;
    }
    return;
  }
  if (event.type === "turn.completed") {
    state.completedTurns += 1;
    if (state.completedTurns > 1) throw new Error("Codex JSONL contains more than one completed root turn");
    if (!plainObject(event.usage)) throw new Error("Codex JSONL turn.completed is missing usage");
    state.completedUsage = event.usage;
  }
}

function finishCodexUsage(state) {
  if (!state.threadId) throw new Error("Codex JSONL is missing thread.started");
  if (!state.completedUsage) throw new Error("Codex JSONL is missing turn.completed usage");
  const providerInput = requiredCodexToken(state.completedUsage.input_tokens, "input_tokens");
  const cacheRead = requiredCodexToken(state.completedUsage.cached_input_tokens ?? 0, "cached_input_tokens");
  const cacheWrite = requiredCodexToken(state.completedUsage.cache_write_input_tokens ?? 0, "cache_write_input_tokens");
  const output = requiredCodexToken(state.completedUsage.output_tokens, "output_tokens");
  const reasoning = requiredCodexToken(state.completedUsage.reasoning_output_tokens ?? 0, "reasoning_output_tokens");
  if (cacheRead > providerInput) throw new Error("Codex JSONL cached_input_tokens exceeds input_tokens");
  if (reasoning > output) throw new Error("Codex JSONL reasoning_output_tokens exceeds output_tokens");
  const input = providerInput - cacheRead;
  const sortedTools = Object.fromEntries(Object.entries(state.toolNames).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
  return {
    input,
    providerInput,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: providerInput + output,
    fresh: input + output,
    cost: null,
    costSource: "unavailable",
    sessions: 1,
    subagentSessions: 0,
    toolCalls: Object.values(sortedTools).reduce((sum, value) => sum + value, 0),
    toolNames: sortedTools,
    messages: state.messages,
    model: typeof state.model === "string" && state.model ? state.model : "unknown",
    thinkingLevel: typeof state.thinkingLevel === "string" && state.thinkingLevel ? state.thinkingLevel : "unknown",
    contextUsage: {
      source: "unavailable",
      observations: 0,
      peakTokens: null,
      contextWindow: null,
      peakPercent: null
    },
    providerSessionId: state.threadId
  };
}

export function createCodexExecJsonlCollector(options = {}) {
  const state = {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    onEvent: typeof options.onEvent === "function" ? options.onEvent : undefined,
    threadId: undefined,
    completedUsage: undefined,
    completedTurns: 0,
    messages: 0,
    toolNames: {},
    diagnostics: []
  };
  let buffer = "";
  let lineNumber = 0;
  let failure;
  const decoder = new StringDecoder("utf8");
  const consumeLine = (rawLine) => {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`Codex JSONL line ${lineNumber} is not valid JSON`); }
    consumeCodexEvent(state, event, lineNumber);
  };
  return {
    write(chunk) {
      if (failure) return;
      try {
        buffer += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          consumeLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > 64 * 1024 * 1024) throw new Error("Codex JSONL event exceeds the 64 MiB safety limit");
      } catch (error) {
        failure = error;
        buffer = "";
      }
    },
    finish() {
      if (!failure) buffer += decoder.end();
      if (!failure && buffer) {
        try { consumeLine(buffer); } catch (error) { failure = error; }
        buffer = "";
      }
      if (failure) throw failure;
      return finishCodexUsage(state);
    },
    diagnostics() {
      return state.diagnostics.map((item) => ({ ...item }));
    }
  };
}

export function parseCodexExecJsonl(stdout, options = {}) {
  if (typeof stdout !== "string") throw new Error("Codex JSONL output must be a string");
  const collector = createCodexExecJsonlCollector(options);
  collector.write(stdout);
  return collector.finish();
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
    medianReasoningTokens: median(runs.map((run) => run.usage?.reasoning)),
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
    ...(acceptanceCriteria.length > 0 && requireSemanticAcceptanceEvidence ? [
      {
        id: "criterion-linked-evidence",
        passed: (criticalAcceptance.length ? criticalAcceptance : acceptanceCriteria).every((criterion) => criterion.status === "satisfied"
          && Array.isArray(criterion.evidence)
          && (scenarioKind === "read-only"
            ? criterion.evidence.length > 0
            : Boolean(terminalVerifierDigest) && criterion.evidence.some((evidence) => evidence?.workingTreeDigest === terminalVerifierDigest))),
        weight: 1
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

function pairedUsageBands(tokenPairs, field) {
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
    const scenarioRatios = [...byScenario.values()].map(geometricMean);
    return [key, {
      pairs: values.length,
      scenarioFamilies: byScenario.size,
      freshTokenRatio: rounded(geometricMean(ratios), 4),
      freshTokenRatioConfidence95: geometricMeanConfidence95(scenarioRatios),
      medianFreshTokenDelta: rounded(median(deltas), 2),
      candidateWins: deltas.filter((value) => value < 0).length,
      baselineWins: deltas.filter((value) => value > 0).length,
      ties: deltas.filter((value) => value === 0).length
    }];
  }));
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
  const costPairs = tokenPairs.filter((pair) => (
    Number.isFinite(pair.baseline.usage.cost)
    && Number.isFinite(pair.candidate.usage.cost)
    && pair.baseline.usage.cost > 0
    && pair.candidate.usage.cost > 0
  ));
  const costRatios = costPairs.map((pair) => pair.candidate.usage.cost / pair.baseline.usage.cost);
  const freshRatio = geometricMean(freshRatios);
  const confidenceScenarioRatios = suite.schemaVersion === 2 ? completeScenarioFreshRatios : scenarioFreshRatios;
  const freshRatioConfidence95 = geometricMeanConfidence95(confidenceScenarioRatios.map((item) => item.ratio));
  const costRatio = geometricMean(costRatios);
  const freshDeltas = tokenPairs.map((pair) => pair.candidate.usage.fresh - pair.baseline.usage.fresh);
  const freshWins = freshDeltas.filter((delta) => delta < 0).length;
  const freshLosses = freshDeltas.filter((delta) => delta > 0).length;
  const freshTies = freshDeltas.length - freshWins - freshLosses;
  const baselineFreshPerResolvedOutcome = tokensPerResolvedOutcome(allPairs, "baseline");
  const candidateFreshPerResolvedOutcome = tokensPerResolvedOutcome(allPairs, "candidate");
  const failureAwareFreshTokenRatio = Number.isFinite(baselineFreshPerResolvedOutcome)
    && baselineFreshPerResolvedOutcome > 0
    && Number.isFinite(candidateFreshPerResolvedOutcome)
      ? candidateFreshPerResolvedOutcome / baselineFreshPerResolvedOutcome
      : null;
  candidate.scores.efficiency = efficiencyScore(freshRatio);
  baseline.scores.efficiency = tokenPairs.length ? 5 : null;
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
  const requiresConfidenceEfficiency = Number.isFinite(maximumFreshTokenRatioUpper95) || releaseGate.requireEfficiencyClaim === true;
  const requiresSuiteEfficiency = requiresConfidenceEfficiency;
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
  const repeatGate = Number.isInteger(minimumRepeats) ? repeats >= minimumRepeats : null;
  const protocol = comparisonProtocol(environment, suite, baselineSurface);
  const efficiencyConfidenceGate = requiresConfidenceEfficiency
    ? Boolean(freshRatioConfidence95 && freshRatioConfidence95.upper <= (maximumFreshTokenRatioUpper95 ?? 1))
    : null;
  const pairedResolvedOutcomes = pairedOutcomeCounts(allPairs, (run) => run?.resolved === true);
  const pairedRegressionGate = pairedResolvedOutcomes.baselineOnlyPass === 0;
  const failureAwareEfficiencyGate = Number.isFinite(failureAwareFreshTokenRatio)
    ? failureAwareFreshTokenRatio <= (maximumFreshTokenRatioUpper95 ?? 1)
    : null;
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
    && outcomeEvidenceGate
    && efficiencyEvidenceGate
    && efficiencyBandCoverageGate
    && failureAwareEfficiencyGate
    && repeatGate !== false
    && (!requiresConfidenceEfficiency || efficiencyConfidenceGate)
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
    && qualityGate
    && reliabilityGate
    && qualityNonInferior
    && workflowGate !== false
    && categoryGate !== false
    && outcomeScoreGate !== false
    && pairedRegressionGate
    && protocol.passed
    && outcomeEvidenceGate
    && efficiencyEvidenceGate
    && efficiencyBandCoverageGate
    && repeatGate !== false
    && Number.isFinite(freshRatio)
    && failureAwareEfficiencyGate
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
    !protocol.passed ? "comparison-protocol" : null,
    !outcomeEvidenceGate ? "paired-outcome-evidence" : null,
    requiresSuiteEfficiency && !efficiencyEvidenceGate ? "efficiency-evidence" : null,
    requiresSuiteEfficiency && !efficiencyBandCoverageGate ? "efficiency-category-coverage" : null,
    requiresSuiteEfficiency && !failureAwareEfficiencyGate ? "failure-aware-efficiency" : null,
    repeatGate === false ? "repeat-count" : null,
    requiresConfidenceEfficiency && !efficiencyConfidenceGate ? "efficiency-confidence" : null
  ].filter(Boolean);
  const suiteGate = suite.schemaVersion === 2 ? {
    passed: releaseFailures.length === 0,
    failures: releaseFailures,
    thresholds: {
      quality: qualityThreshold,
      safety: safetyThreshold,
      reliability: reliabilityThreshold,
      workflow: workflowThreshold,
      category: categoryThreshold ?? null,
      outcomeScoreExclusive: outcomeScoreThresholdExclusive ?? null,
      pairedOutcomeScenarios: minimumPairedScenarios ?? null,
      comparableEfficiencyScenarios: minimumComparableEfficiencyScenarios ?? null,
      repeats: minimumRepeats ?? null,
      freshTokenRatioUpper95: maximumFreshTokenRatioUpper95 ?? null
    }
  } : null;
  const baselineKey = surfaceReportKey(baselineSurface);
  const candidateKey = surfaceReportKey(candidateSurface);
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
    surfaces: { [baselineKey]: baseline, [candidateKey]: candidate },
    comparison: {
      baselineSurface,
      candidateSurface,
      purpose: claimEligibility.comparisonPurpose,
      usageEstimator: "paired-geometric-mean-ratio",
      failureAwareUsageEstimator: "total-comparable-attempt-fresh-tokens-per-resolved-outcome",
      pairedOutcomeScenarios: completeOutcomeScenarios,
      pairedSuccessfulRuns: pairs.length,
      pairedUsageRuns: tokenPairs.length,
      pairedUsageScenarios: scenarioFreshRatios.length,
      pairedCompleteScenarios: completeScenarioFreshRatios.length,
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
      medianFreshTokens: { [baselineKey]: baselineFresh, [candidateKey]: candidateFresh },
      medianCost: { [baselineKey]: baselineCost, [candidateKey]: candidateCost },
      freshTokensPerResolvedOutcome: {
        [baselineKey]: rounded(baselineFreshPerResolvedOutcome, 2),
        [candidateKey]: rounded(candidateFreshPerResolvedOutcome, 2)
      },
      failureAwareFreshTokenRatio: rounded(failureAwareFreshTokenRatio, 4),
      freshTokenRatio: rounded(freshRatio, 4),
      freshTokenRatioConfidence95: freshRatioConfidence95,
      freshTokenDeltaPercent: Number.isFinite(freshRatio) ? rounded((freshRatio - 1) * 100, 2) : null,
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
      outcomeEvidenceGate,
      efficiencyEvidenceGate,
      efficiencyBandCoverageGate,
      efficiencyCategoryCoverage,
      failureAwareEfficiencyGate,
      repeatGate,
      efficiencyConfidenceGate,
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
              : !protocol.passed
                ? "comparison-protocol-gate-failed"
                : workflowGate === false
                  ? "workflow-gate-failed"
                : categoryGate === false
                  ? "category-gate-failed"
                  : outcomeScoreGate === false
                    ? "outcome-score-floor-gate-failed"
                    : !pairedRegressionGate
                      ? "paired-candidate-regression"
                  : repeatGate === false
                      ? "repeat-gate-failed"
                      : requiresConfidenceEfficiency && efficiencyConfidenceGate === false
                        ? "efficiency-confidence-gate-failed"
                        : tokenClaimAllowed
                          ? `${candidateSurface}-more-efficient`
                          : "insufficient-efficiency-evidence",
      note: `Raw metrics and hidden verifier results are authoritative. Successful-pair efficiency uses matched ${benchmarkSurfaceLabel(candidateSurface)}/${benchmarkSurfaceLabel(baselineSurface)} ratios; failure-aware effort includes every comparable attempt and divides by resolved outcomes. Confidence intervals cluster repeats by scenario family. Claim scope is ${claimEligibility.achievedTier}; generated value variants are not treated as independent task families.`
    },
    runs
  };
}

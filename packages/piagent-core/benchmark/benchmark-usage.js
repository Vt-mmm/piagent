import { StringDecoder } from "node:string_decoder";

const CODEX_NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "plan", "user_message"]);
const TOKEN_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"]);
const EXECUTION_COUNTER_FIELDS = Object.freeze([
  "providerStartedAttempts", "toolCalls", "toolResults", "toolFailures", "blockedToolCalls",
  "declinedToolCalls", "explicitRetries", "retryFailures", "compactions", "abortedCompactions",
  "summarizationRetries", "repeatedToolCalls", "subagentAttempts", "subagentFailures"
]);

export const BENCHMARK_TOKEN_DEFINITIONS = Object.freeze({
  unit: "provider-reported-tokens",
  input: "Fresh input tokens, excluding cache-read and cache-write input.",
  output: "All output tokens; reasoning is a subset and is not added again.",
  cacheRead: "Input tokens served from provider cache.",
  cacheWrite: "Input tokens written to provider cache.",
  reasoning: "Reasoning token subset included inside output.",
  fresh: "Claim denominator: input + output.",
  total: "Accounted provider tokens: input + cacheRead + cacheWrite + output."
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyExecutionAggregate(source) {
  return {
    schemaVersion: 1,
    source,
    completeness: { tools: "unavailable", retries: "unavailable", compactions: "unavailable", subagents: "unavailable" },
    ...Object.fromEntries(EXECUTION_COUNTER_FIELDS.map((field) => [field, 0]))
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function codexToolFingerprint(item) {
  const identity = item.type === "command_execution" ? item.command
    : item.type === "mcp_tool_call" ? [item.server, item.tool, stableValue(item.arguments)]
      : item.type === "collab_tool_call" ? [item.tool, item.prompt]
        : item.type === "web_search" ? stableValue(item.action ?? item.query)
          : item.type;
  try { return JSON.stringify([item.type, identity]); }
  catch { return item.type; }
}

function executionCompleteness(sessions, field) {
  const rank = { exact: 0, partial: 1, unverified: 2, unavailable: 3 };
  if (sessions.length === 0) return "unavailable";
  return sessions.reduce((worst, session) => {
    const value = session.execution?.completeness?.[field] ?? "unavailable";
    return rank[value] > rank[worst] ? value : worst;
  }, "exact");
}

export function exactBenchmarkMeasuredUsage(usage) {
  return usage?.usageCompleteness === "exact"
    && Number.isSafeInteger(usage?.sessions) && usage.sessions > 0
    && TOKEN_FIELDS.every((field) => Number.isSafeInteger(usage?.[field]) && usage[field] >= 0)
    && usage.fresh === usage.input + usage.output
    && usage.total === usage.input + usage.cacheRead + usage.cacheWrite + usage.output
    && usage.reasoning <= usage.output;
}

function knownPreProviderZero(usage, status) {
  return status === "known-pre-provider-zero"
    && Number.isSafeInteger(usage?.sessions ?? 0)
    && (usage?.sessions ?? 0) === 0
    && TOKEN_FIELDS.every((field) => Number.isSafeInteger(usage?.[field] ?? 0)
      && (usage?.[field] ?? 0) === 0);
}

export function exactBenchmarkAttemptUsage(usage, status) {
  return status !== "unknown-after-provider-start"
    && (exactBenchmarkMeasuredUsage(usage) || knownPreProviderZero(usage, status));
}

function tokenBucket(entries) {
  const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  const bySurface = {};
  let exactAttempts = 0;
  for (const entry of entries) {
    const exact = exactBenchmarkAttemptUsage(entry.usage, entry.status);
    if (!exact) continue;
    exactAttempts += 1;
    const surface = bySurface[entry.surface] ?? { attempts: 0, tokens: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])) };
    surface.attempts += 1;
    for (const field of TOKEN_FIELDS) {
      const value = Number(entry.usage?.[field] ?? 0);
      totals[field] += value;
      surface.tokens[field] += value;
    }
    bySurface[entry.surface] = surface;
  }
  return {
    attempts: entries.length,
    exactAttempts,
    unknownAttempts: entries.length - exactAttempts,
    complete: exactAttempts === entries.length,
    tokens: totals,
    bySurface: Object.fromEntries(Object.entries(bySurface).sort(([left], [right]) => left.localeCompare(right)))
  };
}

export function benchmarkTokenAccounting(runs) {
  const accepted = runs.map((run) => ({ surface: run.surface, status: run.usageStatus ?? "measured", usage: run.usage }));
  const failed = runs.flatMap((run) => (run.infrastructureFailures ?? []).map((attempt) => ({
    surface: run.surface,
    status: attempt.usageStatus ?? "unknown-after-provider-start",
    usage: attempt.usage
  })));
  return {
    schemaVersion: 1,
    definitions: BENCHMARK_TOKEN_DEFINITIONS,
    acceptedAttempts: tokenBucket(accepted),
    failedAttempts: tokenBucket(failed),
    allAttempts: tokenBucket([...accepted, ...failed])
  };
}

export function benchmarkInfrastructureFailureLedgerIssues(runs) {
  return runs.flatMap((run) => {
    const issues = [];
    if (!Number.isInteger(run.infrastructureRetries) || run.infrastructureRetries < 0) {
      issues.push("invalid-infrastructure-retry-count");
    }
    if (!Array.isArray(run.infrastructureFailures)) {
      issues.push("missing-infrastructure-failure-ledger");
    } else if (Number.isInteger(run.infrastructureRetries) && run.infrastructureFailures.length !== run.infrastructureRetries) {
      issues.push("retry-ledger-count-mismatch");
    }
    if (!Number.isInteger(run.infrastructureAttempts)
      || run.infrastructureAttempts !== (Number.isInteger(run.infrastructureRetries) ? run.infrastructureRetries + 1 : -1)) {
      issues.push("attempt-ledger-count-mismatch");
    }
    return issues.length > 0 ? [{
      scenarioId: run.scenarioId ?? null,
      surface: run.surface ?? null,
      repeat: run.repeat ?? null,
      issues
    }] : [];
  });
}

export function aggregateSessionUsage(sessions) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0 };
  const subagentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  const models = new Set();
  const thinkingLevels = new Set();
  const toolNames = {};
  let toolCalls = 0;
  let messages = 0;
  const contextSnapshots = [];
  const execution = emptyExecutionAggregate("pi-session-jsonl");
  const pricingRequests = [];
  for (const session of sessions) {
    for (const key of Object.keys(totals)) totals[key] += Number(session.tokens?.[key] ?? 0);
    if (session.isSubagent) {
      for (const key of Object.keys(subagentTokens)) subagentTokens[key] += Number(session.tokens?.[key] ?? 0);
    }
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
    for (const field of EXECUTION_COUNTER_FIELDS) execution[field] += Number(session.execution?.[field] ?? 0);
    if (Array.isArray(session.pricingBuckets?.requests)) pricingRequests.push(...session.pricingBuckets.requests);
  }
  for (const field of ["tools", "retries", "compactions", "subagents"]) {
    execution.completeness[field] = executionCompleteness(sessions, field);
  }
  return {
    ...totals,
    fresh: totals.input + totals.output,
    sessions: sessions.length,
    subagentSessions: sessions.filter((session) => session.isSubagent).length,
    subagentTokens: {
      ...subagentTokens,
      fresh: subagentTokens.input + subagentTokens.output
    },
    toolCalls,
    toolNames: Object.fromEntries(Object.entries(toolNames).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    messages,
    model: models.size === 1 ? [...models][0] : models.size === 0 ? "unknown" : "mixed",
    thinkingLevel: thinkingLevels.size === 1 ? [...thinkingLevels][0] : thinkingLevels.size === 0 ? "unknown" : "mixed",
    usageSource: sessions.length > 0 ? "pi-session-jsonl" : "unavailable",
    usageCompleteness: sessions.length > 0 && sessions.every((session) => session.usageIntegrity?.exact === true) ? "exact" : "unverified",
    pricingBuckets: {
      schemaVersion: 1,
      source: "provider-request-usage",
      completeness: sessions.length > 0 && sessions.every((session) => session.pricingBuckets?.completeness === "exact")
        ? "exact" : "unverified",
      requests: pricingRequests
    },
    execution,
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

/** Aggregate every provider-reported Codex turn, preserving exact token categories. */
function aggregateCodexProviderTurnTokens(turnUsages) {
  if (!Array.isArray(turnUsages) || turnUsages.length === 0) {
    throw new Error("Codex JSONL is missing turn.completed usage");
  }
  const totals = { providerInput: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, fresh: 0 };
  for (const [index, usage] of turnUsages.entries()) {
    if (!plainObject(usage)) throw new Error(`Codex JSONL turn.completed usage ${index + 1} is not an object`);
    const providerInput = requiredCodexToken(usage.input_tokens, "input_tokens");
    const cacheRead = requiredCodexToken(usage.cached_input_tokens ?? 0, "cached_input_tokens");
    const cacheWrite = requiredCodexToken(usage.cache_write_input_tokens ?? 0, "cache_write_input_tokens");
    const output = requiredCodexToken(usage.output_tokens, "output_tokens");
    const reasoning = requiredCodexToken(usage.reasoning_output_tokens ?? 0, "reasoning_output_tokens");
    if (cacheRead + cacheWrite > providerInput) throw new Error("Codex JSONL cached and cache-write input tokens exceed input_tokens");
    if (reasoning > output) throw new Error("Codex JSONL reasoning_output_tokens exceeds output_tokens");
    const input = providerInput - cacheRead - cacheWrite;
    totals.providerInput += providerInput;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.reasoning += reasoning;
    totals.total += providerInput + output;
    totals.fresh += input + output;
  }
  return totals;
}

/**
 * Combine exact usage captured from multiple invocations of one resumed Codex
 * thread. Identity mismatches and incomplete turns fail closed instead of being
 * silently presented as one comparable session.
 */
export function aggregateCodexTurnUsage(turnUsages) {
  if (!Array.isArray(turnUsages) || turnUsages.length === 0) {
    throw new Error("Codex turn usage must contain at least one turn");
  }
  for (const [index, usage] of turnUsages.entries()) {
    if (!exactBenchmarkMeasuredUsage(usage)) throw new Error(`Codex turn usage ${index + 1} is incomplete`);
    for (const field of ["providerSessionId", "model", "thinkingLevel"]) {
      if (typeof usage[field] !== "string" || !usage[field]) throw new Error(`Codex turn usage ${index + 1} is missing ${field}`);
    }
  }
  const first = turnUsages[0];
  for (const [index, usage] of turnUsages.slice(1).entries()) {
    for (const field of ["providerSessionId", "model", "thinkingLevel"]) {
      if (usage[field] !== first[field]) throw new Error(`Codex turn usage ${index + 2} has mismatched ${field}`);
    }
  }

  const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  const subagentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, fresh: 0, total: 0 };
  const toolNames = {};
  const execution = emptyExecutionAggregate("codex-resumed-thread-aggregate");
  const pricingRequests = [];
  let messages = 0;
  let cost = 0;
  let exactCost = true;
  for (const usage of turnUsages) {
    for (const field of TOKEN_FIELDS) totals[field] += usage[field];
    for (const field of Object.keys(subagentTokens)) subagentTokens[field] += Number(usage.subagentTokens?.[field] ?? 0);
    for (const [name, count] of Object.entries(usage.toolNames ?? {})) toolNames[name] = (toolNames[name] ?? 0) + Number(count ?? 0);
    for (const field of EXECUTION_COUNTER_FIELDS) execution[field] += Number(usage.execution?.[field] ?? 0);
    if (Array.isArray(usage.pricingBuckets?.requests)) pricingRequests.push(...usage.pricingBuckets.requests);
    messages += Number(usage.messages ?? 0);
    if (Number.isFinite(usage.cost)) cost += usage.cost;
    else exactCost = false;
  }
  for (const field of ["tools", "retries", "compactions", "subagents"]) {
    execution.completeness[field] = executionCompleteness(turnUsages, field);
  }
  const pricingExact = turnUsages.every((usage) => usage.pricingBuckets?.completeness === "exact");
  return {
    ...totals,
    providerInput: totals.input + totals.cacheRead + totals.cacheWrite,
    cost: exactCost ? cost : null,
    costSource: exactCost ? "summed-provider-reported" : "unavailable",
    usageSource: "codex-resumed-thread-aggregate",
    usageCompleteness: "exact",
    sessions: 1,
    turns: turnUsages.length,
    subagentSessions: turnUsages.reduce((sum, usage) => sum + Number(usage.subagentSessions ?? 0), 0),
    subagentTokens,
    toolCalls: Object.values(toolNames).reduce((sum, count) => sum + count, 0),
    toolNames: Object.fromEntries(Object.entries(toolNames).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    messages,
    model: first.model,
    thinkingLevel: first.thinkingLevel,
    pricingBuckets: {
      schemaVersion: 1,
      source: pricingExact ? "provider-request-usage" : "codex-turn-aggregate-usage",
      completeness: pricingExact ? "exact" : "unverified",
      requests: pricingRequests
    },
    execution,
    contextUsage: {
      source: "unavailable",
      observations: 0,
      peakTokens: null,
      contextWindow: null,
      peakPercent: null
    },
    providerSessionId: first.providerSessionId
  };
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
      state.execution.toolCalls += 1;
      state.execution.toolResults += 1;
      const status = typeof event.item.status === "string" ? event.item.status.toLowerCase() : "";
      const failed = status === "failed" || type === "command_execution" && Number.isInteger(event.item.exit_code) && event.item.exit_code !== 0;
      if (failed) state.execution.toolFailures += 1;
      if (status === "blocked") state.execution.blockedToolCalls += 1;
      if (status === "declined") state.execution.declinedToolCalls += 1;
      const fingerprint = codexToolFingerprint(event.item);
      if (state.toolFingerprints.has(fingerprint)) state.execution.repeatedToolCalls += 1;
      else state.toolFingerprints.add(fingerprint);
      if (type === "collab_tool_call" && event.item.tool === "spawn_agent") {
        state.execution.subagentAttempts += 1;
        if (failed) state.execution.subagentFailures += 1;
      }
    }
    return;
  }
  if (event.type === "turn.completed") {
    state.completedTurns += 1;
    if (!plainObject(event.usage)) throw new Error("Codex JSONL turn.completed is missing usage");
    state.completedUsages.push(event.usage);
    state.execution.providerStartedAttempts += 1;
  }
}

function finishCodexUsage(state) {
  if (!state.threadId) throw new Error("Codex JSONL is missing thread.started");
  const { providerInput, input, output, cacheRead, cacheWrite, reasoning, total, fresh } = aggregateCodexProviderTurnTokens(state.completedUsages);
  const sortedTools = Object.fromEntries(Object.entries(state.toolNames).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
  state.execution.completeness.tools = "exact";
  state.execution.completeness.subagents = "exact";
  return {
    input,
    providerInput,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total,
    fresh,
    cost: null,
    costSource: "unavailable",
    usageSource: "codex-turn-completed",
    usageCompleteness: "exact",
    pricingBuckets: {
      schemaVersion: 1,
      source: "codex-turn-aggregate-usage",
      completeness: "unverified",
      requests: []
    },
    execution: state.execution,
    sessions: 1,
    turns: state.completedTurns,
    subagentSessions: 0,
    subagentTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, fresh: 0, total: 0 },
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
    completedUsages: [],
    completedTurns: 0,
    messages: 0,
    toolNames: {},
    toolFingerprints: new Set(),
    execution: emptyExecutionAggregate("codex-exec-jsonl"),
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

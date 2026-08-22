import { StringDecoder } from "node:string_decoder";

const CODEX_NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "plan", "user_message"]);
const TOKEN_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"]);

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

function exactMeasuredUsage(usage) {
  return Number.isInteger(usage?.sessions) && usage.sessions > 0
    && TOKEN_FIELDS.every((field) => Number.isFinite(usage?.[field]) && usage[field] >= 0)
    && usage.fresh === usage.input + usage.output
    && usage.total === usage.input + usage.cacheRead + usage.cacheWrite + usage.output
    && usage.reasoning <= usage.output;
}

function knownPreProviderZero(usage, status) {
  return status === "known-pre-provider-zero"
    && Number(usage?.sessions ?? 0) === 0
    && TOKEN_FIELDS.every((field) => Number(usage?.[field] ?? 0) === 0);
}

function tokenBucket(entries) {
  const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  const bySurface = {};
  let exactAttempts = 0;
  for (const entry of entries) {
    const exact = entry.status !== "unknown-after-provider-start"
      && (exactMeasuredUsage(entry.usage) || knownPreProviderZero(entry.usage, entry.status));
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
    usageSource: sessions.length > 0 ? "pi-session-jsonl" : "unavailable",
    usageCompleteness: sessions.length > 0 && sessions.every((session) => session.usageIntegrity?.exact === true) ? "exact" : "unverified",
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
  if (cacheRead + cacheWrite > providerInput) throw new Error("Codex JSONL cached and cache-write input tokens exceed input_tokens");
  if (reasoning > output) throw new Error("Codex JSONL reasoning_output_tokens exceeds output_tokens");
  const input = providerInput - cacheRead - cacheWrite;
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
    usageSource: "codex-turn-completed",
    usageCompleteness: "exact",
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

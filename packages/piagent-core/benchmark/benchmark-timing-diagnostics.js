import { StringDecoder } from "node:string_decoder";

import { median, rounded } from "./benchmark-statistics.js";

const CODEX_MODEL_OUTPUT_ITEMS = new Set(["agent_message", "reasoning"]);
const CODEX_CONTROL_ITEMS = new Set(["todo_list"]);
const CODEX_COMPLETED_ONLY_CONTROL_ITEMS = new Set(["error"]);
const CODEX_COMPLETED_ONLY_TOOL_ITEMS = new Set(["file_change"]);
const CODEX_TIMED_TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "collab_tool_call", "web_search"]);
const CODEX_COMMAND_TERMINAL_STATUSES = new Set(["completed", "failed", "declined"]);
const CODEX_TOOL_TERMINAL_STATUSES = new Set(["completed", "failed"]);
const CODEX_COLLAB_TOOLS = new Set(["spawn_agent", "send_input", "wait", "close_agent"]);
const CODEX_COLLAB_AGENT_STATUSES = new Set([
  "pending_init", "running", "interrupted", "completed", "errored", "shutdown", "not_found"
]);
const CODEX_USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];
const PI_CONTROL_EVENTS = new Set([
  "queue_update", "compaction_start", "entry_appended", "session_info_changed",
  "thinking_level_changed", "compaction_end", "auto_retry_start", "auto_retry_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
  "bash_execution_update"
]);
const PI_MESSAGE_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);
const SURFACES = new Set(["raw-pi", "piagent", "codex-cli"]);
const PHASES = ["processStartup", "modelTurnWait", "toolExecution", "other"];
const MAX_JSONL_BYTES = 64 * 1024 * 1024;
const MAX_TIMING_REPLAY_BYTES = 4 * 1024 * 1024;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function phase(status, seconds, reason, boundary) {
  return { status, seconds: status === "available" ? rounded(seconds, 6) : null, reason, boundary };
}

function intervalDuration(intervals) {
  if (intervals.length === 0) return 0;
  const ordered = intervals.slice().sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let [start, end] = ordered[0];
  for (const [nextStart, nextEnd] of ordered.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return total + end - start;
}

function addInterval(state, target, start, end) {
  if (!finiteNonnegative(start) || !finiteNonnegative(end) || end < start) {
    state.invalidClockBoundaries += 1;
    return false;
  }
  if (end === start) {
    state.coalescedBoundaries += 1;
    return false;
  }
  target.push([start, end]);
  return true;
}

function safeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_000 ? value : null;
}

function sameIdentityMaps(left, right) {
  if (left.size !== right.size) return false;
  for (const [id, name] of left) if (right.get(id) !== name) return false;
  return true;
}

function piToolResultIdentity(message) {
  if (!plainObject(message) || message.role !== "toolResult") return null;
  const id = safeId(message.toolCallId);
  return id && typeof message.toolName === "string" && message.toolName ? { id, name: message.toolName } : null;
}

function validPiCustomMessage(message) {
  return typeof message.customType === "string" && message.customType.length > 0
    && (typeof message.content === "string" || Array.isArray(message.content))
    && typeof message.display === "boolean" && finiteNonnegative(message.timestamp);
}

function invalidateEvent(state) {
  state.malformedLines += 1;
}

function validPiControlEvent(event) {
  if (event.type === "summarization_retry_finished") return true;
  if (event.type === "queue_update") return Array.isArray(event.steering) && Array.isArray(event.followUp);
  if (event.type === "compaction_start") return ["manual", "threshold", "overflow"].includes(event.reason);
  if (event.type === "entry_appended") return plainObject(event.entry);
  if (event.type === "session_info_changed") return event.name === undefined || typeof event.name === "string";
  if (event.type === "thinking_level_changed") return typeof event.level === "string" && event.level.length > 0;
  if (event.type === "compaction_end") return ["manual", "threshold", "overflow"].includes(event.reason)
    && typeof event.aborted === "boolean" && typeof event.willRetry === "boolean"
    && (event.result === undefined || event.result === null || plainObject(event.result));
  if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
    return Number.isSafeInteger(event.attempt) && event.attempt > 0
      && Number.isSafeInteger(event.maxAttempts) && event.maxAttempts > 0
      && finiteNonnegative(event.delayMs) && typeof event.errorMessage === "string";
  }
  if (event.type === "auto_retry_end") return typeof event.success === "boolean"
    && Number.isSafeInteger(event.attempt) && event.attempt > 0
    && (event.finalError === undefined || typeof event.finalError === "string");
  if (event.type === "summarization_retry_attempt_start") return ["branchSummary", "compaction"].includes(event.source)
    && (event.source !== "compaction" || ["manual", "threshold", "overflow"].includes(event.reason));
  if (event.type === "bash_execution_update") return (event.id === undefined || safeId(event.id)) && typeof event.delta === "string";
  return false;
}

function consumePiEvent(state, event, at) {
  if (state.agentSettled) {
    invalidateEvent(state);
    return;
  }
  if (event.type === "session") {
    if (state.jsonEvents !== 1 || state.sessionSeen || !Number.isSafeInteger(event.version) || event.version <= 0 || !safeId(event.id)
      || typeof event.timestamp !== "string" || !event.timestamp || typeof event.cwd !== "string" || !event.cwd) invalidateEvent(state);
    else {
      state.sessionSeen = true;
      state.sessionHeaders += 1;
    }
    return;
  }
  if (event.type === "agent_start") {
    if (!state.sessionSeen || state.agentCycleOpen || state.turnOpen || state.modelTurnStart !== null
      || state.openMessageRole !== null || state.openTools.size > 0) invalidateEvent(state);
    else {
      state.agentStarted = true;
      state.agentCycleOpen = true;
      state.agentEnded = false;
      state.lastAgentEndWillRetry = null;
      state.agentStarts += 1;
    }
    return;
  }
  if (event.type === "turn_start") {
    if (!state.agentCycleOpen || state.turnOpen || state.modelTurnStart !== null) {
      invalidateEvent(state);
      return;
    }
    state.turnStarts += 1;
    if (state.startupBoundary === null) state.startupBoundary = at;
    state.turnOpen = true;
    state.assistantSeenInTurn = false;
    state.assistantMessageEnded = false;
    state.turnToolStarts = 0;
    state.turnToolCompletions = 0;
    state.turnToolResultMessages = 0;
    state.completedTurnTools.clear();
    state.turnToolResultIdentities.clear();
    state.openToolResultIdentity = null;
    state.modelTurnStart = at;
    return;
  }
  if (event.type === "message_start" || event.type === "message_end") {
    if (!plainObject(event.message) || typeof event.message.role !== "string" || !state.turnOpen) {
      invalidateEvent(state);
      return;
    }
    const role = event.message.role;
    if (!PI_MESSAGE_ROLES.has(role) || role === "custom" && !validPiCustomMessage(event.message)) { invalidateEvent(state); return; }
    if (event.type === "message_start") {
      if (state.openMessageRole !== null || (["user", "custom"].includes(role) && state.assistantSeenInTurn)
        || (role === "toolResult" && (!state.assistantMessageEnded || state.openTools.size > 0))) {
        invalidateEvent(state);
        return;
      }
      if (role === "toolResult") {
        const identity = piToolResultIdentity(event.message);
        if (!identity || state.completedTurnTools.get(identity.id) !== identity.name
          || state.turnToolResultIdentities.has(identity.id)) {
          invalidateEvent(state);
          return;
        }
        state.openToolResultIdentity = identity;
      }
      if (role === "custom") state.openCustomType = event.message.customType;
      state.openMessageRole = role;
      if (role !== "assistant") return;
      if (state.assistantSeenInTurn || state.modelTurnStart === null) {
        invalidateEvent(state);
        return;
      }
      state.assistantSeenInTurn = true;
      return;
    }
    if (state.openMessageRole !== role || role === "custom" && state.openCustomType !== event.message.customType) {
      invalidateEvent(state);
      return;
    }
    if (role === "toolResult") {
      const identity = piToolResultIdentity(event.message);
      if (!identity || state.openToolResultIdentity === null
        || identity.id !== state.openToolResultIdentity.id || identity.name !== state.openToolResultIdentity.name) {
        invalidateEvent(state);
        return;
      }
      state.turnToolResultIdentities.set(identity.id, identity.name);
      state.openToolResultIdentity = null;
    }
    state.openMessageRole = null;
    if (role === "custom") state.openCustomType = null;
    if (role === "user" || role === "custom") {
      if (state.assistantSeenInTurn || state.modelTurnStart === null) invalidateEvent(state);
      else state.modelTurnStart = at;
      return;
    }
    if (role === "toolResult") {
      if (!state.assistantMessageEnded || state.openTools.size > 0) invalidateEvent(state);
      else state.turnToolResultMessages += 1;
    }
    if (role === "assistant") {
      if (!state.assistantSeenInTurn || state.assistantMessageEnded || state.modelTurnStart === null) invalidateEvent(state);
      else {
        state.assistantBoundaries += 1;
        if (addInterval(state, state.modelTurnIntervals, state.modelTurnStart, at)) state.matchedModelTurnIntervals += 1;
        else state.modelTurnIntervalsInvalid = true;
        state.modelTurnStart = null;
        state.assistantMessageEnded = true;
      }
    }
    return;
  }
  if (event.type === "message_update") {
    if (!state.turnOpen || state.openMessageRole !== "assistant" || !plainObject(event.assistantMessageEvent)) invalidateEvent(state);
    return;
  }
  if (event.type === "tool_execution_start") {
    const id = safeId(event.toolCallId);
    if (!state.turnOpen || !state.assistantMessageEnded || !id || typeof event.toolName !== "string" || !event.toolName
      || state.openTools.has(id)) {
      invalidateEvent(state);
      return;
    }
    if (state.completedTurnTools.has(id)) {
      invalidateEvent(state);
      return;
    }
    state.toolStarts += 1;
    state.turnToolStarts += 1;
    state.openTools.set(id, { at, toolName: event.toolName });
    return;
  }
  if (event.type === "tool_execution_end") {
    const id = safeId(event.toolCallId);
    if (!state.turnOpen || !state.assistantMessageEnded || !id || typeof event.toolName !== "string" || !event.toolName
      || typeof event.isError !== "boolean") {
      invalidateEvent(state);
      return;
    }
    state.toolCompletions += 1;
    state.turnToolCompletions += 1;
    const started = state.openTools.get(id);
    if (started === undefined || started.toolName !== event.toolName || state.completedTurnTools.has(id)) {
      if (started !== undefined && started.toolName !== event.toolName) invalidateEvent(state);
      state.unmatchedToolCompletions += 1;
    }
    else {
      if (!addInterval(state, state.toolIntervals, started.at, at)) state.toolIntervalsInvalid = true;
      state.matchedToolIntervals += 1;
      state.openTools.delete(id);
      state.completedTurnTools.set(id, event.toolName);
    }
    return;
  }
  if (event.type === "tool_execution_update") {
    const id = safeId(event.toolCallId);
    const started = id ? state.openTools.get(id) : undefined;
    if (!state.turnOpen || !state.assistantMessageEnded || !id || started === undefined
      || typeof event.toolName !== "string" || !event.toolName || started.toolName !== event.toolName) invalidateEvent(state);
    return;
  }
  if (event.type === "turn_end") {
    const receiptIdentities = new Map();
    let receiptValid = Array.isArray(event.toolResults);
    if (receiptValid) {
      for (const result of event.toolResults) {
        const identity = piToolResultIdentity(result);
        if (!identity || receiptIdentities.has(identity.id)) { receiptValid = false; break; }
        receiptIdentities.set(identity.id, identity.name);
      }
    }
    if (!state.turnOpen || !state.assistantMessageEnded || !plainObject(event.message) || !Array.isArray(event.toolResults)
      || event.message.role !== "assistant" || state.openMessageRole !== null
      || state.openToolResultIdentity !== null || !receiptValid
      || state.openTools.size > 0 || state.modelTurnStart !== null
      || state.turnToolStarts !== state.turnToolCompletions
      || state.turnToolCompletions !== state.turnToolResultMessages
      || state.turnToolCompletions !== event.toolResults.length
      || !sameIdentityMaps(state.completedTurnTools, state.turnToolResultIdentities)
      || !sameIdentityMaps(state.completedTurnTools, receiptIdentities)) {
      invalidateEvent(state);
      return;
    }
    state.turnCompletions += 1;
    state.turnOpen = false;
    state.assistantSeenInTurn = false;
    state.assistantMessageEnded = false;
    state.turnToolStarts = 0;
    state.turnToolCompletions = 0;
    state.turnToolResultMessages = 0;
    state.completedTurnTools.clear();
    state.turnToolResultIdentities.clear();
    state.openToolResultIdentity = null;
    return;
  }
  if (event.type === "agent_end") {
    if (!state.agentCycleOpen || typeof event.willRetry !== "boolean" || !Array.isArray(event.messages)
      || state.turnOpen || state.modelTurnStart !== null || state.openMessageRole !== null || state.openTools.size > 0) invalidateEvent(state);
    else {
      state.agentCycleOpen = false;
      state.agentEnded = true;
      state.lastAgentEndWillRetry = event.willRetry;
      state.agentEnds += 1;
    }
    return;
  }
  if (event.type === "agent_settled") {
    if (!state.sessionSeen || !state.agentStarted || !state.agentEnded || state.agentCycleOpen
      || state.lastAgentEndWillRetry !== false
      || state.turnOpen || state.openMessageRole !== null || state.openTools.size > 0) invalidateEvent(state);
    else {
      state.agentSettled = true;
      state.agentSettledEvents += 1;
    }
    return;
  }
  if (PI_CONTROL_EVENTS.has(event.type)) {
    if (!validPiControlEvent(event)) invalidateEvent(state);
    return;
  }
  invalidateEvent(state);
}

function codexItemKind(type) {
  if (CODEX_MODEL_OUTPUT_ITEMS.has(type)) return "model-output";
  if (CODEX_CONTROL_ITEMS.has(type)) return "control";
  if (CODEX_COMPLETED_ONLY_CONTROL_ITEMS.has(type)) return "completed-only-control";
  if (CODEX_COMPLETED_ONLY_TOOL_ITEMS.has(type)) return "completed-only-tool";
  if (CODEX_TIMED_TOOL_ITEMS.has(type)) return "timed-tool";
  return null;
}

function validCodexTodoList(item) {
  return Array.isArray(item.items) && item.items.every((todo) => plainObject(todo)
    && typeof todo.text === "string" && typeof todo.completed === "boolean");
}

function validCodexUsage(usage) {
  return plainObject(usage) && CODEX_USAGE_KEYS.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    && (usage.cache_write_input_tokens === undefined
      || Number.isSafeInteger(usage.cache_write_input_tokens) && usage.cache_write_input_tokens >= 0);
}

function validCodexMcpResult(result) {
  return plainObject(result) && Array.isArray(result.content);
}

function validCodexCollabAgents(states) {
  return plainObject(states) && Object.entries(states).every(([id, agent]) => safeId(id) && plainObject(agent)
    && CODEX_COLLAB_AGENT_STATUSES.has(agent.status)
    && (agent.message === null || typeof agent.message === "string"));
}

function validCodexWebSearchAction(action) {
  if (!plainObject(action) || !["search", "open_page", "find_in_page", "other"].includes(action.type)) return false;
  if (action.type === "search") return (action.query === undefined || typeof action.query === "string")
    && (action.queries === undefined || Array.isArray(action.queries) && action.queries.every((query) => typeof query === "string"));
  if (action.type === "open_page") return action.url === undefined || typeof action.url === "string";
  if (action.type === "find_in_page") return (action.url === undefined || typeof action.url === "string")
    && (action.pattern === undefined || typeof action.pattern === "string");
  return true;
}

function validCodexItemForEvent(eventType, item) {
  if (CODEX_MODEL_OUTPUT_ITEMS.has(item.type)) {
    return eventType === "item.completed" && typeof item.text === "string"
      && (item.type !== "reasoning" || item.text.trim().length > 0);
  }
  if (item.type === "todo_list") {
    return ["item.started", "item.updated", "item.completed"].includes(eventType) && validCodexTodoList(item);
  }
  if (item.type === "error") {
    return eventType === "item.completed" && typeof item.message === "string" && item.message.length > 0;
  }
  if (item.type === "file_change") {
    return eventType === "item.completed" && ["completed", "failed"].includes(item.status)
      && Array.isArray(item.changes) && item.changes.every((change) => plainObject(change)
        && typeof change.path === "string" && ["add", "delete", "update"].includes(change.kind));
  }
  if (item.type === "command_execution") {
    const statusValid = eventType === "item.started"
      ? item.status === "in_progress"
      : eventType === "item.completed" && CODEX_COMMAND_TERMINAL_STATUSES.has(item.status);
    return statusValid && typeof item.command === "string"
      && (eventType === "item.started"
        ? (item.aggregated_output === undefined || typeof item.aggregated_output === "string")
          && (item.exit_code === undefined || item.exit_code === null)
        : typeof item.aggregated_output === "string" && (item.exit_code === null || Number.isSafeInteger(item.exit_code)));
  }
  if (item.type === "mcp_tool_call") {
    const statusValid = eventType === "item.started"
      ? item.status === "in_progress"
      : eventType === "item.completed" && CODEX_TOOL_TERMINAL_STATUSES.has(item.status);
    return statusValid && typeof item.server === "string" && item.server.length > 0
      && typeof item.tool === "string" && item.tool.length > 0
      && (eventType === "item.started" || Object.hasOwn(item, "arguments"))
      && (item.result === undefined || item.result === null || validCodexMcpResult(item.result))
      && (item.error === undefined || item.error === null
        || plainObject(item.error) && typeof item.error.message === "string" && item.error.message.length > 0);
  }
  if (item.type === "collab_tool_call") {
    const statusValid = eventType === "item.started"
      ? item.status === "in_progress"
      : eventType === "item.completed" && CODEX_TOOL_TERMINAL_STATUSES.has(item.status);
    return statusValid && CODEX_COLLAB_TOOLS.has(item.tool) && Boolean(safeId(item.sender_thread_id))
      && Array.isArray(item.receiver_thread_ids) && item.receiver_thread_ids.every((id) => safeId(id))
      && (item.prompt === undefined || item.prompt === null || typeof item.prompt === "string")
      && (eventType === "item.started"
        ? item.agents_states === undefined || validCodexCollabAgents(item.agents_states)
        : validCodexCollabAgents(item.agents_states));
  }
  return item.type === "web_search" && ["item.started", "item.completed"].includes(eventType) && Boolean(safeId(item.id))
    && (eventType === "item.started"
      ? (item.query === undefined || typeof item.query === "string")
        && (item.action === undefined || validCodexWebSearchAction(item.action))
      : typeof item.query === "string" && validCodexWebSearchAction(item.action));
}

function closeCodexModelTurnInterval(state, at) {
  if (state.modelTurnStart === null) return;
  if (addInterval(state, state.modelTurnIntervals, state.modelTurnStart, at)) state.matchedModelTurnIntervals += 1;
  else state.modelTurnIntervalsInvalid = true;
  state.modelTurnStart = null;
}

function consumeCodexEvent(state, event, at) {
  if (state.terminalTurnSeen) {
    invalidateEvent(state);
    return;
  }
  if (event.type === "thread.started") {
    if (state.jsonEvents !== 1 || !safeId(event.thread_id) || state.threadSeen || state.turnOpen) invalidateEvent(state);
    else {
      state.threadSeen = true;
      state.threadStarts += 1;
    }
    return;
  }
  if (event.type === "turn.started") {
    if (!state.threadSeen || state.terminalTurnSeen || state.turnOpen || state.modelTurnStart !== null) {
      invalidateEvent(state);
      return;
    }
    state.turnStarts += 1;
    if (state.startupBoundary === null) state.startupBoundary = at;
    state.turnOpen = true;
    state.modelTurnStart = at;
    return;
  }
  if (event.type === "turn.failed") {
    if (!state.turnOpen || !plainObject(event.error) || typeof event.error.message !== "string" || !event.error.message) {
      invalidateEvent(state);
      return;
    }
    if (state.modelTurnStart !== null) {
      state.unmatchedModelTurnStarts += 1;
      state.modelTurnStart = null;
    }
    state.unmatchedToolStarts += state.openTools.size;
    state.openTools.clear();
    if (state.openTodoItemId !== null) state.openTodoItemId = null;
    state.turnOpen = false;
    state.terminalTurnSeen = true;
    return;
  }
  if (event.type === "error") {
    if (!state.threadSeen || typeof event.message !== "string" || !event.message) {
      invalidateEvent(state);
      return;
    }
    state.providerErrorSeen = true;
    return;
  }
  if (event.type === "turn.completed") {
    if (!state.turnOpen || !validCodexUsage(event.usage) || state.openTools.size > 0 || state.openTodoItemId !== null) {
      invalidateEvent(state);
      return;
    }
    state.turnCompletions += 1;
    closeCodexModelTurnInterval(state, at);
    state.turnOpen = false;
    state.terminalTurnSeen = true;
    return;
  }
  if (event.type === "item.updated") {
    if (!state.turnOpen || !plainObject(event.item) || !safeId(event.item.id)
      || event.item.type !== "todo_list" || !validCodexItemForEvent(event.type, event.item)
      || state.openTodoItemId !== event.item.id || state.seenCodexItemIds.get(event.item.id) !== "todo_list") invalidateEvent(state);
    return;
  }
  if (!["item.started", "item.completed"].includes(event.type)) {
    invalidateEvent(state);
    return;
  }
  if (!plainObject(event.item) || !safeId(event.item.id) || typeof event.item.type !== "string" || !state.turnOpen) {
    invalidateEvent(state);
    return;
  }
  const kind = codexItemKind(event.item.type);
  if (!kind || !validCodexItemForEvent(event.type, event.item)) {
    invalidateEvent(state);
    return;
  }
  if (event.type === "item.started") {
    if (state.seenCodexItemIds.has(event.item.id)) {
      invalidateEvent(state);
      return;
    }
    if (kind === "control") {
      if (state.openTodoItemId !== null) invalidateEvent(state);
      else {
        state.seenCodexItemIds.set(event.item.id, event.item.type);
        state.openTodoItemId = event.item.id;
      }
      return;
    }
    const id = safeId(event.item.id);
    if (!id || state.openTools.has(id)) { invalidateEvent(state); return; }
    state.seenCodexItemIds.set(id, event.item.type);
    closeCodexModelTurnInterval(state, at);
    state.toolStarts += 1;
    state.openTools.set(id, { at, type: event.item.type });
    return;
  }
  if (kind === "control") {
    if (state.openTodoItemId !== event.item.id || state.seenCodexItemIds.get(event.item.id) !== event.item.type) invalidateEvent(state);
    else state.openTodoItemId = null;
    return;
  }
  if (kind === "completed-only-control" || kind === "model-output" || kind === "completed-only-tool") {
    if (state.seenCodexItemIds.has(event.item.id)) {
      invalidateEvent(state);
      return;
    }
    state.seenCodexItemIds.set(event.item.id, event.item.type);
  }
  if (kind === "completed-only-control") return;
  if (kind === "completed-only-tool") {
    state.toolCompletions += 1;
    state.unmatchedToolCompletions += 1;
    state.modelTurnIntervalsInvalid = true;
    state.toolIntervalsInvalid = true;
    return;
  }
  if (kind === "model-output") return;
  state.toolCompletions += 1;
  const id = safeId(event.item.id);
  if (!id) {
    invalidateEvent(state);
    state.unmatchedToolCompletions += 1;
    return;
  }
  const seenType = state.seenCodexItemIds.get(id);
  const started = state.openTools.get(id);
  let matched = false;
  if (started === undefined) {
    if (seenType !== undefined) invalidateEvent(state);
    else state.seenCodexItemIds.set(id, event.item.type);
    state.unmatchedToolCompletions += 1;
    state.modelTurnIntervalsInvalid = true;
    state.toolIntervalsInvalid = true;
  }
  else if (seenType !== event.item.type || started.type !== event.item.type) {
    invalidateEvent(state);
    state.unmatchedToolCompletions += 1;
    state.modelTurnIntervalsInvalid = true;
    state.toolIntervalsInvalid = true;
  }
  else {
    if (!addInterval(state, state.toolIntervals, started.at, at)) state.toolIntervalsInvalid = true;
    state.matchedToolIntervals += 1;
    state.openTools.delete(id);
    matched = true;
  }
  if (matched && state.openTools.size === 0) {
    if (state.modelTurnStart !== null) state.unmatchedModelTurnStarts += 1;
    state.modelTurnStart = at;
  }
}

function unavailableReason(state, kind) {
  if (state.malformedLines > 0 || state.invalidObservationClock || state.providerErrorSeen) return "invalid-event-stream";
  if (kind === "startup" && state.startupBoundary === null) return "missing-turn-start-boundary";
  if (kind === "modelTurn" && (state.modelTurnIntervalsInvalid || state.unmatchedModelTurnStarts > 0 || state.turnStarts === 0)) return "incomplete-model-turn-boundaries";
  if (kind === "tool" && (state.toolIntervalsInvalid || state.unmatchedToolStarts > 0 || state.unmatchedToolCompletions > 0 || state.openTools.size > 0)) return "incomplete-tool-boundaries";
  return "unavailable";
}

export function unavailableBenchmarkTimingDiagnostics(surface, durationSeconds) {
  if (!SURFACES.has(surface)) throw new Error(`Unsupported benchmark timing surface: ${surface}`);
  const processDurationSeconds = finiteNonnegative(durationSeconds) ? rounded(durationSeconds, 6) : null;
  return {
    schemaVersion: 1,
    authority: "observational-only",
    gateImpact: "none",
    clock: "benchmark-process-monotonic-receipt",
    surface,
    status: "unavailable",
    processDurationSeconds,
    phases: {
      processStartup: phase("unavailable", null, "invalid-event-stream", "process-start-to-turn-start"),
      modelTurnWait: phase("unavailable", null, "invalid-event-stream", "request-ready-to-next-model-output-boundary"),
      toolExecution: phase("unavailable", null, "invalid-event-stream", "matched-tool-start-to-tool-completion"),
      other: phase("unavailable", null, "one-or-more-phase-boundaries-unavailable", "process-duration-minus-available-observed-phases")
    },
    observations: {
      jsonEvents: 0, sessionHeaders: 0, agentStarts: 0, agentEnds: 0, agentSettled: 0, threadStarts: 0,
      turnStarts: 0, turnCompletions: 0, matchedModelTurnIntervals: 0,
      toolStarts: 0, toolCompletions: 0, matchedToolIntervals: 0,
      unmatchedToolStarts: 0, unmatchedToolCompletions: 0, unmatchedModelTurnStarts: 0,
      malformedLines: 1, invalidClockBoundaries: 0, coalescedBoundaries: 0
    },
    privacy: { rawPayloadStored: false, promptsStored: false, commandsStored: false, pathsStored: false, identifiersStored: false }
  };
}

function finish(state, durationSeconds) {
  const durationAvailable = finiteNonnegative(durationSeconds);
  if (durationAvailable && state.lastObservationAt !== null && state.lastObservationAt > durationSeconds + 1e-6) {
    state.invalidObservationClock = true;
    state.invalidClockBoundaries += 1;
  }
  const lifecycleComplete = state.surface === "codex-cli"
    ? state.threadSeen && state.terminalTurnSeen && state.turnStarts > 0
      && state.turnCompletions === state.turnStarts && !state.turnOpen
    : state.turnStarts > 0 && state.turnCompletions === state.turnStarts && state.assistantBoundaries === state.turnStarts
      && state.sessionSeen && state.agentStarted && state.agentEnded && state.agentSettled
      && !state.agentCycleOpen && state.lastAgentEndWillRetry === false && state.agentStarts === state.agentEnds
      && !state.turnOpen && state.modelTurnStart === null;
  if (state.modelTurnStart !== null) state.unmatchedModelTurnStarts += 1;
  state.unmatchedToolStarts += state.openTools.size;
  const startupAvailable = durationAvailable && state.malformedLines === 0 && !state.invalidObservationClock
    && !state.providerErrorSeen && state.startupBoundary !== null && state.startupBoundary <= durationSeconds;
  const modelTurnAvailable = durationAvailable && state.malformedLines === 0 && !state.invalidObservationClock
    && !state.providerErrorSeen && lifecycleComplete && state.unmatchedModelTurnStarts === 0 && !state.modelTurnIntervalsInvalid;
  const toolAvailable = durationAvailable && state.malformedLines === 0 && !state.invalidObservationClock
    && !state.providerErrorSeen && lifecycleComplete && state.unmatchedToolStarts === 0
    && state.unmatchedToolCompletions === 0 && !state.toolIntervalsInvalid;
  const startupSeconds = startupAvailable ? state.startupBoundary : null;
  const modelTurnSeconds = modelTurnAvailable ? intervalDuration(state.modelTurnIntervals) : null;
  const toolSeconds = toolAvailable ? intervalDuration(state.toolIntervals) : null;
  const attributed = startupAvailable && modelTurnAvailable && toolAvailable
    ? startupSeconds + modelTurnSeconds + toolSeconds
    : null;
  const otherAvailable = Number.isFinite(attributed) && attributed <= durationSeconds + 1e-6;
  const otherSeconds = otherAvailable ? Math.max(0, durationSeconds - attributed) : null;
  const availablePhases = [startupAvailable, modelTurnAvailable, toolAvailable, otherAvailable].filter(Boolean).length;
  const status = availablePhases === PHASES.length ? "complete" : availablePhases > 0 ? "partial" : "unavailable";
  return {
    schemaVersion: 1,
    authority: "observational-only",
    gateImpact: "none",
    clock: "benchmark-process-monotonic-receipt",
    surface: state.surface,
    status,
    processDurationSeconds: durationAvailable ? rounded(durationSeconds, 6) : null,
    phases: {
      processStartup: startupAvailable
        ? phase("available", startupSeconds, "observed-boundaries", "process-start-to-turn-start")
        : phase("unavailable", null, unavailableReason(state, "startup"), "process-start-to-turn-start"),
      modelTurnWait: modelTurnAvailable
        ? phase("available", modelTurnSeconds, "observed-boundaries", "request-ready-to-next-model-output-boundary")
        : phase("unavailable", null, unavailableReason(state, "modelTurn"), "request-ready-to-next-model-output-boundary"),
      toolExecution: toolAvailable
        ? phase("available", toolSeconds, "observed-boundaries", "matched-tool-start-to-tool-completion")
        : phase("unavailable", null, unavailableReason(state, "tool"), "matched-tool-start-to-tool-completion"),
      other: otherAvailable
        ? phase("available", otherSeconds, "exact-unattributed-remainder", "process-duration-minus-available-observed-phases")
        : phase("unavailable", null, "one-or-more-phase-boundaries-unavailable", "process-duration-minus-available-observed-phases")
    },
    observations: {
      jsonEvents: state.jsonEvents,
      sessionHeaders: state.sessionHeaders,
      agentStarts: state.agentStarts,
      agentEnds: state.agentEnds,
      agentSettled: state.agentSettledEvents,
      threadStarts: state.threadStarts,
      turnStarts: state.turnStarts,
      turnCompletions: state.turnCompletions,
      matchedModelTurnIntervals: state.matchedModelTurnIntervals,
      toolStarts: state.toolStarts,
      toolCompletions: state.toolCompletions,
      matchedToolIntervals: state.matchedToolIntervals,
      unmatchedToolStarts: state.unmatchedToolStarts,
      unmatchedToolCompletions: state.unmatchedToolCompletions,
      unmatchedModelTurnStarts: state.unmatchedModelTurnStarts,
      malformedLines: state.malformedLines,
      invalidClockBoundaries: state.invalidClockBoundaries,
      coalescedBoundaries: state.coalescedBoundaries
    },
    privacy: {
      rawPayloadStored: false,
      promptsStored: false,
      commandsStored: false,
      pathsStored: false,
      identifiersStored: false
    }
  };
}

export function createBenchmarkTimingCollector({ surface }) {
  if (!SURFACES.has(surface)) throw new Error(`Unsupported benchmark timing surface: ${surface}`);
  const state = {
    surface,
    jsonEvents: 0, sessionHeaders: 0, agentStarts: 0, agentEnds: 0, agentSettledEvents: 0,
    threadStarts: 0, turnStarts: 0, turnCompletions: 0, assistantBoundaries: 0,
    toolStarts: 0, toolCompletions: 0, matchedToolIntervals: 0, matchedModelTurnIntervals: 0,
    unmatchedToolStarts: 0, unmatchedToolCompletions: 0, unmatchedModelTurnStarts: 0,
    malformedLines: 0, invalidClockBoundaries: 0, coalescedBoundaries: 0, invalidObservationClock: false,
    startupBoundary: null, modelTurnStart: null,
    modelTurnIntervals: [],
    modelTurnIntervalsInvalid: false,
    toolIntervals: [],
    toolIntervalsInvalid: false,
    openTools: new Map(),
    completedTurnTools: new Map(),
    turnToolResultIdentities: new Map(),
    openToolResultIdentity: null,
    seenCodexItemIds: new Map(),
    turnOpen: false, assistantSeenInTurn: false, assistantMessageEnded: false, openMessageRole: null, openCustomType: null,
    turnToolStarts: 0, turnToolCompletions: 0, turnToolResultMessages: 0, openTodoItemId: null,
    agentStarted: false, agentCycleOpen: false, agentEnded: false, lastAgentEndWillRetry: null,
    agentSettled: false, sessionSeen: false, threadSeen: false, terminalTurnSeen: false, providerErrorSeen: false,
    lastObservationAt: null
  };
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let bufferedAt = 0;
  let finished = false;
  const consumeLine = (raw, at) => {
    const line = raw.trim();
    if (!line) return;
    let event;
    try { event = JSON.parse(line); }
    catch { state.malformedLines += 1; return; }
    if (!plainObject(event) || typeof event.type !== "string") { state.malformedLines += 1; return; }
    state.jsonEvents += 1;
    if (surface === "codex-cli") consumeCodexEvent(state, event, at);
    else consumePiEvent(state, event, at);
  };
  return {
    write(chunk, observedAtSeconds) {
      if (finished) throw new Error("Benchmark timing collector is already finished");
      if (!finiteNonnegative(observedAtSeconds) || observedAtSeconds < bufferedAt) state.invalidObservationClock = true;
      bufferedAt = finiteNonnegative(observedAtSeconds) ? observedAtSeconds : bufferedAt;
      if (finiteNonnegative(observedAtSeconds)) state.lastObservationAt = observedAtSeconds;
      buffer += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, newline), bufferedAt);
        buffer = buffer.slice(newline + 1);
      }
      if (Buffer.byteLength(buffer) > MAX_JSONL_BYTES) { state.malformedLines += 1; buffer = ""; }
    },
    finish(durationSeconds) {
      if (finished) throw new Error("Benchmark timing collector is already finished");
      finished = true;
      buffer += decoder.end();
      if (buffer) consumeLine(buffer, bufferedAt);
      buffer = "";
      return finish(state, durationSeconds);
    }
  };
}

export function createDeferredBenchmarkTimingCollector({
  surface,
  maximumBytes = MAX_TIMING_REPLAY_BYTES,
  collectorFactory = createBenchmarkTimingCollector
}) {
  if (!SURFACES.has(surface)) throw new Error(`Unsupported benchmark timing surface: ${surface}`);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error("Benchmark timing replay limit must be a positive safe integer");
  if (typeof collectorFactory !== "function") throw new Error("Benchmark timing collector factory must be a function");
  const entries = [];
  let capturedBytes = 0;
  let overflow = false;
  let finished = false;
  const clear = () => {
    for (const entry of entries) { try { entry.chunk.fill(0); } catch { /* Best-effort zeroing; release references below. */ } }
    entries.length = 0;
    capturedBytes = 0;
  };
  return {
    write(chunk, observedAtSeconds) {
      if (finished) throw new Error("Deferred benchmark timing collector is already finished");
      if (overflow) return;
      try {
        const byteLength = Buffer.byteLength(chunk);
        if (byteLength > maximumBytes - capturedBytes) {
          overflow = true;
          clear();
          return;
        }
        const copy = Buffer.from(chunk);
        entries.push({ chunk: copy, observedAtSeconds });
        capturedBytes += copy.length;
      } catch {
        overflow = true;
        clear();
      }
    },
    discard() {
      finished = true;
      clear();
    },
    finish(durationSeconds) {
      if (finished) throw new Error("Deferred benchmark timing collector is already finished");
      finished = true;
      try {
        const collector = collectorFactory({ surface });
        if (overflow) collector.write("invalid-bounded-timing-replay\n", 0);
        else for (const entry of entries) collector.write(entry.chunk, entry.observedAtSeconds);
        return collector.finish(durationSeconds);
      } catch {
        return unavailableBenchmarkTimingDiagnostics(surface, durationSeconds);
      } finally {
        clear();
      }
    }
  };
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

export function validBenchmarkTimingDiagnostics(value, surface, durationSeconds) {
  const topLevelKeys = ["schemaVersion", "authority", "gateImpact", "clock", "surface", "status", "processDurationSeconds", "phases", "observations", "privacy"];
  if (!plainObject(value) || Object.keys(value).length !== topLevelKeys.length || !topLevelKeys.every((key) => Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || value.authority !== "observational-only"
    || value.gateImpact !== "none" || value.clock !== "benchmark-process-monotonic-receipt"
    || value.surface !== surface || !["complete", "partial", "unavailable"].includes(value.status)
    || !finiteNonnegative(value.processDurationSeconds)
    || !plainObject(value.phases) || Object.keys(value.phases).length !== PHASES.length
    || !PHASES.every((name) => validPhase(value.phases[name], name))) return false;
  if (finiteNonnegative(durationSeconds) && Math.abs(value.processDurationSeconds - durationSeconds) > 1e-5) return false;
  const observationKeys = ["jsonEvents", "sessionHeaders", "agentStarts", "agentEnds", "agentSettled", "threadStarts",
    "turnStarts", "turnCompletions", "matchedModelTurnIntervals", "toolStarts", "toolCompletions", "matchedToolIntervals",
    "unmatchedToolStarts", "unmatchedToolCompletions", "unmatchedModelTurnStarts", "malformedLines", "invalidClockBoundaries", "coalescedBoundaries"];
  if (!plainObject(value.observations) || Object.keys(value.observations).length !== observationKeys.length
    || !observationKeys.every((key) => Number.isSafeInteger(value.observations[key]) && value.observations[key] >= 0)) return false;
  const observations = value.observations;
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
  const available = PHASES.filter((name) => value.phases[name].status === "available").length;
  const expectedStatus = available === PHASES.length ? "complete" : available > 0 ? "partial" : "unavailable";
  if (value.status !== expectedStatus) return false;
  if (PHASES.some((name) => value.phases[name].status === "available" && value.phases[name].seconds > value.processDurationSeconds + 1e-6)) return false;
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
    const sum = PHASES.reduce((total, name) => total + value.phases[name].seconds, 0);
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
    const phaseSummary = Object.fromEntries(PHASES.map((name) => {
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
      phases: phaseSummary
    };
  }
  return {
    schemaVersion: 1,
    authority: "observational-only",
    gateImpact: "none",
    clock: "benchmark-process-monotonic-receipt",
    surfaces
  };
}

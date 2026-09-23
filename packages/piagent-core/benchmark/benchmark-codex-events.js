const ALLOWED_AUXILIARY_EVENTS = new Set(["thread_settings_applied", "event_msg"]);
const FAILURE_ITEM_STATUSES = new Set(["failed", "blocked", "declined"]);
const TOOL_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "collab_tool_call", "web_search", "file_change"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function reason(state, value) {
  state.lifecycleViolations.add(value);
}

function failure(state, value) {
  state.failureSignals.add(value);
}

function safeItemId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
}

export function createCodexEventState() {
  return {
    events: 0,
    eventTypes: {},
    threadIds: [],
    turnStarted: 0,
    turnCompleted: 0,
    turnFailed: 0,
    turnOpen: false,
    terminalSeen: false,
    terminalAgentMessages: 0,
    terminalResponseText: "",
    itemStarted: 0,
    itemCompleted: 0,
    itemUpdated: 0,
    itemTypes: {},
    openItems: new Map(),
    seenItemIds: new Map(),
    lifecycleViolations: new Set(),
    failureSignals: new Set(),
    commandFailureSignals: new Set(),
    pendingCommandFailures: 0,
    commandFailureEvents: 0,
    continuedCommandFailureEvents: 0
  };
}

function consumeItem(state, event) {
  // Later item activity makes an earlier assistant response non-terminal.
  state.terminalResponseText = "";
  const item = event.item;
  if (!plainObject(item) || typeof item.type !== "string" || !item.type) {
    reason(state, "invalid-item-envelope");
    return;
  }
  if (!state.turnOpen || state.terminalSeen) reason(state, "item-outside-open-turn");
  const id = safeItemId(item.id);
  increment(state.itemTypes, item.type);
  if (event.type === "item.started") {
    state.itemStarted += 1;
    if (id && state.seenItemIds.has(id)) reason(state, "duplicate-item-id");
    if (id) {
      state.seenItemIds.set(id, item.type);
      state.openItems.set(id, item.type);
    }
    return;
  }
  if (event.type === "item.updated") {
    state.itemUpdated += 1;
    if (!id || state.openItems.get(id) !== item.type || item.type !== "todo_list") {
      reason(state, "invalid-item-update-transition");
    }
    return;
  }
  state.itemCompleted += 1;
  if (id) {
    const seen = state.seenItemIds.get(id);
    if (seen && seen !== item.type) reason(state, "conflicting-item-type");
    if (seen && !state.openItems.has(id)) reason(state, "duplicate-item-terminal");
    if (!seen) state.seenItemIds.set(id, item.type);
    state.openItems.delete(id);
  }
  if (item.type === "agent_message") {
    state.terminalAgentMessages += 1;
    // Transient text only; never included in the persisted redacted summary.
    // A blank/non-text final message must supersede any earlier response.
    state.terminalResponseText = typeof item.text === "string" && item.text.trim()
      && (item.status === undefined || item.status === "completed") ? item.text : "";
  }
  if (item.type === "error") failure(state, "item-error");
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  if (FAILURE_ITEM_STATUSES.has(status)) failure(state, `${item.type}-${status}`);
  if (item.type === "command_execution" && Number.isSafeInteger(item.exit_code) && item.exit_code !== 0) {
    failure(state, "command-exit-nonzero");
  }
  if (item.type === "command_execution") {
    const nonzero = Number.isSafeInteger(item.exit_code) && item.exit_code !== 0;
    if (status === "failed" || nonzero) {
      state.commandFailureEvents += 1;
      state.pendingCommandFailures += 1;
      if (status === "failed") state.commandFailureSignals.add("command_execution-failed");
      if (nonzero) state.commandFailureSignals.add("command-exit-nonzero");
    } else if (item.exit_code === 0 && (status === "" || status === "completed")) {
      // A later successful command is evidence that execution continued, not
      // that the task is correct. Functional grading remains authoritative.
      state.continuedCommandFailureEvents += state.pendingCommandFailures;
      state.pendingCommandFailures = 0;
    }
  }
}

export function consumeCodexLifecycleEvent(state, event) {
  state.events += 1;
  if (!plainObject(event) || typeof event.type !== "string" || !event.type) {
    reason(state, "invalid-event-envelope");
    return;
  }
  increment(state.eventTypes, event.type);
  if (state.terminalSeen && event.type !== "thread_settings_applied") reason(state, "event-after-terminal");
  if (event.type === "thread.started") {
    if (state.events !== 1 || state.threadIds.length > 0 || typeof event.thread_id !== "string" || !event.thread_id) {
      reason(state, "invalid-thread-start");
    }
    if (typeof event.thread_id === "string" && event.thread_id) state.threadIds.push(event.thread_id);
    return;
  }
  if (event.type === "turn.started") {
    if (state.threadIds.length !== 1 || state.turnOpen || state.terminalSeen) reason(state, "invalid-turn-start");
    state.turnStarted += 1;
    state.turnOpen = true;
    return;
  }
  if (event.type === "turn.failed") {
    state.turnFailed += 1;
    if (!state.turnOpen || !plainObject(event.error)) reason(state, "invalid-turn-failed");
    failure(state, "turn-failed");
    return;
  }
  if (event.type === "error") {
    if (state.threadIds.length !== 1 || !state.turnOpen || state.terminalSeen) reason(state, "invalid-top-level-error-position");
    failure(state, "top-level-error");
    return;
  }
  if (event.type === "turn.completed") {
    state.turnCompleted += 1;
    if (!state.turnOpen || state.turnCompleted !== 1) reason(state, "invalid-turn-completed");
    if (!plainObject(event.usage)) reason(state, "missing-or-invalid-terminal-usage");
    if (state.openItems.size > 0) reason(state, "open-item-at-turn-terminal");
    state.turnOpen = false;
    state.terminalSeen = true;
    return;
  }
  if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
    consumeItem(state, event);
    return;
  }
  if (!ALLOWED_AUXILIARY_EVENTS.has(event.type)) reason(state, "unsupported-event-type");
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function finishCodexLifecycle(state, { exactUsage, processExitCode } = {}) {
  if (state.threadIds.length !== 1 || new Set(state.threadIds).size !== 1) reason(state, "missing-or-conflicting-thread-id");
  if (state.turnStarted !== 1) reason(state, "missing-or-duplicate-turn-start");
  if (state.turnCompleted !== 1) reason(state, "missing-or-duplicate-turn-terminal");
  if (exactUsage !== true) reason(state, "missing-or-invalid-terminal-usage");
  if (Number.isInteger(processExitCode) && processExitCode !== 0) failure(state, "process-exit-nonzero");
  const violations = [...state.lifecycleViolations].sort();
  const signals = [...state.failureSignals].sort();
  const terminalAgentMessage = state.terminalResponseText.trim().length > 0;
  const continuedCommands = violations.length === 0 && processExitCode === 0 && terminalAgentMessage
    && state.pendingCommandFailures === 0;
  const terminalSignals = continuedCommands
    ? signals.filter(signal => !state.commandFailureSignals.has(signal)) : signals;
  let failureClass = null;
  if (violations.length > 0) {
    const terminalOnly = violations.every(item => ["missing-or-duplicate-turn-terminal", "missing-or-invalid-terminal-usage"].includes(item));
    failureClass = terminalOnly ? "unknown_terminal" : "harness_contract_failure";
  } else if (terminalSignals.length > 0) failureClass = "agent_tool_failure";
  else if (!terminalAgentMessage) failureClass = "agent_task_failure";
  const runValidity = violations.length > 0 ? "invalid_harness" : "valid";
  const providerStarted = state.turnStarted > 0;
  const summary = {
    schemaVersion: 2,
    source: "codex-exec-jsonl-redacted-event-summary",
    events: state.events,
    eventTypes: sortedObject(state.eventTypes),
    threadStartedEvents: state.threadIds.length,
    turns: { started: state.turnStarted, completed: state.turnCompleted, failed: state.turnFailed },
    items: {
      started: state.itemStarted,
      updated: state.itemUpdated,
      completed: state.itemCompleted,
      types: sortedObject(state.itemTypes),
      openAtTerminal: state.openItems.size
    },
    failureSignals: signals,
    terminalFailureSignals: terminalSignals,
    commandFailureEvents: state.commandFailureEvents,
    continuedCommandFailureEvents: state.continuedCommandFailureEvents,
    lifecycleViolations: violations,
    rawPayloadStored: false,
    promptsStored: false,
    reasoningStored: false,
    commandsStored: false,
    pathsStored: false,
    identifiersStored: false
  };
  return {
    summary,
    outcome: {
      schemaVersion: 1,
      source: "codex-exec-jsonl-authoritative-state-machine",
      terminalStatus: runValidity === "valid" ? failureClass ? "failed" : "completed" : "unknown",
      runValidity,
      failureClass,
      reasonCodes: violations.length > 0 ? violations : terminalSignals.length > 0 ? terminalSignals
        : !terminalAgentMessage ? ["missing-terminal-agent-message"] : [],
      terminalAgentMessage,
      countsTowardQuality: runValidity === "valid",
      countsTowardUsage: providerStarted,
      usageStatus: exactUsage === true ? "exact" : providerStarted ? "unknown_post_provider" : "zero_pre_provider"
    }
  };
}

export function isCodexToolItemType(value) {
  return TOOL_ITEM_TYPES.has(value);
}

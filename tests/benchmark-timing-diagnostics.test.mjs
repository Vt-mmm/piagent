import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createBenchmarkTimingCollector,
  createDeferredBenchmarkTimingCollector,
  summarizeBenchmarkTimingDiagnostics,
  validBenchmarkTimingDiagnostics
} from "../packages/piagent-core/benchmark/benchmark-timing-diagnostics.js";

function writeEvent(collector, event, observedAtSeconds) {
  collector.write(`${JSON.stringify(event)}\n`, observedAtSeconds);
}

function codexUsage(overrides = {}) {
  return {
    input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, ...overrides
  };
}

function codexTimedToolItem(type, status, overrides = {}) {
  const common = { id: `private-${type}`, type };
  if (type === "command_execution") {
    return { ...common, command: "private command", aggregated_output: "", exit_code: status === "in_progress" ? null : 0, status, ...overrides };
  }
  if (type === "mcp_tool_call") {
    return { ...common, server: "private-server", tool: "private-tool", arguments: {}, result: null, error: null, status, ...overrides };
  }
  if (type === "collab_tool_call") {
    return {
      ...common, tool: "wait", sender_thread_id: "private-sender", receiver_thread_ids: ["private-receiver"],
      prompt: null, agents_states: { "private-receiver": { status: "completed", message: null } }, status, ...overrides
    };
  }
  if (type === "web_search") return { ...common, query: "private query", action: { type: "other" }, ...overrides };
  throw new Error(`Unsupported test Codex tool item: ${type}`);
}

test("attributes the official Pi 0.84 JSON stdout lifecycle without retaining payloads", () => {
  const collector = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(collector, { type: "session", version: 3, id: "private-session", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" }, 0.1);
  writeEvent(collector, { type: "agent_start" }, 0.15);
  writeEvent(collector, { type: "queue_update", steering: ["private queued prompt"], followUp: [] }, 0.16);
  writeEvent(collector, { type: "turn_start" }, 0.2);
  writeEvent(collector, { type: "message_start", message: { role: "user", content: "private prompt" } }, 0.2);
  writeEvent(collector, { type: "message_end", message: { role: "user", content: "private prompt" } }, 0.2);
  writeEvent(collector, { type: "message_start", message: { role: "assistant", content: [] } }, 0.6);
  writeEvent(collector, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "private answer" } }, 0.65);
  writeEvent(collector, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "secret-id", name: "bash", arguments: { command: "private command" } }] } }, 0.7);
  writeEvent(collector, { type: "tool_execution_start", toolCallId: "secret-id", toolName: "bash", args: { command: "private command" } }, 0.7);
  writeEvent(collector, { type: "tool_execution_end", toolCallId: "secret-id", toolName: "bash", result: { content: "private path" }, isError: false }, 1.7);
  writeEvent(collector, { type: "message_start", message: { role: "toolResult", toolCallId: "secret-id", toolName: "bash", content: "private path" } }, 1.7);
  writeEvent(collector, { type: "message_end", message: { role: "toolResult", toolCallId: "secret-id", toolName: "bash", content: "private path" } }, 1.7);
  writeEvent(collector, { type: "turn_end", message: { role: "assistant" }, toolResults: [{ role: "toolResult", toolCallId: "secret-id", toolName: "bash" }] }, 1.8);
  writeEvent(collector, { type: "turn_start" }, 1.8);
  writeEvent(collector, { type: "message_start", message: { role: "assistant", content: [] } }, 2.2);
  writeEvent(collector, { type: "message_end", message: { role: "assistant", content: [] } }, 2.3);
  writeEvent(collector, { type: "turn_end", message: { role: "assistant" }, toolResults: [] }, 2.4);
  writeEvent(collector, { type: "agent_end", messages: [{ role: "assistant", content: "private answer" }], willRetry: false }, 2.5);
  writeEvent(collector, { type: "agent_settled" }, 2.55);
  const value = collector.finish(3);

  assert.equal(value.status, "complete");
  assert.equal(value.phases.processStartup.seconds, 0.2);
  assert.equal(value.phases.modelTurnWait.seconds, 1);
  assert.equal(value.phases.toolExecution.seconds, 1);
  assert.equal(value.phases.other.seconds, 0.8);
  assert.equal(value.gateImpact, "none");
  assert.deepEqual(value.privacy, {
    rawPayloadStored: false, promptsStored: false, commandsStored: false, pathsStored: false, identifiersStored: false
  });
  const serialized = JSON.stringify(value);
  for (const secret of ["private prompt", "private queued prompt", "private command", "/private/project", "private-session", "secret-id", "private answer"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(validBenchmarkTimingDiagnostics(value, "piagent", 3), true);
  const forged = structuredClone(value);
  forged.rawPrompt = "private prompt";
  assert.equal(validBenchmarkTimingDiagnostics(forged, "piagent", 3), false);
  delete forged.rawPrompt;
  forged.phases.processStartup.reason = "private command";
  assert.equal(validBenchmarkTimingDiagnostics(forged, "piagent", 3), false);
  const forgedWithoutLifecycle = structuredClone(value);
  for (const key of Object.keys(forgedWithoutLifecycle.observations)) forgedWithoutLifecycle.observations[key] = 0;
  assert.equal(validBenchmarkTimingDiagnostics(forgedWithoutLifecycle, "piagent", 3), false);
  const forgedStartupWithoutAgent = structuredClone(value);
  forgedStartupWithoutAgent.status = "partial";
  Object.assign(forgedStartupWithoutAgent.observations, { agentStarts: 0, agentEnds: 0, agentSettled: 0 });
  Object.assign(forgedStartupWithoutAgent.phases.modelTurnWait, {
    status: "unavailable", seconds: null, reason: "incomplete-model-turn-boundaries"
  });
  Object.assign(forgedStartupWithoutAgent.phases.toolExecution, {
    status: "unavailable", seconds: null, reason: "incomplete-tool-boundaries"
  });
  Object.assign(forgedStartupWithoutAgent.phases.other, {
    status: "unavailable", seconds: null, reason: "one-or-more-phase-boundaries-unavailable"
  });
  assert.equal(validBenchmarkTimingDiagnostics(forgedStartupWithoutAgent, "piagent", 3), false);
});

test("attributes observed Codex lifecycle gaps with the same phase contract", () => {
  const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(collector, { type: "thread.started", thread_id: "private-thread" }, 0.1);
  writeEvent(collector, { type: "turn.started" }, 0.2);
  writeEvent(collector, { type: "item.completed", item: { id: "private-reasoning", type: "reasoning", text: "private chain" } }, 0.5);
  writeEvent(collector, { type: "item.started", item: codexTimedToolItem("command_execution", "in_progress", { id: "private-tool" }) }, 0.9);
  writeEvent(collector, { type: "item.completed", item: codexTimedToolItem("command_execution", "completed", { id: "private-tool", aggregated_output: "private output" }) }, 1.9);
  writeEvent(collector, { type: "item.completed", item: { id: "message", type: "agent_message", text: "private answer" } }, 2.4);
  writeEvent(collector, { type: "turn.completed", usage: codexUsage() }, 2.5);
  const value = collector.finish(3);

  assert.equal(value.status, "complete");
  assert.equal(value.phases.processStartup.seconds, 0.2);
  assert.equal(value.phases.modelTurnWait.seconds, 1.3);
  assert.equal(value.phases.toolExecution.seconds, 1);
  assert.equal(value.phases.other.seconds, 0.5);
  assert.equal(validBenchmarkTimingDiagnostics(value, "codex-cli", 3), true);
  const serialized = JSON.stringify(value);
  for (const secret of ["private-thread", "private-reasoning", "private chain", "private-tool", "private output", "private answer"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("uses the last matched parallel tool result as the next model-turn-ready boundary", () => {
  const collector = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(collector, { type: "session", version: 3, id: "parallel-session", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" }, 0.04);
  writeEvent(collector, { type: "agent_start" }, 0.05);
  writeEvent(collector, { type: "turn_start" }, 0.1);
  writeEvent(collector, { type: "message_start", message: { role: "user" } }, 0.1);
  writeEvent(collector, { type: "message_end", message: { role: "user" } }, 0.1);
  writeEvent(collector, { type: "message_start", message: { role: "assistant" } }, 0.5);
  writeEvent(collector, { type: "message_end", message: { role: "assistant" } }, 0.5);
  writeEvent(collector, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} }, 0.5);
  writeEvent(collector, { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: {} }, 0.5);
  writeEvent(collector, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: {}, isError: false }, 1);
  writeEvent(collector, { type: "tool_execution_end", toolCallId: "b", toolName: "read", result: {}, isError: false }, 1.5);
  writeEvent(collector, { type: "message_start", message: { role: "toolResult", toolCallId: "a", toolName: "read" } }, 1.5);
  writeEvent(collector, { type: "message_end", message: { role: "toolResult", toolCallId: "a", toolName: "read" } }, 1.5);
  writeEvent(collector, { type: "message_start", message: { role: "toolResult", toolCallId: "b", toolName: "read" } }, 1.5);
  writeEvent(collector, { type: "message_end", message: { role: "toolResult", toolCallId: "b", toolName: "read" } }, 1.5);
  writeEvent(collector, { type: "turn_end", message: { role: "assistant" }, toolResults: [
    { role: "toolResult", toolCallId: "a", toolName: "read" }, { role: "toolResult", toolCallId: "b", toolName: "read" }
  ] }, 1.6);
  writeEvent(collector, { type: "turn_start" }, 1.6);
  writeEvent(collector, { type: "message_start", message: { role: "assistant" } }, 2);
  writeEvent(collector, { type: "message_end", message: { role: "assistant" } }, 2);
  writeEvent(collector, { type: "turn_end", message: { role: "assistant" }, toolResults: [] }, 2.1);
  writeEvent(collector, { type: "agent_end", messages: [], willRetry: false }, 2.2);
  writeEvent(collector, { type: "agent_settled" }, 2.3);
  const value = collector.finish(2.5);
  assert.equal(value.status, "complete");
  assert.equal(value.phases.modelTurnWait.seconds, 0.8);
  assert.equal(value.phases.toolExecution.seconds, 1);
  assert.equal(value.phases.other.seconds, 0.6);
});

test("fails closed instead of estimating coalesced, unmatched, or malformed boundaries", () => {
  const collector = createBenchmarkTimingCollector({ surface: "piagent" });
  collector.write([
    { type: "session", version: 3, id: "ambiguous-pi", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: "prompt" } },
    { type: "message_end", message: { role: "user", content: "prompt" } },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "different", toolName: "read", result: {}, isError: false }
  ].map(JSON.stringify).join("\n") + "\n", 0.5);
  const value = collector.finish(1);
  assert.equal(value.status, "partial");
  assert.equal(value.phases.processStartup.status, "available");
  assert.equal(value.phases.modelTurnWait.status, "unavailable");
  assert.equal(value.phases.toolExecution.status, "unavailable");
  assert.equal(value.phases.other.status, "unavailable");
  assert.ok(value.observations.coalescedBoundaries > 0);
  assert.ok(value.observations.unmatchedToolStarts > 0);
  assert.ok(value.observations.unmatchedToolCompletions > 0);

  const malformed = createBenchmarkTimingCollector({ surface: "codex-cli" });
  malformed.write("not-json\n", 0.1);
  assert.equal(malformed.finish(1).status, "unavailable");

  const empty = createBenchmarkTimingCollector({ surface: "piagent" }).finish(1);
  assert.equal(empty.status, "unavailable", "absence of lifecycle evidence cannot prove zero tool or model-turn time");
});

test("fails closed for recognized malformed wire events and receipt timestamps beyond process duration", () => {
  const malformedPi = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(malformedPi, { type: "turn_start" }, 0.1);
  writeEvent(malformedPi, { type: "message_start", message: null }, 0.2);
  assert.equal(malformedPi.finish(1).status, "unavailable");

  const malformedCodex = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(malformedCodex, { type: "turn.started" }, 0.1);
  writeEvent(malformedCodex, { type: "item.started", item: null }, 0.2);
  writeEvent(malformedCodex, { type: "turn.completed", usage: codexUsage() }, 0.3);
  const malformedCodexValue = malformedCodex.finish(1);
  assert.equal(malformedCodexValue.status, "unavailable");
  assert.ok(malformedCodexValue.observations.malformedLines > 0);

  const impossibleClock = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(impossibleClock, { type: "thread.started", thread_id: "clock-thread" }, 2.05);
  writeEvent(impossibleClock, { type: "turn.started" }, 2.1);
  writeEvent(impossibleClock, { type: "turn.completed", usage: codexUsage() }, 2.2);
  const impossibleClockValue = impossibleClock.finish(2);
  assert.equal(impossibleClockValue.status, "unavailable");
  assert.ok(impossibleClockValue.observations.invalidClockBoundaries > 0);
  assert.equal(validBenchmarkTimingDiagnostics(impossibleClockValue, "codex-cli", 2), true);

  const unknownPi = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(unknownPi, { type: "future_private_event", payload: "private" }, 0.1);
  assert.equal(unknownPi.finish(1).status, "unavailable");

  const unknownCodex = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(unknownCodex, { type: "future.private.event", payload: "private" }, 0.1);
  assert.equal(unknownCodex.finish(1).status, "unavailable");

  for (const appServerOnlyType of ["plan", "user_message"]) {
    const appServerOnly = createBenchmarkTimingCollector({ surface: "codex-cli" });
    writeEvent(appServerOnly, { type: "thread.started", thread_id: "private-thread" }, 0.05);
    writeEvent(appServerOnly, { type: "turn.started" }, 0.1);
    writeEvent(appServerOnly, { type: "item.completed", item: { id: "private-item", type: appServerOnlyType } }, 0.2);
    writeEvent(appServerOnly, { type: "turn.completed", usage: codexUsage() }, 0.3);
    const appServerOnlyValue = appServerOnly.finish(1);
    assert.equal(appServerOnlyValue.status, "unavailable", `${appServerOnlyType} is not a Codex exec --json item`);
    assert.ok(appServerOnlyValue.observations.malformedLines > 0);
  }
});

test("summarizes timing as observational evidence without creating a gate", () => {
  const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(collector, { type: "thread.started", thread_id: "summary-thread" }, 0.05);
  writeEvent(collector, { type: "turn.started" }, 0.1);
  writeEvent(collector, { type: "turn.completed", usage: codexUsage() }, 0.8);
  const timingDiagnostics = collector.finish(1);
  const summary = summarizeBenchmarkTimingDiagnostics([
    { surface: "codex-cli", durationSeconds: 1, timingDiagnostics },
    { surface: "codex-cli", durationSeconds: 1, timingDiagnostics: { rawPayload: "private prompt and command" } },
    { surface: "piagent", durationSeconds: 1 }
  ]);
  assert.equal(summary.gateImpact, "none");
  assert.equal(summary.surfaces["codex-cli"].validDiagnostics, 1);
  assert.equal(summary.surfaces["codex-cli"].completeDiagnostics, 1);
  assert.equal(summary.surfaces["codex-cli"].phases.processStartup.unavailableRuns, 1);
  assert.equal(summary.surfaces["codex-cli"].phases.processStartup.medianSeconds, 0.1);
  assert.equal(summary.surfaces.piagent.validDiagnostics, 0);
  assert.equal(summary.surfaces.piagent.phases.processStartup.unavailableRuns, 1);
  assert.equal(JSON.stringify(summary).includes("private prompt and command"), false);
});

test("rejects forged canonical timing that cannot be emitted by the collectors", () => {
  const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(collector, { type: "thread.started", thread_id: "private-thread" }, 0.05);
  writeEvent(collector, { type: "turn.started" }, 0.1);
  writeEvent(collector, { type: "turn.completed", usage: codexUsage() }, 0.8);
  const complete = collector.finish(1);
  assert.equal(validBenchmarkTimingDiagnostics(complete, "codex-cli", 1), true);

  const missingHeader = structuredClone(complete);
  missingHeader.status = "partial";
  missingHeader.observations.threadStarts = 0;
  Object.assign(missingHeader.phases.processStartup, { status: "unavailable", seconds: null, reason: "missing-turn-start-boundary" });
  Object.assign(missingHeader.phases.other, { status: "unavailable", seconds: null, reason: "one-or-more-phase-boundaries-unavailable" });
  assert.equal(validBenchmarkTimingDiagnostics(missingHeader, "codex-cli", 1), false);

  const extraModelBoundary = structuredClone(complete);
  extraModelBoundary.observations.matchedModelTurnIntervals = 2;
  assert.equal(validBenchmarkTimingDiagnostics(extraModelBoundary, "codex-cli", 1), false);

  const multipleExecTurns = structuredClone(complete);
  Object.assign(multipleExecTurns.observations, { jsonEvents: 5, turnStarts: 2, turnCompletions: 2, matchedModelTurnIntervals: 2 });
  assert.equal(validBenchmarkTimingDiagnostics(multipleExecTurns, "codex-cli", 1), false);

  const remainderWithoutAllAttribution = structuredClone(complete);
  remainderWithoutAllAttribution.status = "partial";
  Object.assign(remainderWithoutAllAttribution.phases.modelTurnWait, {
    status: "unavailable", seconds: null, reason: "incomplete-model-turn-boundaries"
  });
  remainderWithoutAllAttribution.phases.other.seconds += complete.phases.modelTurnWait.seconds;
  assert.equal(validBenchmarkTimingDiagnostics(remainderWithoutAllAttribution, "codex-cli", 1), false);

  const missingExactRemainder = structuredClone(complete);
  missingExactRemainder.status = "partial";
  Object.assign(missingExactRemainder.phases.other, {
    status: "unavailable", seconds: null, reason: "one-or-more-phase-boundaries-unavailable"
  });
  assert.equal(validBenchmarkTimingDiagnostics(missingExactRemainder, "codex-cli", 1), false);

  const invalidClockWithAvailablePhase = structuredClone(missingHeader);
  invalidClockWithAvailablePhase.observations.invalidClockBoundaries = 1;
  assert.equal(validBenchmarkTimingDiagnostics(invalidClockWithAvailablePhase, "codex-cli", 1), false);
});

test("times only explicit Codex 0.149 start-and-complete tool items", () => {
  const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(collector, { type: "thread.started", thread_id: "private-thread" }, 0.05);
  writeEvent(collector, { type: "turn.started" }, 0.1);
  const tools = ["command_execution", "mcp_tool_call", "collab_tool_call", "web_search"];
  let at = 0.3;
  for (const [index, type] of tools.entries()) {
    const startedStatus = type === "web_search" ? undefined : "in_progress";
    const completedStatus = type === "web_search" ? undefined : "completed";
    writeEvent(collector, { type: "item.started", item: codexTimedToolItem(type, startedStatus, { id: `private-tool-${index}` }) }, at);
    at += 0.1;
    writeEvent(collector, { type: "item.completed", item: codexTimedToolItem(type, completedStatus, { id: `private-tool-${index}` }) }, at);
    at += 0.1;
  }
  writeEvent(collector, { type: "item.started", item: { id: "private-todo", type: "todo_list", items: [] } }, 1.1);
  writeEvent(collector, { type: "item.updated", item: { id: "private-todo", type: "todo_list", items: [] } }, 1.15);
  writeEvent(collector, { type: "item.completed", item: { id: "private-todo", type: "todo_list", items: [] } }, 1.2);
  writeEvent(collector, { type: "item.completed", item: { id: "private-error", type: "error", message: "private error" } }, 1.25);
  writeEvent(collector, { type: "item.completed", item: { id: "private-message", type: "agent_message", text: "private answer" } }, 1.4);
  writeEvent(collector, { type: "turn.completed", usage: codexUsage() }, 1.5);
  const value = collector.finish(2);

  assert.equal(value.status, "complete");
  assert.equal(value.observations.toolStarts, 4);
  assert.equal(value.observations.toolCompletions, 4);
  assert.equal(value.observations.matchedToolIntervals, 4);
  assert.equal(value.phases.modelTurnWait.seconds, 1);
  assert.equal(value.phases.toolExecution.seconds, 0.4);
  assert.equal(JSON.stringify(value).includes("private"), false);
});

test("rejects impossible Codex exec item transitions and tool statuses", () => {
  const runMalformed = (events) => {
    const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
    writeEvent(collector, { type: "thread.started", thread_id: "private-thread" }, 0.01);
    writeEvent(collector, { type: "turn.started" }, 0.02);
    events.forEach((event, index) => writeEvent(collector, event, 0.1 + (index * 0.1)));
    writeEvent(collector, { type: "turn.completed", usage: codexUsage() }, 0.9);
    return collector.finish(1);
  };

  for (const type of ["agent_message", "reasoning"]) {
    const value = runMalformed([{ type: "item.started", item: { id: "private-output", type, text: "private text" } }]);
    assert.equal(value.status, "unavailable", `${type} has no item.started event in Codex exec JSONL`);
    assert.ok(value.observations.malformedLines > 0);
  }

  const nonTodoUpdates = [
    { id: "private-output", type: "agent_message", text: "private text" },
    codexTimedToolItem("command_execution", "in_progress"),
    codexTimedToolItem("web_search", undefined)
  ];
  for (const item of nonTodoUpdates) {
    const value = runMalformed([{ type: "item.updated", item }]);
    assert.equal(value.status, "unavailable", `item.updated is impossible for ${item.type}`);
    assert.ok(value.observations.malformedLines > 0);
  }

  const orphanTodoUpdate = runMalformed([
    { type: "item.updated", item: { id: "private-todo", type: "todo_list", items: [] } }
  ]);
  assert.equal(orphanTodoUpdate.status, "unavailable", "todo updates require a matching started item");

  for (const type of ["command_execution", "mcp_tool_call", "collab_tool_call"]) {
    const terminalStart = runMalformed([
      { type: "item.started", item: codexTimedToolItem(type, "completed") }
    ]);
    assert.equal(terminalStart.status, "unavailable", `${type} starts must be in_progress`);

    const nonterminalCompletion = runMalformed([
      { type: "item.started", item: codexTimedToolItem(type, "in_progress") },
      { type: "item.completed", item: codexTimedToolItem(type, "in_progress") }
    ]);
    assert.equal(nonterminalCompletion.status, "unavailable", `${type} completions must be terminal`);
  }

  const mismatchedType = runMalformed([
    { type: "item.started", item: codexTimedToolItem("command_execution", "in_progress", { id: "private-shared" }) },
    { type: "item.completed", item: codexTimedToolItem("mcp_tool_call", "completed", { id: "private-shared" }) }
  ]);
  assert.equal(mismatchedType.status, "unavailable", "tool completion type must match its start");
  assert.ok(mismatchedType.observations.malformedLines > 0);
});

test("accepts documented minimal Codex timed-tool starts and usage", () => {
  const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(collector, { type: "thread.started", thread_id: "private-thread" }, 0.01);
  writeEvent(collector, { type: "turn.started" }, 0.02);
  const pairs = [
    [
      { id: "command", type: "command_execution", command: "private command", status: "in_progress" },
      codexTimedToolItem("command_execution", "completed", { id: "command" })
    ],
    [
      { id: "mcp", type: "mcp_tool_call", server: "private-server", tool: "private-tool", status: "in_progress" },
      codexTimedToolItem("mcp_tool_call", "completed", { id: "mcp" })
    ],
    [
      { id: "collab", type: "collab_tool_call", tool: "wait", sender_thread_id: "sender", receiver_thread_ids: [], status: "in_progress" },
      codexTimedToolItem("collab_tool_call", "completed", { id: "collab" })
    ],
    [
      { id: "web", type: "web_search" },
      codexTimedToolItem("web_search", undefined, { id: "web" })
    ]
  ];
  let at = 0.1;
  for (const [started, completed] of pairs) {
    writeEvent(collector, { type: "item.started", item: started }, at);
    writeEvent(collector, { type: "item.completed", item: completed }, at + 0.05);
    at += 0.1;
  }
  writeEvent(collector, { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } }, 0.6);
  const documentedUsage = codexUsage();
  delete documentedUsage.cache_write_input_tokens;
  writeEvent(collector, { type: "turn.completed", usage: documentedUsage }, 0.7);
  const value = collector.finish(1);
  assert.equal(value.status, "complete");
  assert.equal(value.observations.matchedToolIntervals, 4);
  assert.equal(validBenchmarkTimingDiagnostics(value, "codex-cli", 1), true);
});

test("fails Codex diagnostics closed for terminal, usage, payload, and global item-ID violations", () => {
  const run = (events, { terminal = true } = {}) => {
    const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
    writeEvent(collector, { type: "thread.started", thread_id: "private-thread" }, 0.01);
    writeEvent(collector, { type: "turn.started" }, 0.02);
    events.forEach((event, index) => writeEvent(collector, event, 0.1 + index * 0.05));
    if (terminal) writeEvent(collector, { type: "turn.completed", usage: codexUsage() }, 0.8);
    return collector.finish(1);
  };
  const malformedCases = [
    [{ type: "item.completed", item: { id: "blank", type: "reasoning", text: "   " } }],
    [{ type: "item.completed", item: { id: "web", type: "web_search", query: "q", action: { type: "invalid" } } }],
    [{ type: "item.completed", item: codexTimedToolItem("mcp_tool_call", "completed", {
      id: "mcp", result: { content: "not-an-array", structured_content: null }
    }) }],
    [{ type: "item.completed", item: codexTimedToolItem("collab_tool_call", "completed", {
      id: "collab", agents_states: { receiver: { status: "unknown", message: null } }
    }) }],
    [
      { type: "item.completed", item: { id: "reused", type: "agent_message", text: "one" } },
      { type: "item.completed", item: { id: "reused", type: "error", message: "two" } }
    ]
  ];
  for (const events of malformedCases) {
    const value = run(events);
    assert.equal(value.status, "unavailable");
    assert.ok(value.observations.malformedLines > 0);
  }

  const invalidUsage = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(invalidUsage, { type: "thread.started", thread_id: "private-thread" }, 0.01);
  writeEvent(invalidUsage, { type: "turn.started" }, 0.02);
  writeEvent(invalidUsage, { type: "turn.completed", usage: codexUsage({ output_tokens: -1 }) }, 0.1);
  assert.equal(invalidUsage.finish(1).status, "unavailable");

  const afterTerminal = run([{ type: "turn.completed", usage: codexUsage() }], { terminal: false });
  assert.equal(afterTerminal.status, "complete");
  const poisonedAfterTerminal = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(poisonedAfterTerminal, { type: "thread.started", thread_id: "private-thread" }, 0.01);
  writeEvent(poisonedAfterTerminal, { type: "turn.started" }, 0.02);
  writeEvent(poisonedAfterTerminal, { type: "turn.completed", usage: codexUsage() }, 0.1);
  writeEvent(poisonedAfterTerminal, { type: "item.completed", item: { id: "late", type: "error", message: "late" } }, 0.2);
  assert.equal(poisonedAfterTerminal.finish(1).status, "unavailable");
});

test("treats exact Codex stream errors and unstarted timed completions as unavailable", () => {
  const providerError = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(providerError, { type: "thread.started", thread_id: "private-thread" }, 0.01);
  writeEvent(providerError, { type: "turn.started" }, 0.02);
  writeEvent(providerError, { type: "error", message: "private provider error" }, 0.1);
  writeEvent(providerError, { type: "turn.completed", usage: codexUsage() }, 0.2);
  const providerErrorValue = providerError.finish(1);
  assert.equal(providerErrorValue.status, "unavailable");
  assert.equal(providerErrorValue.observations.malformedLines, 0);
  assert.equal(validBenchmarkTimingDiagnostics(providerErrorValue, "codex-cli", 1), true);
  assert.equal(JSON.stringify(providerErrorValue).includes("private provider error"), false);

  const nestedError = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(nestedError, { type: "thread.started", thread_id: "private-thread" }, 0.01);
  writeEvent(nestedError, { type: "turn.started" }, 0.02);
  writeEvent(nestedError, { type: "error", error: { message: "non-wire shape" } }, 0.1);
  const nestedErrorValue = nestedError.finish(1);
  assert.equal(nestedErrorValue.status, "unavailable");
  assert.ok(nestedErrorValue.observations.malformedLines > 0);

  const unstarted = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(unstarted, { type: "thread.started", thread_id: "private-thread" }, 0.01);
  writeEvent(unstarted, { type: "turn.started" }, 0.02);
  writeEvent(unstarted, { type: "item.completed", item: codexTimedToolItem("command_execution", "completed", { id: "unstarted" }) }, 0.4);
  writeEvent(unstarted, { type: "turn.completed", usage: codexUsage() }, 0.8);
  const unstartedValue = unstarted.finish(1);
  assert.equal(unstartedValue.observations.malformedLines, 0, "completion-only timed tools are valid but unobservable");
  assert.equal(unstartedValue.phases.processStartup.status, "available");
  assert.equal(unstartedValue.phases.modelTurnWait.status, "unavailable");
  assert.equal(unstartedValue.phases.toolExecution.status, "unavailable");
});

test("reconciles Pi tool identities across execution, result messages, and turn receipts", () => {
  const run = ({ endName = "read", messageId = "call", receiptId = "call" } = {}) => {
    const collector = createBenchmarkTimingCollector({ surface: "piagent" });
    const events = [
      { type: "session", version: 3, id: "private-session", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private" },
      { type: "agent_start" }, { type: "turn_start" },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: { role: "assistant" } },
      { type: "tool_execution_start", toolCallId: "call", toolName: "read", args: {} },
      { type: "tool_execution_end", toolCallId: "call", toolName: endName, result: {}, isError: false },
      { type: "message_start", message: { role: "toolResult", toolCallId: messageId, toolName: endName } },
      { type: "message_end", message: { role: "toolResult", toolCallId: messageId, toolName: endName } },
      { type: "turn_end", message: { role: "assistant" }, toolResults: [{ role: "toolResult", toolCallId: receiptId, toolName: endName }] },
      { type: "agent_end", messages: [], willRetry: false }, { type: "agent_settled" }
    ];
    events.forEach((event, index) => writeEvent(collector, event, 0.01 + index * 0.05));
    return collector.finish(1);
  };
  for (const forged of [{ endName: "write" }, { messageId: "private-forged-id" }, { receiptId: "private-forged-id" }]) {
    const value = run(forged);
    assert.equal(value.status, "unavailable");
    assert.ok(value.observations.malformedLines > 0);
    assert.equal(JSON.stringify(value).includes("private-forged-id"), false);
  }
});

test("accepts Piagent custom follow-up messages as exact next-turn input boundaries", () => {
  const collector = createBenchmarkTimingCollector({ surface: "piagent" });
  const custom = {
    role: "custom", customType: "piagent-completion-recovery", content: "private recovery prompt",
    display: false, details: { private: true }, timestamp: 1_777_000_000_000
  };
  const events = [
    { type: "session", version: 3, id: "private-session", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private" },
    { type: "agent_start" },
    { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
    { type: "turn_start" }, { type: "message_start", message: custom }, { type: "message_end", message: custom },
    { type: "message_start", message: { role: "assistant" } }, { type: "message_end", message: { role: "assistant" } },
    { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
    { type: "agent_end", messages: [], willRetry: false }, { type: "agent_settled" }
  ];
  events.forEach((event, index) => writeEvent(collector, event, 0.01 + index * 0.05));
  const value = collector.finish(1);
  assert.equal(value.status, "complete");
  assert.equal(value.observations.matchedModelTurnIntervals, 2);
  assert.equal(JSON.stringify(value).includes("private recovery prompt"), false);

  const unknown = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(unknown, events[0], 0.01);
  writeEvent(unknown, events[1], 0.02);
  writeEvent(unknown, { type: "turn_start" }, 0.03);
  writeEvent(unknown, { type: "message_start", message: { role: "unknown" } }, 0.04);
  assert.equal(unknown.finish(1).status, "unavailable");
});

test("fails affected Codex phases closed for completed-only file changes", () => {
  const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(collector, { type: "thread.started", thread_id: "file-change-thread" }, 0.05);
  writeEvent(collector, { type: "turn.started" }, 0.1);
  writeEvent(collector, { type: "item.completed", item: { id: "private-change", type: "file_change", changes: [], status: "completed" } }, 0.5);
  writeEvent(collector, { type: "item.completed", item: { id: "private-message", type: "agent_message", text: "done" } }, 0.8);
  writeEvent(collector, { type: "turn.completed", usage: codexUsage() }, 0.9);
  const value = collector.finish(1);

  assert.equal(value.status, "partial");
  assert.equal(value.phases.processStartup.status, "available");
  assert.equal(value.phases.modelTurnWait.status, "unavailable");
  assert.equal(value.phases.toolExecution.status, "unavailable");
  assert.equal(value.observations.unmatchedToolCompletions, 1);
  assert.equal(validBenchmarkTimingDiagnostics(value, "codex-cli", 1), true);
});

test("requires terminal provider lifecycles before timing can be complete", () => {
  const pi = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(pi, { type: "session", version: 3, id: "unterminated-pi", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" }, 0.04);
  writeEvent(pi, { type: "agent_start" }, 0.05);
  writeEvent(pi, { type: "turn_start" }, 0.1);
  writeEvent(pi, { type: "message_start", message: { role: "assistant" } }, 0.4);
  writeEvent(pi, { type: "message_end", message: { role: "assistant" } }, 0.5);
  writeEvent(pi, { type: "turn_end", message: { role: "assistant" }, toolResults: [] }, 0.6);
  writeEvent(pi, { type: "agent_end", messages: [], willRetry: false }, 0.7);
  assert.notEqual(pi.finish(1).status, "complete", "Pi agent_settled is mandatory after agent_end");

  const codex = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(codex, { type: "thread.started", thread_id: "unterminated-thread" }, 0.05);
  writeEvent(codex, { type: "turn.started" }, 0.1);
  writeEvent(codex, { type: "item.completed", item: { id: "message", type: "agent_message", text: "private answer" } }, 0.5);
  assert.notEqual(codex.finish(1).status, "complete", "a terminal Codex turn event is mandatory");

  const missingThread = createBenchmarkTimingCollector({ surface: "codex-cli" });
  writeEvent(missingThread, { type: "turn.started" }, 0.1);
  writeEvent(missingThread, { type: "turn.completed", usage: codexUsage() }, 0.5);
  assert.equal(missingThread.finish(1).status, "unavailable", "Codex thread.started is mandatory");

  const retryingPi = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(retryingPi, { type: "session", version: 3, id: "retrying-pi", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" }, 0.04);
  writeEvent(retryingPi, { type: "agent_start" }, 0.05);
  writeEvent(retryingPi, { type: "turn_start" }, 0.1);
  writeEvent(retryingPi, { type: "message_start", message: { role: "assistant" } }, 0.4);
  writeEvent(retryingPi, { type: "message_end", message: { role: "assistant" } }, 0.5);
  writeEvent(retryingPi, { type: "turn_end", message: { role: "assistant" }, toolResults: [] }, 0.6);
  writeEvent(retryingPi, { type: "agent_end", messages: [], willRetry: true }, 0.7);
  const retryingValue = retryingPi.finish(1);
  assert.notEqual(retryingValue.status, "complete", "retrying Pi agent_end is not a terminal boundary");
  assert.equal(retryingValue.phases.modelTurnWait.status, "unavailable");

  const outOfOrderPi = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(outOfOrderPi, { type: "session", version: 3, id: "out-of-order-pi", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" }, 0.04);
  writeEvent(outOfOrderPi, { type: "agent_start" }, 0.05);
  writeEvent(outOfOrderPi, { type: "agent_settled" }, 0.06);
  assert.equal(outOfOrderPi.finish(1).status, "unavailable", "agent_settled cannot precede agent_end");

  const duplicateSettledPi = createBenchmarkTimingCollector({ surface: "piagent" });
  const lifecycle = [
    { type: "session", version: 3, id: "duplicate-settled-pi", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
    { type: "agent_settled" }
  ];
  lifecycle.forEach((event, index) => writeEvent(duplicateSettledPi, event, 0.05 + (index * 0.1)));
  assert.equal(duplicateSettledPi.finish(1).status, "unavailable", "agent_settled must occur exactly once");

  const eventAfterSettledPi = createBenchmarkTimingCollector({ surface: "piagent" });
  lifecycle.slice(0, -1).forEach((event, index) => writeEvent(eventAfterSettledPi, event, 0.05 + (index * 0.1)));
  writeEvent(eventAfterSettledPi, { type: "queue_update", steering: [], followUp: [] }, 0.9);
  assert.equal(eventAfterSettledPi.finish(1).status, "unavailable", "agent_settled must be the final Pi event");

  const continuedPi = createBenchmarkTimingCollector({ surface: "piagent" });
  const continuedLifecycle = [
    { type: "session", version: 3, id: "continued-pi", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
    { type: "agent_end", messages: [], willRetry: true },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: "private retry reason" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" }
  ];
  continuedLifecycle.forEach((event, index) => writeEvent(continuedPi, event, 0.02 + (index * 0.05)));
  const continuedValue = continuedPi.finish(1);
  assert.equal(continuedValue.status, "complete", "only the final agent_end must be terminal");
  assert.equal(continuedValue.observations.agentStarts, 2);
  assert.equal(continuedValue.observations.agentEnds, 2);
  assert.equal(validBenchmarkTimingDiagnostics(continuedValue, "piagent", 1), true);
});

test("rejects Pi turn receipts that do not reconcile with observed tool lifecycle counts", () => {
  const collector = createBenchmarkTimingCollector({ surface: "piagent" });
  writeEvent(collector, { type: "session", version: 3, id: "mismatch-pi", timestamp: "2026-08-23T00:00:00.000Z", cwd: "/private/project" }, 0.04);
  writeEvent(collector, { type: "agent_start" }, 0.05);
  writeEvent(collector, { type: "turn_start" }, 0.1);
  writeEvent(collector, { type: "message_start", message: { role: "assistant" } }, 0.3);
  writeEvent(collector, { type: "message_end", message: { role: "assistant" } }, 0.4);
  writeEvent(collector, { type: "tool_execution_start", toolCallId: "private-tool", toolName: "read", args: {} }, 0.5);
  writeEvent(collector, { type: "tool_execution_end", toolCallId: "private-tool", toolName: "read", result: {}, isError: false }, 0.6);
  writeEvent(collector, { type: "turn_end", message: { role: "assistant" }, toolResults: [] }, 0.7);
  writeEvent(collector, { type: "agent_end", messages: [], willRetry: false }, 0.8);
  const value = collector.finish(1);
  assert.equal(value.status, "unavailable");
  assert.ok(value.observations.malformedLines > 0);
});

test("defers bounded timing parsing until authoritative process duration is available", () => {
  let collectorConstructions = 0;
  let writes = 0;
  let finishedWith = null;
  const deferred = createDeferredBenchmarkTimingCollector({
    surface: "piagent",
    maximumBytes: 1_024,
    collectorFactory({ surface }) {
      collectorConstructions += 1;
      assert.equal(surface, "piagent");
      return {
        write(chunk, observedAtSeconds) {
          writes += 1;
          assert.equal(Buffer.from(chunk).toString("utf8"), "{\"type\":\"agent_start\"}\n");
          assert.equal(observedAtSeconds, 0.1);
        },
        finish(durationSeconds) {
          finishedWith = durationSeconds;
          return { durationSeconds };
        }
      };
    }
  });
  deferred.write(Buffer.from('{"type":"agent_start"}\n'), 0.1);
  assert.equal(collectorConstructions, 0);
  assert.equal(writes, 0);
  assert.deepEqual(deferred.finish(1.25), { durationSeconds: 1.25 });
  assert.equal(collectorConstructions, 1);
  assert.equal(writes, 1);
  assert.equal(finishedWith, 1.25);

  let discardParses = 0;
  const discarded = createDeferredBenchmarkTimingCollector({
    surface: "piagent",
    collectorFactory() {
      discardParses += 1;
      throw new Error("discard must not construct the parser");
    }
  });
  discarded.write("private transient stdout", 0.1);
  assert.doesNotThrow(() => discarded.discard());
  assert.doesNotThrow(() => discarded.discard());
  assert.equal(discardParses, 0);
  assert.throws(() => discarded.write("late", 0.2), /already finished/);
  assert.throws(() => discarded.finish(1), /already finished/);

  const overflow = createDeferredBenchmarkTimingCollector({ surface: "piagent", maximumBytes: 8 });
  overflow.write("private-prompt-and-command", 0.1);
  const overflowValue = overflow.finish(1);
  assert.equal(overflowValue.status, "unavailable");
  assert.equal(JSON.stringify(overflowValue).includes("private-prompt-and-command"), false);

  const throwing = createDeferredBenchmarkTimingCollector({
    surface: "codex-cli",
    collectorFactory() {
      return {
        write() { throw new Error("private parser failure"); },
        finish() { throw new Error("private finish failure"); }
      };
    }
  });
  throwing.write('{"type":"thread.started","thread_id":"private"}\n', 0.1);
  const throwingValue = throwing.finish(1);
  assert.equal(throwingValue.status, "unavailable");
  assert.equal(validBenchmarkTimingDiagnostics(throwingValue, "codex-cli", 1), true);
  assert.equal(JSON.stringify(throwingValue).includes("private"), false);
});

test("session wiring clears deferred stdout on command rejection and before later parsers", () => {
  const source = fs.readFileSync(new URL("../scripts/benchmark-session.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const timingCollector = createDeferredBenchmarkTimingCollector");
  const end = source.indexOf("const piTerminalError", start);
  assert.ok(start >= 0 && end > start);
  const wiring = source.slice(start, end);
  assert.match(wiring, /catch \(error\) \{\s*timingCollector\.discard\(\);\s*throw error;\s*\}/);
  const finish = wiring.indexOf("timingCollector.finish(agent.durationSeconds)");
  assert.ok(finish > wiring.indexOf("await runCommand"));
  assert.ok(finish < wiring.indexOf("walkJsonl(sessions)"));
  assert.ok(finish < wiring.indexOf("codexCollector.finish()"));
});

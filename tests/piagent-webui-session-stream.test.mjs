import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RuntimeEventStore } from "../packages/piagent-core/runtime/inspection/runtime-event-store.ts";
import { webUiProjectRef, webUiSessionRef } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import webUiExtension from "../packages/piagent-webui/extension/piagent-webui.ts";
import { PiSessionStreamAdapter } from "../packages/piagent-webui/extension/session-stream-adapter.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.stream", runtimeInstanceId: "runtime.stream", sessionRef: "session.stream", taskId: null,
  taskRunId: null, agentOperationId: "operation.stream", toolCallId: null };
const revisions = { runtimeRevision: "runtime_rev_stream", taskRevision: null, controlRevision: null, workspaceRevision: null,
  indexRevision: null, approvalRevision: null, sessionOptionRevision: "session_option_rev_stream", queueRevision: "queue_rev_stream" };
const snapshot = { state: "ready", identity, revisions, liveness: "running", eventSequence: 1 };
const now = new Date("2026-08-13T14:00:10.000Z");

function persist(drafts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-stream-"));
  const store = new RuntimeEventStore({ projectRoot: root, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
    sessionRef: identity.sessionRef, maxEventsPerSegment: 100, maxSegments: 2 });
  const events = drafts.map((draft, index) => store.append(draft,
    new Date(Math.max(now.getTime(), Date.parse(draft.sourceObservedAt)) + index + 1).toISOString()).event);
  for (const event of events) {
    const validation = validateFixture(registry, "runtime-event-v2", event);
    assert.equal(validation.valid, true, `${event.kind}: ${validation.errors}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
  return events;
}

describe("Piagent WebUI Pi-native session streaming adapter", () => {
  it("emits schema-valid turn/message events while redacting split secrets and all thinking content", () => {
    const adapter = new PiSessionStreamAdapter({ now: () => now });
    const drafts = [
      ...adapter.agentStarted(snapshot),
      ...adapter.turnStarted({ turnIndex: 0, timestamp: now.getTime() - 10 }, snapshot),
      ...adapter.messageStarted({ message: { role: "assistant", content: [], timestamp: now.getTime() - 5 } }, snapshot),
      ...adapter.messageUpdated({ assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, snapshot),
      ...adapter.messageUpdated({ assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private reasoning" } }, snapshot),
      ...adapter.messageUpdated({ assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "private reasoning" } }, snapshot),
      ...adapter.messageUpdated({ assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Token: sk-proj-abc" } }, snapshot),
      ...adapter.messageUpdated({ assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "defghijklmnopqrstuvwxyz\n" } }, snapshot),
      ...adapter.messageEnded({ message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Token: sk-proj-abcdefghijklmnopqrstuvwxyz\nSafe answer." }], stopReason: "stop", timestamp: now.getTime() } }, snapshot),
      ...adapter.turnEnded({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, snapshot)
    ];
    const events = persist(drafts), serialized = JSON.stringify(events);
    assert.equal(serialized.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(serialized.includes("private reasoning"), false);
    assert.equal(events.filter((event) => event.kind === "message.thinking-state").length, 3);
    const delta = events.find((event) => event.kind === "message.text-delta");
    assert.match(delta.payload.delta, /REDACTED_SECRET/);
    assert.equal(delta.redaction.applied, true);
    assert.equal(events.at(-1).kind, "turn.ended");
  });

  it("holds a multiline private key until it can redact the whole block", () => {
    const adapter = new PiSessionStreamAdapter({ now: () => now });
    const drafts = [
      ...adapter.turnStarted({ turnIndex: 0, timestamp: now.getTime() }, snapshot),
      ...adapter.messageStarted({ message: { role: "assistant", content: [] } }, snapshot)
    ];
    assert.deepEqual(adapter.messageUpdated({ assistantMessageEvent: { type: "text_delta", delta: "-----BEGIN PRIVATE KEY-----\n", contentIndex: 0 } }, snapshot), []);
    assert.deepEqual(adapter.messageUpdated({ assistantMessageEvent: { type: "text_delta", delta: "PRIVATE-BODY\n", contentIndex: 0 } }, snapshot), []);
    drafts.push(...adapter.messageUpdated({ assistantMessageEvent: { type: "text_delta", delta: "-----END PRIVATE KEY-----\n", contentIndex: 0 } }, snapshot));
    drafts.push(...adapter.messageEnded({ message: { role: "assistant", content: [{ type: "text", text: "-----BEGIN PRIVATE KEY-----\nPRIVATE-BODY" }],
      stopReason: "stop" } }, snapshot));
    const events = persist(drafts), serialized = JSON.stringify(events);
    assert.equal(serialized.includes("PRIVATE-BODY"), false);
    assert.equal(events.some((event) => event.kind === "message.text-delta" && event.payload.delta.includes("REDACTED_SECRET")), true);
    assert.equal(events.find((event) => event.kind === "message.completed").payload.textPreview.includes("REDACTED_SECRET"), true);
  });

  it("streams only bounded tool metadata and never tool arguments, partials or raw results", () => {
    let tick = now.getTime();
    const adapter = new PiSessionStreamAdapter({ now: () => new Date(tick) });
    adapter.turnStarted({ turnIndex: 0, timestamp: tick }, snapshot);
    const drafts = adapter.toolStarted({ toolCallId: "raw_call_1", toolName: "bash", args: { command: "echo TOP_SECRET" } }, snapshot);
    tick += 300;
    drafts.push(...adapter.toolUpdated({ toolCallId: "raw_call_1", toolName: "bash", partialResult: "TOP_SECRET partial" }, snapshot));
    drafts.push(...adapter.toolEnded({ toolCallId: "raw_call_1", toolName: "bash", result: "TOP_SECRET result", isError: false }, snapshot));
    const events = persist(drafts), serialized = JSON.stringify(events);
    assert.deepEqual(events.map((event) => event.kind), ["activity.started", "activity.progress", "activity.finished"]);
    assert.equal(serialized.includes("raw_call_1"), false);
    assert.equal(serialized.includes("TOP_SECRET"), false);
    assert.equal(events.every((event) => event.payload.preview === null), true);
  });

  it("redacts secret-bearing tool names and bounds newline event amplification", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    const adapter = new PiSessionStreamAdapter({ now: () => now });
    adapter.turnStarted({ turnIndex: 0, timestamp: now.getTime() }, snapshot);
    const drafts = [
      ...adapter.toolStarted({ toolCallId: "call_secret", toolName: `api_key=${secret}` }, snapshot),
      ...adapter.toolEnded({ toolCallId: "call_secret", toolName: secret, isError: false }, snapshot),
      ...adapter.toolStarted({ toolCallId: "call_malformed", toolName: "!!!" }, snapshot)
    ];
    drafts.push(...adapter.messageStarted({ message: { role: "assistant", content: [] } }, snapshot));
    for (let index = 0; index < 1_000; index += 1) {
      drafts.push(...adapter.messageUpdated({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x\n" } }, snapshot));
    }
    drafts.push(...adapter.messageEnded({ message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }, snapshot));
    const events = persist(drafts), deltaEvents = events.filter((event) => event.kind === "message.text-delta");
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.deepEqual(events.filter((event) => event.kind.startsWith("activity.")).map((event) => event.payload.toolName),
      ["redacted-tool", "redacted-tool", "tool"]);
    assert.ok(deltaEvents.length <= 4, `expected coalesced delta events, received ${deltaEvents.length}`);
  });

  it("deduplicates thinking state and applies one message-wide stream event budget", () => {
    const repeated = new PiSessionStreamAdapter({ now: () => now });
    repeated.turnStarted({ turnIndex: 0, timestamp: now.getTime() }, snapshot);
    repeated.messageStarted({ message: { role: "assistant", content: [] } }, snapshot);
    const repeatedDrafts = [];
    for (let index = 0; index < 1_000; index += 1) {
      repeatedDrafts.push(...repeated.messageUpdated({ assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, snapshot));
      repeatedDrafts.push(...repeated.messageUpdated({ assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, snapshot));
    }
    assert.deepEqual(repeatedDrafts.map((draft) => draft.payload.state), ["started", "completed"]);

    const flooded = new PiSessionStreamAdapter({ now: () => now });
    flooded.turnStarted({ turnIndex: 0, timestamp: now.getTime() }, snapshot);
    flooded.messageStarted({ message: { role: "assistant", content: [] } }, snapshot);
    const floodDrafts = [];
    for (let index = 0; index < 1_000; index += 1) {
      floodDrafts.push(...flooded.messageUpdated({ assistantMessageEvent: { type: "thinking_start", contentIndex: index } }, snapshot));
    }
    assert.equal(floodDrafts.length, 128);
    assert.equal(floodDrafts.every((draft) => draft.kind === "message.thinking-state"), true);
  });

  it("settles and clears the operation stream without inventing queue truth", () => {
    const adapter = new PiSessionStreamAdapter({ now: () => now });
    const [event] = persist(adapter.agentSettled(snapshot, null));
    assert.equal(event.kind, "agent-operation.settled");
    assert.deepEqual(event.payload.hasPendingMessages, { state: "unknown", value: null, reasonCode: "queue-fact-unavailable" });
  });

  it("wires Pi-native events into the exact session's durable replay stream", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-stream-wiring-")), sessionId = "session-stream-wiring";
    const handlers = new Map(), entries = [];
    const pi = {
      registerCommand() {},
      on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      appendEntry(customType, data) { entries.push({ id: `entry_${entries.length + 1}`, type: "custom", customType, data }); },
      sendUserMessage() {},
      getThinkingLevel() { return "off"; }
    };
    webUiExtension(pi);
    const ctx = { cwd, isIdle: () => false, hasPendingMessages: () => false, getContextUsage: () => undefined,
      sessionManager: { getSessionId: () => sessionId, getBranch: () => structuredClone(entries), getLeafId: () => entries.at(-1)?.id ?? null,
        getLeafEntry: () => structuredClone(entries.at(-1) ?? null) }, ui: { notify() {} } };
    const emit = async (name, event = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
    };
    await emit("session_start");
    await emit("agent_start");
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("message_start", { message: { role: "assistant", content: [], timestamp: Date.now() } });
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Streamed safely.\n" } });
    await emit("tool_execution_start", { toolCallId: "raw_tool_wiring", toolName: "read", args: { path: "/private" } });
    await emit("tool_execution_end", { toolCallId: "raw_tool_wiring", toolName: "read", result: "PRIVATE OUTPUT", isError: false });
    await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Streamed safely.\n" }], stopReason: "stop", timestamp: Date.now() } });
    await emit("turn_end", { message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
    await emit("agent_settled");

    const eventRoot = path.join(cwd, ".pi", "piagent-state", "webui-events");
    const runtimeDirectory = path.join(eventRoot, fs.readdirSync(eventRoot).find((name) => name.startsWith("runtime-")));
    const sessionDirectory = path.join(runtimeDirectory, fs.readdirSync(runtimeDirectory).find((name) => name.startsWith("session-")));
    const segment = path.join(sessionDirectory, fs.readdirSync(sessionDirectory).find((name) => name.startsWith("segment.")));
    const runtimeInstanceId = JSON.parse(fs.readFileSync(segment, "utf8").split("\n").find(Boolean)).runtimeInstanceId;
    const store = new RuntimeEventStore({ projectRoot: cwd, projectRef: webUiProjectRef(cwd), runtimeInstanceId,
      sessionRef: webUiSessionRef(sessionId) });
    const replay = store.replay(null, 100);
    assert.equal(replay.state, "current");
    assert.deepEqual(replay.events.map((event) => event.kind), ["agent-operation.started", "turn.started", "message.started", "message.text-delta",
      "activity.started", "activity.finished", "message.completed", "turn.ended", "agent-operation.settled"]);
    for (const event of replay.events) {
      const validation = validateFixture(registry, "runtime-event-v2", event);
      assert.equal(validation.valid, true, `${event.kind}: ${validation.errors}`);
    }
    const serialized = JSON.stringify(replay.events);
    assert.equal(serialized.includes("raw_tool_wiring"), false);
    assert.equal(serialized.includes("/private"), false);
    assert.equal(serialized.includes("PRIVATE OUTPUT"), false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

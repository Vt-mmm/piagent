import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewaySessionStream, safeToolFileLabel } from "../packages/piagent-webui/gateway/gateway-session-stream.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();

describe("Piagent WebUI compact file progress", () => {
  it("derives a redaction-checked basename only for file-aware tools", () => {
    assert.equal(safeToolFileLabel("read", { path: "/repo/src/use-auth-refresh.ts" }), "use-auth-refresh.ts");
    assert.equal(safeToolFileLabel("edit", { file_path: "C:\\repo\\src\\auth.ts" }), "auth.ts");
    assert.equal(safeToolFileLabel("apply_patch", { patch: "*** Update File: src/auth-refresh.test.ts\n@@\n-old\n+new" }),
      "auth-refresh.test.ts");
    assert.equal(safeToolFileLabel("grep", { path: "src/features/auth-refresh.ts", pattern: "refresh" }), "auth-refresh.ts");
    assert.equal(safeToolFileLabel("grep", { path: "src/features", pattern: "refresh" }), null,
      "a search root is not falsely presented as a file");
    assert.equal(safeToolFileLabel("bash", { command: "cat /private/token-refresh.ts" }), null,
      "opaque shell arguments stay out of compact chat progress");
    assert.equal(safeToolFileLabel("read", { path: "/repo/sk-proj-abcdefghijklmnopqrstuvwxyz.ts" }), null);
  });

  it("streams the basename on start and completion without exposing the path or raw arguments", () => {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const stream = new GatewaySessionStream({ sessionRef: "session_file_progress",
      operationRef: "operation_file_progress", events });
    stream.observe({ type: "tool_execution_start", toolCallId: "raw_file_call", toolName: "read",
      args: { path: "/private/project/src/use-auth-refresh.ts", token: "TOP_SECRET" } });
    stream.observe({ type: "tool_execution_end", toolCallId: "raw_file_call", toolName: "read", isError: false,
      result: "PRIVATE_RESULT" });

    assert.deepEqual(observed.map((event) => event.kind), ["tool.started", "tool.completed"]);
    assert.deepEqual(observed.map((event) => event.payload.fileLabel), ["use-auth-refresh.ts", "use-auth-refresh.ts"]);
    const serialized = JSON.stringify(observed);
    assert.equal(serialized.includes("/private/project"), false);
    assert.equal(serialized.includes("TOP_SECRET"), false);
    assert.equal(serialized.includes("PRIVATE_RESULT"), false);
    for (const event of observed) {
      const validation = validateFixture(registry, "gateway-protocol-v1", event);
      assert.equal(validation.valid, true, validation.errors);
    }
  });

  it("shows a summary of the older conversation as one step, before or during the turn", () => {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const stream = new GatewaySessionStream({ sessionRef: "session_summary", operationRef: "operation_summary", events });
    // Before the model is asked (no agent_start yet), then once more after a failed one.
    stream.observe({ type: "compaction_start", reason: "manual" });
    stream.observe({ type: "compaction_start", reason: "manual" });
    stream.observe({ type: "compaction_end", reason: "manual", result: { summary: "PRIVATE_SUMMARY" }, aborted: false, willRetry: false });
    stream.observe({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false });
    stream.observe({ type: "compaction_start", reason: "threshold" });
    stream.observe({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "Auto-compaction failed: x" });
    assert.deepEqual(observed.map((event) => [event.kind, event.payload.toolLabel, event.payload.isError, event.payload.reasonCode]),
      [["tool.started", "compaction", null, null], ["tool.completed", "compaction", false, null],
        ["tool.started", "compaction", null, null], ["tool.completed", "compaction", true, "compaction-failed"]]);
    assert.notEqual(observed[0].payload.toolCallRef, observed[2].payload.toolCallRef);
    assert.equal(JSON.stringify(observed).includes("PRIVATE_SUMMARY"), false);
    for (const event of observed) assert.equal(validateFixture(registry, "gateway-protocol-v1", event).valid, true);
  });

  it("keeps generic progress when the current tool has no safely known file", () => {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const stream = new GatewaySessionStream({ sessionRef: "session_generic_progress",
      operationRef: "operation_generic_progress", events });
    stream.observe({ type: "tool_execution_start", toolCallId: "raw_command_call", toolName: "bash",
      args: { command: "npm test" } });
    assert.equal(observed[0].payload.fileLabel, null);
    assert.equal(validateFixture(registry, "gateway-protocol-v1", observed[0]).valid, true);
  });

  // A line longer than the flush size was sent at 1,024 characters wherever
  // that fell; a credential arriving there went out half-formed, too short for
  // redaction to recognise. Pieces are now cut after a space.
  it("never sends part of a credential when a long line is streamed in pieces", () => {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const stream = new GatewaySessionStream({ sessionRef: "session_stream_secret", operationRef: "operation_stream_secret", events });
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const line = `${"word ".repeat(200)}${secret}${" and more text".repeat(80)}`;
    stream.observe({ type: "agent_start" });
    stream.observe({ type: "message_start", message: { role: "assistant", content: [] } });
    for (let i = 0; i < line.length; i += 7) stream.observe({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: line.slice(i, i + 7) } });
    stream.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: line }], stopReason: "stop" } });
    const deltas = observed.filter((event) => event.kind === "message.delta").map((event) => event.payload.delta);
    assert.ok(deltas.length > 1, "the line went out in pieces");
    const text = deltas.join("");
    assert.equal(text.includes("abcdefghij"), false);
    assert.match(text, /\[REDACTED_SECRET\] and more text/);
  });
});

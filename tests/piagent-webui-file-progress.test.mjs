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
});

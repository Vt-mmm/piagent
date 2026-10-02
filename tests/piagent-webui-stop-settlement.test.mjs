import assert from "node:assert/strict";
import test from "node:test";

import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewaySessionStream } from "../packages/piagent-webui/gateway/gateway-session-stream.ts";

// A member pressed Stop while a command ran. Codex ended the turn with
// stopReason "error" and the AbortError text, and the operation settled as a
// model failure; it is a stop.
function settle(message) {
  const events = new GatewayEventStore(), observed = [];
  events.subscribe((event) => observed.push(event));
  const stream = new GatewaySessionStream({ sessionRef: "session-stop", operationRef: "operation-stop", events });
  stream.observe({ type: "message_start", message: { role: "assistant" } });
  stream.observe({ type: "message_end", message: { role: "assistant", content: [], ...message } });
  stream.complete("revision-stop", null);
  return observed.find((event) => event.kind === "operation.settled")?.payload;
}

test("an AbortError ending settles the operation as stopped, a provider error as an error", () => {
  assert.equal(settle({ stopReason: "error", errorMessage: "This operation was aborted" }).settlement, "aborted");
  assert.equal(settle({ stopReason: "aborted" }).settlement, "aborted");
  assert.equal(settle({ stopReason: "error", errorMessage: "fetch failed: socket hang up" }).settlement, "error");
});

test("a company subagent starting or ending refreshes the catalog row", () => {
  const events = new GatewayEventStore(), observed = [];
  events.subscribe((event) => observed.push(event));
  const stream = new GatewaySessionStream({ sessionRef: "session-helpers", operationRef: "operation-helpers", events });
  stream.observe({ type: "agent_start" });
  stream.observe({ type: "managed_helpers", active: 1, maximum: 2 });
  assert.deepEqual(observed.filter((event) => event.kind === "catalog.changed").map((event) => event.payload.reasonCode), ["managed-helpers-changed"]);
});

test("a company request waiting for a free account is one step of the running turn", () => {
  const events = new GatewayEventStore(), observed = [];
  events.subscribe((event) => observed.push(event));
  const stream = new GatewaySessionStream({ sessionRef: "session-wait", operationRef: "operation-wait", events });
  stream.observe({ type: "agent_start" });
  stream.observe({ type: "managed_capacity_wait", id: "w1", role: "main", code: "session_account_busy_retry_later", state: "start", waitedMs: 0 });
  stream.observe({ type: "managed_capacity_wait", id: "w1", role: "main", code: "session_account_busy_retry_later", state: "waiting", waitedMs: 30000 });
  stream.observe({ type: "managed_capacity_wait", id: "w1", role: "main", code: "session_account_busy_retry_later", state: "end", outcome: "admitted", waitedMs: 61000 });
  // One that waited too long ends as a failed step; one still open when the turn settles is closed.
  stream.observe({ type: "managed_capacity_wait", id: "w2", role: "research", code: "concurrency_limit", state: "start", waitedMs: 0 });
  stream.observe({ type: "managed_capacity_wait", id: "w2", role: "research", code: "concurrency_limit", state: "end", outcome: "gave-up", waitedMs: 1200000 });
  stream.observe({ type: "managed_capacity_wait", id: "w3", role: "main", code: "concurrency_limit", state: "start", waitedMs: 0 });
  stream.observe({ type: "agent_settled" });
  const steps = observed.filter((event) => event.kind.startsWith("tool.")).map((event) => [event.kind, event.payload.toolLabel, event.payload.isError, event.payload.reasonCode]);
  assert.deepEqual(steps, [
    ["tool.started", "capacity-wait", null, null], ["tool.completed", "capacity-wait", false, null],
    ["tool.started", "capacity-wait", null, null], ["tool.completed", "capacity-wait", true, "capacity-wait-expired"],
    ["tool.started", "capacity-wait", null, null], ["tool.completed", "capacity-wait", false, null]]);
});

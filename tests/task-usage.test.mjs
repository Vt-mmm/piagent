import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendContextTelemetry } from "../packages/piagent-core/extensions/context-engine.js";
import { buildTaskEfficiencyMetrics } from "../packages/piagent-core/runtime/product/efficiency-metrics.ts";
import { projectTaskUsage, readTaskUsage } from "../packages/piagent-core/runtime/product/task-usage.ts";
import { registerTaskUsageHooks } from "../packages/piagent-core/runtime/product/task-usage-hooks.ts";

const task = { taskId: "a", taskRunId: "a-run", sessionId: "session" };
const base = { ...task, taskUsageVersion: 1, requestId: "request-1" };
const start = { ...base, event: "task_usage_request" };
const terminal = { ...base, event: "task_usage_terminal", usageSemantics: "request-cumulative", stopReason: "stop",
  usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 22 }, cost: 0.1, costBasis: "sdk-rate-estimate" };
const inspect = (records, overrides = {}) => ({ records, exists: true, integrityFailures: 0, recoverableTailBytes: 0, inputTruncated: false, ...overrides });

test("observed SDK usage deduplicates replay and includes billed format failures across tasks", () => {
  const failure = { ...terminal, requestId: "request-2", stopReason: "error" };
  const other = { ...terminal, taskRunId: "b-run", usage: { ...terminal.usage, totalTokens: 999 } };
  const result = projectTaskUsage(task, inspect([start, terminal, terminal, { ...start, requestId: "request-2" }, failure, other]));
  assert.equal(result.tokens, 44);
  assert.equal(result.requests, 2);
  assert.equal(result.failedAttempts, 1);
  assert.equal(result.sdkEstimatedCost, 0.2);
  assert.equal(result.billedCost, null);
  assert.equal(result.components.cacheRead, 12);
});

test("abort missing usage, conflicting totals, unsupported deltas and hidden retries stay unknown", () => {
  for (const record of [
    { ...terminal, stopReason: "aborted", usage: Object.fromEntries(Object.keys(terminal.usage).map((key) => [key, 0])) },
    { ...terminal, usageSemantics: "delta" },
    { ...terminal, usageSemantics: "session-cumulative" },
    { ...terminal, providerRequests: 2 },
    { ...terminal, usage: { ...terminal.usage, totalTokens: 23 } },
    { ...terminal, usage: undefined }
  ]) assert.equal(projectTaskUsage(task, inspect([start, record])).tokens, null);
  assert.equal(projectTaskUsage(task, inspect([start])).tokens, null);
  assert.equal(projectTaskUsage(task, inspect([terminal])).tokens, null);
  assert.equal(projectTaskUsage(task, inspect([start, terminal, { ...terminal, cost: 0.2 }])).tokens, null);
});

test("late usage fills unknown fields without adding cumulative snapshots or losing them on old replay", () => {
  const missing = { ...terminal, usage: null, cost: null, stopReason: "aborted" };
  const late = { ...terminal, stopReason: "aborted" };
  assert.equal(projectTaskUsage(task, inspect([start, missing])).tokens, null);
  const result = projectTaskUsage(task, inspect([start, missing, late, missing, late]));
  assert.equal(result.tokens, 22);
  assert.equal(result.failedAttempts, 1);
});

test("executed tools counted once per request, never from recommendations or authorization attempts", () => {
  const tool = { ...base, event: "task_tool_invoked", toolCallId: "tool-1", toolName: "edit" };
  const result = projectTaskUsage(task, inspect([start, terminal, { ...tool, event: "task_tool_attempted" }, tool, tool,
    { ...tool, event: "task_tool_attempted", toolName: "read", toolCallId: "tool-2" }, { ...tool, toolName: "read", toolCallId: "tool-2" }, { ...tool, event: "tool_call", toolCallId: "blocked" }]));
  assert.deepEqual(result.actualInvocationCounts, { edit: 1, read: 1 });
  const conflict = projectTaskUsage(task, inspect([start, terminal, { ...tool, event: "task_tool_attempted" }, tool, { ...tool, toolName: "write" }]));
  assert.equal(conflict.actualInvocationCounts, null);
});

test("missing, rotated, corrupt and truncated telemetry cannot manufacture exact totals", () => {
  for (const flag of [{ exists: false }, { inputTruncated: true }, { integrityFailures: 1 }, { recoverableTailBytes: 4 }]) {
    const result = projectTaskUsage(task, inspect([start, terminal], flag));
    assert.equal(result.tokens, null);
    assert.equal(result.knownTokenSubtotal, 22);
  }
});

test("hooks bind terminal usage before task switch, omit content, and persist cold report readback", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pcl-usage-"));
  try {
    const handlers = new Map();
    let active = task;
    const ctx = { cwd, sessionManager: { getSessionId: () => task.sessionId } };
    const records = [];
    registerTaskUsageHooks({ on: (name, callback) => handlers.set(name, callback) }, {
      activeTask: () => active,
      telemetry: (_ctx, event) => { const record = { sessionId: task.sessionId, ...event }; records.push(record); appendContextTelemetry(cwd, record); }
    });
    const fire = async (name, event = {}) => handlers.get(name)(event, ctx);
    await fire("turn_start");
    await fire("before_provider_request", { payload: { secret: "DO_NOT_STORE" } });
    await fire("tool_execution_start", { toolCallId: "read-1", toolName: "read", args: { private: "DO_NOT_STORE" } });
    await fire("tool_result", { toolCallId: "read-1", toolName: "read" });
    await fire("tool_execution_end", { toolCallId: "read-1", toolName: "read" });
    const message = { role: "assistant", stopReason: "error", usage: { ...terminal.usage, cost: { total: 0.1 } }, content: "DO_NOT_STORE" };
    await fire("message_end", { message });
    active = { ...task, taskId: "b", taskRunId: "b-run" };
    await fire("turn_start");
    await fire("turn_end", { message });
    await fire("session_shutdown");
    const result = readTaskUsage(cwd, task);
    assert.equal(result.tokens, 22);
    assert.deepEqual(result.actualInvocationCounts, { read: 1 });
    assert.equal(readTaskUsage(cwd, active).tokens, null);
    assert.doesNotMatch(JSON.stringify(records), /DO_NOT_STORE/);
    const fixture = JSON.parse(fs.readFileSync(new URL("../evals/fixtures/task-contract.valid.json", import.meta.url)));
    const metrics = buildTaskEfficiencyMetrics(cwd, { ...fixture, ...task });
    assert.equal(metrics.exactUsage.tokens, 22);
    assert.equal(metrics.exactUsage.cost, null);
    assert.equal(metrics.timing.timeToFirstCorrectEditMs, null);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("attempts rejected before execution and interrupted unknown executions are distinct", () => {
  const call = { ...base, toolCallId: "blocked", toolName: "read" };
  const rejected = projectTaskUsage(task, inspect([start, terminal, { ...call, event: "task_tool_attempted" }, { ...call, event: "task_tool_not_executed" }]));
  assert.deepEqual(rejected.actualInvocationCounts, {});
  assert.equal(rejected.attemptedToolCalls, 1);
  assert.equal(rejected.notExecutedToolCalls, 1);
  const pending = projectTaskUsage(task, inspect([start, terminal, { ...call, event: "task_tool_attempted" }]));
  assert.equal(pending.actualInvocationCounts, null);
  assert.equal(pending.failedAttempts, null);
  const aborted = projectTaskUsage(task, inspect([start, { ...terminal, stopReason: "aborted", usage: null }]));
  assert.equal(aborted.failedAttempts, null);
  assert.equal(aborted.observedFailedAttempts, 1);
  assert.equal(projectTaskUsage(task, inspect([start, terminal, { ...call, event: "task_tool_started" }])).actualInvocationCounts, null);
});

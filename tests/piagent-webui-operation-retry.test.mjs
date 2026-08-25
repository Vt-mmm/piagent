import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewaySessionStream } from "../packages/piagent-webui/gateway/gateway-session-stream.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionOperationLifecycle, sessionOperationRetryPolicy }
  from "../packages/piagent-webui/gateway/session-operation-lifecycle.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-operation-retry-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = {
    path: path.join(root, `${name}.jsonl`), id: `raw-${name}`, cwd: path.join(root, "project"), name,
    created: new Date("2026-08-25T08:00:00.000Z"), modified: new Date("2026-08-25T08:00:01.000Z"), messageCount: 1,
    firstMessage: "Run once.", allMessagesText: "Run once."
  };
  const key = Buffer.alloc(32, 23);
  return { root, key, info, sessionRef: sessionRefForPath(key, info.path) };
}

function waitFor(assertion, timeout = 1_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try { if (assertion()) { resolve(); return; } }
      catch (error) { reject(error); return; }
      if (Date.now() - started >= timeout) { reject(new Error("operation did not settle")); return; }
      setTimeout(check, 5);
    };
    check();
  });
}

describe("Piagent replay-safe operation lifecycle", () => {
  it("admits only bounded pristine provider retries and keeps compaction on a separate phase", () => {
    assert.deepEqual(sessionOperationRetryPolicy(), { maximumAttempts: 1, maximumDelayMs: 8_000 });
    assert.throws(() => sessionOperationRetryPolicy({ maximumAttempts: 11 }), /retry-policy-invalid/);
    const lifecycle = new SessionOperationLifecycle({ operationRef: "operation_pristine",
      retryPolicy: { maximumAttempts: 2, maximumDelayMs: 20 } });
    lifecycle.observe({ type: "agent_start" });
    lifecycle.observe({ type: "message_end", message: { role: "assistant", stopReason: "error",
      content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "\u200b  " }] } });
    assert.equal(lifecycle.replayUnsafe, false);
    assert.equal(lifecycle.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 10 }).retry, "allowed");
    assert.equal(lifecycle.phase, "retry");
    assert.equal(lifecycle.observe({ type: "auto_retry_end", success: false, attempt: 1 }).phase, "running");
    assert.equal(lifecycle.observe({ type: "auto_retry_start", attempt: 2, maxAttempts: 10, delayMs: 20 }).retry, "allowed");
    assert.equal(lifecycle.observe({ type: "auto_retry_end", success: false, attempt: 2 }).phase, "running");
    const exhausted = lifecycle.observe({ type: "auto_retry_start", attempt: 3, maxAttempts: 10, delayMs: 20 });
    assert.equal(exhausted.retry, "abort");
    assert.equal(exhausted.reasonCode, "automatic-retry-attempt-limit");
    assert.equal(lifecycle.retryAbortRequired, true);
    lifecycle.observe({ type: "auto_retry_end", success: false, attempt: 3 });
    assert.equal(lifecycle.retryAbortRequired, true, "retry_end cannot race the cancellation microtask");

    const compaction = new SessionOperationLifecycle({ operationRef: "operation_compaction" });
    compaction.observe({ type: "agent_start" });
    assert.equal(compaction.observe({ type: "compaction_start", reason: "overflow" }).phase, "compaction");
    assert.equal(compaction.observe({ type: "summarization_retry_scheduled", attempt: 1, delayMs: 5 }).retry, "none");
    assert.equal(compaction.observe({ type: "compaction_end", reason: "overflow", willRetry: true }).phase, "running");
    assert.equal(compaction.observe({ type: "auto_retry_start", attempt: 1, delayMs: 5 }).retry, "allowed");
  });

  it("blocks retry after visible output or any tool call and ignores foreign or terminal events", () => {
    const visible = new SessionOperationLifecycle({ operationRef: "operation_visible" });
    visible.observe({ type: "agent_start" });
    visible.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I changed the file." } });
    assert.equal(visible.replayUnsafe, true);
    assert.equal(visible.observe({ type: "agent_end", willRetry: true }).reasonCode, "automatic-retry-replay-unsafe");
    assert.equal(visible.observe({ type: "auto_retry_start", attempt: 1, delayMs: 0 }).retry, "abort");
    visible.observe({ type: "auto_retry_end", success: false, attempt: 1 });
    assert.equal(visible.retryAbortRequired, true);

    const tool = new SessionOperationLifecycle({ operationRef: "operation_tool" });
    tool.observe({ type: "agent_start" });
    tool.observe({ type: "tool_execution_start", toolCallId: "call-side-effect", toolName: "write" });
    assert.equal(tool.replayUnsafe, true);
    assert.equal(tool.observe({ type: "auto_retry_start", attempt: 1, delayMs: 0 }).reasonCode,
      "automatic-retry-replay-unsafe");

    const correlated = new SessionOperationLifecycle({ operationRef: "operation_current" });
    correlated.observe({ type: "agent_start" });
    const foreign = correlated.observe({ type: "auto_retry_start", operationRef: "operation_old", attempt: 1, delayMs: 0 });
    assert.equal(foreign.accepted, false);
    assert.equal(foreign.reasonCode, "operation-correlation-mismatch");
    correlated.observe({ type: "agent_settled" });
    assert.equal(correlated.observe({ type: "auto_retry_start", attempt: 1, delayMs: 0 }).accepted, false);
  });

  it("emits one explicit error settlement when an unsafe host retry is blocked", () => {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const stream = new GatewaySessionStream({ sessionRef: "session_unsafe_retry", operationRef: "operation_unsafe_retry", events });
    stream.observe({ type: "agent_start" });
    stream.observe({ type: "tool_execution_start", toolCallId: "call-write", toolName: "write" });
    stream.observe({ type: "tool_execution_end", toolCallId: "call-write", toolName: "write", isError: false });
    stream.observe({ type: "message_start", message: { role: "assistant" } });
    stream.observe({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } });
    const decision = stream.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 0 });
    assert.equal(decision.retry, "abort");
    stream.observe({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
    stream.observe({ type: "agent_settled" });
    stream.complete("revision_unsafe_retry");
    stream.complete("revision_duplicate_terminal");

    const settlements = observed.filter((event) => event.kind === "operation.settled");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].payload.settlement, "error");
    assert.equal(settlements[0].payload.reasonCode, "automatic-retry-replay-unsafe");
    assert.equal(observed.some((event) => event.kind === "message.completed"), false);
  });

  it("cancels a zero-delay unsafe retry before it can duplicate a tool side effect and leaves Working", async (t) => {
    const { root, key, info, sessionRef } = fixture(t, "unsafe-host-retry");
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set();
    const emit = (event) => { for (const listener of listeners) listener(event); };
    let retryControllerReady = false, retryCancelled = false, abortRetryCalls = 0, sideEffects = 0;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      abortRetry() { abortRetryCalls += 1; if (retryControllerReady) retryCancelled = true; },
      async prompt() {
        this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-write", name: "write", arguments: {} }] } });
        sideEffects += 1;
        emit({ type: "tool_execution_start", toolCallId: "call-write", toolName: "write" });
        emit({ type: "tool_execution_end", toolCallId: "call-write", toolName: "write", isError: false });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } });
        emit({ type: "agent_end", messages: [], willRetry: true });
        emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 0, errorMessage: "transient" });
        retryControllerReady = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!retryCancelled) {
          sideEffects += 1;
          emit({ type: "tool_execution_start", toolCallId: "call-write-replayed", toolName: "write" });
        }
        emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
        this.isIdle = true; this.isStreaming = false; emit({ type: "agent_settled" });
      }
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_unsafe_host_retry", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [info], events,
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    supervisor.setProjectionReader(async () => ({ sessionRevision: "revision_unsafe_host_retry", liveState: "idle" }));
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Change the file once.",
      expectedOperationRef: null }, "revision_before_unsafe_host_retry");
    await waitFor(() => observed.some((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef));

    assert.equal(sideEffects, 1, "the provider turn was not replayed after its first tool call");
    assert.ok(abortRetryCalls >= 2, "the immediate and post-emission cancellation boundaries both ran");
    assert.equal(supervisor.currentOperation(sessionRef), null, "the session no longer projects Working");
    const settlement = observed.find((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlement.payload.settlement, "error");
    assert.equal(settlement.payload.reasonCode, "automatic-retry-replay-unsafe");
    assert.equal(observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef).length, 1);
    await supervisor.close();
  });

  it("allows one pristine bounded retry and publishes its durable final exactly once", async (t) => {
    const { root, key, info, sessionRef } = fixture(t, "pristine-host-retry");
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set();
    const emit = (event) => { for (const listener of listeners) listener(event); };
    let abortRetryCalls = 0, attempts = 0;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      abortRetry() { abortRetryCalls += 1; },
      async prompt() {
        this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } });
        emit({ type: "agent_end", messages: [], willRetry: true });
        emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 0, errorMessage: "network" });
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Final." }] },
          assistantMessageEvent: { type: "text_delta", delta: "Final." } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop",
          content: [{ type: "text", text: "Final." }] } });
        emit({ type: "auto_retry_end", success: true, attempt: 1 });
        this.isIdle = true; this.isStreaming = false; emit({ type: "agent_settled" });
      }
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_pristine_host_retry", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [info], events,
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    supervisor.setProjectionReader(async () => ({ sessionRevision: "revision_pristine_host_retry", liveState: "idle" }));
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Read without side effects.",
      expectedOperationRef: null }, "revision_before_pristine_host_retry");
    await waitFor(() => observed.some((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef));

    assert.equal(attempts, 1);
    assert.equal(abortRetryCalls, 0);
    assert.equal(observed.filter((event) => event.kind === "message.completed"
      && event.payload.operationRef === started.operationRef).length, 1);
    assert.equal(observed.find((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef).payload.settlement, "completed");
    assert.equal(supervisor.currentOperation(sessionRef), null);
    await supervisor.close();
  });
});

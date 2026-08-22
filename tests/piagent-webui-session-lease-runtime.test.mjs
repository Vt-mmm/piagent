import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { webUiModelRef } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { piApprovalBroker } from "../packages/piagent-core/runtime/inspection/approval-broker.ts";
import { buildSessionCatalog, projectRefForCwd, sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewaySessionStream, runtimeRestartReasonCode } from "../packages/piagent-webui/gateway/gateway-session-stream.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { preferAuthoritativePiagentGuard } from "../packages/piagent-webui/gateway/extension-authority.ts";
import { sessionOperationDeadlinePolicy, SessionOperationWatchdog, terminateWatchedSessionOperation }
  from "../packages/piagent-webui/gateway/session-operation-watchdog.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { installedPiHostRoot, loadPinnedPiHost } from "../packages/piagent-webui/gateway/pi-host.ts";
import { TerminalSessionAdapter } from "../packages/piagent-webui/extension/terminal-session-adapter.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function localPiAi() {
  const hostRoot = installedPiHostRoot();
  const candidates = [path.join(hostRoot, "node_modules", "@earendil-works", "pi-ai"), path.join(path.dirname(hostRoot), "pi-ai"),
    path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-ai")];
  const found = candidates.find((candidate) => {
    try { return JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")).name === "@earendil-works/pi-ai"; }
    catch { return false; }
  });
  if (!found) throw new Error("pi-ai-unavailable");
  return await import(pathToFileURL(path.join(found, "dist", "index.js")));
}

function waitFor(assertion, timeout = 5_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try { if (assertion()) { resolve(); return; } }
      catch (error) { reject(error); return; }
      if (Date.now() - started >= timeout) { reject(new Error("timed out waiting for runtime state")); return; }
      setTimeout(check, 10);
    };
    check();
  });
}

function state(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-lease-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, key: Buffer.alloc(32, 7) };
}

function info(root, name = "session.jsonl") {
  return {
    path: path.join(root, name), id: `raw-${name}`, cwd: path.join(root, "project"), name: "Lease runtime proof",
    created: new Date("2026-08-14T08:00:00.000Z"), modified: new Date("2026-08-14T08:00:01.000Z"), messageCount: 2,
    firstMessage: "Continue this durable session.", allMessagesText: "Continue this durable session.\nReady."
  };
}

describe("Piagent Session Hub owner lease and lazy runtime supervisor", () => {
  it("classifies only an observed failed runtime-drift tool result and publishes a bounded reason code", () => {
    const drift = "Installed Piagent runtime changed during this session. Restart the session to verify and re-pin the capability lock before using tools.";
    assert.equal(runtimeRestartReasonCode({ isError: true, result: { content: [{ type: "text", text: drift }] } }),
      "runtime-restart-required");
    assert.equal(runtimeRestartReasonCode({ isError: false, result: drift }), null);
    assert.equal(runtimeRestartReasonCode({ isError: true, result: { content: [{ type: "text", text: "ordinary tool failure" }] } }), null);

    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const stream = new GatewaySessionStream({ sessionRef: "session_runtime_drift", operationRef: "operation_runtime_drift", events });
    stream.observe({ type: "tool_execution_start", toolCallId: "call-runtime-drift", toolName: "subagent" });
    stream.observe({ type: "tool_execution_end", toolCallId: "call-runtime-drift", toolName: "subagent", isError: true,
      result: { content: [{ type: "text", text: drift }] } });
    stream.observe({ type: "message_start", message: { role: "assistant" } });
    stream.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "A final-looking answer after drift." }] } });
    stream.complete("revision_runtime_drift");

    assert.equal(observed.length, 3);
    assert.equal(observed[0].payload.reasonCode, null);
    assert.equal(observed[1].payload.reasonCode, "runtime-restart-required");
    assert.equal(stream.runtimeRestartRequired, true);
    assert.equal(observed.some((event) => event.kind === "message.completed"), false);
    assert.equal(observed[2].kind, "operation.settled");
    assert.equal(observed[2].payload.settlement, "unknown");
    assert.equal(observed[2].payload.reasonCode, "runtime-restart-required");
    assert.equal(JSON.stringify(observed).includes(drift), false);
    for (const event of observed) {
      const validation = validateFixture(registry, "gateway-protocol-v1", event);
      assert.equal(validation.valid, true, validation.errors);
    }
  });

  it("publishes exactly one canonical settlement and only completes durable assistant success", () => {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const make = (suffix) => new GatewaySessionStream({ sessionRef: `session_settlement_${suffix}`,
      operationRef: `operation_settlement_${suffix}`, events });

    const completed = make("completed");
    completed.observe({ type: "message_start", message: { role: "assistant" } });
    completed.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Durable result." } });
    completed.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Durable result." }] } });
    completed.complete("revision_settlement_completed");
    completed.complete("revision_settlement_duplicate");
    const terminalEventCount = observed.length;
    completed.observe({ type: "tool_execution_start", toolCallId: "late-tool", toolName: "late" });
    completed.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Late draft." } });
    completed.observe({ type: "agent_settled" });
    assert.equal(observed.length, terminalEventCount);

    const blocked = make("blocked");
    blocked.observe({ type: "message_start", message: { role: "assistant" } });
    blocked.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "[Piagent completion gate: NOT APPROVED] Task remains open.\n\nDraft." }] } });
    blocked.complete("revision_settlement_blocked");

    const aborted = make("aborted"); aborted.markAborted(); aborted.complete("revision_settlement_aborted");
    const failed = make("error"); failed.markError(); failed.complete(null);
    const unknown = make("unknown"); unknown.complete(null);

    const settlements = observed.filter((event) => event.kind === "operation.settled");
    assert.deepEqual(settlements.map((event) => event.payload.settlement), ["completed", "blocked", "aborted", "error", "unknown"]);
    assert.equal(settlements.filter((event) => event.payload.operationRef === "operation_settlement_completed").length, 1);
    assert.deepEqual(observed.filter((event) => event.kind === "message.completed")
      .map((event) => event.payload.operationRef), ["operation_settlement_completed"]);
    assert.equal(settlements.find((event) => event.payload.settlement === "blocked")?.payload.reasonCode,
      "completion-gate-not-approved");
    assert.equal(settlements.find((event) => event.payload.settlement === "aborted")?.payload.reasonCode, "operation-aborted");
    assert.equal(settlements.find((event) => event.payload.settlement === "error")?.payload.reasonCode, "operation-failed");
    assert.equal(settlements.find((event) => event.payload.settlement === "unknown")?.payload.reasonCode,
      "operation-settlement-unknown");
    for (const event of observed) {
      const validation = validateFixture(registry, "gateway-protocol-v1", event);
      assert.equal(validation.valid, true, validation.errors);
    }
  });

  it("does not turn visually empty assistant stops into durable success merely because message identity exists", () => {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const invisible = ["", "\u200b\u200c\u200d\u2060\ufeff\u061c", "\u001b[31m\u001b[0m"];
    for (let index = 0; index < invisible.length; index += 1) {
      const stream = new GatewaySessionStream({ sessionRef: `session_empty_assistant_${index}`,
        operationRef: `operation_empty_assistant_${index}`, events });
      stream.observe({ type: "message_start", message: { role: "assistant" } });
      stream.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop",
        content: invisible[index] ? [{ type: "text", text: invisible[index] }] : [] } });
      stream.complete(`revision_empty_assistant_${index}`);
    }
    assert.equal(observed.some((event) => event.kind === "message.completed"), false);
    const settlements = observed.filter((event) => event.kind === "operation.settled");
    assert.equal(settlements.length, invisible.length);
    assert.equal(settlements.every((event) => event.payload.settlement === "unknown"
      && event.payload.reasonCode === "assistant-message-empty"), true);
    for (const event of settlements) {
      const validation = validateFixture(registry, "gateway-protocol-v1", event);
      assert.equal(validation.valid, true, validation.errors);
    }

    const unicode = new GatewaySessionStream({ sessionRef: "session_visible_unicode",
      operationRef: "operation_visible_unicode", events });
    const visibleText = "Đã xong 👩‍💻";
    unicode.observe({ type: "message_start", message: { role: "assistant" } });
    unicode.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: visibleText }] } });
    unicode.complete("revision_visible_unicode");
    const visible = observed.filter((event) => event.payload.operationRef === "operation_visible_unicode");
    assert.equal(visible.some((event) => event.kind === "message.completed"), true);
    assert.equal(visible.find((event) => event.kind === "operation.settled")?.payload.settlement, "completed");
  });

  it("quarantines an idle clean host when approval cancellation throws", async () => {
    const watchdog = new SessionOperationWatchdog(sessionOperationDeadlinePolicy({ inactivityTimeoutMs: 100,
      maximumDurationMs: 200, terminationTimeoutMs: 5, projectionTimeoutMs: 2 }));
    watchdog.start(() => undefined);
    const marked = []; let aborts = 0, forced = null;
    const result = await terminateWatchedSessionOperation({ watchdog, settlement: "error",
      reasonCode: "operation-inactivity-timeout", forcedReasonCode: "operation-inactivity-timeout",
      stream: { markAborted: (reason) => marked.push(reason), markError: (reason) => marked.push(reason),
        forceLifecycleTermination: (reason) => { forced = reason; } },
      completion: () => Promise.resolve(), settledCleanly: () => true,
      cancelApproval: () => { throw new Error("fixture-broker-failed"); },
      abortHost: () => { aborts += 1; return new Promise(() => undefined); }
    });
    assert.deepEqual(result, { state: "quarantine", reasonCode: "operation-termination-cleanup-failed" });
    assert.deepEqual(marked, ["operation-termination-cleanup-failed", "operation-termination-cleanup-failed"]);
    assert.equal(forced, "operation-termination-cleanup-failed"); assert.equal(aborts, 1);
  });

  it("keeps a headless Gateway alive until an active operation deadline settles", () => {
    const watchdogModule = pathToFileURL(path.join(repositoryRoot,
      "packages/piagent-webui/gateway/session-operation-watchdog.ts")).href;
    const script = `import { SessionOperationWatchdog, sessionOperationDeadlinePolicy } from ${JSON.stringify(watchdogModule)};
const watchdog = new SessionOperationWatchdog(sessionOperationDeadlinePolicy({ inactivityTimeoutMs: 20,
  maximumDurationMs: 100, terminationTimeoutMs: 10, projectionTimeoutMs: 5 }));
watchdog.start((reason) => process.stdout.write(reason));`;
    const output = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import",
      path.join(repositoryRoot, "scripts/register-typescript-loader.mjs"), "--input-type=module", "--eval", script], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 1_000
    });
    assert.equal(output, "operation-inactivity-timeout");
  });

  it("settles the operation when canonical projection fails and does not publish draft success", async (t) => {
    const { root, key } = state(t), target = info(root, "projection-failure-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set();
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); throw new Error("fixture-unsubscribe-failed"); }; },
      async prompt() {
        this.isIdle = false; this.isStreaming = true;
        for (const listener of listeners) listener({ type: "agent_start" });
        for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant" } });
        for (const listener of listeners) listener({ type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Unconfirmed draft." } });
        for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", stopReason: "stop",
          content: [{ type: "text", text: "Unconfirmed draft." }] } });
        await new Promise((resolve) => setImmediate(resolve));
        this.isIdle = true; this.isStreaming = false;
        for (const listener of listeners) listener({ type: "agent_settled" });
      }
    };
    let projectionEntered = false, releaseProjection;
    const projectionGate = new Promise((resolve) => { releaseProjection = resolve; });
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_projection_failure", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    supervisor.setProjectionReader(async () => { projectionEntered = true; await projectionGate; throw new Error("projection-failed"); });
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Produce a durable result.",
      expectedOperationRef: null }, "revision_projection_before");
    await waitFor(() => projectionEntered);
    assert.deepEqual(supervisor.currentOperation(sessionRef), {
      operationRef: started.operationRef, state: "settling", abortable: false
    });
    assert.deepEqual(supervisor.currentOperations(), [{ sessionRef, operationRef: started.operationRef, state: "settling", abortable: false }]);
    releaseProjection();
    await waitFor(() => observed.some((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef));

    const settlement = observed.find((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.ok(settlement);
    assert.equal(settlement.payload.settlement, "unknown");
    assert.equal(settlement.payload.reasonCode, "session-projection-unavailable");
    assert.equal(settlement.payload.sessionRevision, null);
    assert.equal(observed.some((event) => event.kind === "message.completed"
      && event.payload.operationRef === started.operationRef), false);
    assert.equal(supervisor.ownership(sessionRef).liveState, "idle");
    assert.equal(supervisor.currentOperation(sessionRef), null);
    assert.equal(validateFixture(registry, "gateway-protocol-v1", settlement).valid, true);
    await supervisor.close();
  });

  it("rejects a late Stop while a completed assistant reply awaits canonical projection", async (t) => {
    const { root, key } = state(t), target = info(root, "projection-late-stop-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let aborts = 0;
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt() {
        this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Canonical result." } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop",
          content: [{ type: "text", text: "Canonical result." }] } });
        this.isIdle = true; this.isStreaming = false; emit({ type: "agent_settled" });
      },
      async abort() { aborts += 1; }
    };
    let projectionEntered = false, releaseProjection;
    const projectionGate = new Promise((resolve) => { releaseProjection = resolve; });
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_projection_late_stop", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    supervisor.setProjectionReader(async () => { projectionEntered = true; await projectionGate;
      return { sessionRevision: "revision_projection_late_stop", liveState: "idle" }; });
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Finish once.",
      expectedOperationRef: null }, "revision_projection_late_stop_start");
    await waitFor(() => projectionEntered);
    assert.deepEqual(supervisor.currentOperation(sessionRef), {
      operationRef: started.operationRef, state: "settling", abortable: false
    });
    assert.equal(supervisor.ownership(sessionRef).liveState, "running");
    await assert.rejects(() => supervisor.abort(sessionRef, started.operationRef, true), /session-operation-conflict/);
    assert.equal(aborts, 0); releaseProjection();
    await waitFor(() => observed.some((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef));
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "completed");
    assert.equal(settlements[0].payload.reasonCode, null);
    assert.equal(observed.filter((event) => event.kind === "message.completed"
      && event.payload.operationRef === started.operationRef).length, 1);
    await supervisor.close();
  });

  it("does not let a late idle projection overwrite recovery-required authority", async (t) => {
    const { root, key } = state(t), target = info(root, "projection-recovery-race-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    const leases = new SessionLeaseStore(root, key); events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let disposals = 0;
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt() {
        this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Stale idle result." } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop",
          content: [{ type: "text", text: "Stale idle result." }] } });
        this.isIdle = true; this.isStreaming = false; emit({ type: "agent_settled" });
      }
    };
    let projectionEntered = false, releaseProjection;
    const projectionGate = new Promise((resolve) => { releaseProjection = resolve; });
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_projection_recovery_race", key,
      leases, listSessions: async () => [target], events,
      runtimeFactory: async () => ({ session, async dispose() { disposals += 1; } }) });
    supervisor.setProjectionReader(async () => { projectionEntered = true; await projectionGate;
      return { sessionRevision: "revision_projection_recovery_race", liveState: "idle" }; });
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Project after recovery.",
      expectedOperationRef: null }, "revision_projection_recovery_start");
    await waitFor(() => projectionEntered);
    const authority = supervisor.ownership(sessionRef).owner;
    leases.requireRecovery(sessionRef, authority.ownerEpoch, authority.gatewayInstanceRef,
      authority.runtimeInstanceRef, "fixture-forced-recovery");
    releaseProjection(); await waitFor(() => supervisor.activeCount === 0);
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "error");
    assert.equal(settlements[0].payload.reasonCode, "session-owner-continuity-lost");
    const runtimeEvents = observed.filter((event) => event.kind === "runtime.changed" && event.payload.sessionRef === sessionRef);
    assert.equal(runtimeEvents.some((event) => event.payload.liveState === "idle"), false);
    assert.equal(runtimeEvents.at(-1).payload.liveState, "uncertain");
    assert.equal(supervisor.ownership(sessionRef).reasonCode, "fixture-forced-recovery");
    assert.equal(disposals, 1); await supervisor.close();
  });

  it("bounds a canonical projection that never returns", async (t) => {
    const { root, key } = state(t), target = info(root, "projection-timeout-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set();
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => { throw new Error("fixture-unsubscribe-failed"); }; },
      async prompt() {
        this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Unconfirmed result." } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop",
          content: [{ type: "text", text: "Unconfirmed result." }] } });
        this.isIdle = true; this.isStreaming = false; emit({ type: "agent_settled" });
      }
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_projection_timeout", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 500, maximumDurationMs: 1_000, terminationTimeoutMs: 30, projectionTimeoutMs: 15 },
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    supervisor.setProjectionReader(() => new Promise(() => undefined));
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Return a durable result.",
      expectedOperationRef: null }, "revision_projection_timeout_start");
    await waitFor(() => observed.some((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef));
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "error");
    assert.equal(settlements[0].payload.reasonCode, "session-projection-timeout");
    assert.equal(observed.some((event) => event.kind === "message.completed"
      && event.payload.operationRef === started.operationRef), false);
    assert.equal(supervisor.currentOperation(sessionRef), null);
    await supervisor.close();
  });

  it("restarts a drifted runtime after the reply while preserving the exact session manager", async (t) => {
    const { root, key } = state(t), target = info(root, "runtime-drift-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    const stableManager = { getSessionFile: () => target.path, getSessionId: () => target.id };
    let opened = 0, disposed = 0;
    events.subscribe((event) => observed.push(event));
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_runtime_drift", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      runtimeFactory: async (_info, _runtimeRef, suppliedManager) => {
        opened += 1;
        if (opened === 1) assert.equal(suppliedManager, undefined);
        else assert.equal(suppliedManager, stableManager);
        const listeners = new Set();
        const session = {
          isIdle: true, isStreaming: false, sessionManager: stableManager,
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          async prompt() {
            this.isIdle = false; this.isStreaming = true;
            for (const listener of listeners) listener({ type: "agent_start" });
            for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant" } });
            for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: {
              type: "text_delta", delta: "The plan was still produced." } });
            for (const listener of listeners) listener({ type: "tool_execution_start", toolCallId: "call-drift", toolName: "subagent" });
            for (const listener of listeners) listener({ type: "tool_execution_end", toolCallId: "call-drift", toolName: "subagent", isError: true,
              result: { content: [{ type: "text", text: "Installed Piagent runtime changed during this session. Restart the session to verify and re-pin the capability lock before using tools." }] } });
            for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", stopReason: "stop",
              content: [{ type: "text", text: "The plan was still produced." }] } });
            await new Promise((resolve) => setImmediate(resolve));
            this.isIdle = true; this.isStreaming = false;
            for (const listener of listeners) listener({ type: "agent_settled" });
          }
        };
        return { session, async dispose() { disposed += 1; } };
      }
    });
    supervisor.setProjectionReader(async () => ({ sessionRevision: `revision_runtime_drift_${opened}`, liveState: "idle" }));
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Build the detailed plan.",
      expectedOperationRef: null }, "revision_runtime_drift_0");
    assert.equal(started.resultCode, "started");
    await waitFor(() => opened === 2 && supervisor.ownership(sessionRef).liveState === "idle");

    assert.equal(disposed, 1);
    assert.equal(supervisor.liveSessionManager(sessionRef), stableManager);
    assert.equal(observed.some((event) => event.kind === "tool.completed"
      && event.payload.reasonCode === "runtime-restart-required"), true);
    assert.equal(observed.some((event) => event.kind === "runtime.changed" && event.payload.liveState === "uncertain"
      && event.payload.reasonCode === "runtime-restart-required"), true);
    assert.equal(observed.some((event) => event.kind === "runtime.changed" && event.payload.liveState === "idle"
      && event.payload.reasonCode === null), true);
    await supervisor.close();
    assert.equal(disposed, 2);
  });

  it("keeps one authoritative Piagent Guard while preserving every unrelated extension diagnostic", () => {
    const authoritative = path.join(repositoryRoot, "installed", "packages", "piagent-core", "extensions", "piagent-guard.ts");
    const configured = path.join(repositoryRoot, "configured", "packages", "piagent-core", "extensions", "piagent-guard.ts");
    const mcp = path.join(repositoryRoot, "configured", "extensions", "mcp.ts");
    const base = {
      extensions: [
        { path: authoritative, resolvedPath: authoritative },
        { path: configured, resolvedPath: configured },
        { path: mcp, resolvedPath: mcp }
      ],
      errors: [
        { path: configured, error: `Tool \"piagent_tools\" conflicts with ${authoritative}` },
        { path: configured, error: "Configured Guard also has an unrelated load failure" },
        { path: mcp, error: "MCP extension failed independently" }
      ],
      runtime: { authority: "shared" }
    };
    const filtered = preferAuthoritativePiagentGuard(authoritative)(base);
    assert.deepEqual(filtered.extensions.map((extension) => extension.resolvedPath), [authoritative, mcp]);
    assert.deepEqual(filtered.errors, [base.errors[1], base.errors[2]]);
    assert.equal(filtered.runtime, base.runtime);

    const missingAuthority = { ...base, extensions: base.extensions.slice(1) };
    assert.equal(preferAuthoritativePiagentGuard(authoritative)(missingAuthority), missingAuthority);
  });

  it("forwards prepared text on the prompt and images on the host's own channel", async (t) => {
    const { root, key } = state(t), target = info(root);
    const prompts = [];
    // The supervisor races the prompt against an observed agent_start, so a fake
    // that resolves without ever emitting one reports the operation as unobserved.
    let observer = null;
    const session = { isIdle: true, isStreaming: false, subscribe: (fn) => { observer = fn; return () => {}; },
      async prompt(text, options) { prompts.push({ text, options }); observer?.({ type: "agent_start" }); } };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_attachment_send", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target],
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    const images = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
    const sent = await supervisor.send(sessionRefForPath(key, target.path), { delivery: "new-operation",
      message: "Doc hai file nay.\nChot ngan sach Q3.", expectedOperationRef: null, images }, "revision_attachment_send");
    assert.equal(sent.resultCode, "started");
    assert.equal(prompts.length, 1);
    // Document prose is already in the message; the image never becomes prose.
    assert.match(prompts[0].text, /Chot ngan sach Q3\./);
    assert.equal(prompts[0].text.includes("aW1hZ2U="), false);
    assert.deepEqual(prompts[0].options.images, images);
    await supervisor.close();
  });

  it("omits the image option entirely when a message carries none", async (t) => {
    const { root, key } = state(t), target = info(root);
    const prompts = [];
    let observer = null;
    const session = { isIdle: true, isStreaming: false, subscribe: (fn) => { observer = fn; return () => {}; },
      async prompt(text, options) { prompts.push({ text, options }); observer?.({ type: "agent_start" }); } };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_plain_send", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target],
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    await supervisor.send(sessionRefForPath(key, target.path), { delivery: "new-operation", message: "Khong co file.",
      expectedOperationRef: null, images: [] }, "revision_plain_send");
    assert.equal(prompts[0].text, "Khong co file.");
    assert.equal(prompts[0].options, undefined);
    await supervisor.close();
  });

  it("does not acquire an internal subagent session through user-facing runtime authority", async (t) => {
    const { root, key } = state(t), normal = info(root), hidden = {
      ...info(root, path.join("sessions", "subagent", "96dfe478", "run-0", "session.jsonl")),
      name: "subagent-piagent-planner-96dfe478-1", parentSessionPath: normal.path,
      allMessagesText: `${normal.allMessagesText}\nTask: You are a delegated subagent running from a fork of the parent session.`
    };
    let opened = 0;
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_hidden_subagent", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [normal, hidden],
      runtimeFactory: async () => { opened += 1; return { async dispose() {} }; } });
    assert.deepEqual((await supervisor.listSessions()).map((item) => item.path), [normal.path]);
    await assert.rejects(() => supervisor.acquire(sessionRefForPath(key, hidden.path)), /session-not-found/);
    assert.equal(opened, 0);
    await supervisor.close();
  });

  it("persists an owner-only HMAC chain and fails closed on conflict or corruption", (t) => {
    const { root, key } = state(t), store = new SessionLeaseStore(root, key), sessionRef = "session_lease_store_test";
    assert.equal(store.inspect(sessionRef).state, "released");
    const acquired = store.acquire(sessionRef, "gateway_instance_one", "runtime_instance_one", new Date("2026-08-14T08:00:00.000Z"));
    assert.equal(acquired.state, "gateway-owned");
    assert.equal(acquired.continuity, "exact");
    const file = path.join(store.directory, fs.readdirSync(store.directory)[0]);
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => store.acquire(sessionRef, "gateway_instance_two", "runtime_instance_two"), /session-owner-conflict/);
    assert.throws(() => store.release(sessionRef, acquired.ownerEpoch, "gateway_instance_two", "runtime_instance_one"), /session-owner-conflict/);
    const released = store.release(sessionRef, acquired.ownerEpoch, "gateway_instance_one", "runtime_instance_one",
      new Date("2026-08-14T08:01:00.000Z"));
    assert.equal(released.state, "released");
    fs.appendFileSync(file, "{\"forged\":true}\n");
    assert.deepEqual(store.inspect(sessionRef), {
      state: "unavailable", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null,
      continuity: "unknown", revision: null, reasonCode: "session-lease-unavailable"
    });
  });

  it("linearizes terminal and Gateway ownership and safely replaces a terminal process that is proven dead", (t) => {
    const { root, key } = state(t), store = new SessionLeaseStore(root, key), sessionRef = "session_terminal_owner_test";
    const dead = store.acquireTerminal(sessionRef, "terminal_99999999_dead_owner", "runtime_terminal_dead",
      new Date("2026-08-14T08:00:00.000Z"));
    assert.equal(dead.state, "terminal-owned");
    assert.throws(() => store.acquire(sessionRef, "gateway_blocked_by_terminal", "runtime_gateway_blocked"), /session-owner-conflict/);
    const currentTerminal = `terminal_${process.pid}_current_owner`;
    const adopted = store.acquireTerminal(sessionRef, currentTerminal, "runtime_terminal_current",
      new Date("2026-08-14T08:01:00.000Z"));
    assert.equal(adopted.state, "terminal-owned");
    assert.equal(adopted.gatewayInstanceRef, currentTerminal);
    assert.notEqual(adopted.ownerEpoch, dead.ownerEpoch);
    assert.throws(() => store.acquireTerminal(sessionRef, `terminal_${process.pid}_second_owner`, "runtime_terminal_second"),
      /session-owner-conflict/);
    store.releaseTerminal(sessionRef, adopted.ownerEpoch, currentTerminal, "runtime_terminal_current",
      new Date("2026-08-14T08:02:00.000Z"));
    assert.equal(store.acquire(sessionRef, "gateway_after_terminal", "runtime_after_terminal").state, "gateway-owned");
  });

  it("lets a terminal adapter register and release one exact persisted Pi session", (t) => {
    const { root } = state(t), agentDir = path.join(root, "agent"), file = path.join(root, "terminal-session.jsonl");
    const adapter = new TerminalSessionAdapter("runtime_terminal_adapter", agentDir);
    const ctx = { sessionManager: { getSessionFile: () => file, getSessionId: () => "raw-terminal-adapter" } };
    adapter.bind(ctx);
    assert.equal(adapter.dispatchAllowed(ctx), true);
    const key = fs.readFileSync(path.join(agentDir, "piagent-gateway", "catalog.key"));
    const store = new SessionLeaseStore(path.join(agentDir, "piagent-gateway"), key);
    const sessionRef = sessionRefForPath(key, file);
    assert.equal(store.inspect(sessionRef).state, "terminal-owned");
    assert.throws(() => store.acquire(sessionRef, `gateway_${process.pid}_while_terminal`, "runtime_gateway_conflict"), /owner-conflict/);
    adapter.release();
    assert.equal(store.inspect(sessionRef).state, "released");
    assert.equal(store.acquire(sessionRef, `gateway_${process.pid}_after_terminal_release`, "runtime_gateway_after_release").state, "gateway-owned");
  });

  it("requires an explicit recovery boundary before replacing a Gateway process proven dead", (t) => {
    const { root, key } = state(t), store = new SessionLeaseStore(root, key), sessionRef = "session_dead_gateway_test";
    const dead = store.acquire(sessionRef, "gateway_99999999_dead_owner", "runtime_dead_gateway",
      new Date("2026-08-14T08:00:00.000Z"));
    assert.equal(dead.state, "gateway-owned");
    assert.equal(store.releaseDeadOwnerForExplicitRecovery(sessionRef, new Date("2026-08-14T08:01:00.000Z")).state, "released");
    assert.equal(store.acquire(sessionRef, `gateway_${process.pid}_new_owner`, "runtime_new_gateway").state, "gateway-owned");
  });

  it("reclaims an owner-only mutation lock only after its process is proven dead", (t) => {
    const { root, key } = state(t), store = new SessionLeaseStore(root, key), sessionRef = "session_dead_lock_test";
    const first = store.acquire(sessionRef, `gateway_${process.pid}_lock_seed`, "runtime_lock_seed");
    store.release(sessionRef, first.ownerEpoch, `gateway_${process.pid}_lock_seed`, "runtime_lock_seed");
    const journal = fs.readdirSync(store.directory).find((name) => name.endsWith(".jsonl"));
    assert.ok(journal);
    fs.writeFileSync(path.join(store.directory, `${journal}.lock`), JSON.stringify({
      version: "piagent-session-lease-lock-v1", pid: 99999999,
      createdAt: "2026-08-14T08:00:00.000Z", nonce: "lock_dead_process_fixture"
    }), { mode: 0o600 });
    const recovered = store.acquire(sessionRef, `gateway_${process.pid}_after_dead_lock`, "runtime_after_dead_lock");
    assert.equal(recovered.state, "gateway-owned");
    assert.equal(fs.existsSync(path.join(store.directory, `${journal}.lock`)), false);
  });

  it("opens once, projects exact ownership, releases cleanly and makes stale ownership recovery-only", async (t) => {
    const { root, key } = state(t), leases = new SessionLeaseStore(root, key), session = info(root);
    const sessionRef = sessionRefForPath(key, session.path);
    let opened = 0, disposed = 0;
    const first = new SessionRuntimeSupervisor({
      gatewayInstanceRef: "gateway_runtime_first", key, leases, listSessions: async () => [session],
      runtimeFactory: async (target, runtimeRef) => {
        opened += 1;
        assert.equal(target.path, session.path);
        assert.match(runtimeRef, /^runtime_/);
        return { async dispose() { disposed += 1; } };
      }
    });
    const [left, right] = await Promise.all([first.acquire(sessionRef), first.acquire(sessionRef)]);
    assert.equal(left.ownerEpoch, right.ownerEpoch);
    assert.equal(opened, 1);
    assert.equal(first.activeCount, 1);
    assert.equal(first.ownership(sessionRef).state, "gateway-owned");

    const catalog = await buildSessionCatalog({
      gatewayInstanceRef: "gateway_runtime_first", key, listSessions: async () => [session],
      readOwnership: (value) => first.ownership(value)
    });
    const validation = validateFixture(registry, "session-catalog-v1", catalog);
    assert.equal(validation.valid, true, validation.errors);
    assert.equal(catalog.sessions[0].owner.continuity, "exact");
    assert.equal(JSON.stringify(catalog).includes(session.path), false);

    const second = new SessionRuntimeSupervisor({
      gatewayInstanceRef: "gateway_runtime_second", key, leases, listSessions: async () => [session],
      runtimeFactory: async () => ({ async dispose() {} })
    });
    assert.equal(second.ownership(sessionRef).state, "recovery-required");
    assert.equal(second.ownership(sessionRef).owner.continuity, "uncertain");
    await assert.rejects(() => second.acquire(sessionRef), /session-owner-conflict/);
    await first.release(sessionRef);
    assert.equal(disposed, 1);
    assert.equal(first.ownership(sessionRef).state, "offline");
    await first.close();
    await second.close();
  });

  it("records recovery-required when runtime opening or disposal cannot be proven clean", async (t) => {
    const { root, key } = state(t), leases = new SessionLeaseStore(root, key), openFailure = info(root, "open-failure.jsonl");
    const openRef = sessionRefForPath(key, openFailure.path);
    const failedOpen = new SessionRuntimeSupervisor({
      gatewayInstanceRef: "gateway_open_failure", key, leases, listSessions: async () => [openFailure],
      runtimeFactory: async () => { throw new Error("fixture-open-failure"); }
    });
    await assert.rejects(() => failedOpen.acquire(openRef), /fixture-open-failure/);
    assert.equal(failedOpen.ownership(openRef).state, "recovery-required");
    assert.equal(failedOpen.ownership(openRef).reasonCode, "session-runtime-open-failed");

    const disposeFailure = info(root, "dispose-failure.jsonl"), disposeRef = sessionRefForPath(key, disposeFailure.path);
    const failedDispose = new SessionRuntimeSupervisor({
      gatewayInstanceRef: "gateway_dispose_failure", key, leases, listSessions: async () => [disposeFailure],
      runtimeFactory: async () => ({ async dispose() { throw new Error("fixture-dispose-failure"); } })
    });
    await failedDispose.acquire(disposeRef);
    await assert.rejects(() => failedDispose.release(disposeRef), /fixture-dispose-failure/);
    assert.equal(failedDispose.ownership(disposeRef).state, "recovery-required");
    assert.equal(failedDispose.ownership(disposeRef).reasonCode, "session-runtime-dispose-failed");
    await failedOpen.close();
    await failedDispose.close();
  });

  it("keeps an unpersisted Pi session under one lease until the first assistant reply persists", async (t) => {
    const { root, key } = state(t), seed = info(root, "seed.jsonl"), newFile = path.join(root, "new-session.jsonl");
    const manager = { getSessionFile: () => newFile, getSessionId: () => "new-session-id" };
    const selectedModel = { provider: "fixture", id: "reasoning-model" };
    let modelSet = null, thinkingSet = null, disposed = 0, passedManager = null;
    const supervisor = new SessionRuntimeSupervisor({
      gatewayInstanceRef: "gateway_create_runtime", key, leases: new SessionLeaseStore(root, key), listSessions: async () => [seed],
      host: { SessionManager: { create(cwd) { assert.equal(cwd, seed.cwd); return manager; } } },
      runtimeFactory: async (_target, _runtimeRef, value) => {
        passedManager = value;
        return { session: {
          model: null, thinkingLevel: "off",
          modelRuntime: { getAvailableSnapshot: () => [selectedModel] },
          async setModel(model) { modelSet = model; this.model = model; }, setThinkingLevel(level) { thinkingSet = level; this.thinkingLevel = level; }
        }, async dispose() { disposed += 1; } };
      }
    });
    const projectRef = projectRefForCwd(key, seed.cwd);
    const created = await supervisor.createWithReadback(projectRef, projectRef, webUiModelRef("fixture", "reasoning-model"), "high");
    const sessionRef = created.sessionRef;
    assert.deepEqual(created.effectiveOptions, { state: "confirmed", modelRef: webUiModelRef("fixture", "reasoning-model"),
      thinkingLevel: "high", reasonCode: null });
    assert.equal(sessionRef, sessionRefForPath(key, newFile));
    assert.equal(passedManager, manager);
    assert.equal(modelSet, selectedModel);
    assert.equal(thinkingSet, "high");
    assert.equal(supervisor.liveSessionManager(sessionRef), manager);
    assert.equal(supervisor.ownership(sessionRef).state, "gateway-owned");
    assert.equal((await supervisor.listSessions()).find((value) => value.path === newFile)?.firstMessage, "(no messages)");
    await supervisor.release(sessionRef);
    assert.equal(disposed, 1);
    assert.equal((await supervisor.listSessions()).some((value) => value.path === newFile), false);
    await supervisor.close();
  });

  it("keeps a long operation alive while host progress proves liveness", async (t) => {
    const { root, key } = state(t), target = info(root, "watchdog-progress-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let aborts = 0, disposed = 0;
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt() {
        this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        return new Promise((resolve) => {
          let ticks = 0;
          const timer = setInterval(() => {
            ticks += 1; emit({ type: "tool_execution_update", toolCallId: "long-tool", progress: ticks });
            if (ticks < 7) return;
            clearInterval(timer);
            emit({ type: "message_start", message: { role: "assistant" } });
            emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Long task completed." } });
            emit({ type: "message_end", message: { role: "assistant", stopReason: "stop",
              content: [{ type: "text", text: "Long task completed." }] } });
            this.isIdle = true; this.isStreaming = false; emit({ type: "agent_settled" }); resolve();
          }, 15);
        });
      },
      async abort() { aborts += 1; }, clearQueue() {}
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_watchdog_progress", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 35, maximumDurationMs: 500, terminationTimeoutMs: 30, projectionTimeoutMs: 10 },
      runtimeFactory: async () => ({ session, async dispose() { disposed += 1; } }) });
    supervisor.setProjectionReader(async () => ({ sessionRevision: "revision_watchdog_progress", liveState: "idle" }));
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Run a long live task.",
      expectedOperationRef: null }, "revision_watchdog_progress_start");
    await waitFor(() => observed.some((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef));
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "completed");
    assert.equal(aborts, 0); assert.equal(supervisor.currentOperation(sessionRef), null);
    await supervisor.close(); assert.equal(disposed, 1);
  });

  it("quarantines authority when the host subscription boundary fails before prompt", async (t) => {
    const { root, key } = state(t), target = info(root, "watchdog-subscribe-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    let prompts = 0, disposals = 0;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe() { throw new Error("fixture-subscribe-failed"); },
      async prompt() { prompts += 1; }
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_watchdog_subscribe", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 500, maximumDurationMs: 1_000, terminationTimeoutMs: 30, projectionTimeoutMs: 10 },
      runtimeFactory: async () => ({ session, async dispose() { disposals += 1; } }) });
    await assert.rejects(() => supervisor.send(sessionRef, { delivery: "new-operation", message: "Start safely.",
      expectedOperationRef: null }, "revision_watchdog_subscribe_start"), /fixture-subscribe-failed/);
    const settlements = observed.filter((event) => event.kind === "operation.settled");
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "error");
    assert.equal(settlements[0].payload.reasonCode, "session-operation-start-failed");
    assert.equal(prompts, 0); assert.equal(disposals, 1); assert.equal(supervisor.activeCount, 0);
    assert.equal(supervisor.currentOperation(sessionRef), null);
    assert.equal(supervisor.ownership(sessionRef).reasonCode, "session-operation-start-failed");
    await supervisor.close();
  });

  it("terminates a prompt that never reaches agent_start without leaving send pending", async (t) => {
    const { root, key } = state(t), target = info(root, "watchdog-unstarted-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let aborts = 0;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt() { this.isIdle = false; this.isStreaming = true; return new Promise(() => undefined); },
      abort() { aborts += 1; return new Promise(() => undefined); }, clearQueue() {}
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_watchdog_unstarted", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 35, maximumDurationMs: 500, terminationTimeoutMs: 20, projectionTimeoutMs: 10 },
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    await assert.rejects(() => supervisor.send(sessionRef, { delivery: "new-operation", message: "Never start.",
      expectedOperationRef: null }, "revision_watchdog_unstarted_start"), /operation-inactivity-timeout/);
    await waitFor(() => supervisor.activeCount === 0);
    const settlements = observed.filter((event) => event.kind === "operation.settled");
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "error");
    assert.equal(settlements[0].payload.reasonCode, "operation-inactivity-timeout");
    assert.equal(aborts, 1); assert.equal(supervisor.currentOperation(sessionRef), null);
    assert.equal(supervisor.ownership(sessionRef).reasonCode, "operation-inactivity-timeout");
    await supervisor.close();
  });

  it("enforces the absolute operation deadline despite continuous progress", async (t) => {
    const { root, key } = state(t), target = info(root, "watchdog-absolute-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let aborts = 0, timer;
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt() {
        this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        timer = setInterval(() => emit({ type: "tool_execution_update", toolCallId: "endless-tool" }), 10);
        return new Promise(() => undefined);
      },
      abort() { aborts += 1; return new Promise(() => undefined); }, clearQueue() {}
    };
    t.after(() => clearInterval(timer));
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_watchdog_absolute", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 35, maximumDurationMs: 90, terminationTimeoutMs: 25, projectionTimeoutMs: 10 },
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Run forever.",
      expectedOperationRef: null }, "revision_watchdog_absolute_start");
    await waitFor(() => supervisor.activeCount === 0);
    clearInterval(timer);
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "error");
    assert.equal(settlements[0].payload.reasonCode, "operation-deadline-exceeded");
    assert.equal(aborts, 1); assert.equal(supervisor.currentOperation(sessionRef), null);
    assert.equal(supervisor.ownership(sessionRef).reasonCode, "operation-deadline-exceeded");
    await supervisor.close();
  });

  it("bounds Stop, emits one terminal settlement and quarantines a host that never aborts", async (t) => {
    const { root, key } = state(t), target = info(root, "watchdog-stop-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let aborts = 0, clears = 0, disposals = 0;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => { throw new Error("fixture-unsubscribe-failed"); }; },
      prompt() {
        this.isIdle = false; this.isStreaming = true;
        for (const listener of listeners) listener({ type: "agent_start" });
        return new Promise(() => undefined);
      },
      abort() { aborts += 1; return new Promise(() => undefined); }, clearQueue() { clears += 1; }
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_watchdog_stop", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 500, maximumDurationMs: 1_000, terminationTimeoutMs: 30, projectionTimeoutMs: 10 },
      runtimeFactory: async () => ({ session, dispose() { disposals += 1; return new Promise(() => undefined); } }) });
    supervisor.setProjectionReader(async () => ({ sessionRevision: "revision_watchdog_stop", liveState: "idle" }));
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Start a stuck host.",
      expectedOperationRef: null }, "revision_watchdog_stop_start");
    const before = Date.now(), firstStop = supervisor.abort(sessionRef, started.operationRef, true);
    const secondStop = supervisor.abort(sessionRef, started.operationRef, true);
    assert.deepEqual(supervisor.currentOperation(sessionRef), {
      operationRef: started.operationRef, state: "settling", abortable: false
    });
    assert.equal(supervisor.ownership(sessionRef).liveState, "running");
    await assert.rejects(() => supervisor.send(sessionRef, { delivery: "follow-up", message: "Do not queue this.",
      expectedOperationRef: started.operationRef }, "revision_watchdog_stop_start"), /session-operation-conflict/);
    await assert.rejects(() => supervisor.send(sessionRef, { delivery: "steer", message: "Do not steer this.",
      expectedOperationRef: started.operationRef }, "revision_watchdog_stop_start"), /session-operation-conflict/);
    await Promise.all([firstStop, secondStop]); const elapsed = Date.now() - before;
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.ok(elapsed < 500, `Stop took ${elapsed}ms`);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "aborted");
    assert.equal(settlements[0].payload.reasonCode, "operation-abort-timeout");
    assert.equal(aborts, 1); assert.equal(clears, 1); assert.equal(disposals, 1);
    assert.equal(supervisor.activeCount, 0); assert.equal(supervisor.currentOperation(sessionRef), null);
    assert.equal(supervisor.ownership(sessionRef).reasonCode, "operation-abort-timeout");
    const terminalEventCount = observed.length;
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "late-tool", toolName: "late" });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Late draft." } });
    }
    assert.equal(observed.length, terminalEventCount);
    await supervisor.close();
  });

  it("quarantines clean host completion when clearQueue throws and keeps recovery as the final live state", async (t) => {
    const { root, key } = state(t), target = info(root, "watchdog-cleanup-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let aborts = 0, disposals = 0;
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt() { this.isIdle = false; this.isStreaming = true; emit({ type: "agent_start" });
        return new Promise(() => undefined); },
      async abort() { aborts += 1; this.isIdle = true; this.isStreaming = false; emit({ type: "agent_settled" }); },
      clearQueue() { throw new Error("fixture-clear-queue-failed"); }
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_watchdog_cleanup", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 500, maximumDurationMs: 1_000, terminationTimeoutMs: 30, projectionTimeoutMs: 10 },
      runtimeFactory: async () => ({ session, async dispose() { disposals += 1; } }) });
    supervisor.setProjectionReader(async () => ({ sessionRevision: "revision_watchdog_cleanup", liveState: "idle" }));
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Stop cleanly.",
      expectedOperationRef: null }, "revision_watchdog_cleanup_start");
    await supervisor.abort(sessionRef, started.operationRef, true);
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "aborted");
    assert.equal(settlements[0].payload.reasonCode, "operation-termination-cleanup-failed");
    assert.equal(aborts, 1); assert.equal(disposals, 1); assert.equal(supervisor.activeCount, 0);
    assert.equal(supervisor.ownership(sessionRef).reasonCode, "operation-termination-cleanup-failed");
    const runtimeEvents = observed.filter((event) => event.kind === "runtime.changed" && event.payload.sessionRef === sessionRef);
    assert.equal(runtimeEvents.at(-1).payload.liveState, "uncertain");
    assert.equal(runtimeEvents.at(-1).payload.reasonCode, "operation-termination-cleanup-failed");
    const recoveryIndex = runtimeEvents.findIndex((event) => event.payload.reasonCode === "operation-termination-cleanup-failed");
    assert.ok(recoveryIndex >= 0); assert.equal(runtimeEvents.slice(recoveryIndex + 1).some((event) => event.payload.liveState === "idle"), false);
    await supervisor.close();
  });

  it("cancels a pending approval when an operation becomes genuinely inactive", async (t) => {
    const { root, key } = state(t), target = info(root, "watchdog-approval-session.jsonl");
    const sessionRef = sessionRefForPath(key, target.path), events = new GatewayEventStore(), observed = [];
    events.subscribe((event) => observed.push(event));
    const listeners = new Set(); let aborts = 0;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt() {
        this.isIdle = false; this.isStreaming = true;
        for (const listener of listeners) listener({ type: "agent_start" });
        return new Promise(() => undefined);
      },
      abort() { aborts += 1; return new Promise(() => undefined); }, clearQueue() {}
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_watchdog_approval", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [target], events,
      operationWatchdog: { inactivityTimeoutMs: 55, maximumDurationMs: 500, terminationTimeoutMs: 25, projectionTimeoutMs: 10 },
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Wait forever for approval.",
      expectedOperationRef: null }, "revision_watchdog_approval_start");
    const guardPromise = piApprovalBroker.request({ cwd: target.cwd, rawSessionId: target.id, toolCallId: "tool.watchdog.approval",
      action: { kind: "external-provider-action", preconditionClass: "runtime-only", toolName: "external-action",
        rawAction: { action: "create" }, commandPreview: null, parameterPreview: "Create one record", targetPaths: [],
        targetSummaries: [], provider: "fixture-provider", urlOrigin: "https://example.test", requestedScope: "one-action",
        reason: "External write", riskClass: "high", allowConsequence: "Create once", denyConsequence: "Block" },
      terminalConfirm: () => new Promise(() => undefined), ttlMs: 30_000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.approvalProjection(sessionRef).summary.state, "waiting");
    const guard = await guardPromise;
    assert.equal(guard.allowed, false); assert.equal(guard.receipt.winnerSurface, "runtime-control");
    assert.equal(guard.receipt.resolutionReason, "operation-inactivity-timeout");
    await waitFor(() => supervisor.activeCount === 0);
    const settlements = observed.filter((event) => event.kind === "operation.settled"
      && event.payload.operationRef === started.operationRef);
    assert.equal(settlements.length, 1); assert.equal(settlements[0].payload.settlement, "error");
    assert.equal(settlements[0].payload.reasonCode, "operation-inactivity-timeout");
    assert.equal(aborts, 1); assert.equal(supervisor.currentOperation(sessionRef), null);
    assert.equal(supervisor.ownership(sessionRef).reasonCode, "operation-inactivity-timeout");
    await supervisor.close();
  });

  it("binds one pending browser approval to the exact Gateway-owned operation", async (t) => {
    const { root, key } = state(t), sessionInfo = info(root, "approval-session.jsonl");
    const sessionRef = sessionRefForPath(key, sessionInfo.path), listeners = new Set();
    let finishPrompt;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt() {
        this.isIdle = false; this.isStreaming = true;
        for (const listener of listeners) listener({ type: "agent_start" });
        return new Promise((resolve) => { finishPrompt = () => { this.isIdle = true; this.isStreaming = false; resolve(); }; });
      },
      async abort() { finishPrompt?.(); }, clearQueue() {}
    };
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: `gateway_${process.pid}_approval_test`, key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [sessionInfo],
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    const before = (await buildSessionCatalog({ gatewayInstanceRef: `gateway_${process.pid}_approval_test`, key,
      listSessions: async () => [sessionInfo], readOwnership: (value) => supervisor.ownership(value) })).sessions[0];
    const started = await supervisor.send(sessionRef, { delivery: "new-operation", message: "Run guarded action.",
      expectedOperationRef: null }, before.sessionRevision);
    const guardPromise = piApprovalBroker.request({ cwd: sessionInfo.cwd, rawSessionId: sessionInfo.id, toolCallId: "tool.gateway.approval",
      action: { kind: "external-provider-action", preconditionClass: "runtime-only", toolName: "external-action",
        rawAction: { action: "create" }, commandPreview: null, parameterPreview: "Create one remote record",
        targetPaths: [], targetSummaries: [], provider: "fixture-provider", urlOrigin: "https://example.test",
        requestedScope: "one-external-action", reason: "External write", riskClass: "high",
        allowConsequence: "Create once", denyConsequence: "Block" },
      terminalConfirm: () => new Promise(() => undefined), ttlMs: 30_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const projection = supervisor.approvalProjection(sessionRef);
    assert.equal(projection.summary.state, "waiting");
    assert.equal(supervisor.ownership(sessionRef).liveState, "waiting-approval");
    const approvalRef = projection.summary.pending[0].approvalRef;
    const request = supervisor.approvalDetail(sessionRef, approvalRef);
    assert.ok(request); assert.equal(request.identity.agentOperationId, started.operationRef);
    assert.equal(validateFixture(registry, "approval-v1", request).valid, true);
    const receiptPromise = supervisor.decideApproval(approvalRef, {
      schemaVersion: 1, version: "piagent-webui-approval-v1", recordType: "decision", approvalRef,
      decisionId: "decision.gateway.browser", decisionToken: request.decisionToken, identity: structuredClone(request.identity),
      actionDigest: request.action.actionDigest, expectedRevisions: structuredClone(request.expectedRevisions), decision: "allow", reason: null,
      decidedAt: new Date().toISOString(), expiresAt: request.expiresAt, decisionSurface: "webui", executor: "pi-guard", directExecution: false
    });
    const guard = await guardPromise;
    assert.equal(guard.allowed, true); assert.equal(guard.consume(), true);
    const receipt = await receiptPromise;
    assert.equal(validateFixture(registry, "approval-v1", receipt).valid, true);
    assert.equal(receipt.winnerSurface, "webui"); assert.equal(receipt.permit.status, "consumed");
    finishPrompt(); await new Promise((resolve) => setImmediate(resolve));
    await supervisor.release(sessionRef);
  });

  it("opens and resumes a real persisted Pi runtime with the production guard stack and zero provider turns", async (t) => {
    const { root, key } = state(t);
    const cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), sessionDir = path.join(root, "sessions");
    fs.mkdirSync(cwd); fs.mkdirSync(agentDir); fs.mkdirSync(sessionDir);
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
    fs.writeFileSync(path.join(cwd, "README.md"), "# Runtime lease proof\n");
    execFileSync("git", ["-C", cwd, "add", "."]); execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
    const expected = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
      .peerDependencies["@earendil-works/pi-coding-agent"];
    const host = await loadPinnedPiHost(expected);
    const model = { id: "fixture", name: "Fixture model", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 };
    let providerTurns = 0;
    const modelRuntime = {
      async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
      getAuth: async () => ({ auth: { apiKey: "fixture" }, env: {} }),
      getModel: (provider, id) => provider === "fixture" && id === "fixture" ? model : undefined,
      getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
      registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
      stream() { providerTurns += 1; throw new Error("provider-turn-not-allowed"); }
    };
    const manager = host.SessionManager.create(cwd, sessionDir, { id: "runtime-lease-proof" });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "Persist before runtime resume." }], timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Persisted." }], api: "fixture", provider: "fixture", model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const sessions = await host.SessionManager.list(cwd, sessionDir), sessionRef = sessionRefForPath(key, sessions[0].path);
    class ScopedSessionManager extends host.SessionManager {
      static create(targetCwd) { return host.SessionManager.create(targetCwd, sessionDir); }
      static forkFrom(sourcePath, targetCwd) { return host.SessionManager.forkFrom(sourcePath, targetCwd, sessionDir); }
    }
    const runtimeHost = { ...host, SessionManager: ScopedSessionManager };
    const supervisor = new SessionRuntimeSupervisor({
      gatewayInstanceRef: "gateway_real_runtime", key, leases: new SessionLeaseStore(root, key),
      listSessions: () => host.SessionManager.list(cwd, sessionDir),
      host: runtimeHost, agentDir, packageRoot: repositoryRoot, modelRuntime
    });
    const lease = await supervisor.acquire(sessionRef);
    assert.equal(lease.state, "gateway-owned");
    assert.equal(supervisor.ownership(sessionRef).owner.continuity, "exact");
    assert.equal(providerTurns, 0);
    assert.equal(await supervisor.rename(sessionRef, "Renamed without a provider turn"), "renamed");
    assert.equal(host.SessionManager.open(sessions[0].path, sessionDir).getSessionName(), "Renamed without a provider turn");
    const forkRef = await supervisor.fork(sessionRef, null, "Forked without a provider turn");
    assert.notEqual(forkRef, sessionRef);
    const forked = (await host.SessionManager.list(cwd, sessionDir)).find((item) => sessionRefForPath(key, item.path) === forkRef);
    assert.equal(forked?.parentSessionPath, sessions[0].path);
    assert.equal(forked?.name, "Forked without a provider turn");
    assert.equal(providerTurns, 0);
    await supervisor.release(sessionRef);
    assert.equal(supervisor.ownership(sessionRef).state, "offline");
    assert.equal(host.SessionManager.open(sessions[0].path, sessionDir).getSessionId(), "runtime-lease-proof");
    const projectRef = projectRefForCwd(key, cwd);
    const createdRef = await supervisor.create(projectRef, projectRef, webUiModelRef("fixture", "fixture"), "off");
    assert.notEqual(createdRef, sessionRef);
    assert.equal(supervisor.ownership(createdRef).state, "gateway-owned");
    assert.equal((await supervisor.listSessions()).length, 3);
    assert.equal(providerTurns, 0);
    await supervisor.release(createdRef);
    assert.equal((await supervisor.listSessions()).length, 2);
    await supervisor.close();
  });

  it("starts the first Gateway message with the installed WebUI extension and a headless theme", async (t) => {
    const { root, key } = state(t), cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), sessionDir = path.join(root, "sessions");
    fs.mkdirSync(cwd); fs.mkdirSync(agentDir); fs.mkdirSync(sessionDir);
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
    fs.writeFileSync(path.join(cwd, "README.md"), "# Gateway first-message proof\n");
    execFileSync("git", ["-C", cwd, "add", "."]); execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
    const expected = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
      .peerDependencies["@earendil-works/pi-coding-agent"];
    const host = await loadPinnedPiHost(expected), piAi = await localPiAi();
    const themeProof = path.join(root, "gateway-theme-proof.mjs");
    fs.writeFileSync(themeProof, `export default function (pi) {\n  pi.on("session_start", (_event, ctx) => {\n    pi.appendEntry("gateway-theme-proof", { rendered: ctx.ui.theme.fg("accent", "ready") });\n  });\n}\n`);
    const model = { id: "fixture", name: "Fixture model", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 };
    let providerTurns = 0;
    const modelRuntime = {
      async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
      getAuth: async () => ({ auth: { apiKey: "fixture" }, env: {} }),
      getModel: (provider, id) => provider === "fixture" && id === "fixture" ? model : undefined,
      getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
      registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
      streamSimple() {
        providerTurns += 1;
        const stream = piAi.createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Gateway reply." }],
          api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
        return stream;
      }
    };
    class ScopedSessionManager extends host.SessionManager {
      static create(targetCwd) { return host.SessionManager.create(targetCwd, sessionDir); }
      static forkFrom(sourcePath, targetCwd) { return host.SessionManager.forkFrom(sourcePath, targetCwd, sessionDir); }
    }
    const runtimeHost = { ...host, SessionManager: ScopedSessionManager,
      createAgentSessionServices: (options) => host.createAgentSessionServices({ ...options,
        resourceLoaderOptions: { ...options.resourceLoaderOptions, additionalExtensionPaths: [
          ...(options.resourceLoaderOptions?.additionalExtensionPaths ?? []),
          path.join(repositoryRoot, "packages", "piagent-webui", "extension", "piagent-webui.ts"), themeProof
        ] } }) };
    const projectRef = projectRefForCwd(key, cwd);
    const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_first_message", key,
      leases: new SessionLeaseStore(root, key), listSessions: () => host.SessionManager.list(cwd, sessionDir), host: runtimeHost,
      agentDir, packageRoot: repositoryRoot, modelRuntime, resolveProject: (value) => value === projectRef ? cwd : null });
    const createdRef = await supervisor.create(projectRef, projectRef, webUiModelRef("fixture", "fixture"), "off");
    const started = await supervisor.send(createdRef, { delivery: "new-operation", message: "Start this imported project.",
      expectedOperationRef: null }, "session-revision.gateway-first-message");
    assert.equal(started.resultCode, "started"); assert.match(started.operationRef, /^operation_/);
    await waitFor(() => supervisor.ownership(createdRef).liveState === "idle");
    assert.equal(providerTurns, 1);
    const sessions = await host.SessionManager.list(cwd, sessionDir), created = sessions.find((item) => sessionRefForPath(key, item.path) === createdRef);
    assert.ok(created);
    const branch = host.SessionManager.open(created.path, sessionDir).getBranch();
    assert.equal(branch.some((entry) => entry.type === "custom" && entry.customType === "gateway-theme-proof" && entry.data?.rendered === "ready"), true);
    assert.equal(branch.filter((entry) => entry.type === "message" && entry.message?.role === "user").length, 1);
    assert.equal(branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length, 1);
    await supervisor.release(createdRef); await supervisor.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

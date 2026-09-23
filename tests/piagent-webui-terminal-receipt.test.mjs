import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fork } from "node:child_process";

import { activeSessionTask, bindSessionTask, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { registerInputHook } from "../packages/piagent-core/runtime/hooks/input-hook.ts";
import { buildHandoffProjection, writeHandoffProjection } from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { terminalUncertainSendReceipt } from "../packages/piagent-core/runtime/session/uncertain-send-continuation.ts";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewaySessionStream } from "../packages/piagent-webui/gateway/gateway-session-stream.ts";
import { loadPinnedPiHost } from "../packages/piagent-webui/gateway/pi-host.ts";
import { rpcUiContext } from "../packages/piagent-webui/gateway/rpc-ui-context.ts";
import { sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { SessionInspectionRegistry } from "../packages/piagent-webui/gateway/session-inspection-registry.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { TERMINAL_DELIVERY_CONFIRMATION_TYPE, terminalDeliveryPairs, terminalDeliveryReceiptCommitter, terminalDeliveryRequest, terminalDeliverySessionEntries }
  from "../packages/piagent-webui/server/terminal-delivery-receipt.ts";
import { conversationTranscriptItems, persistedLiveConversationHasFinal }
  from "../packages/piagent-webui/client/src/transcript-view-model.ts";
import { projectTranscript } from "../packages/piagent-webui/server/transcript-projection.ts";
import { WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE } from "../packages/piagent-webui/shared/message-correlation.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const recovery = fs.readFileSync(path.join(repositoryRoot,
  "benchmarks/production-v2/prompts/journeys/recover-after-uncertain-send.md"), "utf8").trim();
const registry = createWebUiSchemaRegistry();
const revision = { runtimeRevision: "runtime.receipt", taskRevision: "task.receipt", controlRevision: null,
  workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };

function project(entries, expectedReceipt, sessionRef = "session.receipt", persistedEntries = entries) {
  return projectTranscript({ identity: { projectRef: "project.receipt", runtimeInstanceId: "runtime.receipt", sessionRef,
    taskId: expectedReceipt?.details.taskId ?? null, taskRunId: expectedReceipt?.details.taskRunId ?? null,
    agentOperationId: null, toolCallId: null }, revision, eventCursor: "cursor.receipt", entries,
    terminalDeliveryReceipt: expectedReceipt, terminalDeliveryEntries: persistedEntries, taskOutcome: expectedReceipt?.details.outcome ?? null });
}

function receiptEntries(receipt, suffix = "recovery") {
  return [{ type: "custom", id: `marker.${suffix}`, timestamp: "2026-08-13T14:00:00.000Z",
    customType: WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE, data: { schemaVersion: 1,
      messageRequestId: `request.${suffix}`, operationRef: `operation.${suffix}`, terminalDeliveryRequest: recovery } },
  { type: "custom_message", id: `receipt.${suffix}`, timestamp: "2026-08-13T14:00:01.000Z", display: true,
    ...structuredClone(receipt) }];
}

function customMessage(receipt) { return { role: "custom", display: true, ...structuredClone(receipt) }; }

function receiptStream(readReceipt, configure = () => {}, revision = "session-revision.receipt", taskOutcome = "completed", taskStatusOverride = null) {
  const events = new GatewayEventStore(), observed = [];
  events.subscribe((event) => observed.push(event));
  const stream = new GatewaySessionStream({ sessionRef: "session.receipt", operationRef: "operation.recovery",
    messageRequestId: "request.recovery", events, commitTerminalDeliveryReceipt: readReceipt });
  configure(stream);
  stream.complete(revision, taskOutcome, taskStatusOverride);
  stream.complete(revision, taskOutcome, taskStatusOverride);
  return observed;
}

async function fixture(t, options = {}) {
  const outcome = options.outcome ?? "completed";
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "piagent-terminal-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), sessionDir = path.join(root, "sessions");
  for (const directory of [cwd, agentDir, sessionDir]) fs.mkdirSync(directory);
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
    .peerDependencies["@earendil-works/pi-coding-agent"];
  const host = await loadPinnedPiHost(expectedVersion);
  let manager = host.SessionManager.create(cwd, sessionDir, { id: "receipt-reconnect" });
  if (options.noAssistant) {
    // An already-created session header is a persisted host fixture with no model output.
    fs.writeFileSync(manager.getSessionFile(), `${JSON.stringify(manager.getHeader())}\n`);
    manager = host.SessionManager.open(manager.getSessionFile(), sessionDir);
  }
  // The first, already-settled read-only turn is an explicit public fixture.
  // The recovery turn below uses the pinned host and real input hook, not a
  // synthetic assistant event or a provider response.
  manager.appendCustomEntry(WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE,
    { schemaVersion: 1, messageRequestId: "request.first", operationRef: "operation.first" });
  manager.appendMessage({ role: "user", content: "Inspect the incident log without edits.", timestamp: Date.now() });
  if (!options.noAssistant) manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ROOT_CAUSE=FIXTURE_QUEUE" }],
    api: "fixture", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const task = writeTaskContract(cwd, { ...JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, "evals/fixtures/task-contract.valid.json"), "utf8")),
    taskId: "readonly-incident", taskRunId: "readonly-incident-receipt", sessionId: manager.getSessionId(),
    sessionName: "Readonly incident", changeMode: "read-only", verifyCommands: [],
    trace: { outcome, recordedAt: new Date().toISOString() } });
  bindSessionTask(cwd, task.sessionId, task.sessionName, task);
  writeHandoffProjection(cwd, buildHandoffProjection(cwd, task, { currentDigests: {},
    gate: { decision: outcome === "completed" ? "pass" : "fail", missing: outcome === "completed" ? [] : ["fixture evidence missing"], missingVerifyCommands: [], currentWorkingTreeDigest: workingTreeEvidenceDigest({}) } }));
  const expectedReceipt = terminalUncertainSendReceipt(cwd, task);
  assert.equal(expectedReceipt?.details.completionApproved, outcome === "completed");
  const key = Buffer.alloc(32, 4), sessionRef = sessionRefForPath(key, manager.getSessionFile());
  let providerTurns = 0, beganTurns = 0, clearedBoundaries = 0;
  const telemetry = [], hostEvents = [];
  const model = { id: "fixture", name: "Fixture", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 };
  const modelRuntime = { async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }),
    isUsingOAuth: () => false, getAuth: async () => ({ auth: { apiKey: "fixture" }, env: {} }),
    getModel: () => model, getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model],
    getProviders: () => [], registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
    streamSimple() { providerTurns += 1; throw new Error("provider-turn-forbidden"); } };
  const events = new GatewayEventStore(), observed = [];
  events.subscribe((event) => observed.push(event));
  const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_receipt_reconnect", key,
    leases: new SessionLeaseStore(root, key), listSessions: () => host.SessionManager.list(cwd, sessionDir), events,
    runtimeFactory: async () => {
      const sessionManager = host.SessionManager.open(manager.getSessionFile(), sessionDir);
      const services = await host.createAgentSessionServices({ cwd, agentDir, modelRuntime,
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true,
          extensionFactories: [(pi) => registerInputHook(pi, {
            state: { beginTurn() { beganTurns += 1; throw new Error("unexpected-new-turn"); },
              clearTaskBoundary() { clearedBoundaries += 1; }, taskIdentity() { return { taskRunId: task.taskRunId }; } },
            boilerplateCollapseChars: 1000, activeTask: () => activeSessionTask(cwd, task.sessionId),
            authorityPolicy: () => ({ disposition: "continue" }), readProtectedPaths: () => [],
            imageAccess: () => ({ mode: "deny" }), activateToolGroups() {}, telemetry: (_ctx, event) => telemetry.push(event)
          })] } });
      const { session } = await host.createAgentSessionFromServices({ services, sessionManager, model, noTools: "all" });
      await session.bindExtensions({ mode: "rpc", uiContext: rpcUiContext() });
      session.subscribe((event) => { hostEvents.push(event); options.observeHost?.(event); });
      return { session, async dispose() { session.dispose(); } };
    } });
  t.after(() => supervisor.close());
  supervisor.setProjectionReader(async () => ({ sessionRevision: "session-revision.receipt", liveState: "idle" }));
  return { cwd, key, task, manager, host, sessionDir, expectedReceipt, supervisor, sessionRef, events, observed, hostEvents, telemetry,
    counters: () => ({ providerTurns, beganTurns, clearedBoundaries }) };
}

if (!process.env.PIAGENT_RECEIPT_CRASH_CHILD) {

test("receipt delivery completes a durably refused operation without granting task completion", async t => {
  const f = await fixture(t, { outcome: "blocked" });
  for (const [name, receipt, outcome, override, expected] of [
    ["native refused", f.expectedReceipt, "blocked", "refused", "completed"],
    ["ordinary blocked", f.expectedReceipt, "blocked", null, "blocked"],
    ["failed is not refused", f.expectedReceipt, "failed", "refused", "blocked"],
    ["no durable receipt", undefined, "blocked", "refused", "unknown"],
    ["conflicting approval", { ...f.expectedReceipt, details: { ...f.expectedReceipt.details, completionApproved: true } }, "blocked", "refused", "blocked"],
    ["conflicting gate", { ...f.expectedReceipt, details: { ...f.expectedReceipt.details, gateDecision: "pass" } }, "blocked", "refused", "blocked"]
  ]) {
    const observed = receiptStream(() => receipt, () => {}, "session-revision.receipt", outcome, override);
    const settled = observed.filter(event => event.kind === "operation.settled");
    assert.equal(settled.length, 1, name);
    assert.equal(settled[0].payload.settlement, expected, name);
    assert.notEqual(settled[0].payload.taskStatus, "completed", name);
  }
  for (const configure of [stream => stream.markAborted(), stream => stream.markError("fixture-error"),
    stream => stream.markBlocked("fixture-block")]) {
    const observed = receiptStream(() => f.expectedReceipt, configure, "session-revision.receipt", "blocked", "refused");
    assert.notEqual(observed.find(event => event.kind === "operation.settled").payload.settlement, "completed");
  }
});

test("reconnected read-only delivery recovery settles the observed durable receipt without a second model turn", async (t) => {
  const f = await fixture(t);
  const sent = await f.supervisor.send(f.sessionRef, { delivery: "new-operation", message: recovery,
    messageRequestId: "request.recovery", expectedOperationRef: null }, "session-revision.before");
  for (let count = 0; count < 100 && !f.observed.some((event) => event.kind === "operation.settled"); count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const branch = f.supervisor.liveSessionManager(f.sessionRef).getBranch();
  assert.equal(f.hostEvents.filter((event) => event.type === "message_end" && event.message?.role === "custom").length, 1);
  assert.equal(branch.filter((entry) => entry.type === "custom_message").length, 1);
  assert.equal(branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length, 1);
  assert.deepEqual(f.counters(), { providerTurns: 0, beganTurns: 0, clearedBoundaries: 0 });
  assert.equal(f.telemetry.at(-1).event, "uncertain_send_terminal_receipt_reemitted");
  assert.deepEqual(activeSessionTask(f.cwd, f.task.sessionId), f.task);
  const settlements = f.observed.filter((event) => event.kind === "operation.settled");
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].payload.operationRef, sent.operationRef);
  assert.equal(settlements[0].payload.messageRequestId, "request.recovery");
  assert.equal(settlements[0].payload.settlement, "completed");
  assert.equal(f.observed.filter((event) => event.kind === "message.completed").length, 1);
  assert.equal(f.observed.some((event) => event.kind === "message.delta"), false, "custom receipts never stream as assistant text");
  for (const event of f.observed) assert.equal(validateFixture(registry, "gateway-protocol-v1", event).valid, true);
  await f.supervisor.release(f.sessionRef);
  const persisted = f.host.SessionManager.open(f.manager.getSessionFile(), f.sessionDir).getBranch();
  const transcript = project(persisted, f.expectedReceipt, f.sessionRef);
  assert.equal(validateFixture(registry, "transcript-v1", transcript).valid, true);
  assert.equal(transcript.page.truncated, false);
  const turn = transcript.items.filter((item) => item.messageRequestId === "request.recovery");
  assert.deepEqual(turn.map((item) => item.role), ["user", "custom"]);
  assert.equal(turn[0].content.text, recovery);
  assert.equal(turn[1].content.text, f.expectedReceipt.content);
  assert.equal(turn[1].parentMessageRef, turn[0].messageRef);
  assert.equal(turn.every((item) => item.agentOperationId === sent.operationRef), true);
  const inspection = new SessionInspectionRegistry({ gatewayInstanceRef: "gateway_receipt_inspection", key: f.key,
    packageRoot: repositoryRoot, host: f.host, listSessions: () => f.host.SessionManager.list(f.cwd, f.sessionDir) });
  const provider = await inspection.provider(f.sessionRef);
  const inspected = await provider.transcript(null, 100);
  assert.deepEqual(inspected.items.filter((item) => item.messageRequestId === "request.recovery")
    .map((item) => [item.role, item.content.text]), [["user", recovery], ["custom", f.expectedReceipt.content]]);
  assert.deepEqual(f.counters(), { providerTurns: 0, beganTurns: 0, clearedBoundaries: 0 });
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("receipt-lifecycle-timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function confirmer(entries) {
  return (type, data) => entries.push({ type: "custom", id: "confirmation.recovery",
    timestamp: "2026-08-13T14:00:02.000Z", customType: type, data });
}

function receiptCommitter(f, entries, appendCustomEntry = confirmer(entries)) {
  return terminalDeliveryReceiptCommitter({ cwd: f.cwd, sessionId: f.task.sessionId, operationRef: "operation.recovery",
    messageRequestId: "request.recovery", request: recovery, entries: () => entries, persistedEntries: () => entries, appendCustomEntry });
}

test("reconnect before and after actual host settlement reuses one dispatch and one durable custom result", async (t) => {
  const f = await fixture(t);
  let releaseProjection, projectionEntered = false;
  const projection = new Promise((resolve) => { releaseProjection = resolve; });
  f.supervisor.setProjectionReader(async () => { projectionEntered = true; await projection;
    return { sessionRevision: "session-revision.receipt", liveState: "idle" }; });
  t.after(() => releaseProjection());
  const sent = await f.supervisor.send(f.sessionRef, { delivery: "new-operation", message: recovery,
    messageRequestId: "request.recovery", expectedOperationRef: null }, "session-revision.before", { deferDispatch: true });
  const beforeDispatch = f.events.stateVersion;
  sent.dispatch(); sent.dispatch();
  await waitFor(() => projectionEntered);
  assert.equal(project(f.supervisor.liveSessionManager(f.sessionRef).getBranch(), f.expectedReceipt).items
    .some((item) => item.messageRequestId === "request.recovery"), false, "receipt is not confirmed before settlement");
  assert.equal(f.events.replay(beforeDispatch).events.some((event) => event.kind === "operation.settled"), false);
  releaseProjection();
  await waitFor(() => f.observed.some((event) => event.kind === "operation.settled"));
  const after = f.events.replay(beforeDispatch);
  assert.equal(after.events.filter((event) => event.kind === "operation.settled").length, 1);
  assert.deepEqual(f.events.replay(after.currentSequence).events, []);
  assert.equal(f.hostEvents.filter((event) => event.type === "message_end" && event.message?.role === "custom").length, 1);
  await f.supervisor.release(f.sessionRef);
  const disk = f.host.SessionManager.open(f.manager.getSessionFile(), f.sessionDir).getBranch();
  const items = project(disk, f.expectedReceipt).items;
  const current = conversationTranscriptItems(items).filter((item) => item.messageRequestId === "request.recovery");
  assert.deepEqual(current.map((item) => item.role), ["user", "custom"]);
  assert.equal(persistedLiveConversationHasFinal(items, recovery,
    { operationRef: sent.operationRef, messageRequestId: "request.recovery" }), true);
  assert.deepEqual(f.counters(), { providerTurns: 0, beganTurns: 0, clearedBoundaries: 0 });
});

test("actual blocked receipt is delivered as custom without completing the task", async (t) => {
  const f = await fixture(t, { outcome: "blocked" });
  await f.supervisor.send(f.sessionRef, { delivery: "new-operation", message: recovery,
    messageRequestId: "request.recovery", expectedOperationRef: null }, "session-revision.before");
  await waitFor(() => f.observed.some((event) => event.kind === "operation.settled"));
  const settled = f.observed.find((event) => event.kind === "operation.settled");
  assert.equal(settled.payload.settlement, "blocked");
  assert.equal(f.observed.some((event) => event.kind === "message.completed" || event.kind === "message.delta"), false);
  const items = project(f.supervisor.liveSessionManager(f.sessionRef).getBranch(), f.expectedReceipt).items;
  assert.equal(items.at(-1).role, "custom");
  assert.match(items.at(-1).content.text, /Completion approved: no/);
  assert.equal(activeSessionTask(f.cwd, f.task.sessionId).trace.outcome, "blocked");
  assert.deepEqual(f.counters(), { providerTurns: 0, beganTurns: 0, clearedBoundaries: 0 });
});

test("cancel after actual custom receipt but before settlement never confirms or displays it as completed", async (t) => {
  let f, sent, cancellation;
  f = await fixture(t, { observeHost(event) {
    if (event.type === "message_end" && event.message?.role === "custom") {
      cancellation = f.supervisor.abort(f.sessionRef, sent.operationRef, true);
    }
  } });
  sent = await f.supervisor.send(f.sessionRef, { delivery: "new-operation", message: recovery,
    messageRequestId: "request.recovery", expectedOperationRef: null }, "session-revision.before", { deferDispatch: true });
  sent.dispatch();
  await waitFor(() => Boolean(cancellation));
  await cancellation;
  await waitFor(() => f.observed.some((event) => event.kind === "operation.settled"));
  assert.equal(f.observed.find((event) => event.kind === "operation.settled").payload.settlement, "aborted");
  const branch = f.supervisor.liveSessionManager(f.sessionRef).getBranch();
  assert.equal(branch.some((entry) => entry.customType === TERMINAL_DELIVERY_CONFIRMATION_TYPE), false);
  assert.equal(project(branch, f.expectedReceipt).items.some((item) => item.messageRequestId === "request.recovery"), false);
  assert.equal(f.observed.some((event) => event.kind === "message.completed" || event.kind === "message.delta"), false);
  assert.deepEqual(f.counters(), { providerTurns: 0, beganTurns: 0, clearedBoundaries: 0 });
});

test("cancel before dispatch leaves no receipt, no model turn and no replay", async (t) => {
  const f = await fixture(t);
  const sent = await f.supervisor.send(f.sessionRef, { delivery: "new-operation", message: recovery,
    messageRequestId: "request.recovery", expectedOperationRef: null }, "session-revision.before", { deferDispatch: true });
  assert.equal(sent.cancel(), true); sent.dispatch(); sent.dispatch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.hostEvents.length, 0);
  assert.equal(f.supervisor.liveSessionManager(f.sessionRef).getBranch().some((entry) => entry.type === "custom_message"), false);
  assert.equal(f.observed.some((event) => event.kind === "message.completed"), false);
});

test("receipt matching rejects forged, stale, cross-request and cross-operation evidence", async (t) => {
  const f = await fixture(t), message = customMessage(f.expectedReceipt);
  const mutations = [
    ["wrong operation", (entries) => { entries[0].data.operationRef = "operation.old"; }],
    ["wrong request", (entries) => { entries[0].data.messageRequestId = "request.old"; }],
    ["changed request text", (entries) => { entries[0].data.terminalDeliveryRequest += " extra text"; }],
    ["unhandled request", (entries) => { entries[0].data.terminalDeliveryRequest = "Start a different task."; }],
    ["missing receipt", (entries) => { entries.pop(); }],
    ["forged task", (entries) => { entries[1].details.taskId = "forged-task"; }],
    ["forged run", (entries) => { entries[1].details.taskRunId = "forged-run"; }],
    ["forged content", (entries) => { entries[1].content += " forged"; }],
    ["forged approval", (entries) => { entries[1].details.completionApproved = false; }],
    ["replayed receipt", (entries) => { entries[1].details.replayed = true; }],
    ["model turn claimed", (entries) => { entries[1].details.modelTurnStarted = true; }],
    ["hidden receipt", (entries) => { entries[1].display = false; }],
    ["other custom type", (entries) => { entries[1].customType = "other"; }],
    ["invalid entry time", (entries) => { entries[1].timestamp = "not-a-time"; }],
    ["duplicate entry id", (entries) => { entries[1].id = entries[0].id; }],
    ["missing entry id", (entries) => { delete entries[1].id; }],
    ["reordered entries", (entries) => { entries.reverse(); }],
    ["intervening work", (entries) => { entries.splice(1, 0, { type: "custom", id: "intervening" }); }],
    ["later work", (entries) => { entries.push({ type: "custom", id: "later" }); }],
    ["duplicate request", (entries) => { entries.push({ ...structuredClone(entries[0]), id: "duplicate" }); }]
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const entries = receiptEntries(f.expectedReceipt); mutate(entries);
    const commit = receiptCommitter(f, entries);
    assert.equal(commit(message), undefined);
    assert.equal(entries.some((entry) => entry.customType === TERMINAL_DELIVERY_CONFIRMATION_TYPE), false);
  });
  const entries = receiptEntries(f.expectedReceipt), commit = receiptCommitter(f, entries);
  assert.equal(commit({ ...message, content: "forged observed content" }), undefined);
  assert.equal(commit({ ...message, role: "assistant" }), undefined);
  assert.equal(commit(undefined), undefined);
  assert.deepEqual(commit(message), f.expectedReceipt);
  assert.equal(commit(message), undefined, "same operation cannot acknowledge twice");
  assert.equal(terminalDeliveryPairs(entries, f.expectedReceipt, entries).length, 1);
  assert.equal(terminalDeliveryRequest(recovery, [{}]), undefined);
  assert.equal(terminalDeliveryPairs(new Array(50_001), f.expectedReceipt).length, 0);
});

test("transcript projection requires exact current task receipt and durable delivery confirmation", async (t) => {
  const f = await fixture(t), entries = receiptEntries(f.expectedReceipt);
  assert.equal(project(entries, f.expectedReceipt).items.length, 0);
  assert.deepEqual(receiptCommitter(f, entries)(customMessage(f.expectedReceipt)), f.expectedReceipt);
  assert.deepEqual(project(entries, f.expectedReceipt).items.map((item) => item.role), ["user", "custom"]);
  for (const [name, mutate] of [
    ["wrong confirmed request", (items) => { items[2].data.messageRequestId = "request.old"; }],
    ["wrong confirmed operation", (items) => { items[2].data.operationRef = "operation.old"; }],
    ["wrong confirmed receipt", (items) => { items[2].data.receiptEntryId = "receipt.old"; }],
    ["wrong confirmed task", (items) => { items[2].data.taskRunId = "task.old"; }],
    ["missing confirmation", (items) => { items.pop(); }],
    ["duplicate confirmation id", (items) => { items[2].id = items[1].id; }],
    ["nonadjacent confirmation", (items) => { items.splice(2, 0, { type: "custom", id: "work" }); }]
  ]) await t.test(name, () => {
    const values = structuredClone(entries); mutate(values);
    assert.equal(project(values, f.expectedReceipt).items.length, 0);
  });
  assert.equal(project(entries, undefined).items.length, 0);
  const wrong = { ...f.expectedReceipt, details: { ...f.expectedReceipt.details, taskId: "wrong" } };
  assert.equal(project(entries, wrong).items.length, 0);
  const unrelated = [{ type: "message", id: "forged", timestamp: "2026-08-13T14:00:01.000Z",
    message: { role: "custom", content: f.expectedReceipt.content } }];
  assert.equal(project(unrelated, f.expectedReceipt).items.length, 0, "custom is not a general transcript message admission route");
  const nextTask = writeTaskContract(f.cwd, { ...f.task, taskId: "new-task", taskRunId: "new-task-pending",
    trace: { outcome: "pending" } });
  bindSessionTask(f.cwd, nextTask.sessionId, nextTask.sessionName, nextTask);
  const freshEntries = receiptEntries(f.expectedReceipt);
  assert.equal(receiptCommitter(f, freshEntries)(customMessage(f.expectedReceipt)), undefined);
});

test("settlement cannot commit a receipt after abort, errors, wrong observed operation, missing projection or real agent work", async (t) => {
  const f = await fixture(t), message = customMessage(f.expectedReceipt);
  const deliver = (stream) => { stream.observe({ type: "message_start", message }); stream.observe({ type: "message_end", message }); };
  for (const [name, configure, revision, outcome, expected] of [
    ["missing projection", deliver, null, "completed", "unknown"],
    ["pending task", deliver, "session.receipt", "pending", "unknown"],
    ["missing task", deliver, "session.receipt", null, "unknown"],
    ["aborted operation", (stream) => { deliver(stream); stream.markAborted(); }, "session.receipt", "completed", "aborted"],
    ["failed operation", (stream) => { deliver(stream); stream.markError(); }, "session.receipt", "completed", "error"],
    ["agent turn", (stream) => { stream.observe({ type: "agent_start" }); deliver(stream); }, "session.receipt", "completed", "unknown"],
    ["tool execution", (stream) => { stream.observe({ type: "tool_execution_start", toolCallId: "tool", toolName: "read" }); deliver(stream); },
      "session.receipt", "completed", "unknown"],
    ["wrong observed operation", (stream) => { stream.observe({ type: "message_end", message, operationRef: "operation.other" }); },
      "session.receipt", "completed", "unknown"],
    ["no observation", () => {}, "session.receipt", "completed", "unknown"]
  ]) await t.test(name, () => {
    const entries = receiptEntries(f.expectedReceipt);
    const events = receiptStream(receiptCommitter(f, entries), configure, revision, outcome);
    assert.equal(events.at(-1).payload.settlement, expected);
    assert.equal(events.filter((event) => event.kind === "operation.settled").length, 1);
    assert.equal(events.some((event) => event.kind === "message.completed" || event.kind === "message.delta"), false);
    assert.equal(entries.some((entry) => entry.customType === TERMINAL_DELIVERY_CONFIRMATION_TYPE), false);
  });
});

test("persistence failure and silent no-op persistence withhold receipt settlement", async (t) => {
  const f = await fixture(t), message = customMessage(f.expectedReceipt);
  for (const append of [() => { throw new Error("disk-write-failed"); }, () => {}]) {
    const entries = receiptEntries(f.expectedReceipt);
    const events = receiptStream(receiptCommitter(f, entries, append), (stream) => stream.observe({ type: "message_end", message }));
    assert.equal(events.at(-1).payload.settlement, "unknown");
    assert.equal(project(entries, f.expectedReceipt).items.length, 0);
  }
});

test("actual persisted host session with no prior assistant confirms custom receipt on disk before acknowledgment", async (t) => {
  const f = await fixture(t, { noAssistant: true });
  const diskAtAck = [];
  f.events.subscribe((event) => {
    if (event.kind === "message.completed" || event.kind === "operation.settled") {
      const disk = f.host.SessionManager.open(f.manager.getSessionFile(), f.sessionDir).getBranch();
      diskAtAck.push({ kind: event.kind, pairs: terminalDeliveryPairs(disk, f.expectedReceipt, disk).length,
        assistants: disk.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length });
    }
  });
  await f.supervisor.send(f.sessionRef, { delivery: "new-operation", message: recovery,
    messageRequestId: "request.recovery", expectedOperationRef: null }, "session-revision.before");
  await waitFor(() => diskAtAck.length === 2);
  assert.deepEqual(diskAtAck, [{ kind: "message.completed", pairs: 1, assistants: 0 },
    { kind: "operation.settled", pairs: 1, assistants: 0 }]);
  assert.deepEqual(f.counters(), { providerTurns: 0, beganTurns: 0, clearedBoundaries: 0 });
});

test("brand-new unflushed Pi session fails closed despite in-memory custom history", async (t) => {
  const f = await fixture(t);
  const manager = f.host.SessionManager.create(f.cwd, f.sessionDir, { id: f.task.sessionId });
  const file = manager.getSessionFile();
  manager.appendCustomEntry(WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE, { schemaVersion: 1,
    messageRequestId: "request.recovery", operationRef: "operation.recovery", terminalDeliveryRequest: recovery });
  manager.appendCustomMessageEntry(f.expectedReceipt.customType, f.expectedReceipt.content, true, f.expectedReceipt.details);
  assert.equal(manager.isPersisted(), true, "this flag only means persistence is configured");
  assert.equal(fs.existsSync(file), false, "Pi defers the initial file without an assistant message");
  const commit = terminalDeliveryReceiptCommitter({ cwd: f.cwd, sessionId: f.task.sessionId,
    operationRef: "operation.recovery", messageRequestId: "request.recovery", request: recovery,
    entries: () => manager.getBranch(), persistedEntries: () => terminalDeliverySessionEntries(file, f.task.sessionId),
    appendCustomEntry: (type, data) => manager.appendCustomEntry(type, data) });
  assert.equal(commit(customMessage(f.expectedReceipt)), undefined);
  assert.equal(manager.getBranch().some((entry) => entry.customType === TERMINAL_DELIVERY_CONFIRMATION_TYPE), false);
  assert.equal(fs.existsSync(file), false, "delivery must not invent a model message to trigger flush");
});

test("a confirmation appended only in memory cannot become a live or reconnected success", async (t) => {
  const f = await fixture(t), entries = receiptEntries(f.expectedReceipt), disk = structuredClone(entries);
  const commit = terminalDeliveryReceiptCommitter({ cwd: f.cwd, sessionId: f.task.sessionId,
    operationRef: "operation.recovery", messageRequestId: "request.recovery", request: recovery,
    entries: () => entries, persistedEntries: () => disk, appendCustomEntry: confirmer(entries) });
  assert.equal(commit(customMessage(f.expectedReceipt)), undefined);
  assert.equal(entries.length, 3);
  assert.equal(project(entries, f.expectedReceipt, "session.receipt", disk).items.length, 0);
});

test("disk receipt reader rejects wrong session, incomplete append, corrupt and oversized history", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-disk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl"), header = { type: "session", version: 3, id: "session" };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify({ type: "custom", id: "one" })}\n`);
  assert.equal(terminalDeliverySessionEntries(file, "session").length, 1);
  assert.deepEqual(terminalDeliverySessionEntries(file, "wrong"), []);
  fs.appendFileSync(file, "{\"type\":");
  assert.deepEqual(terminalDeliverySessionEntries(file, "session"), []);
  fs.appendFileSync(file, "\n");
  assert.deepEqual(terminalDeliverySessionEntries(file, "session"), []);
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  assert.deepEqual(terminalDeliverySessionEntries(file, "session"), []);
});

test("actual Pi process interruption preserves confirmed receipt without acknowledging earlier windows", async (t) => {
  const host = await loadPinnedPiHost(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
    .peerDependencies["@earendil-works/pi-coding-agent"]);
  for (const phase of ["before-confirmation", "after-confirmation", "after-settlement"]) await t.test(phase, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-crash-")), marker = path.join(root, "checkpoint.json");
    const child = fork(import.meta.filename, [], { stdio: "ignore", execArgv: [],
      env: { ...process.env, PIAGENT_RECEIPT_CRASH_CHILD: phase, PIAGENT_RECEIPT_CRASH_ROOT: root } });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(marker)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`crash-child-not-ready:${phase}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const checkpoint = JSON.parse(fs.readFileSync(marker, "utf8"));
      child.kill("SIGKILL");
      assert.equal((await exited).signal, "SIGKILL");
      const disk = host.SessionManager.open(checkpoint.file).getBranch();
      const pairs = terminalDeliveryPairs(disk, checkpoint.receipt, disk);
      assert.equal(pairs.length, phase === "before-confirmation" ? 0 : 1);
      assert.equal(checkpoint.settlements, phase === "after-settlement" ? 1 : 0);
      assert.deepEqual(checkpoint.counters, { providerTurns: 0, beganTurns: 0, clearedBoundaries: 0 });
      assert.equal(disk.some((entry) => entry.type === "message" && entry.message.role === "assistant"), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

} else {
  const phase = process.env.PIAGENT_RECEIPT_CRASH_CHILD, root = process.env.PIAGENT_RECEIPT_CRASH_ROOT;
  const f = await fixture({ after() {} }, { root, noAssistant: true });
  const pause = () => {
    const marker = path.join(root, "checkpoint.json"), pending = `${marker}.pending`;
    fs.writeFileSync(pending, JSON.stringify({ file: f.manager.getSessionFile(), receipt: f.expectedReceipt,
      counters: f.counters(), settlements: f.observed.filter((event) => event.kind === "operation.settled").length }));
    fs.renameSync(pending, marker);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  await f.supervisor.acquire(f.sessionRef);
  const manager = f.supervisor.liveSessionManager(f.sessionRef), append = manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry = (type, data) => {
    if (type === TERMINAL_DELIVERY_CONFIRMATION_TYPE && phase === "before-confirmation") pause();
    const id = append(type, data);
    if (type === TERMINAL_DELIVERY_CONFIRMATION_TYPE && phase === "after-confirmation") pause();
    return id;
  };
  f.events.subscribe((event) => { if (event.kind === "operation.settled" && phase === "after-settlement") pause(); });
  await f.supervisor.send(f.sessionRef, { delivery: "new-operation", message: recovery,
    messageRequestId: "request.recovery", expectedOperationRef: null }, "session-revision.before");
}

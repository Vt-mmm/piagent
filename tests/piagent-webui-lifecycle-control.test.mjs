import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindSessionTask, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { appendTaskJournalEvent } from "../packages/piagent-core/extensions/task-journal.js";
import { inspectTaskControlState } from "../packages/piagent-core/runtime/inspection/task-control-journal.ts";
import { RuntimeEventStore } from "../packages/piagent-core/runtime/inspection/runtime-event-store.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { LifecycleController } from "../packages/piagent-webui/extension/lifecycle-controller.ts";
import { lifecycleRuntimeDraft } from "../packages/piagent-webui/extension/lifecycle-event-adapter.ts";
import { SameSessionPiBridge, chatContentDigest, controlActionDigest } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { CoreInspectionProvider } from "../packages/piagent-webui/server/core-inspection-provider.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-lifecycle-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]); execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]); fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", cwd, "add", "tracked.txt"]); execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  const createdAt = "2026-08-14T00:00:00.000Z", taskInput = { schemaVersion: 2,
    taskRunId: "task-20260814000000-0123456789", taskId: "task", sessionId: "session-lifecycle", sessionName: "TASK lifecycle",
    changeMode: "source-change", attempt: 1, maxAttempts: 3, previousAttempts: [], summary: "Lifecycle fixture", riskLane: "normal",
    expectedOutput: "Lifecycle control is durable", acceptanceCriteria: ["Lifecycle transitions are exact"], scope: ["tracked.txt"], outOfScope: [],
    protectedPaths: [], requiredContext: [], contextManifest: [], memoryCitations: [], mcpCapabilities: [], verifyGroup: "source",
    verifyCommands: ["node --test"], workPlan: [], reviewLenses: [], workingTreeDigestAlgorithm: "wt-content-v2", baselineChangedFiles: [],
    baselineFileDigests: {}, observedChangedFiles: [], finalWorkingTreeFiles: [], finalFileDigests: {}, changedFiles: [], verifyEvidence: [],
    trace: { outcome: "pending" }, createdAt, updatedAt: createdAt };
  taskInput.authoritySnapshot = createBoundTaskAuthority({ taskId: taskInput.taskId, taskRunId: taskInput.taskRunId, createdAt });
  const task = writeTaskContract(cwd, taskInput);
  bindSessionTask(cwd, task.sessionId, task.sessionName, task);
  const entries = []; let idle = true, aborts = 0, sends = 0, approvalsCancelled = 0, autoDispatch = false, rejectSend = false;
  const ctx = { cwd, sessionManager: { getSessionId: () => task.sessionId, getBranch: () => structuredClone(entries),
    getLeafId: () => entries.at(-1)?.id ?? null, getLeafEntry: () => structuredClone(entries.at(-1) ?? null) }, isIdle: () => idle,
    hasPendingMessages: () => false, abort() { aborts += 1; } };
  const pi = { appendEntry(customType, data) { entries.push({ id: `e${entries.length + 1}`, type: "custom", customType, data }); },
    sendUserMessage(text) { sends += 1; if (rejectSend) throw new Error("dispatch rejected"); if (!autoDispatch) return;
      const parentId = entries.at(-1)?.id ?? null, message = { role: "user", content: text };
      entries.push({ id: `e${entries.length + 1}`, parentId, type: "message", message });
      bridge.observeInput({ source: "extension", text }, ctx); idle = false; bridge.observeAgentStart(ctx); } };
  let bridge;
  const taskFacts = () => { const control = inspectTaskControlState(cwd, task); return { taskId: task.taskId, taskRunId: task.taskRunId,
    taskRevision: "task-rev.lifecycle", controlRevision: control.controlRevision, controlState: control.state }; };
  bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime.lifecycle", taskFacts }); bridge.bind(ctx);
  const lifecycle = new LifecycleController({ bridge, runtimeInstanceId: "runtime.lifecycle", task: () => task,
    abort: (value) => value.abort(), cancelApprovals: () => { approvalsCancelled += 1; },
    treeDigest: () => `wt-content-v2:${"a".repeat(64)}` }); lifecycle.bind(ctx);
  const lifecycleDrafts = []; lifecycle.subscribe((event) => { const draft = lifecycleRuntimeDraft(event, bridge.snapshot(), new Date().toISOString());
    if (draft) lifecycleDrafts.push(draft); });
  return { cwd, task, ctx, bridge, lifecycle, lifecycleDrafts, get aborts() { return aborts; }, get sends() { return sends; },
    get entries() { return structuredClone(entries); }, get approvalsCancelled() { return approvalsCancelled; }, setIdle(value) { idle = value; },
    enableAutoDispatch() { autoDispatch = true; }, rejectDispatch() { rejectSend = true; } };
}
function command(surface, action, overrides = {}) {
  const snapshot = surface.bridge.snapshot(), now = new Date(), value = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command",
    commandId: overrides.commandId ?? `command_${action.split(".")[1]}`, idempotencyKey: overrides.idempotencyKey ?? `lifecycle-${action}-000000000000000000000000`,
    requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    capabilityScope: action === "lifecycle.resume-and-continue" ? "control.resumeAndContinue" : "control.lifecycle", action,
    actionDigest: "", identity: structuredClone(snapshot.identity), expectedRevisions: { ...structuredClone(snapshot.revisions), workspacePreimage: null,
      indexPreimage: null, patchPreimage: null }, payload: action === "lifecycle.stop" ? { requestedScope: "current-agent-operation" }
      : action === "lifecycle.pause" ? { safePointPolicy: "after-current-atomic-unit" }
        : action === "lifecycle.resume-and-continue" ? { messageRequestId: "message_request_continue", capabilityAction: "send",
          delivery: "new-operation", text: "Continue from the verified checkpoint.", attachmentRefs: [], contentDigest: "" } : {} };
  if (action === "lifecycle.resume-and-continue") value.payload.contentDigest = chatContentDigest(value.payload);
  value.actionDigest = controlActionDigest(value); return value;
}
function valid(receipt) { const result = validateFixture(registry, "control-command-v1", receipt); assert.equal(result.valid, true, result.errors); }

test("Pause persists a safe-point barrier, keeps task pending and deduplicates the terminal receipt", async (t) => {
  const current = fixture(t), value = command(current, "lifecycle.pause");
  const receipt = await current.lifecycle.execute(value); valid(receipt); assert.equal(receipt.resultCode, "paused");
  const control = inspectTaskControlState(current.cwd, current.task); assert.equal(control.state, "paused"); assert.equal(control.dispatchBlocked, true);
  assert.equal(current.task.trace.outcome, "pending"); assert.equal(current.aborts, 0); assert.equal(current.approvalsCancelled, 1);
  assert.equal(current.sends, 0); assert.equal(current.lifecycle.dispatchAllowed(current.ctx), false);
  const replay = await current.lifecycle.execute(value); valid(replay); assert.equal(replay.deduplicated, true); assert.equal(replay.resultCode, "paused");
});

test("Pause waits for the atomic tool, then aborts the remainder and settles only after the exact operation", async (t) => {
  const current = fixture(t); current.setIdle(false); current.bridge.observeAgentStart(current.ctx); current.lifecycle.observeAgentStart(current.ctx);
  current.lifecycle.observeToolStart(current.ctx); const value = command(current, "lifecycle.pause"), accepted = await current.lifecycle.execute(value);
  valid(accepted); assert.equal(accepted.phase, "accepted"); assert.equal(accepted.resultCode, "pause-requested"); assert.equal(current.aborts, 0);
  current.lifecycle.observeToolEnd(current.ctx); assert.equal(current.aborts, 1); assert.equal(inspectTaskControlState(current.cwd, current.task).state, "pause-requested");
  const operation = current.bridge.snapshot().identity.agentOperationId; current.bridge.observeAgentSettled(current.ctx); current.setIdle(true);
  current.lifecycle.observeAgentSettled(current.ctx, operation); assert.equal(inspectTaskControlState(current.cwd, current.task).state, "paused");
  const replay = await current.lifecycle.execute(value); valid(replay); assert.equal(replay.resultCode, "paused");
});

test("Resume cancels a pending pause worker before abort and creates no dispatch", async (t) => {
  const current = fixture(t); current.setIdle(false); current.bridge.observeAgentStart(current.ctx); current.lifecycle.observeAgentStart(current.ctx);
  current.lifecycle.observeToolStart(current.ctx); const paused = await current.lifecycle.execute(command(current, "lifecycle.pause")); assert.equal(paused.resultCode, "pause-requested");
  const resumed = await current.lifecycle.execute(command(current, "lifecycle.resume", { commandId: "command_resume_cancel",
    idempotencyKey: "resume-cancel-key-000000000000000000000" })); valid(resumed); assert.equal(resumed.resultCode, "pause-cancelled");
  current.lifecycle.observeToolEnd(current.ctx); assert.equal(current.aborts, 0); assert.equal(current.sends, 0);
  assert.equal(inspectTaskControlState(current.cwd, current.task).state, "active");
});

test("Resume & Continue resumes and dispatches exactly one operator message with durable replay", async (t) => {
  const current = fixture(t); await current.lifecycle.execute(command(current, "lifecycle.pause")); current.enableAutoDispatch();
  const value = command(current, "lifecycle.resume-and-continue"), receipt = await current.lifecycle.execute(value);
  valid(receipt); assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "dispatch-observed");
  assert.equal(inspectTaskControlState(current.cwd, current.task).state, "active"); assert.equal(current.sends, 1);
  assert.equal(current.entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").length, 1);
  const replay = await current.lifecycle.execute(value); valid(replay); assert.equal(replay.resultCode, "dispatch-observed");
  assert.equal(replay.deduplicated, true); assert.equal(current.sends, 1);
});

test("Resume & Continue keeps the task active and the message retry-safe when dispatch is rejected", async (t) => {
  const current = fixture(t); await current.lifecycle.execute(command(current, "lifecycle.pause")); current.rejectDispatch();
  const value = command(current, "lifecycle.resume-and-continue", { commandId: "command_resume_not_dispatched",
    idempotencyKey: "resume-not-dispatched-key-000000000000000" });
  const receipt = await current.lifecycle.execute(value); valid(receipt); assert.equal(receipt.phase, "uncertain");
  assert.equal(receipt.resultCode, "resumed-not-dispatched"); assert.equal(inspectTaskControlState(current.cwd, current.task).state, "active");
  assert.equal(current.entries.filter((entry) => entry.type === "message").length, 0);
  const replay = await current.lifecycle.execute(value); valid(replay); assert.equal(replay.deduplicated, true); assert.equal(current.sends, 1);
});

test("Resume & Continue cannot smuggle a normal chat dispatch while the task is active", async (t) => {
  const current = fixture(t), receipt = await current.lifecycle.execute(command(current, "lifecycle.resume-and-continue", {
    commandId: "command_compound_active", idempotencyKey: "compound-active-key-00000000000000000000" }));
  valid(receipt); assert.equal(receipt.phase, "rejected"); assert.equal(receipt.resultCode, "capability-unavailable");
  assert.equal(current.sends, 0); assert.equal(inspectTaskControlState(current.cwd, current.task).state, "active");
});

test("Stop calls native abort once and cannot claim stopped before matching settlement", async (t) => {
  const current = fixture(t); current.setIdle(false); current.bridge.observeAgentStart(current.ctx); current.lifecycle.observeAgentStart(current.ctx);
  const operation = current.bridge.snapshot().identity.agentOperationId, value = command(current, "lifecycle.stop"), promise = current.lifecycle.execute(value);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(current.aborts, 1); assert.equal(inspectTaskControlState(current.cwd, current.task).stopPending, true);
  assert.equal(await Promise.race([promise.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 20))]), true,
    "void abort must not settle Stop before agent_settled");
  current.bridge.observeAgentSettled(current.ctx); current.setIdle(true); current.lifecycle.observeAgentSettled(current.ctx, operation);
  const receipt = await promise; valid(receipt); assert.equal(receipt.resultCode, "stopped"); assert.equal(receipt.phase, "settled");
  assert.equal(current.task.trace.outcome, "pending"); const replay = await current.lifecycle.execute(value);
  assert.equal(replay.resultCode, "stopped"); assert.equal(replay.deduplicated, true); assert.equal(current.aborts, 1);
});

test("malformed and stale lifecycle commands fail closed without a journal transition", async (t) => {
  const current = fixture(t), malformed = command(current, "lifecycle.pause"); malformed.requestedAt = "2026-99-99T00:00:00.000Z";
  const invalid = await current.lifecycle.execute(malformed); valid(invalid); assert.equal(invalid.resultCode, "invalid-command");
  const stale = command(current, "lifecycle.pause", { commandId: "command_stale", idempotencyKey: "stale-lifecycle-key-0000000000000000000" });
  stale.expectedRevisions.controlRevision = "control-rev.stale"; stale.actionDigest = controlActionDigest(stale);
  const rejected = await current.lifecycle.execute(stale); valid(rejected); assert.equal(rejected.resultCode, "stale-revision");
  assert.equal(inspectTaskControlState(current.cwd, current.task).state, "active"); assert.equal(current.aborts, 0);
});

test("lifecycle CAS uses only runtime, task and control revisions", async (t) => {
  const current = fixture(t), value = command(current, "lifecycle.pause");
  value.expectedRevisions.workspaceRevision = "workspace-rev.browser-observed";
  value.expectedRevisions.indexRevision = "index-rev.browser-observed";
  value.actionDigest = controlActionDigest(value);
  const receipt = await current.lifecycle.execute(value); valid(receipt); assert.equal(receipt.resultCode, "paused");
  assert.equal(inspectTaskControlState(current.cwd, current.task).state, "paused");
});

test("lifecycle idempotency binds both the one-time key and canonical action", async (t) => {
  const current = fixture(t), first = command(current, "lifecycle.pause");
  const settled = await current.lifecycle.execute(first); assert.equal(settled.resultCode, "paused");
  const sameKey = structuredClone(first); sameKey.commandId = "command_pause_retry";
  const replay = await current.lifecycle.execute(sameKey); valid(replay); assert.equal(replay.resultCode, "paused");
  assert.equal(replay.commandId, first.commandId); assert.equal(replay.deduplicated, true);
  const changedKey = structuredClone(first); changedKey.idempotencyKey = "lifecycle-pause-conflict-00000000000000000";
  const mismatch = await current.lifecycle.execute(changedKey); valid(mismatch); assert.equal(mismatch.resultCode, "idempotency-payload-mismatch");
  const changedAction = { ...structuredClone(first), commandId: "command_resume_conflict", action: "lifecycle.resume", payload: {} };
  changedAction.actionDigest = controlActionDigest(changedAction);
  const actionMismatch = await current.lifecycle.execute(changedAction); valid(actionMismatch);
  assert.equal(actionMismatch.resultCode, "idempotency-payload-mismatch");
});

test("runtime replacement cannot replay old browser lifecycle authority", async (t) => {
  const current = fixture(t), oldCommand = command(current, "lifecycle.pause");
  assert.equal((await current.lifecycle.execute(oldCommand)).resultCode, "paused"); current.lifecycle.shutdown();
  const nextBridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() {} }, { runtimeInstanceId: "runtime.lifecycle-new",
    taskFacts: () => { const control = inspectTaskControlState(current.cwd, current.task); return { taskId: current.task.taskId,
      taskRunId: current.task.taskRunId, taskRevision: "task-rev.lifecycle", controlRevision: control.controlRevision, controlState: control.state }; } });
  nextBridge.bind(current.ctx); const next = new LifecycleController({ bridge: nextBridge, runtimeInstanceId: "runtime.lifecycle-new",
    task: () => current.task, abort: () => undefined, cancelApprovals: () => undefined,
    treeDigest: () => `wt-content-v2:${"a".repeat(64)}` }); next.bind(current.ctx);
  const receipt = await next.execute(oldCommand); valid(receipt); assert.equal(receipt.resultCode, "identity-mismatch");
});

test("schema-invalid durable lifecycle receipts fail closed on reconstruction", async (t) => {
  const current = fixture(t), value = command(current, "lifecycle.pause"), receipt = await current.lifecycle.execute(value);
  appendTaskJournalEvent(current.cwd, { eventType: "task-control.command-receipt", taskRunId: current.task.taskRunId,
    taskId: current.task.taskId, sessionId: current.task.sessionId, idempotencyKey: "corrupt-lifecycle-receipt",
    data: { schemaVersion: 1, commandId: value.commandId, idempotencyKeyDigest: receipt.idempotencyKeyDigest,
      actionDigest: value.actionDigest, receipt: { commandId: value.commandId, idempotencyKeyDigest: receipt.idempotencyKeyDigest,
        actionDigest: value.actionDigest } } });
  const rejected = await current.lifecycle.execute(value); valid(rejected); assert.equal(rejected.resultCode, "resync-required");
});

test("canonical snapshot advertises only the current lifecycle actions and remains schema-valid", async (t) => {
  const current = fixture(t), eventStore = { retention: () => ({ eventRetentionCount: 0, eventRetentionSeconds: 0 }), currentCursor: () => null,
    resyncRequired: () => false, replay: () => ({ state: "current", events: [], nextCursor: "cursor.current", latestCursor: "cursor.current", reasonCode: null }) };
  const provider = new CoreInspectionProvider({ cwd: current.cwd, sessionId: current.task.sessionId, runtimeInstanceId: "runtime.lifecycle",
    eventStore, task: () => current.task, sessionEntries: () => [], lifecycleControl: () => current.lifecycle.snapshot(),
    chatControl: () => { const value = current.bridge.snapshot(); return { ...value, heldCount: 0, queueRevision: value.revisions?.queueRevision ?? null }; } });
  const active = await provider.snapshot(), activeValidation = validateFixture(registry, "snapshot-v1", active);
  assert.equal(activeValidation.valid, true, activeValidation.errors); assert.equal(active.capabilities.capabilities["control.lifecycle"].actions.pause.available, true);
  assert.equal(active.capabilities.capabilities["control.lifecycle"].actions.resume.available, false);
  await current.lifecycle.execute(command(current, "lifecycle.pause")); provider.invalidate(); const paused = await provider.snapshot();
  const pausedValidation = validateFixture(registry, "snapshot-v1", paused); assert.equal(pausedValidation.valid, true, pausedValidation.errors);
  assert.equal(paused.session.controlState, "paused"); assert.equal(paused.capabilities.capabilities["control.lifecycle"].actions.resume.available, true);
  assert.equal(paused.capabilities.capabilities["control.chat"].actions.send.available, false);
  assert.equal(paused.capabilities.capabilities["control.resumeAndContinue"].status, "available");
});

test("journal transitions emit bounded schema-valid runtime facts", async (t) => {
  const current = fixture(t); await current.lifecycle.execute(command(current, "lifecycle.pause"));
  assert.deepEqual(current.lifecycleDrafts.map((draft) => draft.kind), ["task-control.pause-requested", "task-control.paused"]);
  const identity = current.bridge.snapshot().identity, store = new RuntimeEventStore({ projectRoot: current.cwd, projectRef: identity.projectRef,
    runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef });
  for (const draft of current.lifecycleDrafts) {
    const appended = store.append(draft); assert.equal(appended.appended, true);
    const result = validateFixture(registry, "runtime-event-v2", appended.event); assert.equal(result.valid, true, result.errors);
  }
});

test("a durable paused barrier survives runtime reconstruction without browser authority", async (t) => {
  const current = fixture(t); await current.lifecycle.execute(command(current, "lifecycle.pause")); current.lifecycle.shutdown();
  const nextBridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() { assert.fail("paused restart dispatched a message"); } }, {
    runtimeInstanceId: "runtime.lifecycle-restarted", taskFacts: () => { const control = inspectTaskControlState(current.cwd, current.task);
      return { taskId: current.task.taskId, taskRunId: current.task.taskRunId, taskRevision: "task-rev.lifecycle", controlRevision: control.controlRevision,
        controlState: control.state }; } });
  nextBridge.bind(current.ctx); const next = new LifecycleController({ bridge: nextBridge, runtimeInstanceId: "runtime.lifecycle-restarted",
    task: () => current.task, abort: () => undefined, cancelApprovals: () => undefined,
    treeDigest: () => `wt-content-v2:${"a".repeat(64)}` }); next.bind(current.ctx);
  assert.equal(next.snapshot().state, "paused"); assert.equal(next.dispatchAllowed(current.ctx), false);
});

test("a terminal task accepts conversation input and only the successor task-start tool", (t) => {
  const current = fixture(t); current.task.trace = { outcome: "blocked" };
  assert.equal(current.lifecycle.dispatchAllowed(current.ctx), false);
  assert.equal(current.lifecycle.inputAllowed(current.ctx), true);
  assert.equal(current.lifecycle.toolAllowed("bash", current.ctx), false);
  assert.equal(current.lifecycle.toolAllowed("piagent_task_start", current.ctx), true);
});

// A stop request is only counted as pending if its commandId is truthy: the
// projection does `if (eventType === "task-control.stop-requested" && commandId)
// pendingStops.add(commandId)`. So an empty commandId does not fail loudly — it
// records the stop and then reports nothing pending, which is the one outcome an
// operator pressing stop must never get. The journal writers do not check the
// shape (validTaskControlBinding exists for it and is called nowhere); the only
// thing standing between the wire and that state is REF.test in the controller's
// structural validation. Nothing pinned that, so loosening the regex would have
// opened it silently.
test("a commandId that could not be counted as a pending stop never reaches the journal", async (t) => {
  const current = fixture(t);
  const before = inspectTaskControlState(current.cwd, current.task);

  // Empty is the dangerous one; the rest are the shapes REF exists to exclude.
  const rejected = ["", " ", "-leading-dash", "a".repeat(200), "has space", "has/slash", "has:colon"];
  for (const commandId of rejected) {
    const value = command(current, "lifecycle.pause", { commandId });
    value.actionDigest = controlActionDigest(value);
    const receipt = await current.lifecycle.execute(value);
    valid(receipt);
    assert.equal(receipt.resultCode, "invalid-command", `accepted commandId ${JSON.stringify(commandId)}`);
    assert.equal(receipt.error?.code, "invalid-command-metadata", JSON.stringify(commandId));
    // The rejection receipt must not echo the bad value back either; it carries
    // a fixed placeholder so nothing downstream stores an uncheckable id.
    assert.equal(receipt.commandId, "command.invalid", JSON.stringify(commandId));
  }

  // Nothing was written, so control state is untouched and no stop is pending.
  const after = inspectTaskControlState(current.cwd, current.task);
  assert.equal(after.state, before.state);
  assert.equal(after.controlRevision, before.controlRevision);
  assert.equal(after.stopPending, false);
  assert.equal(current.aborts, 0);
});

test("a well-formed commandId is still accepted, so the check is not blanket refusal", async (t) => {
  // Without this, deleting the transition entirely would pass the test above.
  const current = fixture(t);
  const value = command(current, "lifecycle.pause", { commandId: "command_shape_ok-1.2~3" });
  value.actionDigest = controlActionDigest(value);
  const receipt = await current.lifecycle.execute(value);
  valid(receipt);
  assert.notEqual(receipt.resultCode, "invalid-command");
  assert.notEqual(inspectTaskControlState(current.cwd, current.task).controlRevision, "control-rev.stale");
});

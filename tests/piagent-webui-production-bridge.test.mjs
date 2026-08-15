import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SameSessionPiBridge,
  WEBUI_CONTROL_ENTRY_TYPE,
  chatActionDigest,
  chatContentDigest
} from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { validateFixture, createWebUiSchemaRegistry } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();

function context(sessionId = "session-production-bridge") {
  const entries = [];
  let idle = true, entrySequence = 0;
  const append = (entry) => {
    const value = { id: `entry_${++entrySequence}`, parentId: entries.at(-1)?.id ?? null,
      timestamp: "2026-08-13T12:00:01.000Z", ...structuredClone(entry) };
    entries.push(value); return value;
  };
  return {
    ctx: {
      cwd: "/project/current",
      sessionManager: { getSessionId: () => sessionId, getBranch: () => structuredClone(entries),
        getLeafId: () => entries.at(-1)?.id ?? null, getLeafEntry: () => structuredClone(entries.at(-1) ?? null) },
      isIdle: () => idle
    },
    entries,
    append,
    setIdle(value) { idle = value; }
  };
}

function command(snapshot, overrides = {}) {
  const requestedAt = "2026-08-13T12:00:00.000Z";
  const payload = {
    messageRequestId: overrides.messageRequestId ?? "message_request_01",
    capabilityAction: "send",
    delivery: overrides.delivery ?? "new-operation",
    text: overrides.text ?? "Please continue in this exact Pi session.",
    attachmentRefs: []
  };
  payload.contentDigest = chatContentDigest(payload);
  const value = {
    schemaVersion: 1,
    version: "piagent-webui-control-v1",
    messageType: "command",
    commandId: overrides.commandId ?? "command_01",
    idempotencyKey: overrides.idempotencyKey ?? "idempotency-key-000000000000000001",
    requestedAt,
    expiresAt: "2026-08-13T12:05:00.000Z",
    capabilityScope: "control.chat",
    action: "chat.send",
    actionDigest: "",
    identity: structuredClone(snapshot.identity),
    expectedRevisions: { ...structuredClone(snapshot.revisions), workspacePreimage: null, indexPreimage: null, patchPreimage: null },
    payload
  };
  value.actionDigest = chatActionDigest(value);
  return value;
}

function assertValidReceipt(receipt) {
  const result = validateFixture(registry, "control-command-v1", receipt);
  assert.equal(result.valid, true, result.errors);
}

describe("Piagent WebUI production same-session bridge", () => {
  it("rejects dispatch into a terminal task and preserves exact capability evidence", async () => {
    const surface = context(); let sends = 0;
    const pi = { appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); }, sendUserMessage() { sends += 1; } };
    const taskFacts = () => ({ taskId: "task_terminal", taskRunId: "task_run_terminal", taskRevision: "task-rev.terminal",
      controlRevision: "control-rev.terminal", controlState: "terminal" });
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_terminal_task", taskFacts,
      now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const snapshot = bridge.snapshot(); assert.equal(snapshot.taskState, "terminal");
    const receipt = await bridge.execute(command(snapshot, { commandId: "command_terminal", idempotencyKey: "terminal-task-key-000000000000000000" }));
    assert.equal(receipt.phase, "rejected"); assert.equal(receipt.resultCode, "capability-unavailable");
    assert.equal(receipt.error.code, "task-terminal"); assert.equal(sends, 0); assertValidReceipt(receipt);
  });

  it("dispatches one idle message, observes it in the bound operation and deduplicates replay", async () => {
    const surface = context();
    let bridge, sends = 0;
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage(text) {
        sends += 1;
        surface.setIdle(false);
        bridge.observeInput({ source: "extension", text }, surface.ctx);
        surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
        queueMicrotask(() => bridge.observeAgentStart(surface.ctx));
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_01", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const initial = bridge.snapshot();
    assert.equal(initial.state, "ready");
    assert.equal(initial.liveness, "idle");

    const value = command(initial);
    const receipt = await bridge.execute(value);
    assert.equal(receipt.resultCode, "dispatch-observed");
    assert.equal(receipt.phase, "settled");
    assert.equal(receipt.identity.sessionRef, initial.identity.sessionRef);
    assert.match(receipt.identity.agentOperationId, /^operation\./);
    assert.equal(receipt.settlementEvidenceRef, surface.entries.find((entry) => entry.type === "message" && entry.message?.role === "user")?.id);
    assert.equal(sends, 1);
    assertValidReceipt(receipt);
    assert.equal(surface.entries.filter((entry) => entry.customType === WEBUI_CONTROL_ENTRY_TYPE).length, 2);

    const replay = await bridge.execute(value);
    assert.equal(replay.resultCode, "dispatch-observed");
    assert.equal(replay.deduplicated, true);
    assert.equal(sends, 1);
    assertValidReceipt(replay);

    bridge.observeAgentSettled(surface.ctx);
    surface.setIdle(true);
    assert.equal(bridge.snapshot().liveness, "idle");
    assert.equal(bridge.events().events.some((event) => event.kind === "operation.settled"), true);
  });

  it("fails closed on stale identity/revision, invalid lifecycle delivery and idempotency payload mismatch", async () => {
    const surface = context();
    let sends = 0, bridge;
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage(text) {
        sends += 1;
        surface.setIdle(false);
        bridge.observeInput({ source: "extension", text }, surface.ctx);
        surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
        queueMicrotask(() => bridge.observeAgentStart(surface.ctx));
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_02", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);

    const wrongSession = command(bridge.snapshot(), { commandId: "command_wrong_session", idempotencyKey: "wrong-session-key-0000000000000000" });
    wrongSession.identity.sessionRef = "session_wrong";
    wrongSession.actionDigest = chatActionDigest(wrongSession);
    assert.equal((await bridge.execute(wrongSession)).resultCode, "identity-mismatch");

    const stale = command(bridge.snapshot(), { commandId: "command_stale", idempotencyKey: "stale-revision-key-00000000000000" });
    stale.expectedRevisions.runtimeRevision = "runtime_rev_stale";
    stale.actionDigest = chatActionDigest(stale);
    assert.equal((await bridge.execute(stale)).resultCode, "stale-revision");

    const followUp = command(bridge.snapshot(), { commandId: "command_followup", idempotencyKey: "follow-up-key-0000000000000000000", delivery: "follow-up" });
    followUp.actionDigest = chatActionDigest(followUp);
    assert.equal((await bridge.execute(followUp)).resultCode, "dispatch-rejected");

    const smuggled = command(bridge.snapshot(), { commandId: "command_smuggled", idempotencyKey: "smuggled-field-key-00000000000000" });
    smuggled.payload.hiddenInstruction = "not part of the closed contract";
    smuggled.actionDigest = chatActionDigest(smuggled);
    assert.equal((await bridge.execute(smuggled)).resultCode, "invalid-command");

    const accepted = command(bridge.snapshot(), { commandId: "command_accepted", idempotencyKey: "accepted-command-key-0000000000000" });
    const receipt = await bridge.execute(accepted);
    assert.equal(receipt.resultCode, "dispatch-observed");
    const mismatch = structuredClone(accepted);
    mismatch.payload.text = "A different payload under the same key.";
    mismatch.payload.contentDigest = chatContentDigest(mismatch.payload);
    mismatch.actionDigest = chatActionDigest(mismatch);
    assert.equal((await bridge.execute(mismatch)).resultCode, "idempotency-payload-mismatch");
    assert.equal(sends, 1);
  });

  it("causally accepts Pi-native follow-up and Interrupt & Send only in the bound running operation", async () => {
    const surface = context("session_running_delivery");
    const deliveries = [];
    let bridge;
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage(text, options) {
        deliveries.push(options?.deliverAs);
        bridge.observeInput({ source: "extension", text }, surface.ctx);
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_running_delivery", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx); surface.setIdle(false); bridge.observeAgentStart(surface.ctx);

    const followUp = command(bridge.snapshot(), { commandId: "command_followup", idempotencyKey: "follow-up-key-0000000000000000000", delivery: "follow-up" });
    followUp.actionDigest = chatActionDigest(followUp);
    const followReceipt = await bridge.execute(followUp);
    assert.equal(followReceipt.phase, "accepted");
    assert.equal(followReceipt.resultCode, "dispatch-requested");
    assertValidReceipt(followReceipt);

    const steer = command(bridge.snapshot(), { commandId: "command_steer", idempotencyKey: "interrupt-send-key-00000000000000", delivery: "steer",
      messageRequestId: "message_request_steer" });
    steer.payload.capabilityAction = "interruptAndSend";
    steer.payload.contentDigest = chatContentDigest(steer.payload);
    steer.actionDigest = chatActionDigest(steer);
    const steerReceipt = await bridge.execute(steer);
    assert.equal(steerReceipt.phase, "accepted");
    assert.equal(steerReceipt.resultCode, "dispatch-requested");
    assertValidReceipt(steerReceipt);
    assert.deepEqual(deliveries, ["followUp", "steer"]);
  });

  it("does not erase the running operation when a follow-up dispatch fails", async () => {
    const surface = context("session_running_failure");
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage() { throw new Error("native follow-up rejected"); }
    };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_running_failure", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx); surface.setIdle(false); bridge.observeAgentStart(surface.ctx);
    const operationId = bridge.snapshot().identity.agentOperationId;
    const followUp = command(bridge.snapshot(), { commandId: "command_followup_failure", idempotencyKey: "follow-up-failure-key-000000000000000", delivery: "follow-up" });
    followUp.actionDigest = chatActionDigest(followUp);
    const receipt = await bridge.execute(followUp);
    assert.equal(receipt.resultCode, "dispatch-rejected");
    assert.equal(bridge.snapshot().identity.agentOperationId, operationId);
    assert.equal(bridge.snapshot().liveness, "running");
    assertValidReceipt(receipt);
  });

  it("closes authority during replacement and does not carry a stale session binding", async () => {
    const first = context("session_first"), second = context("session_second");
    const pi = { appendEntry() {}, sendUserMessage() { throw new Error("must not dispatch"); } };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_03", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(first.ctx);
    const stale = command(bridge.snapshot(), { commandId: "command_replacement", idempotencyKey: "replacement-key-000000000000000000" });
    bridge.replacementPending();
    assert.equal((await bridge.execute(stale)).resultCode, "resync-required");
    bridge.shutdown(first.ctx);
    bridge.bind(second.ctx);
    assert.notEqual(bridge.snapshot().identity.sessionRef, stale.identity.sessionRef);
    assert.equal((await bridge.execute(stale)).resultCode, "identity-mismatch");
  });

  it("rebuilds dedupe receipts from the exact session and refuses dispatch without durable receipt storage", async () => {
    const surface = context();
    let bridge, sends = 0;
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage(text) {
        sends += 1; surface.setIdle(false);
        bridge.observeInput({ source: "extension", text }, surface.ctx);
        surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
        queueMicrotask(() => bridge.observeAgentStart(surface.ctx));
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_04", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const accepted = command(bridge.snapshot(), { commandId: "command_durable", idempotencyKey: "durable-command-key-00000000000000" });
    assert.equal((await bridge.execute(accepted)).resultCode, "dispatch-observed");
    bridge.observeAgentSettled(surface.ctx); surface.setIdle(true);

    let rebuiltSends = 0;
    const rebuilt = new SameSessionPiBridge({ appendEntry: pi.appendEntry, sendUserMessage() { rebuiltSends += 1; } },
      { runtimeInstanceId: "runtime_production_04", now: () => new Date("2026-08-13T12:00:02.000Z") });
    rebuilt.bind(surface.ctx);
    const replay = await rebuilt.execute(accepted);
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.resultCode, "dispatch-observed");
    assert.equal(rebuiltSends, 0);

    let unsafeSends = 0;
    const unsafe = new SameSessionPiBridge({ appendEntry() { throw new Error("disk full"); }, sendUserMessage() { unsafeSends += 1; } },
      { runtimeInstanceId: "runtime_production_05", now: () => new Date("2026-08-13T12:00:01.000Z") });
    const unsafeSurface = context("session_unsafe");
    unsafe.bind(unsafeSurface.ctx);
    const rejected = await unsafe.execute(command(unsafe.snapshot(), { commandId: "command_unsafe", idempotencyKey: "unsafe-command-key-000000000000000" }));
    assert.equal(rejected.resultCode, "capability-unavailable");
    assert.equal(rejected.error.code, "receipt-store-unavailable");
    assert.equal(unsafeSends, 0);
  });

  it("does not acknowledge an unrelated input or assistant operation as the requested dispatch", async () => {
    const surface = context("session_correlation"), pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage() { surface.setIdle(false); }
    };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_06", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const pending = bridge.execute(command(bridge.snapshot(), { commandId: "command_correlation", idempotencyKey: "correlation-command-key-00000000000" }));
    await Promise.resolve();
    bridge.observeInput({ source: "extension", text: "some other extension message" }, surface.ctx);
    surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "some other extension message" }] } });
    bridge.observeAgentStart(surface.ctx);
    bridge.observeMessageStart({ message: { role: "user", content: [{ type: "text", text: "some other extension message" }] } }, surface.ctx);
    bridge.observeAgentSettled(surface.ctx);
    const receipt = await pending;
    assert.equal(receipt.resultCode, "dispatch-unknown");
    assert.equal(receipt.phase, "uncertain");
    assert.equal(receipt.settlementEvidenceRef, null);
    assertValidReceipt(receipt);
  });

  it("does not acknowledge an identical message emitted by another same-session producer", async () => {
    const surface = context("session_same_text"), pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage() { surface.setIdle(false); }
    };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_09", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const value = command(bridge.snapshot(), { commandId: "command_same_text", idempotencyKey: "same-text-producer-key-0000000000000" });
    const pending = bridge.execute(value);
    await Promise.resolve();
    bridge.observeInput({ source: "extension", text: value.payload.text }, surface.ctx);
    surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text: value.payload.text }] } });
    bridge.observeAgentStart(surface.ctx);
    bridge.observeMessageStart({ message: { role: "user", content: [{ type: "text", text: value.payload.text }] } }, surface.ctx);
    bridge.observeAgentSettled(surface.ctx);
    const receipt = await pending;
    assert.equal(receipt.resultCode, "dispatch-unknown");
    assert.equal(receipt.phase, "uncertain");
    assertValidReceipt(receipt);
  });

  it("ignores identical evidence delivered with a different live session context", async () => {
    const first = context("session_context_a"), second = context("session_context_b"), pi = {
      appendEntry(customType, data) { first.append({ type: "custom", customType, data }); },
      sendUserMessage() { first.setIdle(false); }
    };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_10", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(first.ctx);
    const value = command(bridge.snapshot(), { commandId: "command_cross_context", idempotencyKey: "cross-context-command-key-000000000" });
    const pending = bridge.execute(value);
    await Promise.resolve();
    second.append({ type: "message", message: { role: "user", content: [{ type: "text", text: value.payload.text }] } });
    bridge.observeInput({ source: "extension", text: value.payload.text }, second.ctx);
    bridge.observeAgentStart(second.ctx);
    bridge.observeMessageStart({ message: { role: "user", content: [{ type: "text", text: value.payload.text }] } }, second.ctx);
    bridge.observeAgentSettled(first.ctx);
    const receipt = await pending;
    assert.equal(receipt.resultCode, "dispatch-unknown");
    assert.equal(receipt.phase, "uncertain");
    assertValidReceipt(receipt);
  });

  it("closes a pending dispatch at replacement and ignores later outgoing-session evidence", async () => {
    const surface = context("session_replacement_race"), pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage() { surface.setIdle(false); }
    };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_07", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const value = command(bridge.snapshot(), { commandId: "command_replacement_race", idempotencyKey: "replacement-race-key-00000000000000" });
    const pending = bridge.execute(value);
    await Promise.resolve();
    bridge.replacementPending();
    surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text: value.payload.text }] } });
    bridge.observeInput({ source: "extension", text: value.payload.text }, surface.ctx);
    bridge.observeAgentStart(surface.ctx);
    bridge.observeMessageStart({ message: { role: "user", content: [{ type: "text", text: value.payload.text }] } }, surface.ctx);
    const receipt = await pending;
    assert.equal(receipt.resultCode, "dispatch-unknown");
    assert.equal(receipt.phase, "uncertain");
    assert.equal(bridge.snapshot().state, "replacement-pending");
    assertValidReceipt(receipt);
  });

  it("returns schema-valid fail-closed receipts for malformed boundary values", async () => {
    const surface = context("session_malformed"), bridge = new SameSessionPiBridge({ appendEntry(customType, data) {
      surface.append({ type: "custom", customType, data });
    }, sendUserMessage() { throw new Error("must not dispatch malformed input"); } },
    { runtimeInstanceId: "runtime_production_08", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const missing = await bridge.execute(null);
    assert.equal(missing.resultCode, "invalid-command");
    assertValidReceipt(missing);

    const malformed = command(bridge.snapshot(), { commandId: "command_malformed", idempotencyKey: "malformed-command-key-000000000000" });
    malformed.identity = { projectRef: 42, sessionRef: { raw: true } };
    const rejected = await bridge.execute(malformed);
    assert.equal(rejected.resultCode, "invalid-command");
    assertValidReceipt(rejected);

    const invalidDate = command(bridge.snapshot(), { commandId: "command_invalid_date", idempotencyKey: "invalid-date-command-key-0000000000" });
    invalidDate.requestedAt = "2026-99-99T12:00:00.000Z";
    invalidDate.expiresAt = "2026-99-99T12:05:00.000Z";
    invalidDate.actionDigest = chatActionDigest(invalidDate);
    const invalidDateReceipt = await bridge.execute(invalidDate);
    assert.equal(invalidDateReceipt.resultCode, "invalid-command");
    assertValidReceipt(invalidDateReceipt);
  });

  it("refuses a corrupt durable receipt instead of granting replay authority", () => {
    const surface = context("session_corrupt_receipt");
    surface.append({ type: "custom", customType: WEBUI_CONTROL_ENTRY_TYPE, data: { receipt: {
      version: "piagent-webui-control-v1", commandId: "command_corrupt", idempotencyKeyDigest: `sha256:${"a".repeat(64)}`,
      actionDigest: `sha256:${"b".repeat(64)}`, phase: "settled", identity: { runtimeInstanceId: "runtime_production_11",
        sessionRef: "session_corrupt" }
    } } });
    const bridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() { throw new Error("must not dispatch"); } },
      { runtimeInstanceId: "runtime_production_11" });
    assert.throws(() => bridge.bind(surface.ctx), /receipt-store-corrupt/);
    assert.equal(bridge.snapshot().state, "unbound");
  });

  it("settles authority even when a bridge event subscriber throws", async () => {
    const surface = context("session_listener_failure");
    let bridge;
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage(text) {
        surface.setIdle(false); bridge.observeInput({ source: "extension", text }, surface.ctx);
        surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
        queueMicrotask(() => bridge.observeAgentStart(surface.ctx));
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_12", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    bridge.subscribe((event) => { if (event.kind === "command.receipt" && event.resultCode === "dispatch-observed") throw new Error("subscriber failed"); });
    const receipt = await bridge.execute(command(bridge.snapshot(), { commandId: "command_listener", idempotencyKey: "listener-failure-key-0000000000000" }));
    assert.equal(receipt.resultCode, "dispatch-observed");
    assertValidReceipt(receipt);
  });

  it("rejects a terminal dispatch receipt without its earlier requested receipt", async () => {
    const surface = context("session_orphan_settlement");
    let bridge;
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage(text) {
        surface.setIdle(false); bridge.observeInput({ source: "extension", text }, surface.ctx);
        surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
        queueMicrotask(() => bridge.observeAgentStart(surface.ctx));
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_13", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    assert.equal((await bridge.execute(command(bridge.snapshot(), { commandId: "command_orphan", idempotencyKey: "orphan-settlement-key-000000000000" }))).resultCode, "dispatch-observed");
    const requestedIndex = surface.entries.findIndex((entry) => entry.customType === WEBUI_CONTROL_ENTRY_TYPE && entry.data.receipt.phase === "requested");
    surface.entries.splice(requestedIndex, 1);
    const rebuilt = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_13" });
    assert.throws(() => rebuilt.bind(surface.ctx), /receipt-store-corrupt/);
  });

  it("rejects forged settlement evidence and unsupported durable audit claims", async () => {
    const surface = context("session_forged_evidence");
    let bridge;
    const pi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage(text) {
        bridge.observeInput({ source: "extension", text }, surface.ctx);
        surface.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
        queueMicrotask(() => bridge.observeAgentStart(surface.ctx));
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_14", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(surface.ctx);
    const accepted = command(bridge.snapshot(), { commandId: "command_forged_evidence", idempotencyKey: "forged-evidence-key-000000000000000" });
    assert.equal((await bridge.execute(accepted)).resultCode, "dispatch-observed");
    const terminal = surface.entries.find((entry) => entry.customType === WEBUI_CONTROL_ENTRY_TYPE && entry.data.receipt.phase === "settled");
    const originalEvidence = terminal.data.receipt.settlementEvidenceRef;
    terminal.data.receipt.settlementEvidenceRef = "entry_forged_nonexistent";
    assert.throws(() => new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_14" }).bind(surface.ctx), /receipt-store-corrupt/);
    terminal.data.receipt.settlementEvidenceRef = originalEvidence;
    terminal.data.receipt.auditRef = "audit_forged_nonexistent";
    assert.throws(() => new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_production_14" }).bind(surface.ctx), /receipt-store-corrupt/);
  });

  it("preserves a crash-left requested receipt as durable uncertainty across two restarts", async () => {
    const surface = context("session_requested_crash");
    const firstPi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage() { /* simulate a crash before the host exposes dispatch evidence */ }
    };
    const first = new SameSessionPiBridge(firstPi, { runtimeInstanceId: "runtime_production_15", now: () => new Date("2026-08-13T12:00:01.000Z") });
    first.bind(surface.ctx);
    const value = command(first.snapshot(), { commandId: "command_requested_crash", idempotencyKey: "requested-crash-key-000000000000000" });
    void first.execute(value);
    await Promise.resolve();
    assert.equal(surface.entries.filter((entry) => entry.customType === WEBUI_CONTROL_ENTRY_TYPE).length, 1);

    let sends = 0;
    const restartPi = {
      appendEntry(customType, data) { surface.append({ type: "custom", customType, data }); },
      sendUserMessage() { sends += 1; }
    };
    const second = new SameSessionPiBridge(restartPi, { runtimeInstanceId: "runtime_production_15", now: () => new Date("2026-08-13T12:00:02.000Z") });
    second.bind(surface.ctx);
    const uncertain = await second.execute(value);
    assert.equal(uncertain.resultCode, "dispatch-unknown");
    assert.equal(uncertain.phase, "uncertain");
    assertValidReceipt(uncertain);
    assert.equal(sends, 0);

    const third = new SameSessionPiBridge(restartPi, { runtimeInstanceId: "runtime_production_15", now: () => new Date("2026-08-13T12:00:03.000Z") });
    assert.doesNotThrow(() => third.bind(surface.ctx));
    const replay = await third.execute(value);
    assert.equal(replay.resultCode, "dispatch-unknown");
    assert.equal(replay.deduplicated, true);
    assertValidReceipt(replay);
    assert.equal(sends, 0);
  });
});

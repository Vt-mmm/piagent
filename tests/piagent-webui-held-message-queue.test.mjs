import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HeldMessageQueue, WEBUI_QUEUE_ENTRY_TYPE } from "../packages/piagent-webui/extension/held-message-queue.ts";
import { SameSessionPiBridge, chatContentDigest, controlActionDigest } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();

function surface() {
  const entries = []; let idle = true, sequence = 0;
  return {
    entries,
    ctx: {
      cwd: "/project/queue",
      sessionManager: {
        getSessionId: () => "session-held-queue",
        getBranch: () => structuredClone(entries),
        getLeafId: () => entries.at(-1)?.id ?? null,
        getLeafEntry: () => structuredClone(entries.at(-1) ?? null)
      },
      isIdle: () => idle
    },
    append(entry) {
      const value = { id: `entry_${++sequence}`, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-08-13T12:00:01.000Z", ...structuredClone(entry) };
      entries.push(value); return value;
    },
    setIdle(value) { idle = value; }
  };
}

function command(snapshot, action, payload, suffix) {
  const value = {
    schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command", commandId: `command_${suffix}`,
    idempotencyKey: `idempotency-${suffix}-00000000000000000000`, requestedAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:05:00.000Z", capabilityScope: "control.chat", action, actionDigest: "",
    identity: structuredClone(snapshot.identity), expectedRevisions: { ...structuredClone(snapshot.revisions), workspacePreimage: null, indexPreimage: null, patchPreimage: null }, payload
  };
  value.actionDigest = controlActionDigest(value); return value;
}

function hold(snapshot, text, suffix) {
  const payload = { messageRequestId: `message_request_${suffix}`, capabilityAction: "hold", delivery: "hold", text, attachmentRefs: [] };
  payload.contentDigest = chatContentDigest(payload); return command(snapshot, "chat.send", payload, suffix);
}

function assertValid(name, value) {
  const result = validateFixture(registry, name, value);
  assert.equal(result.valid, true, result.errors);
}

describe("Piagent WebUI runtime-owned held message queue", () => {
  it("holds, updates and deletes one exact-session message with revision-bound receipts", async () => {
    const host = surface();
    const pi = { appendEntry(customType, data) { host.append({ type: "custom", customType, data }); }, sendUserMessage() { throw new Error("not dispatched"); } };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime-held-queue", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(host.ctx);
    const queue = new HeldMessageQueue({ bridge, appendEntry: pi.appendEntry, now: () => new Date("2026-08-13T12:00:01.000Z") });

    const held = await queue.execute(hold(bridge.snapshot(), "Continue after the verifier finishes.", "hold"));
    assert.equal(held.phase, "accepted"); assert.equal(held.resultCode, "held"); assertValid("control-command-v1", held);
    const first = queue.projection(); assertValid("queue-v1", first);
    assert.equal(first.heldCount, 1); assert.equal(first.items[0].redacted, false);

    const updatePayload = { queueItemRef: first.items[0].queueItemRef, text: "Continue with the verified result.", attachmentRefs: [] };
    updatePayload.contentDigest = chatContentDigest(updatePayload);
    const updated = await queue.execute(command(bridge.snapshot(), "queue.update", updatePayload, "update"));
    assert.equal(updated.resultCode, "updated"); assertValid("control-command-v1", updated);
    assert.equal(queue.projection().items[0].preview, updatePayload.text);

    const replay = await queue.execute(command({ identity: updated.identity, revisions: updated.observedRevisionsBefore }, "queue.update", updatePayload, "update"));
    assert.equal(replay.resultCode, "updated"); assert.equal(replay.deduplicated, true); assertValid("control-command-v1", replay);

    const deleted = await queue.execute(command(bridge.snapshot(), "queue.delete", { queueItemRef: first.items[0].queueItemRef }, "delete"));
    assert.equal(deleted.resultCode, "deleted"); assertValid("control-command-v1", deleted);
    assert.equal(queue.projection().heldCount, 0);
    assert.equal(host.entries.filter((entry) => entry.customType === WEBUI_QUEUE_ENTRY_TYPE).length, 3);
  });

  it("does not let a hostile browser overwrite a redacted or truncated held preview", async () => {
    const host = surface();
    const pi = { appendEntry(customType, data) { host.append({ type: "custom", customType, data }); }, sendUserMessage() { throw new Error("not dispatched"); } };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime-held-redacted", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(host.ctx);
    const queue = new HeldMessageQueue({ bridge, appendEntry: pi.appendEntry, now: () => new Date("2026-08-13T12:00:01.000Z") });
    await queue.execute(hold(bridge.snapshot(), "Use sk-proj-abcdefghijklmnopqrstuvwxyz only after this tool.", "redacted_hold"));
    const before = queue.projection(), item = before.items[0];
    assert.equal(item.redacted, true); assert.doesNotMatch(item.preview, /sk-proj-abcdefghijklmnopqrstuvwxyz/);
    const updatePayload = { queueItemRef: item.queueItemRef, text: "Attacker replacement.", attachmentRefs: [] };
    updatePayload.contentDigest = chatContentDigest(updatePayload);
    const receipt = await queue.execute(command(bridge.snapshot(), "queue.update", updatePayload, "redacted_update"));
    assert.equal(receipt.resultCode, "capability-unavailable"); assert.equal(receipt.error.code, "queue-item-preview-not-editable");
    assertValid("control-command-v1", receipt);
    const after = queue.projection(); assert.equal(after.revision.queueRevision, before.revision.queueRevision);
    assert.equal(after.items[0].preview, before.items[0].preview);
    assert.equal(host.entries.some((entry) => JSON.stringify(entry).includes("sk-proj-abcdefghijklmnopqrstuvwxyz")), false);
    const evidence = host.entries.filter((entry) => entry.customType === WEBUI_QUEUE_ENTRY_TYPE);
    assert.equal(evidence.length, 1);
    assert.doesNotMatch(JSON.stringify(evidence), /actionDigest|contentDigest|idempotencyKeyDigest/);
    assert.deepEqual(Object.keys(evidence[0].data).sort(), ["action", "commandId", "item", "mutationRef", "queueRevision", "resultCode", "schemaVersion"]);
  });

  it("dispatches a held item exactly once and removes it only after Pi evidence", async () => {
    const host = surface(); let bridge, sends = 0;
    const pi = {
      appendEntry(customType, data) { host.append({ type: "custom", customType, data }); },
      sendUserMessage(text) {
        sends += 1; host.setIdle(false); bridge.observeInput({ source: "extension", text }, host.ctx);
        host.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
        queueMicrotask(() => bridge.observeAgentStart(host.ctx));
      }
    };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime-held-dispatch", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(host.ctx);
    const queue = new HeldMessageQueue({ bridge, appendEntry: pi.appendEntry, now: () => new Date("2026-08-13T12:00:01.000Z") });
    await queue.execute(hold(bridge.snapshot(), "Dispatch me exactly once.", "dispatch_hold"));
    const item = queue.projection().items[0];
    const dispatch = command(bridge.snapshot(), "queue.dispatch", { queueItemRef: item.queueItemRef, messageRequestId: "message_request_dispatch_now" }, "dispatch_now");
    const receipt = await queue.execute(dispatch);
    assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "dispatch-observed"); assertValid("control-command-v1", receipt);
    assert.equal(sends, 1); assert.equal(queue.projection().heldCount, 0);
    const replay = await queue.execute(dispatch);
    assert.equal(replay.deduplicated, true); assert.equal(sends, 1);
  });

  it("fails stale commands closed and drops runtime-lifetime authority on reset", async () => {
    const host = surface(), pi = { appendEntry(customType, data) { host.append({ type: "custom", customType, data }); }, sendUserMessage() {} };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime-held-reset", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(host.ctx);
    const queue = new HeldMessageQueue({ bridge, appendEntry: pi.appendEntry, now: () => new Date("2026-08-13T12:00:01.000Z") });
    const stale = hold(bridge.snapshot(), "Stale command.", "stale");
    await queue.execute(hold(bridge.snapshot(), "First mutation.", "first"));
    const rejected = await queue.execute(stale);
    assert.equal(rejected.resultCode, "stale-revision"); assertValid("control-command-v1", rejected);
    queue.reset();
    assert.equal(queue.projection().heldCount, 0);
  });

  it("preserves held items across a cancelled replacement and reopens only on exact unchanged-session host evidence", async () => {
    const host = surface(), pi = { appendEntry(customType, data) { host.append({ type: "custom", customType, data }); }, sendUserMessage() {} };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime-held-cancelled-switch", now: () => new Date("2026-08-13T12:00:01.000Z") });
    bridge.bind(host.ctx);
    const queue = new HeldMessageQueue({ bridge, appendEntry: pi.appendEntry, now: () => new Date("2026-08-13T12:00:01.000Z") });
    await queue.execute(hold(bridge.snapshot(), "Keep me if the session switch is cancelled.", "cancelled_switch"));
    bridge.replacementPending();
    const pending = queue.projection();
    assert.equal(pending.state, "unavailable"); assert.equal(pending.items.length, 0);
    assert.equal((await queue.execute(hold({ identity: pending.identity, revisions: pending.revision }, "must reject", "pending_reject"))).resultCode, "resync-required");
    bridge.observeInput({ source: "interactive", text: "Terminal input proves the old session stayed active." }, host.ctx);
    const restored = queue.projection();
    assert.equal(restored.state, "ready"); assert.equal(restored.heldCount, 1);
    assert.equal(restored.items[0].preview, "Keep me if the session switch is cancelled.");
    assert.notEqual(restored.revision.queueRevision, pending.revision.queueRevision);
  });

  it("rejects normalized or non-schema timestamps before any queue mutation", async () => {
    const host = surface(), pi = { appendEntry(customType, data) { host.append({ type: "custom", customType, data }); }, sendUserMessage() {} };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime-held-invalid-date", now: () => new Date("2026-03-03T12:00:00.000Z") });
    bridge.bind(host.ctx);
    const queue = new HeldMessageQueue({ bridge, appendEntry: pi.appendEntry, now: () => new Date("2026-03-03T12:00:00.000Z") });
    for (const [suffix, requestedAt] of [["normalized", "2026-02-31T12:00:00.000Z"], ["missing_millis", "2026-03-03T12:00:00Z"]]) {
      const malformed = hold(bridge.snapshot(), "Do not hold malformed input.", suffix);
      malformed.requestedAt = requestedAt; malformed.expiresAt = "2026-03-03T12:05:00.000Z"; malformed.actionDigest = controlActionDigest(malformed);
      const receipt = await queue.execute(malformed);
      assert.equal(receipt.resultCode, "invalid-command"); assertValid("control-command-v1", receipt);
    }
    assert.equal(queue.projection().heldCount, 0);
    assert.equal(host.entries.some((entry) => entry.customType === WEBUI_QUEUE_ENTRY_TYPE), false);
  });
});

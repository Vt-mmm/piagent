import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { AttachmentStore, ATTACHMENT_LIMITS } from "../packages/piagent-webui/extension/attachment-store.ts";
import { SameSessionPiBridge, chatActionDigest, chatContentDigest } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry(), temporaryRoots = new Set();
const now = new Date("2026-08-14T08:00:01.000Z");

function surface(sessionId = "session-attachment") {
  const entries = []; let sequence = 0, idle = true;
  const append = (entry) => { const value = { id: `entry_${++sequence}`, parentId: entries.at(-1)?.id ?? null, ...structuredClone(entry) }; entries.push(value); return value; };
  return { entries, append, setIdle(value) { idle = value; }, ctx: { cwd: "/project/attachment",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => structuredClone(entries), getLeafId: () => entries.at(-1)?.id ?? null,
      getLeafEntry: () => structuredClone(entries.at(-1) ?? null) }, isIdle: () => idle } };
}

function privateRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-attachment-test-")); temporaryRoots.add(root); return root; }
function png() { const bytes = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20); return bytes; }
function stageCommand(snapshot, overrides = {}) {
  return { schemaVersion: 1, version: "piagent-webui-attachment-v1", messageType: "stage-command",
    commandId: overrides.commandId ?? "attachment_command_01", idempotencyKey: overrides.idempotencyKey ?? "attachment-idempotency-key-00000001",
    requestedAt: overrides.requestedAt ?? "2026-08-14T08:00:00.000Z", expiresAt: overrides.expiresAt ?? "2026-08-14T08:05:00.000Z",
    identity: structuredClone(snapshot.identity), expectedRuntimeRevision: overrides.runtimeRevision ?? snapshot.revisions.runtimeRevision,
    messageRequestId: overrides.messageRequestId ?? "message_request_attachment_01",
    file: { displayName: overrides.displayName ?? "notes.md", declaredMimeType: overrides.mimeType ?? "text/markdown",
      dataBase64: (overrides.bytes ?? Buffer.from("# Exact notes\n", "utf8")).toString("base64") } };
}
function validAttachmentReceipt(receipt) {
  const result = validateFixture(registry, "attachment-v1", receipt); assert.equal(result.valid, true, result.errors);
}
function discardCommand(snapshot, attachment, overrides = {}) {
  return { schemaVersion: 1, version: "piagent-webui-attachment-v1", messageType: "discard-command",
    commandId: overrides.commandId ?? "attachment_discard_01", idempotencyKey: overrides.idempotencyKey ?? "attachment-discard-key-00000000000001",
    requestedAt: "2026-08-14T08:00:00.000Z", expiresAt: "2026-08-14T08:05:00.000Z", identity: structuredClone(snapshot.identity),
    expectedRuntimeRevision: snapshot.revisions.runtimeRevision, messageRequestId: attachment.messageRequestId, attachmentRef: attachment.attachmentRef };
}

afterEach(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); temporaryRoots.clear(); });

describe("Piagent WebUI bounded attachment store", () => {
  it("stages private text/image bytes with safe metadata and zero Pi dispatch", () => {
    const host = surface(); let sends = 0;
    const bridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() { sends += 1; } }, { runtimeInstanceId: "runtime_attachment_01", now: () => now });
    bridge.bind(host.ctx);
    const root = privateRoot(), store = new AttachmentStore({ runtimeInstanceId: "runtime_attachment_01", bridgeSnapshot: () => bridge.snapshot(),
      modelSupportsImages: () => true, now: () => now, tempRoot: root });
    const first = store.stage(stageCommand(bridge.snapshot(), { displayName: "sk-proj-abcdefghijklmnopqrstuvwxyz.md" }));
    assert.equal(first.resultCode, "staged"); assert.equal(first.attachment.kind, "file"); assert.equal(first.attachment.displayName.includes("sk-proj"), false);
    assert.equal(JSON.stringify(first).includes("Exact notes"), false); assert.equal(JSON.stringify(first).includes("dataBase64"), false); validAttachmentReceipt(first);
    const image = store.stage(stageCommand(bridge.snapshot(), { commandId: "attachment_command_02", idempotencyKey: "attachment-idempotency-key-00000002",
      displayName: "pixel.png", mimeType: "image/png", bytes: png() }));
    assert.equal(image.resultCode, "staged"); assert.equal(image.attachment.kind, "image"); assert.equal(sends, 0); validAttachmentReceipt(image);
    const directory = fs.readdirSync(root).map((name) => path.join(root, name)).find((candidate) => fs.statSync(candidate).isDirectory());
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
    for (const file of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o077, 0);
    store.close(); assert.equal(fs.existsSync(directory), false);
  });

  it("rejects spoofed bytes, impossible timestamps, stale/cross-session authority and limits", () => {
    const host = surface(), bridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() {} }, { runtimeInstanceId: "runtime_attachment_02", now: () => now });
    bridge.bind(host.ctx);
    const store = new AttachmentStore({ runtimeInstanceId: "runtime_attachment_02", bridgeSnapshot: () => bridge.snapshot(), modelSupportsImages: () => false,
      now: () => now, tempRoot: privateRoot() });
    assert.equal(store.stage(stageCommand(bridge.snapshot(), { requestedAt: "2026-02-31T08:00:00.000Z" })).resultCode, "invalid-command");
    const pathSmuggle = stageCommand(bridge.snapshot(), { commandId: "attachment_path", idempotencyKey: "attachment-path-key-0000000000000000" }); pathSmuggle.file.sourcePath = "/private/secret";
    assert.equal(store.stage(pathSmuggle).resultCode, "invalid-command");
    assert.equal(store.stage(stageCommand(bridge.snapshot(), { commandId: "attachment_spoof", idempotencyKey: "attachment-spoof-key-000000000000000", mimeType: "image/png" })).resultCode, "capability-unavailable");
    const stale = stageCommand(bridge.snapshot(), { commandId: "attachment_stale", idempotencyKey: "attachment-stale-key-000000000000000", runtimeRevision: "runtime_rev_stale" });
    assert.equal(store.stage(stale).resultCode, "stale-revision");
    const foreign = stageCommand(bridge.snapshot(), { commandId: "attachment_foreign", idempotencyKey: "attachment-foreign-key-0000000000000" }); foreign.identity.sessionRef = "session_foreign";
    assert.equal(store.stage(foreign).resultCode, "identity-mismatch");
    const large = stageCommand(bridge.snapshot(), { commandId: "attachment_large", idempotencyKey: "attachment-large-key-000000000000000", bytes: Buffer.alloc(ATTACHMENT_LIMITS.textBytes + 1, 65) });
    assert.equal(store.stage(large).resultCode, "limit-exceeded"); store.close();
    const terminalBridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() {} }, { runtimeInstanceId: "runtime_attachment_terminal", now: () => now,
      taskFacts: () => ({ taskId: "task_terminal", taskRunId: "task_run_terminal", taskRevision: "task_rev_terminal", controlRevision: "control_rev_terminal", controlState: "terminal" }) });
    terminalBridge.bind(host.ctx); const terminalStore = new AttachmentStore({ runtimeInstanceId: "runtime_attachment_terminal", bridgeSnapshot: () => terminalBridge.snapshot(),
      modelSupportsImages: () => true, now: () => now, tempRoot: privateRoot() });
    assert.equal(terminalStore.stage(stageCommand(terminalBridge.snapshot(), { commandId: "attachment_terminal", idempotencyKey: "attachment-terminal-key-000000000000" })).resultCode, "capability-unavailable"); terminalStore.close();
  });

  it("atomically binds one-shot refs to the exact message and sends Pi-native content once", async () => {
    const host = surface(); let bridge, store, sent, sends = 0;
    const pi = { appendEntry(customType, data) { host.append({ type: "custom", customType, data }); }, sendUserMessage(content) {
      sends += 1; sent = structuredClone(content); host.setIdle(false);
      const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      bridge.observeInput({ source: "extension", text }, host.ctx); host.append({ type: "message", message: { role: "user", content } });
      queueMicrotask(() => bridge.observeAgentStart(host.ctx));
    } };
    bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_attachment_03", now: () => now,
      prepareAttachments: (refs, request, identity, text) => store.claim(refs, request, identity, text) });
    bridge.bind(host.ctx); store = new AttachmentStore({ runtimeInstanceId: "runtime_attachment_03", bridgeSnapshot: () => bridge.snapshot(),
      modelSupportsImages: () => true, now: () => now, tempRoot: privateRoot() });
    const file = store.stage(stageCommand(bridge.snapshot())), image = store.stage(stageCommand(bridge.snapshot(), { commandId: "attachment_image_03",
      idempotencyKey: "attachment-image-key-000000000000000", displayName: "pixel.png", mimeType: "image/png", bytes: png() }));
    const payload = { messageRequestId: "message_request_attachment_01", capabilityAction: "send", delivery: "new-operation", text: "Inspect both files.",
      attachmentRefs: [file.attachment.attachmentRef, image.attachment.attachmentRef] }; payload.contentDigest = chatContentDigest(payload);
    const snapshot = bridge.snapshot(), command = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command", commandId: "attachment_dispatch_01",
      idempotencyKey: "attachment-dispatch-key-0000000000001", requestedAt: "2026-08-14T08:00:00.000Z", expiresAt: "2026-08-14T08:05:00.000Z",
      capabilityScope: "control.chat", action: "chat.send", actionDigest: "", identity: structuredClone(snapshot.identity),
      expectedRevisions: { ...structuredClone(snapshot.revisions), workspacePreimage: null, indexPreimage: null, patchPreimage: null }, payload };
    command.actionDigest = chatActionDigest(command);
    const receipt = await bridge.execute(command); assert.equal(receipt.resultCode, "dispatch-observed");
    assert.equal(sent[0].text, "Inspect both files."); assert.match(sent[1].text, /Exact notes/); assert.equal(sent[2].type, "image");
    assert.throws(() => store.claim(payload.attachmentRefs, payload.messageRequestId, snapshot.identity, payload.text), /unavailable/);
    const replay = await bridge.execute(command); assert.equal(replay.deduplicated, true); store.close();
    bridge.bind(host.ctx); const afterRebind = await bridge.execute(command);
    assert.equal(afterRebind.resultCode, "stale-revision"); assert.equal(sends, 1);
  });

  it("revokes a removed draft ref idempotently without dispatching Pi", () => {
    const host = surface(); let sends = 0;
    const bridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() { sends += 1; } }, { runtimeInstanceId: "runtime_attachment_04", now: () => now });
    bridge.bind(host.ctx);
    const store = new AttachmentStore({ runtimeInstanceId: "runtime_attachment_04", bridgeSnapshot: () => bridge.snapshot(),
      modelSupportsImages: () => true, now: () => now, tempRoot: privateRoot() });
    const staged = store.stage(stageCommand(bridge.snapshot())), command = discardCommand(bridge.snapshot(), staged.attachment);
    const receipt = store.execute(command); assert.equal(receipt.resultCode, "discarded"); validAttachmentReceipt(receipt);
    assert.throws(() => store.claim([staged.attachment.attachmentRef], staged.attachment.messageRequestId, bridge.snapshot().identity, "text"), /unavailable/);
    const replay = store.execute(command); assert.equal(replay.resultCode, "discarded"); assert.equal(replay.deduplicated, true); assert.equal(sends, 0);
    const mismatch = store.execute({ ...command, attachmentRef: "attachment.different" });
    assert.equal(mismatch.resultCode, "idempotency-payload-mismatch"); validAttachmentReceipt(mismatch); store.close();
  });

  it("rejects temp-file replacement and expiry without reading or deleting the target", () => {
    const host = surface(), bridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() {} }, { runtimeInstanceId: "runtime_attachment_05", now: () => now });
    bridge.bind(host.ctx); const root = privateRoot(); let clock = new Date(now);
    const store = new AttachmentStore({ runtimeInstanceId: "runtime_attachment_05", bridgeSnapshot: () => bridge.snapshot(),
      modelSupportsImages: () => true, now: () => clock, tempRoot: root });
    const staged = store.stage(stageCommand(bridge.snapshot())), directory = fs.readdirSync(root).map((name) => path.join(root, name)).find((item) => fs.statSync(item).isDirectory());
    const owned = path.join(directory, fs.readdirSync(directory)[0]), target = path.join(root, "user-source.txt"); fs.writeFileSync(target, "DO NOT READ OR DELETE");
    fs.unlinkSync(owned); fs.symlinkSync(target, owned);
    assert.throws(() => store.claim([staged.attachment.attachmentRef], staged.attachment.messageRequestId, bridge.snapshot().identity, "text"));
    assert.equal(fs.readFileSync(target, "utf8"), "DO NOT READ OR DELETE");
    const later = store.stage(stageCommand(bridge.snapshot(), { commandId: "attachment_expiry", idempotencyKey: "attachment-expiry-key-0000000000000" }));
    clock = new Date(now.getTime() + ATTACHMENT_LIMITS.ttlMs + 1);
    assert.throws(() => store.claim([later.attachment.attachmentRef], later.attachment.messageRequestId, bridge.snapshot().identity, "text"), /unavailable/);
    store.close(); assert.equal(fs.readFileSync(target, "utf8"), "DO NOT READ OR DELETE");
  });

  it("never follows a replaced store directory during discard cleanup", () => {
    const host = surface(), bridge = new SameSessionPiBridge({ appendEntry() {}, sendUserMessage() {} }, { runtimeInstanceId: "runtime_attachment_06", now: () => now });
    bridge.bind(host.ctx); const root = privateRoot();
    const store = new AttachmentStore({ runtimeInstanceId: "runtime_attachment_06", bridgeSnapshot: () => bridge.snapshot(),
      modelSupportsImages: () => true, now: () => now, tempRoot: root });
    const staged = store.stage(stageCommand(bridge.snapshot())), directory = fs.readdirSync(root).map((name) => path.join(root, name)).find((item) => fs.statSync(item).isDirectory());
    const filename = fs.readdirSync(directory)[0], moved = `${directory}-moved`, attackerDirectory = path.join(root, "attacker-target");
    fs.renameSync(directory, moved); fs.mkdirSync(attackerDirectory); fs.writeFileSync(path.join(attackerDirectory, filename), "MUST SURVIVE"); fs.symlinkSync(attackerDirectory, directory);
    assert.equal(store.execute(discardCommand(bridge.snapshot(), staged.attachment)).resultCode, "discarded");
    assert.equal(fs.readFileSync(path.join(attackerDirectory, filename), "utf8"), "MUST SURVIVE"); store.close();
    assert.equal(fs.readFileSync(path.join(attackerDirectory, filename), "utf8"), "MUST SURVIVE");
  });
});

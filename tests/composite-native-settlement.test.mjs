import assert from "node:assert/strict";
import { createHash, createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPOSITE_DELIVERY_CONFIRMATION_TYPE,
  capturePersistedAssistantResponse,
  commitCompositeWebUiDelivery,
  persistedAssistantResponseObservation,
  webUiDeliveryObservation
} from "../packages/piagent-core/runtime/verification/composite-session-persistence.ts";
import { loadPinnedPiHost } from "../packages/piagent-webui/gateway/pi-host.ts";
import { WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE }
  from "../packages/piagent-webui/shared/message-correlation.ts";
import { openCompositeAssuranceJournal }
  from "../packages/piagent-core/runtime/verification/runtime-assurance-facts.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const expectedHostVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
  .peerDependencies["@earendil-works/pi-coding-agent"];
const sha = value => createHash("sha256").update(value).digest("hex");
const responseText = "The durable native response is exact.";
const operationRef = "operation_native_settlement";
const messageRequestId = "request_native_settlement";

function assistantMessage(text = responseText) {
  return { role: "assistant", content: [{ type: "text", text }], api: "fixture", provider: "fixture", model: "fixture",
    stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function fixture(t, configure = () => {}) {
  const host = await loadPinnedPiHost(expectedHostVersion);
  const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "piagent-native-settlement-")));
  const cwd = path.join(temporaryRoot, "project"), sessionDir = path.join(temporaryRoot, "sessions");
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(sessionDir, { mode: 0o700 });
  const sessionId = `native-settlement-${path.basename(temporaryRoot).slice(-8)}`;
  const manager = host.SessionManager.create(cwd, sessionDir, { id: sessionId });
  configure({ manager, host, cwd, sessionDir, sessionId, beforeAssistant: true });
  manager.appendCustomEntry(WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE,
    { schemaVersion: 1, messageRequestId, operationRef });
  manager.appendMessage({ role: "user", content: "Return the exact durable fixture response.", timestamp: Date.now() });
  manager.appendMessage(assistantMessage());
  const message = manager.getBranch().at(-1).message;
  configure({ manager, host, cwd, sessionDir, sessionId, message, beforeAssistant: false });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  return { manager, host, cwd, sessionDir, sessionId, message, file: manager.getSessionFile() };
}

function capture(f) {
  return capturePersistedAssistantResponse({ cwd: f.cwd, sessionId: f.sessionId,
    manager: f.manager, message: f.message, expectedText: responseText });
}

function journalFixture(t, suffix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `piagent-anchor-${suffix}-`)));
  const projectRoot = path.join(root, "project"), authority = path.join(root, "authority");
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
  const filePath = path.join(authority, "journal.jsonl"), contextDigest = sha(`anchor-context:${suffix}`),
    key = createSecretKey(randomBytes(32));
  const open = () => openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest });
  const journal = open();
  t.after(() => { try { journal.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return { root, projectRoot, authority, filePath, anchorPath: `${filePath}.anchor.json`, contextDigest, key, journal, open };
}

test("native response capability is minted only from the exact persisted Pi branch object", async t => {
  const f = await fixture(t), capability = capture(f), observed = persistedAssistantResponseObservation(capability);
  assert.equal(observed.sessionId, f.sessionId);
  assert.equal(observed.file, f.file);
  assert.equal(observed.entryId, f.manager.getLeafId());
  assert.equal(observed.digest, sha(responseText));
  assert.equal(observed.byteLength, Buffer.byteLength(responseText));
  assert.equal(observed.bytes, responseText);
  assert.throws(() => persistedAssistantResponseObservation(Object.freeze({ ...capability })), /untrusted-native-response-capability/);
  assert.throws(() => capturePersistedAssistantResponse({ cwd: f.cwd, sessionId: f.sessionId,
    manager: f.manager, message: structuredClone(f.message), expectedText: responseText }), /object-identity-mismatch/);
  assert.throws(() => capturePersistedAssistantResponse({ cwd: f.cwd, sessionId: f.sessionId,
    manager: f.manager, message: f.message, expectedText: `${responseText}!` }), /input-invalid/);
});

test("native response capture rejects a wrong session identity and a non-leaf response", async t => {
  const f = await fixture(t);
  assert.throws(() => capturePersistedAssistantResponse({ cwd: f.cwd, sessionId: "different-session",
    manager: f.manager, message: f.message, expectedText: responseText }), /header-invalid/);
  f.manager.appendCustomEntry("fixture-after-response", { schemaVersion: 1 });
  assert.throws(() => capture(f), /branch-identity-mismatch/);
});

test("native response capture rejects noncanonical and canonically tampered session bytes", async t => {
  const noncanonical = await fixture(t), original = fs.readFileSync(noncanonical.file, "utf8"), lines = original.trimEnd().split("\n");
  lines[lines.length - 1] = `${lines.at(-1).slice(0, -1)}, \"extra\":null}`;
  fs.writeFileSync(noncanonical.file, `${lines.join("\n")}\n`);
  assert.throws(() => capture(noncanonical), /noncanonical-record/);

  const tampered = await fixture(t), records = fs.readFileSync(tampered.file, "utf8").trimEnd().split("\n").map(JSON.parse);
  records.at(-1).message.content[0].text = "Tampered response";
  fs.writeFileSync(tampered.file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  assert.throws(() => capture(tampered), /memory-disk-mismatch/);
});

test("terminal delivery is appended once, survives reopen, and returns only branded observations", async t => {
  const f = await fixture(t), response = capture(f), idempotencyKey = sha("native-delivery-idempotency");
  const first = commitCompositeWebUiDelivery({ response, manager: f.manager, taskRunId: "task-native-settlement",
    operationRef, messageRequestId, idempotencyKey });
  const observed = webUiDeliveryObservation(first);
  assert.equal(observed.operationRef, operationRef);
  assert.equal(observed.messageRequestId, messageRequestId);
  assert.equal(first.responseEntryId, observed.entryId);
  assert.equal(observed.entryId, f.manager.getBranch().find(entry => entry.type === "message"
    && entry.message?.role === "assistant").id);
  assert.equal(f.manager.getBranch().filter(entry => entry.customType === COMPOSITE_DELIVERY_CONFIRMATION_TYPE).length, 1);
  const reopened = f.host.SessionManager.open(f.file, f.sessionDir);
  const replay = commitCompositeWebUiDelivery({ response, manager: reopened, taskRunId: "task-native-settlement",
    operationRef, messageRequestId, idempotencyKey });
  assert.equal(webUiDeliveryObservation(replay).confirmationEntryId, observed.confirmationEntryId);
  assert.equal(reopened.getBranch().filter(entry => entry.customType === COMPOSITE_DELIVERY_CONFIRMATION_TYPE).length, 1);
  assert.throws(() => webUiDeliveryObservation(Object.freeze({ ...first })), /untrusted-native-delivery-capability/);
});

test("terminal delivery rejects wrong correlation, ambiguous correlation, and changed idempotency", async t => {
  const wrong = await fixture(t), response = capture(wrong), idempotencyKey = sha("native-delivery-negative");
  assert.throws(() => commitCompositeWebUiDelivery({ response, manager: wrong.manager, taskRunId: "task-native-settlement",
    operationRef: "operation_wrong", messageRequestId, idempotencyKey }), /correlation-mismatch/);
  commitCompositeWebUiDelivery({ response, manager: wrong.manager, taskRunId: "task-native-settlement",
    operationRef, messageRequestId, idempotencyKey });
  assert.throws(() => commitCompositeWebUiDelivery({ response, manager: wrong.manager, taskRunId: "task-native-settlement",
    operationRef, messageRequestId, idempotencyKey: sha("different-idempotency") }), /replay-mismatch/);

  const duplicate = await fixture(t, ({ manager, beforeAssistant }) => {
    if (beforeAssistant) manager.appendCustomEntry(WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE,
      { schemaVersion: 1, messageRequestId, operationRef });
  });
  assert.throws(() => commitCompositeWebUiDelivery({ response: capture(duplicate), manager: duplicate.manager,
    taskRunId: "task-native-settlement", operationRef, messageRequestId,
    idempotencyKey: sha("ambiguous-correlation") }), /correlation-mismatch/);
});

test("prepared anchor recovers a crash before the journal append", t => {
  const f = journalFixture(t, "before-append"), before = f.journal.head(), originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = function(file, flags, ...rest) {
    if (!injected && file === f.filePath && (flags & fs.constants.O_APPEND)) {
      injected = true; throw new Error("injected-before-journal-append");
    }
    return originalOpen.call(fs, file, flags, ...rest);
  };
  try { assert.throws(() => f.journal.append("probe", { crash: "before-append" }), /injected-before-journal-append/); }
  finally { fs.openSync = originalOpen; f.journal.close(); }
  const reopened = f.open();
  assert.notEqual(reopened.head(), before);
  assert.deepEqual(reopened.events().map(event => [event.kind, event.data.crash]), [["probe", "before-append"]]);
  reopened.close();
});

test("prepared anchor completes an exact partially written journal line", t => {
  const f = journalFixture(t, "partial-line"), journalInode = fs.statSync(f.filePath).ino, originalWrite = fs.writeSync;
  let partial = false, failed = false;
  fs.writeSync = function(fd, buffer, offset, length, position) {
    const requested = Number.isInteger(length) ? length : buffer.length - offset;
    if (fs.fstatSync(fd).ino === journalInode && !partial && requested > 8) {
      partial = true; return originalWrite.call(fs, fd, buffer, offset, Math.floor(requested / 2), position ?? null);
    }
    if (fs.fstatSync(fd).ino === journalInode && partial && !failed) {
      failed = true; throw new Error("injected-partial-journal-line");
    }
    return originalWrite.apply(fs, arguments);
  };
  try { assert.throws(() => f.journal.append("probe", { crash: "partial-line" }), /injected-partial-journal-line/); }
  finally { fs.writeSync = originalWrite; f.journal.close(); }
  assert.notEqual(fs.readFileSync(f.filePath).at(-1), 10);
  const reopened = f.open();
  assert.equal(fs.readFileSync(f.filePath).at(-1), 10);
  assert.deepEqual(reopened.events().map(event => event.data.crash), ["partial-line"]);
  reopened.close();
});

test("prepared anchor commits a fully written journal line after a commit crash", t => {
  const f = journalFixture(t, "before-anchor-commit"), originalRename = fs.renameSync;
  let anchorRenames = 0;
  fs.renameSync = function(from, to) {
    if (to === f.anchorPath && ++anchorRenames === 2) throw new Error("injected-before-anchor-commit");
    return originalRename.call(fs, from, to);
  };
  try { assert.throws(() => f.journal.append("probe", { crash: "before-anchor-commit" }), /injected-before-anchor-commit/); }
  finally { fs.renameSync = originalRename; f.journal.close(); }
  assert.equal(fs.readFileSync(f.filePath).at(-1), 10);
  const reopened = f.open();
  assert.deepEqual(reopened.events().map(event => event.data.crash), ["before-anchor-commit"]);
  assert.equal(JSON.parse(fs.readFileSync(f.anchorPath, "utf8")).payload.state, "committed");
  reopened.close();
});

test("committed anchor rejects a valid-prefix journal rollback", t => {
  const f = journalFixture(t, "rollback"); f.journal.append("probe", { crash: "none" }); f.journal.close();
  const [header] = fs.readFileSync(f.filePath, "utf8").trimEnd().split("\n");
  fs.writeFileSync(f.filePath, `${header}\n`);
  assert.throws(() => f.open(), /rollback or wrong anchored head/);
});

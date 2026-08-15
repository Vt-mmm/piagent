import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SessionCommandController } from "../packages/piagent-webui/gateway/session-command-controller.ts";
import { SessionCommandStore } from "../packages/piagent-webui/gateway/session-command-store.ts";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { buildSessionCatalog, sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { SessionMetadataStore } from "../packages/piagent-webui/gateway/session-metadata-store.ts";
import { webUiModelRef } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-command-admission-")); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 11), info = { path: path.join(root, "session.jsonl"), id: "raw-session", cwd: path.join(root, "project"),
    name: "Command admission", created: new Date("2026-08-14T09:00:00.000Z"), modified: new Date("2026-08-14T09:00:01.000Z"),
    messageCount: 2, firstMessage: "Continue safely.", allMessagesText: "Continue safely.\nReady." };
  const sessionRef = sessionRefForPath(key, info.path), leases = new SessionLeaseStore(root, key); let opened = 0, disposed = 0;
  const runtimes = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_command_test", key, leases, listSessions: async () => [info],
    runtimeFactory: async () => { opened += 1; return { async dispose() { disposed += 1; } }; } });
  const catalog = () => buildSessionCatalog({ gatewayInstanceRef: "gateway_command_test", key, listSessions: async () => [info],
    readOwnership: (value) => runtimes.ownership(value) });
  const store = new SessionCommandStore(root, key), events = new GatewayEventStore();
  const controller = new SessionCommandController({ catalog, runtimes, store, events, now: () => new Date("2026-08-14T09:06:00.000Z") });
  return { root, info, sessionRef, runtimes, catalog, store, events, controller, counts: () => ({ opened, disposed }) };
}

function command(row, catalogRevision, action, suffix, idempotencyKey = `idempotency_key_${suffix}_1234567890`) {
  return { schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command", commandId: `command_${suffix}`,
    idempotencyKey, action, requestedAt: "2026-08-14T09:05:00.000Z", expiresAt: "2026-08-14T09:10:00.000Z",
    sessionRef: row.sessionRef, expectedCatalogRevision: catalogRevision, expectedSessionRevision: row.sessionRevision, payload: {} };
}

describe("Piagent durable session command admission", () => {
  it("creates one durable session, starts its first prompt, and deduplicates the browser retry", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-create-")); fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const key = Buffer.alloc(32, 19), createdInfo = { path: path.join(root, "created.jsonl"), id: "raw-created",
      cwd: path.join(root, "project"), name: "New session", created: new Date("2026-08-14T09:05:01.000Z"),
      modified: new Date("2026-08-14T09:05:02.000Z"), messageCount: 1, firstMessage: "Build safely.", allMessagesText: "Build safely." };
    let sessions = [], creates = 0, sends = 0;
    const catalog = () => buildSessionCatalog({ gatewayInstanceRef: "gateway_create_test", key, listSessions: async () => sessions });
    const runtimes = {
      async create(projectRef, placeRef, modelRef, thinkingLevel) {
        creates += 1; assert.equal(projectRef, placeRef); assert.equal(modelRef, null); assert.equal(thinkingLevel, "high");
        sessions = [createdInfo]; return sessionRefForPath(key, createdInfo.path);
      },
      async send(sessionRef, payload) {
        sends += 1; assert.equal(sessionRef, sessionRefForPath(key, createdInfo.path)); assert.equal(payload.message, "Build safely.");
        return { resultCode: "started", operationRef: "operation_create_01" };
      }
    };
    const before = await catalog(), controller = new SessionCommandController({ catalog, runtimes,
      store: new SessionCommandStore(root, key), events: new GatewayEventStore(), now: () => new Date("2026-08-14T09:06:00.000Z") });
    const command = { schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
      commandId: "command_create_0001", idempotencyKey: "idempotency_create_1234567890", action: "session.create",
      requestedAt: "2026-08-14T09:05:00.000Z", expiresAt: "2026-08-14T09:10:00.000Z", sessionRef: null,
      expectedCatalogRevision: before.catalogRevision, expectedSessionRevision: null,
      payload: { projectRef: "project_create_01", placeRef: "project_create_01", modelRef: null, thinkingLevel: "high",
        message: "Build safely.", messageRequestId: "message_create_01" } };
    const receipt = await controller.execute(command);
    assert.equal(validateFixture(registry, "session-command-v1", receipt).valid, true);
    assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "started");
    assert.equal(receipt.sessionRef, sessionRefForPath(key, createdInfo.path)); assert.equal(receipt.operationRef, "operation_create_01");
    const replay = await controller.execute(command);
    assert.equal(replay.deduplicated, true); assert.equal(replay.sessionRef, receipt.sessionRef);
    assert.equal(creates, 1); assert.equal(sends, 1);
  });

  it("acquires and releases once with schema-valid durable deduplicated receipts", async (t) => {
    const value = fixture(t), before = await value.catalog(), row = before.sessions[0];
    const acquire = command(row, before.catalogRevision, "session.acquire", "acquire_0001");
    const receipt = await value.controller.execute(acquire);
    assert.equal(validateFixture(registry, "session-command-v1", receipt).valid, true);
    assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "acquired");
    assert.equal(value.counts().opened, 1);
    const replay = await value.controller.execute(acquire);
    assert.equal(replay.deduplicated, true); assert.equal(replay.evidenceRef, receipt.evidenceRef); assert.equal(value.counts().opened, 1);
    assert.equal(fs.statSync(value.store.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(value.store.file).mode & 0o777, 0o600);

    const stale = await value.controller.execute(command(row, before.catalogRevision, "session.release", "stale_release_01"));
    assert.equal(stale.phase, "rejected"); assert.equal(stale.resultCode, "stale-revision"); assert.equal(value.counts().disposed, 0);
    const owned = await value.catalog(), release = command(owned.sessions[0], owned.catalogRevision, "session.release", "release_0001");
    const released = await value.controller.execute(release);
    assert.equal(validateFixture(registry, "session-command-v1", released).valid, true);
    assert.equal(released.resultCode, "released"); assert.equal(value.counts().disposed, 1);
    assert.equal(value.events.replay(0).events.filter((event) => event.kind === "session.changed").length, 2);
    await value.runtimes.close();
  });

  it("changes model, thinking, and permission through revision-bound session commands while idle", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-options-")); fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const key = Buffer.alloc(32, 23), info = { path: path.join(root, "session.jsonl"), id: "raw-options", cwd: path.join(root, "project"),
      name: "Options", created: new Date("2026-08-14T09:00:00.000Z"), modified: new Date("2026-08-14T09:00:01.000Z"),
      messageCount: 2, firstMessage: "Options", allMessagesText: "Options" };
    let modelLabel = "Fixture One", thinkingLevel = "high", modelCalls = 0, thinkingCalls = 0, permissionCalls = 0;
    const models = [{ provider: "fixture", id: "one", name: "Fixture One" }, { provider: "fixture", id: "two", name: "Fixture Two" }];
    const session = { isIdle: true, model: models[0], thinkingLevel, messages: [], modelRuntime: { getAvailableSnapshot: () => models },
      async setModel(value) { this.model = value; modelLabel = value.name; modelCalls += 1; },
      setThinkingLevel(value) { this.thinkingLevel = value; thinkingLevel = value; thinkingCalls += 1; },
      async prompt(text) { const mode = text.replace("/permission ", ""); permissionCalls += 1; this.messages.push({ role: "custom",
        customType: "piagent-permission-profile", details: { permissionProfile: { mode, warning: null } } }); } };
    const leases = new SessionLeaseStore(root, key), events = new GatewayEventStore();
    const runtimes = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_options_test", key, leases, listSessions: async () => [info], events,
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    const catalog = () => buildSessionCatalog({ gatewayInstanceRef: "gateway_options_test", key, listSessions: async () => [info],
      readOwnership: (value) => runtimes.ownership(value), readSessionOptions: () => ({ modelLabel, thinkingLevel }) });
    const controller = new SessionCommandController({ catalog, runtimes, store: new SessionCommandStore(root, key), events,
      now: () => new Date("2026-08-14T09:06:00.000Z") });
    let current = await catalog(), row = current.sessions[0];
    const setModel = { ...command(row, current.catalogRevision, "session.set-model", "set_model_001"),
      payload: { modelRef: webUiModelRef("fixture", "two") } };
    const modelReceipt = await controller.execute(setModel);
    assert.equal(validateFixture(registry, "session-command-v1", modelReceipt).valid, true);
    assert.equal(modelReceipt.resultCode, "model-changed"); assert.equal(modelCalls, 1);
    current = await catalog(); row = current.sessions[0]; assert.equal(row.modelLabel, "Fixture Two");
    const setThinking = { ...command(row, current.catalogRevision, "session.set-thinking", "set_thinking_001"), payload: { thinkingLevel: "low" } };
    const thinkingReceipt = await controller.execute(setThinking);
    assert.equal(validateFixture(registry, "session-command-v1", thinkingReceipt).valid, true);
    assert.equal(thinkingReceipt.resultCode, "thinking-changed"); assert.equal(thinkingCalls, 1);
    assert.equal((await catalog()).sessions[0].thinkingLevel, "low");
    const replay = await controller.execute(setThinking);
    assert.equal(replay.deduplicated, true); assert.equal(thinkingCalls, 1);
    current = await catalog(); row = current.sessions[0];
    const setPermission = { ...command(row, current.catalogRevision, "session.set-permission", "set_permission_001"),
      payload: { permissionMode: "workspace-write" } };
    const permissionReceipt = await controller.execute(setPermission);
    assert.equal(validateFixture(registry, "session-command-v1", permissionReceipt).valid, true);
    assert.equal(permissionReceipt.resultCode, "permission-changed"); assert.equal(permissionCalls, 1);
    await runtimes.close();
  });

  it("turns orphan intent into durable uncertainty and never repeats the effect", async (t) => {
    const value = fixture(t), before = await value.catalog(), pending = command(before.sessions[0], before.catalogRevision,
      "session.acquire", "orphan_intent_01");
    value.store.admit(pending, new Date("2026-08-14T09:05:01.000Z"));
    const uncertain = await value.controller.execute(pending);
    assert.equal(validateFixture(registry, "session-command-v1", uncertain).valid, true);
    assert.equal(uncertain.phase, "uncertain"); assert.equal(uncertain.resultCode, "effect-unknown");
    assert.equal(value.counts().opened, 0);
    const replay = await value.controller.execute(pending);
    assert.equal(replay.deduplicated, true); assert.equal(replay.phase, "uncertain"); assert.equal(value.counts().opened, 0);
    await value.runtimes.close();
  });

  it("rejects idempotency payload mismatch and corrupt journal without opening a runtime", async (t) => {
    const value = fixture(t), before = await value.catalog(), original = command(before.sessions[0], before.catalogRevision,
      "session.acquire", "binding_one_001", "shared_idempotency_key_1234567890");
    value.store.admit(original);
    const mismatch = command(before.sessions[0], before.catalogRevision, "session.release", "binding_two_002",
      "shared_idempotency_key_1234567890");
    const rejected = await value.controller.execute(mismatch);
    assert.equal(rejected.phase, "rejected"); assert.equal(rejected.resultCode, "invalid-command");
    fs.appendFileSync(value.store.file, "{\"forged\":true}\n");
    const unavailable = await value.controller.execute(command(before.sessions[0], before.catalogRevision,
      "session.acquire", "corrupt_store_01"));
    assert.equal(unavailable.phase, "rejected"); assert.equal(unavailable.resultCode, "unavailable");
    assert.equal(value.counts().opened, 0);
    await value.runtimes.close();
  });

  it("starts, streams and aborts one operation with redacted schema-valid live events", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-send-")); fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const key = Buffer.alloc(32, 13), info = { path: path.join(root, "session.jsonl"), id: "raw-send", cwd: path.join(root, "project"),
      name: "Send proof", created: new Date("2026-08-14T10:00:00.000Z"), modified: new Date("2026-08-14T10:00:01.000Z"),
      messageCount: 2, firstMessage: "Send safely.", allMessagesText: "Send safely.\nReady." };
    const sessionRef = sessionRefForPath(key, info.path), events = new GatewayEventStore();
    const listeners = new Set(); let finishPrompt, promptText = null, aborted = 0;
    const session = {
      isIdle: true, isStreaming: false,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt(text) {
        promptText = text; this.isIdle = false; this.isStreaming = true;
        for (const listener of listeners) {
          listener({ type: "agent_start" });
          listener({ type: "message_start", message: { role: "assistant" } });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta",
            delta: "Safe reply sk-proj-THIS_IS_SECRET_1234567890\n" } });
          listener({ type: "tool_execution_start", toolCallId: "raw-tool", toolName: "read sk-proj-TOOL_SECRET_1234567890" });
          listener({ type: "tool_execution_end", toolCallId: "raw-tool", toolName: "read sk-proj-TOOL_SECRET_1234567890", isError: false });
        }
        return new Promise((resolve) => { finishPrompt = resolve; });
      },
      async abort() {
        aborted += 1;
        for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant" } });
        this.isStreaming = false; this.isIdle = true; finishPrompt();
      },
      clearQueue() {}
    };
    const runtimes = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_send_test", key,
      leases: new SessionLeaseStore(root, key), listSessions: async () => [info], events,
      runtimeFactory: async () => ({ session, async dispose() {} }) });
    const catalog = () => buildSessionCatalog({ gatewayInstanceRef: "gateway_send_test", key, listSessions: async () => [info],
      readOwnership: (value) => runtimes.ownership(value) });
    runtimes.setProjectionReader(async (value) => {
      const current = await catalog(), row = current.sessions.find((item) => item.sessionRef === value);
      return { sessionRevision: row.sessionRevision, liveState: row.liveState };
    });
    const controller = new SessionCommandController({ catalog, runtimes, store: new SessionCommandStore(root, key), events,
      now: () => new Date("2026-08-14T10:06:00.000Z") });
    const before = await catalog(), row = before.sessions[0];
    const send = { ...command(row, before.catalogRevision, "session.send", "send_message_01"),
      requestedAt: "2026-08-14T10:05:00.000Z", expiresAt: "2026-08-14T10:10:00.000Z",
      payload: { delivery: "new-operation", message: "Continue this session.", messageRequestId: "message_request_send_01",
        expectedOperationRef: null } };
    const started = await controller.execute(send);
    assert.equal(validateFixture(registry, "session-command-v1", started).valid, true);
    assert.equal(started.resultCode, "started"); assert.match(started.operationRef, /^operation_/); assert.equal(promptText, "Continue this session.");
    const streamed = events.replay(0).events;
    for (const event of streamed) assert.equal(validateFixture(registry, "gateway-protocol-v1", event).valid, true);
    assert.equal(streamed.some((event) => event.kind === "message.delta"), true);
    assert.equal(JSON.stringify(streamed).includes("THIS_IS_SECRET"), false);
    assert.equal(JSON.stringify(streamed).includes("TOOL_SECRET"), false);

    const running = await catalog(), runningRow = running.sessions[0];
    const abort = { ...command(runningRow, running.catalogRevision, "session.abort", "abort_message_01"),
      requestedAt: "2026-08-14T10:05:30.000Z", expiresAt: "2026-08-14T10:10:00.000Z",
      payload: { operationRef: started.operationRef, clearQueued: true } };
    const stopped = await controller.execute(abort);
    assert.equal(validateFixture(registry, "session-command-v1", stopped).valid, true);
    assert.equal(stopped.resultCode, "aborted"); assert.equal(stopped.operationRef, started.operationRef); assert.equal(aborted, 1);
    assert.equal((await catalog()).sessions[0].liveState, "idle");
    assert.equal(events.replay(0).events.some((event) => event.kind === "message.completed"), true);
    await runtimes.close();
  });

  it("renames, pins, archives, restores and forks through revision-bound durable commands", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-actions-")); fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const key = Buffer.alloc(32, 23), source = { path: path.join(root, "source.jsonl"), id: "raw-actions", cwd: path.join(root, "project"),
      name: "Action source", created: new Date("2026-08-14T11:00:00.000Z"), modified: new Date("2026-08-14T11:00:01.000Z"),
      messageCount: 2, firstMessage: "Manage this session.", allMessagesText: "Manage this session.\nReady." };
    let sessions = [source], releases = 0, renames = 0, forks = 0;
    const metadata = new SessionMetadataStore(root, key), events = new GatewayEventStore();
    const runtimes = {
      ownership() { return { state: "offline", liveState: "offline", composerAvailable: true, needsAttention: false,
        owner: { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "released" }, reasonCode: null }; },
      async release() { releases += 1; },
      async rename() { renames += 1; return "renamed"; },
      async fork() {
        forks += 1; const child = { ...source, path: path.join(root, "fork.jsonl"), id: "raw-fork", name: "Forked action source",
          created: new Date("2026-08-14T11:06:00.000Z"), modified: new Date("2026-08-14T11:06:00.000Z") };
        sessions = [child, source]; return sessionRefForPath(key, child.path);
      }
    };
    const catalog = () => buildSessionCatalog({ gatewayInstanceRef: "gateway_actions_test", key, listSessions: async () => sessions,
      readMetadata: () => metadata.read(), readOwnership: () => runtimes.ownership() });
    const controller = new SessionCommandController({ catalog, runtimes, metadata, store: new SessionCommandStore(root, key), events,
      now: () => new Date("2026-08-14T11:06:00.000Z") });
    const run = async (action, suffix, payload = {}) => {
      const before = await catalog(), row = before.sessions.find((item) => item.sessionRef === sessionRefForPath(key, source.path));
      const receipt = await controller.execute({ ...command(row, before.catalogRevision, action, suffix),
        requestedAt: "2026-08-14T11:05:00.000Z", expiresAt: "2026-08-14T11:10:00.000Z", payload });
      assert.equal(validateFixture(registry, "session-command-v1", receipt).valid, true);
      assert.equal(receipt.phase, "settled", JSON.stringify(receipt)); return receipt;
    };
    assert.equal((await run("session.rename", "rename_action_01", { title: "Renamed safely" })).resultCode, "renamed");
    assert.equal(renames, 1);
    assert.equal((await run("session.pin", "pin_action_0001", { pinned: true })).resultCode, "pinned");
    assert.equal((await catalog()).sessions.find((item) => item.sessionRef === sessionRefForPath(key, source.path)).pinned, true);
    assert.equal((await run("session.fork", "fork_action_001", { entryRef: null, title: "Safe fork" })).resultCode, "forked");
    assert.equal(forks, 1); assert.equal(sessions.length, 2);
    assert.equal((await run("session.archive", "archive_action_01")).resultCode, "archived");
    assert.equal(releases, 1);
    const archived = await catalog(), archivedRow = archived.sessions.find((item) => item.sessionRef === sessionRefForPath(key, source.path));
    const restored = await controller.execute({ ...command(archivedRow, archived.catalogRevision, "session.unarchive", "unarchive_action_01"),
      requestedAt: "2026-08-14T11:05:00.000Z", expiresAt: "2026-08-14T11:10:00.000Z" });
    assert.equal(validateFixture(registry, "session-command-v1", restored).valid, true);
    assert.equal(restored.resultCode, "unarchived");
    assert.equal((await catalog()).sessions.find((item) => item.sessionRef === sessionRefForPath(key, source.path)).archived, false);
  });
});

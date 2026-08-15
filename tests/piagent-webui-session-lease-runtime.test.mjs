import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { webUiModelRef } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { piApprovalBroker } from "../packages/piagent-core/runtime/inspection/approval-broker.ts";
import { buildSessionCatalog, projectRefForCwd, sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { loadPinnedPiHost } from "../packages/piagent-webui/gateway/pi-host.ts";
import { TerminalSessionAdapter } from "../packages/piagent-webui/extension/terminal-session-adapter.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const repositoryRoot = path.resolve(import.meta.dirname, "..");

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

  it("creates an unpersisted Pi session under one lease and projects it until the first assistant reply persists", async (t) => {
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
          modelRuntime: { getAvailableSnapshot: () => [selectedModel] },
          async setModel(model) { modelSet = model; }, setThinkingLevel(level) { thinkingSet = level; }
        }, async dispose() { disposed += 1; } };
      }
    });
    const projectRef = projectRefForCwd(key, seed.cwd);
    const sessionRef = await supervisor.create(projectRef, projectRef, webUiModelRef("fixture", "reasoning-model"), "high");
    assert.equal(sessionRef, sessionRefForPath(key, newFile));
    assert.equal(passedManager, manager);
    assert.equal(modelSet, selectedModel);
    assert.equal(thinkingSet, "high");
    assert.equal(supervisor.ownership(sessionRef).state, "gateway-owned");
    assert.equal((await supervisor.listSessions()).find((value) => value.path === newFile)?.firstMessage, "(no messages)");
    await supervisor.release(sessionRef);
    assert.equal(disposed, 1);
    assert.equal((await supervisor.listSessions()).some((value) => value.path === newFile), false);
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
      gatewayInstanceRef: "gateway_real_runtime", key, leases: new SessionLeaseStore(root, key), listSessions: async () => sessions,
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
});

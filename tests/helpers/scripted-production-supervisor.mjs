import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { installedPiHostRoot, loadPinnedPiHost } from "../../packages/piagent-webui/gateway/pi-host.ts";
import { SessionRuntimeSupervisor } from "../../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { SessionLeaseStore } from "../../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionCommandStore } from "../../packages/piagent-webui/gateway/session-command-store.ts";
import { SessionCommandController } from "../../packages/piagent-webui/gateway/session-command-controller.ts";
import { GatewayEventStore } from "../../packages/piagent-webui/gateway/gateway-events.ts";
import { SessionInspectionRegistry } from "../../packages/piagent-webui/gateway/session-inspection-registry.ts";
import { buildSessionCatalog, projectRefForCwd } from "../../packages/piagent-webui/gateway/session-catalog.ts";
import { webUiModelRef } from "../../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { activeSessionTask } from "../../packages/piagent-core/extensions/task-state.js";
import { captureJourneyBeforeClose, readClosedJourney } from "./closed-journey-readback.mjs";
import { productionJourneyTransport } from "./production-journey-transport.mjs";

const model = { id: "fixture", name: "Offline scripted fixture", api: "fixture", provider: "fixture", baseUrl: "",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 16000 };
export const scriptedText = text => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
export const scriptedTool = (id, name, args) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" });

async function localPiAi() {
  const hostRoot = installedPiHostRoot();
  const roots = [path.join(hostRoot, "node_modules/@earendil-works/pi-ai"), path.join(path.dirname(hostRoot), "pi-ai")];
  const root = roots.find(value => fs.existsSync(path.join(value, "dist/index.js")));
  assert.ok(root, "the pinned host's local model interface must be available");
  return await import(pathToFileURL(path.join(root, "dist/index.js")).href);
}

export async function scriptedProductionSupervisor({ root, cwd, agentDir, repositoryRoot, transport = "controller", fixtureUsage = null, scopedBrokerRouter }) {
  assert.ok(["controller", "loopback"].includes(transport), "unknown offline journey transport");
  // Explicit fixture accounting, never provider usage. The actual SDK persists
  // this scripted response through its ordinary session writer/inspection path.
  if (fixtureUsage !== null) {
    assert.deepEqual(Object.keys(fixtureUsage).sort(), ["cacheRead", "cacheWrite", "input", "output", "totalTokens"]);
    assert.ok(Object.values(fixtureUsage).every(value => Number.isSafeInteger(value) && value >= 0));
    assert.equal(fixtureUsage.totalTokens, fixtureUsage.input + fixtureUsage.output + fixtureUsage.cacheRead + fixtureUsage.cacheWrite);
    fixtureUsage = Object.freeze({ ...fixtureUsage });
  }
  const host = await loadPinnedPiHost(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
    .peerDependencies["@earendil-works/pi-coding-agent"]);
  const piAi = await localPiAi(), sessionDir = path.join(agentDir, "sessions"), gatewayRoot = path.join(root, "gateway");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(gatewayRoot, { mode: 0o700 });
  const metrics = { scriptedTurns: 0, unexpectedTurns: 0, realProviderCalls: 0 };
  const contexts = [], rawEvents = [], extensionErrors = [], serviceErrors = [], projectResources = [];
  let queue = [], currentTurn = null;
  const readbackTurns = [], scenarioId = process.env.PIAGENT_BENCHMARK_SCENARIO ?? null;
  let closePromise;
  const modelRuntime = {
    async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => { throw new Error("real-auth-forbidden"); },
    getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() { throw new Error("real-provider-registration-forbidden"); },
    registerNativeProvider() { throw new Error("real-provider-registration-forbidden"); }, unregisterProvider() {},
    streamSimple(_model, context) {
      metrics.scriptedTurns++;
      contexts.push({ turnId: currentTurn, messages: structuredClone(context.messages) });
      let turn = queue.shift();
      if (!turn) { metrics.unexpectedTurns++; turn = scriptedText("The offline script has no further action. Work remains unverified; operator attention is required."); }
      if (metrics.unexpectedTurns > 2) throw new Error("unbounded-offline-model-continuation");
      const stream = piAi.createAssistantMessageEventStream();
      const message = { ...turn, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { ...(fixtureUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    }
  };
  class ScopedSessionManager extends host.SessionManager {
    static create(target) { assert.equal(target, cwd); return host.SessionManager.create(target, sessionDir); }
  }
  const runtimeHost = { ...host, SessionManager: ScopedSessionManager,
    async createAgentSessionServices(options) {
      try {
        // Trust only this generated test-owned project. Do not load personal
        // settings or change the production guard, tools, workflows or profile.
        const projectSettings = JSON.parse(fs.readFileSync(path.join(cwd, ".pi/settings.json"), "utf8"));
        const settingsManager = host.SettingsManager.inMemory(projectSettings, { projectTrusted: true });
        const services = await host.createAgentSessionServices({ ...options, settingsManager });
        projectResources.push({ packages: structuredClone(settingsManager.getPackages()),
          extensions: services.resourceLoader.getExtensions().extensions.map(extension =>
            path.resolve(extension.resolvedPath || extension.path)) });
        return services;
      }
      catch (error) { serviceErrors.push(String(error?.stack ?? error)); throw error; }
    },
    async createAgentSessionFromServices(options) {
      const created = await host.createAgentSessionFromServices({ ...options,
        customTools: [host.createBashToolDefinition(cwd, { spawnHook(input) {
          const env = { ...input.env }; delete env.NODE_TEST_CONTEXT; return { ...input, env };
        } })] });
      created.session.subscribe(event => rawEvents.push(event));
      created.session.extensionRunner.onError(error => extensionErrors.push(error));
      return created;
    }
  };
  const key = randomBytes(32), gatewayInstanceRef = "gateway_offline_journey", events = new GatewayEventStore({ maximumCount: 10000 });
  const observed = [], unsubscribe = events.subscribe(event => observed.push(event));
  const projectRef = projectRefForCwd(key, cwd);
  const leases = new SessionLeaseStore(gatewayRoot, key);
  const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef, key, events,
    leases, host: runtimeHost, agentDir, packageRoot: repositoryRoot, modelRuntime, scopedBrokerRouter,
    listSessions: () => host.SessionManager.list(cwd, sessionDir), resolveProject: ref => ref === projectRef ? cwd : null });
  const catalog = () => buildSessionCatalog({ gatewayInstanceRef, key, listSessions: () => supervisor.listSessions(),
    readOwnership: ref => supervisor.ownership(ref) });
  supervisor.setProjectionReader(async ref => {
    const row = (await catalog()).sessions.find(item => item.sessionRef === ref);
    assert.ok(row); return { sessionRevision: row.sessionRevision, liveState: row.liveState };
  });
  const store = new SessionCommandStore(gatewayRoot, key);
  const controller = new SessionCommandController({ catalog, runtimes: supervisor, store, events });
  const inspections = new SessionInspectionRegistry({ gatewayInstanceRef, host, key, packageRoot: repositoryRoot,
    agentDir, models: modelRuntime, listSessions: () => supervisor.listSessions(),
    openLiveSession: ref => supervisor.liveSessionManager(ref),
    operationLiveness: ref => supervisor.currentOperation(ref) ? "running" : "idle" });
  let wire = null;
  try {
    if (transport === "loopback") wire = await productionJourneyTransport({ root, repositoryRoot,
      gatewayInstanceRef, catalog, controller, events, supervisor, readSessionModel: ref => inspections.provider(ref) });
  } catch (error) { unsubscribe(); await supervisor.close(); throw error; }
  let sessionRef = null;
  async function command(action, payload, deadline, turn) {
    const current = await (wire ? wire.readCatalog(deadline) : catalog());
    const row = current.sessions.find(item => item.sessionRef === sessionRef);
    const now = Date.now();
    const value = { schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
      commandId: `command_${randomBytes(12).toString("hex")}`, idempotencyKey: randomBytes(24).toString("base64url"),
      action, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString(),
      sessionRef, expectedCatalogRevision: current.catalogRevision, expectedSessionRevision: row?.sessionRevision ?? null, payload };
    if (wire && turn.receiptUncertain === true) return { command: value, ...await wire.sendUncertain(value, deadline) };
    const receipt = await (wire ? wire.command(value, deadline) : controller.execute(value));
    assert.equal(receipt.phase, "settled", JSON.stringify({ receipt, serviceErrors, extensionErrors }));
    assert.equal(receipt.error, null, JSON.stringify({ receipt, serviceErrors, extensionErrors }));
    return { command: value, receipt, sessionRef: receipt.sessionRef, operationRef: receipt.operationRef, recovery: null };
  }
  return {
    metrics, contexts, rawEvents, extensionErrors, serviceErrors, projectResources, observed, supervisor, transport: wire,
    async turn(turn, scripted, timeoutMs = 60000) {
      assert.equal(queue.length, 0, "the preceding script must settle before another journey turn");
      const deadline = Date.now() + timeoutMs;
      await wire?.beforeTurn(turn, sessionRef, deadline);
      currentTurn = turn.id; queue = [...scripted];
      const before = metrics.scriptedTurns, start = observed.length;
      const messageRequestId = `message_${randomBytes(12).toString("hex")}`;
      const sent = await command(sessionRef ? "session.send" : "session.create", sessionRef
        ? { delivery: "new-operation", message: turn.message, messageRequestId, expectedOperationRef: null,
          attachmentRefs: [], ...(turn.workflow ? { workflow: turn.workflow } : {}) }
        : { projectRef, placeRef: projectRef, modelRef: webUiModelRef(model.provider, model.id), thinkingLevel: "off",
          ...(wire ? { permissionMode: "workspace-write" } : {}),
          message: turn.message, messageRequestId, ...(turn.workflow ? { workflow: turn.workflow } : {}) }, deadline, turn);
      sessionRef = sent.sessionRef;
      const wireSettlement = wire ? await wire.waitSettlement(sent, messageRequestId, deadline) : null;
      while (!wire && supervisor.currentOperation(sessionRef) !== null) {
        if (Date.now() >= deadline) throw new Error(`offline-journey-timeout:${turn.id}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const settled = observed.slice(start).filter(event => event.kind === "operation.settled"
        && event.payload.operationRef === sent.operationRef);
      assert.equal(settled.length, 1, JSON.stringify({ turn: turn.id, sent, observed, extensionErrors }));
      assert.equal(settled[0].payload.messageRequestId, messageRequestId);
      if (wire) assert.deepEqual(wireSettlement.payload, settled[0].payload);
      const manager = supervisor.liveSessionManager(sessionRef), task = activeSessionTask(cwd, manager.getSessionId());
      const result = { turnId: turn.id, ...sent, settlement: wireSettlement?.payload ?? settled[0].payload,
        wireSettlement, transport: wire?.snapshot() ?? null,
        task: task ? structuredClone(task) : null, sessionId: manager.getSessionId(),
        entries: structuredClone(manager.getBranch()), scriptedTurns: metrics.scriptedTurns - before, unconsumedScript: queue.length };
      readbackTurns.push({ id: turn.id, message: turn.message, messageRequestId,
        operationRef: sent.operationRef, taskRunId: result.task?.taskRunId ?? null,
        taskStatus: result.settlement.taskStatus });
      queue = [];
      return result;
    },
    close() {
      return closePromise ??= (async () => {
        const manager = sessionRef ? supervisor.liveSessionManager(sessionRef) : null;
        const before = manager && readbackTurns.length ? captureJourneyBeforeClose({ manager, cwd, turns: readbackTurns }) : null;
        try { await wire?.close(); } finally { unsubscribe(); await supervisor.close(); }
        if (!before) return null;
        const readback = await readClosedJourney({ before, host, cwd, agentDir, sessionDir, key, repositoryRoot,
          gatewayInstanceRef, supervisor, leases, sessionRef, transport, scenarioId });
        process.stdout.write(JSON.stringify(readback) + "\n");
        return readback;
      })();
    }
  };
}

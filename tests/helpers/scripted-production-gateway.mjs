import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installedPiHostRoot, loadPinnedPiHost } from "../../packages/piagent-webui/gateway/pi-host.ts";
import { SessionRuntimeSupervisor } from "../../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { SessionLeaseStore } from "../../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionCommandStore } from "../../packages/piagent-webui/gateway/session-command-store.ts";
import { SessionCommandController } from "../../packages/piagent-webui/gateway/session-command-controller.ts";
import { SessionInspectionRegistry } from "../../packages/piagent-webui/gateway/session-inspection-registry.ts";
import { GatewayEventStore } from "../../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewayProtocolService } from "../../packages/piagent-webui/gateway/gateway-protocol-service.ts";
import { buildSessionCatalog } from "../../packages/piagent-webui/gateway/session-catalog.ts";
import { buildSessionLiveState } from "../../packages/piagent-webui/gateway/session-live-state.ts";
import { gatewayProfileState, readOrCreateCatalogKey } from "../../packages/piagent-webui/gateway/profile-state.ts";
import { ProjectRegistry } from "../../packages/piagent-webui/gateway/project-registry.ts";
import { startLoopbackServer } from "../../packages/piagent-webui/server/loopback-server.ts";

const model = { id: "fixture", name: "Offline scripted fixture", api: "fixture", provider: "fixture", baseUrl: "",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

// Existing qualifiedGatewayLauncher test seam only. The script supplies model
// messages; SDK tools/persistence, HTTP/WS, task settlement and inspection use
// production code. This helper is not a scheduler or production daemon.
export async function launchScriptedProductionGateway({ repositoryRoot, workspace, agentDir, staticRoot,
  expectedPiVersion, script, turnScripts, declaredTurns, fixtureUsage, metrics }) {
  assert.ok(Array.isArray(script) !== Array.isArray(turnScripts), "choose one script mode");
  if (turnScripts) assert.equal(turnScripts.length, declaredTurns?.length);
  const queue = [...(script ?? [])], requests = new Set();
  let activeTurn;
  const finishTurn = () => {
    if (!activeTurn) return;
    activeTurn.remaining = queue.length;
    assert.ok(queue.length === 0 || activeTurn.modelMessages === 0, "a partial script cannot be replaced by the next declared turn");
  };
  Object.assign(metrics, { scriptedTurns: 0, unexpectedTurns: 0, authCalls: 0, providerRegistrations: 0,
    disposes: 0, gatewayCloses: 0, commands: 0, declaredTurns: [] });
  const host = await loadPinnedPiHost(expectedPiVersion), hostRoot = installedPiHostRoot();
  const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(hostRoot,
    "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")).href);
  const sessionDir = path.join(agentDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const modelRuntime = {
    async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }),
    isUsingOAuth: () => false,
    getAuth: async () => { metrics.authCalls++; throw new Error("real-auth-forbidden"); },
    getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() { metrics.providerRegistrations++; throw new Error("provider-registration-forbidden"); },
    registerNativeProvider() { metrics.providerRegistrations++; throw new Error("provider-registration-forbidden"); },
    unregisterProvider() {},
    streamSimple() {
      metrics.scriptedTurns++;
      if (activeTurn) activeTurn.modelMessages++;
      let response = queue.shift();
      if (!response) {
        metrics.unexpectedTurns++;
        assert.ok(metrics.unexpectedTurns <= 1, "the existing continuation bound must remain finite");
        response = { role: "assistant", content: [{ type: "text",
          text: "The task remains unverified; operator attention is required." }], stopReason: "stop" };
      }
      const message = { ...response, api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: { ...fixtureUsage, cost: { ...model.cost, total: 0 } } };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    }
  };
  const sessions = [], extensionErrors = [], rawEvents = [];
  class ScopedSessionManager extends host.SessionManager {
    static create(cwd) { assert.equal(cwd, workspace); return host.SessionManager.create(cwd, sessionDir); }
  }
  const facade = { ...host, SessionManager: ScopedSessionManager,
    async createAgentSessionServices(input) {
      const settings = JSON.parse(fs.readFileSync(path.join(workspace, ".pi/settings.json"), "utf8"));
      const settingsManager = host.SettingsManager.inMemory(settings, { projectTrusted: true });
      const services = await host.createAgentSessionServices({ ...input, settingsManager });
      const extensions = services.resourceLoader.getExtensions().extensions.map(extension =>
        path.resolve(extension.resolvedPath || extension.path));
      for (const required of ["packages/piagent-core/extensions/piagent-guard.ts",
        "packages/piagent-webui/extension/piagent-webui.ts"]) {
        assert.ok(extensions.includes(path.join(repositoryRoot, required)), "actual generated package extension is required");
      }
      return services;
    },
    async createAgentSessionFromServices(input) {
      const created = await host.createAgentSessionFromServices({ ...input,
        customTools: [host.createBashToolDefinition(workspace, { spawnHook(options) {
          const env = { ...options.env }; delete env.NODE_TEST_CONTEXT; return { ...options, env };
        } })] });
      const session = created.session;
      sessions.push(session);
      const dispose = session.dispose.bind(session);
      session.dispose = (...args) => { metrics.disposes++; return dispose(...args); };
      session.subscribe(event => rawEvents.push(event));
      session.extensionRunner.onError(error => extensionErrors.push(error));
      return created;
    }
  };
  const state = gatewayProfileState(agentDir), key = readOrCreateCatalogKey(state);
  const projects = new ProjectRegistry(state.root, key), gatewayInstanceRef = "gateway_offline_scripted_chain";
  const events = new GatewayEventStore(), observed = [], unsubscribe = events.subscribe(event => observed.push(event));
  const leases = new SessionLeaseStore(state.root, key);
  const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef, key, leases, events, host: facade,
    agentDir, packageRoot: repositoryRoot, modelRuntime,
    listSessions: () => host.SessionManager.list(workspace, sessionDir), resolveProject: ref => projects.resolve(ref) });
  const catalog = () => buildSessionCatalog({ gatewayInstanceRef, key, listSessions: () => supervisor.listSessions(),
    readOwnership: ref => supervisor.ownership(ref) });
  supervisor.setProjectionReader(async ref => {
    const row = (await catalog()).sessions.find(item => item.sessionRef === ref);
    assert.ok(row); return { sessionRevision: row.sessionRevision, liveState: row.liveState };
  });
  const controller = new SessionCommandController({ catalog, runtimes: supervisor,
    store: new SessionCommandStore(state.root, key), events });
  const capabilities = { ...JSON.parse(fs.readFileSync(path.join(repositoryRoot,
    "evals/fixtures/piagent-webui/gateway-capabilities-v1.valid.json"), "utf8")),
    gatewayInstanceRef, generatedAt: new Date().toISOString() };
  const protocol = new GatewayProtocolService({ capabilities: () => capabilities, catalog, events,
    command: { execute(command) {
      metrics.commands++;
      if (turnScripts && ["session.create", "session.send"].includes(command.action)
        && !requests.has(command.payload.messageRequestId)) {
        finishTurn();
        const index = requests.size;
        assert.ok(index < declaredTurns.length, "no undeclared message may dispatch");
        assert.equal(command.payload.message, declaredTurns[index].message);
        assert.equal(command.payload.workflow, declaredTurns[index].workflow);
        requests.add(command.payload.messageRequestId);
        queue.splice(0, queue.length, ...turnScripts[index]);
        activeTurn = { id: declaredTurns[index].id, messageRequestId: command.payload.messageRequestId,
          plannedMessages: queue.length, modelMessages: 0, remaining: queue.length };
        metrics.declaredTurns.push(activeTurn);
      }
      return controller.execute(command);
    } } });
  const inspections = new SessionInspectionRegistry({ gatewayInstanceRef, host: facade, key,
    packageRoot: repositoryRoot, agentDir, models: modelRuntime, projects,
    listSessions: () => supervisor.listSessions(), openLiveSession: ref => supervisor.liveSessionManager(ref),
    operationLiveness: ref => supervisor.currentOperation(ref) ? "running" : "idle" });
  let server, closing;
  const close = () => closing ??= (async () => {
    try { await server?.close(); } finally { await supervisor.close(); unsubscribe(); metrics.gatewayCloses++; finishTurn(); }
  })();
  try {
    server = await startLoopbackServer({ staticRoot, mode: "gateway", readCapabilities: () => capabilities,
      readSessionCatalog: catalog,
      readSessionCreationOptions: () => inspections.creationOptions(), readSessionModel: ref => inspections.provider(ref),
      readSessionLiveState: () => buildSessionLiveState({ gatewayInstanceRef, eventSequence: events.stateVersion,
        operations: supervisor.currentOperations(), settlements: events.recentOperationSettlements() }), gatewayProtocol: protocol });
    return { launchUrl: server.launchUrl, close, origin: server.origin, supervisor, leases, sessions, observed, extensionErrors, rawEvents, remainingScript: () => queue.length,
      async readClosedTranscript(sessionRef) {
        assert.equal(metrics.gatewayCloses, 1, "cold inspection requires a closed gateway");
        assert.equal(supervisor.activeCount, 0);
        const cold = new SessionInspectionRegistry({ gatewayInstanceRef, host: facade, key,
          packageRoot: repositoryRoot, agentDir, models: modelRuntime, projects,
          listSessions: () => host.SessionManager.list(workspace, sessionDir) });
        return await (await cold.provider(sessionRef)).transcript(null, 100);
      } };
  } catch (error) { await close(); throw error; }
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadBenchmarkSuite, resolveBenchmarkSuiteEntry } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { openBenchmarkBudgetGovernor } from "../packages/piagent-core/benchmark/benchmark-budget-governor.js";
import { appendPrivateJsonl, createBenchmarkTransportCircuit } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { persistUnacceptedBenchmarkAttempt } from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { benchmarkInfrastructureFailureDisposition } from "../packages/piagent-core/benchmark/benchmark-runner-policy.js";
import { runOfflineBenchmarkSession } from "../scripts/benchmark-session.mjs";
import { runPiagentWebUiJourney } from "../scripts/benchmark-webui-journey.mjs";
import { installedPiHostRoot, loadPinnedPiHost } from "../packages/piagent-webui/gateway/pi-host.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionCommandStore } from "../packages/piagent-webui/gateway/session-command-store.ts";
import { SessionCommandController } from "../packages/piagent-webui/gateway/session-command-controller.ts";
import { SessionInspectionRegistry } from "../packages/piagent-webui/gateway/session-inspection-registry.ts";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewayProtocolService } from "../packages/piagent-webui/gateway/gateway-protocol-service.ts";
import { buildSessionCatalog } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { buildSessionLiveState } from "../packages/piagent-webui/gateway/session-live-state.ts";
import { gatewayProfileState, readOrCreateCatalogKey } from "../packages/piagent-webui/gateway/profile-state.ts";
import { ProjectRegistry } from "../packages/piagent-webui/gateway/project-registry.ts";
import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const digest = value => createHash("sha256").update(value).digest("hex");
const model = { id: "fixture", name: "Offline timeout fixture", api: "fixture", provider: "fixture", baseUrl: "",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const fixtureUsage = { input: 20, output: 5, cacheRead: 2, cacheWrite: 0, reasoning: 0, totalTokens: 27,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const jsonLines = file => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : entry.isFile() ? [target] : [];
  });
}

// This launcher substitutes only local model/auth services and daemon startup.
// Catalog, creation options and transcript routes use the actual registries;
// no task status, command receipt, session JSONL or timeout result is fabricated.
async function launchOfflineGateway({ root, workspace, agentDir, staticRoot, expectedPiVersion, metrics, trace, abortDuringContext }) {
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
    streamSimple(_model, _context, options) {
      metrics.streams++;
      trace("stream-entry", { index: metrics.streams, signalPresent: Boolean(options.signal),
        signalAborted: options.signal?.aborted ?? null });
      assert.ok(metrics.streams <= 2, "the timeout must not replay or continue the model script");
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [], stopReason: "pending", usage: { ...fixtureUsage, cost: { ...fixtureUsage.cost } } };
      if (metrics.streams === 1) {
        message.content = [{ type: "toolCall", id: "read-public-package", name: "read", arguments: { path: "package.json" } }];
        message.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message });
        return stream;
      }
      assert.ok(options.signal);
      message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0,
        cost: { ...fixtureUsage.cost } };
      if (options.signal.aborted) {
        // A provider may be entered after asynchronous context preparation was
        // aborted. Return its normal zero-usage terminal stream, not an SDK
        // fallback caused by a thrown fixture assertion.
        message.stopReason = "aborted";
        message.errorMessage = "offline-fixture-pre-stream-aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        return stream;
      }
      message.content = [{ type: "thinking", thinking: "PRIVATE_THINKING_CANARY" }];
      options.signal.addEventListener("abort", () => {
        metrics.signalAborts++;
        trace("stream-abort-listener", { index: metrics.streams });
        message.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
      }, { once: true });
      trace("stream-abort-listener-installed", { index: metrics.streams });
      queueMicrotask(() => {
        trace("partial-events-queued", { index: metrics.streams });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "thinking_end", contentIndex: 0, content: "PRIVATE_THINKING_CANARY", partial: message });
        stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "PRIVATE_ARGUMENT_CANARY", partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "PRIVATE_ARGUMENT_CANARY", partial: message });
      });
      return stream;
    }
  };
  const sessions = [], extensionErrors = [];
  class ScopedSessionManager extends host.SessionManager {
    static create(cwd) { assert.equal(cwd, workspace); return host.SessionManager.create(cwd, sessionDir); }
  }
  const facade = { ...host, SessionManager: ScopedSessionManager,
    async createAgentSessionServices(input) {
      const projectSettings = JSON.parse(fs.readFileSync(path.join(workspace, ".pi/settings.json"), "utf8"));
      const settingsManager = host.SettingsManager.inMemory({ ...projectSettings, retry: { enabled: false, maxRetries: 0 } },
        { projectTrusted: true });
      assert.deepEqual(settingsManager.getPackages(), projectSettings.packages);
      const services = await host.createAgentSessionServices({ ...input, settingsManager });
      assert.ok(services.resourceLoader.getExtensions().extensions.some(extension =>
        path.resolve(extension.resolvedPath || extension.path) === path.join(repositoryRoot,
          "packages/piagent-webui/extension/piagent-webui.ts")), "the actual package telemetry extension must be loaded");
      return services;
    },
    async createAgentSessionFromServices(input) {
      const created = await host.createAgentSessionFromServices(input), session = created.session;
      sessions.push(session);
      const abort = session.abort.bind(session), dispose = session.dispose.bind(session);
      session.abort = async (...args) => {
        metrics.hostAborts++; trace("host-abort-enter");
        try { return await abort(...args); } finally { trace("host-abort-return"); }
      };
      session.dispose = (...args) => { metrics.disposes++; trace("host-dispose"); return dispose(...args); };
      const transformContext = session.agent.transformContext.bind(session.agent);
      session.agent.transformContext = async (messages, signal) => {
        trace("context-enter", { streams: metrics.streams, signalAborted: signal?.aborted ?? null });
        const transformed = await transformContext(messages, signal);
        // The pre-stream case holds context at the real SDK seam until the
        // unchanged journey deadline aborts it. The partial-stream case does
        // not wait here and must actually emit its required partial updates.
        if (abortDuringContext && metrics.streams === 1 && !signal.aborted) {
          trace("context-wait-for-real-abort");
          await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
          trace("context-wait-released", { signalAborted: signal.aborted });
        }
        trace("context-return", { streams: metrics.streams, signalAborted: signal?.aborted ?? null });
        return transformed;
      };
      session.subscribe(event => {
        if (["agent_start", "agent_end", "turn_start", "turn_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) {
          trace(event.type);
        }
        if (event.type === "tool_execution_start") metrics.toolStarts++;
        if (event.type === "tool_execution_end") metrics.toolEnds++;
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "toolcall_delta") metrics.partialUpdates++;
      });
      session.extensionRunner.onError(error => extensionErrors.push(error));
      return created;
    }
  };
  const state = gatewayProfileState(agentDir), key = readOrCreateCatalogKey(state);
  const projects = new ProjectRegistry(state.root, key), gatewayInstanceRef = "gateway_offline_timeout_chain";
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
    command: { execute(command) { metrics.commands++; return controller.execute(command); } } });
  const inspections = new SessionInspectionRegistry({ gatewayInstanceRef, host: facade, key,
    packageRoot: repositoryRoot, agentDir, models: modelRuntime, projects,
    listSessions: () => supervisor.listSessions(), openLiveSession: ref => supervisor.liveSessionManager(ref),
    operationLiveness: ref => supervisor.currentOperation(ref) ? "running" : "idle" });
  let server, closing;
  const close = () => closing ??= (async () => {
    try { await server?.close(); } finally { await supervisor.close(); unsubscribe(); metrics.gatewayCloses++; }
  })();
  try {
    server = await startLoopbackServer({ staticRoot, mode: "gateway", readCapabilities: () => capabilities,
      readSessionCatalog: catalog,
      readSessionCreationOptions: () => inspections.creationOptions(), readSessionModel: ref => inspections.provider(ref),
      readSessionLiveState: () => buildSessionLiveState({ gatewayInstanceRef, eventSequence: events.stateVersion,
        operations: supervisor.currentOperations(), settlements: events.recentOperationSettlements() }), gatewayProtocol: protocol });
    return { launchUrl: server.launchUrl, close, origin: server.origin, supervisor, leases, sessions, observed, extensionErrors };
  } catch (error) { await close(); throw error; }
}

for (const phase of ["partial-stream", "pre-stream"]) test(`actual Pi journey timeout retains usage floor, stops governor dispatch and releases its runtime (${phase})`, { timeout: 60000 }, async t => {
  const traceStarted = performance.now(), phaseTrace = [];
  let droppedTraceEvents = 0;
  const trace = (phase, fields = {}) => {
    if (phaseTrace.length < 96) phaseTrace.push({ phase, elapsedMs: Math.round(performance.now() - traceStarted), ...fields });
    else droppedTraceEvents++;
  };
  const abortDuringContext = phase === "pre-stream";
  t.after(() => t.diagnostic(JSON.stringify({ boundary: "timeout-ordering-diagnosis", phase, abortDuringContext,
    phaseTrace, droppedTraceEvents })));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-timeout-accounting-chain-")));
  const runRoot = path.join(root, "run"), agentDir = path.join(root, "agent"), staticRoot = path.join(root, "static");
  for (const directory of [runRoot, agentDir, staticRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><main>Offline transport fixture</main>");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { suite, suiteRoot, manifestPath } = loadBenchmarkSuite("production-v3", repositoryRoot);
  const scenario = suite.scenarios.find(item => item.id === "idempotent-replay-conflict");
  assert.ok(scenario?.userJourney);
  const runId = "offline-timeout-accounting-chain", configurationDigest = digest(runId);
  const suiteDigest = digest(fs.readFileSync(manifestPath)), manifest = { schemaVersion: 1, runId, configurationDigest };
  const governor = openBenchmarkBudgetGovernor({ statePath: path.join(root, "budget.json"), resume: false,
    policy: { semantics: "management-thresholds", maxProviderAttempts: 3, freshTokenThreshold: 100000, activeWallTimeMsThreshold: 60000 },
    binding: { runId, suiteDigest, candidateDigest: digest("test-owned-scripted-candidate") } });
  t.after(() => governor.close()); governor.startStage("offline-timeout");
  const metrics = { streams: 0, authCalls: 0, providerRegistrations: 0, hostAborts: 0, signalAborts: 0, disposes: 0,
    partialUpdates: 0, toolStarts: 0, toolEnds: 0, commands: 0, gatewayCloses: 0, attemptStarts: 0, attemptReturns: 0,
    completedRecords: 0, dispatchChecks: 0 };
  let gateway, actualJourney, returned;
  t.after(async () => { await gateway?.close(); });
  const runCommand = async (command, args, options = {}) => {
    assert.ok([process.execPath, "git", "bash"].includes(command), "only local fixture preparation executables are permitted");
    if (command === "bash") assert.equal(args[0], path.join(repositoryRoot, "scripts/init-project.sh"));
    const env = { ...options.env }; delete env.NODE_TEST_CONTEXT;
    const started = Date.now(), result = spawnSync(command, args, { cwd: options.cwd, env,
      input: options.input, encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { code: result.status ?? 1, signal: result.signal ?? null, timedOut: result.error?.code === "ETIMEDOUT",
      stdout: result.stdout ?? "", stderr: result.stderr ?? "", durationSeconds: (Date.now() - started) / 1000 };
  };
  const result = await runOfflineBenchmarkSession({ packageRoot: repositoryRoot, runCommand,
    resolveSuiteEntry: resolveBenchmarkSuiteEntry, interrupted: () => false,
    persistCompletedRecord() { metrics.completedRecords++; throw new Error("timeout-cannot-be-an-accepted-record"); },
    assertProviderDispatchReady() { metrics.dispatchChecks++; governor.checkpointStage("offline-timeout"); },
    onProviderAttemptStart(attempt) { metrics.attemptStarts++; governor.startAttempt(attempt); },
    onProviderAttemptReturned(attempt) { metrics.attemptReturns++; returned = attempt;
      governor.settleAttempt(attempt, { usage: attempt.usage, usageStatus: attempt.usageStatus }); },
    suite, suiteRoot, scenario, surface: "piagent", repeat: 1, orderIndex: 1, runId, runRoot,
    options: { timeoutSeconds: 8, model: "fixture/fixture", thinking: "off", piagentTreatment: "release-defaults" },
    piCommand: "forbidden-provider", codexCommand: "forbidden-provider", piRuntimeHome: { path: agentDir },
    systemCommands: { node: process.execPath, git: "git", bash: "bash" }, suiteDigest, configurationDigest,
    rootSeed: "public-offline-timeout-chain",
    piagentWebUiJourney: input => withJourneyEnvironment(input.environment, async () => {
      actualJourney = await runPiagentWebUiJourney({ ...input, staticRoot,
        qualifiedGatewayLauncher: async options => {
          gateway = await launchOfflineGateway({ ...options, root, workspace: input.workspace, metrics, trace, abortDuringContext });
          return gateway;
        } });
      return actualJourney;
    }) });
  const { record } = result;
  t.diagnostic(JSON.stringify({ boundary: "offline-actual-sdk-http-ws-journey-to-session-accounting", phase, metrics,
    journey: { timedOut: actualJourney.timedOut, completed: actualJourney.journeyReceipt.completed,
      turns: actualJourney.journeyReceipt.turns.length },
    attempt: { failure: record.failure, usageStatus: record.usageStatus, fresh: record.usage.fresh,
      total: record.usage.total, attemptId: record.attemptId, sessionId: record.sessionId } }));
  assert.equal(actualJourney.timedOut, true);
  assert.match(actualJourney.stderr, /^webui-journey-timeout:turn-1-settlement$/);
  assert.equal(record.infrastructureFailure, "agent-timeout-after-observed-usage");
  assert.equal(record.usageStatus, "measured-lower-bound");
  assert.equal(record.usage.fresh, 25); assert.equal(record.usage.total, 27);
  assert.equal(record.abortSuite, true); assert.equal(record.infrastructureRetryable, false);
  assert.equal(record.agent.timedOut, true); assert.equal(record.resolved, false);
  assert.equal(returned.attemptId, record.attemptId); assert.equal(returned.usageStatus, "measured-lower-bound");
  assert.equal(metrics.streams, 2); assert.equal(metrics.attemptStarts, 1); assert.equal(metrics.attemptReturns, 1);
  assert.equal(metrics.authCalls, 0); assert.equal(metrics.providerRegistrations, 0);
  assert.equal(metrics.hostAborts, 1); assert.equal(metrics.signalAborts, abortDuringContext ? 0 : 1);
  assert.equal(metrics.partialUpdates, abortDuringContext ? 0 : 2);
  assert.equal(metrics.toolStarts, 1); assert.equal(metrics.toolEnds, 1);
  const secondStream = phaseTrace.filter(event => event.phase === "stream-entry" && event.index === 2);
  assert.equal(secondStream.length, 1);
  assert.equal(secondStream[0].signalAborted, abortDuringContext,
    "each case must reach its declared phase, never adopt whichever ordering happened");
  assert.equal(phaseTrace.filter(event => event.phase === "stream-abort-listener-installed").length, abortDuringContext ? 0 : 1);
  assert.equal(phaseTrace.filter(event => event.phase === "partial-events-queued").length, abortDuringContext ? 0 : 1);
  assert.equal(metrics.commands, 1); assert.equal(metrics.dispatchChecks, 1); assert.equal(metrics.completedRecords, 0);
  assert.deepEqual(gateway.extensionErrors, []);
  const failed = filesBelow(path.join(result.workspaceRoot, "project/.pi/piagent-state/webui-events"))
    .filter(file => file.endsWith(".jsonl")).flatMap(jsonLines).filter(event => event.kind === "message.failed");
  assert.equal(failed.length, 1, "the actual extension must durably retain the aborted consumer boundary");
  assert.equal(failed[0].payload.reason, "aborted"); assert.equal(failed[0].payload.usage, undefined);
  assert.equal(failed[0].payload.errorCode, "assistant-message-aborted");
  assert.equal(failed[0].payload.message, abortDuringContext ? "offline-fixture-pre-stream-aborted" : null,
    "pre-stream abort must use the provider error stream, not SDK fallback after a thrown fixture assertion");
  assert.equal(failed[0].payload.contentDigest, null);
  if (abortDuringContext) {
    assert.deepEqual(failed[0].payload.streamActivity, { schemaVersion: 1, boundary: "pi-message-update-hook",
      observedUpdates: 0, textUpdates: 0, thinkingUpdates: 0, toolCallUpdates: 0, otherUpdates: 0,
      lastUpdateKind: null, lastObservedAt: null, countersCapped: false });
  } else {
    assert.equal(failed[0].payload.streamActivity.observedUpdates, 4);
    assert.equal(failed[0].payload.streamActivity.thinkingUpdates, 1);
    assert.equal(failed[0].payload.streamActivity.toolCallUpdates, 3);
    assert.equal(failed[0].payload.streamActivity.lastUpdateKind, "toolcall_delta");
  }
  assert.doesNotMatch(JSON.stringify(failed[0].payload.streamActivity), /PRIVATE_/);
  const disposition = benchmarkInfrastructureFailureDisposition({ circuit: createBenchmarkTransportCircuit(), record,
    infrastructureAttempt: 1, retryLimit: 2, orderIndex: 1, scenarioId: scenario.id, surface: "piagent", repeat: 1 });
  assert.equal(disposition.retryAvailable, false, "even a nonzero retry allowance cannot replay lower-bound usage");
  persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record });
  appendPrivateJsonl(path.join(runRoot, "infrastructure-attempts.jsonl"), { ...record, accepted: false, retryAvailable: disposition.retryAvailable });
  const ledger = jsonLines(path.join(runRoot, "infrastructure-attempts.jsonl"));
  assert.equal(ledger.length, 1); assert.equal(ledger[0].usageStatus, "measured-lower-bound");
  assert.equal(ledger[0].accepted, false); assert.equal(ledger[0].usage.fresh, 25);
  assert.equal(manifest.recoveredProviderAttempts[0].usageStatus, "measured-lower-bound");
  assert.match(manifest.tokenClaimsUnavailableReason, /unaccepted-or-unknown-usage/);
  assert.equal(fs.existsSync(path.join(runRoot, "runs.jsonl")), false);
  const budget = governor.snapshot();
  assert.equal(budget.unknownAttempts, 1); assert.equal(budget.freshTokens, null);
  assert.equal(budget.canStartAttempt, false); assert.deepEqual(budget.stopReasons, ["unknown-usage"]);
  const durableBudget = JSON.parse(fs.readFileSync(path.join(root, "budget.json"), "utf8")).state;
  assert.equal(durableBudget.attempts.length, 1); assert.equal(durableBudget.attempts[0].attemptId, record.attemptId);
  assert.equal(durableBudget.attempts[0].status, "unknown"); assert.equal(durableBudget.attempts[0].usage, null);
  assert.equal(durableBudget.attempts[0].usageStatus, "unknown-after-provider-start");
  assert.throws(() => {
    governor.startAttempt({ ...returned, attemptId: "forbidden-next-attempt", orderIndex: 2 });
    throw new Error("a second provider dispatch became reachable");
  }, /unknown-usage/);
  governor.endStage("offline-timeout");
  assert.equal(gateway.supervisor.activeCount, 0); assert.equal(metrics.disposes, 1); assert.equal(metrics.gatewayCloses, 1);
  assert.equal(gateway.sessions[0].isStreaming, false);
  assert.equal(gateway.leases.inspect(actualJourney.journeyReceipt.sessionRef).state, "released");
  await assert.rejects(fetch(`${gateway.origin}/api/v1/session-catalog`, { signal: AbortSignal.timeout(1000) }));
  t.diagnostic(JSON.stringify({ phase, terminalConsumerSummary: failed[0].payload.streamActivity,
    retainedAttempt: { usageStatus: ledger[0].usageStatus, retryAvailable: ledger[0].retryAvailable },
    governor: { unknownAttempts: budget.unknownAttempts, freshTokens: budget.freshTokens, canStartAttempt: budget.canStartAttempt },
    cleanup: { activeRuntimes: gateway.supervisor.activeCount, hostDisposes: metrics.disposes, gatewayCloses: metrics.gatewayCloses },
    limits: ["scripted fixture usage is not provider billing", "test-local launcher is not full daemon startup",
      "no browser/native auth or paid campaign qualification", "does not recover historical run-6"] }));
});

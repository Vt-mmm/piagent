import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import { createScopedMaterialBroker, loadScopedBrokerPiExtension,
  SCOPED_TOOL_DEFINITIONS } from "./benchmark-scoped-tool-broker.mjs";
import { assertScopedBrokerPiOwnership, createQualifiedLoopbackModelRuntime, createQualifiedLoopbackTransport,
  scopedContextPolicySha256, scopedQualificationIdentity } from "./benchmark-scoped-verification-supervisor.mjs";
export { createQualifiedLoopbackTransport };

const attached = new WeakSet();

// This public-session seam is useful for qualification. It is not a gateway
// injection seam, an admission guard, a phase receipt, or a live child launcher.
// Observation failure invalidates evidence without changing the host callback.
export function attachBenchmarkArmObserver({ session, identity, record, maximumCallbacks = 128 }) {
  if (!session?.agent || typeof session.agent.onPayload !== "function"
    || typeof session.sessionManager?.getSessionId !== "function") throw new Error("arm-observer-public-session-required");
  if (typeof record !== "function" || !Number.isSafeInteger(maximumCallbacks) || maximumCallbacks < 1
    || maximumCallbacks > 4096) throw new Error("arm-observer-options-invalid");
  const keys = ["armId", "candidateDigest", "sessionId", "runtimeInstanceRef"];
  if (!identity || Object.keys(identity).length !== keys.length
    || !keys.every(key => typeof identity[key] === "string" && identity[key].length > 0)
    || !/^[a-f0-9]{64}$/.test(identity.candidateDigest)
    || session.sessionManager.getSessionId() !== identity.sessionId) throw new Error("arm-observer-identity-invalid");
  const bound = Object.freeze({ ...identity }), agent = session.agent;
  if (attached.has(agent)) throw new Error("arm-observer-already-attached");
  const previous = agent.onPayload;
  let callbackCount = 0, returnedCount = 0, thrownCount = 0, recordedCount = 0;
  const failures = new Set();
  function capture(value) {
    let nodes = 0;
    function copy(item, depth) {
      if (++nodes > 100000 || depth > 64) throw new Error("payload-bounds");
      if (item === null || typeof item === "string" || typeof item === "boolean") return item;
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (!item || typeof item !== "object" || types.isProxy(item)) throw new Error("payload-non-json");
      const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
      if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("payload-prototype");
      const descriptors = Object.getOwnPropertyDescriptors(item), result = array ? [] : Object.create(null);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (array && key === "length") continue;
        if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable
          || array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("payload-descriptor");
        Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true });
      }
      if (array && (result.length !== item.length || Object.keys(result).length !== item.length)) throw new Error("payload-sparse-array");
      return result;
    }
    const json = JSON.stringify(copy(value, 0));
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error("payload-size");
    return createHash("sha256").update(json).digest("hex");
  }
  async function observe(event) {
    if (event.sequence > maximumCallbacks) { failures.add("callback-limit"); return; }
    try { await record(Object.freeze({ ...bound, ...event })); recordedCount++; }
    catch { failures.add("record-failed"); }
  }
  async function wrapper(...args) {
    const sequence = ++callbackCount;
    let result;
    try { result = await Reflect.apply(previous, this, args); }
    catch (error) {
      thrownCount++;
      await observe({ sequence, outcome: "thrown", payloadSha256: null });
      throw error;
    }
    returnedCount++;
    try {
      const payloadSha256 = capture(result === undefined ? args[0] : result);
      await observe({ sequence, outcome: "returned", payloadSha256 });
    } catch { failures.add("payload-unobservable"); }
    return result;
  }
  agent.onPayload = wrapper;
  attached.add(agent);
  return Object.freeze({
    status() {
      const reasons = [...failures];
      if (agent.onPayload !== wrapper) reasons.push("callback-ownership-lost");
      return Object.freeze({ callbackCount, returnedCount, thrownCount, recordedCount,
        complete: reasons.length === 0 && recordedCount === callbackCount, reasons,
        phaseWireQualified: false, dispatchPermission: false });
    },
    detach() {
      if (agent.onPayload !== wrapper) { failures.add("callback-ownership-lost"); return false; }
      agent.onPayload = previous; attached.delete(agent); return true;
    }
  });
}

const HASH = /^[a-f0-9]{64}$/;
const ARM_KEYS = ["version", "armId", "candidateRoot", "candidateDigest", "configSha256", "brokerClosureSha256",
  "toolDefinitionsSha256", "manifestAuthoritySha256", "journalSignerSha256", "journalPathSha256",
  "contextPolicySha256", "sdkRoot", "sdkVersion", "sdkTreeSha256", "assetsRoot", "assetTreeSha256", "runtimeHome"];
const TOOL_NAMES = Object.freeze(SCOPED_TOOL_DEFINITIONS.map(tool => tool.name));
function armFail(code) { throw Object.assign(new Error(code), { armCode: code }); }
function exactRecord(value, keys, code) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) armFail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || !keys.every(key => descriptors[key]?.enumerable
    && Object.hasOwn(descriptors[key], "value"))) armFail(code);
}
function realDirectory(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value
    || !fs.statSync(value).isDirectory()) armFail(code);
  const real = fs.realpathSync(value);
  if (real !== value) armFail(code);
  return real;
}
function inside(root, file, code) {
  const real = fs.realpathSync(file);
  if (real !== root && !real.startsWith(root + path.sep)) armFail(code);
  return real;
}
function validateArmIdentity(identity) {
  exactRecord(identity, ARM_KEYS, "arm-identity-fields");
  if (identity.version !== 3 || !["A", "B", "C"].includes(identity.armId)
    || !["candidateDigest", "configSha256", "brokerClosureSha256", "toolDefinitionsSha256",
      "manifestAuthoritySha256", "journalSignerSha256", "journalPathSha256", "contextPolicySha256",
      "sdkTreeSha256", "assetTreeSha256"]
      .every(key => HASH.test(identity[key]))
    || typeof identity.sdkVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(identity.sdkVersion)) armFail("arm-identity-invalid");
  const result = { ...identity, candidateRoot: realDirectory(identity.candidateRoot, "arm-candidate-root"),
    sdkRoot: realDirectory(identity.sdkRoot, "arm-sdk-root"), assetsRoot: realDirectory(identity.assetsRoot, "arm-assets-root"),
    runtimeHome: realDirectory(identity.runtimeHome, "arm-runtime-home") };
  inside(result.candidateRoot, path.join(result.assetsRoot, "index.html"), "arm-assets-outside-candidate");
  if (result.runtimeHome.startsWith(result.candidateRoot + path.sep)
    || result.runtimeHome.startsWith(result.sdkRoot + path.sep)) armFail("arm-runtime-home-overlap");
  return Object.freeze(result);
}
async function candidateModules(root, names) {
  return await Promise.all(names.map(async relative => {
    const file = inside(root, path.join(root, relative), "arm-module-outside-candidate");
    return await import(pathToFileURL(file).href);
  }));
}
/** Creates the explicit G0 launcher. Nothing changes in the default gateway path. */
export function createQualifiedArmGatewayLauncher({ identity: rawIdentity, brokerConfigPath,
  createBroker = createScopedMaterialBroker, modelRuntime, loopbackTransport, record, contextPolicy,
  scopedBrokerRouter = null } = {}) {
  const identity = validateArmIdentity(rawIdentity);
  if (scopedContextPolicySha256(contextPolicy) !== identity.contextPolicySha256) armFail("arm-context-policy-mismatch");
  if (typeof record !== "function") armFail("arm-record-required");
  if (typeof brokerConfigPath !== "string" || !path.isAbsolute(brokerConfigPath)
    || path.normalize(brokerConfigPath) !== brokerConfigPath) armFail("arm-broker-config-path");
  if (scopedBrokerRouter && (!Array.isArray(scopedBrokerRouter.toolNames)
    || typeof scopedBrokerRouter.extensionFactory !== "function"
    || typeof scopedBrokerRouter.beginOperation !== "function"
    || typeof scopedBrokerRouter.settlementEvidence !== "function"
    || typeof scopedBrokerRouter.assertProviderDispatchReady !== "function"
    || typeof scopedBrokerRouter.takeFatalProviderBoundaryError !== "function"
    || typeof scopedBrokerRouter.assertOwnership !== "function"
    || typeof scopedBrokerRouter.dispose !== "function")) armFail("arm-scoped-router-invalid");
  let launched = false;
  return async function qualifiedArmGateway(options) {
    if (launched) armFail("arm-launcher-single-use"); launched = true;
    if (fs.realpathSync(options.packageRoot) !== identity.candidateRoot
      || fs.realpathSync(options.staticRoot) !== identity.assetsRoot
      || fs.realpathSync(options.agentDir) !== identity.runtimeHome
      || options.expectedPiVersion !== identity.sdkVersion
      || (options.scopedBrokerRouter ?? null) !== scopedBrokerRouter) armFail("arm-launch-identity-mismatch");
    const actual = scopedQualificationIdentity({ candidateRoot: identity.candidateRoot,
      assetsRoot: identity.assetsRoot, sdkRoot: identity.sdkRoot });
    if (actual.sourceSha256 !== identity.candidateDigest || actual.assetTreeSha256 !== identity.assetTreeSha256
      || actual.sdkTreeSha256 !== identity.sdkTreeSha256
      || actual.brokerClosureSha256 !== identity.brokerClosureSha256) armFail("arm-broker-identity-mismatch");
    const capturedRuntime = await createQualifiedLoopbackModelRuntime({ modelRuntime, transport: loopbackTransport,
      record, identity, contextPolicy });
    const loaded = scopedBrokerRouter ? null
      : loadScopedBrokerPiExtension({ configPath: brokerConfigPath, createBroker });
    let loopback, runtimes;
    try {
    const shared = { armId: identity.armId, sourceSha256: identity.candidateDigest,
      assetTreeSha256: identity.assetTreeSha256, configSha256: identity.configSha256,
      brokerClosureSha256: identity.brokerClosureSha256, toolDefinitionsSha256: identity.toolDefinitionsSha256,
      manifestAuthoritySha256: identity.manifestAuthoritySha256, journalSignerSha256: identity.journalSignerSha256,
      journalPathSha256: identity.journalPathSha256, contextPolicySha256: identity.contextPolicySha256,
      sdkTreeSha256: identity.sdkTreeSha256 };
    if (loaded ? loaded.configSha256 !== identity.configSha256
      || Object.entries(shared).some(([key, value]) => loaded.identity[key] !== value)
      : createHash("sha256").update(fs.readFileSync(brokerConfigPath)).digest("hex") !== identity.configSha256) {
      armFail("arm-broker-identity-mismatch");
    }
    const names = ["packages/piagent-webui/gateway/pi-host.ts", "packages/piagent-webui/gateway/session-runtime-factory.ts",
      "packages/piagent-webui/server/loopback-server.ts", "packages/piagent-webui/gateway/profile-state.ts",
      "packages/piagent-webui/gateway/session-metadata-store.ts", "packages/piagent-webui/gateway/project-registry.ts",
      "packages/piagent-webui/gateway/session-lease-store.ts", "packages/piagent-webui/gateway/gateway-events.ts",
      "packages/piagent-webui/gateway/session-runtime-supervisor.ts", "packages/piagent-webui/gateway/session-catalog.ts",
      "packages/piagent-webui/gateway/session-command-store.ts", "packages/piagent-webui/gateway/session-command-controller.ts",
      "packages/piagent-webui/gateway/runtime-command-controller.ts", "packages/piagent-webui/gateway/gateway-protocol-service.ts",
      "packages/piagent-webui/gateway/session-inspection-registry.ts", "packages/piagent-webui/gateway/session-live-state.ts"];
    const [piHost, factoryModule, loopbackModule, profileModule, metadataModule, projectModule, leaseModule,
      eventsModule, supervisorModule, catalogModule, commandStoreModule, commandModule, runtimeCommandModule,
      protocolModule, inspectionModule, liveModule] = await candidateModules(identity.candidateRoot, names);
    const selectedFactoryModule = scopedBrokerRouter
      ? await import("../packages/piagent-webui/gateway/session-runtime-factory.ts") : factoryModule;
    const selectedSupervisorModule = scopedBrokerRouter
      ? await import("../packages/piagent-webui/gateway/session-runtime-supervisor.ts") : supervisorModule;
    if (fs.realpathSync(piHost.installedPiHostRoot()) !== identity.sdkRoot) armFail("arm-sdk-root-mismatch");
    const host = await piHost.loadPinnedPiHost(identity.sdkVersion), runtimeScope = new AsyncLocalStorage();
    let claimedSession = false; const observers = [];
    const facade = { ...host,
      async createAgentSessionServices(input) {
        const guard = inside(identity.candidateRoot, path.join(identity.candidateRoot,
          "packages/piagent-core/extensions/piagent-guard.ts"), "arm-guard-outside-candidate");
        const supplied = input.resourceLoaderOptions?.additionalExtensionPaths ?? [];
        if (supplied.length !== 1 || fs.realpathSync(supplied[0]) !== guard) armFail("arm-extension-route-mismatch");
        const extensionFactory = scopedBrokerRouter?.extensionFactory ?? loaded.extensionFactory;
        const suppliedFactories = input.resourceLoaderOptions?.extensionFactories;
        if (scopedBrokerRouter && suppliedFactories !== undefined
          && (suppliedFactories.length !== 1 || suppliedFactories[0] !== extensionFactory)) {
          armFail("arm-extension-route-mismatch");
        }
        const suppliedModelRuntime = scopedBrokerRouter ? input.modelRuntime : capturedRuntime;
        if (scopedBrokerRouter) {
          const descriptor = Object.getOwnPropertyDescriptor(suppliedModelRuntime ?? {}, "streamSimple");
          if (Object.getPrototypeOf(suppliedModelRuntime ?? {}) !== capturedRuntime
            || typeof descriptor?.value !== "function" || descriptor.enumerable !== true
            || descriptor.writable !== false || descriptor.configurable !== false) {
            armFail("arm-provider-boundary-route-mismatch");
          }
        }
        try { const services = await host.createAgentSessionServices({ ...input, agentDir: identity.runtimeHome,
          modelRuntime: suppliedModelRuntime,
          resourceLoaderOptions: { ...input.resourceLoaderOptions, noExtensions: true, noSkills: true,
            noPromptTemplates: true, noThemes: true, noContextFiles: true,
            additionalExtensionPaths: [guard], extensionFactories: [extensionFactory] } });
          const ownership = scopedBrokerRouter ? scopedBrokerRouter.assertOwnership(services.resourceLoader)
            : assertScopedBrokerPiOwnership(services.resourceLoader, extensionFactory);
          await record({ version: 2, kind: "qualified-tool-ownership", ...ownership }); return services; }
        catch (error) { await record({ version: 1, kind: "qualified-arm-error", stage: "services", message: String(error?.message ?? error) }); throw error; }
      },
      async createAgentSessionFromServices(input) {
        if (claimedSession) armFail("arm-session-cap"); claimedSession = true;
        let created;
        try { created = await host.createAgentSessionFromServices({ ...input, noTools: "all", tools: [...TOOL_NAMES] }); }
        catch (error) { await record({ version: 1, kind: "qualified-arm-error", stage: "session", message: String(error?.message ?? error) }); throw error; }
        const scope = runtimeScope.getStore();
        if (!scope) armFail("arm-runtime-scope-missing");
        observers.push(attachBenchmarkArmObserver({ session: created.session, identity: { armId: identity.armId,
          candidateDigest: identity.candidateDigest, sessionId: created.session.sessionManager.getSessionId(),
          runtimeInstanceRef: scope.runtimeInstanceRef }, record }));
        if (JSON.stringify(created.session.getActiveToolNames()) !== JSON.stringify(TOOL_NAMES)) armFail("arm-tool-surface-mismatch");
        created.session.subscribe(event => { if (event?.type === "message_end" && event.message?.errorMessage)
          void record({ version: 1, kind: "qualified-arm-error", stage: "message", message: String(event.message.errorMessage) }); });
        await record({ version: 1, kind: "qualified-session-created", armId: identity.armId,
          sessionId: created.session.sessionManager.getSessionId(), tools: created.session.getActiveToolNames() });
        return created;
      } };
    const baseFactory = selectedFactoryModule.createProductionRuntimeFactory({ host: facade,
      agentDir: identity.runtimeHome, packageRoot: identity.candidateRoot, modelRuntime: capturedRuntime,
      ...(scopedBrokerRouter ? { scopedBrokerRouter } : {}) });
    const runtimeFactory = async (info, runtimeInstanceRef, manager, initial) => {
      try {
        return await runtimeScope.run({ runtimeInstanceRef },
          () => baseFactory(info, runtimeInstanceRef, manager, initial));
      }
      catch (error) { await record({ version: 1, kind: "qualified-arm-error", stage: "runtime", message: String(error?.message ?? error) }); throw error; }
    };
    const state = profileModule.gatewayProfileState(identity.runtimeHome), key = profileModule.readOrCreateCatalogKey(state);
    const metadata = new metadataModule.SessionMetadataStore(state.root, key), projects = new projectModule.ProjectRegistry(state.root, key);
    const gatewayInstanceRef = `g0_${process.pid}_${identity.armId}_${Date.now()}`;
    const events = new eventsModule.GatewayEventStore();
    runtimes = new selectedSupervisorModule.SessionRuntimeSupervisor({ gatewayInstanceRef, key,
      leases: new leaseModule.SessionLeaseStore(state.root, key), listSessions: () => host.SessionManager.listAll(),
      runtimeFactory, host, events, resolveProject: ref => projects.resolve(ref),
      compositeSettlementEvidence: scopedBrokerRouter
        ? () => scopedBrokerRouter.settlementEvidence() : loaded.settlementEvidence });
    const readCatalog = () => catalogModule.buildSessionCatalog({ gatewayInstanceRef, key,
      listSessions: () => runtimes.listSessions(), readMetadata: () => metadata.read(),
      readOwnership: ref => runtimes.ownership(ref), readSessionOptions: () => ({ modelLabel: null, thinkingLevel: "unknown" }) });
    runtimes.setProjectionReader(async ref => { const catalog = await readCatalog(), row = catalog.sessions.find(item => item.sessionRef === ref);
      if (!row) armFail("arm-session-projection"); return { sessionRevision: row.sessionRevision, liveState: row.liveState }; });
    const commands = new commandModule.SessionCommandController({ catalog: readCatalog, runtimes, metadata,
      store: new commandStoreModule.SessionCommandStore(state.root, key), events });
    const runtimeCommands = new runtimeCommandModule.RuntimeCommandController({ catalog: readCatalog, runtimes, events });
    const capabilities = () => ({ schemaVersion: 1, version: "piagent-gateway-capabilities-v1", generatedAt: new Date().toISOString(),
      gatewayInstanceRef, protocol: { minimum: 1, maximum: 1, selected: 1, compatibility: "ready" }, mode: "full",
      capabilities: { catalog: { status: "available", version: 1, reasonCode: null }, events: { status: "available", version: 1, reasonCode: null },
        terminalAdapter: { status: "unavailable", version: null, reasonCode: "g0-scoped" }, sessionRuntime: { status: "available", version: 1, reasonCode: null },
        sessionActions: Object.fromEntries(["create", "send", "abort", "setModel", "setThinking", "setPermission", "rename", "pin", "archive", "unarchive", "fork", "acquire", "release"]
          .map(name => [name, { status: "available", version: 1, reasonCode: null }])) }, reasonCode: null });
    const protocol = new protocolModule.GatewayProtocolService({ capabilities, catalog: readCatalog, events, command: commands });
    const inspections = new inspectionModule.SessionInspectionRegistry({ gatewayInstanceRef, host, key,
      packageRoot: identity.candidateRoot, agentDir: identity.runtimeHome, models: capturedRuntime, projects,
      listSessions: () => runtimes.listSessions(), openLiveSession: ref => runtimes.liveSessionManager(ref),
      operationLiveness: ref => runtimes.currentOperation(ref) ? "running" : "idle" });
    loopback = await loopbackModule.startLoopbackServer({ staticRoot: identity.assetsRoot, mode: "gateway",
      readCapabilities: capabilities, readSessionCatalog: readCatalog,
      readSessionLiveState: () => liveModule.buildSessionLiveState({ gatewayInstanceRef,
        eventSequence: events.stateVersion, operations: runtimes.currentOperations(), settlements: events.recentOperationSettlements() }),
      readSessionCreationOptions: () => inspections.creationOptions(), readSessionModel: ref => inspections.provider(ref),
      executeRuntimeCommand: command => runtimeCommands.execute(command), gatewayProtocol: protocol });
    await record(Object.freeze({ version: 1, kind: "qualified-arm-start", armId: identity.armId,
      candidateDigest: identity.candidateDigest, configSha256: identity.configSha256, moduleCount: names.length,
      tools: [...TOOL_NAMES], providerRoute: "local-loopback", externalProviderCalls: 0 }));
    return Object.freeze({ descriptor: { gatewayInstanceRef, origin: loopback.origin }, launchUrl: loopback.issueLaunchUrl(),
      qualification: "PROVISIONAL_NOT_G0", async wait() {}, async close() {
        await loopback.close().catch(() => undefined); await runtimes.close().catch(() => undefined);
        await record({ version: 1, kind: "qualified-observer-status", armId: identity.armId,
          transport: loopbackTransport.status(), statuses: observers.map(observer => observer.status()) });
        if (loaded && !loaded.broker.status().ended) {
          if (!loaded.broker.status().cancelled) loaded.broker.cancel(); loaded.broker.close();
        }
      } });
    } catch (error) {
      await loopback?.close().catch(() => undefined); await runtimes?.close().catch(() => undefined);
      try { if (loaded && !loaded.broker.status().ended) {
        if (!loaded.broker.status().cancelled) loaded.broker.cancel(); loaded.broker.close();
      } }
      catch {}
      throw error;
    }
  };
}

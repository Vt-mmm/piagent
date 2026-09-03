import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { attachBenchmarkArmObserver, createQualifiedArmGatewayLauncher,
  createQualifiedLoopbackTransport } from "../scripts/benchmark-arm-observer.mjs";
import { createQualifiedLoopbackModelRuntime, sanitizeScopedProviderContext, scopedContextPolicySha256,
  scopedTreeIdentity, SCOPED_TOOL_DEFINITIONS, validateScopedProviderPayload
} from "../scripts/benchmark-scoped-verification-supervisor.mjs";

const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = { armId: "fixture-A", candidateDigest: "a".repeat(64), sessionId: "fixture-session", runtimeInstanceRef: "fixture-runtime" };
function fixture(callback, options = {}) {
  const records = [], session = { agent: { onPayload: callback }, sessionManager: { getSessionId: () => identity.sessionId } };
  const observer = attachBenchmarkArmObserver({ session, identity, record: row => records.push(row), ...options });
  return { session, observer, records };
}

test("preserves the exact replacement, receiver and arguments after the existing callback", async () => {
  const raw = { instruction: "before" }, replacement = { instruction: "after", tools: [] }, model = {};
  let f;
  f = fixture(function (payload, passedModel) { assert.equal(this, f.session.agent); assert.equal(payload, raw);
    assert.equal(passedModel, model); return replacement; });
  assert.equal(await f.session.agent.onPayload(raw, model), replacement);
  assert.equal(f.records[0].payloadSha256, sha(replacement));
  assert.equal(f.observer.status().complete, true);
  assert.equal(f.observer.status().phaseWireQualified, false);
  assert.equal(f.observer.status().dispatchPermission, false);
});

test("undefined fallback and exact host exception survive record errors", async () => {
  const raw = { value: 1 }, error = new Error("original failure");
  const f = fixture(() => undefined, { record() { throw new Error("sink failure"); } });
  assert.equal(await f.session.agent.onPayload(raw), undefined);
  assert.deepEqual(f.observer.status().reasons, ["record-failed"]);
  const g = fixture(() => { throw error; }, { record() { throw new Error("sink failure"); } });
  await assert.rejects(g.session.agent.onPayload(raw), failure => failure === error);
  assert.equal(g.observer.status().thrownCount, 1);
  assert.equal(g.observer.status().complete, false);
});

test("hashing does not invoke payload getters, toJSON or proxy traps", async () => {
  for (const payload of [Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("getter invoked"); } }),
    { toJSON() { throw new Error("toJSON invoked"); } },
    new Proxy({}, { ownKeys() { throw new Error("proxy trap invoked"); } })]) {
    const f = fixture(() => payload);
    assert.equal(await f.session.agent.onPayload({}), payload);
    assert.equal(f.observer.status().complete, false);
    assert.deepEqual(f.observer.status().reasons, ["payload-unobservable"]);
  }
});

test("repeated callbacks remain distinct; overflow does not change host output", async () => {
  const payload = { text: "same" }, f = fixture(() => payload, { maximumCallbacks: 2 });
  for (let index = 0; index < 3; index++) assert.equal(await f.session.agent.onPayload(payload), payload);
  assert.deepEqual(f.records.map(row => row.sequence), [1, 2]);
  assert.equal(f.observer.status().callbackCount, 3);
  assert.deepEqual(f.observer.status().reasons, ["callback-limit"]);
});

test("overlapping callback completions keep invocation sequence and exact results", async () => {
  const pending = [], f = fixture(() => new Promise(resolve => pending.push(resolve)), { maximumCallbacks: 2 });
  const first = f.session.agent.onPayload({}), second = f.session.agent.onPayload({});
  const a = { value: "first" }, b = { value: "second" };
  pending[1](b); assert.equal(await second, b); pending[0](a); assert.equal(await first, a);
  assert.deepEqual(f.records.map(row => row.sequence), [2, 1]);
  assert.deepEqual(f.records.map(row => row.payloadSha256), [sha(b), sha(a)]);
  assert.equal(f.observer.status().complete, true);
});

test("sparse and non-JSON payloads invalidate observation without changing the callback", async () => {
  for (const payload of [[, 1], { value: undefined }]) {
    const f = fixture(() => payload);
    assert.equal(await f.session.agent.onPayload({}), payload);
    assert.deepEqual(f.observer.status().reasons, ["payload-unobservable"]);
  }
});

test("missing identity, duplicate installation and callback ownership loss cannot claim completeness", () => {
  const f = fixture(() => ({}));
  assert.throws(() => attachBenchmarkArmObserver({ session: f.session, identity, record() {} }), /already-attached/);
  assert.throws(() => fixture(() => ({}), { identity: { ...identity, sessionId: "other" } }), /identity-invalid/);
  const later = () => ({}); f.session.agent.onPayload = later;
  assert.deepEqual(f.observer.status().reasons, ["callback-ownership-lost"]);
  assert.equal(f.observer.detach(), false);
  assert.equal(f.session.agent.onPayload, later);
});

test("detach restores only its own public callback", () => {
  const previous = () => ({}), f = fixture(previous);
  assert.equal(f.observer.detach(), true);
  assert.equal(f.session.agent.onPayload, previous);
});

test("qualified launcher rejects malformed or cross-root v3 identity and defers tree rechecks to launch", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arm-launch-identity-")));
  const candidate = path.join(root, "candidate"), sdk = path.join(root, "sdk"), runtime = path.join(root, "runtime");
  const assets = path.join(candidate, "packages/piagent-webui/dist/client");
  fs.mkdirSync(assets, { recursive: true }); fs.mkdirSync(sdk); fs.mkdirSync(runtime); fs.writeFileSync(path.join(assets, "index.html"), "ok");
  const config = path.join(root, "config.json"); fs.writeFileSync(config, "{}");
  const contextPolicy = { version: 2, systemPrompt: "G0 exact3.", allowedUserMessages: ["allowed"], removableUserMessages: [] };
  const arm = { version: 3, armId: "A", candidateRoot: fs.realpathSync(candidate), candidateDigest: "a".repeat(64),
    configSha256: "b".repeat(64), brokerClosureSha256: "c".repeat(64), toolDefinitionsSha256: "d".repeat(64),
    manifestAuthoritySha256: "e".repeat(64), journalSignerSha256: "f".repeat(64), journalPathSha256: "1".repeat(64),
    contextPolicySha256: scopedContextPolicySha256(contextPolicy), sdkRoot: fs.realpathSync(sdk), sdkVersion: "0.84.1",
    sdkTreeSha256: scopedTreeIdentity(fs.realpathSync(sdk)).sha256,
    assetsRoot: fs.realpathSync(assets), assetTreeSha256: scopedTreeIdentity(fs.realpathSync(assets)).sha256,
    runtimeHome: fs.realpathSync(runtime) };
  try {
    assert.equal(typeof createQualifiedArmGatewayLauncher({ identity: arm, brokerConfigPath: config,
      modelRuntime: {}, record() {}, contextPolicy }), "function");
    assert.throws(() => createQualifiedArmGatewayLauncher({ identity: { ...arm, candidateDigest: "unfrozen" },
      brokerConfigPath: config, modelRuntime: {}, record() {}, contextPolicy }), /arm-identity-invalid/);
    const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "index.html"), "outside");
    assert.throws(() => createQualifiedArmGatewayLauncher({ identity: { ...arm, assetsRoot: fs.realpathSync(outside) },
      brokerConfigPath: config, modelRuntime: {}, record() {}, contextPolicy }), /arm-assets-outside-candidate/);
    fs.writeFileSync(path.join(sdk, "mutation"), "changed");
    assert.equal(typeof createQualifiedArmGatewayLauncher({ identity: arm, brokerConfigPath: config,
      modelRuntime: {}, record() {}, contextPolicy }), "function");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("qualified context policy removes only signed automatic messages and validates the whole final payload", () => {
  const automatic = "permissionProfile: workspace-write\nversion-bound-auto", policy = { version: 2,
    systemPrompt: "G0 signed exact3 context.", allowedUserMessages: ["perform allowed case"],
    removableUserMessages: [automatic] };
  const tools = SCOPED_TOOL_DEFINITIONS.map(definition => ({ name: definition.name, label: definition.name,
    description: `Bounded broker operation ${definition.name}.`, parameters: definition.inputSchema,
    constrainedSampling: true, execute() { throw new Error("must-not-run-here"); } }));
  const context = { systemPrompt: "UNBOUND_HOST_PROMPT_SENTINEL", messages: [
    { role: "user", content: [{ type: "text", text: automatic }], timestamp: 123 },
    { role: "user", content: [{ type: "text", text: "perform allowed case" }], timestamp: 456 }
  ], tools };
  const outgoing = sanitizeScopedProviderContext(context, policy);
  assert.equal(outgoing.systemPrompt, policy.systemPrompt); assert.equal(outgoing.messages.length, 1);
  assert.equal(outgoing.messages[0].content[0].text, "perform allowed case");
  assert.ok(!JSON.stringify(outgoing).includes("UNBOUND_HOST_PROMPT_SENTINEL"));
  assert.ok(!JSON.stringify(outgoing).includes("version-bound-auto")); assert.ok(!Object.hasOwn(outgoing.tools[0], "execute"));
  const payload = { model: "g0", messages: structuredClone(outgoing.messages), tools: structuredClone(outgoing.tools) };
  assert.equal(JSON.stringify(validateScopedProviderPayload(payload, "g0", outgoing)), JSON.stringify(payload));
  assert.throws(() => sanitizeScopedProviderContext({ ...context, messages: [...context.messages,
    { role: "user", content: [{ type: "text", text: "UNSIGNED_TASK_POISON" }], timestamp: 789 }] }, policy),
  /context-user-not-allowlisted/);
  assert.throws(() => validateScopedProviderPayload({ ...payload, poison: true }, "g0", outgoing), /invalid-fields/);
  const widened = structuredClone(payload); widened.tools[0].execute = "forged";
  assert.throws(() => validateScopedProviderPayload(widened, "g0", outgoing), /invalid-fields/);
});

test("capability-branded host loopback validates final bytes before evidence or endpoint dispatch", {
  skip: !fs.existsSync(process.env.PIAGENT_REAL_PI_HOST
    ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent"), timeout: 15000
}, async t => {
  const sdkRoot = fs.realpathSync(process.env.PIAGENT_REAL_PI_HOST
    ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent");
  const policy = { version: 2, systemPrompt: "G0 exact3.", allowedUserMessages: ["allowed"], removableUserMessages: [] };
  const arm = { version: 3, armId: "A", candidateDigest: "a".repeat(64), assetTreeSha256: "b".repeat(64),
    brokerClosureSha256: "c".repeat(64), sdkTreeSha256: "d".repeat(64), configSha256: "e".repeat(64),
    contextPolicySha256: scopedContextPolicySha256(policy), sdkRoot };
  const model = { id: "g0", api: "g0-loopback", provider: "loopback" };
  const context = { systemPrompt: "ignored", messages: [{ role: "user",
    content: [{ type: "text", text: "allowed" }], timestamp: 1 }], tools: SCOPED_TOOL_DEFINITIONS.map(item => ({
    name: item.name, label: item.name, description: `Bounded broker operation ${item.name}.`, parameters: item.inputSchema })) };
  let endpointHits = 0, callerStreams = 0;
  const server = http.createServer((request, response) => { endpointHits++; request.resume();
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ kind: "text", text: "done" })); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const caller = { streamSimple() { callerStreams++; throw new Error("caller-bypass"); } };
  await assert.rejects(createQualifiedLoopbackModelRuntime({ modelRuntime: caller, transport: {}, record() {},
    identity: arm, contextPolicy: policy }), /loopback-capability-invalid/);
  const rejectedRecords = [], rejectedTransport = createQualifiedLoopbackTransport({ origin });
  const rejected = await createQualifiedLoopbackModelRuntime({ modelRuntime: caller, transport: rejectedTransport,
    record: row => rejectedRecords.push(row), identity: arm, contextPolicy: policy });
  const failure = await rejected.streamSimple(model, context, { onPayload: payload => ({ ...payload, poison: true }) }).result();
  assert.equal(failure.stopReason, "error"); assert.match(failure.errorMessage, /invalid-fields/);
  assert.equal(endpointHits, 0); assert.equal(callerStreams, 0); assert.deepEqual(rejectedRecords, []);
  assert.deepEqual({ ...rejectedTransport.status(), lastFailure: null }, { version: 1, bound: true,
    validatedRequests: 0, callbackCount: 1, evidenceRecords: 0, networkWrites: 0, responses: 0, failures: 1,
    lastRequestSha256: null, lastFailure: null, externalProviderCalls: 0 });
  assert.match(rejectedTransport.status().lastFailure, /invalid-fields/);
  const nullTransport = createQualifiedLoopbackTransport({ origin });
  const nullRuntime = await createQualifiedLoopbackModelRuntime({ modelRuntime: caller, transport: nullTransport,
    record() {}, identity: arm, contextPolicy: policy });
  const nullFailure = await nullRuntime.streamSimple(model, context, { onPayload: () => null }).result();
  assert.equal(nullFailure.stopReason, "error"); assert.equal(endpointHits, 0); assert.equal(callerStreams, 0);
  assert.equal(nullTransport.status().evidenceRecords, 0); assert.equal(nullTransport.status().networkWrites, 0);
  const records = [], transport = createQualifiedLoopbackTransport({ origin });
  const runtime = await createQualifiedLoopbackModelRuntime({ modelRuntime: caller, transport,
    record: row => records.push(row), identity: arm, contextPolicy: policy });
  const message = await runtime.streamSimple(model, context, { onPayload: payload => payload }).result();
  assert.equal(message.content[0].text, "done"); assert.equal(endpointHits, 1); assert.equal(callerStreams, 0);
  assert.deepEqual(records.map(row => row.kind), ["provider-context", "final-provider-payload"]);
  assert.deepEqual(transport.status(), { version: 1, bound: true, validatedRequests: 1, callbackCount: 1,
    evidenceRecords: 2, networkWrites: 1, responses: 1, failures: 0,
    lastRequestSha256: records[1].sha256, lastFailure: null, externalProviderCalls: 0 });
});

const candidateRoot = process.env.PIAGENT_OBSERVER_BASELINE_ROOT;
const hostRoot = process.env.PIAGENT_REAL_PI_HOST;
const actualAvailable = Boolean(candidateRoot && hostRoot);

test("actual pinned SDK + immutable A factory: final wrapper sees tail replacement missed by an earlier extension", {
  skip: !actualAvailable, timeout: 30000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-sdk-"));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir); fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  const host = await import(pathToFileURL(path.join(hostRoot, "dist/index.js")));
  const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(hostRoot,
    "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
  const { createProductionRuntimeFactory } = await import(pathToFileURL(path.join(candidateRoot,
    "packages/piagent-webui/gateway/session-runtime-factory.ts")));
  const model = { id: "qualification", name: "Local synthetic qualification", api: "qualification", provider: "qualification",
    baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16000, maxTokens: 1000 };
  const early = [], final = [], records = [], errors = [];
  let runtime, observer, fakeCalls = 0, starts = 0, ends = 0, guardLoaded = false;
  const modelRuntime = {
    async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => { throw new Error("external-auth-forbidden"); },
    getModel: () => model, getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model],
    getProviders: () => [], registerProvider() { throw new Error("registration-forbidden"); },
    registerNativeProvider() { throw new Error("registration-forbidden"); }, unregisterProvider() {},
    streamSimple(_model, _context, options) {
      fakeCalls++;
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          const raw = { model: "qualification", instructions: "synthetic-before", tools: [] };
          const changed = await options.onPayload(raw, model);
          final.push(changed === undefined ? raw : changed);
          stream.push({ type: "done", reason: "stop", message });
        } catch (error) { errors.push(error.message); message.stopReason = "error"; message.errorMessage = error.message;
          stream.push({ type: "error", reason: "error", error: message }); }
      })();
      return stream;
    }
  };
  const manager = host.SessionManager.inMemory(cwd);
  const facade = { ...host,
    async createAgentSessionServices(options) {
      const services = await host.createAgentSessionServices({ ...options,
        settingsManager: host.SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } },
          { projectTrusted: true }),
        resourceLoaderOptions: { ...options.resourceLoaderOptions, noSkills: true, noPromptTemplates: true, noThemes: true,
          noContextFiles: true, extensionFactories: [pi => pi.on("before_provider_request", event => { early.push(sha(event.payload)); }),
            pi => pi.on("before_provider_request", event => ({ ...event.payload, instructions: "synthetic-after" }))] } });
      guardLoaded = services.resourceLoader.getExtensions().extensions.some(extension =>
        fs.realpathSync(extension.path) === fs.realpathSync(path.join(candidateRoot, "packages/piagent-core/extensions/piagent-guard.ts")));
      return services;
    },
    async createAgentSessionFromServices(options) {
      const created = await host.createAgentSessionFromServices({ ...options, model, thinkingLevel: "off", noTools: "all" });
      observer = attachBenchmarkArmObserver({ session: created.session,
        identity: { ...identity, sessionId: manager.getSessionId() }, record: row => records.push(row) });
      created.session.subscribe(event => { if (event.type === "agent_start") starts++; if (event.type === "agent_end") ends++; });
      return created;
    }
  };
  t.after(async () => { await runtime?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  runtime = await createProductionRuntimeFactory({ host: facade, agentDir, packageRoot: candidateRoot, modelRuntime })(
    { path: path.join(root, "session.jsonl"), id: manager.getSessionId(), cwd }, identity.runtimeInstanceRef, manager);
  await runtime.session.prompt("Hello.", { source: "rpc" });
  assert.equal(guardLoaded, true, "must preserve the actual A guard in this low-level qualification");
  assert.deepEqual(errors, []);
  assert.equal(fakeCalls, 1); assert.equal(starts, 1); assert.equal(ends, 1);
  assert.equal(early.length, 1); assert.equal(final.length, 1); assert.equal(records.length, 1);
  assert.notEqual(early[0], sha(final[0]), "ordinary earlier extension does not observe final payload");
  assert.equal(records[0].payloadSha256, sha(final[0]));
  assert.equal(observer.status().complete, true);
  t.diagnostic("actual-SDK/A-factory only: 1 synthetic call, 0 external calls; top-level A gateway injection remains unproven");
});

// These tests call the real public SDK callback directly. They never prompt,
// register a provider, or execute a model stream. PASS can confirm a limitation.
async function tailFixture(t, factories = []) {
  assert.ok(actualAvailable, "TAIL tests require the pinned SDK and immutable A paths");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tail-sdk-")));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const host = await import(pathToFileURL(path.join(hostRoot, "dist/index.js")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"))).version, "0.84.1");
  const metrics = { sdkSessions: 0, directCallbacks: 0, streams: 0, authRetrievals: 0, providerRegistrations: 0, modelTurns: 0 };
  const denied = key => () => { metrics[key]++; throw new Error(`tail-forbidden-${key}`); };
  const model = { id: "tail-fixture", name: "Direct callback fixture", api: "tail-fixture", provider: "tail-fixture",
    baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16000, maxTokens: 1000 };
  const modelRuntime = { async refresh() {}, getModel: () => model, getModels: () => [model],
    getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    hasConfiguredAuth: denied("authRetrievals"), checkAuth: denied("authRetrievals"), getAuth: denied("authRetrievals"),
    isUsingOAuth: () => false, registerProvider: denied("providerRegistrations"),
    registerNativeProvider: denied("providerRegistrations"), unregisterProvider() {}, streamSimple: denied("streams") };
  const settingsManager = host.SettingsManager.inMemory({ packages: [], retry: { enabled: false, maxRetries: 0 },
    compaction: { enabled: false } }, { projectTrusted: true });
  const sessions = [], errors = [];
  const loader = options => new host.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories, ...options });
  const ordered = resourceLoader => resourceLoader.getExtensions().extensions.map(extension => ({
    path: extension.path, sha256: extension.path.startsWith("<inline:") ? null
      : createHash("sha256").update(fs.readFileSync(extension.resolvedPath || extension.path)).digest("hex") }));
  async function create(resourceLoader = loader()) {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await host.createAgentSession({ cwd, agentDir, model, thinkingLevel: "off", noTools: "all",
      modelRuntime, settingsManager, sessionManager: host.SessionManager.inMemory(cwd), resourceLoader });
    metrics.sdkSessions++; sessions.push(session);
    session.subscribe(event => { if (event.type === "agent_start") metrics.modelTurns++; });
    await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
    return { session, resourceLoader, invoke: async payload => {
      metrics.directCallbacks++; return await session.agent.onPayload(payload, model);
    } };
  }
  t.after(() => {
    for (const session of sessions) session.dispose();
    t.diagnostic(`TAIL_METRICS ${JSON.stringify({ case: t.name.slice(0, 7), ...metrics })}`);
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(metrics.streams + metrics.authRetrievals + metrics.providerRegistrations + metrics.modelTurns, 0);
  });
  return { root, cwd, agentDir, host, loader, ordered, create, errors, metrics };
}

test("TAIL-02 actual resource loader keeps the immutable A guard before a pinned global tail", {
  skip: !actualAvailable, timeout: 30000
}, async t => {
  const f = await tailFixture(t), guard = path.join(candidateRoot, "packages/piagent-core/extensions/piagent-guard.ts");
  const { preferAuthoritativePiagentGuard } = await import(pathToFileURL(path.join(candidateRoot,
    "packages/piagent-webui/gateway/extension-authority.ts")));
  const options = { noExtensions: false, additionalExtensionPaths: [guard], extensionsOverride: preferAuthoritativePiagentGuard(guard) };
  const control = f.loader(options); await control.reload();
  assert.deepEqual(control.getExtensions().errors, []);
  const baselineOrder = f.ordered(control);
  assert.deepEqual(baselineOrder.map(row => fs.realpathSync(row.path)), [fs.realpathSync(guard)]);
  const tail = path.join(f.agentDir, "extensions", "tail.js"); fs.mkdirSync(path.dirname(tail));
  fs.writeFileSync(tail, 'export default function(pi) { pi.on("before_provider_request", () => undefined); }\n');
  const observed = f.loader(options); await observed.reload();
  assert.deepEqual(observed.getExtensions().errors, []);
  const order = f.ordered(observed);
  assert.deepEqual(order.map(row => fs.realpathSync(row.path)), [fs.realpathSync(guard), fs.realpathSync(tail)]);
  assert.deepEqual(order[0], baselineOrder[0]);
  t.diagnostic(`TAIL_ORDER ${JSON.stringify({ case: "TAIL-02", ordered: order, digest: sha(order), baselineOrder })}`);
});

test("TAIL-03 actual SDK tail sees the preceding replacement and agrees with direct callback return", {
  skip: !actualAvailable, timeout: 30000
}, async t => {
  const observed = [], replacement = { instructions: "after", tools: [] };
  const f = await tailFixture(t, [pi => pi.on("before_provider_request", () => replacement),
    pi => pi.on("before_provider_request", event => { observed.push(sha(event.payload)); })]);
  const s = await f.create(), raw = { instructions: "before", tools: [] };
  const result = await s.invoke(raw);
  assert.equal(result, replacement); assert.deepEqual(observed, [sha(result)]);
  assert.notEqual(sha(raw), observed[0]); assert.deepEqual(f.errors, []);
});

test("TAIL-04 preceding swallowed error is invisible to an otherwise identical last observer", {
  skip: !actualAvailable, timeout: 30000
}, async t => {
  let shouldThrow = false; const observed = [];
  const f = await tailFixture(t, [pi => pi.on("before_provider_request", () => {
    if (shouldThrow) throw new Error("tail-earlier-hook-failure");
  }), pi => pi.on("before_provider_request", (event, ctx) => {
    observed.push({ payload: sha(event.payload), contextKeys: Object.keys(ctx).sort() });
  })]);
  const s = await f.create(), raw = { value: "identical" };
  assert.equal(await s.invoke(raw), raw); assert.deepEqual(f.errors, []);
  shouldThrow = true; assert.equal(await s.invoke(raw), raw);
  assert.deepEqual(observed[1], observed[0]);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].event, "before_provider_request");
  assert.equal(f.errors[0].error, "tail-earlier-hook-failure");
  assert.ok(!observed[0].contextKeys.includes("agent") && !observed[0].contextKeys.includes("session"));
  t.diagnostic("TAIL_LIMITATION preceding hook error is host-only; tail payload equality cannot certify error-free admission");
});

test("TAIL-05 a throwing tail sink does not reject the actual SDK final callback", {
  skip: !actualAvailable, timeout: 30000
}, async t => {
  let failSink = false; const durable = [];
  const f = await tailFixture(t, [pi => pi.on("before_provider_request", event => {
    if (failSink) throw new Error("tail-sink-failure");
    durable.push(sha(event.payload));
  })]);
  const s = await f.create(), raw = { value: "same" };
  assert.equal(await s.invoke(raw), raw); failSink = true; assert.equal(await s.invoke(raw), raw);
  assert.equal(durable.length, 1); assert.equal(f.errors.length, 1); assert.equal(f.errors[0].error, "tail-sink-failure");
  assert.notEqual(durable.length, f.metrics.directCallbacks);
  t.diagnostic("TAIL_LIMITATION sink failure leaves SDK return intact; missing durable observation must remain unavailable");
});

test("TAIL-06 retained replacement mutation invalidates the tail pre-await hash", {
  skip: !actualAvailable, timeout: 30000
}, async t => {
  const replacement = { value: "before-await" }, entered = Promise.withResolvers(), release = Promise.withResolvers();
  let recordedHash;
  const f = await tailFixture(t, [pi => pi.on("before_provider_request", () => replacement),
    pi => pi.on("before_provider_request", async event => {
      recordedHash = sha(event.payload); entered.resolve(); await release.promise;
    })]);
  const s = await f.create(), pending = s.invoke({ value: "original" });
  await entered.promise; replacement.value = "changed-during-await"; release.resolve();
  const result = await pending;
  assert.equal(result, replacement); assert.notEqual(recordedHash, sha(result)); assert.deepEqual(f.errors, []);
  t.diagnostic(`TAIL_LIMITATION ${JSON.stringify({ case: "TAIL-06", recordedHash, finalHash: sha(result), finalBytesEqual: false })}`);
});

test("TAIL-07 an appended real extension invalidates the frozen tail position", {
  skip: !actualAvailable, timeout: 30000
}, async t => {
  const f = await tailFixture(t), tail = path.join(f.root, "tail.js"), foreign = path.join(f.root, "foreign.js");
  fs.writeFileSync(tail, 'export default function(pi) { pi.on("before_provider_request", () => undefined); }\n');
  fs.writeFileSync(foreign, 'export default function(pi) { pi.on("before_provider_request", p => ({...p.payload, later:true})); }\n');
  const initial = f.loader({ additionalExtensionPaths: [tail] }); await initial.reload();
  assert.deepEqual(initial.getExtensions().errors, []); const frozenOrder = f.ordered(initial);
  const s = await f.create(f.loader({ additionalExtensionPaths: [tail, foreign] })), changedOrder = f.ordered(s.resourceLoader);
  assert.notEqual(sha(frozenOrder), sha(changedOrder));
  assert.deepEqual(changedOrder.map(row => row.path), [tail, foreign]);
  assert.equal(changedOrder[changedOrder.length - 1].path === tail, false);
  assert.deepEqual(await s.invoke({ value: "input" }), { value: "input", later: true });
  t.diagnostic(`TAIL_ORDER ${JSON.stringify({ case: "TAIL-07", frozenOrder, changedOrder,
    frozenDigest: sha(frozenOrder), changedDigest: sha(changedOrder), frozenTailEligible: false })}`);
});

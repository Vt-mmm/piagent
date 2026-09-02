import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { createProductionRuntimeFactory } from "../packages/piagent-webui/gateway/session-runtime-factory.ts";
import { observeHostWireInput, HOST_WIRE_PHASE_EDGES } from "../packages/piagent-core/runtime/session/runtime-state.ts";
import { buildOpenAiCodexWireFingerprint } from "../packages/piagent-core/runtime/model/provider-wire-fingerprint.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const hostRoot = process.env.PIAGENT_REAL_PI_HOST;
const hostAvailable = Boolean(hostRoot && fs.existsSync(path.join(hostRoot, "dist/index.js")));
const expectedPayload = { model: "gpt-5.6-luna", instructions: "Pinned offline final payload", tools: [], input: [], service_tier: "priority",
  reasoning: { effort: "medium" }, text: { verbosity: "low" }, tool_choice: "auto" };
const clone = value => structuredClone(value);
const sha = value => createHash("sha256").update(value).digest("hex");
const inputText = "Offline fixture; fake model only.";

async function actualFixture(t, behavior = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PIAGENT_WIRE_TEST_ROOT || os.tmpdir(), "final-wire-")));
  fs.chmodSync(root, 0o700);
  const cwd = path.join(root, "project"), custody = path.join(root, "custody");
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(custody, { mode: 0o700 });
  const host = await import(pathToFileURL(path.join(hostRoot, "dist/index.js")));
  const aiRoot = path.join(hostRoot, "node_modules/@earendil-works/pi-ai/dist");
  const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(aiRoot, "utils/event-stream.js")));
  const { getModel } = await import(pathToFileURL(path.join(aiRoot, "compat.js")));
  const model = getModel("openai-codex", "gpt-5.6-luna");
  const counts = { fakeStreams: 0, wouldDispatch: 0, realProviderCalls: 0, hookCalls: 0, hostStarts: 0, hostEnds: 0 };
  const records = { payloads: [], errors: [], contexts: [], agents: [], retained: null };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const receiptPublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const fingerprint = buildOpenAiCodexWireFingerprint({ payload: expectedPayload, provider: model.provider, modelId: model.id, workingDirectory: cwd });
  const manifest = { schemaVersion: 1, protocol: "phase-valid-configuration-v1", source: "pinned-host-definitions",
    candidateDigest: "1".repeat(64), configurationDigest: "2".repeat(64), definitionDigest: "3".repeat(64), workingDirectory: cwd,
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", requestedTier: "fast", requestTier: "priority", receiptPublicKey,
    states: [{ id: "pre-task", operatorInputHash: sha(inputText), inputHash: sha(inputText), phase: null,
      taskPresence: "none", selectedTools: [], fingerprint }], allowedEdges: clone(HOST_WIRE_PHASE_EDGES),
    pins: [{ path: "fixture-public-definition", sha256: sha(JSON.stringify(expectedPayload)) }] };
  const wireReceiptsPath = path.join(custody, "receipts.jsonl"); fs.writeFileSync(wireReceiptsPath, "", { mode: 0o600 });
  const modelRuntime = {
    async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => { throw new Error("real-auth-forbidden"); }, getModel: () => model, getModels: () => [model],
    getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() { throw new Error("provider-registration-forbidden"); },
    registerNativeProvider() { throw new Error("provider-registration-forbidden"); }, unregisterProvider() {},
    streamSimple(_model, _context, options) {
      counts.fakeStreams++;
      const stream = new AssistantMessageEventStream();
      const response = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          const raw = clone(expectedPayload);
          const transformed = await options.onPayload(raw, model);
          const final = transformed === undefined ? raw : transformed;
          await behavior.afterPayload?.({ records, counts });
          if (options.signal?.aborted) throw new Error("fixture-aborted");
          records.payloads.push(clone(final)); counts.wouldDispatch++;
          stream.push({ type: "done", reason: "stop", message: response });
        } catch (error) {
          response.stopReason = options.signal?.aborted ? "aborted" : "error";
          response.errorMessage = error.message; records.errors.push(error.message);
          stream.push({ type: "error", reason: response.stopReason, error: response });
        }
      })();
      return stream;
    }
  };
  const fixtureHost = {
    ...host,
    async createAgentSessionServices(options) {
      return host.createAgentSessionServices({ ...options,
        settingsManager: host.SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } }, { projectTrusted: true }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [pi => {
            pi.on("session_start", () => behavior.sessionStart?.());
            pi.on("input", (event, ctx) => {
              records.contexts.push(ctx);
              if (behavior.manifest || behavior.observeInputs) observeHostWireInput(ctx.cwd, ctx.sessionManager.getSessionId(),
                { turnId: `turn_${records.contexts.length}`, promptHash: sha(event.text), text: event.text, source: event.source, hasImages: Boolean(event.images?.length) });
              behavior.input?.(ctx);
            });
            pi.on("before_provider_request", async (event, ctx) => {
              counts.hookCalls++; records.retained = event.payload;
              return await behavior.beforePayload?.(event, ctx);
            });
          }] } });
    },
    async createAgentSessionFromServices(options) {
      const created = await host.createAgentSessionFromServices({ ...options, model, thinkingLevel: "medium", noTools: "all" });
      records.agents.push(created.session.agent);
      created.session.subscribe(event => { if (event.type === "agent_start") counts.hostStarts++; if (event.type === "agent_end") counts.hostEnds++; });
      return created;
    }
  };
  const manager = behavior.persisted ? host.SessionManager.create(cwd, path.join(root, "sessions")) : host.SessionManager.inMemory(cwd);
  const info = { path: manager.getSessionFile() ?? path.join(root, "session.jsonl"), id: manager.getSessionId(), cwd,
    created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" };
  const factoryOptions = { host: fixtureHost, agentDir: path.join(root, "agent"), packageRoot: repositoryRoot, modelRuntime,
    ...(behavior.manifest ? { wireManifest: manifest, signReceipt: material => sign(null, Buffer.from(material), privateKey).toString("base64"), wireReceiptsPath } : {}) };
  const factory = createProductionRuntimeFactory(factoryOptions);
  let runtime;
  const createRuntime = async (_info = info, generation = "runtime_wire_fixture") => (runtime = await factory(_info, generation, manager));
  if (!behavior.supervisor) await createRuntime();
  t.after(async () => { await behavior.beforeCleanup?.(); await runtime?.dispose();
    t.diagnostic?.(`WIRE_METRICS ${JSON.stringify(counts)}`); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, host, info, get runtime() { return runtime; }, createRuntime, manager, counts, records, manifest, publicKey, wireReceiptsPath, factoryOptions,
    begin: (overrides = {}) => runtime.beginWireOperation?.({ operationRef: "operation_wire", messageRequestId: "request_wire", inputText, ...overrides }),
    prompt: () => runtime.session.prompt(inputText, { source: "rpc" }),
    writeEnvironment() {
      const manifestPath = path.join(custody, "manifest.json"), keyPath = path.join(custody, "signing.pem");
      const source = JSON.stringify(manifest); fs.writeFileSync(manifestPath, source, { mode: 0o600 });
      fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      return { PIAGENT_WIRE_MANIFEST_PATH: manifestPath, PIAGENT_WIRE_MANIFEST_SHA256: sha(source),
        PIAGENT_WIRE_SIGNING_KEY_PATH: keyPath, PIAGENT_WIRE_RECEIPTS_PATH: wireReceiptsPath };
    } };
}

if (!process.env.PIAGENT_WIRE_CRASH_PHASE) {
test("errors raised during actual SDK reload remain latched before the next provider request", { skip: !hostAvailable }, async t => {
  let failReload = false;
  const f = await actualFixture(t, { manifest: true, sessionStart: () => {
    if (failReload) throw new Error("fixture-reload-start-error");
  } });
  failReload = true;
  await f.runtime.session.reload(); f.begin(); await f.prompt();
  assert.equal(f.counts.wouldDispatch, 0);
  assert.ok(f.records.errors.some(error => error.includes("extension-hook-error")));
});
test("actual pinned SDK preserves non-manifest prompts without an extra model turn", { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t);
  await f.prompt();
  assert.deepEqual(f.records.payloads, [expectedPayload]);
  assert.equal(f.counts.fakeStreams, 1);
  assert.equal(f.counts.wouldDispatch, 1);
  assert.equal(f.counts.hostStarts, 1);
  assert.equal(f.counts.hostEnds, 1);
  assert.equal(f.counts.realProviderCalls, 0);
});

async function actualSupervisor(t, behavior = {}) {
  let supervisor;
  const f = await actualFixture(t, { ...behavior, manifest: true, supervisor: true, beforeCleanup: () => supervisor?.close() });
  const key = Buffer.alloc(32, 19), sessionRef = sessionRefForPath(key, f.info.path), events = new GatewayEventStore();
  const settled = [];
  events.subscribe(event => { if (event.kind === "operation.settled") settled.push(event.payload); });
  supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_wire_fixture", key,
    leases: new SessionLeaseStore(path.join(f.root, "gateway"), key), listSessions: async () => [f.info], runtimeFactory: f.createRuntime, events });
  const send = (id, options) => supervisor.send(sessionRef,
    { delivery: "new-operation", expectedOperationRef: null, message: inputText, messageRequestId: id }, "revision_wire_fixture", options);
  const finish = async count => {
    for (let attempt = 0; attempt < 200 && settled.length < count; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settled.length, count);
  };
  return { ...f, get runtime() { return f.runtime; }, supervisor, sessionRef, settled, send, finish };
}

test("actual supervisor binds exact request, operation and runtime before dispatch and separates repeated text", { skip: !hostAvailable }, async t => {
  const f = await actualSupervisor(t);
  const first = await f.send("request_first", { deferDispatch: true });
  const lease = await f.supervisor.acquire(f.sessionRef);
  assert.equal(f.counts.fakeStreams, 0); first.dispatch(); await f.finish(1);
  assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
  const second = await f.send("request_second", { deferDispatch: true });
  assert.notEqual(second.operationRef, first.operationRef); second.dispatch(); await f.finish(2);
  const rows = fs.readFileSync(f.wireReceiptsPath, "utf8").trim().split("\n").map(line => JSON.parse(JSON.parse(line).material));
  assert.equal(rows.length, 2); assert.equal(rows[0].operationRef, first.operationRef); assert.equal(rows[1].operationRef, second.operationRef);
  assert.deepEqual(rows.map(row => row.messageRequestId), ["request_first", "request_second"]);
  assert.ok(rows.every(row => row.runtimeInstanceRef === lease.runtimeInstanceRef));
  assert.notEqual(rows[0].turnId, rows[1].turnId); assert.equal(f.counts.fakeStreams, 2);
});

test("actual supervisor cancels deferred admission without dispatch or borrowing the next request", { skip: !hostAvailable }, async t => {
  const f = await actualSupervisor(t);
  const cancelled = await f.send("request_cancelled", { deferDispatch: true });
  assert.equal(cancelled.cancel(), true); cancelled.dispatch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts.fakeStreams, 0); assert.equal(fs.readFileSync(f.wireReceiptsPath, "utf8"), "");
  const next = await f.send("request_after_cancel", { deferDispatch: true });
  assert.equal(cancelled.cancel(), false); next.dispatch(); await f.finish(1);
  assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
});

test("actual supervisor blocks unbound queued inputs and retires authority before abort awaits", { skip: !hostAvailable }, async t => {
  let releaseHook, enteredHook;
  const entered = new Promise(resolve => { enteredHook = resolve; });
  const hold = new Promise(resolve => { releaseHook = resolve; });
  const f = await actualSupervisor(t, { beforePayload() { enteredHook(); return hold; } });
  const first = await f.send("request_active"); await entered;
  for (const delivery of ["follow-up", "steer"]) await assert.rejects(f.supervisor.send(f.sessionRef,
    { delivery, expectedOperationRef: first.operationRef, message: inputText, messageRequestId: `request_${delivery}` }, "revision_wire_fixture"), /provider-wire-queued-input-unsupported/);
  const aborted = f.supervisor.abort(f.sessionRef, first.operationRef, true); releaseHook(); await aborted;
  assert.equal(f.counts.wouldDispatch, 0); assert.equal(f.counts.fakeStreams, 1);
  assert.equal(fs.readFileSync(f.wireReceiptsPath, "utf8"), "");
});

test("wire event budget exhaustion cannot prevent the supervisor from stopping its host", { skip: !hostAvailable }, async t => {
  let releaseHook, enteredHook;
  const entered = new Promise(resolve => { enteredHook = resolve; }), hold = new Promise(resolve => { releaseHook = resolve; });
  const f = await actualSupervisor(t, { beforePayload() { enteredHook(); return hold; } });
  await f.supervisor.acquire(f.sessionRef);
  for (let index = 0; index < 511; index++) f.runtime.beginWireOperation({
    operationRef: `cancelled_operation_${index}`, messageRequestId: `cancelled_request_${index}`, inputText })("cancelled");
  const active = await f.send("request_budget_boundary"); await entered;
  const aborted = f.supervisor.abort(f.sessionRef, active.operationRef, true); releaseHook(); await aborted;
  assert.equal(f.counts.wouldDispatch, 0); assert.equal(f.supervisor.currentOperation(f.sessionRef), null);
});

test("actual first-call SDK writes a signed host receipt before dispatch without assistant history", { skip: !hostAvailable }, async t => {
  let f;
  f = await actualFixture(t, { manifest: true, persisted: true, afterPayload() {
    const rows = fs.readFileSync(f.wireReceiptsPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(verify(null, Buffer.from(rows[0].material), f.publicKey, Buffer.from(rows[0].signature, "base64")), true);
    assert.equal(f.counts.wouldDispatch, 0);
    assert.equal(f.manager.getBranch().some(entry => entry.type === "message" && entry.message?.role === "assistant"), false);
  } });
  f.begin(); await f.prompt();
  assert.equal(f.counts.fakeStreams, 1);
  assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
  assert.deepEqual(f.records.payloads, [expectedPayload]);
  const material = JSON.parse(JSON.parse(fs.readFileSync(f.wireReceiptsPath, "utf8")).material);
  assert.equal(material.operationRef, "operation_wire"); assert.equal(material.messageRequestId, "request_wire");
  assert.equal(material.sessionId, f.info.id); assert.equal(material.runtimeInstanceRef, "runtime_wire_fixture");
  assert.equal(material.taskId, null); assert.equal(material.taskRunId, null);
});

for (const [name, beforePayload] of [
  ["tail mutation", event => ({ ...event.payload, instructions: "late changed instructions" })],
  ["swallowed hook error", () => { throw new Error("fixture-hook-error"); }],
  ["wrong model", event => ({ ...event.payload, model: "wrong-model" })],
  ["wrong service tier", event => ({ ...event.payload, service_tier: "default" })]
]) test(`actual final callback rejects ${name} before fake dispatch`, { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t, { manifest: true, beforePayload });
  f.begin(); await f.prompt();
  assert.equal(f.counts.fakeStreams, 1); assert.equal(f.counts.wouldDispatch, 0);
  assert.equal(fs.readFileSync(f.wireReceiptsPath, "utf8"), "");
  assert.equal(f.records.errors.length, 1);
});

test("retained extension payload cannot mutate the detached admitted object", { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t, { manifest: true, afterPayload({ records }) { records.retained.instructions = "retained-object-mutation"; } });
  f.begin(); await f.prompt();
  assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
  assert.deepEqual(f.records.payloads, [expectedPayload]);
});

test("operation cancellation during final hooks invalidates its payload", { skip: !hostAvailable }, async t => {
  let cancel;
  const f = await actualFixture(t, { manifest: true, beforePayload() { cancel("operator-cancelled"); } });
  cancel = f.begin(); await f.prompt();
  assert.equal(f.counts.wouldDispatch, 0); assert.equal(fs.readFileSync(f.wireReceiptsPath, "utf8"), "");
});

test("a replaced operation cannot borrow the accepted input of its predecessor", { skip: !hostAvailable }, async t => {
  let f;
  f = await actualFixture(t, { manifest: true, beforePayload() {
    f.begin({ operationRef: "operation_replacement", messageRequestId: "request_replacement" });
  } });
  f.begin(); await f.prompt();
  assert.equal(f.counts.wouldDispatch, 0); assert.equal(fs.readFileSync(f.wireReceiptsPath, "utf8"), "");
});

test("SDK reload retires the old binding and preserves final guard installation", { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t, { manifest: true });
  const oldCancel = f.begin();
  await f.runtime.session.reload();
  f.begin({ operationRef: "operation_after_reload", messageRequestId: "request_after_reload" });
  oldCancel("late-old-cancel");
  await f.prompt();
  assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
  assert.equal(f.counts.fakeStreams, 1); assert.equal(f.counts.hostStarts, 1);
});

test("SDK session replacement revokes a retained old Agent callback", { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t, { manifest: true });
  f.begin(); const oldPayload = f.runtime.session.agent.onPayload;
  await f.runtime.newSession();
  await assert.rejects(oldPayload(clone(expectedPayload), { provider: "openai-codex", id: "gpt-5.6-luna" }), /provider-wire-session-stale/);
  f.begin({ operationRef: "operation_new_session", messageRequestId: "request_new_session" });
  await f.prompt();
  assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
});

test("nonempty signed journals fail closed without an approved resume checkpoint", { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t, { manifest: true });
  f.begin(); await f.prompt(); assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
  await assert.rejects(createProductionRuntimeFactory(f.factoryOptions)(f.info, "runtime_reopened", f.manager), /provider-wire-journal-replay-required/);
});

for (const mutation of ["permissions", "symlink", "prefix", "rotation"]) test(`journal ${mutation} change fails closed before dispatch`, { skip: !hostAvailable }, async t => {
  let f;
  f = await actualFixture(t, { manifest: true, beforePayload() {
    if (mutation === "permissions") fs.chmodSync(f.wireReceiptsPath, 0o644);
    if (mutation === "symlink") { fs.unlinkSync(f.wireReceiptsPath); fs.symlinkSync(path.join(f.root, "other.jsonl"), f.wireReceiptsPath); }
    if (mutation === "prefix") fs.writeFileSync(f.wireReceiptsPath, "forged-prefix\n");
    if (mutation === "rotation") fs.writeFileSync(`${f.wireReceiptsPath}.1`, "prior", { mode: 0o600 });
  } });
  f.begin(); await f.prompt(); assert.equal(f.counts.wouldDispatch, 0); assert.equal(f.records.errors.length, 1);
});

test("fsync failure leaves an unacknowledged receipt and prevents dispatch", { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t, { manifest: true });
  t.mock.method(fs, "fsyncSync", () => { throw new Error("fixture-fsync-failed"); });
  f.begin(); await f.prompt();
  assert.equal(f.counts.wouldDispatch, 0); assert.match(f.records.errors.join("\n"), /fixture-fsync-failed/);
  assert.equal(fs.readFileSync(f.wireReceiptsPath, "utf8").trim().split("\n").length, 1);
});

test("launcher environment pins private manifest and fresh signer before a first call", { skip: !hostAvailable }, async t => {
  const f = await actualFixture(t, { observeInputs: true }); await f.runtime.dispose();
  const supplied = f.writeEnvironment(), previous = Object.fromEntries(Object.keys(supplied).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, supplied);
    process.env.PIAGENT_WIRE_MANIFEST_SHA256 = "0".repeat(64);
    await assert.rejects(f.createRuntime(), /provider-wire-manifest-pin-mismatch/);
    process.env.PIAGENT_WIRE_MANIFEST_SHA256 = supplied.PIAGENT_WIRE_MANIFEST_SHA256;
    await f.createRuntime(); f.begin(); await f.prompt();
    assert.equal(f.counts.wouldDispatch, 1, f.records.errors.join("\n"));
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

for (const phase of ["before-final-guard", "after-durable-guard"]) test(`SIGKILL ${phase} preserves exact predispatch journal state`, { skip: !hostAvailable }, async t => {
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename], {
    env: { ...process.env, PIAGENT_WIRE_CRASH_PHASE: phase }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "", row;
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); if (row) fs.rmSync(row.root, { recursive: true, force: true }); });
  row = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`fixture child timeout: ${output}`)); }, 10_000);
    child.once("message", message => { clearTimeout(timeout); resolve(message); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`fixture child exited ${code}: ${output}`)); });
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGKILL"); assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
  const source = fs.readFileSync(row.receiptsPath, "utf8");
  if (phase === "before-final-guard") assert.equal(source, "");
  else {
    const envelope = JSON.parse(source), material = JSON.parse(envelope.material);
    const key = { key: Buffer.from(row.receiptPublicKey, "base64"), format: "der", type: "spki" };
    assert.equal(verify(null, Buffer.from(envelope.material), key, Buffer.from(envelope.signature, "base64")), true);
    assert.equal(material.sequence, 1); assert.equal(material.previousReceiptHash, null);
    assert.equal(material.messageRequestId, "request_wire");
  }
  assert.equal(row.counts.fakeStreams, 1); assert.equal(row.counts.wouldDispatch, 0); assert.equal(row.counts.realProviderCalls, 0);
  t.diagnostic(`WIRE_CRASH_METRICS ${JSON.stringify({ phase, ...row.counts, signal: "SIGKILL" })}`);
  t.diagnostic(`WIRE_CRASH_PROOF ${JSON.stringify({ phase, receiptPublicKey: row.receiptPublicKey, journal: source })}`);
});
} else {
  let f;
  const phase = process.env.PIAGENT_WIRE_CRASH_PHASE;
  const pause = () => {
    process.send({ root: f.root, receiptsPath: f.wireReceiptsPath, receiptPublicKey: f.manifest.receiptPublicKey, counts: f.counts });
    return new Promise(() => {});
  };
  f = await actualFixture({ after() {} }, { manifest: true, persisted: true,
    ...(phase === "before-final-guard" ? { beforePayload: pause } : { afterPayload: pause }) });
  f.begin(); await f.prompt();
}

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { isolatedContainerArguments, isolatedContainerConfigurationMatches, runIsolatedContract } from "../packages/piagent-core/extensions/acceptance-isolated-executor.js";
import { NODE_WORKER_VERSION, WORKER_VERSION, parseRequest, parseResponse } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { NODE_PROFILE_RUNTIME_IDENTITY, expectedNodeProfile, nodeProfileDigest } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { cancelOnContainerStart, createCancellationBarrier, dockerJson } from "./helpers/isolated-executor-barriers.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 60000 };
const value = (type, payload) => payload === undefined ? { type } : { type, value: payload };
const number = (payload) => value("number", payload);
const sourceRequest = (source, cases = [{ id: "one", args: [] }], exportName = "run") => JSON.stringify({ schemaVersion: 1, source, exportName, cases });
const nodeSourceRequest = (source, cases = [{ id: "one", args: [], invocation: { kind: "call" } }], exportName = "run") => JSON.stringify({
  schemaVersion: 2, profile: expectedNodeProfile(), source, exportName, cases
});
const run = (source, cases, options = {}) => runIsolatedContract({ requestText: sourceRequest(source, cases), imageId, dockerSocket, ...options });

test("isolated request protocol excludes answers, ambient paths, coercions, and unbounded inputs", () => {
  const good = JSON.parse(sourceRequest("export const run = x => x"));
  for (const mutation of [
    { ...good, expected: true }, { ...good, mounts: ["/"] }, { ...good, source: "x".repeat(128 * 1024 + 1) },
    { ...good, cases: [] }, { ...good, cases: [good.cases[0], good.cases[0]] },
    { ...good, cases: [{ id: "one", args: [], expected: true }] },
    { ...good, cases: [{ id: "one", args: [number("123")] }] },
    { ...good, cases: [{ id: "one", args: [value("undefined", 1)] }] },
    { ...good, cases: [{ id: "one", args: [{ type: "object", value: {} }] }] }
  ]) assert.throws(() => parseRequest(JSON.stringify(mutation)));
  assert.equal(parseRequest(JSON.stringify(good)).source, good.source);
});

test("container configuration is pinned, non-root, networkless, read-only, and bounded without mounts", () => {
  const args = isolatedContainerArguments(`sha256:${"a".repeat(64)}`, "a".repeat(36));
  for (const [flag, expected] of [["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"],
    ["--user", "65534:65534"], ["--pids-limit", "32"], ["--memory", "256m"], ["--memory-swap", "256m"]]) {
    assert.equal(args[args.indexOf(flag) + 1], expected);
  }
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("cpu=10:12"));
  assert.equal(args[args.indexOf("--pull") + 1], "never");
  for (const flag of ["--mount", "--volume", "-v", "--privileged", "--env-file", "--pid", "--entrypoint"]) assert.ok(!args.includes(flag));
  assert.throws(() => isolatedContainerArguments("node:latest", "a".repeat(36)));
});

test("actual container configuration is checked before any candidate starts", () => {
  const valid = { Config: { User: "65534:65534", WorkingDir: "/executor",
    Entrypoint: ["timeout", "--signal=KILL", "8s", "node", "--max-old-space-size=96", "/executor/worker.mjs"] },
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, Init: true,
      CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], PidsLimit: 32, Memory: 268435456, MemorySwap: 268435456,
      NanoCpus: 1e9, IpcMode: "private", Ulimits: [{ Name: "cpu", Soft: 10, Hard: 12 }, { Name: "nofile", Soft: 64, Hard: 64 }] }, Mounts: [] };
  assert.equal(isolatedContainerConfigurationMatches(valid), true);
  for (const [field, value] of [["NetworkMode", "host"], ["ReadonlyRootfs", false], ["Privileged", true], ["CapDrop", []],
    ["SecurityOpt", []], ["Memory", 0], ["PidsLimit", 0], ["IpcMode", "host"], ["PidMode", "host"], ["Ulimits", []]]) {
    assert.equal(isolatedContainerConfigurationMatches({ ...valid, HostConfig: { ...valid.HostConfig, [field]: value } }), false, field);
  }
  assert.equal(isolatedContainerConfigurationMatches({ ...valid, Mounts: [{ Source: "/" }] }), false);
  assert.equal(isolatedContainerConfigurationMatches({ ...valid, Config: { ...valid.Config, Entrypoint: ["node"] } }), false);
});

test("worker responses require exact request, complete ordered cases, and typed observations", () => {
  const text = sourceRequest("export const run = () => true");
  const request = parseRequest(text);
  const digest = createHash("sha256").update(text).digest("hex");
  const good = { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest: digest, status: "completed",
    cases: [{ id: "one", outcome: "return", value: value("boolean", true), dateArgsAfter: [], clockReads: 0 }] };
  assert.deepEqual(parseResponse(JSON.stringify(good), request, digest), good);
  for (const mutation of [
    { ...good, requestDigest: "0".repeat(64) }, { ...good, cases: [] },
    { ...good, cases: [{ ...good.cases[0], id: "other" }] },
    { ...good, cases: [{ ...good.cases[0], value: value("boolean", "true") }] },
    { ...good, cases: [{ ...good.cases[0], errorClass: "TypeError" }] },
    { ...good, cases: [{ ...good.cases[0], dateArgsAfter: undefined }] },
    { ...good, cases: [{ ...good.cases[0], resources: { caseCpuMicros: 1, caseThreadCpuMicros: 1, caseWallMicros: 1 } }] }
  ]) assert.throws(() => parseResponse(JSON.stringify(mutation), request, digest));
});

test("Node protocol v2 binds the pinned profile, typed backing stores, and receiver history before execution", () => {
  const typed = { type: "uint8array", value: { backingBase64: "WEFCWQ==", byteOffset: 1, byteLength: 2 } };
  const good = JSON.parse(nodeSourceRequest("export const run=x=>x", [{ id: "one", args: [typed], invocation: { kind: "call" } }]));
  assert.equal(parseRequest(JSON.stringify(good)).profile.digest, expectedNodeProfile().digest);
  for (const mutate of [
    value => { value.profile.digest = "0".repeat(64); }, value => { delete value.cases[0].invocation; },
    value => { value.cases[0].args[0].value.backingBase64 = "WEE"; }, value => { value.cases[0].args[0].value.backingBase64 = "WEE==="; },
    value => { value.cases[0].args[0].value.byteOffset = 4; }, value => { value.cases[0].args[0].value.extra = true; },
    value => { value.cases[0].args[0].type = "arraybuffer"; }, value => { value.cases[0].invocation = { kind: "method", receiverId: "cache", method: "get" }; }
  ]) { const value = structuredClone(good); mutate(value); assert.throws(() => parseRequest(JSON.stringify(value))); }
  const history = JSON.parse(nodeSourceRequest("export class C{set(){}get(){}}", [
    { id: "new", sequence: "s", args: [], invocation: { kind: "construct", receiverId: "cache" } },
    { id: "get", sequence: "s", args: [], invocation: { kind: "method", receiverId: "cache", method: "get" } }
  ], "C"));
  assert.equal(parseRequest(JSON.stringify(history)).cases.length, 2);
  history.cases[1].reset = true;
  assert.throws(() => parseRequest(JSON.stringify(history)));
  const legacy = JSON.parse(sourceRequest("export const run=x=>x", [{ id: "one", args: [typed] }]));
  assert.throws(() => parseRequest(JSON.stringify(legacy)));
});

test("Node profile digest changes with every pinned runtime and dependency identity", () => {
  const original = nodeProfileDigest();
  assert.equal(expectedNodeProfile().digest, original);
  for (const [field, changed] of [
    ["baseImageId", `sha256:${"0".repeat(64)}`], ["nodeBinarySha256", "0".repeat(64)],
    ["versionsSha256", "0".repeat(64)], ["buildConfigSha256", "0".repeat(64)],
    ["dependencyClosureSha256", "0".repeat(64)], ["dependencyFiles", NODE_PROFILE_RUNTIME_IDENTITY.dependencyFiles + 1]
  ]) assert.notEqual(nodeProfileDigest({ ...NODE_PROFILE_RUNTIME_IDENTITY, [field]: changed }), original, field);
});

test("Node response v2 requires exact traces, counters, profile binding, order, and final quiescence", () => {
  const text = nodeSourceRequest("export const run=()=>true"), request = parseRequest(text), requestDigest = createHash("sha256").update(text).digest("hex");
  const counters = { calls: 0, rawBytes: 0, textBytes: 0, decodersCreated: 0, timersScheduled: 0, denials: 0 };
  const good = { schemaVersion: 2, workerVersion: NODE_WORKER_VERSION, profileDigest: request.profile.digest, requestDigest, status: "completed",
    cases: [{ id: "one", outcome: "return", value: value("boolean", true), dateArgsAfter: [], clockReads: 0,
      invocationTrace: { kind: "call", exportName: "run", outcome: "return" }, services: counters }],
    services: counters, quiescence: { pendingTimers: 0, liveDecoders: 0, receivers: 0 } };
  assert.deepEqual(parseResponse(JSON.stringify(good), request, requestDigest), good);
  for (const mutate of [value => { value.profileDigest = "0".repeat(64); }, value => { delete value.cases[0].invocationTrace; },
    value => { value.cases[0].invocationTrace.exportName = "other"; }, value => { value.services = { ...value.services, calls: 1 }; },
    value => { value.quiescence.liveDecoders = 1; }, value => { value.workerVersion = WORKER_VERSION; }, value => { value.cases = []; }]) {
    const invalid = structuredClone(good); mutate(invalid); assert.throws(() => parseResponse(JSON.stringify(invalid), request, requestDigest));
  }
});

test("Node response v2 applies one 64 KiB typed-output budget across every case", () => {
  const typed = { type: "uint8array", value: { backingBase64: Buffer.alloc(4096).toString("base64"), byteOffset: 0, byteLength: 4096 } };
  const counters = { calls: 0, rawBytes: 0, textBytes: 0, decodersCreated: 0, timersScheduled: 0, denials: 0 };
  const fixture = count => {
    const cases = Array.from({ length: count }, (_, index) => ({ id: `typed-${index}`, args: [], invocation: { kind: "call" } }));
    const text = nodeSourceRequest("export const run=()=>new Uint8Array(4096)", cases), request = parseRequest(text);
    const requestDigest = createHash("sha256").update(text).digest("hex");
    const response = { schemaVersion: 2, workerVersion: NODE_WORKER_VERSION, profileDigest: request.profile.digest, requestDigest, status: "completed",
      cases: cases.map(item => ({ id: item.id, outcome: "return", value: typed, dateArgsAfter: [], clockReads: 0,
        invocationTrace: { kind: "call", exportName: "run", outcome: "return" }, services: counters })),
      services: counters, quiescence: { pendingTimers: 0, liveDecoders: 0, receivers: 0 } };
    return { text: JSON.stringify(response), request, requestDigest };
  };
  const atLimit = fixture(16);
  assert.equal(parseResponse(atLimit.text, atLimit.request, atLimit.requestDigest).cases.length, 16);
  const over = fixture(17);
  assert.throws(() => parseResponse(over.text, over.request, over.requestDigest), /Aggregate typed output budget exceeded/);
});

test("unavailable backend never falls back to host evaluation", async () => {
  const result = await runIsolatedContract({ requestText: sourceRequest("process.exit(42)"),
    imageId: `sha256:${"a".repeat(64)}`, dockerSocket: "/nonexistent/piagent-contract-test.sock" });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "local-backend-unavailable");
  assert.ok(!result.observation);
  for (const executionRunId of [true, "existing-container", "-".repeat(36)]) {
    await assert.rejects(runIsolatedContract({ requestText: sourceRequest("export const run=()=>true"), imageId: `sha256:${"a".repeat(64)}`,
      dockerSocket: "/nonexistent/piagent-contract-test.sock", executionRunId }), /Invalid isolated/);
  }
});

test("a cancelled Node-profile request never creates a worker and retains profile binding", integration, async () => {
  const profile = expectedNodeProfile(), requestText = nodeSourceRequest("export const run=()=>true");
  const result = await runIsolatedContract({ requestText, profile, imageId, dockerSocket, signal: AbortSignal.abort() });
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "cancelled-before-create");
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.profileDigest, profile.digest);
  assert.equal(Object.hasOwn(result, "observation"), false);
});

test("real Node worker stops the request when aggregate returned typed data exceeds 64 KiB", integration, async () => {
  const cases = Array.from({ length: 17 }, (_, index) => ({ id: `typed-${index}`, sequence: "one-session", args: [], invocation: { kind: "call" } }));
  const requestText = nodeSourceRequest("export const run=()=>new Uint8Array(4096)", cases);
  const result = await runIsolatedContract({ requestText, profile: expectedNodeProfile(), imageId, dockerSocket, timeoutMs: 30000 });
  assert.equal(result.status, "error", JSON.stringify(result));
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.observation.cases.slice(0, 16).map(item => item.outcome), Array(16).fill("return"));
  assert.equal(result.observation.cases[16].outcome, "error");
  assert.equal(result.observation.cases[16].reason, "guest-observation-failed");
});

test("versioned timeout causes cannot hide error cases or masquerade as a completed worker", () => {
  const text = sourceRequest("export const run = () => true"), request = parseRequest(text), digest = "diagnostic";
  const good = { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest: digest, status: "timeout",
    timeoutReason: "guest-cpu-budget", cases: [{ id: "one", outcome: "error", reason: "guest-cpu-budget",
      resources: { caseCpuMicros: 350000, caseThreadCpuMicros: 300000, caseWallMicros: 350000 } }] };
  assert.deepEqual(parseResponse(JSON.stringify(good), request, digest), good);
  const wall = { ...good, timeoutReason: "guest-wall-deadline", cases: [] };
  assert.deepEqual(parseResponse(JSON.stringify(wall), request, digest), wall);
  for (const invalid of [
    { ...good, workerVersion: "quickjs-contract-worker-v4" }, { ...good, workerVersion: "quickjs-contract-worker-v5" },
    { ...good, workerVersion: "quickjs-contract-worker-v6" }, { ...good, timeoutReason: undefined },
    { ...good, timeoutReason: "guest-wall-deadline" }, { ...good, status: "completed" },
    { ...good, status: "error" }, { ...good, cases: [] }, { ...wall, status: "error", timeoutReason: undefined },
    { ...good, status: "completed", timeoutReason: undefined }
  ]) assert.throws(() => parseResponse(JSON.stringify(invalid), request, digest));
  for (const resources of [undefined, {}, { caseCpuMicros: 299999, caseThreadCpuMicros: 10, caseWallMicros: 50000 },
    { caseCpuMicros: 300000, caseThreadCpuMicros: -1, caseWallMicros: 50000 },
    { caseCpuMicros: 300000, caseThreadCpuMicros: 10.5, caseWallMicros: 50000 },
    { caseCpuMicros: 300000, caseThreadCpuMicros: 10, caseWallMicros: Number.MAX_SAFE_INTEGER + 1 },
    { caseCpuMicros: 300000, caseThreadCpuMicros: 10, caseWallMicros: 50000, forged: true }]) {
    assert.throws(() => parseResponse(JSON.stringify({ ...good, cases: [{ ...good.cases[0], resources }] }), request, digest));
  }
});

test("a reused durable execution identity cannot start or remove an existing worker", integration, async (context) => {
  const executionRunId = randomUUID();
  const docker = (...args) => execFileSync("docker", ["--host", `unix://${dockerSocket}`, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  const id = docker(...isolatedContainerArguments(imageId, executionRunId));
  context.after(() => { docker("rm", "--force", id); });
  const result = await run("export const run = () => true", undefined, { executionRunId });
  assert.equal(result.status, "error"); assert.equal(result.reason, "reserved-execution-id-conflict");
  const [remaining] = JSON.parse(docker("inspect", id));
  assert.equal(remaining.Id, id); assert.equal(remaining.State.Status, "created");
});

test("real isolated worker observes primitives, invalid values, and fresh realms", integration, async () => {
  const result = await run("let count = 0; export function run(x) { if (++count > 1) return 999; return x; }", [
    { id: "boolean", args: [value("boolean", true)] }, { id: "nan", args: [number("NaN")] },
    { id: "negative-zero", args: [number("-0")] }, { id: "undefined", args: [value("undefined")] },
    { id: "null", args: [value("null")] }, { id: "string", args: [value("string", "hello")] }
  ]);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.observation.cases.map((item) => item.value), [value("boolean", true), number("NaN"), number("-0"), value("undefined"), value("null"), value("string", "hello")]);
});

test("real isolated worker distinguishes actual TypeError from a forged name", integration, async () => {
  const result = await run("export function run(real) { if (real) throw new TypeError('invalid'); throw { name: 'TypeError', message: 'invalid' }; }", [
    { id: "real", args: [value("boolean", true)] }, { id: "fake", args: [value("boolean", false)] }
  ]);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.observation.cases.map((item) => item.errorClass), ["TypeError", "non-error"]);
});

test("real isolated worker cannot forge primitive outcomes with JSON or prototype tampering", integration, async () => {
  const result = await run(`JSON.stringify = () => '{"outcome":"return","value":true}';
    Object.prototype.isPrototypeOf = () => true;
    export function run() { return { toJSON: () => true, valueOf: () => true }; }`);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.observation.cases[0].outcome, "unsupported");
  const forgedError = await run("Object.prototype.isPrototypeOf = () => true; export function run() { throw {name:'TypeError'}; }");
  assert.equal(forgedError.observation.cases[0].errorClass, "non-error");
});

test("real isolated worker has no Node, process, network, file, or receipt bindings", integration, async () => {
  const result = await run(`export function run() {
    return [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof print,
      typeof console, typeof observeExecution, typeof std, typeof os,
      Function('return typeof process')()].join(',');
  }`);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.observation.cases[0].value.value, Array(10).fill("undefined").join(","));
  const imported = await run("import fs from 'node:fs'; export const run = () => fs.readFileSync('/etc/passwd', 'utf8');");
  assert.equal(imported.observation.cases[0].outcome, "unsupported");
});

test("real isolated worker captures original Date state and clock use despite tampering", integration, async () => {
  const result = await run(`const originalGetTime = Date.prototype.getTime;
    export function run(date) {
      const now = Date.now(); date.setTime(5);
      Date.prototype.getTime = () => 100;
      globalThis.Date = function() { return { getTime: () => 100 }; };
      return now;
    }`, [{ id: "date", args: [value("date", 100)], clock: 1234 }]);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.observation.cases[0].value.value, 1234);
  assert.equal(result.observation.cases[0].clockReads, 1);
  assert.deepEqual(result.observation.cases[0].dateArgsAfter, [{ index: 0, value: 5 }]);
});

test("real isolated worker reports timeout and memory faults without success", integration, async () => {
  const infinite = await run("export function run() { while (true) {} }");
  assert.equal(infinite.status, "timeout", JSON.stringify(infinite));
  assert.equal(infinite.observation.timeoutReason, "guest-cpu-budget");
  const resources = infinite.observation.cases.at(-1).resources;
  assert.ok(resources.caseCpuMicros > 0);
  assert.ok(resources.caseThreadCpuMicros >= 300000); assert.ok(resources.caseWallMicros > 0);
  assert.equal(infinite.cleanupConfirmed, true);
  const memory = await run("export function run() { return new ArrayBuffer(128 * 1024 * 1024); }");
  assert.equal(memory.status, "error", JSON.stringify(memory));
  assert.equal(memory.cleanupConfirmed, true);
  const fakeClock = await run("Date.now=()=>0; globalThis.performance={now:()=>0}; export function run(){ while(true){} }");
  assert.equal(fakeClock.status, "timeout", JSON.stringify(fakeClock));
  assert.equal(fakeClock.observation.timeoutReason, "guest-cpu-budget");
  const initialization = await run("while (true) {} export function run() { return true; }");
  assert.equal(initialization.status, "timeout", JSON.stringify(initialization));
  assert.ok(initialization.observation.cases.at(-1).resources.caseThreadCpuMicros >= 300000);
  assert.equal(initialization.cleanupConfirmed, true);
});

test("outer deadline and cancellation remove only the run-owned container", integration, async () => {
  const timed = await run("export function run() { while (true) {} }", undefined, { timeoutMs: 25 });
  assert.equal(timed.status, "timeout", JSON.stringify(timed));
  assert.equal(timed.cleanupConfirmed, true);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await run("export const run = () => true", undefined, { signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  const ids = execFileSync("docker", ["--host", `unix://${dockerSocket}`, "ps", "--all", "--quiet", "--filter", `label=io.piagent.contract-execution=${timed.runId}`], { encoding: "utf8" });
  assert.equal(ids.trim(), "");
});

test("pathological native operations stay bounded", integration, async (context) => {
  const started = Date.now();
  const pathological = await run("export function run() { return /^(a+)+$/.test('a'.repeat(100) + '!'); }", undefined, { timeoutMs: 12000 });
  assert.ok(["timeout", "error"].includes(pathological.status), JSON.stringify(pathological));
  assert.equal(pathological.cleanupConfirmed, true);
  context.diagnostic(`pathological regex stopped in ${Date.now() - started}ms: ${pathological.reason ?? pathological.status}`);
});

test("in-flight cancellation follows the exact daemon START event and confirms removal", integration, async (context) => {
  const executionRunId = randomUUID();
  const controller = new AbortController();
  const watched = await cancelOnContainerStart(context, { dockerSocket, runId: executionRunId, controller });
  const cancelled = await run("export function run() { while (true) {} }", undefined, { executionRunId, signal: controller.signal });
  assert.equal(watched.error, null); assert.ok(watched.event, "cancellation requires a real START, not elapsed time");
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.cleanupConfirmed, true);
  assert.equal((await dockerJson(dockerSocket, "GET", `/containers/${watched.event.Actor.ID}/json`)).status, 404);
});

for (const phase of ["before-forward", "after-create"]) {
  test(`CREATE cancellation at ${phase} preserves honest ownership and cleanup evidence`, integration, async (context) => {
    const executionRunId = randomUUID(), controller = new AbortController();
    const { socketPath, state } = await createCancellationBarrier(context, { dockerSocket, runId: executionRunId, imageId, phase, controller });
    const result = await run("export const run=()=>true", undefined, { dockerSocket: socketPath, executionRunId, signal: controller.signal });
    assert.equal(state.phaseReached, true); assert.deepEqual(state.errors, []); assert.equal(state.startRequests, 0);
    assert.equal(result.observation, undefined);
    if (phase === "before-forward") {
      assert.equal(state.createdId, null); assert.equal(result.status, "error");
      assert.equal(result.reason, "container-create-failed");
      assert.equal(result.cleanupConfirmed, false, "the host cannot infer that an interrupted remote CREATE had no effect");
    } else {
      assert.match(state.createdId, /^[a-f0-9]{64}$/); assert.equal(result.status, "cancelled");
      assert.equal(result.reason, "container-create-incomplete"); assert.equal(result.cleanupConfirmed, true);
    }
    assert.equal((await dockerJson(dockerSocket, "GET", `/containers/piagent-contract-${executionRunId}/json`)).status, 404);
  });
}

test("a delayed CREATE can outlive the cancelled CLI without becoming confirmed cleanup or a retry", integration, async (context) => {
  const executionRunId = randomUUID(), controller = new AbortController();
  const barrier = await createCancellationBarrier(context, { dockerSocket, runId: executionRunId, imageId, phase: "after-host-settled", controller });
  const result = await run("export const run=()=>true", undefined, { dockerSocket: barrier.socketPath, executionRunId, signal: controller.signal });
  assert.equal(barrier.state.phaseReached, true); assert.deepEqual(barrier.state.errors, []);
  assert.equal(result.status, "error"); assert.equal(result.cleanupConfirmed, false); assert.equal(result.observation, undefined);
  assert.equal((await dockerJson(dockerSocket, "GET", `/containers/piagent-contract-${executionRunId}/json`)).status, 404);
  const id = await barrier.releaseDelayedCreate();
  const late = await dockerJson(dockerSocket, "GET", `/containers/${id}/json`);
  assert.equal(late.status, 200); assert.equal(late.body.Id, id); assert.equal(late.body.State.Status, "created");
  assert.equal(late.body.Image, imageId); assert.equal(late.body.Config.Labels["io.piagent.contract-execution"], executionRunId);
  assert.equal(isolatedContainerConfigurationMatches(late.body), true);
  const retry = await run("export const run=()=>true", undefined, { executionRunId });
  assert.equal(retry.reason, "reserved-execution-id-conflict"); assert.equal(retry.cleanupConfirmed, false);
  assert.equal((await dockerJson(dockerSocket, "GET", `/containers/${id}/json`)).body.State.Status, "created");
  assert.equal(barrier.state.startRequests, 0);
  assert.equal((await dockerJson(dockerSocket, "DELETE", `/containers/${id}?force=true`)).status, 204);
  assert.equal((await dockerJson(dockerSocket, "GET", `/containers/${id}/json`)).status, 404);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHostWireSession, observeHostWireInput, HOST_WIRE_PHASE_EDGES, TrajectoryRuntime } from "../packages/piagent-core/runtime/trajectory/trajectory-runtime.ts";
import { createTrajectoryState, reduceTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { trajectoryStatePath } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";
import { buildOpenAiCodexWireFingerprint } from "../packages/piagent-core/runtime/model/provider-wire-fingerprint.ts";
import { buildBenchmarkPhaseWireEvidence } from "../packages/piagent-core/benchmark/benchmark-provider-wire.js";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const text = "Inspect a public fixture and plan the change.";
const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
const payload = { model: model.id, instructions: "Pinned public fixture", tools: [], input: [],
  reasoning: { effort: "medium" }, text: { verbosity: "low" }, tool_choice: "auto", service_tier: "priority" };
const taskFixture = JSON.parse(fs.readFileSync(new URL("../evals/fixtures/task-contract.valid.json", import.meta.url), "utf8"));

function fixture(t, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "host-wire-trajectory-")), sessionId = crypto.randomUUID();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const fingerprint = buildOpenAiCodexWireFingerprint({ payload, provider: model.provider, modelId: model.id, workingDirectory: cwd });
  const manifest = { schemaVersion: 1, protocol: "phase-valid-configuration-v1", source: "pinned-host-definitions",
    candidateDigest: "1".repeat(64), configurationDigest: "2".repeat(64), definitionDigest: "3".repeat(64),
    workingDirectory: cwd, model: `${model.provider}/${model.id}`, thinking: "medium", requestedTier: "fast", requestTier: "priority",
    pins: [{ path: path.resolve(import.meta.dirname, "host-wire-trajectory.test.mjs"), sha256: "4".repeat(64) }],
    receiptPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), allowedEdges: structuredClone(HOST_WIRE_PHASE_EDGES),
    states: [null, ...Object.keys(HOST_WIRE_PHASE_EDGES)].map((phase) => ({ id: phase ?? "pre-task", phase,
      taskPresence: phase === null ? "none" : "current", operatorInputHash: sha(text), inputHash: sha(text), selectedTools: [], fingerprint })) };
  const records = [];
  const options = { cwd, sessionId, runtimeInstanceRef: crypto.randomUUID(), manifest,
    signReceipt: (material) => crypto.sign(null, Buffer.from(material), privateKey).toString("base64"),
    record: async (envelope) => { records.push(envelope); }, ...overrides };
  const handle = createHostWireSession(options);
  t.after(() => { handle.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const operations = [];
  const begin = () => {
    const identity = { operationRef: crypto.randomUUID(), messageRequestId: crypto.randomUUID(), inputText: text };
    operations.push({ operationRef: identity.operationRef, messageRequestId: identity.messageRequestId, operatorInputHash: sha(text) });
    return handle.beginOperation(identity);
  };
  const accept = () => observeHostWireInput(cwd, sessionId, { turnId: crypto.randomUUID(), promptHash: sha(text), text, source: "rpc", hasImages: false });
  const send = (changes = {}) => handle.validatePayload({ payload: structuredClone(payload), model, hookErrors: 0, ...changes });
  const expected = { manifestDigest: sha(JSON.stringify(manifest)), candidateDigest: manifest.candidateDigest,
    configurationDigest: manifest.configurationDigest, definitionDigest: manifest.definitionDigest, workingDirectory: cwd,
    sessionId, runtimeInstanceRef: options.runtimeInstanceRef, operations };
  const reduce = (overrides = {}) => buildBenchmarkPhaseWireEvidence({ manifest, receipts: records, expected,
    expectedReceiptCount: records.length, trajectoryPolicy: { create: createTrajectoryState, reduce: reduceTrajectory }, ...overrides });
  return { cwd, sessionId, manifest, records, options, handle, begin, accept, send, expected, reduce };
}

test("actual trajectory transitions and exact host input are signed before a payload is admitted", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime();
  f.begin(); f.accept();
  runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state", observedAt: "2026-08-08T00:00:00.000Z" });
  await f.send();
  current.workPlan[0].status = "in-progress";
  runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state", observedAt: "2026-08-08T00:00:01.000Z" });
  await f.send();
  assert.equal(f.records.length, 2);
  const first = JSON.parse(f.records[0].material), second = JSON.parse(f.records[1].material);
  assert.equal(first.phase, "intake"); assert.equal(second.phase, "plan");
  assert.equal(first.events[0].type, "operation-accepted");
  assert.ok(first.events.some((e) => e.type === "task-attached"));
  assert.equal(second.events[0].event.cause, "plan-observed");
  assert.equal(second.events[0].event.sequence, 1);
  assert.equal(second.previousReceiptHash, sha(JSON.stringify(f.records[0])));
  assert.equal(second.sequence, 2);
  assert.equal(f.reduce().passed, true);
  assert.ok(crypto.verify(null, Buffer.from(f.records[1].material),
    crypto.createPublicKey({ key: Buffer.from(f.manifest.receiptPublicKey, "base64"), format: "der", type: "spki" }),
    Buffer.from(f.records[1].signature, "base64")));
});

test("known endpoint hashes cannot stand in for a current accepted input", async (t) => {
  const f = fixture(t); f.begin(); await assert.rejects(f.send(), /payload-without-current-input/); assert.equal(f.records.length, 0);
});

test("identical text requires distinct operator admission and request identity", async (t) => {
  const f = fixture(t), close = f.begin(); f.accept(); await f.send(); close("completed");
  f.begin(); f.accept(); await f.send();
  const [first, second] = f.records.map((record) => JSON.parse(record.material));
  assert.equal(first.inputHash, second.inputHash); assert.notEqual(first.messageRequestId, second.messageRequestId);
  assert.notEqual(first.turnId, second.turnId); assert.notEqual(first.operationRef, second.operationRef);
  assert.equal(f.reduce().passed, true);
});

test("unadmitted replacement input and cross-session input never acquire authority", async (t) => {
  const f = fixture(t); f.begin();
  observeHostWireInput(f.cwd, "another-session", { turnId: "wrong", promptHash: sha(text), text, source: "rpc", hasImages: false });
  await assert.rejects(f.send(), /payload-without-current-input/); assert.equal(f.records.length, 0);
});

test("unfrozen or attached images cannot enter a text-only input manifest", async (t) => {
  for (const hasImages of [true, undefined]) {
    const f = fixture(t); f.begin();
    assert.throws(() => observeHostWireInput(f.cwd, f.sessionId, { turnId: "turn", promptHash: sha(text), text,
      source: "rpc", hasImages }), /input-images-unprojected/);
    await assert.rejects(f.send(), /input-images-unprojected/); assert.equal(f.records.length, 0);
  }
});

test("copied serialized trajectory state cannot bootstrap a live attachment", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime();
  runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state", observedAt: "2026-08-08T00:00:00.000Z" });
  f.begin(); f.accept();
  assert.throws(() => runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "agent-start" }), /task-attachment-unproven/);
  await assert.rejects(f.send(), /trajectory-sync-failed/); assert.equal(f.records.length, 0);
});

test("corrupt trajectory storage revokes prior live phase evidence", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime();
  f.begin(); f.accept(); runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" }); await f.send();
  fs.writeFileSync(trajectoryStatePath(f.cwd, current.taskRunId), "{corrupt");
  assert.equal(runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "agent-start" }).enforcementSafe, false);
  await assert.rejects(f.send(), /trajectory-store-corrupt/); assert.equal(f.records.length, 1);
});

test("a pending task cannot be replaced by a different task with plausible phase endpoints", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime(); f.begin(); f.accept();
  runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" });
  const replacement = { ...current, taskId: "replacement", taskRunId: "replacement-run" };
  assert.throws(() => runtime.sync(f.cwd, f.sessionId, replacement, { sourceHook: "task-state" }), /pending-task-replaced/);
  await assert.rejects(f.send(), /trajectory-sync-failed/);
});

test("signature mismatch and persistence failure cannot admit a payload", async (t) => {
  const f = fixture(t, { signReceipt: () => Buffer.alloc(64).toString("base64") }); f.begin(); f.accept();
  await assert.rejects(f.send(), /receipt-signature-invalid/); assert.equal(f.records.length, 0);
  const g = fixture(t, { record: async () => { throw new Error("disk-full-fixture"); } }); g.begin(); g.accept();
  await assert.rejects(g.send(), /disk-full-fixture/); await assert.rejects(g.send(), /receipt-not-durable/);
});

test("cancellation during durable acknowledgement makes the response ineligible", async (t) => {
  let finish;
  const f = fixture(t, { record: () => new Promise((resolve) => { finish = resolve; }) });
  const close = f.begin(); f.accept(); const pending = f.send(); close("cancelled"); finish();
  await assert.rejects(pending, /payload-binding-superseded/);
});

test("disposing an old generation cannot clear its replacement", async (t) => {
  const f = fixture(t); f.handle.dispose();
  const replacement = createHostWireSession({ ...f.options, runtimeInstanceRef: "generation-two" });
  t.after(() => replacement.dispose()); f.handle.dispose();
  replacement.beginOperation({ operationRef: "op", messageRequestId: "req", inputText: text }); f.accept();
  await replacement.validatePayload({ payload, model, hookErrors: 0 });
  assert.equal(JSON.parse(f.records[0].material).runtimeInstanceRef, "generation-two");
});

test("manifest, model, tier and extension failures remain hard blocks", async (t) => {
  for (const change of [{ model: { ...model, id: "gpt-5.6-sol" } }, { payload: { ...payload, service_tier: "default" } }, { hookErrors: 1 }]) {
    const f = fixture(t); f.begin(); f.accept(); await assert.rejects(f.send(change), /host-wire-/); assert.equal(f.records.length, 0);
  }
  assert.throws(() => HOST_WIRE_PHASE_EDGES.intake.push("repair"), TypeError);
});

test("a caught transition write failure cannot admit the cached prior phase", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime();
  f.begin(); f.accept(); runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" }); await f.send();
  current.workPlan[0].status = "in-progress";
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(target).includes("/trajectory/") && String(target).endsWith(".json")) throw new Error("fixture-state-publish-failed");
    return rename(source, target);
  };
  try { assert.throws(() => runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" }), /fixture-state-publish-failed/); }
  finally { fs.renameSync = rename; }
  await assert.rejects(f.send(), /trajectory-sync-failed/); assert.equal(f.records.length, 1);
});

test("trajectory corruption between host sync and final payload is rejected without another sync", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime();
  f.begin(); f.accept(); runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" });
  fs.writeFileSync(trajectoryStatePath(f.cwd, current.taskRunId), "{corrupt");
  await assert.rejects(f.send(), /trajectory-custody-changed/); assert.equal(f.records.length, 0);
});

test("a TaskContract belonging to another session cannot acquire a current-session signature", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: "another-session" }, runtime = new TrajectoryRuntime();
  f.begin(); f.accept();
  assert.throws(() => runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" }), /task-identity-mismatch/);
  await assert.rejects(f.send(), /trajectory-sync-failed/); assert.equal(f.records.length, 0);
});

test("trajectory corruption during receipt acknowledgement cannot authorize dispatch", async (t) => {
  let finish;
  const f = fixture(t, { record: () => new Promise(resolve => { finish = resolve; }) });
  const current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime();
  f.begin(); f.accept(); runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" });
  const pending = f.send(); fs.writeFileSync(trajectoryStatePath(f.cwd, current.taskRunId), "{corrupt"); finish();
  await assert.rejects(pending, /trajectory-custody-changed/);
});

test("signed request evidence needs independent host identity and cannot prove dispatch or usage", async (t) => {
  const f = fixture(t); f.begin(); f.accept(); await f.send();
  assert.equal(f.reduce().passed, true);
  assert.equal(f.reduce().provesAdmission, false); assert.equal(f.reduce().provesProviderDispatch, false); assert.equal(f.reduce().provesUsage, false);
  assert.equal(f.reduce({ expected: undefined }).state, "unavailable");
  assert.equal(f.reduce({ trajectoryPolicy: undefined }).state, "unavailable");
  assert.equal(f.reduce({ expected: { ...f.expected, runtimeInstanceRef: "wrong-runtime" } }).passed, false);
  assert.equal(f.reduce({ expected: { ...f.expected, sessionId: "wrong-session" } }).passed, false);
  assert.equal(f.reduce({ expected: { ...f.expected, manifestDigest: "f".repeat(64) } }).passed, false);
  assert.equal(f.reduce({ expectedReceiptCount: 2 }).passed, false);
  assert.equal(f.reduce({ telemetryTruncated: true }).passed, false);
});

test("forged, replayed and reordered signed receipts cannot pass the phase reducer", async (t) => {
  const f = fixture(t); f.begin(); f.accept(); await f.send(); await f.send();
  assert.equal(f.reduce().passed, true);
  const forged = structuredClone(f.records); forged[0].signature = Buffer.alloc(64).toString("base64");
  assert.equal(f.reduce({ receipts: forged }).reason, "signature-invalid");
  assert.equal(f.reduce({ receipts: [f.records[1], f.records[0]] }).reason, "receipt-order-invalid");
  assert.equal(f.reduce({ receipts: [f.records[0], f.records[0]] }).reason, "receipt-order-invalid");
});

test("even signed endpoint rows require the exact host cause and input admission order", async (t) => {
  const f = fixture(t), current = { ...structuredClone(taskFixture), sessionId: f.sessionId }, runtime = new TrajectoryRuntime();
  f.begin(); f.accept(); runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" });
  current.workPlan[0].status = "in-progress"; runtime.sync(f.cwd, f.sessionId, current, { sourceHook: "task-state" }); await f.send();
  assert.equal(f.reduce().passed, true);
  const mutate = fn => {
    const row = JSON.parse(f.records[0].material); fn(row);
    const material = JSON.stringify(row); return [{ material, signature: f.options.signReceipt(material) }];
  };
  assert.equal(f.reduce({ receipts: mutate(row => { row.events.reverse(); }) }).passed, false);
  assert.equal(f.reduce({ receipts: mutate(row => { row.events.find(e => e.type === "phase-transition").event.cause = "mutation-observed"; }) }).passed, false);
  assert.equal(f.reduce({ receipts: mutate(row => { row.events = row.events.filter(e => e.type !== "task-attached"); }) }).passed, false);
  assert.equal(f.reduce({ receipts: mutate(row => { row.messageRequestId = "another-request"; }) }).passed, false);
  assert.equal(f.reduce({ receipts: mutate(row => { row.fingerprint.instructionsHash = "f".repeat(64); }) }).passed, false);
});

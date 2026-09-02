import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createOfflineAblationPlan, offlineAblationAccounting, runOfflineCandidateAblation } from "../scripts/benchmark-candidate-ablation.mjs";
import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { fakeProvider, fixture } from "./fixtures/benchmark-candidate-ablation-fake.mjs";

const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function setup(t, options) {
  const root = fs.mkdtempSync(path.join(process.env.PIAGENT_ABLATION_TEST_TMP ?? os.tmpdir(), "ablation-"));
  t.after(() => { if (!process.env.PIAGENT_ABLATION_KEEP_EVIDENCE) fs.rmSync(root, { recursive: true, force: true }); });
  return fixture(root, options);
}
function reconcile(value, usage = null) {
  const manifest = read(path.join(value.runRoot, "run-manifest.json"));
  const active = manifest.active;
  const file = path.join(value.root, "reconciliation.json");
  fs.writeFileSync(file, JSON.stringify({ kind: "offline-interruption-reconciliation-v1", planDigest: manifest.planDigest,
    coordinate: active.coordinate, attemptId: active.attemptId, usage: usage ?? active.usage,
    terminalReason: "Confirmed synthetic interrupted attempt; no quality claim" }));
  return file;
}

test("54 locked real-surface coordinates reuse the single-session runner with no cross-arm home/cache", async t => {
  const value = setup(t);
  const calls = [];
  const fake = fakeProvider({ onDispatch: call => calls.push(call) });
  const result = await runOfflineCandidateAblation({ ...value, fakeProvider: fake });
  assert.equal(result.status, "offline-proof-complete");
  assert.equal(result.rows, 54);
  assert.equal(result.accounting.knownFresh, 540);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.providerDispatchAllowed, false);
  assert.equal(calls.length, 54);
  assert.equal(new Set(calls.map(call => call.home)).size, 54);
  const rows = inspectBenchmarkLedger(path.join(value.runRoot, "runs.jsonl")).records;
  assert.equal(new Set(rows.map(row => row.attemptId)).size, 54);
  assert.equal(new Set(rows.map(row => row.record.sessionId)).size, 54);
  assert.equal(new Set(rows.map(row => row.coordinate.armRunId)).size, 2);
  for (let index = 0; index < rows.length; index += 2) {
    assert.equal(rows[index].coordinate.scenarioId, rows[index + 1].coordinate.scenarioId);
    assert.notEqual(rows[index].coordinate.armId, rows[index + 1].coordinate.armId);
    assert.equal(rows[index].record.variant.fixtureDigest, rows[index + 1].record.variant.fixtureDigest);
    assert.notEqual(rows[index].coordinate.candidateDigest, rows[index + 1].coordinate.candidateDigest);
    assert.equal(rows[index].coordinate.armId, index % 4 ? "test-treatment" : "test-control");
  }
  for (const row of rows) assert.deepEqual(row.transitions.map(event => event.state), ["planned", "dispatched", "returned", "verified", "sealed"]);
  const resumed = await runOfflineCandidateAblation({ ...value, fakeProvider: fake });
  assert.equal(resumed.rows, 54);
  assert.equal(calls.length, 54, "sealed coordinates never dispatch again");
  assert.equal(read(path.join(value.runRoot, "stop-acknowledgment.json")).activeState, null);
});

test("reject fake surface, duplicate coordinate, wrong model, and undeclared live-provider seams", async t => {
  const value = setup(t);
  const rejects = [
    plan => { plan.arms[0].surface = "raw-pi"; },
    plan => { plan.suite.scenarios[1].id = plan.suite.scenarios[0].id; },
    plan => { plan.execution.model = "other-model"; },
    plan => { plan.providerDispatchAllowed = true; },
    plan => { plan.order.reverse(); }
  ];
  for (const mutate of rejects) {
    const plan = structuredClone(value.plan); mutate(plan);
    await assert.rejects(runOfflineCandidateAblation({ ...value, plan, fakeProvider: fakeProvider() }));
  }
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: { kind: "live" } }), /fake-provider seams/);
  assert.throws(() => createOfflineAblationPlan({ ...value.plan, arms: value.plan.arms.map((a, i) => ({ ...a, armId: i ? "B" : "A" })) }), /exact baseline/);
});

for (const drift of ["source", "head", "config", "fixture", "evaluator"]) test(`${drift} drift fails closed before any fake dispatch`, async t => {
  const value = setup(t);
  if (drift === "source") fs.appendFileSync(path.join(value.plan.arms[0].packageRoot, "source.txt"), "drift");
  if (drift === "head") spawnSync("git", ["-C", value.plan.arms[0].packageRoot, "-c", "user.name=Offline", "-c", "user.email=offline@example.invalid", "commit", "--allow-empty", "-qm", "new head"]);
  if (drift === "config") fs.appendFileSync(value.plan.arms[0].configurationFile, " ");
  if (drift === "fixture") fs.appendFileSync(path.join(value.plan.suiteRoot, "project", "package.json"), " ");
  if (drift === "evaluator") fs.appendFileSync(path.join(value.plan.suiteRoot, "grade.mjs"), "// drift\n");
  let calls = 0;
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider({ onDispatch: () => calls++ }) }), /drift/);
  assert.equal(calls, 0);
});

test("post-return drift preserves usage and refuses verification or later dispatch", async t => {
  const value = setup(t);
  let calls = 0;
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider({ onDispatch: () => calls++ }), checkpoint: stage => {
    if (stage === "returned") fs.appendFileSync(value.plan.arms[0].configurationFile, " ");
  } }), /configuration drift/);
  const manifest = read(path.join(value.runRoot, "run-manifest.json"));
  assert.equal(manifest.active.state, "returned");
  assert.equal(manifest.active.usage.fresh, 10);
  assert.equal(calls, 1);
  assert.equal(offlineAblationAccounting(value.plan, [], manifest.active).knownFresh, 10);
});

test("duplicate provider session across Pi WebUI arms is rejected with both costs retained", async t => {
  const value = setup(t);
  for (const scenario of value.plan.suite.scenarios) scenario.userJourney = { turns: [{ id: "first", prompt: "prompt.md" }], expectedTerminalSettlement: "completed" };
  let calls = 0;
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider({ duplicateSessionId: true, onDispatch: () => calls++ }) }), /provider session reused/);
  assert.equal(calls, 2);
  const manifest = read(path.join(value.runRoot, "run-manifest.json"));
  const rows = inspectBenchmarkLedger(path.join(value.runRoot, "runs.jsonl")).records;
  assert.equal(rows.length, 1);
  assert.equal(offlineAblationAccounting(value.plan, rows, manifest.active).knownFresh, 20);
});

test("a partial usage receipt remains unknown and its lower bound and reservation are retained", t => {
  const value = setup(t);
  const active = { state: "returned", usage: { usageCompleteness: "partial", fresh: 20000 } };
  const result = offlineAblationAccounting(value.plan, [], active);
  assert.equal(result.knownFreshLowerBound, 20000);
  assert.equal(result.unknownAttempts, 1);
  assert.equal(result.reservedFresh, 100000);
  assert.equal(result.admitted, false);
});

for (const stage of ["planned", "dispatched", "returned", "verified", "ledger-appended", "sealed"]) test(`SIGKILL at ${stage}: durable resume without blind replay`, async t => {
  const value = setup(t);
  const planFile = path.join(value.root, "plan.json"); fs.writeFileSync(planFile, JSON.stringify(value.plan));
  const killed = spawnSync(process.execPath, [path.join(import.meta.dirname, "fixtures", "benchmark-candidate-ablation-fake.mjs"), "--crash-worker", planFile, value.runRoot, stage], { encoding: "utf8", timeout: 30000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  let calls = 0;
  const fake = fakeProvider({ onDispatch: () => calls++ });
  let reconciliation;
  if (["dispatched", "returned"].includes(stage)) {
    await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fake }), /requires reconciliation/);
    assert.equal(calls, 0);
    const manifest = read(path.join(value.runRoot, "run-manifest.json"));
    const accounting = offlineAblationAccounting(value.plan, [], manifest.active);
    if (stage === "dispatched") {
      assert.equal(accounting.unknownAttempts, 1);
      assert.equal(accounting.reservedFresh, 100000);
      assert.equal(accounting.admitted, false);
    } else assert.equal(accounting.knownFresh, 10);
    const usage = stage === "dispatched" ? { usageCompleteness: "exact", sessions: 1, input: 15, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 1, fresh: 17, total: 20 } : null;
    reconciliation = reconcile(value, usage);
  }
  const result = await runOfflineCandidateAblation({ ...value, fakeProvider: fake, reconciliation,
    stopRequested: () => inspectBenchmarkLedger(path.join(value.runRoot, "runs.jsonl")).records.length >= 2 });
  assert.equal(result.rows, 2);
  assert.equal(calls, stage === "planned" ? 2 : 1);
  assert.equal(result.accounting.knownFresh, stage === "dispatched" ? 27 : 20);
  if (reconciliation) assert.equal(inspectBenchmarkLedger(path.join(value.runRoot, "runs.jsonl")).records[0].resolved, false);
});

test("a second worker cannot own the campaign and replaced lock is not removed", async t => {
  const value = setup(t);
  fs.mkdirSync(value.runRoot);
  const release = acquireBenchmarkRunLock(value.runRoot, value.plan.runId);
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider() }), /locked/);
  release();
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider(), checkpoint: stage => {
    if (stage === "planned") {
      const lock = path.join(value.runRoot, ".benchmark-run.lock");
      fs.renameSync(lock, `${lock}.original`); fs.writeFileSync(lock, '{"replacement":true}');
    }
  } }), /lock owner changed/);
  assert.equal(read(path.join(value.runRoot, ".benchmark-run.lock")).replacement, true);
});

test("management reservation blocks admission and records rather than hides overshoot", async t => {
  const value = setup(t, { budget: { maxFreshTokens: 20, reserveFreshPerSession: 10 } });
  let calls = 0;
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider({ input: 23, onDispatch: () => calls++ }) }), /budget admission denied/);
  assert.equal(calls, 1);
  const rows = inspectBenchmarkLedger(path.join(value.runRoot, "runs.jsonl")).records;
  const accounting = offlineAblationAccounting(value.plan, rows);
  assert.equal(accounting.knownFresh, 25);
  assert.equal(accounting.overshootFresh, 5);
  assert.equal(accounting.hardCapProven, false);
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider({ onDispatch: () => calls++ }) }), /budget admission denied/);
  assert.equal(calls, 1);
});

test("lock lost during return leaves durable runner usage even when acknowledgment cannot be written", async t => {
  const value = setup(t); let calls = 0;
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider({ onDispatch: () => {
    calls++;
    const lock = path.join(value.runRoot, ".benchmark-run.lock");
    fs.renameSync(lock, `${lock}.original`); fs.writeFileSync(lock, '{"replacement":true}');
  } }) }), /lock owner changed/);
  assert.equal(calls, 1);
  const manifest = read(path.join(value.runRoot, "run-manifest.json"));
  assert.equal(manifest.active.state, "dispatched", "lost owner may not update the adapter manifest");
  const workspaces = path.join(manifest.active.sessionRoot, "workspaces");
  const marker = read(path.join(workspaces, fs.readdirSync(workspaces)[0], "inflight.json"));
  assert.equal(marker.stage, "provider-returned");
  assert.equal(marker.usage.fresh, 10, "existing runner persists cost before the callback");
  assert.equal(fs.existsSync(path.join(value.runRoot, "stop-acknowledgment.json")), false);
  assert.equal(read(path.join(value.runRoot, ".benchmark-run.lock")).replacement, true);
});

test("cross-attempt reconciliation and ledger tampering are rejected", async t => {
  const value = setup(t);
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider(), checkpoint: stage => { if (stage === "returned") throw new Error("interrupt"); } }), /interrupt/);
  const file = reconcile(value); const receipt = read(file); receipt.attemptId = "foreign"; fs.writeFileSync(file, JSON.stringify(receipt));
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider(), reconciliation: file }), /cross-attempt/);
  await runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider(), reconciliation: reconcile(value), stopRequested: () => true });
  const ledger = path.join(value.runRoot, "runs.jsonl");
  const row = read(ledger); row.coordinate.armId = "evil-control"; fs.writeFileSync(ledger, `${JSON.stringify(row)}\n`);
  await assert.rejects(runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider() }), /binding mismatch/);
});

test("stop acknowledgment preserves a returned interrupted attempt without extra dispatch", async t => {
  const value = setup(t); let stopped = false; let calls = 0;
  const result = await runOfflineCandidateAblation({ ...value, fakeProvider: fakeProvider({ onDispatch: () => { calls++; stopped = true; } }), stopRequested: () => stopped });
  assert.equal(calls, 1); assert.equal(result.status, "stopped");
  assert.equal(result.accounting.knownFresh, 10);
  assert.equal(read(path.join(value.runRoot, "stop-acknowledgment.json")).status, "stopped");
});

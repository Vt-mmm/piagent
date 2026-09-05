import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startBenchmarkBudgetLaunch } from "../scripts/benchmark-budget-launcher.mjs";
import { completeBenchmarkOuterStage, runBenchmarkChild } from "../scripts/benchmark-runner.mjs";

function fixture(t, threshold = 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policyPath = path.join(root, "policy.json");
  const bytes = JSON.stringify({ fixture: "provider-free" });
  fs.writeFileSync(policyPath, bytes);
  const control = { identity: { policyPath, statePath: path.join(root, "state.json"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
    policy: { semantics: "management-thresholds", maxProviderAttempts: 2, freshTokenThreshold: 100, activeWallTimeMsThreshold: threshold },
    binding: { runId: "provider-free-launcher-test" } };
  return { root, control };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1200001;
  child.acks = [];
  child.send = (value, callback) => { child.acks.push(value); callback?.(); };
  return child;
}

test("launcher acknowledges exact direct-core packets and watchdog independently kills registered groups", async (t) => {
  const { control } = fixture(t);
  let clock = 100;
  const timers = [], signals = [], alive = new Set([1200002]);
  const launch = startBenchmarkBudgetLaunch(control, { now: () => clock,
    schedule: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, cancel: () => {},
    signalCore: (child, signal) => signals.push([child.pid, signal]),
    registryOptions: { groupAlive: pid => alive.has(pid), signalGroup: (pid, signal) => {
      signals.push([pid, signal]); if (signal === "SIGKILL") alive.delete(pid);
    } } });
  const child = fakeChild(), context = JSON.parse(launch.context);
  launch.supervise(child);
  child.emit("message", { kind: "benchmark-budget-process-v1", stageId: context.stageId, event: "started", pid: 1200002 });
  assert.deepEqual(child.acks, [{ kind: "benchmark-budget-process-ack-v1", stageId: context.stageId, event: "started", pid: 1200002, accepted: true }]);
  clock = 1100; timers[0].callback(); timers[1].callback();
  assert.deepEqual(signals, [[1200002, "SIGTERM"], [1200001, "SIGTERM"], [1200002, "SIGKILL"], [1200001, "SIGKILL"]]);
  child.emit("close");
  assert.equal((await launch.drain({ termGraceMs: 0, killGraceMs: 0 })).cleanupConfirmed, true);
  assert.ok(launch.finish().stopReasons.includes("launcher-wall-watchdog"));
});

test("malformed IPC is never acknowledged and leaves a durable protocol stop", async (t) => {
  const { control } = fixture(t);
  const launch = startBenchmarkBudgetLaunch(control, { schedule: () => 1, cancel: () => {}, signalCore: () => {} });
  const child = fakeChild(); launch.supervise(child);
  child.emit("message", { kind: "untrusted", pid: 1200002 }); child.emit("close");
  assert.deepEqual(child.acks, []);
  assert.equal((await launch.drain()).cleanupConfirmed, false);
  assert.ok(launch.finish().stopReasons.includes("launcher-process-protocol-failure"));
});

test("unconfirmed process cleanup cannot disappear behind successful core exit", async (t) => {
  const { control } = fixture(t);
  const launch = startBenchmarkBudgetLaunch(control, { schedule: () => 1, cancel: () => {}, signalCore: () => {},
    registryOptions: { groupAlive: () => true, signalGroup: () => {} } });
  const child = fakeChild(); launch.supervise(child);
  child.emit("message", { kind: "benchmark-budget-process-v1", stageId: JSON.parse(launch.context).stageId, event: "started", pid: 1200002 });
  child.emit("close");
  assert.equal((await launch.drain({ termGraceMs: 0, killGraceMs: 0 })).cleanupConfirmed, false);
  assert.ok(launch.finish().stopReasons.includes("launcher-process-cleanup-unconfirmed"));
});

test("finalizer catches policy mutation after the last child return and durably refuses success", (t) => {
  const { control } = fixture(t);
  let clock = 100;
  const launch = startBenchmarkBudgetLaunch(control, { now: () => clock });
  fs.writeFileSync(control.identity.policyPath, JSON.stringify({ fixture: "changed-after-last-provider" }));
  clock = 140;
  const result = launch.finish();
  assert.equal(result.launcherSucceeded, false);
  assert.deepEqual(result.launcherErrors, ["budget-policy-changed"]);
  assert.ok(result.stopReasons.includes("budget-policy-changed"));
  assert.equal(result.activeWallTimeMs, 40);
  const state = JSON.parse(fs.readFileSync(control.identity.statePath, "utf8")).state;
  assert.equal(state.stages[0].status, "closed");
  assert.ok(state.stopReasons.includes("budget-policy-changed"));
});

test("outer child exit drains registered groups before the cleanup callback", async (t) => {
  const { root } = fixture(t);
  const script = path.join(root, "fake-core.mjs");
  fs.writeFileSync(script, "process.exitCode = 0;\n");
  fs.writeFileSync(path.join(root, "register-typescript-loader.mjs"), "");
  const order = [];
  const launch = { supervise: () => order.push("supervise"), terminate: () => {},
    drain: async () => { order.push("drain"); return { cleanupConfirmed: true }; } };
  assert.equal(await runBenchmarkChild(script, [], {}, () => order.push("cleanup"), launch), 0);
  assert.deepEqual(order, ["supervise", "drain", "cleanup"]);
});

test("outer failure requires snapshot retention when group cleanup cannot be confirmed", async (t) => {
  const { root } = fixture(t);
  const script = path.join(root, "fake-core.mjs");
  fs.writeFileSync(script, "process.exitCode = 0;\n");
  fs.writeFileSync(path.join(root, "register-typescript-loader.mjs"), "");
  const launch = { supervise: () => {}, terminate: () => {}, drain: async () => ({ cleanupConfirmed: false }) };
  let cleaned = false;
  await assert.rejects(runBenchmarkChild(script, [], {}, () => { cleaned = true; }, launch), error => error.preserveBenchmarkSnapshot === true);
  assert.equal(cleaned, false);
});

test("real unresponsive core and registered detached provider are stopped by outer watchdog", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
  const { root, control } = fixture(t, 300);
  const script = path.join(root, "fake-core.mjs");
  const pidFile = path.join(root, "worker.pid");
  fs.writeFileSync(path.join(root, "register-typescript-loader.mjs"), "");
  fs.writeFileSync(script, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const context = JSON.parse(process.env.PIAGENT_BENCHMARK_BUDGET_CONTEXT);
process.on('SIGTERM',()=>{});
const worker = spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});
fs.writeFileSync(${JSON.stringify(pidFile)},String(worker.pid));
worker.stdout.once('data',()=>process.send({kind:'benchmark-budget-process-v1',stageId:context.stageId,event:'started',pid:worker.pid}));
process.on('message',message=>{if(message.kind==='benchmark-budget-process-ack-v1'&&message.accepted)while(true){}});
`);
  t.after(() => {
    if (fs.existsSync(pidFile)) try { process.kill(-Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already reaped. */ }
  });
  const launch = startBenchmarkBudgetLaunch(control, {
    schedule: (callback, ms) => setTimeout(callback, ms === 10_000 ? 60 : ms)
  });
  const code = await runBenchmarkChild(script, [], { [launch.environmentKey]: launch.context }, undefined, launch);
  assert.notEqual(code, 0);
  const result = launch.finish();
  assert.ok(result.stopReasons.includes("launcher-wall-watchdog"));
  assert.equal(result.stopReasons.includes("launcher-process-cleanup-unconfirmed"), false);
});

function outerFixture() {
  const events = [];
  const accounting = { launcherSucceeded: true, launcherErrors: [], overshoot: { freshTokens: 9, activeWallTimeMs: 3 } };
  const options = {
    snapshot: { temporaryRoot: "/fixture/snapshot", runtimeParent: "/fixture/runtime", metadata: { piAgentHome: {} } },
    launch: { context: JSON.stringify({ stageId: "a".repeat(32) }), finish: () => { events.push("finish"); return accounting; } },
    control: { identity: { sha256: "b".repeat(64) } }, childExitCode: 0,
    cleanupSnapshot: () => events.push("cleanup"),
    writeAccounting: value => { assert.equal(value, accounting); events.push("print"); },
    finalizePublication: value => { events.push("receipt"); return { ...value, closureAllowed: true }; }
  };
  return { events, accounting, options };
}

test("outer publication follows cleanup, finish and accounting and retains exact overshoot", async () => {
  const { events, accounting, options } = outerFixture();
  const result = await completeBenchmarkOuterStage(options);
  assert.deepEqual(events, ["cleanup", "finish", "print", "receipt"]);
  assert.equal(result.publication.outerSucceeded, true);
  assert.equal(result.publication.launcherReceipt, accounting);
  assert.equal(result.publication.stageId, "a".repeat(32));
  assert.deepEqual(result.publication.outerErrorCodes, []);
});

test("a legitimate quality-failure exit can publish its valid failure report", async () => {
  const { options } = outerFixture();
  const result = await completeBenchmarkOuterStage({ ...options, childExitCode: 1 });
  assert.equal(result.code, 1);
  assert.equal(result.publication.childExitCode, 1);
  assert.equal(result.publication.outerSucceeded, true);
});

test("cleanup failure still records the final accounting but never authorizes promotion", async () => {
  const { events, options } = outerFixture();
  const failure = new Error("cleanup-original"); let receipt;
  await assert.rejects(completeBenchmarkOuterStage({ ...options,
    cleanupSnapshot: () => { events.push("cleanup"); throw failure; },
    finalizePublication: value => { receipt = value; events.push("receipt"); }
  }), error => error === failure);
  assert.deepEqual(events, ["cleanup", "finish", "print", "receipt"]);
  assert.equal(receipt.outerSucceeded, false);
  assert.deepEqual(receipt.outerErrorCodes, ["snapshot-cleanup-failed"]);
});

test("primary child error survives cleanup, finalizer and receipt errors without masking", async () => {
  const { options } = outerFixture();
  const original = new Error("child-original"); let receipt;
  await assert.rejects(completeBenchmarkOuterStage({ ...options, primaryError: original,
    cleanupSnapshot: () => { throw new Error("cleanup-secondary"); },
    launch: { ...options.launch, finish: () => { throw new Error("finalizer-secondary"); } },
    finalizePublication: value => { receipt = value; throw new Error("publication-secondary"); }
  }), error => error === original);
  assert.equal(receipt.launcherReceipt, null);
  assert.equal(receipt.outerSucceeded, false);
  assert.deepEqual(original.benchmarkOuterErrorCodes, ["child-execution-error", "snapshot-cleanup-failed", "budget-finalizer-failed", "budget-publication-failed"]);
});

test("unknown process cleanup preserves runtime artifacts and records a failed parent receipt", async () => {
  const { options, events } = outerFixture(); let receipt;
  await assert.rejects(completeBenchmarkOuterStage({ ...options, preserveSnapshot: true,
    finalizePublication: value => { receipt = value; events.push("receipt"); }
  }), /snapshot retained/);
  assert.deepEqual(events, ["finish", "print", "receipt"]);
  assert.equal(receipt.outerSucceeded, false);
  assert.ok(receipt.outerErrorCodes.includes("snapshot-cleanup-unconfirmed"));
});

test("failed accounting output does not suppress durable failed receipt or permit promotion", async () => {
  const { options } = outerFixture(); let receipt;
  await assert.rejects(completeBenchmarkOuterStage({ ...options,
    writeAccounting: () => { throw new Error("output unavailable"); },
    finalizePublication: value => { receipt = value; }
  }), /output unavailable/);
  assert.equal(receipt.outerSucceeded, false);
  assert.deepEqual(receipt.outerErrorCodes, ["accounting-output-failed"]);
});

test("parent publication exception propagates after accounting without returning a clean result", async () => {
  const { options, events } = outerFixture();
  await assert.rejects(completeBenchmarkOuterStage({ ...options,
    finalizePublication: () => { events.push("receipt"); throw new Error("receipt persistence failed"); }
  }), /receipt persistence failed/);
  assert.deepEqual(events, ["cleanup", "finish", "print", "receipt"]);
});

test("a durable denied receipt cannot return a clean wrapper exit", async () => {
  const { options, events } = outerFixture();
  await assert.rejects(completeBenchmarkOuterStage({ ...options,
    finalizePublication: () => { events.push("receipt"); return { closureAllowed: false, publicationAllowed: false }; }
  }), /did not authorize/);
  assert.deepEqual(events, ["cleanup", "finish", "print", "receipt"]);
});

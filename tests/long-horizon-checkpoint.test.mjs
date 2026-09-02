import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { readCheckpoint } from "../packages/piagent-core/benchmark/benchmark-checkpoint.js";

const root = path.resolve(import.meta.dirname, "..");
const runner = path.join(root, "evals/long-horizon-v1/runner.mjs");
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
function assertUniqueProgress(execution, totalUnits) {
  const events = fs.readFileSync(path.join(execution, "project/.pi/piagent-state/task-journal/events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.eventType === "long-horizon-progress");
  assert.deepEqual(events.map((entry) => entry.data.unit), Array.from({ length: totalUnits }, (_, index) => index + 1),
    "checkpoint replay must restore every committed unit exactly once, including projection crash windows");
  assert.equal(new Set(events.map((entry) => entry.idempotencyKey)).size, totalUnits);
}
async function until(predicate, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 15)); }
  throw new Error(`Timed out: ${description}`);
}

function pauseAtCheckpointPreload(workerCheckpoint, pauseMarker, interruptedUnit) {
  return `import fs from 'node:fs';
import { writeCheckpointBytes } from ${JSON.stringify(new URL("../packages/piagent-core/benchmark/benchmark-checkpoint.js", import.meta.url).href)};
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename(from, to);
  if (String(to) === ${JSON.stringify(workerCheckpoint)} && !fs.existsSync(${JSON.stringify(pauseMarker)})) {
    const value = JSON.parse(fs.readFileSync(to, 'utf8'));
    if (value.data?.state?.currentUnit === ${interruptedUnit}) {
      // The parent may read concurrently even while this process writes synchronously.
      writeCheckpointBytes(${JSON.stringify(pauseMarker)}, JSON.stringify({ pid: process.pid, unit: ${interruptedUnit} }));
      process.kill(process.pid, 'SIGSTOP');
    }
  }
  return result;
};\n`;
}

test("pause marker publication never exposes empty or partial JSON to its strict reader", { timeout: 15_000 }, (t) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-pause-publication-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workerCheckpoint = path.join(directory, "checkpoint.json"), pauseMarker = path.join(directory, "paused-worker.json");
  const checkpoint = { data: { state: { currentUnit: 2 } } };
  const reader = `import fs from 'node:fs';
let observation;
try { observation = { status: 'read', value: (${read.toString()})(process.argv[1]) }; }
catch (error) { observation = { status: 'error', name: error.name, message: error.message }; }
process.stdout.write(JSON.stringify(observation));`;
  // Run the same preload used by the real SIGKILL tests in an isolated process.
  // A nested reader runs synchronously at both publication windows, so this
  // regression does not depend on polling frequency or scheduler load.
  const probe = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const checkpoint = ${JSON.stringify(workerCheckpoint)}, marker = ${JSON.stringify(pauseMarker)};
const payload = JSON.stringify({ pid: process.pid, unit: 2 });
const write = fs.writeFileSync, duringWrite = [], signals = [];
write(checkpoint + '.pending', ${JSON.stringify(JSON.stringify(checkpoint))});
const inspect = () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(reader)}, marker], { encoding: 'utf8', timeout: 3_000 });
  assert.equal(result.status, 0, result.stderr);
  duringWrite.push(JSON.parse(result.stdout));
};
fs.writeFileSync = function(target, bytes, ...options) {
  if (bytes !== payload) return write(target, bytes, ...options);
  const ownsDescriptor = typeof target !== 'number';
  const fd = ownsDescriptor ? fs.openSync(target, 'w') : target;
  try {
    inspect();
    fs.writeSync(fd, '{"pid":', 0, 'utf8');
    inspect();
    return write(fd, bytes, ...options);
  } finally { if (ownsDescriptor) fs.closeSync(fd); }
};
process.kill = (pid, signal) => { assert.equal(pid, process.pid); assert.equal(signal, 'SIGSTOP'); signals.push(signal); };
await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(pauseAtCheckpointPreload(workerCheckpoint, pauseMarker, 2)).toString("base64")}`)});
fs.renameSync(checkpoint + '.pending', checkpoint);
process.stdout.write(JSON.stringify({ duringWrite, signals, marker: JSON.parse(fs.readFileSync(marker, 'utf8')) }));`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], { env, encoding: "utf8", timeout: 12_000 });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.duringWrite, [{ status: "read", value: null }, { status: "read", value: null }]);
  assert.deepEqual(observed.marker, { pid: result.pid, unit: 2 });
  assert.deepEqual(observed.signals, ["SIGSTOP"]);
  assert.deepEqual(read(workerCheckpoint), checkpoint);
  assert.deepEqual(read(pauseMarker), observed.marker);
  const corrupt = path.join(directory, "corrupt-marker.json");
  for (const bytes of ["", '{"pid":']) {
    fs.writeFileSync(corrupt, bytes);
    assert.throws(() => read(corrupt), SyntaxError, "malformed published JSON must still fail, not be retried or ignored");
  }
});

for (const interruptedUnit of [2, 5, 8]) test(`long-horizon resumes after coordinator SIGKILL at unit ${interruptedUnit}`, { timeout: 60_000 }, async (t) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-s0-resume-")));
  const execution = path.join(directory, "execution");
  const output = path.join(directory, "report.json");
  const privateRoot = path.join(execution, "project/.pi/piagent-state/long-horizon");
  const workerCheckpoint = path.join(privateRoot, "checkpoint.json");
  const pauseMarker = path.join(directory, "paused-worker.json"), preload = path.join(directory, "pause-at-checkpoint.mjs");
  // Freeze the actual worker at the requested durable boundary. Polling a
  // checkpoint, then awaiting a competing process, lets the worker advance
  // under load before SIGKILL and does not test the advertised restart unit.
  // Injection remains outside production source and runs only once.
  fs.writeFileSync(preload, pauseAtCheckpointPreload(workerCheckpoint, pauseMarker, interruptedUnit));
  const children = [];
  const start = (...extra) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${preload}`;
    const child = spawn(process.execPath, [runner, "--calibration-fast", "--tick-ms", "300", "--state-directory", execution, "--output", output, ...extra], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })); });
    children.push({ child, result });
    return children.at(-1);
  };
  t.after(async () => {
    for (const { child, result } of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await result; }
    const owner = read(path.join(privateRoot, ".benchmark-run.lock"));
    if (owner?.pid) {
      if (alive(owner.pid)) process.kill(owner.pid, "SIGCONT");
      await until(() => !alive(owner.pid), "owned orphan exit");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const initial = start();
  await until(() => read(pauseMarker)?.unit === interruptedUnit, "worker stopped at durable unit checkpoint");
  const before = read(workerCheckpoint);
  assert.equal(before.data.state.currentUnit, interruptedUnit);
  const artifact = path.join(execution, "project/artifacts/long-horizon/units", `${String(interruptedUnit).padStart(3, "0")}.json`);
  const artifactBytes = fs.readFileSync(artifact);
  const artifactTime = fs.statSync(artifact).mtimeMs;
  const workerPid = read(path.join(privateRoot, ".benchmark-run.lock")).pid;
  assert.equal(read(pauseMarker).pid, workerPid);
  const competitor = start();
  const rejected = await competitor.result;
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /locked by another process/);
  initial.child.kill("SIGKILL");
  assert.equal((await initial.result).signal, "SIGKILL");
  process.kill(workerPid, "SIGCONT");
  await until(() => !alive(workerPid), "IPC orphan shutdown");
  assert.equal(fs.existsSync(output), false, "partial progress is not a completed lane receipt");
  const retained = read(workerCheckpoint);
  assert.equal(retained.data.state.currentUnit, interruptedUnit, "the injected crash occurs at the exact advertised unit");
  // A changed configuration cannot reuse the same progress directory.
  const changed = start("--binding", "changed-binding");
  assert.notEqual((await changed.result).code, 0);
  assert.deepEqual(read(workerCheckpoint), retained);
  const resumed = start();
  const result = await resumed.result;
  assert.equal(result.code, 0, result.stderr);
  const report = read(output);
  assert.equal(report.evidenceClass, "calibration-fast");
  assert.equal(report.wallClockQualified, false, "accelerated calibration is never full wall-clock evidence");
  assert.equal(report.completedFromResume, true);
  assert.equal(report.stateGrowth.checkpointSequenceComplete, true);
  assert.deepEqual(report.stateGrowth.samples.map((entry) => entry.unit), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(report.lifecycle.processStarts >= 4);
  assert.ok(report.lifecycle.resumedUnits.includes(interruptedUnit));
  assert.equal(report.continuation.consumed, 1);
  assert.equal(report.continuation.secondAllowed, false);
  assert.equal(report.verification.stableCurrentTree, true);
  assertUniqueProgress(execution, 9);
  assert.deepEqual(fs.readFileSync(artifact), artifactBytes);
  assert.equal(fs.statSync(artifact).mtimeMs, artifactTime, "committed units are not executed or rewritten on resume");
  const after = read(workerCheckpoint);
  assert.ok(after.data.state.activeMilliseconds >= before.data.state.activeMilliseconds);
  const complete = read(path.join(execution, "coordinator.json"));
  assert.equal(readCheckpoint(path.join(execution, "coordinator.json"), complete.binding).phase, "complete");
  const reused = await start().result;
  assert.equal(reused.code, 0, reused.stderr);
  assert.deepEqual(read(workerCheckpoint), after, "completed reuse does not start another worker");
  assert.deepEqual(read(output), report);
});

for (const boundary of ["before-unit-commit", "after-unit-commit", "before-coordinator-commit", "after-coordinator-commit"]) test(`long-horizon recovers the ${boundary} crash window`, { timeout: 45_000 }, async (t) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-s0-atomic-")));
  const execution = path.join(directory, "execution");
  const output = path.join(directory, "report.json");
  const preload = path.join(directory, "fault.mjs");
  const fired = path.join(directory, "fired");
  // Fault injection lives outside the candidate and calls the real OS signal.
  // No production-only bypass, synthetic pass, or accelerated full S0 flag.
  fs.writeFileSync(preload, `import fs from 'node:fs';
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (!fs.existsSync(${JSON.stringify(fired)}) && (String(to).endsWith('/checkpoint.json') || String(to).endsWith('/coordinator.json'))) {
    const value = JSON.parse(fs.readFileSync(from, 'utf8'));
    const target = ${JSON.stringify(boundary)}.includes('coordinator')
      ? value.data?.phase === 'handoff'
      : value.data?.state?.currentUnit === 2;
    if (target) {
      fs.writeFileSync(${JSON.stringify(fired)}, String(process.pid));
      if (!${JSON.stringify(boundary)}.startsWith('before-')) rename(from, to);
      process.kill(process.pid, 'SIGKILL');
    }
  }
  return rename(from, to);
};\n`);
  const children = [];
  const start = (inject) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    if (inject) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${preload}`;
    const child = spawn(process.execPath, [runner, "--calibration-fast", "--state-directory", execution, "--output", output], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stdout.resume(); child.stderr.on("data", (data) => { stderr += data; });
    const result = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stderr })); });
    children.push({ child, result }); return result;
  };
  t.after(async () => {
    for (const { child, result } of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await result; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const interrupted = await start(true);
  assert.ok(interrupted.signal === "SIGKILL" || interrupted.code !== 0);
  assert.equal(fs.existsSync(fired), true, "the intended crash window was actually reached");
  assert.equal(fs.existsSync(output), false);
  const checkpointPath = path.join(execution, "project/.pi/piagent-state/long-horizon/checkpoint.json");
  const snapshot = read(checkpointPath);
  assert.equal(snapshot.data.state.currentUnit, boundary === "before-unit-commit" ? 1 : boundary === "after-unit-commit" ? 2 : 3);
  const result = await start(false);
  assert.equal(result.code, 0, result.stderr);
  const report = read(output);
  assert.equal(report.completedFromResume, true);
  assert.equal(report.stateGrowth.checkpointSequenceComplete, true);
  assert.equal(report.context.observations, 9);
  assert.equal(report.continuation.consumed, 1);
  assert.equal(report.continuation.secondAllowed, false);
  assert.deepEqual(report.lifecycle.journalCorruptions, []);
  assertUniqueProgress(execution, 9);
});

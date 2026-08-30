import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
  fs.writeFileSync(preload, `import fs from 'node:fs';
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename(from, to);
  if (String(to) === ${JSON.stringify(workerCheckpoint)} && !fs.existsSync(${JSON.stringify(pauseMarker)})) {
    const value = JSON.parse(fs.readFileSync(to, 'utf8'));
    if (value.data?.state?.currentUnit === ${interruptedUnit}) {
      fs.writeFileSync(${JSON.stringify(pauseMarker)}, JSON.stringify({ pid: process.pid, unit: ${interruptedUnit} }));
      process.kill(process.pid, 'SIGSTOP');
    }
  }
  return result;
};\n`);
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

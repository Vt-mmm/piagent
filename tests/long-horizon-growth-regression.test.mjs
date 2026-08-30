import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { readCheckpoint } from "../packages/piagent-core/benchmark/benchmark-checkpoint.js";
import { appendTaskJournalEvent, readTaskJournal, taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";

const root = path.resolve(import.meta.dirname, "..");
const laneRoot = path.join(root, "evals", "long-horizon-v1");
const lane = JSON.parse(fs.readFileSync(path.join(laneRoot, "lane.json"), "utf8"));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function treeBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((bytes, entry) => {
    const absolute = path.join(directory, entry.name);
    return bytes + (entry.isDirectory() ? treeBytes(absolute) : entry.isFile() ? fs.statSync(absolute).size : 0);
  }, 0);
}

function initializeFixture(workspace) {
  fs.cpSync(path.resolve(laneRoot, lane.fixture), workspace, { recursive: true });
  for (const args of [["init", "-q", workspace], ["-C", workspace, "config", "user.email", "long-horizon@example.invalid"],
    ["-C", workspace, "config", "user.name", "Piagent Long Horizon"], ["-C", workspace, "add", "."],
    ["-C", workspace, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  }
}

test("90-unit fast worker regression keeps replayed progress unique and durable state below 2 MiB", { timeout: 180_000 }, async (t) => {
  // Exercise the real worker at the full unit count, not the nine-unit runner
  // calibration. Accelerated test timing is never S0 or wall-clock evidence.
  assert.equal(lane.totalUnits, 90);
  assert.equal(lane.durableStateCeilingBytes, 2 * 1024 * 1024);
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-long-horizon-growth-")));
  const workspace = path.join(directory, "project");
  const privateRoot = path.join(workspace, ".pi", "piagent-state");
  const checkpointPath = path.join(privateRoot, "long-horizon", "checkpoint.json");
  const children = [];
  let passed = false;
  t.after(async () => {
    for (const { child, result } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await result;
    }
    if (passed) fs.rmSync(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained test-owned failure artifacts: ${directory}`);
  });
  initializeFixture(workspace);
  const runtime = {
    laneId: lane.id, taskId: "long-horizon-90", taskRunId: "long-horizon-90-run-1", sessionId: "long-horizon-session",
    totalUnits: lane.totalUnits, logicalDurationMinutes: lane.logicalDurationMinutes,
    compactionUnits: lane.compactionUnits, tickMilliseconds: 0
  };
  const start = (name, boundaries = {}) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const encoded = Buffer.from(JSON.stringify({ ...runtime, ...boundaries })).toString("base64url");
    const child = spawn(process.execPath, [path.join(laneRoot, "worker.mjs"), workspace, encoded], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let stdout = "", stderr = "", timedOut = false;
    const messages = [];
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (message) => {
      messages.push(message);
      if (message.type === "crash-boundary" && message.unit === boundaries.crashBoundary) child.kill("SIGKILL");
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90_000);
    timer.unref();
    const result = new Promise((resolve) => {
      let spawnError;
      child.once("error", (error) => { spawnError = String(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const outcome = { code, signal, timedOut, spawnError, messages, stdout, stderr };
        fs.writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 });
        resolve(outcome);
      });
    });
    children.push({ child, result });
    return result;
  };
  const checkpoint = () => readCheckpoint(checkpointPath, read(checkpointPath).binding);
  const stageBytes = [];
  const killed = await start("hard-crash", { crashBoundary: lane.hardCrashAfterUnit });
  assert.equal(killed.timedOut, false, killed.stderr);
  assert.equal(killed.spawnError, undefined);
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  assert.deepEqual(killed.messages, [{ type: "crash-boundary", unit: lane.hardCrashAfterUnit }]);
  assert.equal(checkpoint().state.currentUnit, lane.hardCrashAfterUnit);
  stageBytes.push(treeBytes(privateRoot));
  const committedArtifact = path.join(workspace, "artifacts", "long-horizon", "units", "030.json");
  const committedBytes = fs.readFileSync(committedArtifact);
  const committedMtime = fs.statSync(committedArtifact).mtimeMs;
  const handoff = await start("planned-handoff", { stopAfterUnit: lane.handoffAfterUnit });
  assert.equal(handoff.timedOut, false, handoff.stderr);
  assert.equal(handoff.code, 75, handoff.stderr);
  assert.equal(checkpoint().state.currentUnit, lane.handoffAfterUnit);
  stageBytes.push(treeBytes(privateRoot));
  const finished = await start("finish");
  assert.equal(finished.timedOut, false, finished.stderr);
  assert.equal(finished.code, 0, finished.stderr);

  const final = checkpoint();
  const journal = readTaskJournal(workspace, { taskRunId: runtime.taskRunId });
  const progress = journal.events.filter((entry) => entry.eventType === "long-horizon-progress");
  const finalBytes = treeBytes(privateRoot);
  const peakBytes = Math.max(finalBytes, final.state.peakDurableStateBytes, ...stageBytes, ...final.telemetry.map((entry) => entry.durableStateBytes));
  const summary = {
    purpose: "Provider-free accelerated regression only; not S0 or wall-clock qualification.",
    completedUnits: final.state.currentUnit, progressEvents: progress.length,
    uniqueProgressKeys: new Set(progress.map((entry) => entry.idempotencyKey)).size,
    finalBytes, peakBytes, ceilingBytes: lane.durableStateCeilingBytes,
    processStarts: final.state.processStarts, resumedUnits: final.state.resumedUnits,
    activeMilliseconds: final.state.activeMilliseconds
  };
  fs.writeFileSync(path.join(directory, "regression-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  t.diagnostic(JSON.stringify(summary));
  assert.ok(peakBytes <= lane.durableStateCeilingBytes,
    `90-unit durable state grew to ${peakBytes} bytes; unchanged ceiling is ${lane.durableStateCeilingBytes} bytes`);
  assert.deepEqual(journal.corruptions, []);
  assert.equal(journal.inputTruncated, false);
  const expectedUnits = Array.from({ length: lane.totalUnits }, (_, index) => index + 1);
  assert.equal(final.state.currentUnit, lane.totalUnits);
  assert.equal(final.state.processStarts, 3);
  assert.deepEqual(final.state.resumedUnits, [lane.hardCrashAfterUnit, lane.handoffAfterUnit]);
  assert.equal(final.state.compactions, lane.compactionUnits.length);
  assert.deepEqual(final.telemetry.map((entry) => entry.unit), expectedUnits);
  assert.deepEqual(progress.map((entry) => entry.data.unit), expectedUnits, "checkpoint projection must append each durable unit exactly once");
  assert.equal(summary.uniqueProgressKeys, lane.totalUnits);
  for (const [index, entry] of progress.entries()) {
    const unit = read(path.join(workspace, "artifacts", "long-horizon", "units", `${String(index + 1).padStart(3, "0")}.json`));
    assert.equal(entry.taskId, runtime.taskId);
    assert.equal(entry.sessionId, runtime.sessionId);
    assert.equal(entry.idempotencyKey, `long-horizon:${unit.unit}`);
    assert.equal(entry.recordedAt, final.telemetry[index].recordedAt);
    assert.deepEqual(entry.data, {
      unit: unit.unit, logicalMinute: unit.unit, sourceDigest: unit.sourceDigest,
      currentWorkingTreeDigest: final.telemetry[index].currentWorkingTreeDigest
    });
  }
  assert.deepEqual(fs.readFileSync(committedArtifact), committedBytes);
  assert.equal(fs.statSync(committedArtifact).mtimeMs, committedMtime, "resume must not rewrite an already committed unit");
  const verification = spawnSync(process.execPath, [path.join(laneRoot, "verify.mjs"), workspace, String(lane.totalUnits)], {
    encoding: "utf8", timeout: 10_000
  });
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).completedUnits, lane.totalUnits);
  passed = true;
});

test("worker rejects a conflicting progress key without rewriting prior journal evidence", { timeout: 20_000 }, (t) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-long-horizon-conflict-")));
  const workspace = path.join(directory, "project");
  let passed = false;
  t.after(() => {
    if (passed) fs.rmSync(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained test-owned failure artifacts: ${directory}`);
  });
  initializeFixture(workspace);
  const runtime = {
    laneId: lane.id, taskId: "long-horizon-conflict", taskRunId: "long-horizon-conflict-run", sessionId: "long-horizon-session",
    totalUnits: 1, logicalDurationMinutes: lane.logicalDurationMinutes, compactionUnits: [], tickMilliseconds: 0
  };
  // The prior event is a valid hash-chained record, but its data and timestamp
  // cannot stand in for the new worker's committed observation of this unit.
  appendTaskJournalEvent(workspace, {
    eventType: "long-horizon-progress", taskId: runtime.taskId, taskRunId: runtime.taskRunId,
    sessionId: runtime.sessionId, idempotencyKey: "long-horizon:1",
    data: { unit: 1, logicalMinute: 1, sourceDigest: "0".repeat(64), currentWorkingTreeDigest: `wt-content-v2:${"0".repeat(64)}` }
  }, { recordedAt: "2000-01-01T00:00:00.000Z" });
  const paths = taskJournalPaths(workspace);
  const eventsBefore = fs.readFileSync(paths.events), headBefore = fs.readFileSync(paths.head);
  const priorJournal = readTaskJournal(workspace);
  assert.deepEqual(priorJournal.corruptions, []);
  assert.equal(priorJournal.events.length, 1);
  const encoded = Buffer.from(JSON.stringify(runtime)).toString("base64url");
  const result = spawnSync(process.execPath, [path.join(laneRoot, "worker.mjs"), workspace, encoded], {
    cwd: root, encoding: "utf8", timeout: 10_000
  });
  fs.writeFileSync(path.join(directory, "worker-result.json"), `${JSON.stringify({ status: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2)}\n`, { mode: 0o600 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /long-horizon journal projection mismatch at unit 1/);
  assert.deepEqual(fs.readFileSync(paths.events), eventsBefore, "a conflicting existing event must not be overwritten or duplicated");
  assert.deepEqual(fs.readFileSync(paths.head), headBefore);
  const journal = readTaskJournal(workspace);
  assert.deepEqual(journal.corruptions, []);
  assert.deepEqual(journal.events, priorJournal.events);
  assert.equal(fs.existsSync(path.join(workspace, "artifacts", "long-horizon", "report.json")), false,
    "conflicting projection cannot produce a completed worker artifact");
  passed = true;
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildContextEfficiencyReport } from "../../packages/piagent-core/extensions/context-engine.js";
import { recordCompletionAudit, recordTaskStartCheckpoint } from "../../packages/piagent-core/extensions/task-runtime-audit.js";
import { inspectTaskContinuationBudget, reserveTaskContinuation } from "../../packages/piagent-core/runtime/recovery/continuation-budget.ts";
import { buildHandoffProjection, readHandoffProjection, writeHandoffProjection } from "../../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { inspectTaskResumeState } from "../../packages/piagent-core/runtime/recovery/resume-state.ts";
import { createBoundTaskAuthority } from "../../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { bindSessionTask, workingTreeSnapshot, writeTaskContract } from "../../packages/piagent-core/extensions/task-state.js";
import { readTaskJournal } from "../../packages/piagent-core/extensions/task-journal.js";
import { workingTreeEvidenceDigest } from "../../packages/piagent-core/extensions/working-tree-digest.js";

const laneRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(laneRoot, "../..");
const lane = JSON.parse(fs.readFileSync(path.join(laneRoot, "lane.json"), "utf8"));
const argumentsList = process.argv.slice(2);
const option = (name) => {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : undefined;
};
const calibrationFast = argumentsList.includes("--calibration-fast");
const outputPath = path.resolve(option("--output") ?? path.join(process.cwd(), "long-horizon-report.json"));
const totalUnits = calibrationFast ? 9 : lane.totalUnits;
const crashAfterUnit = calibrationFast ? 3 : lane.hardCrashAfterUnit;
const handoffAfterUnit = calibrationFast ? 6 : lane.handoffAfterUnit;
const compactionUnits = calibrationFast ? [2, 4, 6, 8] : lane.compactionUnits;
const tickMilliseconds = calibrationFast ? Number(option("--tick-ms") ?? 2) : lane.tickMilliseconds;
const evidenceClass = calibrationFast ? "calibration-fast" : "provider-free-long-horizon";
if (!calibrationFast && option("--tick-ms") !== undefined) throw new Error("wall-clock evidence cannot override tick duration");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-long-horizon-"));
const workspace = path.join(temporaryRoot, "project");
const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
const fixture = path.resolve(laneRoot, lane.fixture);
fs.cpSync(fixture, workspace, { recursive: true });
spawnSync("git", ["init", "-q", workspace], { stdio: "inherit" });
spawnSync("git", ["-C", workspace, "config", "user.email", "long-horizon@example.invalid"], { stdio: "inherit" });
spawnSync("git", ["-C", workspace, "config", "user.name", "Piagent Long Horizon"], { stdio: "inherit" });
spawnSync("git", ["-C", workspace, "add", "."], { stdio: "inherit" });
spawnSync("git", ["-C", workspace, "commit", "-qm", "fixture"], { stdio: "inherit" });

const taskId = "long-horizon-90";
const taskRunId = "long-horizon-90-run-1";
const sessionId = "long-horizon-session";
const sessionName = "LONG-HORIZON-90 repository audit";
const createdAt = startedAt;
const portableVerifier = path.join(workspace, ".pi", "piagent-state", "long-horizon", "verify.mjs");
fs.mkdirSync(path.dirname(portableVerifier), { recursive: true, mode: 0o700 });
fs.copyFileSync(path.join(laneRoot, "verify.mjs"), portableVerifier);
fs.chmodSync(portableVerifier, 0o600);
let task = {
  schemaVersion: 2,
  taskRunId,
  taskId,
  sessionId,
  sessionName,
  changeMode: "source-change",
  attempt: 1,
  maxAttempts: 3,
  previousAttempts: [],
  summary: "Complete a durable repository inventory across three 30-minute logical stages and survive a hard process death.",
  riskLane: "normal",
  expectedOutput: "A verified 90-unit inventory report completed from durable resume state.",
  acceptanceCriteria: [
    "All configured units are present and bind to current source bytes.",
    "A hard process death resumes from the last durable checkpoint without duplicate units.",
    "Compaction keeps context proxy and private state growth within declared ceilings.",
    "Exactly one system continuation is consumable and a second is refused.",
    "The final verifier is stable on the completed current tree."
  ],
  scope: ["artifacts/long-horizon/**"],
  outOfScope: ["Existing source, package, vendor, configuration, and dependency files."],
  protectedPaths: [],
  requiredContext: [],
  contextManifest: [],
  memoryCitations: [],
  mcpCapabilities: [],
  verifyGroup: "source",
  verifyCommands: [`node .pi/piagent-state/long-horizon/verify.mjs . ${totalUnits}`],
  workPlan: [
    { id: "discovery", title: "Inventory the first repository segment.", role: "parent", mode: "single-writer", status: "in-progress" },
    { id: "validation", title: "Resume and validate the second segment.", role: "parent", mode: "single-writer", status: "pending", dependsOn: ["discovery"] },
    { id: "synthesis", title: "Resume from handoff and synthesize the final report.", role: "parent", mode: "single-writer", status: "pending", dependsOn: ["validation"] }
  ],
  reviewLenses: ["correctness", "tests", "scope"],
  workingTreeDigestAlgorithm: "wt-content-v2",
  orchestration: {
    mode: "solo-first", subagents: "not-used", reason: "Deterministic one-writer lifecycle lane.", fieldGuidePath: ".pi/memory/MEMORY.md",
    modelRoles: { planner: "not-used", worker: "not-used", reviewer: "not-used", watchdog: "not-used" }
  },
  baselineChangedFiles: [],
  baselineFileDigests: workingTreeSnapshot(workspace),
  observedChangedFiles: [],
  finalWorkingTreeFiles: [],
  finalFileDigests: {},
  changedFiles: [],
  verifyEvidence: [],
  trace: { outcome: "pending" },
  createdAt,
  updatedAt: createdAt
};
task.authoritySnapshot = createBoundTaskAuthority({ taskId, taskRunId, createdAt });
task = writeTaskContract(workspace, task);
bindSessionTask(workspace, sessionId, sessionName, task);
recordTaskStartCheckpoint({ cwd: workspace, ui: { notify() {} } }, task, "discovery", "automatic");

const runtimeBase = {
  laneId: lane.id,
  taskId,
  taskRunId,
  sessionId,
  totalUnits,
  logicalDurationMinutes: lane.logicalDurationMinutes,
  compactionUnits,
  tickMilliseconds
};
const workerPath = path.join(laneRoot, "worker.mjs");
const statePath = path.join(workspace, ".pi", "piagent-state", "long-horizon", "state.json");

function state() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return { currentUnit: 0 }; throw error; }
}

function startWorker(stopAfterUnit) {
  const runtime = Buffer.from(JSON.stringify({ ...runtimeBase, stopAfterUnit })).toString("base64url");
  const child = spawn(process.execPath, [workerPath, workspace, runtime], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, result: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }))) };
}

async function waitForUnit(unit) {
  const remaining = Math.max(1, unit - Number(state().currentUnit ?? 0));
  const deadline = Date.now() + Math.max(30_000, tickMilliseconds * (remaining + 2));
  while (Date.now() < deadline) {
    if (state().currentUnit >= unit) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(5, tickMilliseconds / 20))));
  }
  throw new Error(`timed out waiting for long-horizon unit ${unit}`);
}

function updatePendingTask(completed, active) {
  const snapshot = workingTreeSnapshot(workspace);
  const files = Object.keys(snapshot).sort();
  task = writeTaskContract(workspace, {
    ...task,
    workPlan: task.workPlan.map((step) => ({ ...step, status: step.id === completed ? "done" : step.id === active ? "in-progress" : step.status })),
    observedChangedFiles: files,
    updatedAt: new Date().toISOString()
  });
  bindSessionTask(workspace, sessionId, sessionName, task);
}

function treeBytes(directory) {
  let bytes = 0;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) bytes += fs.statSync(absolute).size;
    }
  };
  visit(directory);
  return bytes;
}

function persistHandoff(reason) {
  const projection = buildHandoffProjection(workspace, task, {
    gate: { decision: "fail", missing: [reason], missingVerifyCommands: task.verifyCommands, currentWorkingTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(workspace)) },
    recovery: null
  });
  writeHandoffProjection(workspace, projection);
  return readHandoffProjection(workspace, taskRunId);
}

const first = startWorker(undefined);
await waitForUnit(crashAfterUnit);
first.child.kill("SIGKILL");
const firstResult = await first.result;
assert.equal(firstResult.signal, "SIGKILL", firstResult.stderr);
assert.equal(state().currentUnit, crashAfterUnit);
updatePendingTask("discovery", "validation");
const crashDigest = workingTreeEvidenceDigest(workingTreeSnapshot(workspace));
const firstContinuation = reserveTaskContinuation(workspace, task, {
  capabilityId: "CAP-12",
  classification: "infrastructure-retry",
  action: "retry",
  currentWorkingTreeDigest: crashDigest,
  reasonCodes: ["process-killed"],
  recordedAt: new Date().toISOString()
});
assert.equal(firstContinuation.allowed, true);
const secondContinuation = reserveTaskContinuation(workspace, task, {
  capabilityId: "CAP-12",
  classification: "infrastructure-retry",
  action: "retry",
  currentWorkingTreeDigest: crashDigest,
  reasonCodes: ["second-process-killed"],
  recordedAt: new Date().toISOString()
});
assert.equal(secondContinuation.allowed, false);
assert.equal(secondContinuation.reason, "global-budget-exhausted");
const crashHandoff = persistHandoff("hard process death at a durable checkpoint");
assert.equal(crashHandoff?.identity.taskRunId, taskRunId);
const crashResume = inspectTaskResumeState(workspace, task, sessionId);
assert.equal(crashResume.enforcementSafe, true, crashResume.reason);

const second = startWorker(handoffAfterUnit);
const secondResult = await second.result;
assert.equal(secondResult.code, 75, secondResult.stderr);
assert.equal(state().currentUnit, handoffAfterUnit);
updatePendingTask("validation", "synthesis");
const plannedHandoff = persistHandoff("planned process handoff after validation stage");
assert.equal(plannedHandoff?.identity.taskRunId, taskRunId);

const third = startWorker(undefined);
const thirdResult = await third.result;
assert.equal(thirdResult.code, 0, thirdResult.stderr);
assert.equal(state().currentUnit, totalUnits);
const beforeVerify = workingTreeEvidenceDigest(workingTreeSnapshot(workspace));
const verifier = spawnSync(process.execPath, [portableVerifier, workspace, String(totalUnits)], { encoding: "utf8" });
assert.equal(verifier.status, 0, verifier.stderr);
const afterVerify = workingTreeEvidenceDigest(workingTreeSnapshot(workspace));
assert.equal(afterVerify, beforeVerify);
const finalSnapshot = workingTreeSnapshot(workspace);
const finalFiles = Object.keys(finalSnapshot).sort();
const completedAt = new Date().toISOString();
task = writeTaskContract(workspace, {
  ...task,
  workPlan: task.workPlan.map((step) => ({ ...step, status: "done" })),
  observedChangedFiles: finalFiles,
  finalWorkingTreeFiles: finalFiles,
  finalFileDigests: finalSnapshot,
  changedFiles: finalFiles,
  verifyEvidence: [{
    command: task.verifyCommands[0], exitCode: 0, summary: verifier.stdout.trim(), recordedAt: completedAt, observedAt: completedAt,
    observed: true, matchedProfileCommand: true, isError: false, preWorkingTreeDigest: beforeVerify, workingTreeDigest: afterVerify
  }],
  trace: { outcome: "completed", recordedAt: completedAt },
  updatedAt: completedAt
});
recordCompletionAudit({ cwd: workspace, ui: { notify() {} } }, task, { outcome: "completed", phase: "review", idempotencyAt: completedAt });
const terminalResume = inspectTaskResumeState(workspace, task, sessionId);
assert.equal(terminalResume.decision, "terminal");

const finalState = state();
const telemetry = fs.readFileSync(path.join(workspace, ".pi", "piagent-state", "long-horizon", "telemetry.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const journal = readTaskJournal(workspace, { taskRunId });
const continuation = inspectTaskContinuationBudget(workspace, task);
const contextEfficiency = buildContextEfficiencyReport(workspace);
const finalDurableStateBytes = treeBytes(path.join(workspace, ".pi", "piagent-state"));
const stateSamples = telemetry.map((entry) => ({
  unit: entry.unit,
  processStart: entry.processStart,
  resumedFromUnit: entry.resumedFromUnit,
  compactions: entry.compactions,
  contextProxyTokens: entry.contextProxyTokens,
  durableStateBytes: entry.durableStateBytes
}));
const peakDurableStateBytes = Math.max(finalState.peakDurableStateBytes, finalDurableStateBytes);
const peakContextSample = stateSamples.reduce((peak, sample) => sample.contextProxyTokens > peak.contextProxyTokens ? sample : peak, stateSamples[0]);
const endedAtMs = Date.now();
const wallClockMilliseconds = endedAtMs - startedAtMs;
const completedFromResume = finalState.processStarts === 3
  && finalState.resumedUnits.includes(crashAfterUnit)
  && finalState.resumedUnits.includes(handoffAfterUnit)
  && terminalResume.decision === "terminal";
const wallClockQualified = wallClockMilliseconds >= lane.minimumWallClockMinutes * 60_000;
const report = {
  schemaVersion: 1,
  laneId: lane.id,
  workItem: lane.workItem,
  evidenceClass,
  startedAt,
  completedAt,
  logicalDurationMinutes: lane.logicalDurationMinutes,
  wallClockMilliseconds,
  wallClockMinutes: Number((wallClockMilliseconds / 60_000).toFixed(4)),
  minimumWallClockMinutes: lane.minimumWallClockMinutes,
  wallClockQualified,
  providerUsed: false,
  completedFromResume,
  lifecycle: {
    totalUnits,
    hardCrashAfterUnit: crashAfterUnit,
    handoffAfterUnit,
    processStarts: finalState.processStarts,
    hardCrashes: 1,
    resumedUnits: finalState.resumedUnits,
    compactions: finalState.compactions,
    handoffReadback: Boolean(crashHandoff && plannedHandoff),
    journalEvents: journal.events.length,
    journalCorruptions: journal.corruptions,
    terminalDecision: terminalResume.decision
  },
  context: {
    source: "deterministic-provider-free-proxy",
    observations: telemetry.length,
    peakProxyTokens: finalState.peakContextProxyTokens,
    peakObservedAtUnit: peakContextSample.unit,
    ceilingTokens: lane.contextProxyCeilingTokens,
    withinCeiling: finalState.peakContextProxyTokens <= lane.contextProxyCeilingTokens,
    efficiency: contextEfficiency.metrics
  },
  stateGrowth: {
    observations: telemetry.length,
    initialBytes: stateSamples[0].durableStateBytes,
    finalBytes: finalDurableStateBytes,
    growthBytes: finalDurableStateBytes - stateSamples[0].durableStateBytes,
    peakBytes: peakDurableStateBytes,
    ceilingBytes: lane.durableStateCeilingBytes,
    withinCeiling: peakDurableStateBytes <= lane.durableStateCeilingBytes,
    checkpointSequenceComplete: telemetry.length === totalUnits && telemetry.every((entry, index) => entry.unit === index + 1),
    samples: stateSamples
  },
  continuation: {
    firstAllowed: firstContinuation.allowed,
    secondAllowed: secondContinuation.allowed,
    secondReason: secondContinuation.reason,
    consumed: continuation.consumed,
    maximum: continuation.maximum,
    enforcementSafe: continuation.enforcementSafe
  },
  verification: {
    command: task.verifyCommands[0],
    exitCode: verifier.status,
    preWorkingTreeDigest: beforeVerify,
    workingTreeDigest: afterVerify,
    stableCurrentTree: beforeVerify === afterVerify,
    changedFiles: finalFiles,
    finalFileDigestCount: Object.keys(task.finalFileDigests).length
  },
  claimBoundary: lane.claimBoundary
};
assert.equal(report.completedFromResume, true);
assert.equal(report.context.withinCeiling, true);
assert.equal(report.stateGrowth.withinCeiling, true);
assert.equal(report.stateGrowth.checkpointSequenceComplete, true);
assert.equal(report.continuation.consumed, 1);
assert.equal(report.continuation.maximum, 1);
assert.equal(report.verification.stableCurrentTree, true);
if (!calibrationFast) assert.equal(report.wallClockQualified, true, `wall clock ${report.wallClockMinutes}m is below ${lane.minimumWallClockMinutes}m`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report)}\n`);

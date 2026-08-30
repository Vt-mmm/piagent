import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { appendContextTelemetry, contextEnginePaths, estimateContextTokens } from "../../packages/piagent-core/extensions/context-engine.js";
import { checkpointDigest, readCheckpoint, writeCheckpoint, writeCheckpointBytes } from "../../packages/piagent-core/benchmark/benchmark-checkpoint.js";
import { acquireBenchmarkRunLock } from "../../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../packages/piagent-core/extensions/local-state-path.js";
import { appendTaskJournalEventAtMost } from "../../packages/piagent-core/extensions/task-journal.js";
import { workingTreeSnapshot } from "../../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../../packages/piagent-core/extensions/working-tree-digest.js";

const [workspaceArgument, runtimeArgument] = process.argv.slice(2);
if (!workspaceArgument || !runtimeArgument) throw new Error("worker requires workspace and runtime specification");
const workspace = path.resolve(workspaceArgument);
const runtime = JSON.parse(Buffer.from(runtimeArgument, "base64url").toString("utf8"));
const privateRoot = ensurePrivateStateDirectory(workspace, path.join(workspace, ".pi", "piagent-state", "long-horizon"), "Long-horizon state");
const releaseWorker = acquireBenchmarkRunLock(privateRoot, runtime.taskRunId);
// An orphan must stop before another coordinator starts it. IPC disconnect is
// an observed loss of the parent, not a timeout-based guess about its liveness.
if (process.connected) process.once("disconnect", () => process.exit(76));
const statePath = resolveLocalStatePath(workspace, path.join(privateRoot, "state.json"), { label: "Long-horizon state" });
const workingSetPath = resolveLocalStatePath(workspace, path.join(privateRoot, "working-set.json"), { label: "Long-horizon working set" });
const telemetryPath = resolveLocalStatePath(workspace, path.join(privateRoot, "telemetry.jsonl"), { label: "Long-horizon telemetry" });
const artifactRoot = path.join(workspace, "artifacts", "long-horizon");
const unitRoot = path.join(artifactRoot, "units");
fs.mkdirSync(unitRoot, { recursive: true });

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function removeDeadWriterTemps(directory) {
  for (const name of fs.readdirSync(directory)) {
    const match = name.match(/\.(\d+)(?:\.[a-f0-9-]{36})?\.tmp$/);
    if (!match || processAlive(Number.parseInt(match[1], 10))) continue;
    const target = path.join(directory, name);
    try { if (fs.lstatSync(target).isFile()) fs.rmSync(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

removeDeadWriterTemps(privateRoot);
removeDeadWriterTemps(unitRoot);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

function writeAtomic(file, value, mode = 0o600) {
  writeCheckpointBytes(file, `${JSON.stringify(value)}\n`, mode);
}

function projectSources() {
  const values = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
      if ([".git", ".pi", "artifacts"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) values.push(path.relative(workspace, absolute).split(path.sep).join("/"));
    }
  };
  visit(workspace);
  return values;
}

function treeBytes(root) {
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) bytes += fs.statSync(absolute).size;
    }
  };
  visit(root);
  return bytes;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const sources = projectSources();
if (sources.length < runtime.totalUnits) throw new Error(`fixture has only ${sources.length} source files for ${runtime.totalUnits} units`);
const { stopAfterUnit, crashBoundary, ...stableRuntime } = runtime;
const binding = { runtime: stableRuntime, sources: sources.map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(workspace, file))).digest("hex")]) };
const checkpointPath = path.join(privateRoot, "checkpoint.json");
const checkpoint = readCheckpoint(checkpointPath, checkpointDigest(binding));
let state = checkpoint?.state ?? readJson(statePath, {
  schemaVersion: 1,
  laneId: runtime.laneId,
  taskId: runtime.taskId,
  taskRunId: runtime.taskRunId,
  currentUnit: 0,
  processStarts: 0,
  compactions: 0,
  peakContextProxyTokens: 0,
  peakDurableStateBytes: 0,
  activeMilliseconds: 0,
  resumedUnits: []
});
if (state.laneId !== runtime.laneId || state.taskId !== runtime.taskId || state.taskRunId !== runtime.taskRunId) throw new Error("long-horizon state identity mismatch");
if (!checkpoint && state.currentUnit !== 0) throw new Error("legacy long-horizon progress has no atomic checkpoint");
let workingSet = checkpoint?.workingSet ?? [];
const telemetry = checkpoint?.telemetry ?? [];
const contextEvents = checkpoint?.contextEvents ?? [];
if (telemetry.length !== state.currentUnit || telemetry.some((entry, index) => entry.unit !== index + 1)) throw new Error("invalid long-horizon checkpoint sequence");
for (let unit = 1; unit <= state.currentUnit; unit += 1) {
  const actual = readJson(path.join(unitRoot, `${String(unit).padStart(3, "0")}.json`));
  const [sourcePath, sourceDigest] = binding.sources[unit - 1];
  if (actual?.unit !== unit || actual.sourcePath !== sourcePath || actual.sourceDigest !== sourceDigest) throw new Error("completed long-horizon artifact changed");
}

function projectCheckpoint() {
  writeAtomic(statePath, state);
  writeAtomic(workingSetPath, workingSet);
  writeCheckpointBytes(telemetryPath, telemetry.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const contextPath = resolveLocalStatePath(workspace, contextEnginePaths(workspace).telemetry);
  ensurePrivateStateDirectory(workspace, path.dirname(contextPath));
  // These events belong only to this owned provider-free fixture. The atomic
  // checkpoint is authoritative; partial/uncommitted projections are rebuilt.
  writeCheckpointBytes(contextPath, contextEvents.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  // Replay the committed prefix to repair a checkpoint-before-projection crash,
  // but never append the same unit again. The raw append API does not dedupe.
  for (const entry of telemetry) {
    const data = { unit: entry.unit, logicalMinute: entry.unit, sourceDigest: binding.sources[entry.unit - 1][1], currentWorkingTreeDigest: entry.currentWorkingTreeDigest };
    const { record } = appendTaskJournalEventAtMost(workspace, {
      eventType: "long-horizon-progress", taskId: runtime.taskId, taskRunId: runtime.taskRunId,
      sessionId: runtime.sessionId, idempotencyKey: `long-horizon:${entry.unit}`, data
    }, { maximum: runtime.totalUnits, recordedAt: entry.recordedAt });
    // A conflicting key or exhausted budget must not silently erase evidence.
    if (!record || record.taskId !== runtime.taskId || record.sessionId !== runtime.sessionId
      || record.recordedAt !== entry.recordedAt || JSON.stringify(record.data) !== JSON.stringify(data)) {
      throw new Error(`long-horizon journal projection mismatch at unit ${entry.unit}`);
    }
  }
}

function commitCheckpoint() {
  writeCheckpoint(checkpointPath, checkpointDigest(binding), { state, workingSet, telemetry, contextEvents });
  projectCheckpoint();
}

const startingUnit = state.currentUnit;
state.processStarts += 1;
if (startingUnit > 0) state.resumedUnits.push(startingUnit);
commitCheckpoint();

async function boundary(unit) {
  if (unit === crashBoundary) {
    process.send?.({ type: "crash-boundary", unit });
    await new Promise(() => { setInterval(() => {}, 1_000); });
  }
  if (unit === stopAfterUnit && unit < runtime.totalUnits) process.exit(75);
}
await boundary(startingUnit);
let activeSince = performance.now();

for (let unit = startingUnit + 1; unit <= runtime.totalUnits; unit += 1) {
  const sourcePath = sources[(unit - 1) % sources.length];
  const source = fs.readFileSync(path.join(workspace, sourcePath));
  const sourceDigest = crypto.createHash("sha256").update(source).digest("hex");
  const unitRecord = { schemaVersion: 1, unit, logicalMinute: unit, sourcePath, sourceDigest };
  writeAtomic(path.join(unitRoot, `${String(unit).padStart(3, "0")}.json`), unitRecord, 0o644);
  workingSet.push({ unit, sourcePath, sourceDigest, observation: `validated-${unit}-${sourceDigest.slice(0, 16)}` });
  const beforeCompactionTokens = estimateContextTokens(JSON.stringify(workingSet));
  state.peakContextProxyTokens = Math.max(state.peakContextProxyTokens, beforeCompactionTokens);
  if (runtime.compactionUnits.includes(unit)) {
    workingSet = [{ unit, compactedThrough: unit, retainedDigest: crypto.createHash("sha256").update(JSON.stringify(workingSet)).digest("hex") }];
    state.compactions += 1;
    contextEvents.push(appendContextTelemetry(workspace, { event: "session_compact", taskRunId: runtime.taskRunId, unit, reason: "long-horizon-boundary", fromExtension: true }));
  }
  const currentWorkingTreeDigest = workingTreeEvidenceDigest(workingTreeSnapshot(workspace));
  contextEvents.push(appendContextTelemetry(workspace, {
    event: "agent_prompt",
    taskRunId: runtime.taskRunId,
    unit,
    activeTools: 4,
    systemPromptTokens: 1006,
    toolSchemaTokens: 872,
    contextProxyTokens: beforeCompactionTokens,
    source: "deterministic-provider-free-proxy"
  }));
  const durableStateBytes = treeBytes(path.join(workspace, ".pi", "piagent-state"));
  state.currentUnit = unit;
  state.peakDurableStateBytes = Math.max(state.peakDurableStateBytes, durableStateBytes);
  state.lastWorkingTreeDigest = currentWorkingTreeDigest;
  state.updatedAt = new Date().toISOString();
  state.activeMilliseconds += performance.now() - activeSince;
  telemetry.push({
    schemaVersion: 1,
    recordedAt: state.updatedAt,
    processId: process.pid,
    processStart: state.processStarts,
    unit,
    resumedFromUnit: startingUnit,
    contextProxyTokens: beforeCompactionTokens,
    durableStateBytes,
    compactions: state.compactions,
    currentWorkingTreeDigest
  });
  commitCheckpoint();
  activeSince = performance.now();
  await boundary(unit);
  if (unit < runtime.totalUnits) await sleep(runtime.tickMilliseconds);
}

const unitFiles = fs.readdirSync(unitRoot).filter((file) => file.endsWith(".json")).sort();
const aggregate = crypto.createHash("sha256");
for (const file of unitFiles) aggregate.update(fs.readFileSync(path.join(unitRoot, file)));
writeAtomic(path.join(artifactRoot, "report.json"), {
  schemaVersion: 1,
  laneId: runtime.laneId,
  taskRunId: runtime.taskRunId,
  completedUnits: unitFiles.length,
  logicalDurationMinutes: runtime.logicalDurationMinutes,
  aggregateDigest: aggregate.digest("hex")
}, 0o644);
releaseWorker();
process.exit(0);

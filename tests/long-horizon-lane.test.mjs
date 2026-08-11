import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const laneRoot = path.join(root, "evals", "long-horizon-v1");
const lane = JSON.parse(fs.readFileSync(path.join(laneRoot, "lane.json"), "utf8"));

test("long-horizon lane freezes a 30-to-90 minute lifecycle contract without a provider claim", () => {
  assert.equal(lane.id, "long-horizon-v1");
  assert.equal(lane.workItem, "CF-FS4-03");
  assert.equal(lane.logicalDurationMinutes, 90);
  assert.equal(lane.minimumWallClockMinutes, 30);
  assert.equal(lane.totalUnits, 90);
  assert.equal(lane.hardCrashAfterUnit, 30);
  assert.equal(lane.handoffAfterUnit, 60);
  assert.deepEqual(lane.compactionUnits, [20, 40, 60, 80]);
  assert.equal(lane.tickMilliseconds, 21_000);
  assert.equal(lane.continuationBudget, 1);
  assert.equal(lane.providerRequired, false);
  assert.match(lane.claimBoundary, /no model quality, token, latency, 90-minute wall-clock, generalization, or release claim/);
});

test("retained 30-minute evidence proves the bounded lifecycle contract without private state", () => {
  const reportPath = path.join(laneRoot, "reports", "provider-free-30m-run.v1.json");
  const reportText = fs.readFileSync(reportPath, "utf8");
  const report = JSON.parse(reportText);
  assert.equal(fs.statSync(reportPath).mode & 0o777, 0o644);
  assert.equal(report.evidenceClass, "provider-free-long-horizon");
  assert.equal(report.wallClockQualified, true);
  assert.ok(report.wallClockMinutes >= 30);
  assert.equal(report.providerUsed, false);
  assert.equal(report.completedFromResume, true);
  assert.deepEqual(report.lifecycle.resumedUnits, [30, 60]);
  assert.equal(report.lifecycle.totalUnits, 90);
  assert.equal(report.lifecycle.processStarts, 3);
  assert.equal(report.lifecycle.hardCrashes, 1);
  assert.equal(report.lifecycle.compactions, 4);
  assert.equal(report.lifecycle.handoffReadback, true);
  assert.deepEqual(report.lifecycle.journalCorruptions, []);
  assert.equal(report.lifecycle.terminalDecision, "terminal");
  assert.equal(report.context.observations, 90);
  assert.equal(report.context.withinCeiling, true);
  assert.ok(report.context.peakProxyTokens <= report.context.ceilingTokens);
  assert.equal(report.stateGrowth.observations, 90);
  assert.equal(report.stateGrowth.samples.length, 90);
  assert.equal(report.stateGrowth.checkpointSequenceComplete, true);
  assert.equal(report.stateGrowth.withinCeiling, true);
  assert.equal(report.stateGrowth.growthBytes, report.stateGrowth.finalBytes - report.stateGrowth.initialBytes);
  assert.deepEqual(report.stateGrowth.samples.map((sample) => sample.unit), Array.from({ length: 90 }, (_, index) => index + 1));
  assert.deepEqual(report.continuation, {
    firstAllowed: true,
    secondAllowed: false,
    secondReason: "global-budget-exhausted",
    consumed: 1,
    maximum: 1,
    enforcementSafe: true
  });
  assert.equal(report.verification.exitCode, 0);
  assert.equal(report.verification.stableCurrentTree, true);
  assert.equal(report.verification.preWorkingTreeDigest, report.verification.workingTreeDigest);
  assert.equal(report.verification.finalFileDigestCount, 91);
  assert.doesNotMatch(reportText, /(?:\/var\/folders|\/private\/tmp|auth\.json|access[_-]?token|refresh[_-]?token)/i);
});

test("fast calibration survives hard death and two process resumes with bounded state", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-long-horizon-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "report.json");
  const result = spawnSync(process.execPath, [path.join(laneRoot, "runner.mjs"), "--calibration-fast", "--tick-ms", "2", "--output", output], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(report.evidenceClass, "calibration-fast");
  assert.equal(report.providerUsed, false);
  assert.equal(report.completedFromResume, true);
  assert.deepEqual(report.lifecycle.resumedUnits, [3, 6]);
  assert.equal(report.lifecycle.processStarts, 3);
  assert.equal(report.lifecycle.hardCrashes, 1);
  assert.equal(report.lifecycle.compactions, 4);
  assert.equal(report.lifecycle.handoffReadback, true);
  assert.equal(report.lifecycle.journalCorruptions.length, 0);
  assert.equal(report.lifecycle.terminalDecision, "terminal");
  assert.equal(report.context.withinCeiling, true);
  assert.equal(report.stateGrowth.withinCeiling, true);
  assert.equal(report.stateGrowth.checkpointSequenceComplete, true);
  assert.equal(report.stateGrowth.samples.length, 9);
  assert.deepEqual(report.stateGrowth.samples.map((sample) => sample.unit), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(report.stateGrowth.finalBytes >= report.stateGrowth.initialBytes);
  assert.equal(report.stateGrowth.growthBytes, report.stateGrowth.finalBytes - report.stateGrowth.initialBytes);
  assert.deepEqual(report.continuation, {
    firstAllowed: true,
    secondAllowed: false,
    secondReason: "global-budget-exhausted",
    consumed: 1,
    maximum: 1,
    enforcementSafe: true
  });
  assert.equal(report.verification.stableCurrentTree, true);
  assert.equal(report.verification.preWorkingTreeDigest, report.verification.workingTreeDigest);
  const expectedChangedFiles = [
    "artifacts/long-horizon/report.json",
    ...Array.from({ length: 9 }, (_, index) => `artifacts/long-horizon/units/${String(index + 1).padStart(3, "0")}.json`)
  ];
  assert.deepEqual(report.verification.changedFiles, expectedChangedFiles);
  assert.equal(report.verification.finalFileDigestCount, expectedChangedFiles.length);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("worker refuses a cross-task durable state before writing a unit", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-long-horizon-identity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "project");
  fs.cpSync(path.resolve(laneRoot, lane.fixture), workspace, { recursive: true });
  const stateRoot = path.join(workspace, ".pi", "piagent-state", "long-horizon");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "state.json"), `${JSON.stringify({ schemaVersion: 1, laneId: lane.id, taskId: "foreign", taskRunId: "foreign-run", currentUnit: 0 })}\n`);
  const runtime = Buffer.from(JSON.stringify({
    laneId: lane.id, taskId: "expected", taskRunId: "expected-run", sessionId: "session",
    totalUnits: 1, logicalDurationMinutes: 90, compactionUnits: [], tickMilliseconds: 1
  })).toString("base64url");
  const result = spawnSync(process.execPath, [path.join(laneRoot, "worker.mjs"), workspace, runtime], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /state identity mismatch/);
  assert.equal(fs.existsSync(path.join(workspace, "artifacts", "long-horizon", "units", "001.json")), false);
});

test("wall-clock evidence rejects accelerated timing overrides", () => {
  const result = spawnSync(process.execPath, [path.join(laneRoot, "runner.mjs"), "--tick-ms", "1", "--output", path.join(os.tmpdir(), "not-written.json")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wall-clock evidence cannot override tick duration/);
});

test("standalone verifier rejects missing or reordered durable units", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-long-horizon-verifier-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "artifacts", "long-horizon", "units"), { recursive: true });
  fs.writeFileSync(path.join(directory, "artifacts", "long-horizon", "report.json"), `${JSON.stringify({ completedUnits: 1, aggregateDigest: "0".repeat(64) })}\n`);
  const result = spawnSync(process.execPath, [path.join(laneRoot, "verify.mjs"), directory, "2"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0 !== 2/);
});

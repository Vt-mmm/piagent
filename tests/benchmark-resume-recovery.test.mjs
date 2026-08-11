import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { expectedBenchmarkRecord } from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { emptyBenchmarkLedgerBinding, inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import {
  persistUnacceptedBenchmarkAttempt,
  promoteMeasuredBenchmarkRecord,
  recoverOrphanedBenchmarkAttempts,
  recoverPendingBenchmarkRecord,
  stageMeasuredBenchmarkRecord
} from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";

const hash = "a".repeat(64);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function record(overrides = {}) {
  return {
    schemaVersion: 1, runId: "run", attemptId: "attempt", configurationDigest: hash, orderIndex: 1,
    scenarioId: "task", scenarioTitle: "Task", scenarioKind: "source-change", category: "code", difficulty: "small",
    profile: "node", lifecycle: "steady-state", surface: "raw-pi", repeat: 1, infrastructureAttempt: 1,
    infrastructureAttempts: 1, infrastructureRetries: 0, infrastructureFailures: [], sessionId: "session", abortSuite: false,
    resolved: true, agent: { exitCode: 0, timedOut: false, stdoutHash: hash, stderrHash: hash },
    grade: { passed: true, score: 10, checks: [] }, graderIntegrity: { passed: true },
    scope: { passed: true, changedFiles: [], outsideScope: [] }, outputSafety: { passed: true, forbiddenHits: [] },
    outputEvidence: { passed: true, requiredCount: 0 }, durationSeconds: 1, promptHash: hash,
    variant: { generated: false, fixtureDigest: hash },
    usageStatus: "measured", usage: { sessions: 1, fresh: 3, input: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3, cost: null, costSource: "unavailable" },
    ...overrides
  };
}

test("expected record binds exact surface and repeat before append", () => {
  const suite = { profile: "node" };
  const expected = { scenario: { id: "task", title: "Task", kind: "source-change", category: "code", difficulty: "small" }, surface: "raw-pi", repeat: 1 };
  assert.equal(expectedBenchmarkRecord(record(), 0, expected, "run", suite, hash), true);
  assert.equal(expectedBenchmarkRecord(record({ surface: "piagent" }), 0, expected, "run", suite, hash), false);
  assert.equal(expectedBenchmarkRecord(record({ repeat: 2 }), 0, expected, "run", suite, hash), false);
});

test("known failed-attempt usage remains claimable while unknown usage closes claims", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-known-attempt-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const known = { schemaVersion: 1, runId: "run", ledger: null };
  persistUnacceptedBenchmarkAttempt({ runRoot, manifest: known, record: record({ abortSuite: true, infrastructureFailure: "transport-after-usage" }) });
  assert.equal(known.tokenClaimsUnavailableReason, undefined);
  assert.equal(known.recoveredProviderAttempts[0].usage.fresh, 3);

  const unknownRoot = path.join(runRoot, "unknown");
  fs.mkdirSync(unknownRoot);
  const unknown = { schemaVersion: 1, runId: "run", ledger: null };
  persistUnacceptedBenchmarkAttempt({
    runRoot: unknownRoot,
    manifest: unknown,
    record: record({ abortSuite: true, usageStatus: "unknown-after-provider-start", usage: { sessions: 0, fresh: 0 }, infrastructureFailure: "transport-unknown" })
  });
  assert.equal(unknown.tokenClaimsUnavailableReason, "one-or-more-provider-attempts-have-unaccepted-or-unknown-usage");
});

test("measured-session WAL without a post-session guard stays unaccepted on resume", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-wal-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const suite = { profile: "node" };
  const expected = { scenario: { id: "task", title: "Task", kind: "source-change", category: "code", difficulty: "small" }, surface: "raw-pi", repeat: 1 };
  const ledger = emptyBenchmarkLedgerBinding();
  const manifest = { schemaVersion: 1, runId: "run", configurationDigest: hash, ledger };
  const measured = record();
  stageMeasuredBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, record: measured, infrastructureFailures: [], index: 0, expected, runId: "run", suite, configurationDigest: hash, runs: [] });
  const measuredPath = path.join(runRoot, "measured-record-ready.json");
  const measuredReady = JSON.parse(fs.readFileSync(measuredPath));
  const recovered = recoverPendingBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, completedRuns: [], pending: null, measuredReady, fullOrder: [expected], suite });
  assert.equal(recovered.completedRuns.length, 0);
  assert.equal(recovered.ledgerBinding.records, 0);
  assert.equal(manifest.recoveredProviderAttempts[0].attemptId, measured.attemptId);
  assert.equal(manifest.tokenClaimsUnavailableReason, undefined);
  assert.equal(fs.existsSync(measuredPath), false);
});

test("post-session guard receipt makes the completed WAL promotable byte-identically", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-guarded-session-wal-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const suite = { profile: "node" };
  const expected = { scenario: { id: "task", title: "Task", kind: "source-change", category: "code", difficulty: "small" }, surface: "raw-pi", repeat: 1 };
  const ledger = emptyBenchmarkLedgerBinding();
  const manifest = { schemaVersion: 1, runId: "run", configurationDigest: hash, ledger };
  const measured = record();
  stageMeasuredBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, record: measured, infrastructureFailures: [], index: 0, expected, runId: "run", suite, configurationDigest: hash, runs: [] });
  promoteMeasuredBenchmarkRecord({ runRoot, ledgerBinding: ledger, record: measured, postSessionGuard: { stage: "after-session:task:raw-pi:r1:attempt1", matched: true } });
  const pendingPath = path.join(runRoot, "pending-record.json");
  const pendingBytes = fs.readFileSync(pendingPath);
  const pending = JSON.parse(pendingBytes);
  const recovered = recoverPendingBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, completedRuns: [], pending, measuredReady: null, fullOrder: [expected], suite });
  assert.equal(recovered.completedRuns.length, 1);
  assert.deepEqual(recovered.completedRuns[0], measured);
  assert.equal(fs.existsSync(pendingPath), false);
  assert.deepEqual(inspectBenchmarkLedger(path.join(runRoot, "runs.jsonl")).records, [measured]);
  assert.ok(pendingBytes.length > 0);
});

test("orphan recovery is idempotent and preserves exact usage without disabling claims", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-orphan-wal-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const workspace = path.join(runRoot, "workspaces", "01-task-raw-pi");
  fs.mkdirSync(workspace, { recursive: true });
  const project = path.join(workspace, "project");
  fs.mkdirSync(project);
  git(project, ["init", "-q"]);
  git(project, ["config", "user.email", "benchmark@piagent.local"]);
  git(project, ["config", "user.name", "Piagent Benchmark"]);
  fs.writeFileSync(path.join(project, "task.js"), "export const value = 1;\n");
  git(project, ["add", "task.js"]);
  git(project, ["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(project, "task.js"), "export const value = 2;\n");
  if (process.platform !== "win32") fs.chmodSync(path.join(project, "task.js"), 0o644);
  const projectDigest = workingTreeEvidenceDigest(workingTreeSnapshot(project));
  const sessions = path.join(workspace, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "session.jsonl"), "{}\n", { mode: 0o644 });
  const inflight = {
    schemaVersion: 1, runId: "run", attemptId: "attempt", orderIndex: 1, scenarioId: "task",
    surface: "raw-pi", repeat: 1, infrastructureAttempt: 1, stage: "provider-returned", usage: record().usage
  };
  const inflightPath = path.join(workspace, "inflight.json");
  fs.writeFileSync(inflightPath, `${JSON.stringify(inflight)}\n`, { mode: 0o600 });
  const manifest = { schemaVersion: 1, runId: "run", configurationDigest: hash, ledger: emptyBenchmarkLedgerBinding() };
  const fullOrder = [{ scenario: { id: "task" }, surface: "raw-pi", repeat: 1 }];
  const first = recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys: new Set() });
  assert.equal(first.get(["task", "raw-pi", "1"].join("\0")).length, 1);
  assert.equal(manifest.tokenClaimsUnavailableReason, undefined);
  assert.equal(manifest.recoveredProviderAttempts[0].usageStatus, "measured-but-unaccepted");
  assert.equal(workingTreeEvidenceDigest(workingTreeSnapshot(project)), projectDigest);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(project, "task.js")).mode & 0o777, 0o644);
    assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
    assert.equal(fs.statSync(sessions).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(sessions, "session.jsonl")).mode & 0o777, 0o600);
  }

  fs.writeFileSync(inflightPath, `${JSON.stringify(inflight)}\n`, { mode: 0o600 });
  const second = recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys: new Set() });
  assert.equal(second.get(["task", "raw-pi", "1"].join("\0")).length, 1);
  assert.equal(manifest.recoveredProviderAttempts.length, 1);
});

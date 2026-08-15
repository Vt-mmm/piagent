import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { benchmarkCandidateProvenance } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { appendBenchmarkLedger, emptyBenchmarkLedgerBinding } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { projectBenchmarkReleaseMonitor } from "../packages/piagent-webui/server/benchmark-release-monitor.ts";
import { routeReadOnlyRequest } from "../packages/piagent-webui/server/read-only-router.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const hash = "a".repeat(64);
const identity = { projectRef: "project.fixture", runtimeInstanceId: "runtime.fixture", sessionRef: "session.fixture",
  taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function candidateDigest(cwd) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd })
    .toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(cwd, relative), stat = fs.lstatSync(absolute);
    digest.update(relative).update("\0").update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute)).update("\0");
  }
  return digest.digest("hex");
}
function record(runId) {
  return { schemaVersion: 1, runId, attemptId: "attempt.secret-session", configurationDigest: hash, orderIndex: 1,
    scenarioId: "task", scenarioTitle: "Task", scenarioKind: "source-change", category: "code", difficulty: "small",
    profile: "node", lifecycle: "steady-state", surface: "piagent", repeat: 1, infrastructureAttempt: 1, infrastructureAttempts: 1,
    sessionId: "raw-session-must-not-leak", abortSuite: false, resolved: true,
    agent: { exitCode: 0, timedOut: false, stdoutHash: hash, stderrHash: hash },
    grade: { passed: true, score: 10, checks: [] }, graderIntegrity: { passed: true },
    scope: { passed: true, changedFiles: [], outsideScope: [] }, outputSafety: { passed: true, forbiddenHits: [] },
    outputEvidence: { passed: true, requiredCount: 0 }, durationSeconds: 1, promptHash: hash,
    variant: { generated: false, fixtureDigest: hash },
    usage: { sessions: 1, fresh: 3, input: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3, cost: null, costSource: "unavailable" } };
}

function fixture(t) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-release-monitor-")); t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const cwd = path.join(outer, "repo"), benchmarkRoot = path.join(outer, "benchmarks"), releaseReportPath = path.join(outer, "release-report.json");
  fs.mkdirSync(cwd); fs.mkdirSync(benchmarkRoot); fs.writeFileSync(path.join(cwd, "source.txt"), "current source\n");
  git(cwd, ["init", "-q"]); git(cwd, ["config", "user.email", "fixture@example.invalid"]); git(cwd, ["config", "user.name", "Fixture"]);
  git(cwd, ["add", "source.txt"]); git(cwd, ["commit", "-qm", "fixture"]);
  const runId = "production-v1-20260814T120000Z-fixture", runRoot = path.join(benchmarkRoot, runId); fs.mkdirSync(runRoot);
  const measured = record(runId); let ledger = emptyBenchmarkLedgerBinding(); ledger = appendBenchmarkLedger(path.join(runRoot, "runs.jsonl"), measured, ledger);
  const provenance = benchmarkCandidateProvenance(cwd), commit = git(cwd, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(runRoot, "report.json"), `${JSON.stringify({ schemaVersion: 2, runId,
    startedAt: "2026-08-14T10:00:00.000Z", completedAt: "2026-08-14T11:00:00.000Z", suite: { id: "production-v1" },
    runCount: 1, runs: [measured], ledger, environment: { candidateProvenance: provenance, source: { commit } }, verdict: { status: "passed" },
    surfaces: { piagent: { scores: { quality: 9, safety: 10, reliability: 9, workflow: 9, efficiency: 8, overall: 9 } } },
    comparison: { productionGate: { passed: true }, tokenClaimAllowed: true, claimEligibility: { achievedTier: "production-shadow" } }
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(releaseReportPath, `${JSON.stringify({ schemaVersion: 1, reportVersion: "rc-local-readiness-v1", generatedAt: "2026-08-14T11:30:00.000Z",
    matrix: { repository: { head: commit, candidateContentDigest: candidateDigest(cwd) } },
    readiness: { localSafeGate: "passed", rcAssembly: "ready", beta: "blocked", gaRelease: "blocked", blockers: ["explicit operator approval missing"] },
    authorization: { releaseCommit: false, tag: false, publish: false, push: false }
  }, null, 2)}\n`, { mode: 0o600 });
  return { cwd, benchmarkRoot, releaseReportPath, runRoot };
}

function writeBenchmarkRun(cwd, benchmarkRoot, runId, ordinal) {
  const runRoot = path.join(benchmarkRoot, runId); fs.mkdirSync(runRoot);
  const measured = record(runId); measured.attemptId = `attempt-${ordinal}`; measured.sessionId = `private-session-${ordinal}`;
  let ledger = emptyBenchmarkLedgerBinding(); ledger = appendBenchmarkLedger(path.join(runRoot, "runs.jsonl"), measured, ledger);
  const provenance = benchmarkCandidateProvenance(cwd), commit = git(cwd, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(runRoot, "report.json"), `${JSON.stringify({ schemaVersion: 2, runId,
    startedAt: "2026-08-14T10:00:00.000Z", completedAt: "2026-08-14T11:00:00.000Z", suite: { id: "production-v1" },
    runCount: 1, runs: [measured], ledger, environment: { candidateProvenance: provenance, source: { commit } }, verdict: { status: "passed" },
    surfaces: { piagent: { scores: { quality: 9, safety: 10, reliability: 9, workflow: 9, efficiency: 8, overall: 9 } } },
    comparison: { productionGate: { passed: true }, tokenClaimAllowed: true, claimEligibility: { achievedTier: "production-shadow" } }
  })}\n`, { mode: 0o600 });
  return runRoot;
}

test("release monitor binds current benchmark ledger and RC candidate without leaking private evidence", async (t) => {
  const value = projectBenchmarkReleaseMonitor({ ...fixture(t), identity, generatedAt: "2026-08-14T12:00:00.000Z" });
  assert.equal(value.state, "ready"); assert.equal(value.benchmark.state, "ready"); assert.equal(value.benchmark.runs.length, 1);
  assert.equal(value.benchmark.runs[0].sourceState, "current"); assert.equal(value.benchmark.runs[0].releaseGate, "passed");
  assert.equal(value.release.state, "ready"); assert.equal(value.release.localSafeGate, "passed");
  assert.deepEqual(value.actions, { runBenchmark: false, resumeBenchmark: false, releaseCommit: false, tag: false, publish: false, push: false });
  const serialized = JSON.stringify(value);
  for (const secret of ["raw-session-must-not-leak", "attempt.secret-session", hash, "promptHash", "sessionId", "report.json", "runs.jsonl"])
    assert.equal(serialized.includes(secret), false, `private evidence leaked: ${secret}`);
  const registry = createWebUiSchemaRegistry(); assert.equal(validateFixture(registry, "release-monitor-v1", value).valid, true);

  const routed = await routeReadOnlyRequest(new URL("http://127.0.0.1/api/v1/monitoring/release"), { releaseMonitor: () => value });
  assert.equal(routed.handled, true); assert.equal(routed.status, 200); assert.equal(routed.value, value);
});

test("release monitor marks source changes stale and fails closed on a tampered ledger", (t) => {
  const current = fixture(t); fs.appendFileSync(path.join(current.cwd, "source.txt"), "changed after evidence\n");
  const stale = projectBenchmarkReleaseMonitor({ ...current, identity, generatedAt: "2026-08-14T12:00:00.000Z" });
  assert.equal(stale.benchmark.runs[0].sourceState, "stale"); assert.equal(stale.release.state, "stale"); assert.equal(stale.health.state, "degraded");
  fs.appendFileSync(path.join(current.runRoot, "runs.jsonl"), "{}\n");
  const corrupt = projectBenchmarkReleaseMonitor({ ...current, identity, generatedAt: "2026-08-14T12:00:00.000Z" });
  assert.equal(corrupt.benchmark.state, "unavailable"); assert.deepEqual(corrupt.benchmark.runs, []);
  assert.equal(corrupt.benchmark.warnings[0].code, "benchmark-evidence-corrupt");
});

test("release monitor projection performs no model turn and never mutates benchmark or release evidence", (t) => {
  const current = fixture(t), before = fs.readdirSync(current.runRoot).sort(); let modelTurns = 0;
  const value = projectBenchmarkReleaseMonitor({ ...current, identity, generatedAt: "2026-08-14T12:00:00.000Z", modelTurn: () => { modelTurns += 1; } });
  assert.equal(value.state, "ready"); assert.equal(modelTurns, 0); assert.deepEqual(fs.readdirSync(current.runRoot).sort(), before);
});

test("release monitor caps directory and run scale, deduplicates run authority and rejects oversized or symlinked reports", (t) => {
  const current = fixture(t);
  for (let index = 1; index < 25; index += 1) writeBenchmarkRun(current.cwd, current.benchmarkRoot,
    `production-v1-20260814T12${String(index).padStart(4, "0")}Z-${String(index).padStart(6, "0")}`, index);
  const duplicate = path.join(current.benchmarkRoot, "duplicate-newest"); fs.mkdirSync(duplicate);
  fs.copyFileSync(path.join(current.runRoot, "report.json"), path.join(duplicate, "report.json"));
  fs.copyFileSync(path.join(current.runRoot, "runs.jsonl"), path.join(duplicate, "runs.jsonl"));
  fs.utimesSync(current.runRoot, 2_000_000_000, 2_000_000_000); fs.utimesSync(duplicate, 2_000_000_001, 2_000_000_001);
  for (let index = 0; index < 79; index += 1) {
    const directory = path.join(current.benchmarkRoot, `legacy-empty-${String(index).padStart(3, "0")}`); fs.mkdirSync(directory); fs.utimesSync(directory, 1, 1);
  }
  const value = projectBenchmarkReleaseMonitor({ ...current, identity, generatedAt: "2026-08-14T12:00:00.000Z" });
  assert.equal(value.benchmark.runs.length, 20); assert.equal(new Set(value.benchmark.runs.map((run) => run.runRef)).size, 20);
  assert.equal(value.benchmark.page.truncated, true); assert.ok(value.benchmark.warnings.some((warning) => warning.code === "benchmark-directory-truncated"));
  assert.ok(value.benchmark.warnings.some((warning) => warning.code === "benchmark-evidence-corrupt"));
  assert.equal(validateFixture(createWebUiSchemaRegistry(), "release-monitor-v1", value).valid, true);

  const bad = fixture(t), external = path.join(path.dirname(bad.benchmarkRoot), "external-report.json"); fs.writeFileSync(external, "{}\n");
  fs.rmSync(path.join(bad.runRoot, "report.json")); fs.symlinkSync(external, path.join(bad.runRoot, "report.json"));
  assert.equal(projectBenchmarkReleaseMonitor({ ...bad, identity }).benchmark.state, "unavailable");
  fs.rmSync(path.join(bad.runRoot, "report.json")); fs.writeFileSync(path.join(bad.runRoot, "report.json"), "{}");
  fs.truncateSync(path.join(bad.runRoot, "report.json"), 32 * 1024 * 1024 + 1);
  const oversized = projectBenchmarkReleaseMonitor({ ...bad, identity }); assert.equal(oversized.benchmark.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(oversized), /external-report|report\.json|runs\.jsonl/);
});

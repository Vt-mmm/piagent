import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadReplayFailurePlan } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { appendBenchmarkLedger, emptyBenchmarkLedgerBinding } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { assertDiagnosticBenchmarkMatrix } from "../packages/piagent-core/benchmark/benchmark-diagnostic-treatment.js";

function fixture(t, mutate = value => value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "failed-attempt-replay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = mutate([
    ["a", "piagent", false], ["a", "codex-cli", true],
    ["b", "codex-cli", false], ["b", "piagent", true],
    ["c", "piagent", false], ["c", "codex-cli", false]
  ].map(([scenarioId, surface, resolved], index) => ({ scenarioId, surface, resolved,
    repeat: index < 4 ? 1 : 2, orderIndex: index + 1, usage: { usageCompleteness: "exact" },
    outcome: { runValidity: "valid" } })));
  let ledger = emptyBenchmarkLedgerBinding();
  for (const run of runs) ledger = appendBenchmarkLedger(path.join(root, "runs.jsonl"), run, ledger);
  const report = { runId: "source-run", completedAt: "2026-09-21T10:19:20Z", ledger, runs,
    suite: { id: "production-v3" }, environment: { variantRootSeed: "unchanged-seed",
      surfaces: ["piagent", "codex-cli"], suiteDigest: "a".repeat(64),
      candidateProvenance: { contentDigest: "b".repeat(64) } } };
  const reportPath = path.join(root, "report.json");
  const manifest = { runId: report.runId, ledger, suiteDigest: report.environment.suiteDigest,
    candidateProvenance: report.environment.candidateProvenance };
  fs.writeFileSync(reportPath, JSON.stringify(report));
  fs.writeFileSync(path.join(root, "run-manifest.json"), JSON.stringify(manifest));
  return { root, report, reportPath, load: () => loadReplayFailurePlan(reportPath, { failedAttemptsOnly: true }) };
}

test("exact failed replay includes Codex-only failures and excludes previous PASS partners", t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.root, "runs.jsonl"));
  const plan = f.load();
  assert.deepEqual(plan.replayRuns, [
    { scenarioId: "a", surface: "piagent", repeat: 1 },
    { scenarioId: "b", surface: "codex-cli", repeat: 1 },
    { scenarioId: "c", surface: "piagent", repeat: 2 },
    { scenarioId: "c", surface: "codex-cli", repeat: 2 }
  ]);
  assert.equal(plan.seed, "unchanged-seed");
  assert.equal(plan.source.selection, "failed-attempts");
  assert.equal(plan.source.selectedAttempts, 4);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "runs.jsonl")), before);
  assert.deepEqual(loadReplayFailurePlan(f.reportPath).replayRuns.map(x => x.scenarioId), ["a", "a", "c", "c"],
    "legacy paired replay keeps its original behavior");
});

for (const [name, mutate, pattern] of [
  ["duplicate coordinate", runs => [...runs, runs[0]], /duplicate attempt/],
  ["unknown usage", runs => { runs[0].usage.usageCompleteness = "unknown"; return runs; }, /exactly accounted/],
  ["invalid harness", runs => { runs[0].outcome.runValidity = "invalid_harness"; return runs; }, /valid, exactly/],
  ["all pass", runs => runs.map(x => ({ ...x, resolved: true })), /no failed attempts/]
]) test(`failed replay rejects ${name}`, t => assert.throws(fixture(t, mutate).load, pattern));

test("failed replay needs complete immutable source evidence and cannot accept abort markers", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "aborted.json"), "{}");
  assert.throws(f.load, /without aborted.json/);
  fs.unlinkSync(path.join(f.root, "aborted.json"));
  f.report.runs[0].resolved = true;
  fs.writeFileSync(f.reportPath, JSON.stringify(f.report));
  assert.throws(f.load, /do not match its bound ledger/);
  fs.unlinkSync(path.join(f.root, "run-manifest.json"));
  assert.throws(f.load, /completed, ledger-bound/);
});

test("failed-only CLI remains an explicit measurement replay, not a generic gate bypass", () => {
  const args = ["--replay-failures", "/tmp/report.json", "--failed-attempts-only", "--measurement-only"];
  assert.equal(parseBenchmarkArgs(args).failedAttemptsOnly, true);
  for (const bad of [["--failed-attempts-only"], args.concat("--resume", "/tmp/run"),
    args.concat("--scenarios", "a"), args.concat("--failed-attempts-only"),
    args.filter(x => x !== "--measurement-only")]) assert.throws(() => parseBenchmarkArgs(bad));
  assert.throws(() => parseBenchmarkArgs(["--replay-failures", "/tmp/report.json", "--measurement-only"]));
});

test("diagnostic subset admission requires a ledger-bound original full108 and controlled mode", () => {
  const options = { piagentTreatment: "acceptance-diagnostic", measurementOnly: true,
    codexMode: "controlled", failedAttemptsOnly: true, replayRuns: [{}],
    replaySource: { selection: "failed-attempts", evidenceComplete: true, originalAttemptCount: 108, selectedAttempts: 1 } };
  const matrix = { builtInId: "production-v3", fullMatrix: false, expectedSessions: 108 };
  assert.doesNotThrow(() => assertDiagnosticBenchmarkMatrix(options, matrix));
  for (const patch of [{ evidenceComplete: false }, { selection: "pairs" }, { originalAttemptCount: 12 }, { selectedAttempts: 2 }]) {
    assert.throws(() => assertDiagnosticBenchmarkMatrix({ ...options, replaySource: { ...options.replaySource, ...patch } }, matrix));
  }
  assert.throws(() => assertDiagnosticBenchmarkMatrix({ ...options, codexMode: "native" }, matrix));
});

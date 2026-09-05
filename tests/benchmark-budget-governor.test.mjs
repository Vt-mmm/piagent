import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openBenchmarkBudgetGovernor } from "../packages/piagent-core/benchmark/benchmark-budget-governor.js";

const policy = { semantics: "management-thresholds", maxProviderAttempts: 108, freshTokenThreshold: 100, activeWallTimeMsThreshold: 1000 };
const binding = { candidateDigest: "a".repeat(64), suiteDigest: "b".repeat(64), runId: "fresh-run" };
const attempt = (index = 1) => ({ attemptId: `attempt-${index}`, orderIndex: index, scenarioId: "fixture", surface: "piagent", repeat: 1, infrastructureAttempt: 1 });
const measured = (fresh) => ({ sessions: 1, usageCompleteness: "exact", input: fresh, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, fresh, total: fresh });

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-budget-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = 1000;
  const options = { statePath: path.join(root, "budget.json"), policy, binding, now: () => time, ...overrides };
  const open = (resume = false, extra = {}) => {
    const value = openBenchmarkBudgetGovernor({ ...options, ...extra, resume });
    t.after(() => value.close());
    return value;
  };
  return { options, open, advance: (ms) => { time += ms; } };
}

test("threshold crossing retains one in-flight overshoot and prevents another provider start", (t) => {
  const { open } = fixture(t);
  const budget = open();
  budget.startStage("S12");
  budget.startAttempt(attempt());
  budget.settleAttempt(attempt(), { usage: measured(125), usageStatus: "measured" });
  const view = budget.snapshot();
  assert.equal(view.hardCapProven, false);
  assert.equal(view.policy.semantics, "management-thresholds");
  assert.equal(view.knownExactFreshTokens, 125);
  assert.equal(view.overshoot.freshTokens, 25);
  assert.equal(view.canStartAttempt, false);
  assert.throws(() => budget.startAttempt(attempt(2)), /fresh-token-threshold/);
  budget.endStage("S12");
});

test("exact threshold hit stops, without requiring an overshoot", (t) => {
  const budget = fixture(t).open();
  budget.startStage("S12");
  budget.startAttempt(attempt());
  budget.settleAttempt(attempt(), { usage: measured(100), usageStatus: "measured" });
  assert.equal(budget.snapshot().overshoot.freshTokens, 0);
  assert.deepEqual(budget.snapshot().stopReasons, ["fresh-token-threshold"]);
});

test("failed attempts retain exact spend and consume the strict session cap", (t) => {
  const budget = fixture(t, { policy: { ...policy, maxProviderAttempts: 1 } }).open();
  budget.startStage("S12");
  budget.startAttempt(attempt());
  budget.settleAttempt(attempt(), { usage: measured(30), usageStatus: "measured", outcome: "failed" });
  assert.equal(budget.snapshot().providerStartedAttempts, 1);
  assert.equal(budget.snapshot().knownExactFreshTokens, 30);
  assert.throws(() => budget.startAttempt(attempt(2)), /session-cap/);
  budget.endStage("S12");
});

test("unknown terminal usage permanently stops and is never turned into zero", (t) => {
  const { open } = fixture(t);
  const budget = open();
  budget.startStage("S12");
  budget.startAttempt(attempt());
  budget.settleAttempt(attempt(), { usage: measured(0), usageStatus: "unknown-after-provider-start" });
  budget.endStage("S12");
  assert.equal(budget.snapshot().unknownAttempts, 1);
  assert.equal(budget.snapshot().freshTokens, null);
  assert.equal(budget.snapshot().overshoot.freshTokens, null);
  budget.close();
  assert.throws(() => open(true).startStage("S18"), /unknown-usage/);
});

test("malformed or pre-provider-zero settlement after started fails closed", (t) => {
  for (const result of [
    { usage: { ...measured(20), fresh: 19 }, usageStatus: "measured" },
    { usage: { ...measured(0), sessions: 0 }, usageStatus: "known-pre-provider-zero" },
    { usage: measured(20), usageStatus: "measured-lower-bound" }
  ]) {
    const budget = fixture(t).open();
    budget.startStage("S12"); budget.startAttempt(attempt());
    budget.settleAttempt(attempt(), result);
    assert.equal(budget.snapshot().unknownAttempts, 1);
    assert.equal(budget.snapshot().canStartAttempt, false);
  }
});

test("stage wall charges setup, checkpoints and teardown, excludes between-stage idle", (t) => {
  const { open, advance } = fixture(t);
  const budget = open();
  budget.startStage("S12"); advance(100);
  budget.startAttempt(attempt()); advance(100);
  budget.settleAttempt(attempt(), { usage: measured(10), usageStatus: "measured" });
  advance(100); budget.checkpointStage("S12"); advance(100); budget.endStage("S12");
  assert.equal(budget.snapshot().activeWallTimeMs, 400);
  advance(10_000); budget.close();
  const resumed = open(true);
  assert.equal(resumed.snapshot().activeWallTimeMs, 400);
  resumed.startStage("S18"); advance(200); resumed.endStage("S18");
  assert.equal(resumed.snapshot().activeWallTimeMs, 600);
});

test("wall threshold stops dispatch but still records settlement and cleanup overshoot", (t) => {
  const { open, advance } = fixture(t);
  const budget = open();
  budget.startStage("S12"); budget.startAttempt(attempt()); advance(1000);
  assert.equal(budget.checkpointStage("S12").remainingActiveWallTimeMs, 0);
  assert.throws(() => budget.startAttempt(attempt(2)), /active-wall-threshold/);
  budget.settleAttempt(attempt(), { usage: measured(1), usageStatus: "measured" });
  advance(25); budget.endStage("S12");
  assert.equal(budget.snapshot().overshoot.activeWallTimeMs, 25);
});

test("reopening an unclosed stage fails closed even without a provider attempt", (t) => {
  const { open, advance } = fixture(t);
  const budget = open(); budget.startStage("S12"); advance(200);
  budget.checkpointStage("S12"); budget.close(); advance(1000);
  const resumed = open(true);
  assert.equal(resumed.snapshot().activeWallTimeExact, false);
  assert.equal(resumed.snapshot().activeWallTimeMs, 200);
  assert.throws(() => resumed.startStage("S18"), /unclosed-stage-on-resume/);
});

test("crash with in-flight attempt cannot reopen with reset usage or permit dispatch", (t) => {
  const { open } = fixture(t);
  const budget = open(); budget.startStage("S12"); budget.startAttempt(attempt()); budget.close();
  const resumed = open(true);
  assert.equal(resumed.snapshot().providerStartedAttempts, 1);
  assert.equal(resumed.snapshot().unknownAttempts, 1);
  assert.equal(resumed.snapshot().freshTokens, null);
  assert.equal(resumed.snapshot().canStartAttempt, false);
  assert.throws(() => resumed.settleAttempt(attempt(), { usage: measured(0), usageStatus: "measured" }), /active attempt/);
});

test("binding or policy mismatch refuses resume without rewriting state", (t) => {
  const { open, options } = fixture(t);
  open().close();
  const original = fs.readFileSync(options.statePath, "utf8");
  assert.throws(() => open(true, { binding: { ...binding, runId: "foreign" } }), /binding/);
  assert.throws(() => open(true, { policy: { ...policy, freshTokenThreshold: 101 } }), /policy/);
  assert.equal(fs.readFileSync(options.statePath, "utf8"), original);
});

test("missing, corrupt or modified state cannot resume or silently initialize again", (t) => {
  for (const mutate of [
    (file) => fs.unlinkSync(file),
    (file) => fs.writeFileSync(file, "{corrupt"),
    (file) => { const value = JSON.parse(fs.readFileSync(file, "utf8")); value.state.attempts = []; fs.writeFileSync(file, JSON.stringify(value)); }
  ]) {
    const { open, options } = fixture(t);
    const budget = open(); budget.startStage("S12"); budget.startAttempt(attempt()); budget.close();
    mutate(options.statePath);
    assert.throws(() => open(true), /state/);
    assert.throws(() => open(false), /already|exists/);
  }
});

test("parallel writers, concurrent attempts, duplicate and foreign identities are refused", (t) => {
  const { open } = fixture(t);
  const budget = open();
  assert.throws(() => open(true), /locked/);
  budget.startStage("S12"); budget.startAttempt(attempt());
  assert.throws(() => budget.startAttempt(attempt(2)), /active attempt/);
  assert.throws(() => budget.settleAttempt({ ...attempt(), surface: "codex-cli" }, { usage: measured(1), usageStatus: "measured" }), /identity/);
  budget.settleAttempt(attempt(), { usage: measured(1), usageStatus: "measured" });
  assert.throws(() => budget.settleAttempt(attempt(), { usage: measured(1), usageStatus: "measured" }), /active attempt/);
  assert.throws(() => budget.startAttempt({ ...attempt(2), attemptId: attempt().attemptId }), /duplicate/);
  assert.throws(() => budget.startAttempt(attempt(3)), /sequential/);
  assert.throws(() => budget.startAttempt({ ...attempt(2), infrastructureAttempt: 2 }), /retry/);
});

test("bound planned coordinates reject foreign workload before starting", (t) => {
  const budget = fixture(t, { binding: { ...binding, plannedAttempts: [attempt()] } }).open();
  budget.startStage("S12");
  assert.throws(() => budget.startAttempt({ ...attempt(), scenarioId: "foreign" }), /planned/);
  assert.equal(budget.snapshot().providerStartedAttempts, 0);
});

test("clock rollback is terminal and state mutation while open cannot be overwritten", (t) => {
  const { open, advance, options } = fixture(t);
  const budget = open(); budget.startStage("S12"); advance(-1);
  assert.throws(() => budget.checkpointStage("S12"), /clock/);
  advance(2);
  assert.throws(() => budget.startAttempt(attempt()), /clock/);
  const second = fixture(t);
  const other = second.open();
  fs.writeFileSync(second.options.statePath, "{}");
  assert.throws(() => other.startStage("S12"), /changed|state/);
  assert.equal(fs.readFileSync(second.options.statePath, "utf8"), "{}");
  assert.ok(fs.existsSync(options.statePath));
});

test("public snapshots are copies and closing does not forgive an open stage", (t) => {
  const { open } = fixture(t);
  const budget = open();
  const view = budget.snapshot(); view.policy.freshTokenThreshold = 100000;
  assert.equal(budget.snapshot().policy.freshTokenThreshold, 100);
  budget.startStage("S12"); budget.close();
  assert.throws(() => budget.startAttempt(attempt()), /closed/);
  const resumed = open(true);
  assert.equal(resumed.snapshot().stopped, true);
});

test("one-use launcher handoff accounts setup, child execution, teardown and resume idle correctly", (t) => {
  const { open, advance } = fixture(t);
  const parent = open(); parent.startStage("stage-nonce-1"); advance(100); parent.close();
  const child = open(true, { attachStageId: "stage-nonce-1" });
  child.startAttempt(attempt()); advance(200);
  child.settleAttempt(attempt(), { usage: measured(10), usageStatus: "measured" }); child.close();
  advance(50);
  assert.throws(() => open(true, { attachStageId: "stage-nonce-1" }), /duplicate/);
  const finalizer = open(true, { finalizeStageId: "stage-nonce-1" });
  assert.throws(() => finalizer.startAttempt(attempt(2)), /finalization-only/);
  assert.equal(finalizer.endStage("stage-nonce-1").activeWallTimeMs, 350); finalizer.close();
  advance(10_000);
  const resumed = open(true); resumed.startStage("stage-nonce-2"); advance(25); resumed.endStage("stage-nonce-2");
  assert.equal(resumed.snapshot().activeWallTimeMs, 375);
  assert.equal(resumed.snapshot().unknownAttempts, 0);
});

test("launcher finalization marks an interrupted child attempt unknown while preserving exact elapsed", (t) => {
  const { open, advance } = fixture(t);
  const parent = open(); parent.startStage("stage-nonce"); parent.close();
  const child = open(true, { attachStageId: "stage-nonce" }); child.startAttempt(attempt()); advance(500); child.close();
  advance(100);
  const finalizer = open(true, { finalizeStageId: "stage-nonce" });
  const view = finalizer.endStage("stage-nonce");
  assert.equal(view.activeWallTimeMs, 600);
  assert.equal(view.activeWallTimeExact, true);
  assert.equal(view.unknownAttempts, 1);
  assert.equal(view.freshTokens, null);
  assert.equal(view.stopped, true);
});

test("launcher can finalize setup failure without any provider attempt", (t) => {
  const { open, advance } = fixture(t);
  const parent = open(); parent.startStage("stage-nonce"); advance(75); parent.close();
  const finalizer = open(true, { finalizeStageId: "stage-nonce" });
  const view = finalizer.endStage("stage-nonce");
  assert.equal(view.activeWallTimeMs, 75);
  assert.equal(view.providerStartedAttempts, 0);
  assert.equal(view.freshTokens, 0);
});

test("foreign handoff and invalid modes fail without rewriting pending stage", (t) => {
  const { open, options } = fixture(t);
  const parent = open(); parent.startStage("stage-nonce"); parent.close();
  const raw = fs.readFileSync(options.statePath, "utf8");
  for (const extra of [{ attachStageId: "foreign" }, { finalizeStageId: "foreign" }, { attachStageId: "stage-nonce", finalizeStageId: "stage-nonce" }]) {
    assert.throws(() => open(true, extra), /identity|mode/);
    assert.equal(fs.readFileSync(options.statePath, "utf8"), raw);
  }
});

test("caller mutation cannot raise policy thresholds or replace planned workload", (t) => {
  const mutablePolicy = { ...policy };
  const mutableBinding = { ...binding, plannedAttempts: [attempt()] };
  const budget = fixture(t, { policy: mutablePolicy, binding: mutableBinding }).open();
  mutablePolicy.freshTokenThreshold = 1000;
  mutableBinding.plannedAttempts[0].scenarioId = "foreign";
  budget.startStage("S12"); budget.startAttempt(attempt());
  budget.settleAttempt(attempt(), { usage: measured(100), usageStatus: "exact" });
  assert.deepEqual(budget.snapshot().stopReasons, ["fresh-token-threshold"]);
});

test("measured-but-unaccepted failure retains exact usage like the campaign ledger", (t) => {
  const budget = fixture(t).open();
  budget.startStage("S12"); budget.startAttempt(attempt());
  const view = budget.settleAttempt(attempt(), { usage: measured(47), usageStatus: "measured-but-unaccepted" });
  assert.equal(view.unknownAttempts, 0);
  assert.equal(view.knownExactFreshTokens, 47);
  assert.equal(view.freshTokens, 47);
  assert.equal(view.providerStartedAttempts, 1);
});

test("state read failure poisons the handle even if someone restores its previous bytes", (t) => {
  const { open, options } = fixture(t);
  const budget = open();
  const prior = fs.readFileSync(options.statePath);
  fs.unlinkSync(options.statePath);
  assert.throws(() => budget.startStage("S12"), /state missing/);
  fs.writeFileSync(options.statePath, prior);
  assert.throws(() => budget.startStage("S12"), /failed persistence/);
});

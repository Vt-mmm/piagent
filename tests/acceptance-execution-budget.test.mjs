import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { CASE_THREAD_CPU_MICROS, createExecutionBudget } from "../packages/piagent-core/extensions/acceptance-executor/budget.mjs";
import { executionDiagnostics } from "../packages/piagent-core/extensions/acceptance-execution-diagnostics.js";

function fixture(deadline = 5000) {
  const state = { now: 0, user: 0, system: 0, threadUser: 0, threadSystem: 0 };
  const budget = createExecutionBudget(deadline, { now: () => state.now, cpu: () => ({ user: state.user, system: state.system }),
    threadCpu: () => ({ user: state.threadUser, system: state.threadSystem }) });
  budget.beginCase();
  return { state, budget };
}

test("scheduler waiting is not charged as case CPU while the request wall deadline remains fixed", () => {
  const { state, budget } = fixture();
  state.now = 600; state.user = 35000;
  assert.equal(budget.poll(), null);
  state.now = 4999;
  assert.equal(budget.poll(), null);
  state.now = 5000;
  assert.equal(budget.poll(), "guest-wall-deadline");
  budget.beginCase();
  assert.equal(budget.poll(), "guest-wall-deadline", "a new case cannot renew the request wall budget");
});

test("both executing-thread user and system CPU count, with an inclusive fixed per-case boundary", () => {
  const { state, budget } = fixture();
  state.user = CASE_THREAD_CPU_MICROS + 100000;
  state.threadUser = CASE_THREAD_CPU_MICROS - 1000; state.threadSystem = 999;
  assert.equal(budget.poll(), null);
  state.threadSystem++;
  assert.equal(budget.poll(), "guest-cpu-budget");
  state.now = 6000;
  assert.equal(budget.poll(), "guest-cpu-budget", "the observed first stop reason is stable");
});

test("case CPU resets without refunding elapsed request time or earlier process CPU", () => {
  const { state, budget } = fixture();
  state.user = 350000; state.threadUser = 250000; state.now = 1000;
  budget.beginCase();
  assert.equal(budget.poll(), null);
  state.user = 650000; state.threadUser = 549999; state.now = 2000;
  assert.equal(budget.poll(), null);
  state.threadUser++;
  assert.equal(budget.poll(), "guest-cpu-budget");
  budget.beginCase(); state.now = 5000;
  assert.equal(budget.poll(), "guest-wall-deadline");
});

test("invalid or regressing resource clocks cannot manufacture an available budget", () => {
  for (const deadline of [NaN, Infinity, -Infinity, "5000"]) assert.throws(() => createExecutionBudget(deadline));
  for (const change of [{ now: NaN }, { user: -1 }, { user: -1, system: 1 }, { user: "0" }, { system: Infinity }, { user: 0.5 }]) {
    const { state, budget } = fixture(); Object.assign(state, change);
    assert.throws(() => budget.poll(), /Invalid resource observation/);
  }
  const { state, budget } = fixture();
  state.user = 100; assert.equal(budget.poll(), null);
  state.user = 50; assert.throws(() => budget.poll(), /Invalid resource observation/);
});

test("a wall timeout between cases remains a visible authenticated diagnostic", () => {
  const diagnostic = executionDiagnostics({ execution: { status: "timeout", cleanupConfirmed: true,
    observation: { timeoutReason: "guest-wall-deadline", cases: [] } }, checks: [] });
  assert.deepEqual(diagnostic.reasons, ["executor-timeout", "guest-wall-deadline"]);
});

test("support-thread CPU does not exhaust a case; diagnostics retain both counters at the first real stop", () => {
  const { state, budget } = fixture();
  assert.equal(budget.diagnostics(), null);
  // Exact failing v5 full-run sample: about 210 ms was outside the case thread.
  Object.assign(state, { now: 244.051, user: 310014, threadUser: 100256 });
  assert.equal(budget.poll(), null);
  assert.equal(budget.diagnostics(), null);
  Object.assign(state, { now: 600, user: 650000, threadUser: CASE_THREAD_CPU_MICROS - 400, threadSystem: 400 });
  assert.equal(budget.poll(), "guest-cpu-budget");
  const sample = budget.diagnostics();
  assert.deepEqual(sample, { caseCpuMicros: 650000, caseThreadCpuMicros: CASE_THREAD_CPU_MICROS, caseWallMicros: 600000 });
  assert.ok(Object.isFrozen(sample));
  Object.assign(state, { now: 700, user: 700000, threadUser: 400000 });
  assert.equal(budget.poll(), "guest-cpu-budget"); assert.equal(budget.diagnostics(), sample);
  budget.beginCase(); assert.equal(budget.diagnostics(), null);
  state.now = 5000;
  assert.equal(budget.poll(), "guest-wall-deadline");
  assert.deepEqual(budget.diagnostics(), { caseCpuMicros: 0, caseThreadCpuMicros: 0, caseWallMicros: 4300000 });
});

test("invalid thread samples or reversed case elapsed time cannot become resource diagnostics", () => {
  for (const change of [{ threadUser: -1 }, { threadSystem: Infinity }, { threadUser: 0.5 }, { now: -1 }]) {
    const { state, budget } = fixture(); Object.assign(state, { user: CASE_THREAD_CPU_MICROS }, change);
    assert.throws(() => budget.poll(), /Invalid resource observation/);
    assert.equal(budget.diagnostics(), null);
  }
});

test("a regressing thread clock cannot refund CPU within a case or at a case boundary", () => {
  for (const boundary of [false, true]) {
    const { state, budget } = fixture(); state.threadUser = 100;
    assert.equal(budget.poll(), null);
    state.threadUser = 50;
    assert.throws(() => boundary ? budget.beginCase() : budget.poll(), /Invalid resource observation/);
  }
});

test("real isolated resource probes distinguish idle waiting, CPU exhaustion, and request expiry", {
  skip: !process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID || !process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET, timeout: 90000
}, () => {
  const output = execFileSync(process.execPath, [new URL("../evals/harness-next/run-resource-probe.mjs", import.meta.url).pathname],
    { env: process.env, encoding: "utf8", timeout: 85000, maxBuffer: 65536 });
  const rows = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.equal(row.workerVersion, "quickjs-contract-worker-v8");
    if (row.stallMs) assert.equal(row.stalled, true);
    if (row.stallMs === 5200) assert.equal(row.observation.reason, "guest-wall-deadline");
    else if (row.name === "infinite") {
      assert.equal(row.observation.reason, "guest-cpu-budget");
      assert.ok(row.observation.resources.caseThreadCpuMicros >= CASE_THREAD_CPU_MICROS);
    } else {
      assert.equal(row.observation.outcome, "return", JSON.stringify(row));
      assert.deepEqual(row.observation.value, { type: "number", value: row.name === "correct-sum" ? 5 : -1 });
    }
  }
});

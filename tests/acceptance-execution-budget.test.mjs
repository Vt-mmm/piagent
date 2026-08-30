import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { CASE_CPU_MICROS, createExecutionBudget } from "../packages/piagent-core/extensions/acceptance-executor/budget.mjs";
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

test("both user and system CPU count, with an inclusive fixed per-case boundary", () => {
  const { state, budget } = fixture();
  state.user = CASE_CPU_MICROS - 1000; state.system = 999;
  assert.equal(budget.poll(), null);
  state.system++;
  assert.equal(budget.poll(), "guest-cpu-budget");
  state.now = 6000;
  assert.equal(budget.poll(), "guest-cpu-budget", "the observed first stop reason is stable");
});

test("case CPU resets without refunding elapsed request time or earlier process CPU", () => {
  const { state, budget } = fixture();
  state.user = 250000; state.now = 1000;
  budget.beginCase();
  assert.equal(budget.poll(), null);
  state.user = 549999; state.now = 2000;
  assert.equal(budget.poll(), null);
  state.user++;
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

test("resource diagnostics capture the first stopping sample without changing the process CPU policy", () => {
  const { state, budget } = fixture();
  assert.equal(budget.diagnostics(), null);
  Object.assign(state, { now: 25, user: CASE_CPU_MICROS, threadUser: 3000, threadSystem: 400 });
  assert.equal(budget.poll(), "guest-cpu-budget", "background CPU is still charged by the current policy");
  const sample = budget.diagnostics();
  assert.deepEqual(sample, { caseCpuMicros: CASE_CPU_MICROS, caseThreadCpuMicros: 3400, caseWallMicros: 25000 });
  assert.ok(Object.isFrozen(sample));
  Object.assign(state, { now: 100, user: CASE_CPU_MICROS + 10000, threadUser: 4000 });
  assert.equal(budget.poll(), "guest-cpu-budget"); assert.equal(budget.diagnostics(), sample);
  budget.beginCase(); assert.equal(budget.diagnostics(), null);
  state.now = 5000;
  assert.equal(budget.poll(), "guest-wall-deadline");
  assert.deepEqual(budget.diagnostics(), { caseCpuMicros: 0, caseThreadCpuMicros: 0, caseWallMicros: 4900000 });
});

test("invalid thread samples or reversed case elapsed time cannot become resource diagnostics", () => {
  for (const change of [{ threadUser: -1 }, { threadSystem: Infinity }, { threadUser: 0.5 }, { now: -1 }]) {
    const { state, budget } = fixture(); Object.assign(state, { user: CASE_CPU_MICROS }, change);
    assert.throws(() => budget.poll(), /Invalid resource observation/);
    assert.equal(budget.diagnostics(), null);
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
    assert.equal(row.workerVersion, "quickjs-contract-worker-v5");
    if (row.stallMs) assert.equal(row.stalled, true);
    if (row.stallMs === 5200) assert.equal(row.observation.reason, "guest-wall-deadline");
    else if (row.name === "infinite") {
      assert.equal(row.observation.reason, "guest-cpu-budget");
      assert.ok(row.cpuMicros >= CASE_CPU_MICROS);
    } else {
      assert.equal(row.observation.outcome, "return", JSON.stringify(row));
      assert.deepEqual(row.observation.value, { type: "number", value: row.name === "correct-sum" ? 5 : -1 });
    }
  }
});

import crypto from "node:crypto";
import { openBenchmarkBudgetGovernor } from "../packages/piagent-core/benchmark/benchmark-budget-governor.js";
import { BENCHMARK_BUDGET_CONTEXT, assertBenchmarkBudgetPolicyUnchanged } from "./benchmark-budget-runtime.mjs";
import { createBenchmarkBudgetProcessRegistry } from "./benchmark-budget-processes.mjs";

function signalGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* Child already exited. */ }
}

// The outer process owns timing from before snapshot setup through snapshot
// cleanup. The core is the sole attempt-state writer during the child lifetime.
export function startBenchmarkBudgetLaunch(control, { resume = false, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, registryOptions = {}, signalCore = signalGroup } = {}) {
  if (!control) return null;
  assertBenchmarkBudgetPolicyUnchanged(control);
  const parameters = { statePath: control.identity.statePath, policy: control.policy, binding: control.binding, now };
  const stageId = crypto.randomBytes(16).toString("hex");
  const governor = openBenchmarkBudgetGovernor({ ...parameters, resume });
  let started;
  try { started = governor.startStage(stageId); } finally { governor.close(); }
  const deadline = started.stages.find(stage => stage.stageId === stageId).lastCheckpointAtMs + started.remainingActiveWallTimeMs;
  const registry = createBenchmarkBudgetProcessRegistry({ ...registryOptions, stageId });
  const timers = new Set();
  let timedOut = false, finished = false, supervised = false, coreClosed = false, protocolFailed = false;
  let childProcess, cleanupReceipt;
  const terminate = signal => {
    registry.terminateAll(signal);
    if (childProcess && !coreClosed) signalCore(childProcess, signal);
  };
  const escalate = () => {
    terminate("SIGTERM");
    const killTimer = schedule(() => terminate("SIGKILL"), 10_000);
    timers.add(killTimer);
  };
  const protocolFailure = () => { if (!protocolFailed) { protocolFailed = true; escalate(); } };
  return {
    context: JSON.stringify({ stageId, parentPid: process.pid, policySha256: control.identity.sha256,
      statePath: control.identity.statePath }),
    environmentKey: BENCHMARK_BUDGET_CONTEXT,
    assertReady() {
      assertBenchmarkBudgetPolicyUnchanged(control);
      if (now() >= deadline) {
        timedOut = true;
        throw Object.assign(new Error("Benchmark budget: active stage wall threshold reached before child launch"),
          { exitCode: 1, code: "BENCHMARK_BUDGET_DENIED" });
      }
    },
    supervise(child) {
      if (supervised) throw new Error("Benchmark budget child was supervised twice");
      supervised = true;
      childProcess = child;
      child.once?.("close", () => { coreClosed = true; });
      child.on?.("message", message => {
        try {
          registry.handleMessage(message);
          child.send({ kind: "benchmark-budget-process-ack-v1", stageId, event: message.event,
            pid: message.pid, accepted: true }, error => { if (error) protocolFailure(); });
        } catch { protocolFailure(); }
      });
      const timer = schedule(() => {
        timedOut = true;
        escalate();
      }, Math.max(0, deadline - now()));
      timers.add(timer);
    },
    terminate,
    async drain(options) {
      cleanupReceipt = await registry.drain(options);
      return { ...cleanupReceipt, cleanupConfirmed: cleanupReceipt.cleanupConfirmed && !protocolFailed };
    },
    finish() {
      if (finished) throw new Error("Benchmark budget stage was finalized twice");
      finished = true;
      for (const timer of timers) cancel(timer);
      const finalizer = openBenchmarkBudgetGovernor({ ...parameters, resume: true, finalizeStageId: stageId });
      try {
        const launcherErrors = [];
        const stop = reason => { launcherErrors.push(reason); finalizer.stop(reason); };
        try { assertBenchmarkBudgetPolicyUnchanged(control); } catch { stop("budget-policy-changed"); }
        if (timedOut) stop("launcher-wall-watchdog");
        if (protocolFailed) stop("launcher-process-protocol-failure");
        if (supervised && cleanupReceipt?.cleanupConfirmed !== true) stop("launcher-process-cleanup-unconfirmed");
        return { ...finalizer.endStage(stageId), launcherSucceeded: launcherErrors.length === 0,
          launcherErrors, processCleanup: cleanupReceipt ?? null };
      } finally { finalizer.close(); }
    }
  };
}

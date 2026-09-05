import { BENCHMARK_BUDGET_CONTEXT } from "./benchmark-budget-runtime.mjs";

// Only the frozen core's direct parent can acknowledge owned process groups.
// This narrows cleanup races; it does not promise a zero spawn/registration gap
// for command-line providers whose prompt is already present in argv.
export function createBenchmarkBudgetProcessHooks({ env = process.env, channel = process, timeoutMs = 5_000 } = {}) {
  if (!env[BENCHMARK_BUDGET_CONTEXT]) return {};
  const { stageId, parentPid } = JSON.parse(env[BENCHMARK_BUDGET_CONTEXT]);
  if (!/^[a-f0-9]{32}$/.test(stageId ?? "") || parentPid !== channel.ppid
    || typeof channel.send !== "function" || !channel.connected) {
    throw new Error("Benchmark budget process ownership requires the direct launcher IPC channel");
  }
  const exchange = (event, pid) => new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      channel.off("message", onMessage); channel.off("disconnect", onDisconnect);
      if (error) reject(error); else resolve();
    };
    const onDisconnect = () => finish(new Error("Benchmark budget launcher IPC disconnected"));
    const onMessage = message => {
      if (message?.kind !== "benchmark-budget-process-ack-v1") return;
      if (message.stageId === stageId && message.pid !== pid) return; // Another concurrent owned command.
      if (message.stageId !== stageId || message.pid !== pid || message.event !== event || message.accepted !== true) {
        finish(new Error("Benchmark budget ownership receipt mismatched"));
      } else finish();
    };
    const timer = setTimeout(() => finish(new Error("Benchmark budget ownership receipt timed out")), timeoutMs);
    channel.on("message", onMessage); channel.once("disconnect", onDisconnect);
    try {
      channel.send({ kind: "benchmark-budget-process-v1", stageId, event, pid }, error => { if (error) finish(error); });
    } catch (error) { finish(error); }
  });
  return { started: pid => exchange("started", pid), closed: pid => exchange("closed", pid) };
}

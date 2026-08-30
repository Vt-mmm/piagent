import { cpuUsage, threadCpuUsage } from "node:process";
import { performance } from "node:perf_hooks";

export const CASE_CPU_MICROS = 300000;
export const REQUEST_WALL_MS = 5000;
export const CPU_EXHAUSTED = "guest-cpu-budget";
export const WALL_EXHAUSTED = "guest-wall-deadline";

// Host-owned clocks, never guest globals or request-supplied limits. CPU counts
// the worker process (including its support work), not an instruction estimate.
export function createExecutionBudget(overallDeadline, clocks = { now: () => performance.now(), cpu: cpuUsage, threadCpu: threadCpuUsage }) {
  if (!Number.isFinite(overallDeadline)) throw new TypeError("Invalid execution deadline");
  const readCpu = (read = clocks.cpu) => {
    const { user, system } = read();
    if (![user, system, user + system].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid resource observation");
    return user + system;
  };
  let initialCpu = readCpu(), previousCpu = initialCpu, reason = null, diagnostic = null;
  let initialThread = readCpu(clocks.threadCpu), startedAt = clocks.now();
  if (!Number.isFinite(startedAt)) throw new Error("Invalid resource observation");
  return {
    beginCase() {
      initialCpu = readCpu();
      if (initialCpu < previousCpu) throw new Error("Invalid resource observation");
      previousCpu = initialCpu; initialThread = readCpu(clocks.threadCpu); startedAt = clocks.now();
      if (!Number.isFinite(startedAt)) throw new Error("Invalid resource observation");
      reason = null; diagnostic = null;
    },
    poll() {
      if (reason) return reason;
      const now = clocks.now(), current = readCpu(), used = current - initialCpu;
      if (!Number.isFinite(now) || now < startedAt || current < previousCpu) throw new Error("Invalid resource observation");
      previousCpu = current;
      if (now >= overallDeadline) reason = WALL_EXHAUSTED;
      else if (used >= CASE_CPU_MICROS) reason = CPU_EXHAUSTED;
      if (reason) {
        const caseThreadCpuMicros = readCpu(clocks.threadCpu) - initialThread;
        const caseWallMicros = Math.ceil((now - startedAt) * 1000);
        if (![caseThreadCpuMicros, caseWallMicros].every(value => Number.isSafeInteger(value) && value >= 0)) {
          throw new Error("Invalid resource observation");
        }
        // Observation only: thread CPU never changes the process CPU policy.
        diagnostic = Object.freeze({ caseCpuMicros: used, caseThreadCpuMicros, caseWallMicros });
      }
      return reason;
    },
    diagnostics() { return diagnostic; }
  };
}

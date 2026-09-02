import { cpuUsage, threadCpuUsage } from "node:process";
import { performance } from "node:perf_hooks";

export const CASE_THREAD_CPU_MICROS = 300000;
export const REQUEST_WALL_MS = 5000;
export const CPU_EXHAUSTED = "guest-cpu-budget";
export const WALL_EXHAUSTED = "guest-wall-deadline";

// Host-owned clocks, never guest globals or request-supplied limits. Each case
// charges its executing thread, including host work on that thread. Background
// compiler/support CPU stays under the container-wide CPU and wall limits; it
// cannot steal this case's allowance. This is not an instruction/fuel estimate.
export function createExecutionBudget(overallDeadline, clocks = { now: () => performance.now(), cpu: cpuUsage, threadCpu: threadCpuUsage }) {
  if (!Number.isFinite(overallDeadline)) throw new TypeError("Invalid execution deadline");
  const readCpu = (read = clocks.cpu) => {
    const { user, system } = read();
    if (![user, system, user + system].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid resource observation");
    return user + system;
  };
  let initialCpu = readCpu(), previousCpu = initialCpu, reason = null, diagnostic = null, caseActive = false;
  let initialThread = readCpu(clocks.threadCpu), startedAt = clocks.now();
  let previousThread = initialThread;
  if (!Number.isFinite(startedAt)) throw new Error("Invalid resource observation");
  return {
    beginCase() {
      initialCpu = readCpu();
      if (initialCpu < previousCpu) throw new Error("Invalid resource observation");
      previousCpu = initialCpu; initialThread = readCpu(clocks.threadCpu); startedAt = clocks.now();
      if (initialThread < previousThread) throw new Error("Invalid resource observation");
      previousThread = initialThread;
      if (!Number.isFinite(startedAt)) throw new Error("Invalid resource observation");
      reason = null; diagnostic = null; caseActive = true;
    },
    poll() {
      if (reason) return reason;
      const now = clocks.now(), current = readCpu(), used = current - initialCpu;
      const currentThread = readCpu(clocks.threadCpu), caseThreadCpuMicros = currentThread - initialThread;
      if (!Number.isFinite(now) || now < startedAt || current < previousCpu || currentThread < previousThread) throw new Error("Invalid resource observation");
      previousCpu = current; previousThread = currentThread;
      if (now >= overallDeadline) reason = WALL_EXHAUSTED;
      else if (caseActive && caseThreadCpuMicros >= CASE_THREAD_CPU_MICROS) reason = CPU_EXHAUSTED;
      if (reason) {
        const caseWallMicros = Math.ceil((now - startedAt) * 1000);
        if (![caseThreadCpuMicros, caseWallMicros].every(value => Number.isSafeInteger(value) && value >= 0)) {
          throw new Error("Invalid resource observation");
        }
        // Keep both counters so support overhead remains visible to the host.
        diagnostic = Object.freeze({ caseCpuMicros: used, caseThreadCpuMicros, caseWallMicros });
      }
      return reason;
    },
    diagnostics() { return diagnostic; }
  };
}

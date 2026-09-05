import { performance } from "node:perf_hooks";

const KIND = "benchmark-budget-process-v1";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const validPid = pid => Number.isInteger(pid) && pid > 1 && pid <= 2_147_483_647 && pid !== process.pid && pid !== process.ppid;

function defaultSignalGroup(pid, signal) {
  process.kill(process.platform === "win32" ? pid : -pid, signal);
}

function defaultGroupAlive(pid) {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/**
 * The trusted core reports each detached provider process group through its
 * direct IPC channel. The parent never scans or guesses other process IDs.
 * Registration must be acknowledged before dispatch can progress. Core exit is
 * not proof of descendant exit: drain independently TERM/KILL/verifies every
 * still-owned group, including when the core event loop stops responding.
 */
export function createBenchmarkBudgetProcessRegistry({ stageId, signalGroup = defaultSignalGroup,
  groupAlive = defaultGroupAlive, now = () => performance.now(), sleep = delay } = {}) {
  if (!/^[a-f0-9]{32}$/.test(stageId ?? "")
    || ![signalGroup, groupAlive, now, sleep].every(value => typeof value === "function")) {
    throw new Error("Benchmark process registry requires a stage identity and valid operations");
  }
  const groups = new Map();
  const errors = [];
  const signals = [];
  const livenessProbeFailures = new Map();
  let draining = false;
  let drainPromise;
  const note = code => { if (!errors.includes(code)) errors.push(code); };
  const fail = message => {
    note(message);
    throw Object.assign(new Error(`Benchmark process registry: ${message}`), { code: "BENCHMARK_BUDGET_PROCESS_INVALID", exitCode: 1 });
  };
  const inspect = pid => {
    try {
      const result = groupAlive(pid);
      if (typeof result !== "boolean") throw Object.assign(new Error("invalid liveness result"), { code: "INVALID_LIVENESS_RESULT" });
      const priorFailure = livenessProbeFailures.get(pid);
      if (priorFailure) priorFailure.latestObservation = result ? "alive" : "absent";
      return result;
    } catch (error) {
      // A dying POSIX group can transiently reject kill(group, 0), e.g. EPERM.
      // This is NEVER proof of exit: retain ownership and retry within the same
      // bounded drain. Only a later conclusive absent probe can resolve it.
      const prior = livenessProbeFailures.get(pid);
      const code = /^[A-Z0-9_]{1,80}$/.test(error?.code ?? "") ? error.code : "UNKNOWN";
      livenessProbeFailures.set(pid, { pid, count: (prior?.count ?? 0) + 1, lastErrorCode: code, latestObservation: "unknown" });
      return true;
    }
  };
  const collectExited = () => {
    for (const [pid, status] of groups) if (status === "active" && !inspect(pid)) groups.set(pid, "closed");
  };
  const snapshot = () => {
    const unconfirmedPids = [...groups].filter(([, status]) => status === "active").map(([pid]) => pid);
    return { schemaVersion: 1, stageId, registeredGroups: groups.size, cleanupConfirmed: errors.length === 0 && unconfirmedPids.length === 0,
      unconfirmedPids, errors: [...errors], signals: signals.map(value => ({ ...value })),
      livenessProbeFailures: [...livenessProbeFailures.values()].map(value => ({ ...value })), draining };
  };
  const terminateAll = signal => {
    if (!["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"].includes(signal)) fail("unsupported termination signal");
    for (const [pid, status] of groups) {
      if (status !== "active") continue;
      signals.push({ pid, signal });
      try { signalGroup(pid, signal); }
      catch (error) { if (error.code !== "ESRCH") note("process-group-signal-unconfirmed"); }
    }
    return snapshot();
  };
  const waitForGroups = async (graceMs, pollMs) => {
    const started = now();
    if (!Number.isFinite(started)) { note("invalid-registry-clock"); return; }
    // The iteration bound also prevents an injected or regressing clock hanging
    // shutdown forever. Production uses a monotonic clock, not wall-clock time.
    for (let index = 0; index <= Math.ceil(graceMs / pollMs); index += 1) {
      collectExited();
      if (![...groups.values()].includes("active")) return;
      const elapsed = now() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0) { note("invalid-registry-clock"); return; }
      if (elapsed >= graceMs || index === Math.ceil(graceMs / pollMs)) return;
      await sleep(Math.min(pollMs, graceMs - elapsed));
    }
  };
  return {
    handleMessage(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)
        || Object.keys(message).sort().join(",") !== "event,kind,pid,stageId"
        || message.kind !== KIND || message.stageId !== stageId
        || !["started", "closed"].includes(message.event) || !validPid(message.pid)) fail("malformed-or-foreign-process-message");
      if (message.event === "started") {
        if (draining) fail("registry is draining or closed");
        if (groups.has(message.pid)) fail("duplicate process registration");
        if (groups.size >= 10_000) fail("process registry capacity exceeded");
        groups.set(message.pid, "active");
      } else {
        if (!groups.has(message.pid)) fail("unknown process close");
        if (groups.get(message.pid) !== "active") fail("duplicate process close");
        if (inspect(message.pid)) fail("process group still alive after close receipt");
        groups.set(message.pid, "closed");
      }
      return { accepted: true, pid: message.pid, event: message.event };
    },
    terminateAll,
    snapshot,
    drain({ termGraceMs = 2000, killGraceMs = 1000, pollMs = 20 } = {}) {
      if (![termGraceMs, killGraceMs, pollMs].every(Number.isInteger)
        || termGraceMs < 0 || killGraceMs < 0 || termGraceMs + killGraceMs > 10_000 || pollMs < 1 || pollMs > 1000) {
        return Promise.reject(new Error("Benchmark process registry drain timing bounds are invalid"));
      }
      if (!drainPromise) {
        draining = true;
        drainPromise = (async () => {
          collectExited();
          terminateAll("SIGTERM");
          await waitForGroups(termGraceMs, pollMs);
          terminateAll("SIGKILL");
          await waitForGroups(killGraceMs, pollMs);
          collectExited();
          if ([...groups.values()].includes("active")) note("process-group-cleanup-unconfirmed");
          if ([...livenessProbeFailures.values()].some(value => value.latestObservation === "unknown")) note("process-group-liveness-unconfirmed");
          return snapshot();
        })();
      }
      return drainPromise;
    }
  };
}

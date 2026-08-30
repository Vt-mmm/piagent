import { createHash } from "node:crypto";
import { compileIndependentContract, INDEPENDENT_CONTRACT_VERSION } from "./acceptance-independent-contract.js";
import { captureExecutionSnapshot, EXECUTION_SNAPSHOT_VERSION, runSnapshotBoundContract } from "./acceptance-execution-snapshot.js";
import { createAuthenticatedAdmission, unavailableAuthenticatedAssessment } from "./acceptance-authenticated-admission.js";

export const DURABLE_EXECUTION_VERSION = "durable-closed-contract-v1";
const HASH = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const freeze = (value) => {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const unavailable = (reason, attemptId) => Object.freeze({ version: DURABLE_EXECUTION_VERSION,
  verdict: "unknown", reason, completionAllowed: false, ...(attemptId ? { attemptId } : {}) });

/**
 * HOST-ONLY durable diagnostic runner, not a completion gate or model tool.
 * All configuration/checks and the evidence-store handle must be host-approved.
 * verifierDigest identifies the installed host verifier code; the project
 * verification callback must return the digest of a current, actually observed
 * project verifier, bound to this snapshot and task (or null if unavailable).
 * Neither model-provided expected results nor project-authored receipt JSON may
 * supply these capabilities. Runtime approval/observation wiring is separate.
 *
 * Only the current authenticated store event can be reused. A pending run never
 * starts another worker automatically. Explicit retries consume the same finite
 * attempt budget. Interruption reconciliation must establish worker termination
 * before the store's recordStoppedAttempt capability can be used.
 */
export function createDurableContractRunner({ store, projectRoot, sourcePath, authorizeSourceRead,
  exportName, checks, imageId, dockerSocket, verifierDigest, getProjectVerificationDigest, timeoutMs = 10000 } = {}) {
  if (!store || typeof store.reserve !== "function" || typeof store.settle !== "function"
    || typeof verifierDigest !== "string" || !HASH.test(verifierDigest) || typeof getProjectVerificationDigest !== "function"
    || typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId)
    || typeof dockerSocket !== "string" || !dockerSocket.startsWith("/") || dockerSocket.includes("\0")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 30000) throw new TypeError("Invalid approved durable verifier configuration");
  // Compile before retaining the plan to detach it from later caller mutations.
  const template = compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: "export const placeholder = 0;", exportName, checks }));
  const approvedChecks = template.plan.checks;
  const snapshotRequest = { projectRoot, sourcePath, authorizeSourceRead };
  const admission = createAuthenticatedAdmission({ store, snapshotRequest, verifierDigest, imageId });
  const completed = new WeakMap();
  const backendDigest = hash(JSON.stringify([DURABLE_EXECUTION_VERSION, INDEPENDENT_CONTRACT_VERSION,
    EXECUTION_SNAPSHOT_VERSION, imageId, dockerSocket, timeoutMs]));

  async function run({ scope, criterionHash, maxAttempts, retry = false, signal } = {}) {
    if (typeof criterionHash !== "string" || !HASH.test(criterionHash)) throw new TypeError("Invalid current criterion hash");
    // Freeze identities before awaiting a host callback; the caller cannot swap
    // tasks or criteria midway through a reserved execution.
    const identity = Object.freeze({ taskRunId: scope?.taskRunId, criterionId: scope?.criterionId, criterionHash });
    const exactScope = Object.freeze({ taskRunId: identity.taskRunId, criterionId: identity.criterionId });
    const before = captureExecutionSnapshot(snapshotRequest);
    if (before.binding.projectId !== store.projectId) throw new Error("Evidence store belongs to another project");
    const verificationDigest = await getProjectVerificationDigest({ ...identity, snapshot: before.binding, snapshotDigest: before.snapshotDigest });
    if (typeof verificationDigest !== "string" || !HASH.test(verificationDigest)) return unavailable("current-project-verifier-missing");
    const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: before.source, exportName, checks: approvedChecks }));
    const binding = { criterionHash, snapshotDigest: before.snapshotDigest, verifierDigest,
      projectVerificationDigest: verificationDigest, planDigest: compiled.planDigest, backendDigest };
    if (signal?.aborted) return unavailable("cancelled-before-reservation");
    const reserved = store.reserve({ scope: exactScope, binding, maxAttempts, retry });
    if (!["current", "reserved"].includes(reserved.status)) return unavailable(`evidence-${reserved.status}`, reserved.event?.attemptId);

    async function stillCurrent() {
      try {
        const after = captureExecutionSnapshot(snapshotRequest);
        return after.snapshotDigest === before.snapshotDigest
          && await getProjectVerificationDigest({ ...identity, snapshot: after.binding, snapshotDigest: after.snapshotDigest }) === verificationDigest;
      } catch { return false; }
    }
    function diagnostic(evidence, event, reused) {
      const result = freeze({ version: DURABLE_EXECUTION_VERSION, verdict: evidence.verdict, completionAllowed: false,
        reused, attemptId: event.attemptId, evidence });
      completed.set(result, { scope: exactScope, binding, event, stillCurrent,
        expectedChecks: compiled.plan.checks.map((check) => ({ id: check.id, caseCount: check.cases.length })) });
      return result;
    }
    if (reserved.status === "current") {
      if (!await stillCurrent()) return unavailable("cached-evidence-binding-drift", reserved.event.attemptId);
      const evidence = JSON.parse(reserved.event.evidenceText);
      if (evidence.version !== DURABLE_EXECUTION_VERSION || evidence.snapshotDigest !== before.snapshotDigest
        || evidence.planDigest !== compiled.planDigest || !["pass", "fail", "unknown", "error"].includes(evidence.verdict)) {
        throw new Error("Authenticated evidence is incompatible with this verifier");
      }
      return diagnostic(evidence, reserved.event, true);
    }

    let observed;
    try {
      observed = await runSnapshotBoundContract({ ...snapshotRequest, exportName, checks: approvedChecks, imageId, dockerSocket,
        timeoutMs, signal, executionRunId: reserved.event.attemptId });
    } catch {
      observed = { verdict: "error", reason: "independent-execution-threw" };
    }
    const bound = observed.snapshotDigest === before.snapshotDigest && observed.result?.planDigest === compiled.planDigest;
    const current = await stillCurrent();
    const verdict = !current ? "unknown" : observed.verdict === "error" ? "error" : bound ? observed.verdict : "unknown";
    const evidence = { version: DURABLE_EXECUTION_VERSION, snapshotDigest: before.snapshotDigest, planDigest: compiled.planDigest,
      verdict, ...(!current || (!bound && observed.verdict !== "error") ? { reason: "execution-or-project-verifier-binding-drift" } : {}), observed };
    // A failed settlement remains pending: there is no fallback to unsigned
    // receipt files or a second execution. The host must reconcile explicitly.
    const settled = store.settle(reserved.reservation, JSON.stringify(evidence));
    return diagnostic(evidence, settled, false);
  }
  async function assess(result, { policy = "unknown" } = {}) {
    if (policy !== "allow") return unavailableAuthenticatedAssessment("policy-unestablished-or-denied");
    const observed = result && typeof result === "object" ? completed.get(result) : undefined;
    if (!observed) return unavailableAuthenticatedAssessment("untrusted-durable-result");
    if (!await observed.stillCurrent()) return unavailableAuthenticatedAssessment("current-project-or-source-binding-changed");
    try { return admission.issue(observed); }
    catch { return unavailableAuthenticatedAssessment("authenticated-admission-unavailable"); }
  }
  return Object.freeze({ version: DURABLE_EXECUTION_VERSION, run, assess });
}

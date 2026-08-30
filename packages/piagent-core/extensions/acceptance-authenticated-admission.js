import { createHash } from "node:crypto";
import { createAcceptanceAssessmentSession } from "./acceptance-assessment.js";
import { isAcceptanceEvidenceStore } from "./acceptance-evidence-store.js";
import { captureExecutionSnapshot, snapshotPlanSource } from "./acceptance-execution-snapshot.js";
import { compileIndependentContract, compareIndependentExecution, INDEPENDENT_CONTRACT_VERSION } from "./acceptance-independent-contract.js";
import { parseRequest, parseResponse } from "./acceptance-executor/protocol.mjs";
import { executionDiagnostics } from "./acceptance-execution-diagnostics.js";

export const AUTHENTICATED_ADMISSION_VERSION = "authenticated-acceptance-admission-v1";
const receipts = new WeakMap();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const freeze = (value) => {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

export function unavailableAuthenticatedAssessment(reason) {
  return freeze({ version: AUTHENTICATED_ADMISSION_VERSION, verdict: "unknown", completionAllowed: false,
    repairEligible: false, sourceMutationAllowed: false, assurance: "none", reasons: [reason], failedChecks: [], missingChecks: [] });
}

/** Host-only factory. Only a branded, authenticated store can admit evidence. */
export function createAuthenticatedAdmission({ store, snapshotRequest, verifierDigest, imageId, exportName, checks }) {
  const approved = compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: "export const placeholder=0;", exportName, checks }));
  function issue({ scope, binding, event, expectedChecks }) {
    if (!isAcceptanceEvidenceStore(store)) return unavailableAuthenticatedAssessment("untrusted-evidence-store");
    const current = store.latest(scope);
    if (!current || current.phase !== "settled" || current.attemptId !== event.attemptId || current.sequence !== event.sequence
      || JSON.stringify(current.binding) !== JSON.stringify(binding)) return unavailableAuthenticatedAssessment("latest-evidence-changed");
    // Read authenticated bytes, never the caller's diagnostic result object.
    const evidence = JSON.parse(current.evidenceText), observed = evidence.observed, result = observed?.result;
    const snapshot = captureExecutionSnapshot(snapshotRequest);
    const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 1, ...snapshotPlanSource(snapshot), exportName, checks: approved.plan.checks }));
    if (snapshot.snapshotDigest !== binding.snapshotDigest || evidence.snapshotDigest !== binding.snapshotDigest
      || evidence.planDigest !== binding.planDigest || observed?.snapshotDigest !== binding.snapshotDigest
      || result?.version !== INDEPENDENT_CONTRACT_VERSION || result.planDigest !== binding.planDigest
      || result.execution?.runId !== current.attemptId || result.execution.sourceDigest !== snapshot.binding.sourceDigest
      || result.execution.imageId !== imageId || compiled.planDigest !== binding.planDigest
      || result.execution.requestDigest !== hash(compiled.requestText)) {
      return unavailableAuthenticatedAssessment("execution-admission-binding-mismatch");
    }
    if (result.execution.observation) {
      const response = parseResponse(JSON.stringify(result.execution.observation), parseRequest(compiled.requestText), result.execution.requestDigest);
      if (response.status !== result.execution.status) return unavailableAuthenticatedAssessment("execution-observation-status-conflict");
    } else if (result.execution.status === "completed") return unavailableAuthenticatedAssessment("execution-observation-missing");
    const compared = compareIndependentExecution(compiled, result.execution);
    if (compared.verdict !== result.verdict || JSON.stringify(compared.checks) !== JSON.stringify(result.checks)
      || JSON.stringify(compared.counterexamples) !== JSON.stringify(result.counterexamples)) {
      return unavailableAuthenticatedAssessment("execution-comparison-conflict");
    }
    if (!Array.isArray(result.checks) || result.checks.length !== expectedChecks.length || !Array.isArray(result.counterexamples)) {
      return unavailableAuthenticatedAssessment("execution-admission-coverage-missing");
    }
    const counterexamples = new Map(result.counterexamples.map((item) => [item.digest, item.evidence]));
    for (const expected of expectedChecks) {
      const check = result.checks.find((item) => item.id === expected.id);
      if (!check || !Number.isSafeInteger(check.caseCount) || check.caseCount < 0 || check.caseCount > expected.caseCount
        || (check.status === "pass" && check.caseCount !== expected.caseCount)) return unavailableAuthenticatedAssessment("execution-admission-case-count-mismatch");
      if (check.status === "fail") {
        const example = counterexamples.get(check.counterexampleRef);
        if (!example || hash(JSON.stringify(example)) !== check.counterexampleRef || example.checkId !== check.id
          || example.runId !== current.attemptId || example.planDigest !== binding.planDigest
          || example.sourceDigest !== snapshot.binding.sourceDigest || example.imageId !== imageId) {
          return unavailableAuthenticatedAssessment("execution-admission-counterexample-missing");
        }
      }
    }
    const session = createAcceptanceAssessmentSession({ taskRunId: scope.taskRunId, criterionHash: binding.criterionHash,
      workingTreeDigest: snapshot.binding.workingTreeDigest, verifierDigest, requiredCheckIds: expectedChecks.map((check) => check.id) });
    const diagnostic = executionDiagnostics(result);
    // Non-completed execution or uncertain cleanup can be authenticated as a
    // diagnostic, but never as completion or source-repair evidence.
    const completion = !diagnostic.cleanupConfirmed || diagnostic.status === "error" ? "crashed" : diagnostic.status;
    const receipt = session.observeExecution({ runId: current.attemptId, taskRunId: scope.taskRunId, criterionHash: binding.criterionHash,
      verifierDigest, beforeWorkingTreeDigest: snapshot.binding.workingTreeDigest, afterWorkingTreeDigest: snapshot.binding.workingTreeDigest,
      completion, checks: result.checks });
    const assessment = session.assess({ receipt, currentWorkingTreeDigest: snapshot.binding.workingTreeDigest, policy: "allow", projectVerifierCurrent: true });
    if (assessment.verdict !== evidence.verdict || assessment.verdict !== observed.verdict || assessment.verdict !== result.verdict) {
      return unavailableAuthenticatedAssessment("execution-admission-verdict-conflict");
    }
    const admitted = freeze({ ...assessment, reasons: [...new Set([...assessment.reasons, ...diagnostic.reasons])],
      executionDiagnostics: diagnostic, version: AUTHENTICATED_ADMISSION_VERSION, attemptId: current.attemptId,
      criterionId: scope.criterionId, taskRunId: scope.taskRunId, criterionHash: binding.criterionHash,
      sourcePath: snapshot.binding.sourcePath, workingTreeDigest: snapshot.binding.workingTreeDigest,
      ...(snapshot.binding.moduleFiles ? { sourcePaths: snapshot.binding.moduleFiles.map((file) => file.sourcePath) } : {}),
      snapshotDigest: binding.snapshotDigest, projectVerificationDigest: binding.projectVerificationDigest,
      counterexamples: result.checks.filter((check) => assessment.verdict === "fail" && check.status === "fail").map((check) => ({
        digest: check.counterexampleRef, evidence: counterexamples.get(check.counterexampleRef)
      })) });
    receipts.set(admitted, { store, snapshotRequest, scope: { ...scope }, binding: { ...binding }, sequence: current.sequence,
      attemptId: current.attemptId, evidenceDigest: hash(current.evidenceText) });
    return admitted;
  }
  return Object.freeze({ issue });
}

/** A serialized/cross-instance receipt is never completion or repair authority. */
export function currentAuthenticatedAssessment(receipt, { taskRunId, criterionId, criterionHash, workingTreeDigest,
  projectVerificationDigest, policy = "unknown" } = {}) {
  const owned = receipt && typeof receipt === "object" ? receipts.get(receipt) : undefined;
  if (!owned || policy !== "allow" || owned.scope.taskRunId !== taskRunId || owned.scope.criterionId !== criterionId
    || owned.binding.criterionHash !== criterionHash || owned.binding.projectVerificationDigest !== projectVerificationDigest) return null;
  try {
    const latest = owned.store.latest(owned.scope);
    if (latest?.phase !== "settled" || latest.attemptId !== owned.attemptId || latest.sequence !== owned.sequence
      || JSON.stringify(latest.binding) !== JSON.stringify(owned.binding) || hash(latest.evidenceText) !== owned.evidenceDigest) return null;
    const source = captureExecutionSnapshot(owned.snapshotRequest);
    if (source.snapshotDigest !== owned.binding.snapshotDigest || source.binding.workingTreeDigest !== workingTreeDigest) return null;
    return receipt;
  } catch { return null; }
}

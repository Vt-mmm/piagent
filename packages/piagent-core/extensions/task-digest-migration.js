import { isCurrentWorkingTreeDigest, WORKING_TREE_DIGEST_ALGORITHM, workingTreeCarrierDigest } from "./working-tree-digest.js";
import { latestObservedVerificationEvidence, verificationEvidenceProvesStableTree } from "./verification-intelligence.js";

export const LEGACY_UNTRUSTED_DIGEST_ALGORITHM = "legacy-untrusted";
export const DIGEST_MIGRATION_SOURCE = "legacy-unversioned";

function pendingReceipt(receipt, recordedAt) {
  if (!receipt || typeof receipt !== "object" || !Array.isArray(receipt.criteria)) return receipt;
  const next = structuredClone(receipt);
  delete next.provenance;
  next.criteria = next.criteria.map((criterion) => ({
    ...criterion,
    status: "pending",
    evidence: [],
    updatedAt: recordedAt
  }));
  return next;
}

function pendingReviewPlan(workPlan, recordedAt) {
  return Array.isArray(workPlan) ? workPlan.map((step) => (
    step?.mode === "review" && step.status === "done"
      ? { ...step, status: "pending", note: "Current verifier evidence is required after working-tree digest migration.", updatedAt: recordedAt }
      : step
  )) : [];
}

function migration(status, reasonCode, archivePath, archiveDigest, archiveBytes, recordedAt, task) {
  const requiredAction = status === "verification-refresh-required"
    ? "rerun-exact-verifier"
    : status === "historical-unverifiable"
      ? "historical-only"
      : "start-new-attempt";
  return { status, source: DIGEST_MIGRATION_SOURCE, reasonCode, requiredAction, archivePath, archiveDigest, archiveBytes, recordedAt,
    baselineEvidenceDigest: workingTreeCarrierDigest("baseline", task.baselineChangedFiles, task.baselineFileDigests),
    finalEvidenceDigest: workingTreeCarrierDigest("final", task.finalWorkingTreeFiles, task.finalFileDigests) };
}

function withoutLegacyProof(raw) {
  const receipt = pendingReceipt(raw.acceptanceReceipt, raw.updatedAt ?? raw.createdAt ?? new Date().toISOString());
  return {
    ...raw,
    baselineChangedFiles: [],
    baselineFileDigests: {},
    observedChangedFiles: [],
    finalWorkingTreeFiles: [],
    finalFileDigests: {},
    changedFiles: [],
    verifyEvidence: [],
    acceptanceReceipt: receipt
  };
}

/** Plan a one-time, fail-closed migration without reinterpreting any old hash. */
export function planUnversionedTaskDigestMigration(raw, options) {
  const recordedAt = options.recordedAt;
  const archivePath = options.archivePath;
  const terminal = raw?.trace?.outcome && raw.trace.outcome !== "pending";
  const cleanBaseline = Array.isArray(raw?.baselineChangedFiles)
    && raw.baselineChangedFiles.length === 0
    && raw.baselineFileDigests
    && typeof raw.baselineFileDigests === "object"
    && !Array.isArray(raw.baselineFileDigests)
    && Object.keys(raw.baselineFileDigests).length === 0;

  if (terminal) {
    const task = { ...withoutLegacyProof(raw), workingTreeDigestAlgorithm: LEGACY_UNTRUSTED_DIGEST_ALGORITHM };
    task.workingTreeDigestMigration = migration("historical-unverifiable", "terminal-legacy-evidence", archivePath, options.archiveDigest, options.archiveBytes, recordedAt, task);
    return {
      task,
      disposition: "historical"
    };
  }

  if (!options.sourceChange || !options.verifierPlanSafe || !cleanBaseline || options.semanticRepairPresent || !options.evidenceRootSafe || !options.keyBindingSafe || !options.snapshotSafe || !options.activeBindingSafe) {
    const reasonCode = options.semanticRepairPresent
      ? "semantic-repair-state-present"
      : !options.sourceChange
        ? "read-only-legacy-task"
        : !options.verifierPlanSafe
          ? "exact-verifier-plan-missing"
        : !cleanBaseline
          ? "baseline-not-provably-clean"
          : !options.evidenceRootSafe
            ? "evidence-root-unavailable"
            : !options.snapshotSafe
              ? "current-snapshot-unavailable"
              : !options.keyBindingSafe
                ? "legacy-carrier-key-mismatch"
                : "active-task-binding-unavailable";
    const task = {
        ...withoutLegacyProof(raw),
        workingTreeDigestAlgorithm: LEGACY_UNTRUSTED_DIGEST_ALGORITHM,
        failedAt: "verify",
        failureReason: `Working-tree digest migration blocked: ${reasonCode}. Start a bounded new attempt.`,
        trace: {
          outcome: "blocked",
          friction: `Legacy working-tree evidence is not replayable (${reasonCode}).`,
          notes: "The original contract was archived without reinterpreting its digests.",
          recordedAt
        }
      };
    task.workingTreeDigestMigration = migration("new-attempt-required", reasonCode, archivePath, options.archiveDigest, options.archiveBytes, recordedAt, task);
    return { task, disposition: "blocked" };
  }

  const currentFiles = Object.keys(options.currentSnapshot ?? {}).sort();
  const task = {
      ...raw,
      workingTreeDigestAlgorithm: WORKING_TREE_DIGEST_ALGORITHM,
      baselineChangedFiles: [],
      baselineFileDigests: {},
      observedChangedFiles: currentFiles,
      finalWorkingTreeFiles: currentFiles,
      finalFileDigests: { ...(options.currentSnapshot ?? {}) },
      changedFiles: currentFiles,
      verifyEvidence: [],
      acceptanceReceipt: pendingReceipt(raw.acceptanceReceipt, recordedAt),
      workPlan: pendingReviewPlan(raw.workPlan, recordedAt),
      updatedAt: recordedAt
    };
  task.workingTreeDigestMigration = migration("verification-refresh-required", "clean-baseline-rebound", archivePath, options.archiveDigest, options.archiveBytes, recordedAt, task);
  return { task, disposition: "refresh" };
}

export function completeTaskDigestRefresh(task, currentWorkingTreeDigest) {
  if (task?.workingTreeDigestAlgorithm !== WORKING_TREE_DIGEST_ALGORITHM || !isCurrentWorkingTreeDigest(currentWorkingTreeDigest) || task?.workingTreeDigestMigration?.status !== "verification-refresh-required") return task;
  const commands = [...new Set((task.verifyCommands ?? []).map((value) => String(value).trim()).filter(Boolean))];
  const currentPassing = new Set([...latestObservedVerificationEvidence(task.verifyEvidence).values()]
    .filter((entry) => verificationEvidenceProvesStableTree(entry, currentWorkingTreeDigest))
    .map((entry) => String(entry.command).trim()));
  if (commands.length === 0 || commands.some((command) => !currentPassing.has(command))) return task;
  return {
    ...task,
    workingTreeDigestMigration: {
      ...task.workingTreeDigestMigration,
      status: "refreshed",
      requiredAction: "none",
      refreshedAt: new Date(Math.max(Date.now(), Date.parse(task.workingTreeDigestMigration.recordedAt) || 0)).toISOString()
    }
  };
}

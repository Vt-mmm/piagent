import { acceptanceReceiptProvenanceSummary, acceptanceReceiptSummary } from "./acceptance-receipt.js";
import { runtimeLifecycleMode } from "./task-lifecycle.js";
import { latestObservedVerificationEvidence, meaningfulVerificationCommands, verificationEvidenceProvesStableTree } from "./verification-intelligence.js";
import { isCurrentWorkingTreeDigest, WORKING_TREE_DIGEST_ALGORITHM } from "./working-tree-digest.js";

export function passingVerifyCommandsForDigest(task, digest) {
  if (task?.workingTreeDigestAlgorithm !== WORKING_TREE_DIGEST_ALGORITHM || !isCurrentWorkingTreeDigest(digest)) return new Set();
  return new Set([...latestObservedVerificationEvidence(task?.verifyEvidence).values()]
    .filter((evidence) => verificationEvidenceProvesStableTree(evidence, digest))
    .map((evidence) => String(evidence.command ?? "").trim()));
}

export function allVerifyCommandsPassCurrentTree(task, digest) {
  const planned = meaningfulVerificationCommands(task?.verifyCommands ?? []);
  if (planned.length === 0) return false;
  const passing = passingVerifyCommandsForDigest(task, digest);
  return planned.every((command) => passing.has(command.trim()));
}

export function compactTaskDetails(task) {
  return {
    schemaVersion: task.schemaVersion,
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    changeMode: task.changeMode,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    previousAttempts: task.previousAttempts,
    riskLane: task.riskLane,
    intakeMode: task.intakeMode ?? "model",
    scope: task.scope,
    verifyGroup: task.verifyGroup,
    verifyCommands: task.verifyCommands,
    acceptanceReceipt: acceptanceReceiptSummary(task.acceptanceReceipt),
    acceptanceProvenance: acceptanceReceiptProvenanceSummary(task.acceptanceReceipt),
    authoritySnapshot: task.authoritySnapshot ? { profile: task.authoritySnapshot.profile, manifestDigest: task.authoritySnapshot.manifestDigest, snapshotDigest: task.authoritySnapshot.snapshotDigest } : null,
    workPlan: task.workPlan,
    reviewLenses: task.reviewLenses,
    orchestration: task.orchestration
      ? {
          mode: task.orchestration.mode,
          subagents: task.orchestration.subagents,
          reason: task.orchestration.reason
        }
      : undefined,
    lifecycleMode: runtimeLifecycleMode(task)
  };
}

export function mergeObservedTaskContext(task, entries, maxManifestFiles, redact = (value) => String(value ?? "")) {
  const known = new Set((task.contextManifest ?? []).map((item) => item.path));
  const added = [];
  for (const entry of entries ?? []) {
    if (task.contextManifest.length >= maxManifestFiles || known.has(entry.path)) continue;
    task.contextManifest.push({ path: entry.path, reason: redact(entry.reason) });
    known.add(entry.path);
    added.push(entry.path);
  }
  return added;
}

export function changedSnapshotFiles(before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((file) => before?.[file] !== after?.[file])
    .sort();
}

/**
 * Return the exact current task delta, including a task-start dirty file that
 * was restored or deleted. Runtime mutation history is deliberately excluded:
 * only the baseline/current evidence pair can authorize review or completion.
 */
export function taskDeltaFilesFromSnapshot(task, currentSnapshot) {
  return changedSnapshotFiles(task?.baselineFileDigests ?? {}, currentSnapshot ?? {});
}

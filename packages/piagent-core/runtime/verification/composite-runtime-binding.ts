import { createHash } from "node:crypto";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { readTaskJournal } from "../../extensions/task-journal.js";
import { applyAssistedReadOnlyFinalHandoff, applyRuntimeLifecycleObservation,
  runtimeLifecycleMode } from "../../extensions/task-lifecycle.js";
import { readTrajectoryStore } from "../trajectory/trajectory-store.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function compositeTaskContractDigest(task: TaskContract): string {
  const steps = task.workPlan?.map(({ id, title, role, mode, dependsOn }) => ({ id, title, role, mode, dependsOn })) ?? [];
  const criteria = task.acceptanceReceipt?.criteria?.map(({ id, hash, obligation, priority }) => ({ id, hash, obligation, priority })) ?? [];
  return sha(JSON.stringify({ schemaVersion: task.schemaVersion, taskRunId: task.taskRunId, taskId: task.taskId,
    sessionId: task.sessionId, changeMode: task.changeMode, mutationPolicy: task.mutationPolicy ?? null, attempt: task.attempt,
    maxAttempts: task.maxAttempts, summary: task.summary, operatorRequestDigest: task.operatorRequestDigest ?? null,
    riskLane: task.riskLane, intakeMode: task.intakeMode ?? null, expectedOutput: task.expectedOutput,
    acceptanceCriteria: task.acceptanceCriteria, criteria, criterionGraph: task.criterionGraph ?? null, scope: task.scope,
    outOfScope: task.outOfScope, protectedPaths: task.protectedPaths, requiredContext: task.requiredContext,
    mcpCapabilities: task.mcpCapabilities, verifyGroup: task.verifyGroup ?? null, verifyCommands: task.verifyCommands,
    workPlan: steps, reviewLenses: task.reviewLenses, orchestration: task.orchestration ?? null,
    authoritySnapshot: task.authoritySnapshot ?? null, workingTreeDigestAlgorithm: task.workingTreeDigestAlgorithm,
    baselineChangedFiles: task.baselineChangedFiles, baselineFileDigests: task.baselineFileDigests, createdAt: task.createdAt }));
}

export function compositePhaseHeadDigest(cwd: string, task: TaskContract): string {
  const journal = readTaskJournal(cwd, { taskRunId: task.taskRunId, sessionId: task.sessionId, maximumBytes: 32 * 1024 * 1024 });
  const trajectory = readTrajectoryStore(cwd, task.taskRunId);
  if (journal.corruptions.length || journal.inputTruncated || journal.recoverableTailBytes || !trajectory.enforcementSafe) {
    throw new Error("Task or trajectory journal is not current");
  }
  if (trajectory.state && (trajectory.state.taskRunId !== task.taskRunId || trajectory.state.taskId !== task.taskId)) {
    throw new Error("Trajectory identity does not match the task");
  }
  return sha(JSON.stringify({ taskJournalHead: journal.head ?? null,
    trajectoryState: trajectory.state ? sha(JSON.stringify(trajectory.state)) : null,
    trajectoryEvents: trajectory.events.length ? sha(JSON.stringify(trajectory.events)) : null }));
}

export function assertCompositeCriterion(task: TaskContract, contract: any): void {
  const receipt = task.acceptanceReceipt?.criteria;
  if (!task.operatorRequestDigest || !Array.isArray(task.acceptanceCriteria) || !Array.isArray(receipt)
    || task.acceptanceCriteria.length !== receipt.length || contract.criterionIndex >= receipt.length
    || new Set(receipt.map(item => item.id)).size !== receipt.length
    || receipt.some((item, index) => item.hash !== sha(task.acceptanceCriteria[index]))
    || task.acceptanceCriteria[contract.criterionIndex] !== contract.criterionText
    || receipt[contract.criterionIndex].id !== contract.criterionId
    || receipt[contract.criterionIndex].hash !== contract.criterionHash) {
    throw new Error("Composite plan does not match the exact current task criterion");
  }
}

/** Pure projection only. The caller must separately prove every supplied kind is
 * a current authenticated fact; this helper never issues acceptance authority. */
export function projectCompositeLifecycle(task: TaskContract, factKinds: Iterable<string>): TaskContract | false {
  if (task.trace.outcome !== "pending") return false;
  const kinds = new Set(factKinds), projected = structuredClone(task), mode = runtimeLifecycleMode(projected);
  if (["automatic", "assisted"].includes(mode)) {
    if (!["workspace-scope", "tool-policy-complete", "project-verifier-current"].every(kind => kinds.has(kind))) return false;
    applyRuntimeLifecycleObservation(projected, "verification-complete");
    return projected;
  }
  if (["automatic-readonly", "assisted-readonly"].includes(mode)) {
    const substantive = ["context-current", "structured-log-claims", "config-document-literals",
      "policy-refusal-output", "bounded-code-checks"].some(kind => kinds.has(kind));
    if (!substantive || !["workspace-scope", "tool-policy-complete"].every(kind => kinds.has(kind))) return false;
    applyRuntimeLifecycleObservation(projected, "context-complete");
    applyAssistedReadOnlyFinalHandoff(projected, { durableReadEvidence: true, finalHandoffObserved: true });
    return projected;
  }
  return projected;
}

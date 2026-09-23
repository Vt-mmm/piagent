import type { TaskContract } from "../../extensions/guard-types.ts";
import { latestObservedVerificationEvidence, verificationEvidenceProvesStableTree } from "../../extensions/verification-intelligence.js";

export type CompletionSource = { approved: boolean; treeDigest: string | null; revisionDigest: string | null };

// A report consumes an existing gate result. It cannot approve completion.
// This metric means first observed edit reaching the accepted final source,
// not proof that an individual hunk alone solved the task.
export function firstCorrectEditTiming(task: TaskContract, records: Record<string, any>[],
  completeTelemetry: boolean, source?: CompletionSource) {
  const unavailable = { timeToFirstCorrectEditMs: null, timeToFirstCorrectEditReason: "edit-to-current-verifier-and-completion-evidence-unavailable" };
  if (!completeTelemetry || !source?.approved || !source.treeDigest || !source.revisionDigest
    || task.trace.outcome !== "completed" || !task.verifyCommands.length) return unavailable;
  const latest = latestObservedVerificationEvidence(task.verifyEvidence);
  const verifiers = task.verifyCommands.map((command) => latest.get(command.trim()));
  if (!verifiers.every((entry) => verificationEvidenceProvesStableTree(entry, source.treeDigest, source.revisionDigest))) return unavailable;
  const startedAt = Date.parse(task.createdAt);
  const earliestVerifier = Math.min(...verifiers.map((entry: any) => Date.parse(entry.observedAt)));
  const candidates = records.filter((event) => event.event === "tool_result" && event.taskUsageVersion === 1
    && event.taskId === task.taskId && event.taskRunId === task.taskRunId && event.sessionId === task.sessionId
    && event.mutationObserved === true && event.isError === false && typeof event.toolCallId === "string"
    && event.postWorkingTreeDigest === source.treeDigest && event.postWorkspaceRevisionDigest === source.revisionDigest)
    .map((event) => Date.parse(event.recordedAt)).filter((time) => Number.isFinite(time) && time >= startedAt && time < earliestVerifier);
  return candidates.length ? { timeToFirstCorrectEditMs: Math.min(...candidates) - startedAt,
    timeToFirstCorrectEditReason: "observed-edit-to-accepted-source; same-tree-and-revision-verifiers" } : unavailable;
}

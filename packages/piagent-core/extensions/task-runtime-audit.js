import crypto from "node:crypto";

import { recordCompletedTaskMemory } from "./repository-memory.js";
import { recordTaskCheckpoint } from "./task-journal.js";

function notify(ctx, message) {
  ctx.ui.notify(message, "warning");
}

export function recordRuntimeTaskCheckpoint(ctx, checkpoint) {
  try {
    return recordTaskCheckpoint(ctx.cwd, checkpoint);
  } catch (error) {
    notify(ctx, `Piagent task journal needs recovery: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function recordMutationCheckpoint(ctx, task, evidence = {}) {
  return recordRuntimeTaskCheckpoint(ctx, {
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    checkpointId: "execute",
    idempotencyKey: `execute:${task.updatedAt}`,
    phase: "execute",
    status: "in-progress",
    attempt: task.attempt,
    evidence
  });
}

export function recordVerificationCheckpoint(ctx, task, verification = {}) {
  const observation = verification.observedAt ?? task.updatedAt;
  const preTree = verification.preWorkingTreeDigest ?? verification.evidence?.preWorkingTreeDigest;
  const identity = crypto.createHash("sha256").update(JSON.stringify([verification.commandHash, preTree, verification.workingTreeDigest, verification.exitCode, observation])).digest("hex");
  return recordRuntimeTaskCheckpoint(ctx, {
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    checkpointId: `verify-${String(verification.commandHash ?? "unknown").slice(0, 12)}`,
    idempotencyKey: `verify:${identity}`,
    phase: "verify",
    status: verification.exitCode === 0 ? "done" : "failed",
    attempt: task.attempt,
    evidence: verification.evidence
  });
}

export function recordTaskStartCheckpoint(ctx, task, checkpointId, lifecycleMode) {
  return recordRuntimeTaskCheckpoint(ctx, {
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    checkpointId,
    idempotencyKey: `task-start:${task.taskRunId}`,
    phase: checkpointId,
    status: "in-progress",
    attempt: task.attempt,
    evidence: { riskLane: task.riskLane, lifecycleMode }
  });
}

export function recordTaskProgressCheckpoints(ctx, task, progress = {}) {
  recordRuntimeTaskCheckpoint(ctx, {
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    checkpointId: progress.stepId,
    idempotencyKey: `progress:${progress.stepId}:${progress.status}:${progress.recordedAt}`,
    phase: progress.stepId,
    status: progress.status,
    attempt: task.attempt,
    evidence: progress.evidence
  });
  if (!progress.startedStep) return;
  recordRuntimeTaskCheckpoint(ctx, {
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    checkpointId: progress.startedStep,
    idempotencyKey: `progress:${progress.startedStep}:in-progress:${progress.recordedAt}`,
    phase: progress.startedStep,
    status: "in-progress",
    attempt: task.attempt,
    evidence: { startedAfter: progress.stepId }
  });
}

export function recordCompletionAudit(ctx, task, completion = {}) {
  const outcome = completion.outcome ?? "blocked";
  const status = completion.status
    ?? (outcome === "completed" ? "done" : outcome === "failed" ? "failed" : outcome === "partial" ? "paused" : "blocked");
  const checkpoint = recordRuntimeTaskCheckpoint(ctx, {
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    sessionName: task.sessionName,
    checkpointId: "completion",
    idempotencyKey: `completion:${outcome}:${completion.idempotencyAt ?? task.updatedAt}`,
    phase: completion.phase ?? "review",
    status,
    attempt: task.attempt,
    evidence: completion.evidence
  });
  if (outcome === "completed") {
    try {
      recordCompletedTaskMemory(ctx.cwd, task);
    } catch (error) {
      notify(ctx, `Piagent repository memory was not updated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return checkpoint;
}

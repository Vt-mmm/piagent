import crypto from "node:crypto";

const OPERATION_STATUSES = ["completed", "blocked", "aborted", "error", "unknown"];
const TASK_STATUSES = ["pending", "completed", "refused", "failed", "unknown"];

function safeCandidateOutcome(value) {
  if (value?.schemaVersion === 2 && value.kind === "terminal-lifecycle-mismatch"
    && OPERATION_STATUSES.includes(value.expectedOperationStatus) && OPERATION_STATUSES.includes(value.observedOperationStatus)
    && TASK_STATUSES.includes(value.expectedTaskStatus) && TASK_STATUSES.includes(value.observedTaskStatus)
    && (value.expectedOperationStatus !== value.observedOperationStatus || value.expectedTaskStatus !== value.observedTaskStatus)
    && Number.isSafeInteger(value.turnIndex) && value.turnIndex > 0) {
    return { schemaVersion: 2, kind: value.kind, expectedOperationStatus: value.expectedOperationStatus,
      observedOperationStatus: value.observedOperationStatus, expectedTaskStatus: value.expectedTaskStatus,
      observedTaskStatus: value.observedTaskStatus, turnIndex: value.turnIndex };
  }
  const expected = [...OPERATION_STATUSES, "refused"];
  if (value?.schemaVersion !== 1 || value.kind !== "terminal-settlement-mismatch"
    || !expected.includes(value.expectedSettlement) || !OPERATION_STATUSES.includes(value.observedSettlement)
    || value.expectedSettlement === value.observedSettlement
    || !Number.isSafeInteger(value.turnIndex) || value.turnIndex < 1) return null;
  return { schemaVersion: 1, kind: value.kind, expectedSettlement: value.expectedSettlement,
    observedSettlement: value.observedSettlement, turnIndex: value.turnIndex };
}

export function candidateOutcomeFailureReason(value) {
  const outcome = safeCandidateOutcome(value);
  if (!outcome) return null;
  return outcome.kind === "terminal-lifecycle-mismatch"
    ? `webui-terminal-lifecycle-operation-${outcome.observedOperationStatus}-expected-${outcome.expectedOperationStatus}`
      + `-task-${outcome.observedTaskStatus}-expected-${outcome.expectedTaskStatus}-turn-${outcome.turnIndex}`
    : `webui-terminal-settlement-${outcome.observedSettlement}-expected-${outcome.expectedSettlement}-turn-${outcome.turnIndex}`;
}

export function persistedJourneyReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const digest = value => typeof value === "string" && value
    ? crypto.createHash("sha256").update(value).digest("hex") : null;
  return {
    schemaVersion: 1, channel: receipt.channel ?? "unknown", completed: receipt.completed === true,
    reconnects: Number.isSafeInteger(receipt.reconnects) ? receipt.reconnects : 0,
    sessionDigest: digest(receipt.sessionRef ?? receipt.threadId),
    turns: Array.isArray(receipt.turns) ? receipt.turns.map(turn => ({
      index: turn.index, id: turn.id ?? null, promptHash: turn.promptHash ?? null,
      messageRequestDigest: digest(turn.messageRequestId), operationDigest: digest(turn.operationRef),
      resumed: turn.resumed === true, receiptPhase: turn.receiptPhase ?? null,
      receiptResult: turn.receiptResult ?? null, receiptUncertain: turn.receiptUncertain === true,
      expectedSettlement: ["completed", "refused"].includes(turn.expectedSettlement) ? turn.expectedSettlement : null,
      expectedOperationStatus: OPERATION_STATUSES.includes(turn.expectedOperationStatus) ? turn.expectedOperationStatus : null,
      expectedTaskStatus: TASK_STATUSES.includes(turn.expectedTaskStatus) ? turn.expectedTaskStatus : null,
      operationStatus: OPERATION_STATUSES.includes(turn.operationStatus) ? turn.operationStatus : null,
      taskStatus: TASK_STATUSES.includes(turn.taskStatus) ? turn.taskStatus : null,
      ...(safeCandidateOutcome(turn.outcome) ? { outcome: safeCandidateOutcome(turn.outcome) } : {}),
      ...(turn.recovery && typeof turn.recovery === "object" ? { recovery: {
        responseObserved: turn.recovery.responseObserved === true,
        responseDiscarded: turn.recovery.responseDiscarded === true,
        connectionDropped: turn.recovery.connectionDropped === true,
        replayCursor: Number.isSafeInteger(turn.recovery.replayCursor) ? turn.recovery.replayCursor : null,
        recoveredFromKind: ["runtime.changed", "operation.settled"].includes(turn.recovery.recoveredFromKind)
          ? turn.recovery.recoveredFromKind : null,
        recoveredAtSequence: Number.isSafeInteger(turn.recovery.recoveredAtSequence)
          ? turn.recovery.recoveredAtSequence : null,
        correlatedByMessageRequestId: turn.recovery.correlatedByMessageRequestId === true,
        sendAttempts: turn.recovery.sendAttempts === 1 ? 1 : null,
        durableUserCopies: turn.recovery.durableUserCopies === 1 ? 1 : null
      } } : {}),
      settlement: turn.settlement ?? null, exitCode: Number.isInteger(turn.exitCode) ? turn.exitCode : null,
      timedOut: turn.timedOut === true, durationSeconds: Number.isFinite(turn.durationSeconds) ? turn.durationSeconds : null,
      usageExact: turn.usageExact === true, durableUserIndex: Number.isInteger(turn.durableUserIndex) ? turn.durableUserIndex : null,
      durableAssistantIndex: Number.isInteger(turn.durableAssistantIndex) ? turn.durableAssistantIndex : null,
      firstSequence: Number.isSafeInteger(turn.firstSequence) ? turn.firstSequence : null,
      lastSequence: Number.isSafeInteger(turn.lastSequence) ? turn.lastSequence : null,
      kinds: Array.isArray(turn.kinds) ? turn.kinds : [], fileLabels: Array.isArray(turn.fileLabels) ? turn.fileLabels : [],
      toolCalls: Number.isSafeInteger(turn.toolCalls) ? turn.toolCalls : null,
      failedToolCalls: Number.isSafeInteger(turn.failedToolCalls) ? turn.failedToolCalls : null,
      ...(turn.timingDiagnostics ? { timingDiagnostics: turn.timingDiagnostics } : {})
    })) : []
  };
}

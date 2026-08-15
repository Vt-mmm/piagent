import type { RuntimeEventDraft } from "../../piagent-core/runtime/inspection/runtime-event-store.ts";
import type { BridgeSnapshot } from "./same-session-bridge.ts";
import type { LifecycleEvent } from "./lifecycle-controller.ts";

export function lifecycleRuntimeDraft(event: LifecycleEvent, snapshot: BridgeSnapshot, observedAt = new Date().toISOString()): RuntimeEventDraft | null {
  if (event.kind !== "control.changed" || !event.fact) return null;
  const identity = snapshot.identity, revisions = snapshot.revisions;
  if (!identity?.taskId || !identity.taskRunId || !revisions || !event.commandId || !event.idempotencyKeyDigest
    || !event.fromControlState || !event.toControlState || !event.expectedControlRevision || event.requestSequence === undefined) return null;
  const operationId = event.agentOperationId ?? identity.agentOperationId;
  if (event.fact.startsWith("stop-") && !operationId) return null;
  return { sourceObservedAt: observedAt, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
    sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId, agentOperationId: operationId,
    turnIndex: null, messageRef: null, toolCallId: null, revision: revisions, kind: `task-control.${event.fact}` as RuntimeEventDraft["kind"],
    correlation: { commandId: event.commandId, messageRequestId: null, replacementId: null, approvalRequestId: null,
      causationEventId: null, idempotencyKeyDigest: event.idempotencyKeyDigest }, evidence: "observed",
    payload: { action: event.action?.replace("lifecycle.", ""), fact: event.fact, fromControlState: event.fromControlState,
      toControlState: event.toControlState, taskOutcome: "pending", resultCode: event.resultCode, requestSequence: event.requestSequence,
      parentSequence: event.parentSequence ?? null, expectedControlRevision: event.expectedControlRevision,
      preWorkingTreeDigest: event.preWorkingTreeDigest ?? null, postWorkingTreeDigest: event.postWorkingTreeDigest ?? null,
      dispatchState: event.fact === "resume-rejected" ? "rejected" : "none" },
    redaction: { applied: false, valuesRemoved: 0, truncated: false } };
}

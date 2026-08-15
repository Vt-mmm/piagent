/* Generated from schemas/piagent-webui/runtime-event-v2.schema.json. Do not edit. */

/**
 * A bounded, browser-safe event projection. This schema intentionally excludes raw Pi payloads, filesystem and session paths, provider headers, reasoning content, and raw tool arguments or results.
 */
export type PiagentWebUIBoundedRuntimeEventV2 = {
  [k: string]: any;
} & (
  | RuntimeStartedEvent
  | RuntimeHealthChangedEvent
  | RuntimeDisconnectedEvent
  | RuntimeResyncRequiredEvent
  | RuntimeResyncedEvent
  | RuntimePhaseChangedEvent
  | SessionBoundEvent
  | SessionInfoChangedEvent
  | SessionReplacementRequestedEvent
  | SessionReplacementPendingEvent
  | SessionReplacementCommittedEvent
  | SessionReplacementCancelledEvent
  | SessionReplacementFailedEvent
  | SessionCompactionPreflightEvent
  | SessionCompactedEvent
  | SessionShutdownEvent
  | AgentOperationStartedEvent
  | AgentOperationLoopEndedEvent
  | AgentOperationSettledEvent
  | AgentOperationStopRequestedEvent
  | AgentOperationStopSettledEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | MessageStartedEvent
  | MessageTextDeltaEvent
  | MessageThinkingStateEvent
  | MessageCompletedEvent
  | MessageFailedEvent
  | ChatHeldEvent
  | ChatDispatchRequestedEvent
  | ChatDispatchObservedEvent
  | ChatDispatchRejectedEvent
  | ChatDispatchUnknownEvent
  | ModelChangedEvent
  | ThinkingChangedEvent
  | TaskStartedEvent
  | TaskStateChangedEvent
  | TaskOutcomeChangedEvent
  | TaskControlStopRequestedEvent
  | TaskControlStopSettledEvent
  | TaskControlPauseRequestedEvent
  | TaskControlPausedEvent
  | TaskControlPauseCancelledEvent
  | TaskControlResumeRequestedEvent
  | TaskControlResumedEvent
  | TaskControlResumeRejectedEvent
  | TaskControlContinueRequestedEvent
  | TaskControlContinueDispatchedEvent
  | TaskControlContinueUncertainEvent
  | QueueChangedEvent
  | ActivityRequestedEvent
  | ActivityStartedEvent
  | ActivityProgressEvent
  | ActivityFinishedEvent
  | ActivityFailedEvent
  | ActivityBlockedEvent
  | ActivityAbortedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ApprovalExpiredEvent
  | SourceChangedEvent
  | VerifierStartedEvent
  | VerifierFinishedEvent
  | VerifierStaleEvent
  | UsageUpdatedEvent
  | HandoffUpdatedEvent
) & {
    schemaVersion: 2;
    eventId: string;
    eventCursor: string;
    writerSequence: number;
    recordedAt: string;
    sourceObservedAt: NullableTimestamp;
    projectRef: string;
    runtimeInstanceId: string;
    sessionRef: string;
    taskId: string | null;
    taskRunId: string | null;
    agentOperationId: string | null;
    turnIndex: NullableTurnIndex;
    messageRef: string | null;
    toolCallId: string | null;
    revision: DomainRevision;
    kind: EventKind;
    correlation: Correlation;
    evidence: "observed" | "derived";
    payload: {
      [k: string]: any;
    };
    redaction: Redaction;
  };
export type RuntimeStartedPayload = {
  [k: string]: any;
} & {
  connectionState: "connected";
  operationState: OperationState;
  buildRef: string;
  capabilitySnapshotRef: string;
  reasonCode: string | null;
};
export type OperationState = "idle" | "running" | "stopping" | "settled" | "unknown";
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};
export type RuntimePhaseChangedPayload = {
  [k: string]: any;
} & {
  factState: FactState;
  phase:
    | "idle"
    | "input-preflight"
    | "model"
    | "tool-preflight"
    | "waiting-approval"
    | "tool"
    | "retry"
    | "compaction"
    | "branch-summary"
    | "direct-bash"
    | "settling"
    | "other"
    | "unknown";
  operationState: OperationState;
  reasonCode: string | null;
};
export type FactState = "known" | "unknown" | "unavailable" | "disconnected" | "resync-required";
export type SessionBoundPayload = {
  [k: string]: any;
} & {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  replacementId: string | null;
};
export type ReplacementReason = "new" | "resume" | "fork";
export type SessionReplacementCommittedPayload = {
  [k: string]: any;
} & {
  reason: ReplacementReason;
  previousSessionRef: string;
  currentSessionRef: string;
  currentSessionValidated: boolean;
  gateState: "open" | "closed";
};
export type SessionReplacementCancelledPayload = {
  [k: string]: any;
} & {
  reason: ReplacementReason;
  unchangedSessionRevalidated: boolean;
  gateState: "open" | "closed";
  reasonCode: string;
};
export type SessionReplacementFailedPayload = {
  [k: string]: any;
} & {
  reason: ReplacementReason;
  unchangedSessionRevalidated: boolean;
  gateState: "open" | "closed";
  resyncRequired: boolean;
  reasonCode: string;
  message: string | null;
};
export type NullableDigest = string | null;
export type NullableCount = number | null;
export type BooleanFact =
  | {
      state: "known";
      value: boolean;
      reasonCode: null;
    }
  | {
      state: "unknown" | "unavailable" | "disconnected" | "resync-required";
      value: null;
      reasonCode: string;
    };
export type NullableStopReason = StopReason | null;
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
export type AgentOperationStopSettledPayload = {
  [k: string]: any;
} & {
  result:
    "already-idle" | "stopped" | "unsupported-operation-phase" | "settlement-unknown" | "audit-unavailable" | "failed";
  operationState: OperationState;
  reasonCode: string;
};
export type MessageRole =
  "user" | "assistant" | "tool-result" | "bash-execution" | "custom" | "branch-summary" | "compaction-summary";
export type SafeChunk = string;
export type NullableLongDisplayText = string | null;
export type NullableTokenUsage = TokenUsage | null;
export type ChatHeldEvent = ChatControlEventBase & {
  kind: "chat.held";
  payload: {
    state: "held";
    delivery: "hold";
    [k: string]: any;
  };
  [k: string]: any;
};
export type ChatDispatchRequestedEvent = ChatControlEventBase & {
  kind: "chat.dispatch-requested";
  payload: {
    state: "dispatch-requested";
    delivery: "new-operation" | "steer" | "follow-up";
    [k: string]: any;
  };
  [k: string]: any;
};
export type ChatDispatchObservedEvent = ChatControlEventBase & {
  kind: "chat.dispatch-observed";
  agentOperationId: string;
  messageRef: string;
  payload: {
    state: "dispatch-observed";
    delivery: "new-operation" | "steer" | "follow-up";
    [k: string]: any;
  };
  [k: string]: any;
};
export type ChatDispatchRejectedEvent = ChatControlEventBase & {
  kind: "chat.dispatch-rejected";
  payload: {
    state: "dispatch-rejected";
    [k: string]: any;
  };
  [k: string]: any;
};
export type ChatDispatchUnknownEvent = ChatControlEventBase & {
  kind: "chat.dispatch-unknown";
  payload: {
    state: "dispatch-unknown";
    delivery: "new-operation" | "steer" | "follow-up";
    [k: string]: any;
  };
  [k: string]: any;
};
export type NullableSafeModel = SafeModel | null;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type NullableThinkingLevel = ThinkingLevel | null;
export type TaskOutcomeChangedPayload = {
  [k: string]: any;
} & {
  previousOutcome: NullableTaskOutcome;
  currentOutcome: TaskOutcome;
  terminal: boolean;
  reasonCode: string;
  taskContractDigest: string;
};
export type NullableTaskOutcome = TaskOutcome | null;
export type TaskOutcome = "pending" | "completed" | "blocked" | "partial" | "failed";
export type TaskControlStopRequestedEvent = TaskControlEventBase & {
  kind: "task-control.stop-requested";
  agentOperationId: string;
  payload: {
    action: "stop";
    fact: "stop-requested";
    resultCode: "stop-requested";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlPayload = {
  taskOutcome?: "pending";
  expectedControlRevision?: string;
  [k: string]: any;
} & {
  [k: string]: any;
} & {
  action: "stop" | "pause" | "resume" | "resume-and-continue";
  fact:
    | "stop-requested"
    | "stop-settled"
    | "pause-requested"
    | "paused"
    | "pause-cancelled"
    | "resume-requested"
    | "resumed"
    | "resume-rejected"
    | "continue-requested"
    | "continue-dispatched"
    | "continue-uncertain";
  fromControlState: NullableControlState;
  toControlState: ControlState;
  taskOutcome: TaskOutcome;
  resultCode: string;
  requestSequence: number;
  parentSequence: number | null;
  expectedControlRevision: string | null;
  preWorkingTreeDigest: string | null;
  postWorkingTreeDigest: string | null;
  dispatchState: "none" | "requested" | "observed" | "rejected" | "unknown";
};
export type NullableControlState = ControlState | null;
export type ControlState = "active" | "pause-requested" | "paused" | "terminal" | "unknown";
export type TaskControlStopSettledEvent = TaskControlEventBase & {
  kind: "task-control.stop-settled";
  agentOperationId: string;
  payload: {
    action: "stop";
    fact: "stop-settled";
    resultCode: "stopped" | "already-idle" | "emergency-stop" | "audit-unavailable" | "settlement-unknown";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlPauseRequestedEvent = TaskControlEventBase & {
  kind: "task-control.pause-requested";
  payload: {
    action: "pause";
    fact: "pause-requested";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlPausedEvent = TaskControlEventBase & {
  kind: "task-control.paused";
  payload: {
    action: "pause";
    fact: "paused";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlPauseCancelledEvent = TaskControlEventBase & {
  kind: "task-control.pause-cancelled";
  payload: {
    action: "resume";
    fact: "pause-cancelled";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlResumeRequestedEvent = TaskControlEventBase & {
  kind: "task-control.resume-requested";
  payload: {
    action: "resume";
    fact: "resume-requested";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlResumedEvent = TaskControlEventBase & {
  kind: "task-control.resumed";
  payload: {
    action: "resume";
    fact: "resumed";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlResumeRejectedEvent = TaskControlEventBase & {
  kind: "task-control.resume-rejected";
  payload: {
    action: "resume";
    fact: "resume-rejected";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlContinueRequestedEvent = TaskControlEventBase & {
  kind: "task-control.continue-requested";
  correlation: {
    messageRequestId: string;
    [k: string]: any;
  };
  payload: {
    action: "resume-and-continue";
    fact: "continue-requested";
    dispatchState: "requested";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlContinueDispatchedEvent = TaskControlEventBase & {
  kind: "task-control.continue-dispatched";
  agentOperationId: string;
  messageRef: string;
  correlation: {
    messageRequestId: string;
    [k: string]: any;
  };
  payload: {
    action: "resume-and-continue";
    fact: "continue-dispatched";
    dispatchState: "observed";
    [k: string]: any;
  };
  [k: string]: any;
};
export type TaskControlContinueUncertainEvent = TaskControlEventBase & {
  kind: "task-control.continue-uncertain";
  correlation: {
    messageRequestId: string;
    [k: string]: any;
  };
  payload: {
    action: "resume-and-continue";
    fact: "continue-uncertain";
    dispatchState: "unknown";
    [k: string]: any;
  };
  [k: string]: any;
};
export type QueueChangedPayload = {
  [k: string]: any;
} & {
  queueKind: "runtime-held" | "pi-steering" | "pi-follow-up" | "aggregate";
  state: "held" | "dispatching" | "quarantined" | "cleared" | "unknown" | "unavailable";
  pendingCount: NullableCount;
  hasPending: NullableBoolean;
  /**
   * @maxItems 128
   */
  messageRequestIds: string[];
  reasonCode: string | null;
};
export type NullableBoolean = boolean | null;
export type ActivityPayload = {
  [k: string]: any;
} & {
  state: "requested" | "started" | "progress" | "finished" | "failed" | "blocked" | "aborted";
  activityType: "tool" | "provider" | "command" | "verifier" | "compaction" | "retry" | "task" | "other";
  activityRef: string;
  toolName: NullableToolName;
  inputDigest: NullableDigest;
  outputDigest: NullableDigest;
  preview: NullableLongDisplayText;
  previewKind: "none" | "summary" | "log" | "text";
  outputBytes: NullableCount;
  outputLines: NullableCount;
  exitCode: NullableExitCode;
  isError: NullableBoolean;
  /**
   * @maxItems 256
   */
  affectedFileRefs: string[];
  /**
   * @maxItems 128
   */
  criterionIds: string[];
  /**
   * @maxItems 128
   */
  verifierAttemptIds: string[];
  reasonCode: string | null;
};
export type NullableToolName = ToolName | null;
export type ToolName = string;
export type NullableExitCode = number | null;
export type NullableTimestamp = string | null;
export type VerifierPayload = {
  [k: string]: any;
} & {
  state: "started" | "passed" | "failed" | "blocked" | "aborted" | "stale" | "unavailable";
  verifierAttemptId: string;
  verifierRef: string;
  displayName: string;
  commandDigest: string;
  exact: boolean;
  exitCode: NullableExitCode;
  workingTreeDigest: string | null;
  /**
   * @maxItems 512
   */
  staleFileRefs: string[];
  logPreview: NullableLongDisplayText;
  logDigest: NullableDigest;
  reasonCode: string | null;
};
export type NullableTurnIndex = number | null;
export type EventKind =
  | "runtime.started"
  | "runtime.health-changed"
  | "runtime.disconnected"
  | "runtime.resync-required"
  | "runtime.resynced"
  | "runtime.phase-changed"
  | "session.bound"
  | "session.info-changed"
  | "session.replacement-requested"
  | "session.replacement-pending"
  | "session.replacement-committed"
  | "session.replacement-cancelled"
  | "session.replacement-failed"
  | "session.compaction-preflight"
  | "session.compacted"
  | "session.shutdown"
  | "agent-operation.started"
  | "agent-operation.loop-ended"
  | "agent-operation.settled"
  | "agent-operation.stop-requested"
  | "agent-operation.stop-settled"
  | "turn.started"
  | "turn.ended"
  | "message.started"
  | "message.text-delta"
  | "message.thinking-state"
  | "message.completed"
  | "message.failed"
  | "chat.held"
  | "chat.dispatch-requested"
  | "chat.dispatch-observed"
  | "chat.dispatch-rejected"
  | "chat.dispatch-unknown"
  | "session-option.model-changed"
  | "session-option.thinking-changed"
  | "task.started"
  | "task.state-changed"
  | "task.outcome-changed"
  | "task-control.stop-requested"
  | "task-control.stop-settled"
  | "task-control.pause-requested"
  | "task-control.paused"
  | "task-control.pause-cancelled"
  | "task-control.resume-requested"
  | "task-control.resumed"
  | "task-control.resume-rejected"
  | "task-control.continue-requested"
  | "task-control.continue-dispatched"
  | "task-control.continue-uncertain"
  | "queue.changed"
  | "activity.requested"
  | "activity.started"
  | "activity.progress"
  | "activity.finished"
  | "activity.failed"
  | "activity.blocked"
  | "activity.aborted"
  | "approval.requested"
  | "approval.resolved"
  | "approval.expired"
  | "source.changed"
  | "verifier.started"
  | "verifier.finished"
  | "verifier.stale"
  | "usage.updated"
  | "handoff.updated";
export type Redaction = {
  [k: string]: any;
} & {
  applied: boolean;
  valuesRemoved: number;
  truncated: boolean;
};

export interface RuntimeStartedEvent {
  kind: "runtime.started";
  payload: RuntimeStartedPayload;
  [k: string]: any;
}
export interface RuntimeHealthChangedEvent {
  kind: "runtime.health-changed";
  payload: RuntimeHealthChangedPayload;
  [k: string]: any;
}
export interface RuntimeHealthChangedPayload {
  health: Health;
}
export interface RuntimeDisconnectedEvent {
  kind: "runtime.disconnected";
  payload: RuntimeDisconnectedPayload;
  [k: string]: any;
}
export interface RuntimeDisconnectedPayload {
  reasonCode: string;
  message: string | null;
  lastKnownCursor: string | null;
  recoverable: boolean;
  resyncRequired: boolean;
}
export interface RuntimeResyncRequiredEvent {
  kind: "runtime.resync-required";
  payload: RuntimeResyncRequiredPayload;
  [k: string]: any;
}
export interface RuntimeResyncRequiredPayload {
  reasonCode: string;
  message: string | null;
  lastAcceptedCursor: string | null;
  minimumAvailableCursor: string | null;
  snapshotRequired: true;
}
export interface RuntimeResyncedEvent {
  kind: "runtime.resynced";
  payload: RuntimeResyncedPayload;
  [k: string]: any;
}
export interface RuntimeResyncedPayload {
  previousCursor: string | null;
  snapshotRef: string;
  snapshotRevision: SnapshotRevision;
  currentCursor: string;
}
export interface SnapshotRevision {
  runtimeRevision: string;
  taskRevision: string | null;
  controlRevision: string | null;
  workspaceRevision: string | null;
  indexRevision: string | null;
  approvalRevision: string | null;
  sessionOptionRevision: string | null;
  queueRevision: string | null;
  journalHead: string | null;
  eventCursor: string;
}
export interface RuntimePhaseChangedEvent {
  kind: "runtime.phase-changed";
  payload: RuntimePhaseChangedPayload;
  [k: string]: any;
}
export interface SessionBoundEvent {
  kind: "session.bound";
  payload: SessionBoundPayload;
  [k: string]: any;
}
export interface SessionInfoChangedEvent {
  kind: "session.info-changed";
  payload: SessionInfoChangedPayload;
  [k: string]: any;
}
export interface SessionInfoChangedPayload {
  displayName: string | null;
}
export interface SessionReplacementRequestedEvent {
  kind: "session.replacement-requested";
  correlation: {
    replacementId: string;
    [k: string]: any;
  };
  payload: SessionReplacementRequestedPayload;
  [k: string]: any;
}
export interface SessionReplacementRequestedPayload {
  reason: ReplacementReason;
  gateState: "closed";
  proposedSessionRef: string | null;
}
export interface SessionReplacementPendingEvent {
  kind: "session.replacement-pending";
  correlation: {
    replacementId: string;
    [k: string]: any;
  };
  payload: SessionReplacementPendingPayload;
  [k: string]: any;
}
export interface SessionReplacementPendingPayload {
  reason: ReplacementReason;
  gateState: "closed";
  waitingFor: "host-result-callback";
}
export interface SessionReplacementCommittedEvent {
  kind: "session.replacement-committed";
  correlation: {
    replacementId: string;
    [k: string]: any;
  };
  payload: SessionReplacementCommittedPayload;
  [k: string]: any;
}
export interface SessionReplacementCancelledEvent {
  kind: "session.replacement-cancelled";
  correlation: {
    replacementId: string;
    [k: string]: any;
  };
  payload: SessionReplacementCancelledPayload;
  [k: string]: any;
}
export interface SessionReplacementFailedEvent {
  kind: "session.replacement-failed";
  correlation: {
    replacementId: string;
    [k: string]: any;
  };
  payload: SessionReplacementFailedPayload;
  [k: string]: any;
}
export interface SessionCompactionPreflightEvent {
  kind: "session.compaction-preflight";
  payload: SessionCompactionPreflightPayload;
  [k: string]: any;
}
export interface SessionCompactionPreflightPayload {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  cancellable: true;
}
export interface SessionCompactedEvent {
  kind: "session.compacted";
  payload: SessionCompactedPayload;
  [k: string]: any;
}
export interface SessionCompactedPayload {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  fromExtension: boolean;
  summaryDigest: NullableDigest;
  tokensBefore: NullableCount;
}
export interface SessionShutdownEvent {
  kind: "session.shutdown";
  payload: SessionShutdownPayload;
  [k: string]: any;
}
export interface SessionShutdownPayload {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  replacementId: string | null;
}
export interface AgentOperationStartedEvent {
  kind: "agent-operation.started";
  agentOperationId: string;
  payload: AgentOperationStartedPayload;
  [k: string]: any;
}
export interface AgentOperationStartedPayload {
  dispatchSource: "interactive" | "rpc" | "extension" | "recovery" | "system" | "unknown";
  delivery: "new-operation" | "steer" | "follow-up" | "automatic" | "unknown";
  inputDigest: NullableDigest;
}
export interface AgentOperationLoopEndedEvent {
  kind: "agent-operation.loop-ended";
  agentOperationId: string;
  payload: AgentOperationLoopEndedPayload;
  [k: string]: any;
}
export interface AgentOperationLoopEndedPayload {
  willRetry: BooleanFact;
  messageCount: number;
  lastStopReason: NullableStopReason;
}
export interface AgentOperationSettledEvent {
  kind: "agent-operation.settled";
  agentOperationId: string;
  payload: AgentOperationSettledPayload;
  [k: string]: any;
}
export interface AgentOperationSettledPayload {
  settlement: "completed" | "aborted" | "error" | "unknown";
  lastStopReason: NullableStopReason;
  hasPendingMessages: BooleanFact;
}
export interface AgentOperationStopRequestedEvent {
  kind: "agent-operation.stop-requested";
  agentOperationId: string;
  correlation: {
    commandId: string;
    [k: string]: any;
  };
  payload: AgentOperationStopRequestedPayload;
  [k: string]: any;
}
export interface AgentOperationStopRequestedPayload {
  phase: OperationState;
  emergency: boolean;
  auditAvailable: boolean;
  reasonCode: string;
}
export interface AgentOperationStopSettledEvent {
  kind: "agent-operation.stop-settled";
  agentOperationId: string;
  correlation: {
    commandId: string;
    [k: string]: any;
  };
  payload: AgentOperationStopSettledPayload;
  [k: string]: any;
}
export interface TurnStartedEvent {
  kind: "turn.started";
  agentOperationId: string;
  turnIndex: number;
  payload: TurnStartedPayload;
  [k: string]: any;
}
export interface TurnStartedPayload {
  phase: "started";
}
export interface TurnEndedEvent {
  kind: "turn.ended";
  agentOperationId: string;
  turnIndex: number;
  payload: TurnEndedPayload;
  [k: string]: any;
}
export interface TurnEndedPayload {
  phase: "ended";
  finalMessageRef: string | null;
  toolResultCount: number;
  stopReason: NullableStopReason;
}
export interface MessageStartedEvent {
  kind: "message.started";
  messageRef: string;
  payload: MessageStartedPayload;
  [k: string]: any;
}
export interface MessageStartedPayload {
  role: MessageRole;
  contentDigest: NullableDigest;
  textChars: NullableCount;
  imageCount: number;
}
export interface MessageTextDeltaEvent {
  kind: "message.text-delta";
  messageRef: string;
  payload: MessageTextDeltaPayload;
  [k: string]: any;
}
export interface MessageTextDeltaPayload {
  role: "assistant";
  contentIndex: number;
  chunkSequence: number;
  delta: SafeChunk;
  deltaDigest: string;
}
export interface MessageThinkingStateEvent {
  kind: "message.thinking-state";
  messageRef: string;
  payload: MessageThinkingStatePayload;
  [k: string]: any;
}
export interface MessageThinkingStatePayload {
  contentIndex: number;
  state: "started" | "streaming" | "completed";
  redacted: boolean;
}
export interface MessageCompletedEvent {
  kind: "message.completed";
  messageRef: string;
  payload: MessageCompletedPayload;
  [k: string]: any;
}
export interface MessageCompletedPayload {
  role: MessageRole;
  contentDigest: NullableDigest;
  contentRef: string | null;
  textPreview: NullableLongDisplayText;
  textChars: NullableCount;
  blockCount: number;
  stopReason: NullableStopReason;
  usage: NullableTokenUsage;
}
export interface TokenUsage {
  input: NullableCount;
  output: NullableCount;
  cacheRead: NullableCount;
  cacheWrite: NullableCount;
  reasoning: NullableCount;
  total: NullableCount;
}
export interface MessageFailedEvent {
  kind: "message.failed";
  messageRef: string;
  payload: MessageFailedPayload;
  [k: string]: any;
}
export interface MessageFailedPayload {
  role: "assistant";
  reason: "aborted" | "error";
  errorCode: string;
  message: string | null;
  contentDigest: NullableDigest;
}
export interface ChatControlEventBase {
  correlation: {
    commandId: string;
    messageRequestId: string;
    idempotencyKeyDigest: string;
    [k: string]: any;
  };
  payload: ChatPayload;
  [k: string]: any;
}
export interface ChatPayload {
  state: "held" | "dispatch-requested" | "dispatch-observed" | "dispatch-rejected" | "dispatch-unknown";
  delivery: "new-operation" | "steer" | "follow-up" | "hold";
  contentDigest: string;
  textChars: number;
  /**
   * @maxItems 16
   */
  attachmentRefs:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  resultCode: string;
}
export interface ModelChangedEvent {
  kind: "session-option.model-changed";
  payload: ModelChangedPayload;
  [k: string]: any;
}
export interface ModelChangedPayload {
  previousModel: NullableSafeModel;
  currentModel: SafeModel;
  source: "set" | "cycle" | "restore";
  effectScope: "session" | "session-and-user-default" | "unknown";
  observedBy: "model-select-event" | "readback" | "host-result";
}
export interface SafeModel {
  modelRef: string;
  provider: string;
  modelId: string;
  displayName: string;
  reasoning: boolean;
  /**
   * @minItems 1
   * @maxItems 2
   */
  inputCapabilities: ["text" | "image"] | ["text" | "image", "text" | "image"];
  /**
   * @minItems 1
   * @maxItems 7
   */
  supportedThinkingLevels:
    | [ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel];
  contextWindow: number;
  maxOutputTokens: number;
}
export interface ThinkingChangedEvent {
  kind: "session-option.thinking-changed";
  payload: ThinkingChangedPayload;
  [k: string]: any;
}
export interface ThinkingChangedPayload {
  previousLevel: NullableThinkingLevel;
  currentLevel: ThinkingLevel;
  source: "set" | "cycle" | "restore" | "model-clamp";
  effectScope: "session" | "session-and-user-default" | "unknown";
  observedBy: "thinking-select-event" | "readback" | "host-result";
}
export interface TaskStartedEvent {
  kind: "task.started";
  taskId: string;
  taskRunId: string;
  payload: TaskStartedPayload;
  [k: string]: any;
}
export interface TaskStartedPayload {
  taskContractDigest: string;
  criterionCount: number;
  taskOutcome: "pending";
  controlState: "active";
}
export interface TaskStateChangedEvent {
  kind: "task.state-changed";
  taskId: string;
  taskRunId: string;
  payload: TaskStateChangedPayload;
  [k: string]: any;
}
export interface TaskStateChangedPayload {
  taskContractDigest: string;
  criterionCounts: {
    pending: number;
    inProgress: number;
    passed: number;
    failed: number;
    blocked: number;
  };
  /**
   * @maxItems 128
   */
  activeCriterionIds: string[];
  reasonCode: string;
}
export interface TaskOutcomeChangedEvent {
  kind: "task.outcome-changed";
  taskId: string;
  taskRunId: string;
  payload: TaskOutcomeChangedPayload;
  [k: string]: any;
}
export interface TaskControlEventBase {
  taskId: string;
  taskRunId: string;
  correlation: {
    commandId: string;
    idempotencyKeyDigest: string;
    [k: string]: any;
  };
  payload: TaskControlPayload;
  [k: string]: any;
}
export interface QueueChangedEvent {
  kind: "queue.changed";
  payload: QueueChangedPayload;
  [k: string]: any;
}
export interface ActivityRequestedEvent {
  kind: "activity.requested";
  payload: ActivityPayload & {
    state: "requested";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ActivityStartedEvent {
  kind: "activity.started";
  payload: ActivityPayload & {
    state: "started";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ActivityProgressEvent {
  kind: "activity.progress";
  payload: ActivityPayload & {
    state: "progress";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ActivityFinishedEvent {
  kind: "activity.finished";
  payload: ActivityPayload & {
    state: "finished";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ActivityFailedEvent {
  kind: "activity.failed";
  payload: ActivityPayload & {
    state: "failed";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ActivityBlockedEvent {
  kind: "activity.blocked";
  payload: ActivityPayload & {
    state: "blocked";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ActivityAbortedEvent {
  kind: "activity.aborted";
  payload: ActivityPayload & {
    state: "aborted";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ApprovalRequestedEvent {
  kind: "approval.requested";
  correlation: {
    approvalRequestId: string;
    [k: string]: any;
  };
  payload: ApprovalPayload & {
    state: "requested";
    decision: null;
    resolutionCode: null;
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ApprovalPayload {
  state: "requested" | "resolved" | "expired";
  actionDigest: string;
  actionSummary: string;
  decision: ("allow" | "deny" | "cancel") | null;
  expiresAt: NullableTimestamp;
  resolutionCode: string | null;
}
export interface ApprovalResolvedEvent {
  kind: "approval.resolved";
  correlation: {
    approvalRequestId: string;
    [k: string]: any;
  };
  payload: ApprovalPayload & {
    state: "resolved";
    decision: "allow" | "deny" | "cancel";
    resolutionCode: string;
    [k: string]: any;
  };
  [k: string]: any;
}
export interface ApprovalExpiredEvent {
  kind: "approval.expired";
  correlation: {
    approvalRequestId: string;
    [k: string]: any;
  };
  payload: ApprovalPayload & {
    state: "expired";
    decision: "deny" | "cancel";
    resolutionCode: string;
    [k: string]: any;
  };
  [k: string]: any;
}
export interface SourceChangedEvent {
  kind: "source.changed";
  payload: SourceChangedPayload;
  [k: string]: any;
}
export interface SourceChangedPayload {
  repoRef: string;
  projection: "task" | "working-tree" | "staged";
  changeSetDigest: string;
  /**
   * @maxItems 512
   */
  changedFileRefs: string[];
  additions: NullableCount;
  deletions: NullableCount;
  truncated: boolean;
}
export interface VerifierStartedEvent {
  kind: "verifier.started";
  payload: VerifierPayload & {
    state: "started";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface VerifierFinishedEvent {
  kind: "verifier.finished";
  payload: VerifierPayload & {
    state: "passed" | "failed" | "blocked" | "aborted" | "unavailable";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface VerifierStaleEvent {
  kind: "verifier.stale";
  payload: VerifierPayload & {
    state: "stale";
    [k: string]: any;
  };
  [k: string]: any;
}
export interface UsageUpdatedEvent {
  kind: "usage.updated";
  payload: UsageUpdatedPayload;
  [k: string]: any;
}
export interface UsageUpdatedPayload {
  scope: "context-estimate" | "provider-response" | "session-ledger" | "task-ledger" | "tool";
  aggregation: "delta" | "cumulative";
  modelRef: string | null;
  tokens: TokenUsage;
  contextTokens: NullableCount;
  contextWindow: NullableCount;
  contextPercentBasisPoints: number | null;
  costUsdMicros: NullableCount;
  reasonCode: string | null;
}
export interface HandoffUpdatedEvent {
  kind: "handoff.updated";
  payload: HandoffUpdatedPayload;
  [k: string]: any;
}
export interface HandoffUpdatedPayload {
  handoffRef: string;
  handoffDigest: string;
  state: "current" | "stale" | "unavailable" | "unknown";
  blockerCount: number;
  /**
   * @maxItems 128
   */
  blockerRefs: string[];
  reasonCode: string | null;
}
export interface DomainRevision {
  runtimeRevision: string;
  taskRevision: string | null;
  controlRevision: string | null;
  workspaceRevision: string | null;
  indexRevision: string | null;
  approvalRevision: string | null;
  sessionOptionRevision: string | null;
  queueRevision: string | null;
}
export interface Correlation {
  commandId: string | null;
  messageRequestId: string | null;
  replacementId: string | null;
  approvalRequestId: string | null;
  causationEventId: string | null;
  idempotencyKeyDigest: NullableDigest;
}

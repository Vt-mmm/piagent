/* Generated from schemas/piagent-webui/task-timeline-v1.schema.json. Do not edit. */

export type PiagentWebUIDurableTaskRecoveryTimelineV1 = {
  identity?: {
    taskId?: string;
    taskRunId?: string;
    agentOperationId?: null;
    toolCallId?: null;
    [k: string]: any;
  };
  [k: string]: any;
} & {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-task-timeline-v1";
  generatedAt: string;
  identity: Identity;
  runRef: string;
  state: "ready" | "unavailable";
  timelineRevision: string | null;
  continuity: Continuity;
  /**
   * @maxItems 300
   */
  events: Event[];
  page: Page;
  /**
   * @maxItems 8
   */
  warnings:
    | []
    | [Warning]
    | [Warning, Warning]
    | [Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning, Warning, Warning];
  health: Health;
};
export type Identity = {
  [k: string]: any;
} & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: string | null;
};
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};

export interface Continuity {
  crashEvidence: "possible-interruption" | "unknown";
  recoveryDecision: "resume" | "retry" | "paused" | "terminal" | "blocked" | "unknown";
  latestCheckpointRef: string | null;
  reasonCode: string | null;
}
export interface Event {
  eventRef: string;
  evidenceRef: string;
  sequence: number;
  recordedAt: string;
  kind:
    | "task-written"
    | "session-bound"
    | "checkpoint"
    | "pause-requested"
    | "paused"
    | "pause-cancelled"
    | "resume-requested"
    | "resumed"
    | "resume-rejected"
    | "stop-requested"
    | "stop-settled"
    | "continuation"
    | "digest-migrated";
  state: "observed" | "requested" | "settled" | "failed" | "unknown";
  title: string;
  detail: string | null;
  checkpointRef: string | null;
}
export interface Page {
  total: number;
  returned: number;
  truncated: boolean;
}
export interface Warning {
  code:
    "journal-corrupt" | "recoverable-tail" | "timeline-truncated" | "journal-input-truncated" | "crash-not-observed";
  count: number;
  message: string;
}

/* Generated from schemas/piagent-webui/handoff-history-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedHandoffHistoryAndNextActionV1 = {
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
  version: "piagent-webui-handoff-history-v1";
  generatedAt: string;
  identity: Identity;
  runRef: string;
  state: "ready" | "unavailable";
  historyRevision: string | null;
  completeness: "complete" | "partial" | "snapshot-only" | "missing" | "unknown";
  current: Current | null;
  nextAction: NextAction;
  /**
   * @maxItems 100
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

export interface Current {
  handoffRef: string;
  generatedAt: string;
  phase: string | null;
  taskOutcome: "pending" | "completed" | "blocked" | "partial" | "failed";
  gateDecision: "pass" | "fail";
  completionApproved: boolean;
  requiredAuthority: "none" | "operator" | "permission" | "scope" | "fresh-session";
  treeEvidenceCurrent: boolean;
  latestVerifierMatchesCurrentTree: boolean;
  changedFileCount: number;
  missingCount: number;
  projectedAction: string;
}
export interface NextAction {
  action:
    | "terminal"
    | "inspect-handoff"
    | "wait-paused"
    | "retry-checkpoint"
    | "rerun-exact-verifier"
    | "continue-plan"
    | "request-completion"
    | "unknown";
  stepRef: string | null;
  reason: string;
  exactCommandCount: number;
  dispatchable: false;
  enforcementSafe: boolean;
}
export interface Event {
  eventRef: string;
  evidenceRef: string;
  sequence: number;
  recordedAt: string;
  phase: string | null;
  completionApproved: boolean;
  projectedAction: string;
}
export interface Page {
  total: number;
  returned: number;
  truncated: boolean;
}
export interface Warning {
  code:
    | "telemetry-missing"
    | "telemetry-corrupt"
    | "telemetry-incomplete-tail"
    | "telemetry-input-truncated"
    | "history-truncated"
    | "current-handoff-missing"
    | "history-snapshot-only";
  count: number;
  message: string;
}

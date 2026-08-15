/* Generated from schemas/piagent-webui/recovery-history-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedCompactionAndRecoveryHistoryV1 = {
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
  version: "piagent-webui-recovery-history-v1";
  generatedAt: string;
  identity: Identity;
  runRef: string;
  state: "ready" | "unavailable";
  historyRevision: string | null;
  completeness: "complete" | "partial" | "missing" | "unknown";
  summary: Summary;
  recovery: Recovery;
  retainedContent: RetainedContent;
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
export type Event = {
  [k: string]: any;
} & {
  eventRef: string;
  evidenceRef: string;
  sequence: number;
  recordedAt: string;
  kind: "context-compaction" | "tool-result-compaction";
  title: string;
  detail: string | null;
  toolName: string | null;
  originalChars: NullableCount;
  originalLines: NullableCount;
  captureCount: NullableCount;
  willRetry: boolean | null;
  fromExtension: boolean | null;
};
export type NullableCount = number | null;
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};

export interface Summary {
  contextCompactions: number;
  toolResultCompactions: number;
  compactedToolResults: number;
}
export interface Recovery {
  decision: "resume" | "retry" | "paused" | "terminal" | "blocked" | "unknown";
  enforcementSafe: boolean | null;
  latestCheckpointRef: string | null;
  verifierState: "current" | "stale" | "not-current" | "unknown";
  invalidatedFileCount: number | null;
  invalidatedFilesKnown: boolean;
  handoffState: "none" | "available" | "invalid" | "unknown";
  reasonCode: string;
}
export interface RetainedContent {
  access: "omitted";
  exposed: false;
  reasonCode: "protected-runtime-evidence";
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
    | "history-truncated";
  count: number;
  message: string;
}

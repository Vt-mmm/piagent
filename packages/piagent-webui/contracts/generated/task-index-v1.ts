/* Generated from schemas/piagent-webui/task-index-v1.schema.json. Do not edit. */

export type PiagentWebUIAuthoritativeLocalTaskRunIndexV1 = {
  identity?: {
    agentOperationId?: null;
    toolCallId?: null;
    [k: string]: any;
  };
  [k: string]: any;
} & {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-task-index-v1";
  generatedAt: string;
  identity: Identity;
  state: "ready" | "unavailable";
  indexRevision: string | null;
  activeRunRef: string | null;
  /**
   * @maxItems 200
   */
  runs: Run[];
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
export type Run = {
  [k: string]: any;
} & {
  runRef: string;
  taskRef: string;
  taskId: string;
  taskRunId: string;
  summary: string;
  sessionLabel: string | null;
  outcome: "pending" | "completed" | "blocked" | "partial" | "failed" | "unknown";
  terminal: boolean;
  attempt: number;
  maxAttempts: number;
  changeMode: "read-only" | "source-change";
  riskLane: "tiny" | "normal" | "high-risk";
  createdAt: string;
  updatedAt: string;
  isCurrentSession: boolean;
  isActive: boolean;
  progress: {
    completed: number;
    total: number;
  };
};
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};

export interface Page {
  total: number;
  returned: number;
  truncated: boolean;
}
export interface Warning {
  code: "corrupt-task-state" | "legacy-task-state" | "task-index-truncated";
  count: number;
  message: string;
}

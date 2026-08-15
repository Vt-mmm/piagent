/* Generated from schemas/piagent-webui/commit-summary-v1.schema.json. Do not edit. */

export type PiagentWebUIDeterministicStagedCommitSummaryV1 = {
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
  version: "piagent-webui-commit-summary-v1";
  generatedAt: string;
  identity: Identity;
  state: "ready" | "unavailable";
  summary: Summary | null;
  reasonCode: string | null;
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

export interface Summary {
  summaryRef: string;
  taskRevision: string;
  indexRevision: string;
  title: string;
  /**
   * @maxItems 32
   */
  bodyLines: string[];
  modelPrompt: string;
  fileCount: number;
  returnedFiles: number;
  statusCounts: {
    A: number;
    M: number;
    D: number;
    R: number;
    C: number;
  };
  additions: number | null;
  deletions: number | null;
  protectedFileCount: number;
  redacted: boolean;
  truncated: boolean;
}

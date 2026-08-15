/* Generated from schemas/piagent-webui/review-state-v1.schema.json. Do not edit. */

export type PiagentWebUIDigestBoundSelectedFileReviewStateV1 = {
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
  version: "piagent-webui-review-state-v1";
  generatedAt: string;
  identity: Identity;
  state: "reviewed" | "unreviewed" | "stale" | "unavailable";
  target: ReviewTarget | null;
  recordedState: ("reviewed" | "unreviewed") | null;
  recordedAt: string | null;
  evidenceRef: string | null;
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

export interface ReviewTarget {
  view: "task" | "working-tree" | "staged";
  fileRef: string;
  diffRef: string;
  taskRevision: string;
  workspaceRevision: string;
  indexRevision: string | null;
  viewRevision: string;
  fileRevision: string;
  baseDigest: string | null;
  currentDigest: string | null;
  patchPreimage: string;
  contentDigest: string;
}

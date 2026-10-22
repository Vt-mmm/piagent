/* Generated from schemas/piagent-webui/checkpoint-v1.schema.json. Do not edit. */

export type PiagentWebUICheckpointV1 = CheckpointState | CheckpointPreview | CheckpointCommand | CheckpointReceipt;
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

export interface CheckpointState {
  schemaVersion: 1;
  version: "piagent-webui-checkpoint-v1";
  messageType: "state";
  identity: Identity;
  revisions: CheckpointRevisions;
  available: boolean;
  agentRunning: boolean;
  /**
   * @maxItems 64
   */
  points: CheckpointPoint[];
}
export interface CheckpointRevisions {
  checkpointRevision: string;
}
export interface CheckpointPoint {
  id: string;
  turnRef: string;
  at: number;
}
export interface CheckpointPreview {
  schemaVersion: 1;
  version: "piagent-webui-checkpoint-v1";
  messageType: "preview";
  identity: Identity;
  revisions: CheckpointRevisions;
  targetId: string;
  result: "ready" | "conflict" | "busy" | "none" | "unavailable";
  previewDigest: string | null;
  tree: string | null;
  /**
   * @maxItems 64
   */
  steps: CheckpointStep[];
  /**
   * @maxItems 10000
   */
  files: string[];
  /**
   * @maxItems 10000
   */
  conflicts: string[];
  stoppedAt: string | null;
}
export interface CheckpointStep {
  id: string;
  turnRef: string;
  /**
   * @maxItems 10000
   */
  restore: string[];
  /**
   * @maxItems 10000
   */
  remove: string[];
}
export interface CheckpointCommand {
  schemaVersion: 1;
  version: "piagent-webui-checkpoint-v1";
  messageType: "command";
  commandId: string;
  idempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  action: "checkpoint.restore";
  actionDigest: string;
  identity: Identity;
  expectedRevisions: CheckpointRevisions;
  payload: CheckpointPayload;
}
export interface CheckpointPayload {
  targetId: string;
  previewDigest: string;
  expectedTree: string;
  confirmed: true;
}
export interface CheckpointReceipt {
  schemaVersion: 1;
  version: "piagent-webui-checkpoint-v1";
  messageType: "receipt";
  commandId: string;
  idempotencyKeyDigest: string;
  action: "checkpoint.restore";
  actionDigest: string;
  identity: Identity;
  phase: "settled" | "rejected" | "uncertain";
  resultCode:
    | "restored"
    | "conflict"
    | "stale-revision"
    | "identity-mismatch"
    | "read-only"
    | "busy"
    | "unavailable"
    | "expired"
    | "idempotency-payload-mismatch"
    | "effect-unknown";
  requestedAt: string;
  settledAt: string;
  observedRevisionsBefore: CheckpointRevisions;
  observedRevisionsAfter: CheckpointRevisions;
  deduplicated: boolean;
  targetId: string;
  /**
   * @maxItems 64
   */
  completed: string[];
  /**
   * @maxItems 10000
   */
  files: string[];
  /**
   * @maxItems 10000
   */
  conflicts: string[];
  stoppedAt: string | null;
}

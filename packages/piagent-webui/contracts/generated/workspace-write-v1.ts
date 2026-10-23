/* Generated from schemas/piagent-webui/workspace-write-v1.schema.json. Do not edit. */

export type PiagentWebUIWorkspaceWriteV1 = WorkspaceWriteState | WorkspaceWriteCommand | WorkspaceWriteReceipt;
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

export interface WorkspaceWriteState {
  schemaVersion: 1;
  version: "piagent-webui-workspace-write-v1";
  messageType: "state";
  identity: Identity;
  revisions: WorkspaceWriteRevisions;
  writable: boolean;
  agentRunning: boolean;
}
export interface WorkspaceWriteRevisions {
  workspaceRevision: string;
}
export interface WorkspaceWriteCommand {
  schemaVersion: 1;
  version: "piagent-webui-workspace-write-v1";
  messageType: "command";
  commandId: string;
  idempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  action: "workspace.write";
  actionDigest: string;
  identity: Identity;
  expectedRevisions: WorkspaceWriteRevisions;
  payload: WorkspaceWritePayload;
}
export interface WorkspaceWritePayload {
  path: string;
  content: string;
  expectedDigest: string;
  /**
   * Absent means write. Rename and delete send empty content and the digest of the file the member saw.
   */
  operation?: "write" | "rename" | "delete";
  /**
   * The new path of a rename.
   */
  destination?: string;
}
export interface WorkspaceWriteReceipt {
  schemaVersion: 1;
  version: "piagent-webui-workspace-write-v1";
  messageType: "receipt";
  commandId: string;
  idempotencyKeyDigest: string;
  action: "workspace.write";
  actionDigest: string;
  identity: Identity;
  phase: "settled" | "rejected" | "uncertain";
  resultCode:
    | "saved"
    | "stale-content"
    | "stale-revision"
    | "identity-mismatch"
    | "read-only"
    | "path-protected"
    | "unsafe-path"
    | "invalid-write"
    | "expired"
    | "idempotency-payload-mismatch"
    | "effect-unknown"
    | "write-failed";
  requestedAt: string;
  settledAt: string;
  observedRevisionsBefore: WorkspaceWriteRevisions;
  observedRevisionsAfter: WorkspaceWriteRevisions;
  path: string;
  digest: string | null;
  currentDigest: string | null;
  deduplicated: boolean;
}

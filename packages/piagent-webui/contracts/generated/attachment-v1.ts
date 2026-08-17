/* Generated from schemas/piagent-webui/attachment-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedAttachmentStagingV1 = StageCommand | StageReceipt | DiscardCommand | DiscardReceipt;
export type Identity = {
  [k: string]: any;
} & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: null;
};
export type StageReceipt = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-attachment-v1";
  messageType: "stage-receipt";
  commandId: string;
  identity: Identity;
  phase: "settled" | "rejected";
  resultCode:
    | "staged"
    | "invalid-command"
    | "identity-mismatch"
    | "stale-revision"
    | "expired"
    | "unsupported-type"
    | "invalid-content"
    | "limit-exceeded"
    | "storage-unavailable"
    | "idempotency-payload-mismatch"
    | "capability-unavailable";
  requestedAt: string;
  settledAt: string;
  deduplicated: boolean;
  attachment: Attachment | null;
  error: StageError | null;
};
export type DiscardReceipt = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-attachment-v1";
  messageType: "discard-receipt";
  commandId: string;
  identity: Identity;
  phase: "settled" | "rejected";
  resultCode:
    | "discarded"
    | "invalid-command"
    | "identity-mismatch"
    | "stale-revision"
    | "expired"
    | "attachment-unavailable"
    | "idempotency-payload-mismatch"
    | "capability-unavailable";
  requestedAt: string;
  settledAt: string;
  deduplicated: boolean;
  attachmentRef: string | null;
  error: StageError | null;
};

export interface StageCommand {
  schemaVersion: 1;
  version: "piagent-webui-attachment-v1";
  messageType: "stage-command";
  commandId: string;
  idempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  identity: Identity;
  expectedRuntimeRevision: string;
  messageRequestId: string;
  file: StageFile;
}
export interface StageFile {
  displayName: string;
  declaredMimeType:
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp"
    | "image/bmp"
    | "text/plain"
    | "text/markdown"
    | "text/csv"
    | "text/tab-separated-values"
    | "application/json"
    | "application/yaml"
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  dataBase64: string;
}
export interface Attachment {
  attachmentRef: string;
  messageRequestId: string;
  displayName: string;
  kind: "file" | "image" | "document";
  mimeType: string;
  /**
   * Bytes held for dispatch: image bytes, or the UTF-8 text extracted from a text or document file.
   */
  sizeBytes: number;
  /**
   * Bytes of the file the operator selected, before extraction. Equal to sizeBytes for images.
   */
  sourceBytes: number;
  /**
   * True when extraction produced more text than the per-attachment cap, so Pi receives a prefix.
   */
  truncated: boolean;
  expiresAt: string;
}
export interface StageError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface DiscardCommand {
  schemaVersion: 1;
  version: "piagent-webui-attachment-v1";
  messageType: "discard-command";
  commandId: string;
  idempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  identity: Identity;
  expectedRuntimeRevision: string;
  messageRequestId: string;
  attachmentRef: string;
}

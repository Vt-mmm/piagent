/* Generated from schemas/piagent-webui/queue-v1.schema.json. Do not edit. */

export type PiagentWebUIHeldMessageQueueProjectionV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-queue-v1";
  generatedAt: string;
  identity: Identity;
  revision: DomainRevision;
  state: "ready" | "unavailable";
  heldCount: Count;
  quarantinedCount: Count;
  /**
   * @maxItems 100
   */
  items: Item[];
  reasonCode: string | null;
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
  toolCallId: null;
};
export type Count = number;
export type Item = {
  [k: string]: any;
} & {
  queueItemRef: string;
  messageRequestId: string;
  position: number;
  state: "held" | "quarantined";
  preview: PreviewText;
  redacted: boolean;
  truncated: boolean;
  attachmentCount: number;
  previewDigest: string;
  createdAt: string;
  updatedAt: string;
  reasonCode: string | null;
};
export type PreviewText = string;

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

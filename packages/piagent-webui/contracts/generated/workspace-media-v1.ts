/* Generated from schemas/piagent-webui/workspace-media-v1.schema.json. Do not edit. */

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

export interface PiagentWebUIWorkspaceMediaV1 {
  schemaVersion: 1;
  version: "piagent-webui-workspace-media-v1";
  generatedAt: string;
  identity: Identity;
  path: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/x-icon" | "image/avif" | null;
  data: string | null;
  reasonCode: "protected" | "unsupported" | "oversized" | null;
}

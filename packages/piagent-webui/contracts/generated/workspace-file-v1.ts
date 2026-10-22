/* Generated from schemas/piagent-webui/workspace-file-v1.schema.json. Do not edit. */

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

export interface PiagentWebUIWorkspaceFileV1 {
  schemaVersion: 1;
  version: "piagent-webui-workspace-file-v1";
  generatedAt: string;
  identity: Identity;
  path: string;
  language: string;
  protected: boolean;
  readOnly: boolean;
  binary: boolean;
  oversized: boolean;
  content: string | null;
  digest: string | null;
  revision: string | null;
}

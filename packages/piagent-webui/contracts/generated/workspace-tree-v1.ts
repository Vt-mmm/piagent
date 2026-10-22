/* Generated from schemas/piagent-webui/workspace-tree-v1.schema.json. Do not edit. */

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

export interface PiagentWebUIWorkspaceTreeV1 {
  schemaVersion: 1;
  version: "piagent-webui-workspace-tree-v1";
  generatedAt: string;
  identity: Identity;
  path: string;
  /**
   * @maxItems 1000
   */
  entries: {
    name: string;
    path: string;
    kind: "file" | "directory" | "symlink" | "other";
    protected: boolean;
    readOnly: boolean;
    ignored: boolean;
  }[];
  truncated: boolean;
  source: "git" | "directory";
}

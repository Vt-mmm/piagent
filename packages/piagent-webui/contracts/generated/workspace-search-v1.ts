/* Generated from schemas/piagent-webui/workspace-search-v1.schema.json. Do not edit. */

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

export interface PiagentWebUIWorkspaceSearchV1 {
  schemaVersion: 1;
  version: "piagent-webui-workspace-search-v1";
  generatedAt: string;
  identity: Identity;
  query: string;
  truncated: boolean;
  available: boolean;
  backend: "ripgrep" | "fts";
  /**
   * @maxItems 100
   */
  matches: {
    path: string;
    line: number;
    column: number;
    preview: string;
  }[];
}

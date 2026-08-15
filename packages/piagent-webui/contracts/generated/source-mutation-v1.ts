/* Generated from schemas/piagent-webui/source-mutation-v1.schema.json. Do not edit. */

export type PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1 = {
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
  version: "piagent-webui-source-mutation-v1";
  generatedAt: string;
  identity: Identity;
  action: "source.stage" | "source.unstage";
  state: "ready" | "unavailable";
  target: MutationTarget | null;
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

export interface MutationTarget {
  view: "working-tree" | "staged";
  repoRef: string;
  fileRef: string;
  diffRef: string;
  status: "A" | "M" | "D" | "R" | "U";
  path: string;
  oldPath: string | null;
  effect: "copy-worktree-to-index" | "restore-index-from-head";
  taskRevision: string;
  workspaceRevision: string;
  indexRevision: string;
  viewRevision: string;
  fileRevision: string;
  workspacePreimage: string;
  indexPreimage: string;
  patchPreimage: string;
  contentDigest: string;
  /**
   * @maxItems 128
   */
  hunkRefs: string[];
}

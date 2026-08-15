/* Generated from schemas/piagent-webui/source-revert-v1.schema.json. Do not edit. */

export type PiagentWebUIConfirmedExactSourceRevertPreviewV1 = {
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
  version: "piagent-webui-source-revert-v1";
  generatedAt: string;
  identity: Identity;
  action: "source.revert";
  state: "ready" | "unavailable";
  target: RevertTarget | null;
  preview: RevertPreview | null;
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

export interface RevertTarget {
  view: "working-tree";
  repoRef: string;
  fileRef: string;
  diffRef: string;
  status: "M";
  path: string;
  oldPath: null;
  effect: "restore-worktree-from-index";
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
   * @maxItems 1
   */
  hunkRefs: [] | [string];
  previewRef: string;
  confirmedPreviewDigest: string;
  expiresAt: string;
  summary: {
    files: 1;
    hunks: number;
    additionsDiscarded: number;
    deletionsRestored: number;
    effect: "discard-unstaged-keep-index";
    recovery: "not-guaranteed";
  };
}
export interface RevertPreview {
  basis: "index-to-working-tree";
  /**
   * @minItems 1
   * @maxItems 128
   */
  hunks: [
    {
      hunkRef: string;
      header: string;
      /**
       * @maxItems 5000
       */
      lines: {
        kind: "added" | "deleted" | "context" | "meta";
        marker: "+" | "-" | " " | "\\";
        text: string;
      }[];
    },
    ...{
      hunkRef: string;
      header: string;
      /**
       * @maxItems 5000
       */
      lines: {
        kind: "added" | "deleted" | "context" | "meta";
        marker: "+" | "-" | " " | "\\";
        text: string;
      }[];
    }[]
  ];
  truncated: false;
}

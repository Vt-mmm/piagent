// Shared source-action data without filesystem or runtime dependencies.

export type WebUiIdentity = {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: string | null;
};

export type ExactGitPatchAuthority = { header: Buffer; hunks: Array<{ hunkRef: string; bytes: Buffer }> };

export type SourceRevertTarget = {
  view: "working-tree"; repoRef: string; fileRef: string; diffRef: string; status: "M"; path: string; oldPath: null;
  effect: "restore-worktree-from-index"; taskRevision: string | null; workspaceRevision: string; indexRevision: string;
  viewRevision: string; fileRevision: string; workspacePreimage: string; indexPreimage: string; patchPreimage: string;
  contentDigest: string; hunkRefs: string[]; previewRef: string; confirmedPreviewDigest: string; expiresAt: string;
  summary: { files: 1; hunks: number; additionsDiscarded: number; deletionsRestored: number;
    effect: "discard-unstaged-keep-index"; recovery: "not-guaranteed" };
};
export type SourceRevertProjection = {
  schemaVersion: 1; version: "piagent-webui-source-revert-v1"; generatedAt: string; identity: WebUiIdentity;
  action: "source.revert"; state: "ready" | "unavailable"; target: SourceRevertTarget | null;
  preview: { basis: "index-to-working-tree"; hunks: RevertPreviewHunk[]; truncated: false } | null; reasonCode: string | null;
  health: { state: "ok" | "unavailable" | "error"; reasonCode: string | null; message: string | null };
};
export type RevertPreviewLine = { kind: "added" | "deleted" | "context" | "meta"; marker: "+" | "-" | " " | "\\"; text: string };
export type RevertPreviewHunk = { hunkRef: string; header: string; lines: RevertPreviewLine[] };
export type SourceRevertAuthority = {
  repoRoot: string; repoPath: string; indexObject: string; indexMode: "100644" | "100755";
  target: SourceRevertTarget; patchAuthority: ExactGitPatchAuthority;
};

export type SourceMutationAction = "source.stage" | "source.unstage";
export type SourceMutationTarget = {
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
  hunkRefs: string[];
};
export type SourceMutationProjection = {
  schemaVersion: 1;
  version: "piagent-webui-source-mutation-v1";
  generatedAt: string;
  identity: WebUiIdentity;
  action: SourceMutationAction;
  state: "ready" | "unavailable";
  target: SourceMutationTarget | null;
  reasonCode: string | null;
  health: { state: "ok" | "unavailable" | "error"; reasonCode: string | null; message: string | null };
};
export type SourceMutationAuthority = {
  repoRoot: string;
  repoPaths: string[];
  headOid: string | null;
  indexStatus: string;
  worktreeStatus: string;
  target: SourceMutationTarget;
  patchAuthority: ExactGitPatchAuthority | null;
};

export const SOURCE_MUTATION_EVIDENCE_VERSION = "piagent-webui-source-mutation-evidence-v1";

export type SourceMutationEvidenceRecord = {
  schemaVersion: 1;
  version: typeof SOURCE_MUTATION_EVIDENCE_VERSION;
  recordId: string;
  evidenceRef: string;
  sequence: number;
  phase: "requested" | "settled" | "rejected" | "uncertain";
  resultCode: "mutation-requested" | "staged" | "unstaged" | "reverted" | "mutation-rejected" | "effect-unknown";
  failureCode: string | null;
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string;
  taskRunId: string;
  commandId: string;
  idempotencyKeyDigest: string;
  actionDigest: string;
  action: SourceMutationAction | "source.revert";
  target: SourceMutationTarget | SourceRevertTarget;
  selectedHunkRefs: string[];
  requestedAt: string;
  recordedAt: string;
  retentionUntil: string;
  beforeIndexPreimage: string;
  afterIndexPreimage: string | null;
  beforeWorkspacePreimage: string;
  afterWorkspacePreimage: string | null;
  observedRevisionsBefore: Record<string, string | null>;
  observedRevisionsAfter: Record<string, string | null> | null;
  integrityDigest: string;
};

export type SourceMutationAppendOptions = Omit<SourceMutationEvidenceRecord, "schemaVersion" | "version" | "recordId" | "evidenceRef" | "sequence" | "retentionUntil" | "integrityDigest"> & { projectRoot: string };

export type SourceIndexTransactionResult = {
  state: "settled" | "rejected" | "uncertain";
  reasonCode: string | null;
  beforeIndexPreimage: string;
  afterIndexPreimage: string | null;
  beforeWorkspacePreimage: string;
  afterWorkspacePreimage: string | null;
  executor: "pi-guard";
  directExecution: false;
};

/* Generated from schemas/piagent-webui/source-change-v1.schema.json. Do not edit. */

export type PiagentWebUISourceChangeViewV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-source-change-v1";
  generatedAt: string;
  identity: Identity;
  view: View;
  viewRevision: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  bases: [ViewBasis, ...ViewBasis[]];
  availability: Availability;
  /**
   * @maxItems 2000
   */
  files: FileChange[];
  page: Page;
  truncationReason: string | null;
  redaction: Redaction;
  health: Health;
  /**
   * @maxItems 64
   */
  issues: Issue[];
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
export type View = "task" | "working-tree" | "staged";
export type ViewBasis = TaskBasis | WorkingTreeBasis | StagedBasis;
export type TaskBasis = {
  [k: string]: any;
} & {
  basisRef: string;
  repoRef: string;
  view: "task";
  state: "current" | "stale" | "unavailable";
  reasonCode: string | null;
  basisRevision: string;
  taskRunId: string;
  taskRevision: string;
  workspaceRevision: string;
  baselineManifestRef: string | null;
  baselineTreeDigest: string | null;
};
export type WorkingTreeBasis = {
  [k: string]: any;
} & {
  [k: string]: any;
} & {
  basisRef: string;
  repoRef: string;
  view: "working-tree";
  state: "current" | "stale" | "unavailable";
  reasonCode: string | null;
  basisRevision: string;
  headState: "head" | "unborn" | "unavailable";
  headRef: string | null;
  workspaceRevision: string;
  indexRevision: string;
};
export type StagedBasis = {
  [k: string]: any;
} & {
  [k: string]: any;
} & {
  basisRef: string;
  repoRef: string;
  view: "staged";
  state: "current" | "stale" | "unavailable";
  reasonCode: string | null;
  basisRevision: string;
  headState: "head" | "unborn" | "unavailable";
  headRef: string | null;
  indexRevision: string;
  workspaceRevision: string | null;
};
export type Availability = {
  [k: string]: any;
} & {
  state: "current" | "stale" | "unavailable";
  reasonCode: string | null;
  message: string | null;
};
export type FileChange = {
  [k: string]: any;
} & {
  repoRef: string;
  basisRef: string;
  fileRef: string;
  fileRevision: string;
  path: string;
  oldPath: string | null;
  pathDisplay: "exact-safe" | "escaped" | "redacted";
  status: "A" | "M" | "D" | "R" | "U" | "C";
  git: GitState;
  baseDigest: string | null;
  currentDigest: string | null;
  content: ContentState;
  stats: LineStats;
  provenance: Provenance;
  /**
   * @maxItems 128
   */
  criterionIds: string[];
  /**
   * @maxItems 128
   */
  verifierAttemptIds: string[];
  health: Health;
};
export type RawGitStatus = ("." | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!") | null;
export type ContentState = {
  [k: string]: any;
} & {
  kind: "text" | "binary" | "symlink" | "submodule" | "unknown";
  access: "available" | "protected" | "oversized" | "unavailable";
  reasonCode: string | null;
};
export type LineStats = {
  [k: string]: any;
} & {
  state: "exact" | "unavailable";
  additions: number | null;
  deletions: number | null;
  reasonCode: string | null;
};
export type Provenance = {
  [k: string]: any;
} & {
  classification: "pre-existing-user" | "runtime-observed-agent" | "post-baseline-unattributed" | "mixed";
  evidence: "exact" | "derived" | "unavailable";
  baselineEvidenceRef: string | null;
  /**
   * @maxItems 64
   */
  mutationEvidenceRefs: string[];
  reasonCode: string | null;
};
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};
export type Redaction = {
  [k: string]: any;
} & {
  applied: boolean;
  valuesRemoved: number;
  truncated: boolean;
};

export interface GitState {
  indexStatus: RawGitStatus;
  worktreeStatus: RawGitStatus;
  conflict: boolean;
}
export interface Page {
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  returned: number;
  truncated: boolean;
}
export interface Issue {
  issueRef: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  /**
   * @maxItems 32
   */
  relatedRefs: string[];
}

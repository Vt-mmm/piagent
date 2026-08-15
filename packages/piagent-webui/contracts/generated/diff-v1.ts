/* Generated from schemas/piagent-webui/diff-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedFileDiffV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-diff-v1";
  generatedAt: string;
  identity: Identity;
  view: "task" | "working-tree" | "staged";
  basis: TaskBasis | WorkingTreeBasis | StagedBasis;
  precondition: Precondition;
  observed: ObservedRevision;
  file: FileChange;
  availability: Availability;
  fallback: Fallback;
  /**
   * @maxItems 128
   */
  hunks: Hunk[];
  /**
   * @maxItems 129
   */
  unchangedRegions: UnchangedRegion[];
  truncation: Truncation;
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
export type Availability = {
  [k: string]: any;
} & {
  state: "current" | "stale" | "unavailable";
  reasonCode: string | null;
  message: string | null;
  retryable: boolean;
};
export type Fallback = {
  [k: string]: any;
} & {
  kind: "none" | "binary" | "symlink" | "submodule" | "protected" | "oversized" | "conflict" | "unavailable" | "stale";
  reasonCode: string | null;
  message: string | null;
};
export type DiffLine = ContextLine | AddedLine | DeletedLine | NoNewlineMarker;
export type DiffLineText = string;
export type UnchangedRegion = {
  [k: string]: any;
} & {
  regionRef: string;
  oldStart: number;
  newStart: number;
  lineCount: number;
  beforeHunkRef: string | null;
  afterHunkRef: string | null;
  contentState: "available" | "unavailable";
  expansionRef: string | null;
  reasonCode: string | null;
};
export type Truncation = {
  [k: string]: any;
} & {
  truncated: boolean;
  reasonCode: string | null;
  omittedHunks: number;
  omittedLines: number;
  nextCursor: string | null;
};
export type Redaction = {
  [k: string]: any;
} & {
  applied: boolean;
  valuesRemoved: number;
  truncated: boolean;
};

export interface Precondition {
  expectedViewRevision: string;
  expectedFileRevision: string;
  expectedBaseDigest: string | null;
  expectedCurrentDigest: string | null;
}
export interface ObservedRevision {
  viewRevision: string;
  fileRevision: string;
  baseDigest: string | null;
  currentDigest: string | null;
}
export interface GitState {
  indexStatus: ("." | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!") | null;
  worktreeStatus: ("." | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!") | null;
  conflict: boolean;
}
export interface Hunk {
  hunkRef: string;
  oldStart: number;
  oldLineCount: number;
  newStart: number;
  newLineCount: number;
  header: string;
  /**
   * @maxItems 512
   */
  lines: DiffLine[];
}
export interface ContextLine {
  lineRef: string;
  kind: "context";
  marker: " ";
  oldLineNumber: number;
  newLineNumber: number;
  text: DiffLineText;
  redacted: boolean;
}
export interface AddedLine {
  lineRef: string;
  kind: "added";
  marker: "+";
  oldLineNumber: null;
  newLineNumber: number;
  text: DiffLineText;
  redacted: boolean;
}
export interface DeletedLine {
  lineRef: string;
  kind: "deleted";
  marker: "-";
  oldLineNumber: number;
  newLineNumber: null;
  text: DiffLineText;
  redacted: boolean;
}
export interface NoNewlineMarker {
  lineRef: string;
  kind: "no-newline-marker";
  marker: "\\";
  oldLineNumber: null;
  newLineNumber: null;
  text: DiffLineText;
  redacted: false;
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

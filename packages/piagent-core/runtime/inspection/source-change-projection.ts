import { createHash } from "node:crypto";
import path from "node:path";
import {
  GitInspectionError,
  type GitStatusRecord,
  type GitStatusSnapshot,
  collectGitStatus,
  collectGitStatusForPaths,
  readGitBlobDigests
} from "./git-status-adapter.ts";
import { collectNumstats, type LineStat } from "./git-numstat-adapter.ts";
import { hashWorkspaceFile, inspectWorkspaceEntry, readWorkspaceFile, readWorkspaceLink } from "./workspace-file-reader.ts";
import { collectTaskSourceChangeView } from "./task-source-projection.ts";
import { sourceInspectionPlan } from "./source-inspection-plan.ts";
const DEFAULT_PAGE_LIMIT = 300;
const MAX_PAGE_LIMIT = 2_000;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export type WebUiIdentity = {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: string | null;
};
export type SourceProjectionOptions = {
  cwd: string;
  identity: WebUiIdentity;
  generatedAt?: string;
  pageLimit?: number;
  taskRevision?: string | null;
  isProtectedPath?: (repoRoot: string, repoPath: string) => boolean;
  timeoutMs?: number;
  maxGitBytes?: number;
};
export type SourceChangeDocument = Record<string, unknown> & {
  view: "task" | "working-tree" | "staged";
  viewRevision: string;
  files: Array<Record<string, unknown>>;
  page: { cursor: string | null; nextCursor: string | null; total: number; returned: number; truncated: boolean };
  availability: { state: "current" | "stale" | "unavailable"; reasonCode: string | null; message: string | null };
};
export type SourceChangeViews = {
  task: SourceChangeDocument | null;
  workingTree: SourceChangeDocument;
  staged: SourceChangeDocument;
};
export type SelectedSourceFileState = {
  snapshot: GitStatusSnapshot;
  record: GitStatusRecord;
  file: Record<string, unknown>;
};
function visibleRecords(snapshot: GitStatusSnapshot): GitStatusRecord[] {
  return snapshot.records.filter((record) => {
    const paths = [record.path.value, record.oldPath?.value].filter((value): value is string => Boolean(value));
    return !paths.some((value) => value === ".pi/piagent-state" || value.startsWith(".pi/piagent-state/"));
  });
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function token(prefix: string, value: string | Buffer): string {
  return `${prefix}.${hash(value)}`;
}
export function sourceRepoRef(snapshot: GitStatusSnapshot): string {
  return token("repo", snapshot.repoRoot);
}
export function sourceFileRef(snapshot: GitStatusSnapshot, record: GitStatusRecord): string {
  return token("file", `${snapshot.repoDigest}\0${record.path.digest}`);
}
function digest(value: Buffer): string {
  return `sha256:${hash(value)}`;
}
function cleanTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new Error("generatedAt must be a millisecond UTC timestamp");
  }
  return timestamp;
}
function indexRevision(snapshot: GitStatusSnapshot): string {
  const evidence = visibleRecords(snapshot)
    .filter((record) => record.kind === "unmerged" || ![".", "?", "!"].includes(record.indexStatus))
    .map((record) => [record.path.digest, record.oldPath?.digest ?? null, record.indexStatus, record.indexMode, record.indexObject]);
  return token("index", JSON.stringify([snapshot.headOid, evidence]));
}
function workspaceRevision(snapshot: GitStatusSnapshot, isProtectedPath?: SourceProjectionOptions["isProtectedPath"], digests?: Map<string, string | null>): string {
  const evidence = visibleRecords(snapshot)
    .filter((record) => record.kind !== "ignored")
    .map((record) => {
      const repoPath = record.path.value;
      const status = [record.kind, record.indexStatus, record.worktreeStatus, record.oldPath?.digest ?? null,
        record.headMode, record.indexMode, record.worktreeMode, record.headObject, record.indexObject];
      if (!repoPath) return [record.path.digest, ...status, "unsafe-path"];
      try {
        const stat = inspectWorkspaceEntry(snapshot.repoRoot, repoPath);
        if (isProtectedPath?.(snapshot.repoRoot, repoPath) === true
          || (record.oldPath?.value && isProtectedPath?.(snapshot.repoRoot, record.oldPath.value) === true)) {
          return [record.path.digest, ...status, "protected", stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
        }
        if (stat.isSymbolicLink()) return [record.path.digest, ...status, "symlink", readWorkspaceLink(snapshot.repoRoot, repoPath)];
        if (stat.isFile()) {
          const raw = hashWorkspaceFile(snapshot.repoRoot, repoPath);
          const value = `sha256:${raw}`;
          digests?.set(repoPath, value);
          return [record.path.digest, ...status, "file", raw];
        }
        return [record.path.digest, ...status, "other", stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
      } catch {
        return [record.path.digest, ...status, "absent"];
      }
    });
  return token("workspace", JSON.stringify([snapshot.repoDigest, snapshot.headOid, evidence]));
}
function isConflict(record: GitStatusRecord): boolean {
  return record.kind === "unmerged" || record.indexStatus === "U" || record.worktreeStatus === "U";
}
function displayStatus(record: GitStatusRecord, view: "working-tree" | "staged"): "A" | "M" | "D" | "R" | "U" | "C" | null {
  if (isConflict(record)) return "C";
  if (view === "staged") {
    if ([".", "?", "!"].includes(record.indexStatus)) return null;
    if (record.indexStatus === "R") return "R";
    if (record.indexStatus === "A" || record.indexStatus === "C") return "A";
    if (record.indexStatus === "D") return "D";
    return "M";
  }
  if (record.kind === "ignored") return null;
  if (record.kind === "untracked") return "U";
  if (record.kind === "renamed" || record.indexStatus === "R" || record.worktreeStatus === "R") return "R";
  if (record.worktreeStatus === "D" || record.indexStatus === "D") return "D";
  if (record.indexStatus === "A" || record.worktreeStatus === "A" || record.indexStatus === "C" || record.worktreeStatus === "C") return "A";
  return "M";
}
function inspectUntracked(repoRoot: string, repoPath: string): { stat: LineStat; kind: "text" | "binary" | "symlink" | "unknown"; digest: string | null } {
  try {
    const fileStat = inspectWorkspaceEntry(repoRoot, repoPath);
    if (fileStat.isSymbolicLink()) return { stat: { additions: null, deletions: null, binary: false }, kind: "symlink", digest: null };
    if (!fileStat.isFile() || fileStat.size > MAX_TEXT_BYTES) {
      return { stat: { additions: null, deletions: null, binary: false }, kind: "unknown", digest: null };
    }
    const content = readWorkspaceFile(repoRoot, repoPath, MAX_TEXT_BYTES);
    if (content.includes(0)) return { stat: { additions: null, deletions: null, binary: true }, kind: "binary", digest: digest(content) };
    const text = content.toString("utf8");
    const additions = text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
    return { stat: { additions, deletions: 0, binary: false }, kind: "text", digest: digest(content) };
  } catch {
    return { stat: { additions: null, deletions: null, binary: false }, kind: "unknown", digest: null };
  }
}
function currentFileDigest(repoRoot: string, repoPath: string): string | null {
  try {
    const stat = inspectWorkspaceEntry(repoRoot, repoPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return null;
    return digest(readWorkspaceFile(repoRoot, repoPath, MAX_TEXT_BYTES));
  } catch {
    return null;
  }
}

function modeKind(record: GitStatusRecord, view: "working-tree" | "staged", binary: boolean): "text" | "binary" | "symlink" | "submodule" | "unknown" {
  if (record.submodule?.startsWith("S") || record.headMode === "160000" || record.indexMode === "160000" || record.worktreeMode === "160000") return "submodule";
  const selected = view === "staged" ? record.indexMode : record.worktreeMode;
  const mode = selected === "000000" ? record.headMode : selected;
  if (mode === "120000") return "symlink";
  if (binary) return "binary";
  return mode === "000000" ? "unknown" : "text";
}

function unavailableStats(reasonCode: string) {
  return { state: "unavailable", additions: null, deletions: null, reasonCode };
}

function projectFile(
  snapshot: GitStatusSnapshot,
  record: GitStatusRecord,
  view: "working-tree" | "staged",
  basisRef: string,
  stats: Map<string, LineStat>,
  blobDigests: Map<string, string>,
  isProtectedPath?: SourceProjectionOptions["isProtectedPath"],
  workspaceDigests?: Map<string, string | null>
): Record<string, unknown> | null {
  const status = displayStatus(record, view);
  const repoPath = record.path.value;
  if (!status || !repoPath || !record.path.display || (status === "R" && !record.oldPath?.display)) return null;
  const conflict = isConflict(record);
  const protectedPath = isProtectedPath?.(snapshot.repoRoot, repoPath) === true
    || (record.oldPath?.value ? isProtectedPath?.(snapshot.repoRoot, record.oldPath.value) === true : false);
  let stat = stats.get(repoPath);
  let untracked: ReturnType<typeof inspectUntracked> | null = null;
  if (record.kind === "untracked" && !protectedPath) {
    untracked = inspectUntracked(snapshot.repoRoot, repoPath);
    stat = untracked.stat;
  }
  const kind = untracked?.kind ?? modeKind(record, view, stat?.binary === true);
  const statsProjection = conflict
    ? unavailableStats("git-conflict")
    : protectedPath
      ? unavailableStats("protected-path")
      : kind === "binary" || kind === "symlink" || kind === "submodule" || kind === "unknown" || !stat || stat.additions === null || stat.deletions === null
        ? unavailableStats(kind === "binary" ? "binary-content" : kind === "symlink" ? "symlink-content" : kind === "submodule" ? "submodule-content" : "line-stats-unavailable")
        : { state: "exact", additions: stat.additions, deletions: stat.deletions, reasonCode: null };
  const baseDigest = status === "A" || status === "U" || protectedPath || !record.headObject
    ? null
    : blobDigests.get(record.headObject) ?? null;
  const currentDigest = status === "D" || protectedPath
    ? null
    : untracked?.digest
      ?? (view === "working-tree"
        ? workspaceDigests?.has(repoPath) ? workspaceDigests.get(repoPath) ?? null : currentFileDigest(snapshot.repoRoot, repoPath)
        : record.indexObject ? blobDigests.get(record.indexObject) ?? null : null);
  const repoRef = sourceRepoRef(snapshot);
  const fileRef = sourceFileRef(snapshot, record);
  const fileRevision = token("file-rev", JSON.stringify([view, status, record.indexObject, currentDigest, stat]));
  return {
    repoRef,
    basisRef,
    fileRef,
    fileRevision,
    path: record.path.display,
    oldPath: status === "R" ? record.oldPath?.display ?? null : null,
    pathDisplay: record.path.displayMode,
    status,
    git: { indexStatus: record.indexStatus, worktreeStatus: record.worktreeStatus, conflict },
    baseDigest,
    currentDigest,
    content: protectedPath
      ? { kind: "unknown", access: "protected", reasonCode: "protected-path" }
      : kind === "unknown"
        ? { kind, access: "unavailable", reasonCode: "content-kind-unavailable" }
        : { kind, access: "available", reasonCode: null },
    stats: statsProjection,
    provenance: {
      classification: "post-baseline-unattributed",
      evidence: "unavailable",
      baselineEvidenceRef: null,
      mutationEvidenceRefs: [],
      reasonCode: "provenance-evidence-unavailable"
    },
    criterionIds: [],
    verifierAttemptIds: [],
    health: protectedPath
      ? { state: "degraded", reasonCode: "protected-path", message: "Content is protected by policy" }
      : { state: "ok", reasonCode: null, message: null }
  };
}

export async function collectSelectedSourceFileState(
  options: SourceProjectionOptions,
  view: "working-tree" | "staged",
  fileRef: string,
  basisRef: string,
  targetRepoPaths?: string[]
): Promise<SelectedSourceFileState | null> {
  const snapshot = targetRepoPaths?.length
    ? await collectGitStatusForPaths(options.cwd, targetRepoPaths, { timeoutMs: options.timeoutMs, maxBytes: options.maxGitBytes })
    : await collectGitStatus(options.cwd, { timeoutMs: options.timeoutMs, maxBytes: options.maxGitBytes });
  const record = visibleRecords(snapshot).find((candidate) => sourceFileRef(snapshot, candidate) === fileRef);
  if (!record || !displayStatus(record, view) || !record.path.value) return null;
  const repoPaths = [record.oldPath?.value, record.path.value].filter((value): value is string => Boolean(value));
  const protectedPath = repoPaths.some((repoPath) => options.isProtectedPath?.(snapshot.repoRoot, repoPath) === true);
  const stats = await collectNumstats(snapshot, view, protectedPath ? [] : repoPaths, options.timeoutMs, options.maxGitBytes);
  const objectIds = protectedPath ? [] : [record.headObject, record.indexObject].filter((value): value is string => Boolean(value));
  const blobDigests = await readGitBlobDigests(snapshot.repoRoot, objectIds, { timeoutMs: options.timeoutMs, maxBlobBytes: MAX_TEXT_BYTES });
  const file = projectFile(snapshot, record, view, basisRef, stats, blobDigests, options.isProtectedPath);
  return file ? { snapshot, record, file } : null;
}

function baseDocument(
  identity: WebUiIdentity,
  view: SourceChangeDocument["view"],
  viewRevision: string,
  generatedAt: string,
  basis: Record<string, unknown>,
  files: Array<Record<string, unknown>>,
  pageLimit: number,
  issues: Array<Record<string, unknown>> = []
): SourceChangeDocument {
  const ordered = [...files].sort((left, right) => String(left.path).localeCompare(String(right.path), "en"));
  const returned = ordered.slice(0, pageLimit);
  const truncated = returned.length < ordered.length;
  const restricted = ordered.filter((file) => (file.content as any)?.access === "protected").length;
  const degraded = issues.length > 0 || restricted > 0;
  return {
    schemaVersion: 1,
    version: "piagent-webui-source-change-v1",
    generatedAt,
    identity,
    view,
    viewRevision,
    bases: [basis],
    availability: { state: "current", reasonCode: null, message: null },
    files: returned,
    page: { cursor: null, nextCursor: truncated ? token("page", `${viewRevision}:${pageLimit}`) : null, total: ordered.length, returned: returned.length, truncated },
    truncationReason: truncated ? "page-limit" : null,
    redaction: { applied: restricted > 0, valuesRemoved: restricted, truncated: false },
    health: degraded
      ? { state: "degraded", reasonCode: issues.length ? "path-projection-unavailable" : "source-content-restricted", message: issues.length ? "Some Git paths could not be projected safely" : "Some source content is protected by policy" }
      : { state: "ok", reasonCode: null, message: null },
    issues
  };
}

function unavailableTaskDocument(options: SourceProjectionOptions, generatedAt: string, workspaceRev: string, repoRef: string): SourceChangeDocument | null {
  if (!options.identity.taskId || !options.identity.taskRunId) return null;
  const basisRef = token("basis", `${options.identity.taskRunId}:task:unavailable`);
  const viewRevision = token("task", `${options.identity.taskRunId}:baseline-unavailable:${workspaceRev}`);
  return {
    schemaVersion: 1,
    version: "piagent-webui-source-change-v1",
    generatedAt,
    identity: options.identity,
    view: "task",
    viewRevision,
    bases: [{
      basisRef,
      repoRef,
      view: "task",
      state: "unavailable",
      reasonCode: "task-baseline-content-unavailable",
      basisRevision: token("basis-rev", `${options.identity.taskRunId}:unavailable`),
      taskRunId: options.identity.taskRunId,
      taskRevision: options.taskRevision ?? "task-revision.unavailable",
      workspaceRevision: workspaceRev,
      baselineManifestRef: null,
      baselineTreeDigest: null
    }],
    availability: { state: "unavailable", reasonCode: "task-baseline-content-unavailable", message: "Exact task changes require Task Baseline Manifest evidence" },
    files: [],
    page: { cursor: null, nextCursor: null, total: 0, returned: 0, truncated: false },
    truncationReason: null,
    redaction: { applied: false, valuesRemoved: 0, truncated: false },
    health: { state: "unavailable", reasonCode: "task-baseline-content-unavailable", message: "Task baseline content evidence is not available" },
    issues: []
  };
}

export async function collectSourceChangeViewsStrict(options: SourceProjectionOptions): Promise<SourceChangeViews> {
  const generatedAt = cleanTimestamp(options.generatedAt);
  const pageLimit = Number.isInteger(options.pageLimit) ? Math.max(1, Math.min(MAX_PAGE_LIMIT, options.pageLimit as number)) : DEFAULT_PAGE_LIMIT;
  const gitOptions = { timeoutMs: options.timeoutMs, maxBytes: options.maxGitBytes };
  const before = await collectGitStatus(options.cwd, gitOptions);
  const beforeWorkspaceRev = workspaceRevision(before, options.isProtectedPath);
  const beforeIndexRev = indexRevision(before);
  const inspection = sourceInspectionPlan(before, options.isProtectedPath);
  const [workingStats, stagedStats, blobDigests] = await Promise.all([
    collectNumstats(before, "working-tree", inspection.workingTreePaths, options.timeoutMs, options.maxGitBytes),
    collectNumstats(before, "staged", inspection.stagedPaths, options.timeoutMs, options.maxGitBytes),
    readGitBlobDigests(before.repoRoot, inspection.objectIds, { timeoutMs: options.timeoutMs, maxBlobBytes: MAX_TEXT_BYTES })
  ]);
  const after = await collectGitStatus(before.repoRoot, gitOptions);
  const repoRef = sourceRepoRef(before);
  const workspaceDigests = new Map<string, string | null>();
  const workspaceRev = workspaceRevision(after, options.isProtectedPath, workspaceDigests);
  const indexRev = indexRevision(after);
  const stale = beforeWorkspaceRev !== workspaceRev || beforeIndexRev !== indexRev;
  const project = (view: "working-tree" | "staged", stats: Map<string, LineStat>) => {
    const basisRef = token("basis", `${repoRef}:${view}:${before.headOid ?? "unborn"}:${view === "staged" ? indexRev : workspaceRev}`);
    const viewRevision = view === "staged" ? indexRev : workspaceRev;
    const basis = {
      basisRef,
      repoRef,
      view,
      state: stale ? "stale" : "current",
      reasonCode: stale ? "git-race" : null,
      basisRevision: token("basis-rev", `${basisRef}:${viewRevision}`),
      headState: before.headState,
      headRef: before.headOid ? `git.${before.headOid}` : null,
      ...(view === "working-tree"
        ? { workspaceRevision: workspaceRev, indexRevision: indexRev }
        : { indexRevision: indexRev, workspaceRevision: workspaceRev })
    };
    if (stale) {
      const document = baseDocument(options.identity, view, viewRevision, generatedAt, basis, [], pageLimit);
      document.availability = { state: "stale", reasonCode: "git-race", message: "Git state changed during collection; retry the projection" };
      document.health = { state: "degraded", reasonCode: "git-race", message: "Git state changed during collection" };
      return document;
    }
    const issues: Array<Record<string, unknown>> = [];
    const files = visibleRecords(before).flatMap((record) => {
      const file = projectFile(before, record, view, basisRef, stats, blobDigests, options.isProtectedPath, workspaceDigests);
      if (file) return [file];
      if (displayStatus(record, view) && !record.path.display) {
        issues.push({
          issueRef: token("issue", `${view}:${record.path.digest}`),
          severity: "warning",
          code: "path-projection-unavailable",
          message: "A Git path could not be represented safely",
          relatedRefs: []
        });
      }
      return [];
    });
    return baseDocument(options.identity, view, viewRevision, generatedAt, basis, files, pageLimit, issues);
  };

  return {
    task: await collectTaskSourceChangeView(options) ?? unavailableTaskDocument(options, generatedAt, workspaceRev, repoRef),
    workingTree: project("working-tree", workingStats),
    staged: project("staged", stagedStats)
  };
}

function unavailableGitDocument(
  options: SourceProjectionOptions,
  generatedAt: string,
  view: "working-tree" | "staged",
  repoRef: string,
  workspaceRev: string,
  indexRev: string,
  reasonCode: string,
  message: string
): SourceChangeDocument {
  const basisRef = token("basis", `${repoRef}:${view}:${reasonCode}`);
  const basis = {
    basisRef,
    repoRef,
    view,
    state: "unavailable",
    reasonCode,
    basisRevision: token("basis-rev", `${basisRef}:unavailable`),
    headState: "unavailable",
    headRef: null,
    ...(view === "working-tree"
      ? { workspaceRevision: workspaceRev, indexRevision: indexRev }
      : { indexRevision: indexRev, workspaceRevision: workspaceRev })
  };
  return {
    schemaVersion: 1,
    version: "piagent-webui-source-change-v1",
    generatedAt,
    identity: options.identity,
    view,
    viewRevision: view === "working-tree" ? workspaceRev : indexRev,
    bases: [basis],
    availability: { state: "unavailable", reasonCode, message },
    files: [],
    page: { cursor: null, nextCursor: null, total: 0, returned: 0, truncated: false },
    truncationReason: null,
    redaction: { applied: false, valuesRemoved: 0, truncated: false },
    health: { state: "unavailable", reasonCode, message },
    issues: []
  };
}

export async function collectSourceChangeViews(options: SourceProjectionOptions): Promise<SourceChangeViews> {
  try {
    return await collectSourceChangeViewsStrict(options);
  } catch (error) {
    const generatedAt = cleanTimestamp(options.generatedAt);
    const reasonCode = error instanceof GitInspectionError ? error.code : "git-collection-failed";
    const message = ({
      "not-git": "The selected workspace is not a Git repository",
      timeout: "Git source collection timed out",
      "output-limit": "Git source collection exceeded its output cap",
      "git-failed": "Git source collection failed",
      "invalid-output": "Git returned an invalid source status",
      "git-collection-failed": "Workspace source evidence could not be read safely"
    } as Record<string, string>)[reasonCode] ?? "Git source collection failed";
    const root = path.resolve(options.cwd);
    const repoRef = token("repo", root);
    const workspaceRev = token("workspace", `${root}:${reasonCode}:unavailable`);
    const indexRev = token("index", `${root}:${reasonCode}:unavailable`);
    return {
      task: unavailableTaskDocument(options, generatedAt, workspaceRev, repoRef),
      workingTree: unavailableGitDocument(options, generatedAt, "working-tree", repoRef, workspaceRev, indexRev, reasonCode, message),
      staged: unavailableGitDocument(options, generatedAt, "staged", repoRef, workspaceRev, indexRev, reasonCode, message)
    };
  }
}

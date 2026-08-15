import { createHash } from "node:crypto";
import path from "node:path";

import {
  collectGitStatus,
  projectGitPath,
  readGitBlob,
  type GitStatusRecord,
  type GitStatusSnapshot
} from "./git-status-adapter.ts";
import { emptyGitTreeObjectId, listGitChangesAgainstTree, readGitTreeEntry } from "./git-tree-adapter.ts";
import {
  decodeBaselineRepoPath,
  readTaskBaselineBlob,
  readTaskBaselineManifest,
  taskBaselineManifestRef,
  taskBaselineRetentionState
} from "./source-evidence-store.ts";
import type { TaskBaselineEntry, TaskBaselineManifest, TaskBaselineRoot } from "./source-evidence-contract.ts";
import type { SourceChangeDocument, SourceProjectionOptions } from "./source-change-projection.ts";
import { buffersEqual, diffTextBuffers } from "./text-diff.ts";
import { taskProvenanceResolver } from "./task-provenance-projection.ts";
import { hashWorkspaceFile, inspectWorkspaceEntry, readWorkspaceFile, readWorkspaceLink } from "./workspace-file-reader.ts";

const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

type RootState = { manifest: TaskBaselineRoot; root: string; status: GitStatusSnapshot; records: Map<string, GitStatusRecord> };
type Content = { bytes: Buffer | null; kind: "text" | "binary" | "symlink" | "submodule" | "unknown"; access: "available" | "protected" | "oversized" | "unavailable"; reasonCode: string | null };
type BaselineItem = { entry: TaskBaselineEntry; root: TaskBaselineRoot; repoPath: string };
type TaskPathSelection = { paths: string[]; aliases: Map<string, Set<string>> };

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(prefix: string, value: string | Buffer): string {
  return `${prefix}.${hash(value)}`;
}

function digest(value: Buffer | null): string | null {
  return value === null ? null : `sha256:${hash(value)}`;
}

function rootPath(projectRoot: string, projectPath: string): string {
  return projectPath === "." ? projectRoot : path.join(projectRoot, ...projectPath.split("/"));
}

function rootRelative(root: TaskBaselineRoot, projectPath: string): string | null {
  if (root.projectPath === ".") return projectPath;
  return projectPath.startsWith(`${root.projectPath}/`) ? projectPath.slice(root.projectPath.length + 1) : null;
}

function visibleRepoPath(repoPath: string): boolean {
  return repoPath !== ".pi/piagent-state" && !repoPath.startsWith(".pi/piagent-state/");
}

function visibleRecord(record: GitStatusRecord): boolean {
  const paths = [record.path.value, record.oldPath?.value].filter((value): value is string => Boolean(value));
  return paths.length > 0 && paths.every(visibleRepoPath);
}

function recordMap(status: GitStatusSnapshot): Map<string, GitStatusRecord> {
  const result = new Map<string, GitStatusRecord>();
  for (const record of status.records) {
    if (record.path.value) result.set(record.path.value, record);
    if (record.oldPath?.value) result.set(record.oldPath.value, record);
  }
  return result;
}

async function collectRoots(projectRoot: string, manifest: TaskBaselineManifest): Promise<RootState[]> {
  return await Promise.all(manifest.roots.map(async (root) => {
    const absolute = rootPath(projectRoot, root.projectPath);
    const status = await collectGitStatus(absolute);
    return { manifest: root, root: absolute, status, records: recordMap(status) };
  }));
}

function entryMap(manifest: TaskBaselineManifest): Map<string, BaselineItem> {
  const result = new Map<string, BaselineItem>();
  for (const root of manifest.roots) {
    for (const entry of root.entries) {
      const repoPath = decodeBaselineRepoPath(entry);
      if (!repoPath || !visibleRepoPath(repoPath)) continue;
      const projectPath = root.projectPath === "." ? repoPath : `${root.projectPath}/${repoPath}`;
      result.set(projectPath, { entry, root, repoPath });
    }
  }
  return result;
}

function unavailableContent(access: Content["access"], reasonCode: string, kind: Content["kind"] = "unknown"): Content {
  return { bytes: null, kind, access, reasonCode };
}

function contentKind(bytes: Buffer): "text" | "binary" {
  return bytes.includes(0) ? "binary" : "text";
}

function baselineEntryContent(projectRoot: string, taskRunId: string, entry: TaskBaselineEntry): Content {
  if (entry.state === "absent") return { bytes: null, kind: "unknown", access: "available", reasonCode: null };
  if (entry.state === "submodule") return unavailableContent("available", "submodule-content", "submodule");
  if (entry.state === "protected") return unavailableContent("protected", entry.reasonCode ?? "protected-path");
  if (entry.state === "oversized") return unavailableContent("oversized", entry.reasonCode ?? "file-size-limit");
  if (entry.state === "unavailable" || !entry.contentRef) return unavailableContent("unavailable", entry.reasonCode ?? "baseline-content-unavailable");
  const bytes = readTaskBaselineBlob(projectRoot, taskRunId, entry.contentRef, MAX_CONTENT_BYTES);
  return { bytes, kind: entry.state === "symlink" ? "symlink" : contentKind(bytes), access: "available", reasonCode: null };
}

async function headContent(root: RootState, repoPath: string): Promise<Content> {
  if (root.manifest.headState === "unborn" || !root.manifest.headOid) return { bytes: null, kind: "unknown", access: "available", reasonCode: null };
  try {
    const entry = await readGitTreeEntry(root.root, root.manifest.headOid, repoPath);
    if (!entry) return { bytes: null, kind: "unknown", access: "available", reasonCode: null };
    if (entry.mode === "160000" || entry.type === "commit") return unavailableContent("available", "submodule-content", "submodule");
    const bytes = await readGitBlob(root.root, entry.objectId, { maxBytes: MAX_CONTENT_BYTES });
    return { bytes, kind: entry.mode === "120000" ? "symlink" : contentKind(bytes), access: "available", reasonCode: null };
  } catch (error) {
    const reason = (error as { code?: string }).code === "output-limit" ? "baseline-blob-limit" : "baseline-git-object-unavailable";
    return unavailableContent((error as { code?: string }).code === "output-limit" ? "oversized" : "unavailable", reason);
  }
}

function linkAliases(aliases: Map<string, Set<string>>, paths: string[]): void {
  const linked = new Set(paths.flatMap((candidate) => [...(aliases.get(candidate) ?? [candidate])]));
  for (const candidate of linked) aliases.set(candidate, linked);
}

async function taskPaths(roots: RootState[], baseline: ReturnType<typeof entryMap>): Promise<TaskPathSelection> {
  const values = new Set(baseline.keys());
  const aliases = new Map<string, Set<string>>();
  for (const root of roots) {
    const projectPath = (repoPath: string) => root.manifest.projectPath === "." ? repoPath : `${root.manifest.projectPath}/${repoPath}`;
    const hidden = new Set<string>();
    for (const record of root.status.records) {
      const recordPaths = [record.path.value, record.oldPath?.value].filter((value): value is string => Boolean(value));
      const projected = recordPaths.map(projectPath);
      linkAliases(aliases, projected);
      projected.forEach((value) => values.add(value));
      if (!visibleRecord(record)) projected.forEach((value) => hidden.add(value));
    }
    const trees = new Set([
      root.manifest.headOid ?? await emptyGitTreeObjectId(root.root),
      root.status.headOid ?? await emptyGitTreeObjectId(root.root)
    ]);
    for (const tree of trees) {
      for (const change of await listGitChangesAgainstTree(root.root, tree)) {
        const repoPaths = [change.path, change.oldPath].filter((value): value is string => Boolean(value));
        const projected = repoPaths.map(projectPath);
        linkAliases(aliases, projected);
        projected.forEach((value) => values.add(value));
        if (repoPaths.some((value) => !visibleRepoPath(value))) projected.forEach((value) => hidden.add(value));
      }
    }
    for (const candidate of [...hidden]) for (const alias of aliases.get(candidate) ?? []) hidden.add(alias);
    for (const candidate of hidden) values.delete(candidate);
  }
  return { paths: [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))), aliases };
}

function protectedRecordPath(options: SourceProjectionOptions, root: RootState, repoPath: string, record?: GitStatusRecord, historical: string[] = []): boolean {
  const candidates = new Set([repoPath, record?.path.value, record?.oldPath?.value, ...historical].filter((value): value is string => Boolean(value)));
  return [...candidates].some((candidate) => options.isProtectedPath?.(root.root, candidate) === true);
}

function workspaceEvidence(root: RootState, record: GitStatusRecord, options: SourceProjectionOptions): unknown {
  const repoPath = record.path.value;
  const identity = [record.path.digest, record.oldPath?.digest ?? null, record.indexStatus, record.worktreeStatus];
  if (!repoPath) return [...identity, "unsafe-path"];
  const protectedPath = protectedRecordPath(options, root, repoPath, record);
  try {
    const stat = inspectWorkspaceEntry(root.root, repoPath);
    if (protectedPath) return [...identity, "protected", stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
    if (stat.isSymbolicLink()) return [...identity, "symlink", readWorkspaceLink(root.root, repoPath)];
    if (stat.isFile() && stat.size <= MAX_CONTENT_BYTES) return [...identity, "file", hashWorkspaceFile(root.root, repoPath)];
    return [...identity, stat.isFile() ? "oversized" : "other", stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch {
    return [...identity, "absent"];
  }
}

function observation(roots: RootState[], options: SourceProjectionOptions): string {
  return token("workspace", JSON.stringify(roots.map((root) => [
    root.manifest.repoRef,
    root.status.headOid,
    root.status.records.filter(visibleRecord).map((record) => workspaceEvidence(root, record, options))
  ])));
}

function workspacePathPresent(root: RootState, repoPath: string): boolean {
  try { inspectWorkspaceEntry(root.root, repoPath); return true; }
  catch { return false; }
}

async function treeEntryIdentity(root: RootState, oid: string | null, repoPath: string): Promise<string | null> {
  if (!oid) return null;
  const entry = await readGitTreeEntry(root.root, oid, repoPath);
  return entry ? `${entry.mode}:${entry.type}:${entry.objectId}` : null;
}

async function protectedChangeState(
  root: RootState,
  repoPath: string,
  record: GitStatusRecord | undefined,
  baselineItem: BaselineItem | undefined
): Promise<{ changed: boolean; basePresent: boolean; currentPresent: boolean; exact: boolean }> {
  const currentPresent = workspacePathPresent(root, repoPath);
  if (baselineItem) {
    const basePresent = baselineItem.entry.state !== "absent";
    if (!basePresent || !currentPresent) return { changed: basePresent !== currentPresent, basePresent, currentPresent, exact: true };
    return { changed: true, basePresent, currentPresent, exact: false };
  }
  const baseIdentity = await treeEntryIdentity(root, root.manifest.headOid, repoPath);
  const currentIdentity = await treeEntryIdentity(root, root.status.headOid, repoPath);
  return {
    changed: Boolean(record) || baseIdentity !== currentIdentity,
    basePresent: baseIdentity !== null,
    currentPresent,
    exact: true
  };
}

function currentContent(root: RootState, repoPath: string, record: GitStatusRecord | undefined): Content {
  if (record?.headMode === "160000" || record?.indexMode === "160000" || record?.worktreeMode === "160000" || record?.submodule?.startsWith("S")) {
    return unavailableContent("available", "submodule-content", "submodule");
  }
  try {
    const stat = inspectWorkspaceEntry(root.root, repoPath);
    if (stat.isSymbolicLink()) {
      const bytes = Buffer.from(readWorkspaceLink(root.root, repoPath), "utf8");
      return { bytes, kind: "symlink", access: "available", reasonCode: null };
    }
    if (!stat.isFile()) return unavailableContent("unavailable", "unsupported-file-type");
    if (stat.size > MAX_CONTENT_BYTES) return unavailableContent("oversized", "file-size-limit");
    const bytes = readWorkspaceFile(root.root, repoPath, MAX_CONTENT_BYTES);
    return { bytes, kind: contentKind(bytes), access: "available", reasonCode: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, kind: "unknown", access: "available", reasonCode: null };
    return unavailableContent("unavailable", "content-read-failed");
  }
}

function projectUnavailable(options: SourceProjectionOptions, manifest: TaskBaselineManifest, reasonCode: string, message: string, protectedCount = 0): SourceChangeDocument {
  const repoRef = manifest.roots[0]?.repoRef ?? token("repo", options.cwd);
  const basisRef = token("basis", `${manifest.integrityDigest}:unavailable`);
  const viewRevision = token("task", `${manifest.integrityDigest}:unavailable`);
  return {
    schemaVersion: 1, version: "piagent-webui-source-change-v1", generatedAt: options.generatedAt ?? new Date().toISOString(), identity: options.identity,
    view: "task", viewRevision, bases: [{ basisRef, repoRef, view: "task", state: "unavailable", reasonCode,
      basisRevision: token("basis-rev", `${basisRef}:unavailable`), taskRunId: manifest.taskRunId,
      taskRevision: options.taskRevision ?? "task-revision.unavailable", workspaceRevision: token("workspace", `${manifest.integrityDigest}:unavailable`),
      baselineManifestRef: taskBaselineManifestRef(manifest), baselineTreeDigest: manifest.baselineTreeDigest }],
    availability: { state: "unavailable", reasonCode, message }, files: [],
    page: { cursor: null, nextCursor: null, total: 0, returned: 0, truncated: false }, truncationReason: null,
    redaction: { applied: protectedCount > 0 || manifest.roots.some((root) => root.entries.some((entry) => entry.state === "protected")), valuesRemoved: protectedCount + manifest.roots.reduce((count, root) => count + root.entries.filter((entry) => entry.state === "protected").length, 0), truncated: false },
    health: { state: "unavailable", reasonCode, message }, issues: []
  };
}

function stats(base: Content, current: Content, conflict: boolean) {
  if (conflict) return { state: "unavailable", additions: null, deletions: null, reasonCode: "git-conflict" };
  if (base.bytes === null && base.access === "available" && current.bytes !== null) {
    const result = diffTextBuffers(Buffer.alloc(0), current.bytes);
    return result.exact ? { state: "exact", additions: result.additions, deletions: 0, reasonCode: null } : { state: "unavailable", additions: null, deletions: null, reasonCode: result.reasonCode };
  }
  if (current.bytes === null && current.access === "available" && base.bytes !== null) {
    const result = diffTextBuffers(base.bytes, Buffer.alloc(0));
    return result.exact ? { state: "exact", additions: 0, deletions: result.deletions, reasonCode: null } : { state: "unavailable", additions: null, deletions: null, reasonCode: result.reasonCode };
  }
  if (base.bytes !== null && current.bytes !== null) {
    const result = diffTextBuffers(base.bytes, current.bytes);
    return result.exact ? { state: "exact", additions: result.additions, deletions: result.deletions, reasonCode: null } : { state: "unavailable", additions: null, deletions: null, reasonCode: result.reasonCode };
  }
  return { state: "unavailable", additions: null, deletions: null, reasonCode: base.reasonCode ?? current.reasonCode ?? "line-stats-unavailable" };
}

function changed(base: Content, current: Content, inCurrentSnapshot: boolean, inBaseline: boolean): boolean {
  if (base.access !== "available" || current.access !== "available") return inCurrentSnapshot || inBaseline;
  return !buffersEqual(base.bytes, current.bytes);
}

export async function collectTaskSourceChangeView(options: SourceProjectionOptions): Promise<SourceChangeDocument | null> {
  if (!options.identity.taskId || !options.identity.taskRunId) return null;
  let manifest: TaskBaselineManifest | undefined;
  try { manifest = readTaskBaselineManifest(options.cwd, options.identity.taskRunId); }
  catch { return null; }
  if (!manifest) return null;
  if (taskBaselineRetentionState(manifest, new Date(options.generatedAt ?? Date.now())) === "expired") {
    return projectUnavailable(options, manifest, "task-baseline-retention-expired", "Task baseline evidence is outside its retention window");
  }
  if (manifest.taskId !== options.identity.taskId || manifest.captureState !== "current") {
    return projectUnavailable(options, manifest, manifest.reasonCode ?? "task-baseline-content-unavailable", "Exact task baseline evidence is unavailable");
  }
  const roots = await collectRoots(options.cwd, manifest);
  const baseline = entryMap(manifest);
  const selection = await taskPaths(roots, baseline);
  const beforeObservation = observation(roots, options);
  const provenanceFor = taskProvenanceResolver(options.cwd, manifest);
  const basisRefs = new Map(manifest.roots.map((root) => [root.repoRef, token("basis", `${manifest.integrityDigest}:${root.repoRef}`)]));
  const files: Array<Record<string, unknown>> = [];
  for (const projectPath of selection.paths) {
    const root = roots.find((candidate) => rootRelative(candidate.manifest, projectPath) !== null);
    if (!root) continue;
    const repoPath = rootRelative(root.manifest, projectPath) as string;
    const record = root.records.get(repoPath);
    if (!visibleRepoPath(repoPath) || (record && !visibleRecord(record))) continue;
    const baselineItem = baseline.get(projectPath);
    const historical = [...(selection.aliases.get(projectPath) ?? [])]
      .map((candidate) => rootRelative(root.manifest, candidate)).filter((candidate): candidate is string => candidate !== null);
    const protectedPath = protectedRecordPath(options, root, repoPath, record, historical);
    const protectedState = protectedPath ? await protectedChangeState(root, repoPath, record, baselineItem) : null;
    if (protectedState && !protectedState.exact) {
      return projectUnavailable(options, manifest, "protected-baseline-overlap", "Exact task delta overlaps content protected by the current policy", 1);
    }
    const base = protectedPath
      ? unavailableContent("protected", "protected-path")
      : baselineItem ? baselineEntryContent(options.cwd, manifest.taskRunId, baselineItem.entry) : await headContent(root, repoPath);
    const current = protectedPath ? unavailableContent("protected", "protected-path") : currentContent(root, repoPath, record);
    const basePresent = protectedState?.basePresent
      ?? (baselineItem ? baselineItem.entry.state !== "absent" : await treeEntryIdentity(root, root.manifest.headOid, repoPath) !== null);
    const currentPresent = protectedState?.currentPresent ?? workspacePathPresent(root, repoPath);
    if (protectedState ? !protectedState.changed : !changed(base, current, currentPresent, basePresent)) continue;
    const conflict = record?.kind === "unmerged" || record?.indexStatus === "U" || record?.worktreeStatus === "U";
    const status = conflict ? "C" : !basePresent ? (record?.kind === "untracked" ? "U" : "A") : !currentPresent ? "D" : "M";
    const display = projectGitPath(projectPath);
    if (!display.display) continue;
    const fileRef = token("file", `${root.status.repoDigest}\0${display.digest}`);
    const recordState = record ? [record.kind, record.path.digest, record.oldPath?.digest ?? null, record.indexStatus, record.worktreeStatus,
      record.headMode, record.indexMode, record.worktreeMode, record.headObject, record.indexObject] : null;
    const fileRevision = token("file-rev", JSON.stringify([manifest.integrityDigest, projectPath, digest(base.bytes), digest(current.bytes),
      root.status.headOid, recordState, protectedPath]));
    const access = base.access !== "available" ? base.access : current.access;
    const kind = current.bytes === null ? base.kind : current.kind;
    const reasonCode = base.reasonCode ?? current.reasonCode;
    files.push({
      repoRef: root.manifest.repoRef, basisRef: basisRefs.get(root.manifest.repoRef), fileRef, fileRevision,
      path: display.display, oldPath: null, pathDisplay: display.displayMode, status,
      git: { indexStatus: record?.indexStatus ?? ".", worktreeStatus: record?.worktreeStatus ?? ".", conflict },
      baseDigest: protectedPath || status === "A" || status === "U" ? null : digest(base.bytes), currentDigest: protectedPath || status === "D" ? null : digest(current.bytes),
      content: access === "available" && kind !== "unknown" ? { kind, access, reasonCode: null } : { kind: kind === "unknown" ? "unknown" : kind, access, reasonCode: reasonCode ?? "content-unavailable" },
      stats: protectedPath ? { state: "unavailable", additions: null, deletions: null, reasonCode: "protected-path" } : stats(base, current, conflict),
      provenance: provenanceFor(projectPath, digest(current.bytes), baselineItem?.entry),
      criterionIds: [], verifierAttemptIds: [], health: access === "available" ? { state: "ok", reasonCode: null, message: null } : { state: "degraded", reasonCode: reasonCode ?? "content-unavailable", message: "Exact task content is unavailable" }
    });
  }
  const afterRoots = await collectRoots(options.cwd, manifest);
  const afterObservation = observation(afterRoots, options);
  if (beforeObservation !== afterObservation) return projectUnavailable(options, manifest, "git-race", "Workspace changed during task projection; retry");
  const workspaceRevision = afterObservation;
  const viewRevision = token("task", `${manifest.integrityDigest}:${workspaceRevision}`);
  const bases = manifest.roots.map((root) => ({
    basisRef: basisRefs.get(root.repoRef), repoRef: root.repoRef, view: "task", state: "current", reasonCode: null,
    basisRevision: token("basis-rev", `${manifest.integrityDigest}:${root.repoRef}`), taskRunId: manifest.taskRunId,
    taskRevision: options.taskRevision ?? "task-revision.unavailable", workspaceRevision,
    baselineManifestRef: taskBaselineManifestRef(manifest), baselineTreeDigest: manifest.baselineTreeDigest
  }));
  const limit = Number.isInteger(options.pageLimit) ? Math.max(1, Math.min(2000, options.pageLimit as number)) : 300;
  const returned = files.slice(0, limit);
  const truncated = returned.length < files.length;
  const protectedCount = files.filter((file) => (file.content as Record<string, unknown>)?.access === "protected").length;
  return {
    schemaVersion: 1, version: "piagent-webui-source-change-v1", generatedAt: options.generatedAt ?? new Date().toISOString(), identity: options.identity,
    view: "task", viewRevision, bases, availability: { state: "current", reasonCode: null, message: null }, files: returned,
    page: { cursor: null, nextCursor: truncated ? token("page", `${viewRevision}:${limit}`) : null, total: files.length, returned: returned.length, truncated }, truncationReason: truncated ? "page-limit" : null,
    redaction: { applied: protectedCount > 0, valuesRemoved: protectedCount, truncated: false },
    health: protectedCount > 0
      ? { state: "degraded", reasonCode: "source-content-restricted", message: "Some task content is protected by policy" }
      : { state: "ok", reasonCode: null, message: null },
    issues: []
  };
}

export async function readTaskFileContents(options: SourceProjectionOptions, fileRef: string): Promise<{ base: Buffer | null; current: Buffer | null } | null> {
  if (!options.identity.taskRunId) return null;
  let manifest: TaskBaselineManifest | undefined;
  try { manifest = readTaskBaselineManifest(options.cwd, options.identity.taskRunId); }
  catch { return null; }
  if (!manifest || manifest.captureState !== "current"
    || taskBaselineRetentionState(manifest, new Date(options.generatedAt ?? Date.now())) === "expired") return null;
  const roots = await collectRoots(options.cwd, manifest);
  const baseline = entryMap(manifest);
  const selection = await taskPaths(roots, baseline);
  for (const projectPath of selection.paths) {
    const root = roots.find((candidate) => rootRelative(candidate.manifest, projectPath) !== null);
    if (!root) continue;
    const repoPath = rootRelative(root.manifest, projectPath) as string;
    const record = root.records.get(repoPath);
    if (!visibleRepoPath(repoPath) || (record && !visibleRecord(record))) continue;
    const display = projectGitPath(projectPath);
    if (token("file", `${root.status.repoDigest}\0${display.digest}`) !== fileRef) continue;
    const historical = [...(selection.aliases.get(projectPath) ?? [])]
      .map((candidate) => rootRelative(root.manifest, candidate)).filter((candidate): candidate is string => candidate !== null);
    if (protectedRecordPath(options, root, repoPath, record, historical)) return null;
    const item = baseline.get(projectPath);
    const base = item ? baselineEntryContent(options.cwd, manifest.taskRunId, item.entry) : await headContent(root, repoPath);
    const current = currentContent(root, repoPath, record);
    if (base.access !== "available" || current.access !== "available") return null;
    return { base: base.bytes, current: current.bytes };
  }
  return null;
}

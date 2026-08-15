import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../../extensions/working-tree-digest.js";
import { collectGitStatus, type GitStatusRecord, type GitStatusSnapshot } from "./git-status-adapter.ts";
import { collectSourceChangeViews, sourceFileRef, type WebUiIdentity } from "./source-change-projection.ts";
import {
  TASK_BASELINE_MANIFEST_VERSION,
  taskBaselineManifestDigest,
  validateTaskBaselineManifest,
  type TaskBaselineEntry,
  type TaskBaselineManifest,
  type TaskBaselineRoot
} from "./source-evidence-contract.ts";
import { inspectWorkspaceEntry, readWorkspaceFile, readWorkspaceLink } from "./workspace-file-reader.ts";

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type BaselineCaptureOptions = {
  projectRoot: string;
  taskId: string;
  taskRunId: string;
  sessionId: string;
  capturedAt: string;
  baselineTreeDigest: string;
  isProtectedProjectPath?: (projectPath: string) => boolean;
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
};

type EvidenceRoot = { cwd: string; projectPath: string };
type Candidate = { record: GitStatusRecord; repoPath: string | null; absent: boolean };

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string | Buffer): string {
  return `sha256:${hash(value)}`;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
}

function runDirectory(projectRoot: string, taskRunId: string): string {
  return path.join(projectRoot, ".pi", "piagent-state", "source-evidence", `run-${hash(taskRunId)}`);
}

export function taskBaselineManifestPath(projectRoot: string, taskRunId: string): string {
  return path.join(runDirectory(projectRoot, taskRunId), "manifest.json");
}

function blobPath(projectRoot: string, taskRunId: string, contentRef: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(contentRef)) throw new Error("Invalid baseline content ref");
  return path.join(runDirectory(projectRoot, taskRunId), "blobs", contentRef.slice(7));
}

function readPrivateFile(projectRoot: string, file: string, maxBytes: number): Buffer {
  const safe = resolveLocalStatePath(projectRoot, file, { label: "Source evidence", kind: "file" });
  const descriptor = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Source evidence file is oversized or not regular");
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishPrivateFile(projectRoot: string, target: string, content: Buffer): void {
  const parent = ensurePrivateStateDirectory(projectRoot, path.dirname(target), "Source evidence directory");
  const safeTarget = resolveLocalStatePath(projectRoot, target, { label: "Source evidence" });
  const temporary = path.join(parent, `${path.basename(safeTarget)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, safeTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readPrivateFile(projectRoot, safeTarget, Math.max(1024, content.length));
    if (!existing.equals(content)) throw new Error("Existing source evidence does not match the captured bytes");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
}

function writeBlob(projectRoot: string, taskRunId: string, content: Buffer): string {
  const contentRef = digest(content);
  publishPrivateFile(projectRoot, blobPath(projectRoot, taskRunId, contentRef), content);
  return contentRef;
}

async function discoverEvidenceRoots(projectRoot: string): Promise<EvidenceRoot[]> {
  const absolute = fs.realpathSync.native(projectRoot);
  try {
    await collectGitStatus(absolute);
    return [{ cwd: absolute, projectPath: "." }];
  } catch {
    const roots: EvidenceRoot[] = [];
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = path.join(absolute, entry.name);
      try {
        if (fs.lstatSync(child).isSymbolicLink()) continue;
        const status = await collectGitStatus(child);
        if (status.repoRoot !== fs.realpathSync.native(child)) continue;
        roots.push({ cwd: status.repoRoot, projectPath: entry.name });
      } catch {}
    }
    return roots.sort((left, right) => left.projectPath.localeCompare(right.projectPath, "en"));
  }
}

function projectPath(root: EvidenceRoot, repoPath: string): string {
  return root.projectPath === "." ? repoPath : `${root.projectPath}/${repoPath}`;
}

function entryMode(record: GitStatusRecord, absent: boolean): string {
  if (absent) return "000000";
  const mode = record.worktreeMode === "000000" ? record.indexMode : record.worktreeMode;
  return /^[0-7]{6}$/.test(mode ?? "") ? mode as string : "000000";
}

function candidates(snapshot: GitStatusSnapshot): Candidate[] {
  const selected = new Map<string, Candidate>();
  for (const record of snapshot.records) {
    if (record.kind === "ignored") continue;
    const paths = [record.path.value, record.oldPath?.value].filter((value): value is string => Boolean(value));
    if (paths.some((value) => value === ".pi/piagent-state" || value.startsWith(".pi/piagent-state/"))) continue;
    if (record.oldPath?.value) selected.set(record.oldPath.value, { record, repoPath: record.oldPath.value, absent: true });
    if (record.path.value) selected.set(record.path.value, { record, repoPath: record.path.value, absent: record.worktreeMode === "000000" && record.kind !== "untracked" });
    else selected.set(`unavailable:${record.path.digest}`, { record, repoPath: null, absent: false });
  }
  return [...selected.values()].sort((left, right) => Buffer.compare(Buffer.from(left.repoPath ?? left.record.path.digest), Buffer.from(right.repoPath ?? right.record.path.digest)));
}

function unavailableEntry(candidate: Candidate, snapshot: GitStatusSnapshot, reasonCode: string): TaskBaselineEntry {
  const raw = candidate.repoPath ? Buffer.from(candidate.repoPath, "utf8") : null;
  const pathDigest = candidate.repoPath ? digest(raw as Buffer) : candidate.record.path.digest;
  return {
    pathRef: `path.${hash(`${snapshot.repoDigest}\0${pathDigest}`)}`,
    pathDigest,
    repoPathBase64: raw?.toString("base64url") ?? null,
    state: "unavailable",
    reasonCode,
    contentRef: null,
    byteLength: 0,
    mode: entryMode(candidate.record, candidate.absent),
    headObject: candidate.record.headObject && !/^0+$/.test(candidate.record.headObject) ? candidate.record.headObject : null,
    indexObject: candidate.record.indexObject && !/^0+$/.test(candidate.record.indexObject) ? candidate.record.indexObject : null
  };
}

function captureEntry(
  options: BaselineCaptureOptions,
  root: EvidenceRoot,
  snapshot: GitStatusSnapshot,
  candidate: Candidate,
  quota: { captured: number; refs: Set<string>; maxFile: number; maxTotal: number }
): TaskBaselineEntry {
  if (!candidate.repoPath) return unavailableEntry(candidate, snapshot, "path-unavailable");
  const base = unavailableEntry(candidate, snapshot, "capture-unavailable");
  const encoded = Buffer.from(candidate.repoPath, "utf8").toString("base64url");
  const exact = (state: TaskBaselineEntry["state"], contentRef: string | null, byteLength: number): TaskBaselineEntry => ({ ...base, repoPathBase64: encoded, state, reasonCode: null, contentRef, byteLength });
  if (options.isProtectedProjectPath?.(projectPath(root, candidate.repoPath))) {
    return { ...base, repoPathBase64: encoded, state: "protected", reasonCode: "protected-path" };
  }
  if (candidate.absent) return exact("absent", null, 0);
  if (base.mode === "160000" || candidate.record.submodule?.startsWith("S")) return exact("submodule", null, 0);
  try {
    const stat = inspectWorkspaceEntry(snapshot.repoRoot, candidate.repoPath);
    let content: Buffer;
    let state: "blob" | "symlink";
    if (stat.isSymbolicLink()) {
      content = Buffer.from(readWorkspaceLink(snapshot.repoRoot, candidate.repoPath), "utf8");
      state = "symlink";
    } else if (stat.isFile()) {
      if (stat.size > quota.maxFile) return { ...base, repoPathBase64: encoded, state: "oversized", reasonCode: "file-size-limit", byteLength: Math.min(stat.size, 16 * 1024 * 1024) };
      content = readWorkspaceFile(snapshot.repoRoot, candidate.repoPath, quota.maxFile);
      state = "blob";
    } else return { ...base, repoPathBase64: encoded, reasonCode: "unsupported-file-type" };
    const contentRef = digest(content);
    const additional = quota.refs.has(contentRef) ? 0 : content.length;
    if (quota.captured + additional > quota.maxTotal) return { ...base, repoPathBase64: encoded, reasonCode: "task-byte-quota" };
    writeBlob(options.projectRoot, options.taskRunId, content);
    quota.refs.add(contentRef);
    quota.captured += additional;
    return exact(state, contentRef, content.length);
  } catch {
    return { ...base, repoPathBase64: encoded, reasonCode: "content-read-failed" };
  }
}

function identity(options: BaselineCaptureOptions): WebUiIdentity {
  return { projectRef: "baseline-capture", runtimeInstanceId: "baseline-capture", sessionRef: "baseline-capture", taskId: options.taskId, taskRunId: options.taskRunId, agentOperationId: null, toolCallId: null };
}

async function captureRoot(options: BaselineCaptureOptions, root: EvidenceRoot, quota: { captured: number; refs: Set<string>; maxFile: number; maxTotal: number }, maxEntries: number): Promise<TaskBaselineRoot> {
  const snapshot = await collectGitStatus(root.cwd);
  const projected = await collectSourceChangeViews({ cwd: root.cwd, identity: identity(options), generatedAt: options.capturedAt, pageLimit: 2000 });
  const basis = projected.workingTree.bases[0] as Record<string, any>;
  const all = candidates(snapshot);
  const limited = all.slice(0, maxEntries);
  const entries = limited.map((candidate) => captureEntry(options, root, snapshot, candidate, quota));
  const bad = entries.find((entry) => ["protected", "oversized", "unavailable"].includes(entry.state));
  const state = all.length > limited.length || bad ? "unavailable" : "current";
  const reasonCode = all.length > limited.length ? "entry-limit" : bad?.reasonCode ?? null;
  return {
    repoRef: String(basis.repoRef),
    projectPath: root.projectPath,
    headState: snapshot.headState,
    headOid: snapshot.headOid,
    workspaceRevision: String(basis.workspaceRevision),
    indexRevision: String(basis.indexRevision),
    state,
    reasonCode,
    entries
  };
}

export async function captureTaskBaselineManifest(options: BaselineCaptureOptions): Promise<TaskBaselineManifest> {
  const existing = readTaskBaselineManifest(options.projectRoot, options.taskRunId);
  if (existing) {
    if (existing.taskId !== options.taskId || existing.baselineTreeDigest !== options.baselineTreeDigest) throw new Error("Task baseline manifest identity collision");
    return existing;
  }
  if (workingTreeEvidenceDigest(workingTreeSnapshot(options.projectRoot)) !== options.baselineTreeDigest) {
    throw new Error("Workspace changed before Task Baseline Manifest capture");
  }
  const maxEntries = bounded(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, DEFAULT_MAX_ENTRIES);
  const maxFileBytes = bounded(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1024, 16 * 1024 * 1024);
  const maxTotalBytes = bounded(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1024 * 1024, 256 * 1024 * 1024);
  const retentionMs = bounded(options.retentionMs, DEFAULT_RETENTION_MS, 60_000, 365 * 24 * 60 * 60 * 1000);
  const roots = await discoverEvidenceRoots(options.projectRoot);
  if (roots.length === 0 || roots.length > 32) throw new Error("Task baseline capture requires between one and 32 Git roots");
  const quota = { captured: 0, refs: new Set<string>(), maxFile: maxFileBytes, maxTotal: maxTotalBytes };
  let remaining = maxEntries;
  const capturedRoots: TaskBaselineRoot[] = [];
  for (const root of roots) {
    const captured = await captureRoot(options, root, quota, remaining);
    capturedRoots.push(captured);
    remaining = Math.max(0, remaining - captured.entries.length);
  }
  const badRoot = capturedRoots.find((root) => root.state !== "current");
  const payload: Omit<TaskBaselineManifest, "integrityDigest"> = {
    schemaVersion: 1,
    version: TASK_BASELINE_MANIFEST_VERSION,
    taskId: options.taskId,
    taskRunId: options.taskRunId,
    sessionIdentityHash: digest(options.sessionId),
    capturedAt: options.capturedAt,
    retentionUntil: new Date(Date.parse(options.capturedAt) + retentionMs).toISOString(),
    baselineDigestAlgorithm: "wt-content-v2",
    baselineTreeDigest: options.baselineTreeDigest,
    captureState: badRoot ? "unavailable" : "current",
    reasonCode: badRoot?.reasonCode ?? null,
    limits: { maxEntries, maxFileBytes, maxTotalBytes, capturedBytes: quota.captured },
    roots: capturedRoots
  };
  if (workingTreeEvidenceDigest(workingTreeSnapshot(options.projectRoot)) !== options.baselineTreeDigest) {
    throw new Error("Workspace changed during Task Baseline Manifest capture");
  }
  const manifest = validateTaskBaselineManifest({ ...payload, integrityDigest: taskBaselineManifestDigest(payload) });
  publishPrivateFile(options.projectRoot, taskBaselineManifestPath(options.projectRoot, options.taskRunId), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return manifest;
}

export function readTaskBaselineManifest(projectRoot: string, taskRunId: string): TaskBaselineManifest | undefined {
  const file = taskBaselineManifestPath(projectRoot, taskRunId);
  try {
    return validateTaskBaselineManifest(JSON.parse(readPrivateFile(projectRoot, file, 8 * 1024 * 1024).toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readTaskBaselineBlob(projectRoot: string, taskRunId: string, contentRef: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Buffer {
  const content = readPrivateFile(projectRoot, blobPath(projectRoot, taskRunId, contentRef), bounded(maxBytes, DEFAULT_MAX_FILE_BYTES, 1024, 16 * 1024 * 1024));
  if (digest(content) !== contentRef) throw new Error("Task baseline blob integrity mismatch");
  return content;
}

export function taskBaselineManifestRef(manifest: TaskBaselineManifest): string {
  return `baseline.${manifest.integrityDigest.slice(7)}`;
}

export function taskBaselineRetentionState(
  manifest: TaskBaselineManifest,
  at = new Date()
): "active" | "expired" {
  return at.getTime() < Date.parse(manifest.retentionUntil) ? "active" : "expired";
}

export function decodeBaselineRepoPath(entry: TaskBaselineEntry): string | null {
  if (entry.repoPathBase64 === null) return null;
  const value = Buffer.from(entry.repoPathBase64, "base64url").toString("utf8");
  return value && !path.posix.isAbsolute(value) && !value.split("/").includes("..") ? value : null;
}

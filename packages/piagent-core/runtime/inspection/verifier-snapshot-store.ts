import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { workingTreeEvidenceDigest, workingTreeSnapshotUsesCurrentAlgorithm } from "../../extensions/working-tree-digest.js";
import { projectGitPath } from "./git-status-adapter.ts";
import { readTaskBaselineManifest } from "./source-evidence-store.ts";
import {
  VERIFIER_SNAPSHOT_VERSION,
  decodeVerifierSnapshotPath,
  validateVerifierFileSnapshot,
  verifierSnapshotDigest,
  verifierSnapshotIdentity,
  type VerifierFileSnapshot
} from "./verifier-snapshot-contract.ts";

const MAX_ATTEMPTS = 200;
const MAX_FILES = 2_000;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type CaptureVerifierSnapshotOptions = {
  projectRoot: string;
  taskId: string;
  taskRunId: string;
  sessionId: string;
  toolCallId: string;
  commandHash: string;
  observedAt: string;
  capturedAt: string;
  exitCode: number;
  treeDigest: string;
  snapshot: Record<string, string>;
  protectedPaths?: string[];
};

export type VerifierStaleness = {
  state: "current" | "stale" | "unknown";
  attemptRef: string | null;
  invalidatedByFiles: string[];
  invalidatedPathDigests: string[];
  filesKnown: boolean;
  truncated: boolean;
  reasonCode: string | null;
};

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function runDirectory(root: string, run: string): string {
  return path.join(root, ".pi", "piagent-state", "source-evidence", `run-${hash(run)}`, "verifiers");
}
function safePath(value: string): boolean {
  return Boolean(value && value.length <= 1536 && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.split("/").includes("..") && !value.includes("\0"));
}

function readPrivate(root: string, file: string): Buffer {
  const safe = resolveLocalStatePath(root, file, { label: "Verifier snapshot", kind: "file" });
  const descriptor = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("Verifier snapshot is oversized or not regular");
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function publishPrivate(root: string, target: string, content: Buffer): void {
  const parent = ensurePrivateStateDirectory(root, path.dirname(target), "Verifier snapshot directory");
  const safeTarget = resolveLocalStatePath(root, target, { label: "Verifier snapshot" });
  const temporary = path.join(parent, `${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); }
  finally { fs.closeSync(descriptor); }
  try { fs.linkSync(temporary, safeTarget); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readPrivate(root, safeTarget).equals(content)) throw new Error("Verifier snapshot identity collision");
  } finally { fs.rmSync(temporary, { force: true }); }
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
}

export function captureVerifierFileSnapshot(options: CaptureVerifierSnapshotOptions): VerifierFileSnapshot | undefined {
  if (!/^[a-f0-9]{64}$/.test(options.commandHash) || !options.toolCallId
    || !workingTreeSnapshotUsesCurrentAlgorithm(options.snapshot)
    || workingTreeEvidenceDigest(options.snapshot) !== options.treeDigest) return undefined;
  const entries = Object.entries(options.snapshot).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (entries.length > MAX_FILES) return undefined;
  let manifest;
  try { manifest = readTaskBaselineManifest(options.projectRoot, options.taskRunId); }
  catch { return undefined; }
  if (manifest && (manifest.taskId !== options.taskId || Date.parse(manifest.retentionUntil) <= Date.parse(options.capturedAt))) return undefined;
  const files = entries.map(([repoPath, carrierDigest]) => {
    const pathDigest = `sha256:${hash(repoPath)}`;
    if (matchesProtectedPath(repoPath, options.protectedPaths ?? [])) {
      return { pathDigest, repoPathBase64: null, state: "protected" as const, reasonCode: "protected-path", carrierDigest };
    }
    if (!safePath(repoPath)) return { pathDigest, repoPathBase64: null, state: "unavailable" as const, reasonCode: "path-unavailable", carrierDigest };
    return { pathDigest, repoPathBase64: Buffer.from(repoPath, "utf8").toString("base64url"), state: "exact" as const, reasonCode: null, carrierDigest };
  });
  const commandDigest = `sha256:${options.commandHash}`;
  const toolCallIdentityHash = `sha256:${hash(`tool-call\0${options.toolCallId}`)}`;
  const identity = verifierSnapshotIdentity({ taskRunId: options.taskRunId, toolCallIdentityHash, commandDigest,
    observedAt: options.observedAt, treeDigest: options.treeDigest, exitCode: options.exitCode });
  const payload: Omit<VerifierFileSnapshot, "integrityDigest"> = {
    schemaVersion: 1, version: VERIFIER_SNAPSHOT_VERSION,
    attemptId: `verifier.${identity}`, attemptRef: `verifier-evidence.${identity}`,
    taskId: options.taskId, taskRunId: options.taskRunId,
    sessionIdentityHash: `sha256:${hash(`session\0${options.sessionId}`)}`, toolCallIdentityHash,
    commandDigest, observedAt: options.observedAt, capturedAt: options.capturedAt,
    retentionUntil: manifest?.retentionUntil ?? new Date(Date.parse(options.capturedAt) + DEFAULT_RETENTION_MS).toISOString(),
    exitCode: options.exitCode, outcome: options.exitCode === 0 ? "passed" : "failed", treeDigest: options.treeDigest,
    fileCount: files.length, exposedPathCount: files.filter((file) => file.state === "exact").length, files
  };
  const record = validateVerifierFileSnapshot({ ...payload, integrityDigest: verifierSnapshotDigest(payload) });
  const directory = runDirectory(options.projectRoot, options.taskRunId);
  let count = 0;
  try { count = fs.readdirSync(resolveLocalStatePath(options.projectRoot, directory, { label: "Verifier snapshot", kind: "directory" })).filter((file) => file.endsWith(".json")).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const target = path.join(directory, `${record.attemptId}.json`);
  if (count >= MAX_ATTEMPTS && !fs.existsSync(target)) throw new Error("Verifier snapshot quota is exhausted");
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  if (bytes.length > MAX_RECORD_BYTES) return undefined;
  publishPrivate(options.projectRoot, target, bytes);
  return record;
}

export function readVerifierFileSnapshots(root: string, taskRunId: string): { records: VerifierFileSnapshot[]; corruptions: string[] } {
  const directory = runDirectory(root, taskRunId);
  let files: string[];
  try { files = fs.readdirSync(resolveLocalStatePath(root, directory, { label: "Verifier snapshot", kind: "directory" })).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], corruptions: [] };
    return { records: [], corruptions: ["verifier-snapshot-directory-unavailable"] };
  }
  if (files.length > MAX_ATTEMPTS) return { records: [], corruptions: ["verifier-snapshot-limit"] };
  const records: VerifierFileSnapshot[] = [], corruptions: string[] = [];
  for (const file of files) {
    try {
      const record = validateVerifierFileSnapshot(JSON.parse(readPrivate(root, path.join(directory, file)).toString("utf8")));
      if (file !== `${record.attemptId}.json` || record.taskRunId !== taskRunId) throw new Error("identity mismatch");
      records.push(record);
    } catch { corruptions.push(`snapshot.${hash(file)}`); }
  }
  return { records: corruptions.length ? [] : records.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.attemptId.localeCompare(b.attemptId)), corruptions };
}

export function findVerifierFileSnapshot(
  records: VerifierFileSnapshot[],
  match: { commandDigest: string; observedAt: string; treeDigest: string; exitCode: number }
): VerifierFileSnapshot | undefined {
  return [...records].reverse().find((record) => record.commandDigest === match.commandDigest
    && record.observedAt === match.observedAt && record.treeDigest === match.treeDigest && record.exitCode === match.exitCode);
}

export function inspectVerifierStaleness(
  record: VerifierFileSnapshot | undefined,
  currentSnapshot: Record<string, string>,
  protectedPaths: string[] | null = null,
  at = new Date()
): VerifierStaleness {
  if (record && at.getTime() >= Date.parse(record.retentionUntil)) {
    return { state: "unknown", attemptRef: record.attemptRef, invalidatedByFiles: [], invalidatedPathDigests: [], filesKnown: false, truncated: false, reasonCode: "verifier-file-snapshot-expired" };
  }
  if (!record || !workingTreeSnapshotUsesCurrentAlgorithm(currentSnapshot)) {
    return { state: "unknown", attemptRef: record?.attemptRef ?? null, invalidatedByFiles: [], invalidatedPathDigests: [], filesKnown: false, truncated: false, reasonCode: record ? "current-tree-unavailable" : "verifier-file-snapshot-unavailable" };
  }
  const currentTree = workingTreeEvidenceDigest(currentSnapshot);
  if (currentTree === record.treeDigest) return { state: "current", attemptRef: record.attemptRef, invalidatedByFiles: [], invalidatedPathDigests: [], filesKnown: true, truncated: false, reasonCode: null };
  const prior = new Map(record.files.map((file) => [file.pathDigest, file]));
  const current = new Map(Object.entries(currentSnapshot).map(([repoPath, carrierDigest]) => [`sha256:${hash(repoPath)}`, { repoPath, carrierDigest }]));
  const changed = [...new Set([...prior.keys(), ...current.keys()])].filter((digest) => prior.get(digest)?.carrierDigest !== current.get(digest)?.carrierDigest).sort();
  const visible: string[] = [];
  let hidden = 0;
  for (const pathDigest of changed) {
    const old = prior.get(pathDigest), now = current.get(pathDigest);
    const decoded = old ? decodeVerifierSnapshotPath(old) : now?.repoPath ?? null;
    if (!decoded || (old && old.state !== "exact") || (!old && protectedPaths === null)
      || (protectedPaths !== null && matchesProtectedPath(decoded, protectedPaths))) { hidden += 1; continue; }
    const display = projectGitPath(decoded).display;
    if (!display) hidden += 1;
    else visible.push(display);
  }
  visible.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const returned = visible.slice(0, 300), truncated = returned.length < visible.length;
  return { state: "stale", attemptRef: record.attemptRef, invalidatedByFiles: returned,
    invalidatedPathDigests: changed.slice(0, 300), filesKnown: hidden === 0 && !truncated,
    truncated, reasonCode: hidden > 0 ? "invalidated-files-partially-hidden" : truncated ? "invalidated-files-truncated" : null };
}

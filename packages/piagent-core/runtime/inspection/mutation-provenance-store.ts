import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { workingTreeEvidenceDigest, workingTreeSnapshotUsesCurrentAlgorithm } from "../../extensions/working-tree-digest.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import {
  MUTATION_PROVENANCE_VERSION,
  mutationProvenanceDigest,
  mutationProvenanceIdentity,
  validateMutationProvenanceRecord,
  type MutationProvenanceRecord
} from "./mutation-provenance-contract.ts";
import { readTaskBaselineManifest, taskBaselineRetentionState } from "./source-evidence-store.ts";

const MAX_RECORDS = 500;
const MAX_RECORD_BYTES = 128 * 1024;

export type AppendMutationProvenanceOptions = {
  projectRoot: string;
  taskId: string;
  taskRunId: string;
  sessionId: string;
  toolCallId: string;
  toolName: "edit" | "write" | "apply_patch" | "shell" | "opaque";
  recordedAt: string;
  beforeSnapshot: Record<string, string>;
  afterSnapshot: Record<string, string>;
  recordedDigests: Record<string, string>;
  recordedContentDigests: Record<string, string>;
  proofModes: Record<string, "full-content" | "exact-replacement">;
  changedPaths: string[];
  protectedPaths?: string[];
};

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceDirectory(projectRoot: string, taskRunId: string): string {
  return path.join(projectRoot, ".pi", "piagent-state", "source-evidence", `run-${hash(taskRunId)}`, "mutations");
}

function readPrivate(projectRoot: string, file: string): Buffer {
  const safe = resolveLocalStatePath(projectRoot, file, { label: "Mutation provenance", kind: "file" });
  const descriptor = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("Mutation provenance record is oversized or not regular");
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function publishPrivate(projectRoot: string, target: string, content: Buffer): void {
  const parent = ensurePrivateStateDirectory(projectRoot, path.dirname(target), "Mutation provenance directory");
  const safeTarget = resolveLocalStatePath(projectRoot, target, { label: "Mutation provenance" });
  const temporary = path.join(parent, `${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); }
  finally { fs.closeSync(descriptor); }
  try { fs.linkSync(temporary, safeTarget); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readPrivate(projectRoot, safeTarget).equals(content)) throw new Error("Mutation provenance identity collision");
  } finally { fs.rmSync(temporary, { force: true }); }
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
}

function safePath(value: string): boolean {
  return Boolean(value && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.split("/").includes("..") && !value.includes("\0") && value.length <= 4096);
}

export function appendMutationProvenance(options: AppendMutationProvenanceOptions): MutationProvenanceRecord | undefined {
  const manifest = readTaskBaselineManifest(options.projectRoot, options.taskRunId);
  if (!manifest || manifest.taskId !== options.taskId || manifest.captureState !== "current"
    || taskBaselineRetentionState(manifest, new Date(options.recordedAt)) !== "active") return undefined;
  if (!workingTreeSnapshotUsesCurrentAlgorithm(options.beforeSnapshot) || !workingTreeSnapshotUsesCurrentAlgorithm(options.afterSnapshot)) return undefined;
  const paths = [...new Set(options.changedPaths)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (paths.length < 1 || paths.length > 100) return undefined;
  const evidenceMode = paths.every((repoPath) => options.recordedDigests[repoPath] && options.proofModes[repoPath])
    ? "exact-runtime" as const : "observed-runtime" as const;
  const previous = evidenceMode === "observed-runtime" ? readMutationProvenance(options.projectRoot, options.taskRunId).records : [];
  const changes = [];
  for (const repoPath of paths) {
    const before = options.beforeSnapshot[repoPath] ?? null;
    const after = options.afterSnapshot[repoPath];
    const content = options.recordedContentDigests[repoPath] ?? null;
    const proofMode = evidenceMode === "exact-runtime" ? options.proofModes[repoPath] : null;
    if (!safePath(repoPath) || matchesProtectedPath(repoPath, options.protectedPaths ?? [])
      || before === (after ?? null) || (content !== null && !/^[a-f0-9]{64}$/.test(content))) return undefined;
    if (evidenceMode === "exact-runtime" && (!after || after !== options.recordedDigests[repoPath] || !content || !proofMode)) return undefined;
    const priorContent = [...previous].reverse().flatMap((record) => record.changes)
      .find((change) => Buffer.from(change.repoPathBase64, "base64url").toString("utf8") === repoPath)?.afterContentDigest ?? null;
    const effect = evidenceMode === "exact-runtime" ? "exact-content"
      : content && priorContent === `sha256:${content}` ? "content-preserved"
        : content ? "content-changed" : "unknown";
    changes.push({
      pathDigest: `sha256:${hash(repoPath)}`,
      repoPathBase64: Buffer.from(repoPath, "utf8").toString("base64url"),
      beforeCarrierDigest: before,
      afterCarrierDigest: after ?? null,
      afterContentDigest: content ? `sha256:${content}` : null,
      proofMode,
      effect
    });
  }
  const beforeTreeDigest = workingTreeEvidenceDigest(options.beforeSnapshot);
  const afterTreeDigest = workingTreeEvidenceDigest(options.afterSnapshot);
  if (beforeTreeDigest === afterTreeDigest) return undefined;
  const core = {
    taskRunId: options.taskRunId,
    toolCallIdentityHash: `sha256:${hash(`tool-call\0${options.toolCallId}`)}`,
    recordedAt: options.recordedAt,
    afterTreeDigest,
    changes
  };
  const identity = mutationProvenanceIdentity(core);
  const payload: Omit<MutationProvenanceRecord, "integrityDigest"> = {
    schemaVersion: 1, version: MUTATION_PROVENANCE_VERSION,
    recordId: `provenance.${identity}`, evidenceRef: `mutation.${identity}`,
    taskId: options.taskId, taskRunId: options.taskRunId,
    sessionIdentityHash: `sha256:${hash(`session\0${options.sessionId}`)}`,
    toolCallIdentityHash: core.toolCallIdentityHash,
    toolName: options.toolName, recordedAt: options.recordedAt, evidenceMode,
    beforeTreeDigest, afterTreeDigest, changes
  };
  const record = validateMutationProvenanceRecord({ ...payload, integrityDigest: mutationProvenanceDigest(payload) });
  const directory = evidenceDirectory(options.projectRoot, options.taskRunId);
  let existing = 0;
  try { existing = fs.readdirSync(resolveLocalStatePath(options.projectRoot, directory, { label: "Mutation provenance", kind: "directory" })).filter((file) => file.endsWith(".json")).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const target = path.join(directory, `${record.recordId}.json`);
  if (existing >= MAX_RECORDS && !fs.existsSync(target)) throw new Error("Mutation provenance record quota is exhausted");
  publishPrivate(options.projectRoot, target, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  return record;
}

export function readMutationProvenance(
  projectRoot: string,
  taskRunId: string
): { records: MutationProvenanceRecord[]; corruptions: string[] } {
  const directory = evidenceDirectory(projectRoot, taskRunId);
  let files: string[];
  try { files = fs.readdirSync(resolveLocalStatePath(projectRoot, directory, { label: "Mutation provenance", kind: "directory" })).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], corruptions: [] };
    return { records: [], corruptions: ["provenance-directory-unavailable"] };
  }
  if (files.length > MAX_RECORDS) return { records: [], corruptions: ["provenance-record-limit"] };
  const records: MutationProvenanceRecord[] = [], corruptions: string[] = [];
  for (const file of files) {
    try {
      const record = validateMutationProvenanceRecord(JSON.parse(readPrivate(projectRoot, path.join(directory, file)).toString("utf8")));
      if (file !== `${record.recordId}.json` || record.taskRunId !== taskRunId) throw new Error("identity mismatch");
      records.push(record);
    } catch { corruptions.push(`record.${hash(file)}`); }
  }
  return { records: corruptions.length ? [] : records.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)), corruptions };
}

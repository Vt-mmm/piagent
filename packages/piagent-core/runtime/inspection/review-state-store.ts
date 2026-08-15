import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { readTaskBaselineManifest, taskBaselineRetentionState } from "./source-evidence-store.ts";
import { REVIEW_EVIDENCE_VERSION, reviewDigest, reviewRecordDigest, validateReviewEvidenceRecord,
  type ReviewEvidenceRecord, type ReviewTarget } from "./review-state-contract.ts";

const MAX_RECORDS = 2_000;
const MAX_RECORD_BYTES = 64 * 1024;

export type AppendReviewEvidenceOptions = {
  projectRoot: string;
  taskId: string;
  taskRunId: string;
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  commandId: string;
  idempotencyKeyDigest: string;
  actionDigest: string;
  reviewState: "reviewed" | "unreviewed";
  target: ReviewTarget;
  requestedAt: string;
  recordedAt: string;
  observedRevisions: Record<string, string | null>;
};

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function directory(projectRoot: string, taskRunId: string): string {
  return path.join(projectRoot, ".pi", "piagent-state", "source-evidence", `run-${hash(taskRunId)}`, "reviews");
}

function readPrivate(projectRoot: string, file: string): Buffer {
  const safe = resolveLocalStatePath(projectRoot, file, { label: "Review evidence", kind: "file" });
  const descriptor = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("Review evidence record is oversized or not regular");
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function publishPrivate(projectRoot: string, target: string, content: Buffer): void {
  const parent = ensurePrivateStateDirectory(projectRoot, path.dirname(target), "Review evidence directory");
  const safeTarget = resolveLocalStatePath(projectRoot, target, { label: "Review evidence" });
  const temporary = path.join(parent, `${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); }
  finally { fs.closeSync(descriptor); }
  try { fs.linkSync(temporary, safeTarget); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readPrivate(projectRoot, safeTarget).equals(content)) throw new Error("Review evidence identity collision");
  } finally { fs.rmSync(temporary, { force: true }); }
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
}

export function appendReviewEvidence(options: AppendReviewEvidenceOptions): ReviewEvidenceRecord {
  const manifest = readTaskBaselineManifest(options.projectRoot, options.taskRunId);
  if (!manifest || manifest.taskId !== options.taskId || manifest.captureState !== "current"
    || taskBaselineRetentionState(manifest, new Date(options.recordedAt)) !== "active") throw new Error("review-baseline-unavailable");
  const identityDigest = reviewDigest({ taskRunId: options.taskRunId, commandId: options.commandId, actionDigest: options.actionDigest });
  const recordId = `review.${identityDigest.slice("sha256:".length)}`;
  const existing = readReviewEvidence(options.projectRoot, options.taskRunId);
  if (existing.corruptions.length) throw new Error("review-evidence-corrupt");
  const duplicate = existing.records.find((record) => record.recordId === recordId);
  if (duplicate) {
    if (duplicate.commandId === options.commandId && duplicate.idempotencyKeyDigest === options.idempotencyKeyDigest
      && duplicate.actionDigest === options.actionDigest && duplicate.reviewState === options.reviewState
      && JSON.stringify(duplicate.target) === JSON.stringify(options.target)) return duplicate;
    throw new Error("review-evidence-identity-collision");
  }
  if (existing.records.length >= MAX_RECORDS) throw new Error("review-evidence-quota-exhausted");
  const sequence = (existing.records.at(-1)?.sequence ?? 0) + 1;
  const payload: Omit<ReviewEvidenceRecord, "integrityDigest"> = {
    schemaVersion: 1, version: REVIEW_EVIDENCE_VERSION, recordId, evidenceRef: `review-evidence.${identityDigest.slice("sha256:".length)}`, sequence,
    taskId: options.taskId, taskRunId: options.taskRunId, projectRef: options.projectRef,
    runtimeInstanceId: options.runtimeInstanceId, sessionRef: options.sessionRef,
    commandId: options.commandId, idempotencyKeyDigest: options.idempotencyKeyDigest, actionDigest: options.actionDigest,
    reviewState: options.reviewState, target: structuredClone(options.target), requestedAt: options.requestedAt, recordedAt: options.recordedAt,
    retentionUntil: manifest.retentionUntil, observedRevisions: structuredClone(options.observedRevisions)
  };
  const record = validateReviewEvidenceRecord({ ...payload, integrityDigest: reviewRecordDigest(payload) });
  const root = directory(options.projectRoot, options.taskRunId);
  const target = path.join(root, `${record.recordId}.json`);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  if (bytes.length > MAX_RECORD_BYTES) throw new Error("review-evidence-record-oversized");
  publishPrivate(options.projectRoot, target, bytes);
  return record;
}

export function readReviewEvidence(projectRoot: string, taskRunId: string): { records: ReviewEvidenceRecord[]; corruptions: string[] } {
  const root = directory(projectRoot, taskRunId);
  let files: string[];
  try { files = fs.readdirSync(resolveLocalStatePath(projectRoot, root, { label: "Review evidence", kind: "directory" })).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], corruptions: [] };
    return { records: [], corruptions: ["review-evidence-directory-unavailable"] };
  }
  if (files.length > MAX_RECORDS) return { records: [], corruptions: ["review-evidence-record-limit"] };
  const records: ReviewEvidenceRecord[] = [], corruptions: string[] = [];
  for (const file of files) {
    try {
      const record = validateReviewEvidenceRecord(JSON.parse(readPrivate(projectRoot, path.join(root, file)).toString("utf8")));
      if (file !== `${record.recordId}.json` || record.taskRunId !== taskRunId) throw new Error("Review evidence identity mismatch");
      records.push(record);
    } catch { corruptions.push(`review.${hash(file)}`); }
  }
  return { records: corruptions.length ? [] : records.sort((left, right) => left.sequence - right.sequence), corruptions };
}

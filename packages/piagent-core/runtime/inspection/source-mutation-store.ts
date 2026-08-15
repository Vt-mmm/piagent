import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { canonicalReviewValue } from "./review-state-contract.ts";
import { validateSourceMutationTarget, type SourceMutationAction, type SourceMutationTarget } from "./source-mutation-projection.ts";
import { validateSourceRevertTarget, type SourceRevertTarget } from "./source-revert-projection.ts";
import { readTaskBaselineManifest, taskBaselineRetentionState } from "./source-evidence-store.ts";

const MAX_RECORDS = 4_000, MAX_RECORD_BYTES = 96 * 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/, DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, REVISION_KEYS = ["runtimeRevision", "taskRevision", "controlRevision",
  "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision"];
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

type AppendOptions = Omit<SourceMutationEvidenceRecord, "schemaVersion" | "version" | "recordId" | "evidenceRef" | "sequence" | "retentionUntil" | "integrityDigest"> & { projectRoot: string };

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function evidenceDigest(value: unknown): string { return `sha256:${sha(canonicalReviewValue(value))}`; }
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function directory(projectRoot: string, taskRunId: string): string {
  return path.join(projectRoot, ".pi", "piagent-state", "source-evidence", `run-${sha(taskRunId)}`, "source-actions");
}
function readPrivate(projectRoot: string, file: string): Buffer {
  const safe = resolveLocalStatePath(projectRoot, file, { label: "Source mutation evidence", kind: "file" });
  const descriptor = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("mutation-record-oversized");
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
function publish(projectRoot: string, target: string, bytes: Buffer): void {
  const parent = ensurePrivateStateDirectory(projectRoot, path.dirname(target), "Source mutation evidence directory");
  const safeTarget = resolveLocalStatePath(projectRoot, target, { label: "Source mutation evidence" });
  const temporary = path.join(parent, `${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); }
  finally { fs.closeSync(descriptor); }
  try { fs.linkSync(temporary, safeTarget); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readPrivate(projectRoot, safeTarget).equals(bytes)) throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function validateSourceMutationEvidence(value: unknown): SourceMutationEvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mutation-record-invalid");
  const record = value as SourceMutationEvidenceRecord;
  const keys = ["schemaVersion", "version", "recordId", "evidenceRef", "sequence", "phase", "resultCode", "projectRef", "runtimeInstanceId", "sessionRef",
    "taskId", "taskRunId", "commandId", "idempotencyKeyDigest", "actionDigest", "action", "target", "selectedHunkRefs", "failureCode", "requestedAt", "recordedAt", "retentionUntil",
    "beforeIndexPreimage", "afterIndexPreimage", "beforeWorkspacePreimage", "afterWorkspacePreimage", "observedRevisionsBefore", "observedRevisionsAfter", "integrityDigest"];
  if (canonicalReviewValue(Object.keys(record).sort()) !== canonicalReviewValue(keys.sort()) || record.schemaVersion !== 1
    || record.version !== SOURCE_MUTATION_EVIDENCE_VERSION || ![record.recordId, record.evidenceRef, record.projectRef, record.runtimeInstanceId,
      record.sessionRef, record.taskId, record.taskRunId, record.commandId].every((item) => REF.test(item))
    || !Number.isInteger(record.sequence) || record.sequence < 1 || record.sequence > MAX_RECORDS
    || ![record.idempotencyKeyDigest, record.actionDigest, record.beforeIndexPreimage, record.integrityDigest].every((item) => DIGEST.test(item))
    || !/^wt-content-v2:[a-f0-9]{64}$/.test(record.beforeWorkspacePreimage)
    || record.afterIndexPreimage !== null && !DIGEST.test(record.afterIndexPreimage)
    || record.afterWorkspacePreimage !== null && !/^wt-content-v2:[a-f0-9]{64}$/.test(record.afterWorkspacePreimage)
    || !Array.isArray(record.selectedHunkRefs) || record.selectedHunkRefs.length > 128
    || new Set(record.selectedHunkRefs).size !== record.selectedHunkRefs.length
    || record.selectedHunkRefs.some((item) => !REF.test(item) || !record.target.hunkRefs.includes(item))
    || ![record.requestedAt, record.recordedAt, record.retentionUntil].every(timestamp)
    || !(record.failureCode === null || /^[a-z][a-z0-9.-]{0,95}$/.test(record.failureCode))
    || !["source.stage", "source.unstage", "source.revert"].includes(record.action)) throw new Error("mutation-record-invalid");
  const settledResult = record.action === "source.stage" ? "staged" : record.action === "source.unstage" ? "unstaged" : "reverted";
  const phaseResult = { requested: "mutation-requested", settled: settledResult,
    rejected: "mutation-rejected", uncertain: "effect-unknown" }[record.phase];
  if (record.resultCode !== phaseResult || record.phase === "requested" && (record.afterIndexPreimage !== null || record.afterWorkspacePreimage !== null)
    || record.phase === "settled" && (!record.afterIndexPreimage || !record.afterWorkspacePreimage)
    || ["requested", "settled"].includes(record.phase) !== (record.failureCode === null)) throw new Error("mutation-record-phase-invalid");
  if (record.action === "source.revert") validateSourceRevertTarget(record.target); else validateSourceMutationTarget(record.target);
  for (const revisions of [record.observedRevisionsBefore, record.observedRevisionsAfter].filter(Boolean) as Array<Record<string, string | null>>) {
    if (canonicalReviewValue(Object.keys(revisions).sort()) !== canonicalReviewValue([...REVISION_KEYS].sort())
      || !REVISION.test(String(revisions.runtimeRevision ?? "")) || REVISION_KEYS.slice(1).some((key) => revisions[key] !== null && !REVISION.test(String(revisions[key]))))
      throw new Error("mutation-record-revisions-invalid");
  }
  if (record.phase === "requested" ? record.observedRevisionsAfter !== null : record.observedRevisionsAfter === null) throw new Error("mutation-record-revisions-invalid");
  const { integrityDigest, ...payload } = record;
  if (evidenceDigest(payload) !== integrityDigest) throw new Error("mutation-record-integrity-invalid");
  return structuredClone(record);
}

export function readSourceMutationEvidence(projectRoot: string, taskRunId: string): { records: SourceMutationEvidenceRecord[]; corruptions: string[] } {
  const root = directory(projectRoot, taskRunId);
  let files: string[];
  try { files = fs.readdirSync(resolveLocalStatePath(projectRoot, root, { label: "Source mutation evidence", kind: "directory" })).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { records: [], corruptions: [] } : { records: [], corruptions: ["mutation-evidence-directory-unavailable"] }; }
  if (files.length > MAX_RECORDS) return { records: [], corruptions: ["mutation-evidence-record-limit"] };
  const records: SourceMutationEvidenceRecord[] = [], corruptions: string[] = [];
  for (const file of files) try {
    const record = validateSourceMutationEvidence(JSON.parse(readPrivate(projectRoot, path.join(root, file)).toString("utf8")));
    if (file !== `${record.recordId}.json` || record.taskRunId !== taskRunId) throw new Error("mutation-record-identity-invalid");
    records.push(record);
  } catch { corruptions.push(`mutation.${sha(file)}`); }
  return { records: corruptions.length ? [] : records.sort((left, right) => left.sequence - right.sequence), corruptions };
}

export function appendSourceMutationEvidence(options: AppendOptions): SourceMutationEvidenceRecord {
  const manifest = readTaskBaselineManifest(options.projectRoot, options.taskRunId);
  if (!manifest || manifest.taskId !== options.taskId || manifest.captureState !== "current"
    || taskBaselineRetentionState(manifest, new Date(options.recordedAt)) !== "active") throw new Error("mutation-baseline-unavailable");
  const existing = readSourceMutationEvidence(options.projectRoot, options.taskRunId);
  if (existing.corruptions.length || existing.records.length >= MAX_RECORDS) throw new Error("mutation-evidence-unavailable");
  const identity = evidenceDigest({ commandId: options.commandId, actionDigest: options.actionDigest, phase: options.phase });
  const recordId = `mutation.${identity.slice(7)}`;
  const duplicate = existing.records.find((record) => record.recordId === recordId);
  if (duplicate) {
    const expected = { phase: options.phase, resultCode: options.resultCode, failureCode: options.failureCode, selectedHunkRefs: options.selectedHunkRefs,
      commandId: options.commandId, idempotencyKeyDigest: options.idempotencyKeyDigest,
      actionDigest: options.actionDigest, action: options.action, target: options.target, beforeIndexPreimage: options.beforeIndexPreimage,
      afterIndexPreimage: options.afterIndexPreimage, beforeWorkspacePreimage: options.beforeWorkspacePreimage,
      afterWorkspacePreimage: options.afterWorkspacePreimage, observedRevisionsBefore: options.observedRevisionsBefore,
      observedRevisionsAfter: options.observedRevisionsAfter };
    const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, (duplicate as any)[key]]));
    if (canonicalReviewValue(actual) !== canonicalReviewValue(expected)) throw new Error("mutation-evidence-identity-collision");
    return validateSourceMutationEvidence(duplicate);
  }
  const payload = { schemaVersion: 1 as const, version: SOURCE_MUTATION_EVIDENCE_VERSION, recordId, evidenceRef: `mutation-evidence.${identity.slice(7)}`,
    sequence: (existing.records.at(-1)?.sequence ?? 0) + 1, phase: options.phase, resultCode: options.resultCode, failureCode: options.failureCode,
    projectRef: options.projectRef, runtimeInstanceId: options.runtimeInstanceId, sessionRef: options.sessionRef, taskId: options.taskId,
    taskRunId: options.taskRunId, commandId: options.commandId, idempotencyKeyDigest: options.idempotencyKeyDigest, actionDigest: options.actionDigest,
    action: options.action, target: structuredClone(options.target), selectedHunkRefs: [...options.selectedHunkRefs], requestedAt: options.requestedAt, recordedAt: options.recordedAt,
    retentionUntil: manifest.retentionUntil, beforeIndexPreimage: options.beforeIndexPreimage, afterIndexPreimage: options.afterIndexPreimage,
    beforeWorkspacePreimage: options.beforeWorkspacePreimage, afterWorkspacePreimage: options.afterWorkspacePreimage,
    observedRevisionsBefore: structuredClone(options.observedRevisionsBefore), observedRevisionsAfter: structuredClone(options.observedRevisionsAfter) };
  const record = validateSourceMutationEvidence({ ...payload, integrityDigest: evidenceDigest(payload) });
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  if (bytes.length > MAX_RECORD_BYTES) throw new Error("mutation-record-oversized");
  publish(options.projectRoot, path.join(directory(options.projectRoot, options.taskRunId), `${record.recordId}.json`), bytes);
  return record;
}

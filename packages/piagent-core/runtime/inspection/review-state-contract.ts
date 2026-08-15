import { createHash } from "node:crypto";

export const REVIEW_EVIDENCE_VERSION = "piagent-webui-review-evidence-v1";

export type ReviewView = "task" | "working-tree" | "staged";
export type ReviewTarget = {
  view: ReviewView;
  fileRef: string;
  diffRef: string;
  taskRevision: string;
  workspaceRevision: string;
  indexRevision: string | null;
  viewRevision: string;
  fileRevision: string;
  baseDigest: string | null;
  currentDigest: string | null;
  patchPreimage: string;
  contentDigest: string;
};

export type ReviewEvidenceRecord = {
  schemaVersion: 1;
  version: typeof REVIEW_EVIDENCE_VERSION;
  recordId: string;
  evidenceRef: string;
  sequence: number;
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
  retentionUntil: string;
  observedRevisions: Record<string, string | null>;
  integrityDigest: string;
};

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION_KEYS = ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision",
  "approvalRevision", "sessionOptionRevision", "queueRevision"];

export function canonicalReviewValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReviewValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalReviewValue(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function reviewDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalReviewValue(value)).digest("hex")}`;
}

export function reviewRecordDigest(record: Omit<ReviewEvidenceRecord, "integrityDigest">): string {
  return reviewDigest(record);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validateReviewTarget(value: unknown): ReviewTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review target is invalid");
  const target = value as ReviewTarget;
  const keys = ["view", "fileRef", "diffRef", "taskRevision", "workspaceRevision", "indexRevision", "viewRevision", "fileRevision",
    "baseDigest", "currentDigest", "patchPreimage", "contentDigest"];
  if (canonicalReviewValue(Object.keys(target).sort()) !== canonicalReviewValue(keys.sort())
    || !["task", "working-tree", "staged"].includes(target.view) || !REF.test(target.fileRef) || !REF.test(target.diffRef)
    || ![target.taskRevision, target.workspaceRevision, target.viewRevision, target.fileRevision].every((item) => REVISION.test(item))
    || target.indexRevision !== null && !REVISION.test(target.indexRevision)
    || ![target.baseDigest, target.currentDigest].every((item) => item === null || DIGEST.test(item))
    || !DIGEST.test(target.patchPreimage) || target.contentDigest !== target.patchPreimage) throw new Error("Review target is invalid");
  return structuredClone(target);
}

export function validateReviewEvidenceRecord(value: unknown): ReviewEvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review evidence is invalid");
  const record = value as ReviewEvidenceRecord;
  const keys = ["schemaVersion", "version", "recordId", "evidenceRef", "sequence", "taskId", "taskRunId", "projectRef", "runtimeInstanceId", "sessionRef", "commandId",
    "idempotencyKeyDigest", "actionDigest", "reviewState", "target", "requestedAt", "recordedAt", "retentionUntil", "observedRevisions", "integrityDigest"];
  if (canonicalReviewValue(Object.keys(record).sort()) !== canonicalReviewValue(keys.sort()) || record.schemaVersion !== 1
    || record.version !== REVIEW_EVIDENCE_VERSION || ![record.recordId, record.evidenceRef, record.projectRef, record.runtimeInstanceId, record.sessionRef, record.commandId].every((item) => REF.test(item))
    || ![record.taskId, record.taskRunId].every((item) => PUBLIC_REF.test(item))
    || !Number.isInteger(record.sequence) || record.sequence < 1 || record.sequence > 2_000
    || ![record.idempotencyKeyDigest, record.actionDigest, record.integrityDigest].every((item) => DIGEST.test(item))
    || !["reviewed", "unreviewed"].includes(record.reviewState) || ![record.requestedAt, record.recordedAt, record.retentionUntil].every(timestamp)
    || Date.parse(record.requestedAt) > Date.parse(record.recordedAt) || Date.parse(record.recordedAt) >= Date.parse(record.retentionUntil)) {
    throw new Error("Review evidence is invalid");
  }
  validateReviewTarget(record.target);
  const revisions = record.observedRevisions;
  if (!revisions || typeof revisions !== "object" || Array.isArray(revisions)
    || canonicalReviewValue(Object.keys(revisions).sort()) !== canonicalReviewValue([...REVISION_KEYS].sort())
    || !REVISION.test(String(revisions.runtimeRevision ?? ""))
    || REVISION_KEYS.slice(1).some((key) => revisions[key] !== null && !REVISION.test(String(revisions[key])))) throw new Error("Review revisions are invalid");
  const { integrityDigest, ...payload } = record;
  if (reviewRecordDigest(payload) !== integrityDigest) throw new Error("Review evidence integrity mismatch");
  return structuredClone(record);
}

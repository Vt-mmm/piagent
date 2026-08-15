import type { DiffDocument } from "./diff-projection.ts";
import { canonicalReviewValue, reviewDigest, type ReviewEvidenceRecord, type ReviewTarget, type ReviewView } from "./review-state-contract.ts";
import type { WebUiIdentity } from "./source-change-projection.ts";

export type ReviewStateProjection = {
  schemaVersion: 1;
  version: "piagent-webui-review-state-v1";
  generatedAt: string;
  identity: WebUiIdentity;
  state: "reviewed" | "unreviewed" | "stale" | "unavailable";
  target: ReviewTarget | null;
  recordedState: "reviewed" | "unreviewed" | null;
  recordedAt: string | null;
  evidenceRef: string | null;
  reasonCode: string | null;
  health: { state: "ok" | "degraded" | "unavailable" | "error"; reasonCode: string | null; message: string | null };
};

type DeriveReviewTargetOptions = {
  diff: DiffDocument;
  taskId: string;
  taskRunId: string;
  taskRevision: string;
  workspaceRevision: string;
  indexRevision: string | null;
};

function targetCore(options: DeriveReviewTargetOptions): Omit<ReviewTarget, "diffRef" | "patchPreimage" | "contentDigest"> & { basisRef: string } {
  const diff = options.diff as Record<string, any>, file = diff.file as Record<string, any>, observed = diff.observed as Record<string, any>;
  return {
    view: diff.view as ReviewView, fileRef: String(file.fileRef), taskRevision: options.taskRevision,
    workspaceRevision: options.workspaceRevision, indexRevision: options.indexRevision,
    viewRevision: String(observed.viewRevision), fileRevision: String(observed.fileRevision),
    baseDigest: observed.baseDigest ?? null, currentDigest: observed.currentDigest ?? null,
    basisRef: String(diff.basis?.basisRef ?? file.basisRef)
  };
}

export function deriveReviewTarget(options: DeriveReviewTargetOptions): ReviewTarget | null {
  const diff = options.diff as Record<string, any>;
  if (!options.taskId || !options.taskRunId || !options.taskRevision || !options.workspaceRevision
    || diff.availability?.state !== "current" || diff.fallback?.kind !== "none"
    || diff.truncation?.truncated !== false || diff.redaction?.applied !== false || diff.redaction?.truncated !== false
    || diff.file?.status === "C" || diff.file?.content?.kind !== "text" || diff.file?.content?.access !== "available") return null;
  const core = targetCore(options), preimage = reviewDigest({ schemaVersion: 1, taskId: options.taskId, taskRunId: options.taskRunId, ...core });
  return { view: core.view, fileRef: core.fileRef, diffRef: `diff.${preimage.slice("sha256:".length)}`, taskRevision: core.taskRevision,
    workspaceRevision: core.workspaceRevision, indexRevision: core.indexRevision, viewRevision: core.viewRevision,
    fileRevision: core.fileRevision, baseDigest: core.baseDigest, currentDigest: core.currentDigest,
    patchPreimage: preimage, contentDigest: preimage };
}

function sameTarget(left: ReviewTarget, right: ReviewTarget): boolean {
  return canonicalReviewValue(left) === canonicalReviewValue(right);
}

export function projectReviewState(options: {
  identity: WebUiIdentity;
  target: ReviewTarget | null;
  records: ReviewEvidenceRecord[];
  corruptions?: string[];
  generatedAt?: string;
  unavailableReason?: string;
}): ReviewStateProjection {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const base = { schemaVersion: 1 as const, version: "piagent-webui-review-state-v1" as const, generatedAt,
    identity: structuredClone(options.identity) };
  if (options.corruptions?.length) return { ...base, state: "unavailable", target: null, recordedState: null, recordedAt: null,
    evidenceRef: null, reasonCode: "review-evidence-corrupt", health: { state: "error", reasonCode: "review-evidence-corrupt", message: "Review evidence is corrupt" } };
  if (!options.target) {
    const reasonCode = options.unavailableReason ?? "review-target-unavailable";
    return { ...base, state: "unavailable", target: null, recordedState: null, recordedAt: null, evidenceRef: null, reasonCode,
      health: { state: "unavailable", reasonCode, message: "The exact review target is unavailable" } };
  }
  const relevant = options.records.filter((record) => record.taskId === options.identity.taskId && record.taskRunId === options.identity.taskRunId
    && record.target.view === options.target!.view && record.target.fileRef === options.target!.fileRef);
  const latest = relevant.at(-1);
  if (!latest) return { ...base, state: "unreviewed", target: structuredClone(options.target), recordedState: null, recordedAt: null,
    evidenceRef: null, reasonCode: null, health: { state: "ok", reasonCode: null, message: null } };
  if (!sameTarget(latest.target, options.target)) {
    const priorReviewed = [...relevant].reverse().find((record) => record.reviewState === "reviewed");
    if (priorReviewed) return { ...base, state: "stale", target: structuredClone(options.target), recordedState: "reviewed",
      recordedAt: priorReviewed.recordedAt, evidenceRef: priorReviewed.evidenceRef, reasonCode: "review-target-changed",
      health: { state: "degraded", reasonCode: "review-target-changed", message: "The file or diff changed after it was reviewed" } };
    return { ...base, state: "unreviewed", target: structuredClone(options.target), recordedState: null, recordedAt: null,
      evidenceRef: null, reasonCode: null, health: { state: "ok", reasonCode: null, message: null } };
  }
  if (latest.reviewState === "unreviewed") return { ...base, state: "unreviewed", target: structuredClone(options.target),
    recordedState: "unreviewed", recordedAt: latest.recordedAt, evidenceRef: latest.evidenceRef, reasonCode: null,
    health: { state: "ok", reasonCode: null, message: null } };
  return { ...base, state: "reviewed", target: structuredClone(options.target), recordedState: "reviewed",
    recordedAt: latest.recordedAt, evidenceRef: latest.evidenceRef, reasonCode: null,
    health: { state: "ok", reasonCode: null, message: null } };
}

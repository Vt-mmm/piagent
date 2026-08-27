import type { FileChange, PiagentWebUISourceChangeViewV1, View } from "../../contracts/generated/source-change-v1.ts";
import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIBoundedFileDiffV1 } from "../../contracts/generated/diff-v1.ts";

export const sourceTabs: Array<{ view: View; label: string; shortLabel: string }> = [
  { view: "task", label: "Thay đổi của task", shortLabel: "Task" },
  { view: "working-tree", label: "Toàn bộ working tree", shortLabel: "Working Tree" },
  { view: "staged", label: "Đã chuẩn bị commit", shortLabel: "Staged" }
];

export function localizedSourceTabs(locale: "vi" | "en") {
  if (locale === "vi") return sourceTabs;
  return [
    { view: "task" as const, label: "Task Changes", shortLabel: "Task" },
    { view: "working-tree" as const, label: "Full Working Tree", shortLabel: "Working Tree" },
    { view: "staged" as const, label: "Staged Changes", shortLabel: "Staged" }
  ];
}

const provenance: Record<FileChange["provenance"]["classification"], string> = {
  "pre-existing-user": "Có sẵn trước task",
  "runtime-observed-agent": "Pi runtime đã chạm",
  "post-baseline-unattributed": "Thay đổi sau baseline · chưa rõ nguồn",
  mixed: "Trộn thay đổi người dùng và runtime"
};

export function provenanceLabel(file: FileChange, locale: "vi" | "en" = "vi"): string {
  if (locale === "vi") return provenance[file.provenance.classification];
  return ({ "pre-existing-user": "Pre-existing user change", "runtime-observed-agent": "Runtime-observed agent touch",
    "post-baseline-unattributed": "Post-baseline · unattributed", mixed: "Mixed user and runtime change" })[file.provenance.classification];
}

export function fileStats(file: FileChange, locale: "vi" | "en" = "vi"): string {
  if (file.stats.state !== "exact") return locale === "vi" ? "Dòng thay đổi chưa xác định" : "Line changes unavailable";
  return `+${file.stats.additions ?? 0}  −${file.stats.deletions ?? 0}`;
}

export function sourceSummary(document: PiagentWebUISourceChangeViewV1, locale: "vi" | "en" = "vi"): string {
  const total = document.page.total;
  if (document.availability.state === "stale") return locale === "vi" ? "Đang đồng bộ lại…" : "Resynchronizing…";
  if (document.availability.state === "unavailable") return document.availability.message ?? (locale === "vi" ? "Nguồn thay đổi chưa sẵn sàng" : "Source changes unavailable");
  if (total === 0) return locale === "vi" ? "Không có file thay đổi" : "No changed files";
  return locale === "vi" ? `${total} file${document.page.truncated ? " · danh sách đã rút gọn" : ""}`
    : `${total} file${total === 1 ? "" : "s"}${document.page.truncated ? " · list truncated" : ""}`;
}

export function relatedEvidence(file: FileChange, locale: "vi" | "en" = "vi"): string {
  return locale === "vi" ? `${file.criterionIds.length} tiêu chí · ${file.verifierAttemptIds.length} verifier`
    : `${file.criterionIds.length} criteria · ${file.verifierAttemptIds.length} verifiers`;
}

export type SourceSnapshotBinding = { sourceProjectionRevision: string | null; taskViewRevision: string | null;
  workspaceRevision: string | null; indexRevision: string | null };
export type SourceDocumentIdentity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string | null; taskRunId: string | null };

export function sourceSnapshotRevisionKey(binding: SourceSnapshotBinding, identity: SourceDocumentIdentity): string {
  return [identity.projectRef, identity.runtimeInstanceId, identity.sessionRef, identity.taskId ?? "no-task", identity.taskRunId ?? "no-run",
    binding.sourceProjectionRevision ?? "no-source-projection-revision", binding.taskViewRevision ?? "no-task-view-revision",
    binding.workspaceRevision ?? "no-workspace-revision",
    binding.indexRevision ?? "no-index-revision"].join("\u001e");
}

export function sourceDocumentMatchesSnapshot(document: PiagentWebUISourceChangeViewV1 | undefined,
  expectedView: View, expectedBinding: SourceSnapshotBinding, expectedIdentity: SourceDocumentIdentity): boolean {
  if (!document || document.view !== expectedView || document.availability.state === "stale") return false;
  const identityMatches = document.identity.projectRef === expectedIdentity.projectRef
    && document.identity.runtimeInstanceId === expectedIdentity.runtimeInstanceId && document.identity.sessionRef === expectedIdentity.sessionRef
    && document.identity.taskId === expectedIdentity.taskId && document.identity.taskRunId === expectedIdentity.taskRunId;
  if (!identityMatches) return false;
  const expectedViewRevision = expectedView === "task" ? expectedBinding.taskViewRevision
    : expectedView === "working-tree" ? expectedBinding.workspaceRevision : expectedBinding.indexRevision;
  const viewMatches = expectedViewRevision === null ? document.availability.state === "unavailable"
    : document.viewRevision === expectedViewRevision;
  if (!viewMatches) return false;
  const binding = document.snapshotBinding;
  if (!binding) return expectedBinding.sourceProjectionRevision === null;
  return expectedBinding.sourceProjectionRevision !== null
    && binding.sourceProjectionRevision === expectedBinding.sourceProjectionRevision
    && binding.taskViewRevision === expectedBinding.taskViewRevision
    && binding.workspaceRevision === expectedBinding.workspaceRevision && binding.indexRevision === expectedBinding.indexRevision;
}

type SourceDetailAvailability = { state: string; reasonCode: string | null; target: unknown | null };

export function sourceDetailUnavailableNeedsRecovery(value: SourceDetailAvailability | undefined,
  diff?: PiagentWebUIBoundedFileDiffV1): boolean {
  if (!value || value.state !== "unavailable" || value.target !== null || !value.reasonCode) return false;
  const exactCurrentDiff = diff?.availability.state === "current" && diff.fallback.kind === "none";
  if (value.reasonCode === "review-target-unavailable") return exactCurrentDiff;
  if (value.reasonCode === "no-unstaged-change" || value.reasonCode === "no-staged-change")
    return exactCurrentDiff && diff.hunks.length > 0;
  return ["-target-stale", "-preview-incomplete", "-preimage-unavailable", "-authority-unavailable"]
    .some((suffix) => value.reasonCode!.endsWith(suffix));
}

export function currentSourceDocument(document: PiagentWebUISourceChangeViewV1 | undefined,
  requestedRevisions: string | undefined, currentRevisions: string, expectedBinding: SourceSnapshotBinding,
  expectedIdentity: SourceDocumentIdentity, expectedView: View): PiagentWebUISourceChangeViewV1 | null {
  return requestedRevisions === currentRevisions && sourceDocumentMatchesSnapshot(document, expectedView, expectedBinding, expectedIdentity)
    ? document ?? null : null;
}

export function sourceDiffMatchesSnapshot(value: PiagentWebUIBoundedFileDiffV1 | undefined, view: View, fileRef: string,
  viewRevision: string, fileRevision: string, snapshot: PiagentWebUICanonicalSnapshotV1): boolean {
  const identity = value?.identity;
  return Boolean(value && identity && identity.projectRef === snapshot.identity.projectRef
    && identity.runtimeInstanceId === snapshot.identity.runtimeInstanceId && identity.sessionRef === snapshot.identity.sessionRef
    && identity.taskId === snapshot.identity.taskId && identity.taskRunId === snapshot.identity.taskRunId
    && value.view === view && value.file.fileRef === fileRef && value.file.fileRevision === fileRevision
    && value.precondition.expectedViewRevision === viewRevision && value.precondition.expectedFileRevision === fileRevision
    && value.observed.viewRevision === viewRevision && value.observed.fileRevision === fileRevision
    && value.availability.state !== "stale" && value.fallback.kind !== "stale");
}

// Which file the diff pane is showing. Selection is derived from the list that
// is actually loaded rather than remembered beside it: the workspace clears the
// remembered ref from several places, and a clear that landed after the list had
// loaded left the pane asking the reader to pick a file while the list beside it
// held exactly one. Falling back to the first file is what the reader would do,
// so no later clear can produce that state again.
export function activeFileRef(files: FileChange[], remembered: string | null): string | null {
  if (remembered && files.some((file) => file.fileRef === remembered)) return remembered;
  return files[0]?.fileRef ?? null;
}

export function nextSourceView(current: View, key: "ArrowLeft" | "ArrowRight" | "Home" | "End"): View {
  const index = sourceTabs.findIndex((tab) => tab.view === current);
  if (key === "Home") return sourceTabs[0].view;
  if (key === "End") return sourceTabs.at(-1)!.view;
  const offset = key === "ArrowRight" ? 1 : -1;
  return sourceTabs[(index + offset + sourceTabs.length) % sourceTabs.length].view;
}

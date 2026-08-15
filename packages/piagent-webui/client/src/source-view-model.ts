import type { FileChange, PiagentWebUISourceChangeViewV1, View } from "../../contracts/generated/source-change-v1.ts";

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
  if (document.availability.state === "unavailable") return document.availability.message ?? (locale === "vi" ? "Nguồn thay đổi chưa sẵn sàng" : "Source changes unavailable");
  if (total === 0) return locale === "vi" ? "Không có file thay đổi" : "No changed files";
  return locale === "vi" ? `${total} file${document.page.truncated ? " · danh sách đã rút gọn" : ""}`
    : `${total} file${total === 1 ? "" : "s"}${document.page.truncated ? " · list truncated" : ""}`;
}

export function relatedEvidence(file: FileChange, locale: "vi" | "en" = "vi"): string {
  return locale === "vi" ? `${file.criterionIds.length} tiêu chí · ${file.verifierAttemptIds.length} verifier`
    : `${file.criterionIds.length} criteria · ${file.verifierAttemptIds.length} verifiers`;
}

export function nextSourceView(current: View, key: "ArrowLeft" | "ArrowRight" | "Home" | "End"): View {
  const index = sourceTabs.findIndex((tab) => tab.view === current);
  if (key === "Home") return sourceTabs[0].view;
  if (key === "End") return sourceTabs.at(-1)!.view;
  const offset = key === "ArrowRight" ? 1 : -1;
  return sourceTabs[(index + offset + sourceTabs.length) % sourceTabs.length].view;
}

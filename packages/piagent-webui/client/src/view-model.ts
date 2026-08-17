import type { Criterion, PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";

export type Tone = "positive" | "warning" | "danger" | "neutral" | "info";

const statusLabelsVi: Record<string, string> = {
  active: "Đang hoạt động", "pause-requested": "Đang yêu cầu tạm dừng", paused: "Đã tạm dừng", terminal: "Đã kết thúc",
  idle: "Đang chờ", running: "Đang chạy", stopping: "Đang dừng", settled: "Đã ổn định", unknown: "Chưa xác định",
  pending: "Chưa xong", completed: "Hoàn thành", blocked: "Bị chặn", partial: "Một phần", failed: "Thất bại",
  satisfied: "Đã đạt", unavailable: "Không có dữ liệu", connected: "Đã kết nối", disconnected: "Mất kết nối",
  reconnecting: "Đang kết nối lại", "resync-required": "Cần đồng bộ lại", none: "Không có", waiting: "Đang chờ duyệt",
  current: "Mới nhất", stale: "Đã cũ", "not-run": "Chưa chạy", "in-progress": "Đang làm", done: "Đã xong",
  skipped: "Bỏ qua", resume: "Tiếp tục", retry: "Thử lại", observed: "Đã ghi nhận", requested: "Đã yêu cầu",
  "possible-interruption": "Có thể bị gián đoạn", complete: "Đầy đủ", "aggregate-only": "Chỉ có dữ liệu tổng hợp",
  off: "Tắt", minimal: "Tối thiểu", low: "Thấp", medium: "Trung bình", high: "Cao", xhigh: "Rất cao", max: "Tối đa",
  orphaned: "Mất owner", cancelled: "Đã hủy", succeeded: "Thành công", "stale-result": "Kết quả đến muộn",
  accepted: "Đã nhận", rejected: "Không nhận", "not-recorded": "Chưa có kết quả", parent: "Task cha", helper: "Helper",
  "read-only": "Chỉ đọc", "workspace-write": "Ghi trong project", "trusted-full-access": "Toàn quyền", "single-writer": "Một writer", retriever: "Truy xuất", scout: "Khảo sát", planner: "Lập kế hoạch",
  worker: "Thực thi", reviewer: "Rà soát", oracle: "Đối chứng", researcher: "Nghiên cứu", ready: "Sẵn sàng",
  missing: "Chưa có bằng chứng", interrupted: "Bị gián đoạn", stopped: "Đã dừng", aborted: "Đã hủy do lỗi",
  incomplete: "Chưa có kết luận", passed: "Đạt", "not-applicable": "Không áp dụng", smoke: "Smoke",
  "public-regression": "Public regression", capability: "Capability", "private-holdout": "Private holdout", "production-shadow": "Production shadow",
  "pdf-converter-unavailable": "Host chưa cài pdftotext (poppler) nên chưa đọc được .pdf",
  "pdf-text-unavailable": "PDF này không có text bóc được; nhiều khả năng là bản scan, cần OCR trước",
  "pdf-extraction-failed": "Không chuyển được PDF này sang text",
  "docx-unreadable": "File .docx này hỏng, bị mã hóa, hoặc không phải file Word thật",
  "document-text-empty": "Tài liệu không có chữ nào để đọc",
  "document-size-limit": "Tài liệu vượt giới hạn dung lượng",
  "text-size-limit": "File text vượt giới hạn dung lượng",
  "text-content-invalid": "File có đuôi text nhưng nội dung không phải text",
  "image-mime-mismatch": "Nội dung ảnh không khớp với đuôi file",
  "model-image-input-unavailable": "Model hiện tại không nhận ảnh",
  "attachment-capacity-limit": "Đã chạm giới hạn số file hoặc dung lượng đính kèm",
  "no-readable-root": "Chưa có thư mục nào đọc được",
  "document-roots-unavailable": "Không xác định được thư mục tài liệu",
  "document-not-listed": "Tài liệu không còn trong danh sách; hãy tải lại",
  "document-unavailable": "Không mở được tài liệu này",
  "document-protected": "Tài liệu nằm trong protectedPaths nên không được đọc",
  "document-changed": "File đã thay đổi sau khi liệt kê; chưa đọc gì cả",
  "document-unreadable": "Không đọc được nội dung tài liệu",
  "document-needs-ocr": "Tài liệu là bản scan, cần OCR trước khi đọc được chữ",
  "document-converter-unavailable": "Host chưa cài pdftotext (poppler) nên chưa đọc được .pdf"
};

const statusLabelsEn: Record<string, string> = {
  active: "Active", "pause-requested": "Pause requested", paused: "Paused", terminal: "Finished",
  idle: "Idle", running: "Running", stopping: "Stopping", settled: "Settled", unknown: "Unknown",
  pending: "Pending", completed: "Completed", blocked: "Blocked", partial: "Partial", failed: "Failed",
  satisfied: "Satisfied", unavailable: "Unavailable", connected: "Connected", disconnected: "Disconnected",
  reconnecting: "Reconnecting", "resync-required": "Resync required", none: "None", waiting: "Awaiting approval",
  current: "Current", stale: "Stale", "not-run": "Not run", "in-progress": "In progress", done: "Done",
  skipped: "Skipped", resume: "Resume", retry: "Retry", observed: "Observed", requested: "Requested",
  "possible-interruption": "Possible interruption", complete: "Complete", "aggregate-only": "Aggregate only",
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum",
  orphaned: "Owner missing", cancelled: "Cancelled", succeeded: "Succeeded", "stale-result": "Stale result",
  accepted: "Accepted", rejected: "Rejected", "not-recorded": "Not recorded", parent: "Parent task", helper: "Helper",
  "read-only": "Read only", "workspace-write": "Workspace write", "trusted-full-access": "Full access", "single-writer": "Single writer", retriever: "Retriever", scout: "Scout", planner: "Planner",
  worker: "Worker", reviewer: "Reviewer", oracle: "Oracle", researcher: "Researcher", ready: "Ready",
  missing: "Evidence missing", interrupted: "Interrupted", stopped: "Stopped", aborted: "Aborted",
  incomplete: "Incomplete", passed: "Passed", "not-applicable": "Not applicable", smoke: "Smoke",
  "public-regression": "Public regression", capability: "Capability", "private-holdout": "Private holdout", "production-shadow": "Production shadow",
  "pdf-converter-unavailable": "This host has no pdftotext (poppler), so .pdf cannot be read",
  "pdf-text-unavailable": "This PDF holds no extractable text; it is probably scanned and needs OCR first",
  "pdf-extraction-failed": "The PDF could not be converted to text",
  "docx-unreadable": "This .docx is corrupt, encrypted, or not really a Word document",
  "document-text-empty": "The document contains no readable text",
  "document-size-limit": "The document is over the size limit",
  "text-size-limit": "The text file is over the size limit",
  "text-content-invalid": "The file has a text extension but its bytes are not text",
  "image-mime-mismatch": "The image content does not match its file extension",
  "model-image-input-unavailable": "The current model does not accept images",
  "attachment-capacity-limit": "The attachment count or size limit was reached",
  "no-readable-root": "No readable directory is available",
  "document-roots-unavailable": "The document directories could not be resolved",
  "document-not-listed": "The document is no longer listed; reload the list",
  "document-unavailable": "This document could not be opened",
  "document-protected": "The document is under protectedPaths and is not readable",
  "document-changed": "The file changed after it was listed; nothing was read",
  "document-unreadable": "The document content could not be read",
  "document-needs-ocr": "The document is scanned and needs OCR before it holds text",
  "document-converter-unavailable": "This host has no pdftotext (poppler), so .pdf cannot be read"
};

export function label(value: string | null | undefined, locale: "vi" | "en" = "vi"): string {
  if (!value) return locale === "vi" ? "Chưa có" : "Not available";
  return (locale === "vi" ? statusLabelsVi : statusLabelsEn)[value] ?? value.replaceAll("-", " ");
}

export function tone(value: string | null | undefined): Tone {
  if (["completed", "satisfied", "current", "connected", "done", "passed"].includes(value ?? "")) return "positive";
  if (["blocked", "failed", "error", "expired"].includes(value ?? "")) return "danger";
  if (["pause-requested", "paused", "waiting", "stale", "stale-result", "orphaned", "partial", "reconnecting"].includes(value ?? "")) return "warning";
  if (["running", "active", "in-progress"].includes(value ?? "")) return "info";
  return "neutral";
}

export function compactRef(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-7)}` : value;
}

export function modelName(snapshot: PiagentWebUICanonicalSnapshotV1, locale: "vi" | "en" = "vi"): string {
  return snapshot.session.model.state === "known" && snapshot.session.model.value
    ? snapshot.session.model.value.displayName
    : locale === "vi" ? "Model chưa xác định" : "Unknown model";
}

export function thinkingName(snapshot: PiagentWebUICanonicalSnapshotV1, locale: "vi" | "en" = "vi"): string {
  return snapshot.session.thinking.state === "known" && snapshot.session.thinking.value
    ? label(snapshot.session.thinking.value, locale)
    : locale === "vi" ? "Chưa xác định" : "Unknown";
}

export function permissionName(snapshot: PiagentWebUICanonicalSnapshotV1, locale: "vi" | "en" = "vi"): string {
  const fact = snapshot.session.permissionProfile as { state?: string; value?: string };
  return fact.state === "known" && fact.value ? label(fact.value, locale) : locale === "vi" ? "Quyền chưa xác định" : "Unknown permission";
}

export function criterionMeta(criterion: Criterion, locale: "vi" | "en" = "vi"): string {
  const files = criterion.relatedFileRefs.length;
  const verifiers = criterion.verifierAttemptRefs.length;
  if (!files && !verifiers) return locale === "vi" ? "Chưa có bằng chứng liên kết" : "No linked evidence";
  return locale === "vi" ? `${files} file · ${verifiers} lần kiểm tra` : `${files} files · ${verifiers} verifier runs`;
}

export function taskProgress(snapshot: PiagentWebUICanonicalSnapshotV1, locale: "vi" | "en" = "vi") {
  const task = snapshot.task;
  return task ? {
    completed: task.progress.completed,
    total: task.progress.total,
    percent: Math.max(0, Math.min(100, task.progress.percent)),
    text: locale === "vi" ? `${task.progress.completed}/${task.progress.total} tiêu chí` : `${task.progress.completed}/${task.progress.total} criteria`
  } : { completed: 0, total: 0, percent: 0, text: locale === "vi" ? "Chưa có task đang chạy" : "No active task" };
}

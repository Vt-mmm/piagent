import type { Activity } from "../../contracts/generated/snapshot-v1.ts";
import type { TerminalOperationActivity } from "./live-state-view-model.ts";

export function terminalOperationActivityRow(activity: TerminalOperationActivity, locale: "vi" | "en" = "vi"): Activity {
  const label = activity.state === "failed" ? (locale === "vi" ? "Lượt chạy gặp lỗi" : "Operation failed")
    : activity.state === "blocked" ? (locale === "vi" ? "Lượt chạy bị chặn" : "Operation blocked")
      : activity.state === "aborted" ? (locale === "vi" ? "Lượt chạy đã dừng" : "Operation stopped")
        : (locale === "vi" ? "Chưa xác định kết quả lượt chạy" : "Operation outcome unknown");
  return { activityRef: activity.activityRef, kind: "system", state: activity.state, label, preview: activity.reasonCode,
    toolCallId: null, toolName: null, commandDigest: null, logRef: null, exitCode: null, exitCodeExact: false,
    startedAt: activity.settledAt, finishedAt: activity.settledAt };
}

export function mergeActivityRows(running: readonly Activity[], recent: readonly Activity[],
  terminal: readonly TerminalOperationActivity[], locale: "vi" | "en" = "vi"): { rows: Activity[]; terminalCount: number } {
  const canonical = [...running, ...recent], canonicalRefs = new Set(canonical.map((activity) => activity.activityRef));
  const overlay = terminal.filter((activity) => !canonicalRefs.has(activity.activityRef))
    .map((activity) => terminalOperationActivityRow(activity, locale));
  return { rows: [...running, ...overlay, ...recent], terminalCount: overlay.length };
}

export function activityResult(activity: Activity, locale: "vi" | "en" = "vi"): string {
  if (activity.state === "passed" && / recovered$/i.test(activity.label)) return locale === "vi" ? "Đã khôi phục" : "Recovered";
  if (activity.state === "passed" && / warning$/i.test(activity.label)) return locale === "vi" ? "Đã xử lý cảnh báo" : "Handled warning";
  if (activity.state === "passed" && activity.exitCodeExact) return `Pass · exit ${activity.exitCode ?? 0}`;
  if (activity.state === "failed" && activity.exitCodeExact) return `Fail · exit ${activity.exitCode ?? "?"}`;
  if (activity.state === "blocked") return "Blocked";
  if (activity.state === "aborted") return locale === "vi" ? "Đã dừng" : "Stopped";
  if (activity.state === "unknown") return locale === "vi" ? "Chưa xác định" : "Unknown";
  if (activity.state === "failed") return locale === "vi" ? "Thất bại" : "Failed";
  if (activity.state === "running") return locale === "vi" ? "Đang chạy" : "Running";
  return activity.state.replaceAll("-", " ");
}

export function activityTime(activity: Activity, locale: "vi" | "en" = "vi"): string {
  const start = Date.parse(activity.startedAt);
  const end = activity.finishedAt ? Date.parse(activity.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return locale === "vi" ? "Thời gian chưa xác định" : "Unknown duration";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

import type { Activity } from "../../contracts/generated/snapshot-v1.ts";

export function activityResult(activity: Activity, locale: "vi" | "en" = "vi"): string {
  if (activity.state === "passed" && activity.exitCodeExact) return `Pass · exit ${activity.exitCode ?? 0}`;
  if (activity.state === "failed" && activity.exitCodeExact) return `Fail · exit ${activity.exitCode ?? "?"}`;
  if (activity.state === "blocked") return "Blocked";
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

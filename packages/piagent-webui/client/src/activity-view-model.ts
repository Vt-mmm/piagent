import type { Activity } from "../../contracts/generated/snapshot-v1.ts";
import type { TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import type { LiveActivity, TerminalOperationActivity } from "./live-state-view-model.ts";

export function liveActivityRow(activity: LiveActivity, locale: "vi" | "en" = "vi"): Activity {
  const state: Activity["state"] = activity.state === "running" ? "running" : activity.state === "failed" ? "failed" : "passed";
  const suffix = state === "running" ? (locale === "vi" ? "đang chạy" : "running")
    : state === "failed" ? (locale === "vi" ? "thất bại" : "failed") : (locale === "vi" ? "hoàn tất" : "completed");
  const startedAt = activity.startedAt ?? activity.finishedAt ?? "";
  return { activityRef: `live.${activity.toolCallRef}`, kind: ["bash", "shell", "exec"].includes(activity.toolLabel) ? "command" : "tool",
    state, label: `${activity.agent ? `${activity.agent} · ` : ""}${activity.toolLabel} ${suffix}`, preview: activity.detail ?? activity.fileLabel ?? (locale === "vi" ? "Cập nhật trực tiếp từ Gateway" : "Live update from the Gateway"),
    toolCallId: activity.toolCallRef, toolName: activity.toolLabel, commandDigest: null, logRef: null, exitCode: null,
    exitCodeExact: false, startedAt, finishedAt: state === "running" ? null : activity.finishedAt ?? startedAt };
}

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
  terminal: readonly TerminalOperationActivity[], locale: "vi" | "en" = "vi", liveActivities?: readonly LiveActivity[]): {
    rows: Activity[]; terminalCount: number; runningCount: number } {
  const canonical = [...running, ...recent], canonicalRefs = new Set(canonical.map((activity) => activity.activityRef));
  const overlay = terminal.filter((activity) => !canonicalRefs.has(activity.activityRef))
    .map((activity) => terminalOperationActivityRow(activity, locale));
  if (liveActivities === undefined) return { rows: [...running, ...overlay, ...recent], terminalCount: overlay.length,
    runningCount: running.length };
  // While Gateway live state is present it is the authoritative volatile
  // boundary. Snapshot Activity remains canonical history, but a stale running
  // row must not survive a matching tool.completed frame.
  const liveRunning = liveActivities.filter((activity) => activity.state === "running")
    .map((activity) => liveActivityRow(activity, locale));
  // Settled live events are intentionally not rendered as history: their
  // opaque Gateway refs cannot be matched to the durable session tool ids.
  // The canonical snapshot owns settled rows and replaces this short-lived
  // overlay on the next bounded Activity refresh.
  return { rows: [...liveRunning, ...overlay, ...recent], terminalCount: overlay.length,
    runningCount: liveRunning.length };
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

export type LogStep = { key: string; toolName: string; target: string | null; state: "running" | "completed" | "failed"; at: string };
export type LogGroup = { agent: string; steps: LogStep[]; total: number };

// Who did what, newest first: the main agent's calls from its transcript, each
// subagent's from its saved run, plus the steps of the turn still running.
export function activityLogGroups(items: readonly TranscriptItem[], live: readonly LiveActivity[] = []): LogGroup[] {
  const groups = new Map<string, LogGroup>([["main", { agent: "main", steps: [], total: 0 }]]);
  const group = (agent: string) => { const found = groups.get(agent); if (found) return found; const made = { agent, steps: [], total: 0 }; groups.set(agent, made); return made; };
  for (const item of items) {
    if (item.helperRun) {
      const target = group(item.helperRun.agent);
      target.total += item.helperRun.total;
      target.steps.push(...item.helperRun.steps.map((step, index) => ({ key: `${item.messageRef}:${index}`, toolName: step.toolName, target: step.target, state: "completed" as const, at: step.at })));
      continue;
    }
    if (item.role !== "assistant") continue;
    const main = group("main");
    for (const tool of item.toolCalls) {
      main.total += 1;
      main.steps.push({ key: `${item.messageRef}:${tool.toolCallRef}`, toolName: tool.toolName, target: tool.summary?.target ?? tool.summary?.detail ?? null,
        state: tool.state === "failed" || tool.result?.isError ? "failed" : "completed", at: item.recordedAt });
    }
  }
  // The main agent's finished live steps reach it through the transcript; a
  // running subagent's are nowhere else until it ends.
  for (const activity of live) {
    if (!activity.agent || activity.state === "running") continue;
    const target = group(activity.agent);
    target.total += 1;
    target.steps.push({ key: activity.toolCallRef, toolName: activity.toolLabel, target: activity.detail ?? null, state: activity.state, at: activity.startedAt ?? "" });
  }
  for (const value of groups.values()) value.steps.sort((a, b) => b.at.localeCompare(a.at));
  return [...groups.values()].filter((value) => value.steps.length > 0);
}

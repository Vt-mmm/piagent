import type { ContextUsage, PiagentWebUICanonicalSnapshotV1, UsageCounter, VerifierAttempt } from "../../contracts/generated/snapshot-v1.ts";

export function compactNumber(value: number | null, locale: "vi" | "en" = "vi"): string {
  if (value === null || !Number.isFinite(value)) return locale === "vi" ? "Không có dữ liệu" : "No data";
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function contextLabel(context: ContextUsage, locale: "vi" | "en" = "vi"): string {
  if (context.state !== "known" || context.tokens === null || context.percent === null) return locale === "vi" ? "Context chưa xác định" : "Unknown context";
  return `${compactNumber(context.tokens, locale)} / ${compactNumber(context.contextWindow, locale)} · ${context.percent.toFixed(1)}%`;
}

export function usageLabel(counter: UsageCounter, locale: "vi" | "en" = "vi"): string {
  if (counter.state !== "known") return locale === "vi" ? "Không có dữ liệu" : "No data";
  return `↑ ${compactNumber(counter.input, locale)} · ↓ ${compactNumber(counter.output, locale)}`;
}

export function verifierSummary(attempt: VerifierAttempt | null, locale: "vi" | "en" = "vi"): string {
  if (!attempt) return locale === "vi" ? "Chưa có verifier gần nhất" : "No recent verifier";
  if (attempt.state === "passed") return attempt.exitCodeExact ? `Pass · exit ${attempt.exitCode ?? 0}` : locale === "vi" ? "Pass · exit chưa xác định" : "Pass · unknown exit";
  if (attempt.state === "failed") return attempt.exitCodeExact ? `Fail · exit ${attempt.exitCode ?? "?"}` : locale === "vi" ? "Fail · exit chưa xác định" : "Fail · unknown exit";
  if (attempt.state === "stale") return attempt.staleFilesKnown ? `Stale · ${attempt.staleByPaths.length} file` : locale === "vi" ? "Stale · file chưa xác định" : "Stale · unknown files";
  return attempt.state.replaceAll("-", " ");
}

export function incompleteReason(snapshot: PiagentWebUICanonicalSnapshotV1, locale: "vi" | "en" = "vi"): string {
  return snapshot.task?.blocker
    ?? snapshot.task?.reasonCode
    ?? snapshot.verification.reasonCode
    ?? snapshot.health.issues.find((issue) => issue.severity === "error")?.message
    ?? (locale === "vi" ? "Không có blocker được ghi nhận" : "No recorded blocker");
}

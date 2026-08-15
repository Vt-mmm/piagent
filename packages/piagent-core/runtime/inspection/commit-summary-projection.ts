import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { canonicalReviewValue } from "./review-state-contract.ts";
import type { SourceChangeDocument, WebUiIdentity } from "./source-change-projection.ts";

const MAX_FILES = 300, MAX_BODY_FILES = 12;
type Status = "A" | "M" | "D" | "R" | "C";
const ACTION: Record<Status, string> = { A: "Add", M: "Update", D: "Remove", R: "Rename", C: "Resolve conflict in" };

function token(value: unknown): string { return `commit-summary.${createHash("sha256").update(canonicalReviewValue(value)).digest("hex")}`; }
function safe(value: unknown, maximum: number): { text: string; redacted: boolean } {
  const raw = String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const result = redactSensitiveText(raw); return { text: result.text.slice(0, maximum).trim(), redacted: result.redacted };
}
function unavailable(identity: WebUiIdentity, generatedAt: string, reasonCode: string) {
  return { schemaVersion: 1 as const, version: "piagent-webui-commit-summary-v1" as const, generatedAt, identity,
    state: "unavailable" as const, summary: null, reasonCode,
    health: { state: "unavailable" as const, reasonCode, message: "A current non-empty staged projection is required." } };
}

export function projectDeterministicCommitSummary(options: { identity: WebUiIdentity; sourceView: SourceChangeDocument;
  taskRevision: string; indexRevision: string; generatedAt?: string }) {
  const generatedAt = options.generatedAt ?? new Date().toISOString(), identity = { ...options.identity, agentOperationId: null, toolCallId: null };
  if (!identity.taskId || !identity.taskRunId || options.sourceView.view !== "staged"
    || options.sourceView.availability.state !== "current") return unavailable(identity, generatedAt, "staged-projection-unavailable");
  const files = options.sourceView.files.slice(0, MAX_FILES) as Array<Record<string, any>>;
  const total = Math.min(2_000, Number((options.sourceView.page as any)?.total ?? files.length));
  if (total < 1 || files.length < 1) return unavailable(identity, generatedAt, "no-staged-changes");
  const statusCounts: Record<Status, number> = { A: 0, M: 0, D: 0, R: 0, C: 0 }, lines: string[] = [];
  let protectedFileCount = 0, redacted = false, additions = 0, deletions = 0, exactStats = total === files.length;
  const commitments: unknown[] = [];
  for (const file of files) {
    const status = ["A", "M", "D", "R", "C"].includes(file.status) ? file.status as Status : "M";
    statusCounts[status] += 1; commitments.push([file.fileRef, file.fileRevision, status, file.currentDigest, file.baseDigest]);
    const restricted = file.content?.access !== "available" || file.pathDisplay !== "exact-safe";
    if (restricted) { protectedFileCount += 1; exactStats = false; continue; }
    const display = safe(file.path, 300); redacted ||= display.redacted;
    const label = display.redacted || !display.text ? "[redacted staged file]" : display.text;
    const statsExact = file.stats?.state === "exact" && Number.isInteger(file.stats.additions) && Number.isInteger(file.stats.deletions);
    if (statsExact) { additions += file.stats.additions; deletions += file.stats.deletions; } else exactStats = false;
    if (lines.length < MAX_BODY_FILES) lines.push(`- ${ACTION[status]} ${label}${statsExact ? ` (+${file.stats.additions}/-${file.stats.deletions})` : ""}`);
  }
  if (protectedFileCount) lines.push(`- ${protectedFileCount} protected staged file${protectedFileCount === 1 ? "" : "s"} (names omitted)`);
  const omitted = Math.max(0, total - Math.min(files.length, MAX_BODY_FILES + protectedFileCount));
  if (omitted) lines.push(`- ${omitted} additional staged file${omitted === 1 ? "" : "s"} omitted from this bounded preview`);
  lines.push(exactStats ? `- Staged changes: +${additions} / -${deletions}` : "- Staged line totals are incomplete");
  const singleVisible = total === 1 && protectedFileCount === 0 && lines[0]?.startsWith("- ") ? lines[0].replace(/^- /, "").replace(/ \(\+\d+\/-\d+\)$/, "") : null;
  const title = safe(singleVisible ?? `Update ${total} staged files`, 160).text || `Update ${total} staged files`;
  const summaryRef = token({ taskRevision: options.taskRevision, indexRevision: options.indexRevision, total, commitments, lines, title });
  const modelPrompt = ["Write a concise Git commit message from the exact staged summary below.",
    "Return one title of at most 72 characters, then optional bullet points. Do not claim that a commit or push was executed.",
    `Index revision: ${options.indexRevision}`, `Deterministic title: ${title}`, ...lines].join("\n").slice(0, 8_000);
  return { schemaVersion: 1 as const, version: "piagent-webui-commit-summary-v1" as const, generatedAt, identity, state: "ready" as const,
    summary: { summaryRef, taskRevision: options.taskRevision, indexRevision: options.indexRevision, title, bodyLines: lines,
      modelPrompt, fileCount: total, returnedFiles: files.length, statusCounts, additions: exactStats ? additions : null,
      deletions: exactStats ? deletions : null, protectedFileCount, redacted, truncated: Boolean((options.sourceView.page as any)?.truncated) || omitted > 0 },
    reasonCode: null, health: { state: "ok" as const, reasonCode: null, message: null } };
}

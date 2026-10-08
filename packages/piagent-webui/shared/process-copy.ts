// What a Harness step says, in Vietnamese and English: the dashboard's turn
// notes and the company Terminal read the same words.
import { failureRoleText, type CopyLocale, type FailureRole } from "./company-copy.ts";

export type ProcessCopyInput = {
  phase?: string; outcome?: string; loop?: number; maxLoops?: number; verified?: boolean; reviewed?: boolean; blockingOpen?: number;
  planOpen?: number; planSkipped?: boolean; verifyPolicy?: string; reviewPolicy?: string; reviewUnavailable?: string; role?: FailureRole;
  disputes?: number; unchanged?: boolean;
  findings?: Array<{ severity: string; file?: string; line?: number | null; issue: string }>;
  claims?: Array<{ claim: string }>; issues?: Array<{ kind: string; detail: string }>;
};
const pick = (locale: CopyLocale, vi: string, en: string) => locale === "vi" ? vi : en;
const SEVERITY: Record<string, [string, string]> = { blocking: ["blocking", "blocking"], major: ["major", "major"], minor: ["minor", "minor"] };
const KIND: Record<string, [string, string]> = { wrong_premise: ["sai giả định", "wrong premise"], conflicts_with_request: ["conflict với yêu cầu", "conflicts with the request"],
  ambiguous: ["chưa rõ ràng", "ambiguous"], out_of_scope: ["out of scope", "out of scope"] };
const UNAVAILABLE: Record<string, [string, string]> = { too_large: ["patch quá lớn", "the patch is too large"], not_git: ["thư mục không phải git", "not a git repository"],
  limit: ["subagent đã hết lượt gọi", "the subagent ran out of calls"], failed: ["subagent lỗi", "the subagent failed"] };

// How a code-changing turn ended against the Harness workflow, in a few words.
export function outcomeText(process: ProcessCopyInput, locale: CopyLocale): string {
  const parts: string[] = [];
  if (process.outcome === "interrupted") return pick(locale, "Lượt bị dừng trước khi check xong", "The turn stopped before its checks finished");
  // A disagreement between the main agent and a subagent is the member's to settle.
  if (process.outcome === "disputed") parts.push((process.disputes ?? 1) > 1 ? pick(locale, `${process.disputes} conflict giữa main agent và subagent, bạn quyết định`, `${process.disputes} disagreements between the main agent and a subagent; your call`)
    : pick(locale, "Main agent và subagent conflict, bạn quyết định", "The main agent and a subagent disagree; your call"));
  if (process.unchanged) return parts.join(" · ") || pick(locale, "Không đổi code", "No code changed");
  if (process.verified) parts.push(pick(locale, "Check đã pass trên code cuối", "A check passed on the final code"));
  else if (process.verifyPolicy !== "off") parts.push(pick(locale, "Chưa có check pass trên code cuối", "No check passed on the final code"));
  if (process.reviewed) parts.push(process.blockingOpen ? pick(locale, `Còn ${process.blockingOpen} lỗi blocking chưa fix`, `${process.blockingOpen} blocking issue(s) still open`)
    : pick(locale, "Review không có lỗi blocking", "Review found no blocking issue"));
  else if (process.reviewPolicy !== "off") parts.push(process.outcome === "review_unavailable" ? pick(locale, "Không chạy được review", "The review could not run")
    + (process.reviewUnavailable && UNAVAILABLE[process.reviewUnavailable] ? ` (${pick(locale, ...UNAVAILABLE[process.reviewUnavailable])})` : "")
    : pick(locale, "Chưa review", "Not reviewed"));
  if (process.planSkipped) parts.push(pick(locale, "Đã sửa code khi chưa có plan", "Code was changed before a plan existed"));
  if (process.planOpen) parts.push(pick(locale, `Plan còn ${process.planOpen} bước chưa xong`, `${process.planOpen} plan step(s) not completed`));
  return parts.join(" · ") || pick(locale, "Đã đổi code", "Code changed");
}

// What a harness step (other than the final one) says, in one line.
export function headlineText(process: ProcessCopyInput, locale: CopyLocale): string {
  const round = process.loop && process.maxLoops ? pick(locale, ` (vòng ${process.loop}/${process.maxLoops})`, ` (round ${process.loop}/${process.maxLoops})`) : "";
  const who = failureRoleText(process.role ?? "review", locale), count = (process.findings ?? process.claims ?? process.issues ?? []).length;
  switch (process.phase) {
    case "plan": return pick(locale, `Harness: plan còn ${process.planOpen ?? 0} bước chưa đánh dấu xong, yêu cầu agent cập nhật`, `Harness: ${process.planOpen ?? 0} plan step(s) not marked completed; asked the agent to update the plan`);
    case "verify": return pick(locale, `Harness: chưa có check nào pass trên code hiện tại, yêu cầu agent chạy check${round}`, `Harness: no check has passed on the current code; asked the agent to run checks${round}`);
    case "review": return pick(locale, `Harness: review tìm thấy ${count} lỗi blocking, gửi lại agent để fix hoặc giải thích${round}`, `Harness: the review found ${count} blocking issue(s); sent back to the agent to fix or answer${round}`);
    case "objection": return pick(locale, `${who} phản biện brief của main agent`, `${who} objected to the main agent's brief`);
    case "answer": return pick(locale, "Harness: yêu cầu main agent nói rõ đã quyết định gì với phản biện của subagent", "Harness: asked the main agent to say what it decided about the subagent's objection");
    case "claims": return pick(locale, `Harness: ${who} đánh fail ${count} claim, gửi lại main agent`, `Harness: ${who} marked ${count} claim(s) as failed; sent back to the main agent`);
    case "rejudge": return process.role === "verify" ? pick(locale, `Harness: ${who} check lại các claim cùng câu trả lời của main agent`, `Harness: ${who} checks the claims again with the main agent's answer`)
      : pick(locale, `Harness: main agent giải thích thay vì fix, ${who} xem xét lại lời giải thích`, `Harness: the main agent answered instead of fixing; ${who} judges the answer`);
    case "dispute": return pick(locale, `Main agent và ${who} vẫn conflict sau 2 lượt, bạn quyết định`, `The main agent and the ${who} still disagree after two rounds; your call`);
    default: return "";
  }
}

// The items a step carries: review findings, failed claims, objections to a brief.
export type ProcessItem = { tag: string; tone: "error" | "warning"; location: string | null; text: string };
export function processItems(process: ProcessCopyInput, locale: CopyLocale): ProcessItem[] {
  return (process.findings ?? []).map((f): ProcessItem => ({ tag: pick(locale, ...(SEVERITY[f.severity] ?? [f.severity, f.severity])),
    tone: f.severity === "blocking" ? "error" : "warning", location: f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null, text: f.issue }))
    .concat((process.claims ?? []).map((c): ProcessItem => ({ tag: "fail", tone: "error", location: null, text: c.claim })))
    .concat((process.issues ?? []).map((i): ProcessItem => ({ tag: pick(locale, ...(KIND[i.kind] ?? [i.kind, i.kind])), tone: "warning", location: null, text: i.detail })));
}

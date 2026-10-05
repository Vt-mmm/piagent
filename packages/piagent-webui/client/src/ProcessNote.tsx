import CheckCircleOutlineRounded from "@mui/icons-material/CheckCircleOutlineRounded";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import ForumOutlined from "@mui/icons-material/ForumOutlined";
import ReplayRounded from "@mui/icons-material/ReplayRounded";
import WarningAmberRounded from "@mui/icons-material/WarningAmberRounded";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { failureRole } from "./company-failure.tsx";
import type { TimelineProcess } from "./timeline-view-model.ts";
import { toneText, type Tone } from "./tone.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

type Outcome = NonNullable<TimelineProcess["outcome"]>;
const SEVERITY: Record<string, [string, string]> = { blocking: ["blocking", "blocking"], major: ["major", "major"], minor: ["minor", "minor"] };
const KIND: Record<string, [string, string]> = { wrong_premise: ["sai giả định", "wrong premise"], conflicts_with_request: ["conflict với yêu cầu", "conflicts with the request"],
  ambiguous: ["chưa rõ ràng", "ambiguous"], out_of_scope: ["out of scope", "out of scope"] };
const TONES: Record<Outcome, Tone> = { clean: "success", disputed: "warning", blocking_open: "error", unverified: "warning", unreviewed: "warning", review_unavailable: "warning", interrupted: "warning", no_change: "info" };

// How a code-changing turn ended against the Harness workflow, in a few words.
const UNAVAILABLE: Record<string, [string, string]> = { too_large: ["patch quá lớn", "the patch is too large"], not_git: ["thư mục không phải git", "not a git repository"],
  limit: ["subagent đã hết lượt gọi", "the subagent ran out of calls"], failed: ["subagent lỗi", "the subagent failed"] };
export function outcomeText(process: { outcome?: Outcome; verified?: boolean; reviewed?: boolean; blockingOpen?: number; planOpen?: number; planSkipped?: boolean; verifyPolicy?: string; reviewPolicy?: string; reviewUnavailable?: string; disputes?: number; unchanged?: boolean }, locale: UiLocale): string {
  const parts: string[] = [];
  if (process.outcome === "interrupted") return localize(locale, "Lượt bị dừng trước khi check xong", "The turn stopped before its checks finished");
  // A disagreement between the main agent and a subagent is the member's to settle.
  if (process.outcome === "disputed") parts.push((process.disputes ?? 1) > 1 ? localize(locale, `${process.disputes} conflict giữa main agent và subagent, bạn quyết định`, `${process.disputes} disagreements between the main agent and a subagent; your call`)
    : localize(locale, "Main agent và subagent conflict, bạn quyết định", "The main agent and a subagent disagree; your call"));
  if (process.unchanged) return parts.join(" · ") || localize(locale, "Không đổi code", "No code changed");
  if (process.verified) parts.push(localize(locale, "Check đã pass trên code cuối", "A check passed on the final code"));
  else if (process.verifyPolicy !== "off") parts.push(localize(locale, "Chưa có check pass trên code cuối", "No check passed on the final code"));
  if (process.reviewed) parts.push(process.blockingOpen ? localize(locale, `Còn ${process.blockingOpen} lỗi blocking chưa fix`, `${process.blockingOpen} blocking issue(s) still open`)
    : localize(locale, "Review không có lỗi blocking", "Review found no blocking issue"));
  else if (process.reviewPolicy !== "off") parts.push(process.outcome === "review_unavailable" ? localize(locale, "Không chạy được review", "The review could not run")
    + (process.reviewUnavailable && UNAVAILABLE[process.reviewUnavailable] ? ` (${localize(locale, ...UNAVAILABLE[process.reviewUnavailable])})` : "")
    : localize(locale, "Chưa review", "Not reviewed"));
  if (process.planSkipped) parts.push(localize(locale, "Đã sửa code khi chưa có plan", "Code was changed before a plan existed"));
  if (process.planOpen) parts.push(localize(locale, `Plan còn ${process.planOpen} bước chưa xong`, `${process.planOpen} plan step(s) not completed`));
  return parts.join(" · ") || localize(locale, "Đã đổi code", "Code changed");
}
export const outcomeTone = (outcome: Outcome | undefined): Tone => (outcome ? TONES[outcome] : "info");
// A turn whose steps all passed still warns when its plan was skipped or left unfinished.
export const processTone = (process: { outcome?: Outcome; planSkipped?: boolean; planOpen?: number }): Tone => {
  const tone = outcomeTone(process.outcome);
  return tone === "success" && (process.planSkipped || process.planOpen) ? "warning" : tone;
};

// What a harness step says, in one line.
function headline(process: TimelineProcess, locale: UiLocale): string {
  const round = process.loop && process.maxLoops ? localize(locale, ` (vòng ${process.loop}/${process.maxLoops})`, ` (round ${process.loop}/${process.maxLoops})`) : "";
  const who = failureRole(process.role ?? "review", locale), count = (process.findings ?? process.claims ?? process.issues ?? []).length;
  switch (process.phase) {
    case "plan": return localize(locale, `Harness: plan còn ${process.planOpen ?? 0} bước chưa đánh dấu xong, yêu cầu agent cập nhật`, `Harness: ${process.planOpen ?? 0} plan step(s) not marked completed; asked the agent to update the plan`);
    case "verify": return localize(locale, `Harness: chưa có check nào pass trên code hiện tại, yêu cầu agent chạy check${round}`, `Harness: no check has passed on the current code; asked the agent to run checks${round}`);
    case "review": return localize(locale, `Harness: review tìm thấy ${count} lỗi blocking, gửi lại agent để fix hoặc giải thích${round}`, `Harness: the review found ${count} blocking issue(s); sent back to the agent to fix or answer${round}`);
    case "objection": return localize(locale, `${who} phản biện brief của main agent`, `${who} objected to the main agent's brief`);
    case "answer": return localize(locale, "Harness: yêu cầu main agent nói rõ đã quyết định gì với phản biện của subagent", "Harness: asked the main agent to say what it decided about the subagent's objection");
    case "claims": return localize(locale, `Harness: ${who} đánh fail ${count} claim, gửi lại main agent`, `Harness: ${who} marked ${count} claim(s) as failed; sent back to the main agent`);
    case "rejudge": return process.role === "verify" ? localize(locale, `Harness: ${who} check lại các claim cùng câu trả lời của main agent`, `Harness: ${who} checks the claims again with the main agent's answer`)
      : localize(locale, `Harness: main agent giải thích thay vì fix, ${who} xem xét lại lời giải thích`, `Harness: the main agent answered instead of fixing; ${who} judges the answer`);
    case "dispute": return localize(locale, `Main agent và ${who} vẫn conflict sau 2 lượt, bạn quyết định`, `The main agent and the ${who} still disagree after two rounds; your call`);
    default: return "";
  }
}
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 };
// The items a step carries: review findings, failed claims, objections to a brief.
function Items({ process, locale }: { process: TimelineProcess; locale: UiLocale }) {
  const tag = (text: string, tone: Tone) => <Box component="span" sx={{ fontWeight: 600, ...toneText(tone) }}>[{text}]</Box>;
  const rows = (process.findings ?? []).map(f => <>{tag(localize(locale, ...(SEVERITY[f.severity] ?? [f.severity, f.severity])), f.severity === "blocking" ? "error" : "warning")}
    {f.file && <Box component="span" sx={mono}> {f.file}{f.line ? `:${f.line}` : ""}</Box>} — {f.issue}</>)
    .concat((process.claims ?? []).map(c => <>{tag("fail", "error")} {c.claim}</>))
    .concat((process.issues ?? []).map(i => <>{tag(localize(locale, ...(KIND[i.kind] ?? [i.kind, i.kind])), "warning")} {i.detail}</>));
  return rows.length > 0 ? <Box component="ol" sx={{ m: 0, pl: 3.5 }}>{rows.map((row, i) => <Typography component="li" key={i} variant="body2" sx={{ overflowWrap: "anywhere" }}>{row}</Typography>)}</Box> : null;
}

// A harness step inside a turn: sending the agent back to run checks, fix
// findings or answer a helper's objection, a disagreement handed to the
// member, and how the turn ended.
export function ProcessNote({ process, locale }: { process: TimelineProcess; locale: UiLocale }) {
  if (process.phase === "final") {
    const tone = processTone(process), Icon = tone === "success" ? CheckCircleOutlineRounded : tone === "error" ? ErrorOutlineRounded : WarningAmberRounded;
    return <Stack direction="row" role="status" aria-label={localize(locale, "Tiến trình của lượt", "Turn process")} sx={{ alignItems: "flex-start", gap: .75 }}>
      <Icon sx={{ fontSize: 16, mt: .2, ...toneText(tone) }} />
      <Typography variant="body2" sx={toneText(tone)}>{outcomeText(process, locale)}</Typography></Stack>;
  }
  // A helper's objection and a disagreement for the member stand out; the harness's own rounds stay quiet.
  const loud = process.phase === "dispute" || process.phase === "objection", Icon = process.phase === "dispute" ? WarningAmberRounded : process.phase === "objection" ? ForumOutlined : ReplayRounded;
  const tone: Tone | null = process.phase === "dispute" ? "warning" : null;
  return <Stack spacing={.5} role={loud ? "status" : undefined} sx={{ borderLeft: 2, borderColor: tone ? "warning.main" : "divider", pl: 1.25 }}>
    <Stack direction="row" sx={{ alignItems: "flex-start", gap: .75 }}>
      <Icon sx={{ fontSize: 16, mt: .2, ...(tone ? toneText(tone) : { color: "text.secondary" }) }} />
      <Typography variant="body2" sx={tone ? { fontWeight: 600, ...toneText(tone) } : loud ? { fontWeight: 600 } : { color: "text.secondary" }}>{headline(process, locale)}</Typography>
    </Stack>
    <Items process={process} locale={locale} />
  </Stack>;
}

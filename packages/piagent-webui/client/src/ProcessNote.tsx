import CheckCircleOutlineRounded from "@mui/icons-material/CheckCircleOutlineRounded";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import ReplayRounded from "@mui/icons-material/ReplayRounded";
import WarningAmberRounded from "@mui/icons-material/WarningAmberRounded";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { TimelineProcess } from "./timeline-view-model.ts";
import { toneText, type Tone } from "./tone.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

type Outcome = NonNullable<TimelineProcess["outcome"]>;
const SEVERITY: Record<string, [string, string]> = { blocking: ["chặn", "blocking"], major: ["quan trọng", "major"], minor: ["nhỏ", "minor"] };
const TONES: Record<Outcome, Tone> = { clean: "success", blocking_open: "error", unverified: "warning", unreviewed: "warning", review_unavailable: "warning", interrupted: "warning", no_change: "info" };

// How a code-changing turn ended against the Harness workflow, in a few words.
const UNAVAILABLE: Record<string, [string, string]> = { too_large: ["patch quá lớn", "the patch is too large"], not_git: ["thư mục không phải git", "not a git repository"],
  limit: ["subagent đã hết lượt", "the subagent ran out of calls"], failed: ["subagent lỗi", "the subagent failed"] };
export function outcomeText(process: { outcome?: Outcome; verified?: boolean; reviewed?: boolean; blockingOpen?: number; planOpen?: number; planSkipped?: boolean; verifyPolicy?: string; reviewPolicy?: string; reviewUnavailable?: string }, locale: UiLocale): string {
  const parts: string[] = [];
  if (process.outcome === "interrupted") return localize(locale, "Lượt bị dừng trước khi kiểm chứng xong", "The turn stopped before its checks finished");
  if (process.verified) parts.push(localize(locale, "Check đã qua trên code cuối", "A check passed on the final code"));
  else if (process.verifyPolicy !== "off") parts.push(localize(locale, "Chưa có check qua trên code cuối", "No check passed on the final code"));
  if (process.reviewed) parts.push(process.blockingOpen ? localize(locale, `Còn ${process.blockingOpen} lỗi chặn chưa sửa`, `${process.blockingOpen} blocking issue(s) still open`)
    : localize(locale, "Review không có lỗi chặn", "Review found no blocking issue"));
  else if (process.reviewPolicy !== "off") parts.push(process.outcome === "review_unavailable" ? localize(locale, "Không chạy được review", "The review could not run")
    + (process.reviewUnavailable && UNAVAILABLE[process.reviewUnavailable] ? ` (${localize(locale, ...UNAVAILABLE[process.reviewUnavailable])})` : "")
    : localize(locale, "Chưa review", "Not reviewed"));
  if (process.planSkipped) parts.push(localize(locale, "Đã sửa code khi chưa có kế hoạch", "Code was changed before a plan existed"));
  if (process.planOpen) parts.push(localize(locale, `Kế hoạch còn ${process.planOpen} bước chưa xong`, `${process.planOpen} plan step(s) not completed`));
  return parts.join(" · ") || localize(locale, "Đã đổi code", "Code changed");
}
export const outcomeTone = (outcome: Outcome | undefined): Tone => (outcome ? TONES[outcome] : "info");
// A turn whose steps all passed still warns when its plan was skipped or left unfinished.
export const processTone = (process: { outcome?: Outcome; planSkipped?: boolean; planOpen?: number }): Tone => {
  const tone = outcomeTone(process.outcome);
  return tone === "success" && (process.planSkipped || process.planOpen) ? "warning" : tone;
};

// A harness step inside a turn: sending the agent back to run checks or fix
// blocking review findings, and how the turn ended.
export function ProcessNote({ process, locale }: { process: TimelineProcess; locale: UiLocale }) {
  const round = process.loop && process.maxLoops ? localize(locale, ` (vòng ${process.loop}/${process.maxLoops})`, ` (round ${process.loop}/${process.maxLoops})`) : "";
  if (process.phase === "final") {
    const tone = processTone(process), Icon = tone === "success" ? CheckCircleOutlineRounded : tone === "error" ? ErrorOutlineRounded : WarningAmberRounded;
    return <Stack direction="row" role="status" aria-label={localize(locale, "Tiến trình của lượt", "Turn process")} sx={{ alignItems: "flex-start", gap: .75 }}>
      <Icon sx={{ fontSize: 16, mt: .2, ...toneText(tone) }} />
      <Typography variant="body2" sx={toneText(tone)}>{outcomeText(process, locale)}</Typography></Stack>;
  }
  const blocking = process.findings ?? [];
  return <Stack spacing={.5} sx={{ borderLeft: 2, borderColor: "divider", pl: 1.25 }}>
    <Stack direction="row" sx={{ alignItems: "flex-start", gap: .75 }}>
      <ReplayRounded sx={{ fontSize: 16, mt: .2, color: "text.secondary" }} />
      <Typography variant="body2" color="text.secondary">{process.phase === "plan"
        ? localize(locale, `Harness: kế hoạch còn ${process.planOpen ?? 0} bước chưa đánh dấu xong, yêu cầu agent cập nhật`, `Harness: ${process.planOpen ?? 0} plan step(s) not marked completed; asked the agent to update the plan`)
        : process.phase === "verify"
        ? localize(locale, `Harness: chưa có lệnh check nào chạy qua trên code hiện tại, yêu cầu agent chạy check${round}`, `Harness: no check has passed on the current code; asked the agent to run checks${round}`)
        : localize(locale, `Harness: review tìm thấy ${blocking.length} lỗi chặn, gửi lại cho agent sửa${round}`, `Harness: the review found ${blocking.length} blocking issue(s); sent back to the agent${round}`)}</Typography>
    </Stack>
    {blocking.length > 0 && <Box component="ol" sx={{ m: 0, pl: 3.5 }}>{blocking.map((f, i) => <Typography component="li" key={i} variant="body2" sx={{ overflowWrap: "anywhere" }}>
      <Box component="span" sx={{ fontWeight: 600, ...toneText(f.severity === "blocking" ? "error" : "warning") }}>[{localize(locale, ...(SEVERITY[f.severity] ?? [f.severity, f.severity]))}]</Box>
      {f.file && <Box component="span" sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 }}> {f.file}{f.line ? `:${f.line}` : ""}</Box>} — {f.issue}</Typography>)}</Box>}
  </Stack>;
}

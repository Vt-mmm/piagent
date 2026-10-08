import CheckCircleOutlineRounded from "@mui/icons-material/CheckCircleOutlineRounded";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import ForumOutlined from "@mui/icons-material/ForumOutlined";
import ReplayRounded from "@mui/icons-material/ReplayRounded";
import WarningAmberRounded from "@mui/icons-material/WarningAmberRounded";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { headlineText, outcomeText as sharedOutcomeText, processItems, type ProcessCopyInput } from "../../shared/process-copy.ts";
import type { TimelineProcess } from "./timeline-view-model.ts";
import { toneText, type Tone } from "./tone.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

type Outcome = NonNullable<TimelineProcess["outcome"]>;
const TONES: Record<Outcome, Tone> = { clean: "success", disputed: "warning", blocking_open: "error", unverified: "warning", unreviewed: "warning", review_unavailable: "warning", interrupted: "warning", no_change: "info" };

// The words live in shared/process-copy.ts: the company Terminal says the same.
export function outcomeText(process: ProcessCopyInput, locale: UiLocale): string { return sharedOutcomeText(process, locale); }
export const outcomeTone = (outcome: Outcome | undefined): Tone => (outcome ? TONES[outcome] : "info");
// A turn whose steps all passed still warns when its plan was skipped or left unfinished.
export const processTone = (process: { outcome?: Outcome; planSkipped?: boolean; planOpen?: number }): Tone => {
  const tone = outcomeTone(process.outcome);
  return tone === "success" && (process.planSkipped || process.planOpen) ? "warning" : tone;
};

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 };
// The items a step carries: review findings, failed claims, objections to a brief.
function Items({ process, locale }: { process: TimelineProcess; locale: UiLocale }) {
  const rows = processItems(process, locale).map(item => <><Box component="span" sx={{ fontWeight: 600, ...toneText(item.tone) }}>[{item.tag}]</Box>
    {item.location && <Box component="span" sx={mono}> {item.location}</Box>}{item.location ? " — " : " "}{item.text}</>);
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
      <Typography variant="body2" sx={tone ? { fontWeight: 600, ...toneText(tone) } : loud ? { fontWeight: 600 } : { color: "text.secondary" }}>{headlineText(process, locale)}</Typography>
    </Stack>
    <Items process={process} locale={locale} />
  </Stack>;
}

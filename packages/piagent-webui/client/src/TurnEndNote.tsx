import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";

import { turnEndCopy, turnEndShort, type TurnEnd } from "../../shared/turn-end.ts";
import type { Tone } from "./tone.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// How a company turn ended, under its last answer: finished, stopped with
// checklist steps open (and why), failed, or stopped by the member. A turn
// that is not finished offers Continue when it is the conversation's last.
export function TurnEndNote({ end, locale, onContinue }: { end: TurnEnd; locale: UiLocale; onContinue?: () => void }) {
  const copy = turnEndCopy(end, locale);
  const action = onContinue && copy.continuable ? <Button color="inherit" size="small" onClick={onContinue}>{localize(locale, "Tiếp tục", "Continue")}</Button> : undefined;
  return <Alert severity={copy.tone} variant="outlined" role="status" aria-label={localize(locale, "Kết quả của lượt", "How the turn ended")} action={action} sx={{ alignSelf: "stretch" }}>
    <AlertTitle sx={{ fontSize: "inherit", fontWeight: 650, mb: .25 }}>{copy.title}</AlertTitle>
    {copy.text}
  </Alert>;
}

// The session list's short label and its tone.
export const TURN_END_TONES: Record<TurnEnd["state"], Tone> = { done: "success", midway: "warning", failed: "error", cancelled: "info" };
export function turnEndLabel(end: Pick<TurnEnd, "state" | "planSteps" | "planDone">, locale: UiLocale): string { return turnEndShort(end, locale); }

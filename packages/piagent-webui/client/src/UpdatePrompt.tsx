import { useEffect, useState } from "react";
import SystemUpdateAltRounded from "@mui/icons-material/SystemUpdateAltRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";

import { localize, type UiLocale } from "./ui-preferences.tsx";
import { updateInProgress, useUpdates } from "./update-state.tsx";
import { updateErrorText, updatePlan } from "./UpdateSettings.tsx";

// A new release is said out loud: a status-bar icon alone went unnoticed.
// "Later" asks again after an hour (per release, per browser); the outcome of
// an update is said once on the dashboard it restarted into.
const SNOOZE_KEY = "piagent-update-snooze", SEEN_JOB_KEY = "piagent-update-job-seen", SNOOZE_MS = 60 * 60 * 1000;

function read(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string): void { try { window.localStorage.setItem(key, value); } catch { /* private window */ } }
function snoozed(version: string, now: number): boolean {
  try { const value = JSON.parse(read(SNOOZE_KEY) ?? "null") as { version?: unknown; until?: unknown } | null;
    return value?.version === version && typeof value.until === "number" && now < value.until; } catch { return false; }
}

export function UpdatePrompt({ locale, onDetails }: { locale: UiLocale; onDetails(): void }) {
  const { status, applying, error, apply } = useUpdates();
  const [now, setNow] = useState(() => Date.now()), [dismissed, setDismissed] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const latest = status?.piagent.latest ?? null, job = status?.job ?? null;
  useEffect(() => {
    if (!job || job.state !== "succeeded" || read(SEEN_JOB_KEY) === job.startedAt) return;
    write(SEEN_JOB_KEY, job.startedAt);
    setDone(localize(locale, `Đã cập nhật Piagent ${job.from} → ${job.installed ?? job.to}.`, `Piagent updated ${job.from} → ${job.installed ?? job.to}.`));
  }, [job, locale]);
  const offer = Boolean(status?.installable && status.updateAvailable && latest && !updateInProgress(status));
  const open = offer && dismissed !== latest && !snoozed(latest!, now);
  const later = () => { if (!latest) return; write(SNOOZE_KEY, JSON.stringify({ version: latest, until: Date.now() + SNOOZE_MS })); setDismissed(latest); };
  const blocked = (status?.runningConversations ?? 0) > 0;
  return <>
    <Dialog open={open} onClose={later} fullWidth maxWidth="xs" aria-labelledby="piagent-update-offer">
      <DialogTitle id="piagent-update-offer" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <SystemUpdateAltRounded color="primary" />{localize(locale, `Có bản Piagent mới: ${latest}`, `Piagent ${latest} is available`)}</DialogTitle>
      <DialogContent sx={{ display: "grid", gap: 1.5 }}>
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: "grid", gap: .75 }}>
          {status && updatePlan(locale, status).map((line) => <Typography component="li" variant="body2" key={line}>{line}</Typography>)}</Box>
        {blocked && <Alert severity="info">{localize(locale,
          `${status?.runningConversations} cuộc trò chuyện đang chạy. Cập nhật khi chúng xong — dialog này sẽ nhắc lại.`,
          `${status?.runningConversations} conversation(s) running. Update once they finish — this will ask again.`)}</Alert>}
        {error && <Alert severity="error">{updateErrorText(locale, error)}</Alert>}
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 1 }}>
        <Button onClick={later}>{localize(locale, "Để sau (nhắc lại sau 1 giờ)", "Later (ask again in an hour)")}</Button>
        <Button onClick={() => { setDismissed(latest); onDetails(); }}>{localize(locale, "Xem chi tiết", "Details")}</Button>
        <Button variant="contained" disabled={blocked || applying} onClick={() => { setDismissed(latest); void apply().then(onDetails); }}>
          {localize(locale, "Cập nhật ngay", "Update now")}</Button>
      </DialogActions>
    </Dialog>
    <Snackbar open={done !== null} autoHideDuration={8_000} onClose={() => setDone(null)} anchorOrigin={{ vertical: "top", horizontal: "center" }}>
      <Alert severity="success" variant="filled" onClose={() => setDone(null)}>{done}</Alert></Snackbar>
  </>;
}

import { useEffect, useRef, useState } from "react";
import SystemUpdateAltRounded from "@mui/icons-material/SystemUpdateAltRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";
import { updateInProgress, useUpdates, type UpdateJob, type UpdateStatus } from "./update-state.tsx";

const LOG_PATH = "~/.pi/piagent-update-job.log";

export function updateErrorText(locale: UiLocale, code: string): string {
  const texts: Record<string, [string, string]> = {
    "update-blocked-running": ["Đang có cuộc trò chuyện chạy. Cập nhật khi chúng xong, hoặc bấm Dừng.", "A conversation is running. Update when it finishes, or stop it."],
    "update-already-running": ["Một lần cập nhật khác đang chạy.", "Another update is running."],
    "update-version-changed": ["Đã có bản mới hơn bản bạn thấy. Kiểm tra lại rồi cập nhật.", "A newer release appeared. Check again, then update."],
    "update-not-available": ["Máy này đã ở bản mới nhất.", "This machine is already up to date."],
    "update-not-installable": ["Bản Piagent này không tự cập nhật được từ dashboard.", "This Piagent cannot update itself from the dashboard."]
  };
  const text = texts[code];
  return text ? localize(locale, text[0], text[1]) : localize(locale, "Chưa cập nhật được. Thử lại sau.", "The update could not start. Try again later.");
}

function jobOutcome(locale: UiLocale, job: UpdateJob): { severity: "success" | "error" | "warning"; text: string } | null {
  if (job.state === "succeeded") return job.reason === "dashboard-restart-failed"
    ? { severity: "warning", text: localize(locale, `Đã cập nhật lên ${job.installed ?? job.to}, nhưng dashboard chưa tự mở lại. Chạy \`piagent dashboard restart\`.`,
      `Updated to ${job.installed ?? job.to}, but the dashboard did not restart. Run \`piagent dashboard restart\`.`) }
    : { severity: "success", text: localize(locale, `Đã cập nhật Piagent ${job.from} → ${job.installed ?? job.to}.`, `Updated Piagent ${job.from} → ${job.installed ?? job.to}.`) };
  if (job.state !== "failed") return null;
  const why = job.reason === "update-interrupted" ? localize(locale, "Lần cập nhật bị ngắt giữa chừng.", "The update was interrupted.")
    : job.reason === "update-version-mismatch" ? localize(locale, "Bản cài xong không đúng bản đã chọn.", "The installed release is not the one chosen.")
      : localize(locale, "Lệnh cập nhật báo lỗi.", "The update command failed.");
  return { severity: "error", text: `${why} ${localize(locale, `Chi tiết trong ${LOG_PATH}.`, `Details are in ${LOG_PATH}.`)}` };
}

function relative(locale: UiLocale, iso: string | null): string {
  if (!iso) return localize(locale, "chưa kiểm tra", "not checked yet");
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return localize(locale, "vừa xong", "just now");
  if (minutes < 60) return localize(locale, `${minutes} phút trước`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  return hours < 48 ? localize(locale, `${hours} giờ trước`, `${hours} h ago`) : localize(locale, `${Math.round(hours / 24)} ngày trước`, `${Math.round(hours / 24)} days ago`);
}

function VersionRow({ name, detail, chip, tone }: { name: string; detail: string; chip: string; tone: "default" | "primary" | "warning" }) {
  return <Stack direction={{ xs: "column", sm: "row" }} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between", gap: 1.5, p: 2.25 }}>
    <Box sx={{ minWidth: 0 }}><Typography sx={{ fontWeight: 760 }}>{name}</Typography>
      <Typography variant="body2" color="text.secondary">{detail}</Typography></Box>
    <Chip size="small" label={chip} color={tone} variant={tone === "default" ? "outlined" : "filled"} sx={{ alignSelf: { xs: "flex-start", sm: "center" } }} /></Stack>;
}

// What the update will do, said before it starts.
export function updatePlan(locale: UiLocale, status: UpdateStatus): string[] {
  const lines = [];
  if (status.piagent.updateAvailable) lines.push(localize(locale, `Piagent ${status.piagent.installed} → ${status.piagent.latest}`, `Piagent ${status.piagent.installed} → ${status.piagent.latest}`));
  if (status.pi.updateAvailable) lines.push(localize(locale, `Pi ${status.pi.installed ?? "?"} → ${status.pi.required} (bản Piagent ${status.piagent.latest} yêu cầu)`,
    `Pi ${status.pi.installed ?? "?"} → ${status.pi.required} (the version Piagent ${status.piagent.latest} requires)`));
  lines.push(localize(locale, "Dashboard khởi động lại và mở trong tab mới; tab này có thể đóng.", "The dashboard restarts and opens in a new tab; this tab can be closed."));
  return lines;
}

export function UpdateSettings() {
  const { locale } = useUiPreferences();
  const { status, supported, checking, applying, error, check, apply } = useUpdates();
  const [confirm, setConfirm] = useState(false), heading = useRef<HTMLHeadingElement | null>(null);
  const running = updateInProgress(status);
  // The update button goes away once the update starts: keep keyboard focus
  // inside Settings, on this section's heading.
  useEffect(() => { if (running && !heading.current?.closest("[role=dialog]")?.contains(document.activeElement)) heading.current?.focus(); }, [running]);
  if (!supported) return <><Typography component="h1" variant="h1" sx={{ mb: 3 }}>{localize(locale, "Cập nhật", "Updates")}</Typography>
    <Alert severity="info">{localize(locale, "Gateway này chưa hỗ trợ kiểm tra cập nhật.", "This Gateway does not check for updates.")}</Alert></>;
  const job = status?.job, outcome = job ? jobOutcome(locale, job) : null;
  const blocked = (status?.runningConversations ?? 0) > 0;
  const piDetail = status ? [localize(locale, `Đang dùng ${status.pi.installed ?? "—"}`, `Using ${status.pi.installed ?? "—"}`),
    status.pi.required ? localize(locale, `Piagent ${status.piagent.latest} cần ${status.pi.required}`, `Piagent ${status.piagent.latest} needs ${status.pi.required}`) : null]
    .filter(Boolean).join(" · ") : "—";
  return <>
    <Typography component="h1" variant="h1" ref={heading} tabIndex={-1} sx={{ mb: 1 }}>{localize(locale, "Cập nhật", "Updates")}</Typography>
    <Typography color="text.secondary" sx={{ mb: 3 }}>{localize(locale,
      "Piagent và Pi được cập nhật cùng nhau: Pi luôn lên đúng bản mà Piagent mới đã kiểm chứng.",
      "Piagent and Pi update together: Pi always moves to the version the new Piagent is qualified on.")}</Typography>
    <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: "hidden" }}>
      <VersionRow name="Piagent" detail={localize(locale, `Đang dùng ${status?.piagent.installed ?? "—"}`, `Using ${status?.piagent.installed ?? "—"}`)}
        chip={status?.piagent.updateAvailable ? localize(locale, `Có bản ${status.piagent.latest}`, `${status.piagent.latest} available`)
          : status?.piagent.latest ? localize(locale, "Mới nhất", "Up to date") : localize(locale, "Chưa rõ", "Unknown")}
        tone={status?.piagent.updateAvailable ? "primary" : "default"} />
      <Divider />
      <VersionRow name="Pi" detail={piDetail}
        chip={status?.pi.updateAvailable ? localize(locale, `Lên ${status.pi.required}`, `To ${status.pi.required}`) : localize(locale, "Đúng bản", "Matches")}
        tone={status?.pi.updateAvailable ? "primary" : "default"} />
      {status?.pi.newerUntested && <><Divider /><Box sx={{ px: 2.25, py: 1.5 }}><Typography variant="body2" color="text.secondary">
        {localize(locale, `Pi đã có bản ${status.pi.latest}, nhưng Piagent chưa kiểm chứng bản đó (chưa tương thích). Pi sẽ được nâng khi một bản Piagent hỗ trợ nó.`,
          `Pi ${status.pi.latest} is out, but Piagent is not qualified on it yet (not compatible). Pi moves when a Piagent release supports it.`)}</Typography></Box></>}
      <Divider />
      <Stack direction={{ xs: "column", sm: "row" }} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between", gap: 1.5, p: 2.25 }}>
        <Typography variant="body2" color="text.secondary">{localize(locale,
          `Kiểm tra lần cuối: ${relative(locale, status?.checkedAt ?? null)} · tự kiểm tra ${(status?.checkEveryHours ?? 1) === 1 ? "mỗi giờ" : `mỗi ${status?.checkEveryHours} giờ`}`,
          `Last checked: ${relative(locale, status?.checkedAt ?? null)} · checks every ${(status?.checkEveryHours ?? 1) === 1 ? "hour" : `${status?.checkEveryHours} hours`}`)}</Typography>
        <Button variant="outlined" disabled={checking || running || !status?.installable} onClick={() => void check()}
          startIcon={checking ? <CircularProgress size={14} /> : undefined}>{localize(locale, "Kiểm tra ngay", "Check now")}</Button></Stack>
    </Paper>
    <Box sx={{ mt: 2.5, display: "grid", gap: 1.5 }}>
      {status && !status.installable && <Alert severity="info">{status.reason === "company-runtime"
        ? localize(locale, "Đây là runtime công ty; cập nhật từ dashboard Piagent.", "This is the company runtime; update from the Piagent dashboard.")
        : localize(locale, "Piagent này chạy từ mã nguồn (git). Cập nhật bằng git pull rồi cài lại.", "This Piagent runs from a source checkout. Update it with git pull and reinstall.")}</Alert>}
      {running && <Alert severity="info" icon={<CircularProgress size={18} />}>{localize(locale,
        `Đang cập nhật lên Piagent ${job?.to}… Xong, dashboard mở lại trong tab mới; tab này có thể đóng.`,
        `Updating to Piagent ${job?.to}… When done, the dashboard opens in a new tab; this tab can be closed.`)}</Alert>}
      {!running && outcome && <Alert severity={outcome.severity}>{outcome.text}</Alert>}
      {!running && job?.bindingChanged && <Alert severity="warning">{localize(locale,
        "Bản mới đổi trình khởi chạy công ty: mở Agent Watch và kết nối lại key công ty để tiếp tục dùng chế độ công ty.",
        "The new release changed the company launcher: open Agent Watch and connect the company key again to keep company mode.")}</Alert>}
      {error && <Alert severity="error" role="alert">{updateErrorText(locale, error)}</Alert>}
      {status?.installable && status.updateAvailable && !running && <Stack direction={{ xs: "column", sm: "row" }} sx={{ alignItems: { sm: "center" }, gap: 1.5 }}>
        <Button variant="contained" size="large" startIcon={applying ? <CircularProgress size={16} color="inherit" /> : <SystemUpdateAltRounded />}
          disabled={applying || blocked} onClick={() => setConfirm(true)}>
          {localize(locale, `Cập nhật lên Piagent ${status.piagent.latest}`, `Update to Piagent ${status.piagent.latest}`)}</Button>
        {blocked && <Typography variant="body2" color="text.secondary">{localize(locale,
          `${status.runningConversations} cuộc trò chuyện đang chạy; nút mở lại khi chúng xong.`,
          `${status.runningConversations} conversation(s) running; available once they finish.`)}</Typography>}</Stack>}
    </Box>
    <Dialog open={confirm && Boolean(status)} onClose={() => setConfirm(false)} fullWidth maxWidth="xs" aria-labelledby="piagent-update-confirm">
      <DialogTitle id="piagent-update-confirm">{localize(locale, "Cập nhật Piagent?", "Update Piagent?")}</DialogTitle>
      <DialogContent><Box component="ul" sx={{ m: 0, pl: 2.5, display: "grid", gap: .75 }}>
        {status && updatePlan(locale, status).map((line) => <Typography component="li" variant="body2" key={line}>{line}</Typography>)}</Box></DialogContent>
      <DialogActions><Button onClick={() => setConfirm(false)}>{localize(locale, "Để sau", "Later")}</Button>
        <Button variant="contained" onClick={() => { setConfirm(false); void apply(); }}>{localize(locale, "Cập nhật", "Update")}</Button></DialogActions>
    </Dialog>
  </>;
}

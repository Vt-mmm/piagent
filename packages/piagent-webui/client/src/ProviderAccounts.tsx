import { useEffect, useState } from "react";
import CheckCircleRounded from "@mui/icons-material/CheckCircleRounded";
import LaunchRounded from "@mui/icons-material/LaunchRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { cancelProviderAuth, readProviderAuthJob, respondProviderAuth, startProviderAuth,
  type ProviderAuthCatalog, type ProviderAuthJob } from "./api.ts";
import { ServiceIcon } from "./ServiceIcon.tsx";
import { label } from "./view-model.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

export function ProviderAccounts({ catalog, refresh }: { catalog?: ProviderAuthCatalog; refresh(): Promise<void> }) {
  const { locale } = useUiPreferences();
  const [job, setJob] = useState<ProviderAuthJob>(), [promptValue, setPromptValue] = useState(""), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const controller = new AbortController(); const timer = window.setTimeout(() => {
      void readProviderAuthJob(job.jobRef, controller.signal).then((value) => {
        setJob(value); if (value.state === "completed") void refresh();
      }).catch(() => { if (!controller.signal.aborted) setError(localize(locale, "Mất kết nối với luồng OAuth", "OAuth flow disconnected")); });
    }, 750);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [job?.jobRef, job?.generatedAt, job?.state, locale]);
  useEffect(() => setPromptValue(""), [job?.prompt?.promptRef]);
  const start = async (providerRef: string) => {
    setBusy(true); setError(null);
    try { setJob(await startProviderAuth(providerRef)); }
    catch { setError(localize(locale, "Không thể bắt đầu OAuth", "Could not start OAuth")); }
    finally { setBusy(false); }
  };
  const respond = async () => {
    if (!job?.prompt || !promptValue) return;
    setBusy(true); setError(null);
    try { setJob(await respondProviderAuth(job.jobRef, job.prompt.promptRef, promptValue)); }
    catch { setError(localize(locale, "Bước xác thực đã hết hạn", "Authentication step expired")); }
    finally { setBusy(false); }
  };
  const close = async () => {
    if (job?.state === "running") await cancelProviderAuth(job.jobRef).catch(() => undefined);
    setJob(undefined); setError(null);
  };
  const latestEvents = job?.events.slice(-4) ?? [];
  return <>
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "repeat(2,minmax(0,1fr))" }, gap: 1 }}>
      {(catalog?.providers ?? []).map((provider) => <Paper variant="outlined" key={provider.providerRef} sx={{ p: 1.75, borderRadius: 2.5 }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1.25 }}><ServiceIcon name={provider.name} size={38} />
          <Typography sx={{ flex: 1, fontWeight: 800 }}>{provider.name}</Typography>{provider.state === "connected"
            ? <Chip size="small" color="success" variant="outlined" icon={<CheckCircleRounded />} label={localize(locale, "Đã kết nối", "Connected")} />
            : <Button size="small" variant="outlined" disabled={busy} onClick={() => void start(provider.providerRef)}>
              {localize(locale, "Kết nối", "Connect")}</Button>}</Stack>
      </Paper>)}
    </Box>
    {catalog && catalog.providers.length === 0 && <Typography color="text.secondary">{localize(locale, "Pi chưa có provider OAuth", "No OAuth providers available")}</Typography>}
    {error && !job && <Typography role="status" color="error" variant="body2" sx={{ mt: 1 }}>{error}</Typography>}
    <Dialog open={Boolean(job)} onClose={() => void close()} fullWidth maxWidth="xs">
      <DialogTitle>{job?.providerName ?? "OAuth"}</DialogTitle><DialogContent>
        <Stack spacing={1.25} sx={{ pt: .5 }}>
          {job?.state === "completed" && <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}><CheckCircleRounded color="success" />
            <Typography>{localize(locale, "Đã kết nối", "Connected")}</Typography></Stack>}
          {latestEvents.map((event) => <Box key={event.sequence}>
            {event.message && <Typography variant="body2" color="text.secondary">{event.message}</Typography>}
            {event.userCode && <Typography sx={{ my: 1, fontFamily: "monospace", fontSize: "1.35rem", fontWeight: 800, letterSpacing: ".12em" }}>{event.userCode}</Typography>}
            {event.url && <Button component="a" href={event.url} target="_blank" rel="noopener noreferrer" variant="outlined" size="small" endIcon={<LaunchRounded />}>
              {localize(locale, "Mở trang xác thực", "Open authentication")}</Button>}
            {event.links.map((link) => <Button key={link.url} component="a" href={link.url} target="_blank" rel="noopener noreferrer" size="small">
              {link.label ?? localize(locale, "Mở liên kết", "Open link")}</Button>)}
          </Box>)}
          {job?.prompt && <Box><Typography variant="body2" sx={{ mb: 1 }}>{job.prompt.message}</Typography>{job.prompt.type === "select"
            ? <Select fullWidth size="small" value={promptValue} onChange={(event) => setPromptValue(event.target.value)}>
              {job.prompt.options.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}</Select>
            : <TextField fullWidth size="small" value={promptValue} placeholder={job.prompt.placeholder ?? undefined}
              onChange={(event) => setPromptValue(event.target.value)} />}</Box>}
          {job && ["failed", "cancelled"].includes(job.state) && <Typography color="error" variant="body2">{label(job.reasonCode ?? job.state, locale)}</Typography>}
          {error && <Typography role="status" color="error" variant="body2">{error}</Typography>}
        </Stack>
      </DialogContent><DialogActions><Button color="inherit" onClick={() => void close()}>{job?.state === "running" ? localize(locale, "Hủy", "Cancel")
        : localize(locale, "Đóng", "Close")}</Button>{job?.prompt && <Button variant="contained" disabled={busy || !promptValue} onClick={() => void respond()}>
          {localize(locale, "Tiếp tục", "Continue")}</Button>}</DialogActions>
    </Dialog>
  </>;
}

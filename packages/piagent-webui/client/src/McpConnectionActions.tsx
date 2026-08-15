import { useEffect, useState } from "react";
import CheckCircleOutlineRounded from "@mui/icons-material/CheckCircleOutlineRounded";
import LaunchRounded from "@mui/icons-material/LaunchRounded";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { cancelMcpAuthJob, executeSessionConnection, readMcpAuthJob, type McpAuthJob, type SessionConnections } from "./api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

type Connection = SessionConnections["connections"][number];

export function mcpConnectionSubtitle(connection: Connection, locale: "vi" | "en"): string {
  const name = connection.name.toLowerCase();
  if (name === "figma-desktop") return localize(locale, "Cần bật MCP trong Figma Desktop", "Enable MCP in Figma Desktop");
  if (name === "figma") return connection.state === "disabled"
    ? localize(locale, "Remote OAuth · chưa được Figma duyệt", "Remote OAuth · not approved by Figma")
    : "Remote OAuth";
  return `${connection.transport} · ${connection.scope}`;
}

function oauthFailure(reasonCode: string | null | undefined, connectionName: string, locale: "vi" | "en"): string {
  if (reasonCode === "mcp-oauth-client-not-approved" && connectionName.toLowerCase() === "figma") {
    return localize(locale, "Figma Remote chưa cho phép Piagent đăng ký OAuth. Anh có thể dùng kết nối Figma Desktop bên dưới.",
      "Figma Remote has not approved Piagent as an OAuth client. You can use the Figma Desktop connection below.");
  }
  if (reasonCode === "mcp-oauth-client-not-approved") return localize(locale, "Nhà cung cấp chưa cho phép client OAuth này.",
    "The provider has not approved this OAuth client.");
  if (reasonCode === "mcp-oauth-registration-rejected") return localize(locale, "Nhà cung cấp từ chối đăng ký OAuth.",
    "The provider rejected OAuth client registration.");
  if (reasonCode === "mcp-oauth-cancelled" || reasonCode === "cancelled-by-user") return localize(locale, "Đã hủy đăng nhập.", "Sign in cancelled.");
  return localize(locale, "Không thể kết nối OAuth. Vui lòng thử lại.", "Could not connect OAuth. Please try again.");
}

export function McpConnectionActions({ sessionRef, connection, onChanged, compact = false }: { sessionRef: string; connection: Connection;
  onChanged(value?: SessionConnections): void; compact?: boolean }) {
  const { locale } = useUiPreferences();
  const [busy, setBusy] = useState(false), [job, setJob] = useState<McpAuthJob>(), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const controller = new AbortController(), timer = window.setTimeout(() => void readMcpAuthJob(job.jobRef, controller.signal).then((value) => {
      setJob(value); if (value.state === "completed") onChanged();
    }).catch(() => setError(localize(locale, "Mất kết nối OAuth", "OAuth flow disconnected"))), 750);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [job?.jobRef, job?.generatedAt, job?.state, locale, onChanged]);
  const runToggle = async (enabled: boolean) => {
    setBusy(true); setError(null);
    try {
      const result = await executeSessionConnection({ action: enabled ? "mcp.enable" : "mcp.disable", sessionRef,
        connectionRef: connection.connectionRef });
      if ("connections" in result) onChanged(result); else onChanged();
    } catch { setError(localize(locale, "Không thể cập nhật MCP", "Could not update MCP")); }
    finally { setBusy(false); }
  };
  const startOAuth = async () => {
    setBusy(true); setError(null);
    try {
      const result = await executeSessionConnection({ action: "mcp.oauth", sessionRef, connectionRef: connection.connectionRef });
      if ("jobRef" in result) setJob(result); else throw new Error("mcp-oauth-job-missing");
    } catch { setError(localize(locale, "Không thể bắt đầu OAuth", "Could not start OAuth")); }
    finally { setBusy(false); }
  };
  const close = async () => {
    if (job?.state === "running") await cancelMcpAuthJob(job.jobRef).catch(() => undefined);
    setJob(undefined); setError(null);
  };
  return <>
    <Stack direction="row" spacing={.75} sx={{ alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
      {connection.authState === "connected" && <Chip size="small" color="success" variant="outlined" icon={<CheckCircleOutlineRounded />}
        label={localize(locale, "Đã kết nối", "Connected")} />}
      {connection.oauthSupported && connection.authState !== "connected" && connection.state !== "disabled" && <Button size="small" variant="outlined"
        disabled={busy} onClick={() => void startOAuth()}>OAuth</Button>}
      {connection.toggleSupported && <Tooltip title={connection.state === "disabled" ? localize(locale, `Bật ${connection.name}`, `Enable ${connection.name}`)
        : localize(locale, `Tắt ${connection.name}`, `Disable ${connection.name}`)} arrow><span><Switch size={compact ? "small" : "medium"}
          checked={connection.state !== "disabled"} disabled={busy} onChange={(_, checked) => void runToggle(checked)}
          slotProps={{ input: { "aria-label": connection.state === "disabled" ? localize(locale, `Bật ${connection.name}`, `Enable ${connection.name}`)
            : localize(locale, `Tắt ${connection.name}`, `Disable ${connection.name}`) } }} /></span></Tooltip>}
    </Stack>
    {error && <Typography role="status" color="error" variant="caption">{error}</Typography>}
    <Dialog open={Boolean(job)} onClose={() => void close()} fullWidth maxWidth="xs">
      <DialogTitle>{connection.name} · OAuth</DialogTitle><DialogContent><Stack spacing={1.25} sx={{ pt: .5 }}>
        {job?.state === "running" && !job.authorizationUrl && <Typography color="text.secondary">{localize(locale, "Đang chuẩn bị đăng nhập…", "Preparing sign in…")}</Typography>}
        {job?.authorizationUrl && <Button component="a" href={job.authorizationUrl} target="_blank" rel="noopener noreferrer" variant="contained"
          endIcon={<LaunchRounded />}>{localize(locale, "Mở trang đăng nhập", "Open sign in")}</Button>}
        {job?.state === "completed" && <Typography color="success.main">{localize(locale, "Đã kết nối MCP", "MCP connected")}</Typography>}
        {job && ["failed", "cancelled"].includes(job.state) && <Typography color="error">{oauthFailure(job.reasonCode, connection.name, locale)}</Typography>}
      </Stack></DialogContent><DialogActions><Button color="inherit" onClick={() => void close()}>{job?.state === "running"
        ? localize(locale, "Hủy", "Cancel") : localize(locale, "Đóng", "Close")}</Button></DialogActions>
    </Dialog>
  </>;
}

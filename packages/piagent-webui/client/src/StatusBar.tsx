import SystemUpdateAltRounded from "@mui/icons-material/SystemUpdateAltRounded";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";

import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import { BranchSwitcher } from "./BranchSwitcher.tsx";
import { localize, type UiLocale } from "./ui-preferences.tsx";
import { updateInProgress, useUpdates } from "./update-state.tsx";

// The dashboard's status bar, as in an editor: where the Gateway stands, what
// runs, the open conversation's Git branch, the release and its update, and
// the command palette. Hidden on narrow screens, where the Settings button
// carries the update dot and the header shows the branch.
export const STATUS_BAR_HEIGHT = 28;
export const modifierKey = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const staticSx = { height: STATUS_BAR_HEIGHT, px: 1, gap: .75, fontSize: 12, color: "text.secondary", alignItems: "center" };
const itemSx = { ...staticSx, borderRadius: 0, "&:hover": { bgcolor: "action.hover", color: "text.primary" },
  "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: -2 } };

export function StatusBar({ locale, connection, running, session, onBranchSwitched, onUpdates, onPalette }: { locale: UiLocale; connection: string; running: number;
  session?: SessionRow; onBranchSwitched?(): void; onUpdates(): void; onPalette(): void }) {
  const { status, supported } = useUpdates();
  const wide = useMediaQuery((theme: import("@mui/material/styles").Theme) => theme.breakpoints.up("md"));
  const updating = updateInProgress(status), available = Boolean(status?.updateAvailable && status.installable);
  const release = status?.piagent.installed ? `Piagent ${status.piagent.installed}${status.pi.installed ? ` · Pi ${status.pi.installed}` : ""}` : "Piagent";
  if (!wide) return null;
  return <Box component="footer" aria-label={localize(locale, "Thanh trạng thái", "Status bar")} sx={{ position: "fixed", left: 0, right: 0, bottom: 0,
    height: STATUS_BAR_HEIGHT, display: "flex", alignItems: "stretch", borderTop: 1, borderColor: "divider",
    bgcolor: "background.paper", zIndex: (theme) => theme.zIndex.drawer + 1, whiteSpace: "nowrap" }}>
    <Stack direction="row" sx={staticSx}>
      <Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: connection === "connected" ? "success.main" : "warning.main" }} />
      <span>{connection === "connected" ? "Gateway live" : connection}</span><Box component="span" sx={{ color: "text.disabled" }}>local</Box></Stack>
    {session?.gitBranch && <Stack direction="row" sx={{ ...staticSx, minWidth: 0 }}><BranchSwitcher projectRef={session.projectRef} projectLabel={session.projectLabel}
      branch={session.gitBranch} locale={locale} maxWidth={320} onSwitched={onBranchSwitched} /></Stack>}
    {running > 0 && <Stack direction="row" sx={staticSx}>
      <CircularProgress size={10} thickness={6} /><span>{localize(locale, `${running} đang chạy`, `${running} running`)}</span></Stack>}
    <Box sx={{ flex: 1 }} />
    {supported && <Tooltip describeChild title={available ? localize(locale, "Mở Cập nhật trong Cài đặt", "Open Updates in Settings") : localize(locale, "Phiên bản và cập nhật", "Version and updates")}>
      <ButtonBase onClick={onUpdates} sx={{ ...itemSx, ...(available && { color: "primary.contrastText", bgcolor: "primary.main", fontWeight: 700,
        "&:hover": { bgcolor: "primary.dark", color: "primary.contrastText" } }) }}>
        {updating ? <><CircularProgress size={11} thickness={6} color="inherit" />{localize(locale, `Đang cập nhật lên ${status?.job?.to}…`, `Updating to ${status?.job?.to}…`)}</>
          : available ? <><SystemUpdateAltRounded sx={{ fontSize: 15 }} />{localize(locale, `Cập nhật Piagent ${status?.piagent.latest}`, `Update Piagent ${status?.piagent.latest}`)}</>
            : <span>{release}</span>}</ButtonBase></Tooltip>}
    <ButtonBase onClick={onPalette} aria-label={localize(locale, "Mở bảng lệnh", "Open command palette")} sx={itemSx}>
      <Box component="kbd" sx={{ font: "inherit", fontSize: 11, px: .6, border: 1, borderColor: "divider", borderRadius: .75 }}>{modifierKey()} K</Box>
      <span>{localize(locale, "Lệnh", "Commands")}</span></ButtonBase>
  </Box>;
}

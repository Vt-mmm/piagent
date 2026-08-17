import CloseRounded from "@mui/icons-material/CloseRounded";
import DashboardRounded from "@mui/icons-material/DashboardRounded";
import DescriptionRounded from "@mui/icons-material/DescriptionRounded";
import DifferenceRounded from "@mui/icons-material/DifferenceRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import TerminalRounded from "@mui/icons-material/TerminalRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { SessionAgentWorkspace, type SessionWorkspaceId } from "./SessionAgentWorkspace.tsx";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

const INSPECTOR_WIDTH = "min(54vw, 980px)";

export function SessionInspectorDrawer({ open, active, snapshot, state, sessionRef, onClose, onActive, refresh }: { open: boolean;
  active: SessionWorkspaceId; snapshot?: PiagentWebUICanonicalSnapshotV1; state: "idle" | "loading" | "ready" | "error";
  sessionRef?: string; onClose(): void; onActive(value: SessionWorkspaceId): void;
  refresh(): Promise<PiagentWebUICanonicalSnapshotV1 | undefined> }) {
  const { locale } = useUiPreferences();
  const theme = useTheme(), desktop = useMediaQuery(theme.breakpoints.up("lg"));
  const sourceCount = snapshot?.sourceChanges.workingTree.counts.files ?? 0;
  return <Drawer anchor="right" variant={desktop ? "persistent" : "temporary"} open={open} onClose={onClose}
    sx={{ "& .MuiDrawer-paper": { width: { xs: "100%", sm: "min(88vw, 980px)", lg: INSPECTOR_WIDTH }, bgcolor: "background.default" } }}>
    <Box sx={{ position: "sticky", top: 0, zIndex: 3, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider" }}>
      <Stack direction="row" sx={{ minHeight: 64, px: { xs: 1.5, md: 2 }, alignItems: "center", gap: 1 }}><Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 820 }}>{localize(locale, "Agent Inspector", "Agent Inspector")}</Typography>
        <Typography variant="caption" color="text.secondary">{localize(locale, "Task contract · Git truth · verifier", "Task contract · Git truth · verifier")}</Typography></Box>
        <Tooltip title={localize(locale, "Làm mới Inspector", "Refresh Inspector")}><IconButton onClick={() => void refresh()}><RefreshRounded fontSize="small" /></IconButton></Tooltip>
        <IconButton aria-label={localize(locale, "Đóng Inspector", "Close Inspector")} onClick={onClose}><CloseRounded /></IconButton></Stack>
      <Tabs value={active} onChange={(_, value: SessionWorkspaceId) => onActive(value)} variant="scrollable" scrollButtons="auto">
        <Tab value="task" icon={<DashboardRounded />} iconPosition="start" label={snapshot?.task
          ? `${localize(locale, "Task", "Task")} · ${snapshot.task.progress.completed}/${snapshot.task.progress.total}` : localize(locale, "Task", "Task")} />
        <Tab value="source" icon={<DifferenceRounded />} iconPosition="start" label={`Source Changes${sourceCount ? ` · ${sourceCount}` : ""}`} />
        <Tab value="documents" icon={<DescriptionRounded />} iconPosition="start" label={localize(locale, "Tài liệu", "Documents")} />
        <Tab value="activity" icon={<TerminalRounded />} iconPosition="start" label={`${localize(locale, "Activity", "Activity")}${snapshot?.activity.running.length ? ` · ${snapshot.activity.running.length}` : ""}`} />
      </Tabs>
    </Box>
    {state === "loading" ? <Stack sx={{ alignItems: "center", py: 12 }} spacing={1.5}><CircularProgress size={25} /><Typography color="text.secondary">
      {localize(locale, "Đang dựng Inspector từ session và Git…", "Building the Inspector from the session and Git…")}</Typography></Stack>
      : state === "error" || !snapshot || !sessionRef ? <Stack sx={{ p: 3, maxWidth: 720 }} spacing={2}><Alert severity="warning">{localize(locale,
        "Không thể dựng Inspector cho session này. Chat vẫn an toàn; hãy kiểm tra project còn tồn tại và thử làm mới.",
        "The Inspector could not be built for this session. Chat remains safe; check that the project still exists and refresh.")}</Alert>
        <Button variant="outlined" onClick={() => void refresh()}>{localize(locale, "Thử lại", "Try again")}</Button></Stack>
        : <Box sx={{ p: active === "source" ? { xs: 1, md: 1.5 } : { xs: 1.5, sm: 2.5, xl: 3 }, maxWidth: active === "source" ? "none" : 1500, mx: "auto", width: "100%" }}>
          <SessionAgentWorkspace active={active} snapshot={snapshot} sessionRef={sessionRef} refresh={refresh} /></Box>}
  </Drawer>;
}

import { useEffect, useMemo, useState } from "react";
import DataUsageRounded from "@mui/icons-material/DataUsageRounded";
import DifferenceRounded from "@mui/icons-material/DifferenceRounded";
import HubRounded from "@mui/icons-material/HubRounded";
import ModelTrainingOutlined from "@mui/icons-material/ModelTrainingOutlined";
import ShieldOutlined from "@mui/icons-material/ShieldOutlined";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Popover from "@mui/material/Popover";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import { readSessionCreationOptions, type SessionConnections, type SessionCreationOptions } from "./api.ts";
import { ServiceIcon } from "./ServiceIcon.tsx";
import { McpConnectionActions, mcpConnectionSubtitle } from "./McpConnectionActions.tsx";
import { ActionConfirmationDialog } from "./ActionConfirmationDialog.tsx";
import { label } from "./view-model.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

type Panel = "model" | "context" | "connections" | "permission" | "changes" | null;

function Stat({ name, value }: { name: string; value: string }) {
  return <Stack direction="row" sx={{ justifyContent: "space-between", gap: 3, py: .65 }}>
    <Typography variant="body2" color="text.secondary">{name}</Typography><Typography variant="body2" sx={{ fontWeight: 600 }}>{value}</Typography>
  </Stack>;
}

function ComposerControl({ title, label: controlLabel, icon, active, badge, onClick }: { title: string; label?: string;
  icon: React.ReactNode; active: boolean; badge?: number; onClick(event: React.MouseEvent<HTMLElement>): void }) {
  const shared = { border: 1, borderColor: active ? "primary.main" : "divider", bgcolor: active ? "action.selected" : "transparent",
    color: active ? "primary.main" : "text.secondary", borderRadius: 2, "&:hover": { bgcolor: "action.hover", color: "text.primary" } };
  const button = controlLabel ? <Button size="small" aria-label={title} onClick={onClick} startIcon={icon} sx={{ ...shared, minHeight: 34,
    maxWidth: 260, px: 1.15, "& .MuiButton-startIcon": { mr: .65 }, "& .MuiButton-startIcon svg": { fontSize: 17 } }}>
    <Box component="span" sx={{ display: { xs: "none", md: "inline" }, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{controlLabel}</Box>
  </Button> : <IconButton size="small" aria-label={title} onClick={onClick} sx={{ ...shared, width: 34, height: 34 }}>{icon}</IconButton>;
  return <Tooltip title={title} arrow>{!badge ? button : <Badge badgeContent={badge} color="primary" max={9999}
    sx={{ "& .MuiBadge-badge": { height: 16, minWidth: 16, px: .4, fontSize: 9, fontWeight: 700 } }}>{button}</Badge>}</Tooltip>;
}

export function SessionComposerControls({ session, snapshot, connections, locale, onOpenChanges, canSetModel, canSetThinking, canSetPermission, onSetModel, onSetThinking, onSetPermission,
  onConnectionsChanged, placement = "composer" }: { session: SessionRow;
  snapshot?: PiagentWebUICanonicalSnapshotV1; connections?: SessionConnections; locale: UiLocale; onOpenChanges(): void;
  canSetModel?: boolean; canSetThinking?: boolean; canSetPermission?: boolean; onSetModel?(modelRef: string): Promise<unknown>;
  onSetThinking?(thinking: string): Promise<unknown>; onSetPermission?(mode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<unknown>;
  onConnectionsChanged?(value?: SessionConnections): void; placement?: "header" | "composer" }) {
  const [panel, setPanel] = useState<Panel>(null), [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [options, setOptions] = useState<SessionCreationOptions>(), [optionBusy, setOptionBusy] = useState(false), [optionError, setOptionError] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<"trusted-full-access" | null>(null);
  useEffect(() => {
    if (placement !== "header") return;
    const controller = new AbortController(); void readSessionCreationOptions(controller.signal).then(setOptions).catch(() => undefined);
    return () => controller.abort();
  }, [placement]);
  const open = (value: Exclude<Panel, null>) => (event: React.MouseEvent<HTMLElement>) => { setPanel(value); setAnchor(event.currentTarget); };
  const close = () => { setPanel(null); setAnchor(null); };
  const source = snapshot?.sourceChanges;
  const sourceCount = source?.workingTree.counts.files ?? 0;
  const permission = snapshot?.session.permissionProfile as { state?: string; value?: string | null } | undefined;
  const [permissionValue, setPermissionValue] = useState<string | null>(permission?.state === "known" ? permission.value ?? null : null);
  useEffect(() => { setPermissionValue(null); }, [session.sessionRef]);
  useEffect(() => { if (permission?.state === "known") setPermissionValue(permission.value ?? null); }, [permission?.state, permission?.value]);
  const snapshotContext = snapshot?.usage.context;
  const contextKnown = snapshotContext?.state === "known";
  const contextTokens = contextKnown ? snapshotContext.tokens : session.contextUsage.usedTokens;
  const contextWindow = contextKnown ? snapshotContext.contextWindow : session.contextUsage.contextWindow;
  const contextPercentValue = contextKnown ? snapshotContext.percent
    : session.contextUsage.ratio === null ? null : session.contextUsage.ratio * 100;
  const contextPercent = contextPercentValue === null || contextPercentValue === undefined ? "—" : `${Math.round(contextPercentValue)}%`;
  const activeModelRef = snapshot?.session.model.state === "known" && snapshot.session.model.value ? snapshot.session.model.value.modelRef : "";
  const activeModel = options?.models.find((model) => model.modelRef === activeModelRef);
  const thinkingLevels = useMemo(() => activeModel?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"], [activeModel]);
  const changeModel = async (modelRef: string) => { if (!modelRef || !onSetModel) return; setOptionBusy(true); setOptionError(null);
    try { await onSetModel(modelRef); } catch { setOptionError(localize(locale, "Chưa thể đổi model lúc này", "Could not change the model right now")); }
    finally { setOptionBusy(false); } };
  const changeThinking = async (value: string) => { if (!onSetThinking) return; setOptionBusy(true); setOptionError(null);
    try { await onSetThinking(value); } catch { setOptionError(localize(locale, "Chưa thể đổi thinking lúc này", "Could not change thinking right now")); }
    finally { setOptionBusy(false); } };
  const applyPermission = async (value: "read-only" | "workspace-write" | "trusted-full-access") => {
    if (!onSetPermission) return;
    setOptionBusy(true); setOptionError(null);
    try { await onSetPermission(value); setPermissionValue(value); }
    catch { setOptionError(localize(locale, "Chưa thể đổi quyền lúc này", "Could not change access right now")); }
    finally { setOptionBusy(false); }
  };
  const changePermission = (value: "read-only" | "workspace-write" | "trusted-full-access") => {
    if (value === "trusted-full-access") { close(); setPendingPermission(value); return; }
    void applyPermission(value);
  };
  const panelTitle = panel === "model" ? "Model & thinking" : panel === "context" ? "Context"
    : panel === "connections" ? localize(locale, "MCP & kết nối", "MCP & connections") : panel === "permission" ? localize(locale, "Quyền", "Access")
      : localize(locale, "Source Changes", "Source Changes");
  return <>
    <Box sx={{ display: "flex", gap: .65, mb: placement === "composer" ? .8 : 0, px: .1, flexWrap: "wrap", alignItems: "center",
      justifyContent: placement === "header" ? "flex-end" : "flex-start" }}>
      {placement === "header" && <ComposerControl active={panel === "model"} onClick={open("model")} icon={<ModelTrainingOutlined fontSize="small" />}
        label={`${session.modelLabel ?? localize(locale, "Model session", "Session model")} · ${label(session.thinkingLevel, locale)}`}
        title={localize(locale, "Đổi model và mức suy luận", "Change model and thinking level")} />}
      {placement === "header" && <ComposerControl active={panel === "permission"} onClick={open("permission")} icon={<ShieldOutlined fontSize="small" />}
        label={permissionValue ? label(permissionValue, locale) : localize(locale, "Quyền", "Access")}
        title={localize(locale, "Đổi quyền truy cập", "Change access level")} />}
      {placement === "composer" && <ComposerControl active={panel === "context"} onClick={open("context")} icon={<DataUsageRounded fontSize="small" />}
        title={`Context · ${contextPercent}`} />}
      {placement === "composer" && <ComposerControl active={panel === "connections"} onClick={open("connections")} icon={<HubRounded fontSize="small" />}
        badge={connections?.summary.configured ?? 0} title={(connections?.summary.configured ?? 0) > 0
          ? localize(locale, `MCP & kết nối · ${connections?.summary.configured}`, `MCP & connections · ${connections?.summary.configured}`)
          : localize(locale, "MCP & kết nối", "MCP & connections")} />}
      {placement === "composer" && <ComposerControl active={panel === "changes"} onClick={open("changes")} icon={<DifferenceRounded fontSize="small" />}
        badge={sourceCount} title={`Source Changes${sourceCount ? ` · ${sourceCount}` : ""}`} />}
    </Box>
    <Popover open={panel !== null} anchorEl={anchor} onClose={close} anchorOrigin={{ vertical: placement === "header" ? "bottom" : "top", horizontal: "left" }}
      transformOrigin={{ vertical: placement === "header" ? "top" : "bottom", horizontal: "left" }}
      slotProps={{ paper: { sx: { width: 330, maxWidth: "calc(100vw - 24px)", borderRadius: 2.5, p: 1.5,
        mt: placement === "header" ? 1 : 0 } } }}>
      <Typography sx={{ px: .5, pb: 1, fontWeight: 600 }}>{panelTitle}</Typography><Divider />
      {panel === "model" && <Stack sx={{ px: .5, pt: 1 }} spacing={1.25}>
        <Box><Typography variant="caption" color="text.secondary">Model</Typography><Select fullWidth size="small" value={activeModelRef}
          disabled={!canSetModel || optionBusy || session.liveState === "running"} onChange={(event) => void changeModel(event.target.value)} sx={{ mt: .5 }}>
          {(options?.models ?? []).map((model) => <MenuItem key={model.modelRef} value={model.modelRef}>{model.displayName}</MenuItem>)}</Select></Box>
        <Box><Typography variant="caption" color="text.secondary">Thinking</Typography><Select fullWidth size="small" value={session.thinkingLevel === "unknown" ? "off" : session.thinkingLevel}
          disabled={!canSetThinking || optionBusy || session.liveState === "running"} onChange={(event) => void changeThinking(event.target.value)} sx={{ mt: .5 }}>
          {thinkingLevels.map((value) => <MenuItem key={value} value={value}>{label(value, locale)}</MenuItem>)}</Select></Box>
        {optionError && <Typography role="status" color="error" variant="caption">{optionError}</Typography>}
      </Stack>}
      {panel === "context" && <Box sx={{ px: .5, pt: .75 }}><Stat name={localize(locale, "Đã dùng", "Used")} value={contextPercent} />
        <Stat name="Tokens" value={contextTokens === null ? "—" : new Intl.NumberFormat().format(contextTokens)} />
        <Stat name="Window" value={contextWindow === null ? "—" : new Intl.NumberFormat().format(contextWindow)} /></Box>}
      {panel === "connections" && <List dense disablePadding sx={{ pt: .5 }}>{(connections?.connections ?? []).map((connection) => <ListItem key={connection.connectionRef}
        sx={{ alignItems: "center", gap: .5 }}>
        <ListItemIcon sx={{ minWidth: 38 }}><ServiceIcon name={connection.name} size={28} /></ListItemIcon>
        <ListItemText primary={connection.name} secondary={mcpConnectionSubtitle(connection, locale)} />
        <McpConnectionActions compact sessionRef={session.sessionRef} connection={connection} onChanged={(value) => onConnectionsChanged?.(value)} /></ListItem>)}
        {connections && connections.connections.length === 0 && <ListItem><ListItemText primary={localize(locale, "Chưa có MCP", "No MCP configured")} /></ListItem>}
        {!connections && <ListItem><ListItemText primary={localize(locale, "Đang đọc…", "Loading…")} /></ListItem>}</List>}
      {panel === "permission" && <Stack sx={{ px: .5, pt: 1 }} spacing={.75}>{(["read-only", "workspace-write", "trusted-full-access"] as const).map((value) =>
        <Button key={value} variant={permissionValue === value ? "contained" : "outlined"} color={value === "trusted-full-access" ? "warning" : "primary"}
          disabled={!canSetPermission || optionBusy || session.liveState === "running"} onClick={() => changePermission(value)} sx={{ justifyContent: "flex-start" }}>
          {label(value, locale)}</Button>)}{optionError && <Typography role="status" color="error" variant="caption">{optionError}</Typography>}</Stack>}
      {panel === "changes" && <Box sx={{ px: .5, pt: .75 }}><Stat name={localize(locale, "Task changes", "Task changes")} value={String(source?.task?.counts.files ?? 0)} />
        <Stat name={localize(locale, "Working tree", "Working tree")} value={String(source?.workingTree.counts.files ?? 0)} />
        <Stat name={localize(locale, "Staged", "Staged")} value={String(source?.staged.counts.files ?? 0)} />
        <Button fullWidth variant="outlined" startIcon={<DifferenceRounded />} sx={{ mt: 1 }} onClick={() => { close(); onOpenChanges(); }}>
          {localize(locale, "Mở Source Changes", "Open Source Changes")}</Button></Box>}
    </Popover>
    <ActionConfirmationDialog open={pendingPermission !== null} title={localize(locale, "Bật toàn quyền?", "Enable full access?")}
      description={localize(locale, "Session này sẽ được phép đọc, sửa file và chạy command trong phạm vi runtime. Các thao tác xóa hoặc gửi dữ liệu ra ngoài vẫn cần anh xác nhận riêng.",
        "This session will be allowed to read and edit files and run commands within the runtime. Destructive actions and external data transfers still require separate confirmation.")}
      cancelLabel={localize(locale, "Hủy", "Cancel")} confirmLabel={localize(locale, "Bật toàn quyền", "Enable full access")}
      onCancel={() => setPendingPermission(null)} onConfirm={() => { setPendingPermission(null); void applyPermission("trusted-full-access"); }} />
  </>;
}

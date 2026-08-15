import { useEffect, useMemo, useState } from "react";
import CloseRounded from "@mui/icons-material/CloseRounded";
import DarkModeRounded from "@mui/icons-material/DarkModeRounded";
import HubRounded from "@mui/icons-material/HubRounded";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import LanguageRounded from "@mui/icons-material/LanguageRounded";
import LightModeRounded from "@mui/icons-material/LightModeRounded";
import MemoryRounded from "@mui/icons-material/MemoryRounded";
import PsychologyRounded from "@mui/icons-material/PsychologyRounded";
import SecurityRounded from "@mui/icons-material/SecurityRounded";
import TuneRounded from "@mui/icons-material/TuneRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { PiagentGatewayCapabilityHandshakeV1 } from "../../contracts/generated/gateway-capabilities-v1.ts";
import { readProviderAuthCatalog, readSessionConnections, readSessionCreationOptions, type ProviderAuthCatalog,
  type SessionConnections, type SessionCreationOptions } from "./api.ts";
import { ProviderAccounts } from "./ProviderAccounts.tsx";
import { McpConnectionActions, mcpConnectionSubtitle } from "./McpConnectionActions.tsx";
import { ServiceIcon } from "./ServiceIcon.tsx";
import { ActionConfirmationDialog } from "./ActionConfirmationDialog.tsx";
import { label } from "./view-model.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

export type SettingsSection = "general" | "models" | "connections" | "permissions" | "usage" | "about";

function number(value: number | null | undefined, locale: UiLocale): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US").format(value);
}

function Title({ children }: { children: React.ReactNode }) {
  return <Typography component="h1" variant="h1" sx={{ mb: 3 }}>{children}</Typography>;
}

function SettingRow({ icon, title, detail, action }: { icon: React.ReactNode; title: string; detail?: string; action: React.ReactNode }) {
  return <Stack direction={{ xs: "column", sm: "row" }} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between", gap: 2, p: 2.25 }}>
    <Stack direction="row" spacing={1.4} sx={{ alignItems: "center" }}>{icon}<Box><Typography sx={{ fontWeight: 760 }}>{title}</Typography>
      {detail && <Typography variant="body2" color="text.secondary">{detail}</Typography>}</Box></Stack>{action}</Stack>;
}

function GeneralSettings() {
  const { locale, colorMode, setLocale, setColorMode } = useUiPreferences();
  return <><Title>{localize(locale, "Giao diện", "Appearance")}</Title><Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: "hidden" }}>
    <SettingRow icon={<LanguageRounded color="primary" />} title={localize(locale, "Ngôn ngữ", "Language")}
      action={<ToggleButtonGroup exclusive size="small" value={locale} onChange={(_, value) => value && setLocale(value)}>
        <ToggleButton value="vi">VI</ToggleButton><ToggleButton value="en">EN</ToggleButton></ToggleButtonGroup>} />
    <Divider /><SettingRow icon={colorMode === "dark" ? <DarkModeRounded color="primary" /> : <LightModeRounded color="primary" />}
      title={localize(locale, "Chủ đề", "Theme")} action={<ToggleButtonGroup exclusive size="small" value={colorMode}
        onChange={(_, value) => value && setColorMode(value)}><ToggleButton value="light">{localize(locale, "Sáng", "Light")}</ToggleButton>
        <ToggleButton value="dark">{localize(locale, "Tối", "Dark")}</ToggleButton></ToggleButtonGroup>} />
  </Paper></>;
}

function ModelSettings({ options, auth, refreshAuth, session, snapshot, onSetModel, onSetThinking }: { options?: SessionCreationOptions; auth?: ProviderAuthCatalog;
  refreshAuth(): Promise<void>; session?: SessionRow; snapshot?: PiagentWebUICanonicalSnapshotV1;
  onSetModel?(modelRef: string): Promise<unknown>; onSetThinking?(thinking: string): Promise<unknown> }) {
  const { locale } = useUiPreferences();
  const [changing, setChanging] = useState(false), [changeError, setChangeError] = useState<string | null>(null);
  const observedModel = snapshot?.session.model.state === "known" ? snapshot.session.model.value : null;
  const providers = useMemo(() => {
    const grouped = new Map<string, SessionCreationOptions["models"]>();
    for (const model of options?.models ?? []) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    return [...grouped.entries()];
  }, [options]);
  const activeModelRef = observedModel?.modelRef ?? "";
  const activeModel = options?.models.find((value) => value.modelRef === activeModelRef);
  const modelValue = activeModel ? activeModelRef : "";
  const modelDisplay = observedModel?.displayName ?? session?.modelLabel ?? "—";
  const thinkingLevels = activeModel?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const change = async (run: (() => Promise<unknown>) | undefined) => { if (!run) return; setChanging(true); setChangeError(null);
    try { await run(); } catch { setChangeError(localize(locale, "Chưa thể áp dụng thay đổi", "Could not apply this change")); }
    finally { setChanging(false); } };
  return <><Title>{localize(locale, "Nhà cung cấp & model", "Providers & models")}</Title>
    {session && <Paper variant="outlined" sx={{ p: 2.25, borderRadius: 2.5, mb: 2 }}><Stack direction="row" spacing={1.25} sx={{ alignItems: "center", mb: 2 }}>
      <ServiceIcon name={observedModel?.provider ?? session.modelLabel ?? "model"} size={38} /><Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 700 }}>{localize(locale, "Model của session hiện tại", "Current session model")}</Typography>
        <Typography variant="body2" color="text.secondary" noWrap>{modelDisplay} · {label(session.thinkingLevel, locale)}</Typography></Box>
      <Chip size="small" variant="outlined" label={localize(locale, "Đang dùng", "In use")} /></Stack>
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
      <Box sx={{ flex: 1 }}><Typography variant="caption" color="text.secondary">Model</Typography><Select fullWidth size="small" value={modelValue} displayEmpty
        renderValue={(value) => value ? options?.models.find((model) => model.modelRef === value)?.displayName ?? modelDisplay : modelDisplay}
        disabled={changing || !onSetModel || session.liveState === "running"} onChange={(event) => void change(() => onSetModel?.(event.target.value) ?? Promise.resolve())} sx={{ mt: .5 }}>
        {(options?.models ?? []).map((model) => <MenuItem key={model.modelRef} value={model.modelRef}>{model.displayName}</MenuItem>)}</Select></Box>
      <Box sx={{ width: { md: 220 } }}><Typography variant="caption" color="text.secondary">Thinking</Typography><Select fullWidth size="small"
        value={session.thinkingLevel === "unknown" ? "off" : session.thinkingLevel} disabled={changing || !onSetThinking || session.liveState === "running"}
        onChange={(event) => void change(() => onSetThinking?.(event.target.value) ?? Promise.resolve())} sx={{ mt: .5 }}>
        {thinkingLevels.map((value) => <MenuItem key={value} value={value}>{label(value, locale)}</MenuItem>)}</Select></Box></Stack>
      {changeError && <Typography role="status" color="error" variant="caption" sx={{ mt: 1 }}>{changeError}</Typography>}</Paper>}
    <Typography variant="h2" sx={{ mt: 3, mb: .5 }}>{localize(locale, "Kết nối nhà cung cấp", "Provider connections")}</Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>{localize(locale,
      "Kết nối tài khoản để mở khóa model tương ứng.", "Connect an account to make its models available.")}</Typography>
    <ProviderAccounts catalog={auth} refresh={refreshAuth} />
    <Typography variant="h2" sx={{ mt: 3, mb: .5 }}>{localize(locale, "Danh mục model", "Model catalog")}</Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>{localize(locale,
      "Các model hiện có từ những provider đã xác thực.", "Models currently available from authenticated providers.")}</Typography>
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "repeat(2,minmax(0,1fr))" }, gap: 1 }}>
      {providers.map(([provider, models]) => <Paper variant="outlined" key={provider} sx={{ p: 1.5, borderRadius: 2 }}><Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <ServiceIcon name={provider} size={32} /><Box sx={{ flex: 1, minWidth: 0 }}><Typography noWrap sx={{ fontWeight: 700, textTransform: "capitalize" }}>{provider}</Typography>
          <Typography variant="body2" color="text.secondary">{models.length} model</Typography></Box><Chip size="small" color="success" variant="outlined" label={localize(locale, "Sẵn sàng", "Ready")} /></Stack>
        <Box sx={{ display: "flex", gap: .6, mt: 1.25, flexWrap: "wrap" }}>{models.slice(0, 6).map((model) => <Chip key={model.modelRef} size="small" variant="outlined" label={model.displayName} />)}
          {models.length > 6 && <Chip size="small" variant="outlined" label={`+${models.length - 6}`} />}</Box></Paper>)}</Box>
    {options && providers.length === 0 && <Typography color="text.secondary">{localize(locale, "Chưa có model đã xác thực", "No authenticated models")}</Typography>}
  </>;
}

function ConnectionSettings({ value, loading, sessionRef, onChanged }: { value?: SessionConnections; loading: boolean; sessionRef?: string;
  onChanged(value?: SessionConnections): void }) {
  const { locale } = useUiPreferences();
  return <><Title>{localize(locale, "MCP & kết nối", "MCP & connections")}</Title>
    {loading ? <CircularProgress size={22} /> : <Stack spacing={1}>
      {(value?.connections ?? []).map((connection) => <Paper variant="outlined" key={connection.connectionRef} sx={{ p: 1.75, borderRadius: 2.5 }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1.25 }}><ServiceIcon name={connection.name} size={38} /><Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 800 }}>{connection.name}</Typography><Typography variant="body2" color="text.secondary">{mcpConnectionSubtitle(connection, locale)}</Typography></Box>
          {sessionRef ? <McpConnectionActions sessionRef={sessionRef} connection={connection} onChanged={onChanged} />
            : <Chip size="small" variant="outlined" label={localize(locale, "Đã cấu hình", "Configured")} />}</Stack></Paper>)}
      {!value?.connections.length && <Typography color="text.secondary">{localize(locale, "Chưa có MCP trong project này", "No MCP configured for this project")}</Typography>}
    </Stack>}
  </>;
}

function PermissionSettings({ snapshot, session, onSetPermission }: { snapshot?: PiagentWebUICanonicalSnapshotV1; session?: SessionRow;
  onSetPermission?(mode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<unknown> }) {
  const { locale } = useUiPreferences();
  const permission = snapshot?.session.permissionProfile as { state?: string; value?: string | null } | undefined;
  const [value, setValue] = useState<string | null>(permission?.state === "known" ? permission.value ?? null : null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<"trusted-full-access" | null>(null);
  useEffect(() => { setValue(null); }, [session?.sessionRef]);
  useEffect(() => { if (permission?.state === "known") setValue(permission.value ?? null); }, [permission?.state, permission?.value]);
  const apply = async (mode: "read-only" | "workspace-write" | "trusted-full-access") => {
    if (!onSetPermission) return;
    setBusy(true); setError(null);
    try { await onSetPermission(mode); setValue(mode); }
    catch { setError(localize(locale, "Chưa thể đổi quyền lúc này", "Could not change access right now")); }
    finally { setBusy(false); }
  };
  const change = (mode: "read-only" | "workspace-write" | "trusted-full-access") => {
    if (mode === "trusted-full-access") { setPendingPermission(mode); return; }
    void apply(mode);
  };
  const choices = [
    { mode: "read-only" as const, detail: localize(locale, "Chỉ xem session, task và source; không thay đổi project.", "Inspect the session, task, and source without changing the project.") },
    { mode: "workspace-write" as const, detail: localize(locale, "Đọc, sửa file và chạy command trong project; thao tác nhạy cảm vẫn cần xác nhận.", "Read and edit project files and run commands; sensitive actions still require confirmation.") },
    { mode: "trusted-full-access" as const, detail: localize(locale, "Quyền rộng hơn trong runtime; xóa hoặc gửi dữ liệu ra ngoài vẫn cần xác nhận riêng.", "Broader runtime access; deleting or sending data externally still requires separate confirmation.") }
  ];
  return <><Title>{localize(locale, "Quyền truy cập", "Access")}</Title><Typography variant="h2" sx={{ mb: .5 }}>
    {localize(locale, "Hồ sơ quyền", "Permission profile")}</Typography><Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
      {localize(locale, "Áp dụng cho session hiện tại.", "Applies to the current session.")}</Typography>
    <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: "hidden" }}>{choices.map((choice, index) => <Box key={choice.mode}>
      <SettingRow icon={<SecurityRounded color={choice.mode === "trusted-full-access" ? "warning" : "primary"} />}
        title={label(choice.mode, locale)} detail={choice.detail}
        action={<Button size="small" variant={value === choice.mode ? "contained" : "outlined"}
          color={choice.mode === "trusted-full-access" ? "warning" : "primary"}
          aria-pressed={value === choice.mode} disabled={busy || !session || !onSetPermission || session.liveState === "running"}
          onClick={() => change(choice.mode)}>{label(choice.mode, locale)}</Button>} />
      {index < choices.length - 1 && <Divider />}</Box>)}</Paper>
    {error && <Typography role="status" color="error" variant="caption" sx={{ mt: 1 }}>{error}</Typography>}
    <ActionConfirmationDialog open={pendingPermission !== null} title={localize(locale, "Bật toàn quyền?", "Enable full access?")}
      description={localize(locale, "Session này sẽ được phép đọc, sửa file và chạy command trong phạm vi runtime. Các thao tác xóa hoặc gửi dữ liệu ra ngoài vẫn cần anh xác nhận riêng.",
        "This session will be allowed to read and edit files and run commands within the runtime. Destructive actions and external data transfers still require separate confirmation.")}
      cancelLabel={localize(locale, "Hủy", "Cancel")} confirmLabel={localize(locale, "Bật toàn quyền", "Enable full access")}
      onCancel={() => setPendingPermission(null)} onConfirm={() => { setPendingPermission(null); void apply("trusted-full-access"); }} />
  </>;
}

function UsageSettings({ session, snapshot }: { session?: SessionRow; snapshot?: PiagentWebUICanonicalSnapshotV1 }) {
  const { locale } = useUiPreferences();
  const context = snapshot?.usage.context ?? (session ? { state: session.contextUsage.state, tokens: session.contextUsage.usedTokens,
    contextWindow: session.contextUsage.contextWindow, percent: session.contextUsage.ratio === null ? null : session.contextUsage.ratio * 100 } : undefined);
  const cards = [[localize(locale, "Context", "Context"), context?.percent == null ? "—" : `${Math.round(context.percent)}%`],
    ["Tokens", `${number(context?.tokens, locale)} / ${number(context?.contextWindow, locale)}`],
    [localize(locale, "Input", "Input"), number(snapshot?.usage.sessionTotal.input, locale)],
    [localize(locale, "Output", "Output"), number(snapshot?.usage.sessionTotal.output, locale)],
    [localize(locale, "Continuation", "Continuation"), number(snapshot?.continuation.remaining, locale)],
    ["Verifier", snapshot?.verification.state ?? "—"]];
  return <><Title>{localize(locale, "Usage & context", "Usage & context")}</Title><Box sx={{ display: "grid",
    gridTemplateColumns: { xs: "1fr", sm: "repeat(2,minmax(0,1fr))", lg: "repeat(3,minmax(0,1fr))" }, gap: 1 }}>
    {cards.map(([name, value]) => <Paper variant="outlined" key={name} sx={{ p: 2, borderRadius: 2.5 }}><Typography variant="caption" color="text.secondary">{name}</Typography>
      <Typography sx={{ mt: .6, fontSize: "1.25rem", fontWeight: 800 }}>{value}</Typography></Paper>)}</Box></>;
}

function AboutSettings({ capabilities, connection }: { capabilities?: PiagentGatewayCapabilityHandshakeV1; connection: string }) {
  const { locale } = useUiPreferences();
  const rows = [["Gateway", connection], ["Mode", capabilities?.mode ?? "unknown"], ["Protocol", capabilities?.protocol.selected ?? "—"],
    [localize(locale, "Runtime", "Runtime"), capabilities?.capabilities.sessionRuntime.status ?? "unknown"]];
  return <><Title>Piagent</Title><Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: "hidden" }}>{rows.map(([name, value], index) => <Box key={String(name)}>
    <Stack direction="row" sx={{ px: 2.25, py: 1.6, justifyContent: "space-between", gap: 2 }}><Typography color="text.secondary">{name}</Typography>
      <Typography sx={{ fontWeight: 760 }}>{String(value)}</Typography></Stack>{index < rows.length - 1 && <Divider />}</Box>)}</Paper></>;
}

export function SettingsPage({ section, onSection, onBack, session, snapshot, capabilities, connection, onSetModel, onSetThinking, onSetPermission }: { section: SettingsSection;
  onSection(value: SettingsSection): void; onBack(): void; session?: SessionRow; snapshot?: PiagentWebUICanonicalSnapshotV1;
  capabilities?: PiagentGatewayCapabilityHandshakeV1; connection: string; onSetModel?(modelRef: string): Promise<unknown>;
  onSetThinking?(thinking: string): Promise<unknown>;
  onSetPermission?(mode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<unknown> }) {
  const { locale } = useUiPreferences();
  const [options, setOptions] = useState<SessionCreationOptions>(), [auth, setAuth] = useState<ProviderAuthCatalog>();
  const [connections, setConnections] = useState<SessionConnections>();
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  useEffect(() => { const controller = new AbortController(); void readSessionCreationOptions(controller.signal).then(setOptions).catch(() => undefined);
    return () => controller.abort(); }, []);
  const refreshAuth = async () => {
    const [authValue, optionsValue] = await Promise.all([readProviderAuthCatalog(), readSessionCreationOptions()]);
    setAuth(authValue); setOptions(optionsValue);
  };
  useEffect(() => { const controller = new AbortController(); void readProviderAuthCatalog(controller.signal).then(setAuth).catch(() => undefined);
    return () => controller.abort(); }, []);
  useEffect(() => {
    if (!session) { setConnections(undefined); return; }
    const controller = new AbortController(); setConnectionsLoading(true); setConnections(undefined);
    void readSessionConnections(session.sessionRef, controller.signal).then(setConnections).catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setConnectionsLoading(false); });
    return () => controller.abort();
  }, [session?.sessionRef]);
  const refreshConnections = async (value?: SessionConnections) => {
    if (value) { setConnections(value); return; }
    if (!session) return;
    setConnections(await readSessionConnections(session.sessionRef).catch(() => connections));
  };
  const navigation = [
    { id: "general" as const, label: localize(locale, "Giao diện", "Appearance"), icon: <TuneRounded /> },
    { id: "models" as const, label: localize(locale, "Nhà cung cấp & model", "Providers & models"), icon: <PsychologyRounded /> },
    { id: "connections" as const, label: localize(locale, "MCP & kết nối", "MCP & connections"), icon: <HubRounded /> },
    { id: "permissions" as const, label: localize(locale, "Quyền truy cập", "Access"), icon: <SecurityRounded /> },
    { id: "usage" as const, label: localize(locale, "Sử dụng & context", "Usage & context"), icon: <MemoryRounded /> },
    { id: "about" as const, label: "Piagent", icon: <InfoOutlined /> }
  ];
  return <Box sx={{ height: "100%", minHeight: 0, display: { sm: "grid" }, gridTemplateColumns: { sm: "220px minmax(0,1fr)" }, bgcolor: "background.default" }}>
    <Box component="nav" aria-label={localize(locale, "Mục cài đặt", "Settings sections")} sx={{ borderRight: { sm: 1 }, borderBottom: { xs: 1, sm: 0 },
      borderColor: "divider", bgcolor: "background.paper", p: 1.25, minHeight: 0, overflow: "auto" }}>
      <Stack direction="row" sx={{ minHeight: 48, alignItems: "center", justifyContent: "space-between", px: 1, mb: { sm: 1 } }}>
        <Typography id="piagent-settings-title" sx={{ fontWeight: 700 }}>{localize(locale, "Cài đặt", "Settings")}</Typography>
        <IconButton aria-label={localize(locale, "Đóng cài đặt", "Close settings")} onClick={onBack}><CloseRounded /></IconButton></Stack>
      <List component="div" disablePadding sx={{ display: { xs: "flex", sm: "block" }, minWidth: { xs: "max-content", sm: 0 }, overflowX: "auto" }}>
        {navigation.map((item) => <ListItemButton key={item.id} selected={section === item.id} onClick={() => onSection(item.id)}>
          <ListItemIcon sx={{ minWidth: 36, color: "inherit", "& .MuiSvgIcon-root": { fontSize: 19 } }}>{item.icon}</ListItemIcon>
          <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: 13, fontWeight: section === item.id ? 800 : 650 } } }} /></ListItemButton>)}</List>
    </Box>
    <Box component="main" sx={{ width: "100%", minHeight: 0, overflowY: "auto", px: { xs: 2, sm: 3, lg: 5 }, py: { xs: 3, md: 4 } }}>
      {section === "general" && <GeneralSettings />}{section === "models" && <ModelSettings options={options} auth={auth} refreshAuth={refreshAuth} session={session}
        snapshot={snapshot} onSetModel={onSetModel} onSetThinking={onSetThinking} />}
      {section === "connections" && <ConnectionSettings value={connections} loading={connectionsLoading} sessionRef={session?.sessionRef} onChanged={refreshConnections} />}
      {section === "permissions" && <PermissionSettings snapshot={snapshot} session={session} onSetPermission={onSetPermission} />}
      {section === "usage" && <UsageSettings session={session} snapshot={snapshot} />}
      {section === "about" && <AboutSettings capabilities={capabilities} connection={connection} />}
    </Box>
  </Box>;
}

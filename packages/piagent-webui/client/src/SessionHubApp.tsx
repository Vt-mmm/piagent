import { useEffect, useMemo, useState } from "react";
import AddRounded from "@mui/icons-material/AddRounded";
import ArchiveRounded from "@mui/icons-material/ArchiveRounded";
import ChatBubbleOutlineRounded from "@mui/icons-material/ChatBubbleOutlineRounded";
import DifferenceRounded from "@mui/icons-material/DifferenceRounded";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import MenuRounded from "@mui/icons-material/MenuRounded";
import MoreHorizRounded from "@mui/icons-material/MoreHorizRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import SendRounded from "@mui/icons-material/SendRounded";
import SettingsRounded from "@mui/icons-material/SettingsRounded";
import StopCircleRounded from "@mui/icons-material/StopCircleRounded";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Dialog from "@mui/material/Dialog";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Catalog, SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { Receipt } from "../../contracts/generated/session-command-v1.ts";
import type { PiagentGatewayCapabilityHandshakeV1 } from "../../contracts/generated/gateway-capabilities-v1.ts";
import { readSessionConnections, readSessionInspectionSnapshot, type SessionConnections } from "./api.ts";
import { NewSessionPage } from "./NewSessionPage.tsx";
import { SessionComposerControls } from "./SessionComposerControls.tsx";
import { SessionInspectorDrawer } from "./SessionInspectorDrawer.tsx";
import { SessionTranscript } from "./SessionTranscript.tsx";
import type { SessionWorkspaceId } from "./SessionAgentWorkspace.tsx";
import { SettingsPage, type SettingsSection } from "./SettingsPage.tsx";
import type { ConnectionState } from "./use-inspection.ts";
import type { LiveConversation } from "./use-session-hub.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

const SIDEBAR_WIDTH = 288;
const INSPECTOR_WIDTH = "min(54vw, 980px)";
type HubView = "chat" | "new";

function relativeTime(value: string, locale: UiLocale): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return localize(locale, "Vừa xong", "Just now");
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return localize(locale, `${minutes} phút`, `${minutes}m`);
  const hours = Math.floor(minutes / 60); if (hours < 24) return localize(locale, `${hours} giờ`, `${hours}h`);
  const days = Math.floor(hours / 24); return localize(locale, `${days} ngày`, `${days}d`);
}

function SessionStateDot({ session }: { session: SessionRow }) {
  const color = session.needsAttention ? "warning.main" : session.liveState === "running" ? "primary.main"
    : session.state === "gateway-owned" || session.state === "terminal-owned" ? "success.main" : "text.disabled";
  return <Box aria-hidden="true" sx={{ width: 7, height: 7, mt: .8, ml: .75, borderRadius: "50%", bgcolor: color,
    boxShadow: session.liveState === "running" ? "0 0 0 4px rgba(216,255,122,.12)" : "none" }} />;
}

type SessionMenuAction = "rename" | "pin" | "archive" | "unarchive" | "fork";

function SessionItem({ session, selected, locale, onSelect, onAction }: { session: SessionRow; selected: boolean; locale: UiLocale;
  onSelect(): void; onAction(action: SessionMenuAction): void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const choose = (action: SessionMenuAction) => { setAnchor(null); onAction(action); };
  return <Box sx={{ display: "flex", alignItems: "center", pr: .5 }}><ListItemButton selected={selected} onClick={onSelect}
    sx={{ minWidth: 0, alignItems: "flex-start", py: 1.1, px: 1.4 }}>
    <ListItemText primary={session.title} secondary={<>{session.preview || session.projectLabel}<span> · </span>{relativeTime(session.updatedAt, locale)}</>}
      slotProps={{ primary: { noWrap: true, sx: { fontSize: 13.25, fontWeight: selected ? 600 : 500 } },
        secondary: { noWrap: true, sx: { mt: .3, fontSize: 11.25 } } }} /><SessionStateDot session={session} /></ListItemButton>
    <IconButton size="small" aria-label={localize(locale, "Tùy chọn cuộc trò chuyện", "Chat options")}
      onClick={(event) => setAnchor(event.currentTarget)}><MoreHorizRounded fontSize="small" /></IconButton>
    <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} onClick={(event) => event.stopPropagation()}>
      {!session.archived && <MenuItem onClick={() => choose("rename")}>{localize(locale, "Đổi tên", "Rename")}</MenuItem>}
      {!session.archived && <MenuItem onClick={() => choose("pin")}>{session.pinned ? localize(locale, "Bỏ ghim", "Unpin") : localize(locale, "Ghim", "Pin")}</MenuItem>}
      {!session.archived && <MenuItem onClick={() => choose("fork")}>{localize(locale, "Tạo nhánh", "Fork")}</MenuItem>}
      <MenuItem onClick={() => choose(session.archived ? "unarchive" : "archive")}>{session.archived
        ? localize(locale, "Bỏ lưu trữ", "Unarchive") : localize(locale, "Lưu trữ", "Archive")}</MenuItem>
    </Menu></Box>;
}

function StateChip({ session, locale }: { session: SessionRow; locale: UiLocale }) {
  const online = session.state === "gateway-owned" || session.state === "terminal-owned";
  return <Chip size="small" variant="outlined" color={online ? "success" : session.needsAttention ? "warning" : "default"}
    label={session.liveState === "running" ? localize(locale, "Đang chạy", "Running") : online ? localize(locale, "Đang hoạt động", "Active")
      : session.state === "recovery-required" ? localize(locale, "Cần khôi phục", "Recovery needed") : localize(locale, "Đã lưu", "Saved")} />;
}

function Conversation({ session, snapshot, locale, live, canSend, send, abort, onInspector }: { session: SessionRow;
  snapshot?: PiagentWebUICanonicalSnapshotV1; locale: UiLocale; live?: LiveConversation; canSend: boolean;
  send(message: string): Promise<unknown>; abort(): Promise<unknown>; onInspector(value: SessionWorkspaceId): void }) {
  const [draft, setDraft] = useState(""), [submitting, setSubmitting] = useState(false), [connections, setConnections] = useState<SessionConnections>();
  useEffect(() => setDraft(""), [session.sessionRef]);
  useEffect(() => {
    const controller = new AbortController(); setConnections(undefined);
    void readSessionConnections(session.sessionRef, controller.signal).then(setConnections).catch(() => undefined);
    return () => controller.abort();
  }, [session.sessionRef, session.sessionRevision]);
  const submit = async () => {
    const message = draft.trim(); if (!message || submitting) return;
    setSubmitting(true); setDraft("");
    try { await send(message); } catch { /* bounded live error is rendered below */ }
    finally { setSubmitting(false); }
  };
  const refreshConnections = async (value?: SessionConnections) => {
    if (value) { setConnections(value); return; }
    setConnections(await readSessionConnections(session.sessionRef).catch(() => connections));
  };
  return <Box sx={{ minHeight: "calc(100vh - 68px)", display: "flex", flexDirection: "column" }}>
    <Box sx={{ flex: 1, width: "100%", maxWidth: 860, mx: "auto", px: { xs: 2, sm: 4 }, py: { xs: 3, md: 4 },
      display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <Box sx={{ width: "100%" }}><SessionTranscript sessionRef={session.sessionRef} sessionRevision={session.sessionRevision}
        live={live} approvals={snapshot?.approvals} locale={locale} /></Box>
    </Box>
    <Box sx={{ position: "sticky", bottom: 0, px: { xs: 1.5, sm: 2.5 }, pb: 2.5,
      background: "linear-gradient(transparent, var(--piagent-palette-background-default) 25%)" }}>
      <Box sx={{ maxWidth: 860, mx: "auto", border: 1, borderColor: "divider", borderRadius: 3, bgcolor: "background.paper", p: 1.15,
        boxShadow: "0 14px 44px rgba(0,0,0,.14)" }}>
        <SessionComposerControls session={session} snapshot={snapshot} connections={connections} locale={locale} onOpenChanges={() => onInspector("source")}
          onConnectionsChanged={refreshConnections} />
        <TextField fullWidth multiline minRows={2} disabled={!canSend || submitting} value={draft} onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }}
          placeholder={localize(locale, "Nhắn cho Piagent…", "Message Piagent…")} variant="standard" slotProps={{ input: { disableUnderline: true } }} />
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center", mt: .5, gap: 1 }}><Typography variant="caption" color="text.disabled">
          {canSend ? localize(locale, "Enter để gửi · Shift+Enter xuống dòng", "Enter to send · Shift+Enter for a new line")
            : localize(locale, "Session hiện chỉ đọc", "Session is currently read only")}</Typography>
          {live?.operationRef && !live.complete ? <Button color="error" startIcon={<StopCircleRounded />} onClick={() => void abort()}>{localize(locale, "Dừng", "Stop")}</Button>
            : <IconButton aria-label={localize(locale, "Gửi", "Send")} disabled={!canSend || submitting || !draft.trim()} color="primary" onClick={() => void submit()}
              sx={{ bgcolor: "primary.main", color: "primary.contrastText", "&:hover": { bgcolor: "primary.dark" }, "&.Mui-disabled": { bgcolor: "action.disabledBackground" } }}><SendRounded fontSize="small" /></IconButton>}
        </Stack>
      </Box>
    </Box>
  </Box>;
}

function EmptyHub({ locale, canCreate, onNew }: { locale: UiLocale; canCreate: boolean; onNew(): void }) {
  return <Stack sx={{ minHeight: "calc(100vh - 68px)", alignItems: "center", justifyContent: "center", px: 3, textAlign: "center" }} spacing={1.5}>
    <Box className="brand-mark" aria-hidden="true" sx={{ width: 50, height: 50, fontSize: 25 }}>π</Box>
    <Typography variant="h1">{localize(locale, "Bắt đầu với Piagent", "Start with Piagent")}</Typography>
    <Typography color="text.secondary" sx={{ maxWidth: 520 }}>{localize(locale,
      "Tạo cuộc trò chuyện mới, chọn project và model; session sẽ được lưu để tiếp tục sau khi đóng Gateway.",
      "Create a new chat, choose a project and model, and the session will remain available after the Gateway closes.")}</Typography>
    <Button disabled={!canCreate} variant="contained" startIcon={<AddRounded />} onClick={onNew}>{localize(locale, "Cuộc trò chuyện mới", "New chat")}</Button>
  </Stack>;
}

export function SessionHubApp({ catalog, capabilities, connection, live, refresh, create, send, abort, setModel, setThinking, setPermission,
  rename, pin, archive, unarchive, fork }: { catalog?: Catalog;
  capabilities?: PiagentGatewayCapabilityHandshakeV1; connection: ConnectionState; live: Readonly<Record<string, LiveConversation>>;
  refresh(): Promise<Catalog | undefined>; create(value: { projectRef: string; placeRef: string; modelRef: string | null;
    thinkingLevel: string; message: string }): Promise<Receipt>; send(session: SessionRow, message: string): Promise<unknown>; abort(session: SessionRow): Promise<unknown>;
    setModel(session: SessionRow, modelRef: string): Promise<unknown>; setThinking(session: SessionRow, thinkingLevel: string): Promise<unknown>;
    setPermission(session: SessionRow, permissionMode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<unknown>;
    rename(session: SessionRow, title: string): Promise<Receipt>; pin(session: SessionRow, pinned: boolean): Promise<Receipt>;
    archive(session: SessionRow): Promise<Receipt>; unarchive(session: SessionRow): Promise<Receipt>;
    fork(session: SessionRow, title: string | null): Promise<Receipt> }) {
  const { locale } = useUiPreferences();
  const [query, setQuery] = useState(""), [selectedRef, setSelectedRef] = useState<string>();
  const [mobileOpen, setMobileOpen] = useState(false), [showArchived, setShowArchived] = useState(false);
  const [view, setView] = useState<HubView>("chat"), [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [inspectorOpen, setInspectorOpen] = useState(false), [activeInspector, setActiveInspector] = useState<SessionWorkspaceId>("task");
  const [inspection, setInspection] = useState<PiagentWebUICanonicalSnapshotV1>();
  const [inspectionState, setInspectionState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [creatingSession, setCreatingSession] = useState(false), [createError, setCreateError] = useState<string | null>(null);
  const [sessionAction, setSessionAction] = useState<{ kind: Exclude<SessionMenuAction, "pin" | "unarchive">; session: SessionRow } | null>(null);
  const [actionTitle, setActionTitle] = useState(""), [actionBusy, setActionBusy] = useState(false), [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  useEffect(() => { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }, [view, selectedRef]);
  const sessions = useMemo(() => (catalog?.sessions ?? []).filter((item) => item.archived === showArchived
    && `${item.title} ${item.projectLabel} ${item.preview}`.toLowerCase().includes(query.trim().toLowerCase())), [catalog, query, showArchived]);
  const projectGroups = useMemo(() => {
    const grouped = new Map<string, { label: string; sessions: SessionRow[] }>();
    for (const session of sessions) {
      const group = grouped.get(session.projectRef) ?? { label: session.projectLabel, sessions: [] };
      group.sessions.push(session); grouped.set(session.projectRef, group);
    }
    return [...grouped.entries()].map(([projectRef, group]) => ({ projectRef, ...group,
      sessions: group.sessions.sort((left, right) => Number(right.pinned) - Number(left.pinned) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)) }))
      .sort((left, right) => Date.parse(right.sessions[0]?.updatedAt ?? "") - Date.parse(left.sessions[0]?.updatedAt ?? ""));
  }, [sessions]);
  const archivedCount = catalog?.sessions.filter((item) => item.archived).length ?? 0;
  useEffect(() => { if (!selectedRef || !(catalog?.sessions ?? []).some((item) => item.sessionRef === selectedRef)) setSelectedRef((catalog?.sessions ?? []).find((item) => !item.archived)?.sessionRef); }, [selectedRef, catalog]);
  const selected = (catalog?.sessions ?? []).find((item) => item.sessionRef === selectedRef);
  const choose = (value: string) => { setSelectedRef(value); setView("chat"); setMobileOpen(false); };
  const openSettings = (section: SettingsSection) => { setSettingsSection(section); setSettingsOpen(true); };
  const openInspector = (active: SessionWorkspaceId) => { setActiveInspector(active); setInspectorOpen(true); };
  const refreshInspection = async () => {
    if (!selected) return undefined;
    setInspectionState("loading");
    try { const value = await readSessionInspectionSnapshot(selected.sessionRef); setInspection(value); setInspectionState("ready"); return value; }
    catch { setInspectionState("error"); return undefined; }
  };
  useEffect(() => {
    if (!selected) { setInspection(undefined); setInspectionState("idle"); return; }
    const controller = new AbortController(); setInspection(undefined); setInspectionState("loading");
    void readSessionInspectionSnapshot(selected.sessionRef, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setInspection(value); setInspectionState("ready"); }
    }).catch(() => { if (!controller.signal.aborted) setInspectionState("error"); });
    return () => controller.abort();
  }, [selected?.sessionRef, selected?.sessionRevision]);
  const canCreate = connection === "connected" && capabilities?.capabilities.sessionActions.create.status === "available";
  const beginSessionAction = (session: SessionRow, action: SessionMenuAction) => {
    if (action === "pin") { void pin(session, !session.pinned).catch((error) => setNotice({
      title: localize(locale, "Không thể đổi trạng thái ghim", "Could not change pin state"),
      message: error instanceof Error ? error.message : "session-pin-failed"
    })); return; }
    if (action === "unarchive") { void unarchive(session).then(() => setShowArchived(false)).catch((error) => setNotice({
      title: localize(locale, "Không thể khôi phục cuộc trò chuyện", "Could not restore chat"),
      message: error instanceof Error ? error.message : "session-unarchive-failed"
    })); return; }
    setActionError(null); setActionTitle(action === "rename" ? session.title : action === "fork"
      ? `${session.title} · ${localize(locale, "nhánh", "fork")}` : "");
    setSessionAction({ kind: action, session });
  };
  const confirmSessionAction = async () => {
    if (!sessionAction || actionBusy) return;
    setActionBusy(true); setActionError(null);
    try {
      if (sessionAction.kind === "rename") await rename(sessionAction.session, actionTitle.trim());
      else if (sessionAction.kind === "archive") await archive(sessionAction.session);
      else {
        const receipt = await fork(sessionAction.session, actionTitle.trim() || null);
        if (receipt.sessionRef) { setSelectedRef(receipt.sessionRef); setView("chat"); }
      }
      setSessionAction(null);
    } catch (error) { setActionError(error instanceof Error ? error.message : "session-action-failed"); }
    finally { setActionBusy(false); }
  };

  const sidebar = <Box sx={{ height: "100%", display: "flex", flexDirection: "column", bgcolor: "background.paper" }}>
    <Toolbar sx={{ minHeight: "68px !important", px: "16px !important", gap: 1.1 }}><Box className="brand-mark" aria-hidden="true">π</Box><Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontWeight: 600 }}>Piagent</Typography><Typography variant="caption" color="text.disabled">Local agent workspace</Typography></Box></Toolbar>
    <Box sx={{ px: 1.25 }}><Tooltip title={canCreate ? localize(locale, "Tạo session mới", "Create a new session")
      : localize(locale, "Gateway hiện chưa cho phép tạo session", "The Gateway cannot create sessions right now")}><span><Button fullWidth disabled={!canCreate}
      variant="outlined" onClick={() => { setCreateError(null); setView("new"); setMobileOpen(false); }} startIcon={<AddRounded />}
      sx={{ justifyContent: "flex-start", py: 1 }}>{localize(locale, "Cuộc trò chuyện mới", "New chat")}</Button></span></Tooltip>
      <TextField value={query} onChange={(event) => setQuery(event.target.value)} fullWidth size="small" placeholder={localize(locale, "Tìm cuộc trò chuyện", "Search chats")}
        sx={{ mt: 1.1 }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> } }} /></Box>
    <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", px: 2, pt: 2, pb: .4 }}><Typography variant="caption" color="text.disabled"
      sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{showArchived ? localize(locale, "Đã lưu trữ", "Archived") : localize(locale, "Cuộc trò chuyện", "Chats")}</Typography>
      <Typography variant="caption" color="text.disabled">{sessions.length}</Typography></Stack>
    <List component="div" sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: .25 }}>
      {projectGroups.map((group) => <Box key={group.projectRef} sx={{ mt: .75 }}><Stack direction="row" sx={{ alignItems: "center", gap: .7, px: 2, py: .55 }}>
        <FolderOpenOutlined sx={{ fontSize: 15, color: "text.disabled" }} /><Typography component="div" variant="caption" color="text.disabled"
          noWrap sx={{ flex: 1, fontWeight: 600 }}>{group.label}</Typography><Typography variant="caption" color="text.disabled">{group.sessions.length}</Typography></Stack>
        {group.sessions.map((session) => <SessionItem key={session.sessionRef} session={session} selected={view === "chat" && selected?.sessionRef === session.sessionRef}
          locale={locale} onSelect={() => choose(session.sessionRef)} onAction={(action) => beginSessionAction(session, action)} />)}</Box>)}
      {sessions.length === 0 && <Stack sx={{ alignItems: "center", textAlign: "center", px: 3, py: 5 }} spacing={1}><ChatBubbleOutlineRounded color="disabled" />
        <Typography variant="body2" color="text.secondary">{localize(locale, "Không tìm thấy cuộc trò chuyện", "No conversations found")}</Typography></Stack>}</List>
    <Box sx={{ p: 1.25 }}><Divider sx={{ mb: 1 }} /><Button fullWidth startIcon={<ArchiveRounded />} disabled={!showArchived && archivedCount === 0}
      onClick={() => { setShowArchived((value) => !value); setMobileOpen(false); }} sx={{ justifyContent: "flex-start" }}>{showArchived
        ? localize(locale, "Quay lại cuộc trò chuyện", "Back to chats") : localize(locale, `Đã lưu trữ (${archivedCount})`, `Archived (${archivedCount})`)}</Button>
      <Button fullWidth startIcon={<SettingsRounded />} onClick={() => { openSettings("general"); setMobileOpen(false); }}
        sx={{ justifyContent: "flex-start", mt: .25 }} color={settingsOpen ? "primary" : "inherit"}>{localize(locale, "Cài đặt", "Settings")}</Button>
      <Stack direction="row" sx={{ px: 1.25, pt: 1, alignItems: "center", gap: 1 }}><Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: connection === "connected" ? "success.main" : "warning.main" }} />
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{connection === "connected" ? "Gateway live" : connection}</Typography>
        <Typography variant="caption" color="text.disabled">local</Typography></Stack></Box>
  </Box>;

  if (!catalog && connection !== "failed") return <Stack sx={{ minHeight: "100vh", alignItems: "center", justifyContent: "center" }} spacing={2}>
    <CircularProgress size={24} /><Typography>{localize(locale, "Đang mở Piagent…", "Opening Piagent…")}</Typography></Stack>;
  const title = view === "new" ? localize(locale, "Cuộc trò chuyện mới", "New chat") : selected?.title ?? "Piagent";
  return <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
    <AppBar position="fixed" color="transparent" elevation={0} sx={{ left: { md: `${SIDEBAR_WIDTH}px` }, right: { lg: inspectorOpen ? INSPECTOR_WIDTH : 0 },
      width: { xs: "100%", md: "auto" }, borderBottom: 1, transition: "right .2s ease",
      borderColor: "divider", bgcolor: "rgba(var(--piagent-palette-background-defaultChannel) / .9)", backdropFilter: "blur(18px)" }}><Toolbar sx={{ minHeight: "68px !important", gap: 1 }}>
      <IconButton aria-label={localize(locale, "Mở điều hướng", "Open navigation")} onClick={() => setMobileOpen(true)} sx={{ display: { md: "none" } }}><MenuRounded /></IconButton>
      <Box sx={{ flex: 1, minWidth: 0 }}><Typography component="h1" noWrap sx={{ fontWeight: 600, fontSize: "inherit" }}>{title}</Typography>
        {view === "chat" && selected && <Typography variant="caption" color="text.secondary" noWrap>{selected.projectLabel}</Typography>}</Box>
      {view === "chat" && selected && <><SessionComposerControls placement="header" session={selected} snapshot={inspection} locale={locale}
        onOpenChanges={() => openInspector("source")}
        canSetModel={connection === "connected" && capabilities?.capabilities.sessionActions.setModel.status === "available"}
        canSetThinking={connection === "connected" && capabilities?.capabilities.sessionActions.setThinking.status === "available"}
        canSetPermission={connection === "connected" && capabilities?.capabilities.sessionActions.setPermission.status === "available"}
        onSetModel={(modelRef) => setModel(selected, modelRef)} onSetThinking={(value) => setThinking(selected, value)}
        onSetPermission={(value) => setPermission(selected, value)} />
        <StateChip session={selected} locale={locale} /><Tooltip title="Source Changes"><IconButton aria-label={localize(locale, "Mở Source Changes Inspector", "Open Source Changes Inspector")}
          onClick={() => openInspector("source")}><DifferenceRounded fontSize="small" /></IconButton></Tooltip></>}
      <Tooltip title={localize(locale, "Làm mới", "Refresh")}><IconButton aria-label={localize(locale, "Làm mới", "Refresh")} onClick={() => void refresh()}><RefreshRounded fontSize="small" /></IconButton></Tooltip>
    </Toolbar></AppBar>
    <Box component="nav" sx={{ width: { md: SIDEBAR_WIDTH } }}><Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)}
      sx={{ display: { xs: "block", md: "none" }, "& .MuiDrawer-paper": { width: SIDEBAR_WIDTH } }}>{sidebar}</Drawer><Drawer variant="permanent"
      sx={{ display: { xs: "none", md: "block" }, "& .MuiDrawer-paper": { width: SIDEBAR_WIDTH, borderRight: 1, borderColor: "divider" } }}>{sidebar}</Drawer></Box>
    <Box component="main" sx={{ ml: { md: `${SIDEBAR_WIDTH}px` }, mr: { lg: inspectorOpen ? INSPECTOR_WIDTH : 0 }, pt: "68px",
      transition: "margin-right .2s ease" }}>
      {view === "new" ? <NewSessionPage active defaultProjectRef={selected?.projectRef} busy={creatingSession} error={createError} onCancel={() => setView("chat")}
        onCreate={(value) => { setCreatingSession(true); void create(value).then((receipt) => { if (receipt.sessionRef) { setSelectedRef(receipt.sessionRef); setView("chat"); } })
          .catch((cause) => setCreateError(cause instanceof Error ? cause.message : "session-create-failed")).finally(() => setCreatingSession(false)); }} />
        : selected ? <Conversation session={selected} snapshot={inspection} locale={locale} live={live[selected.sessionRef]}
            canSend={connection === "connected" && selected.composerAvailable && capabilities?.capabilities.sessionActions.send.status === "available"}
            send={(message) => send(selected, message)} abort={() => abort(selected)} onInspector={openInspector} />
            : <EmptyHub locale={locale} canCreate={canCreate} onNew={() => setView("new")} />}
    </Box>
    <SessionInspectorDrawer open={inspectorOpen} active={activeInspector} snapshot={inspection} state={inspectionState} sessionRef={selected?.sessionRef}
      onClose={() => setInspectorOpen(false)} onActive={setActiveInspector} refresh={refreshInspection} />
    <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} fullWidth maxWidth="lg" aria-labelledby="piagent-settings-title"
      slotProps={{ paper: { sx: { m: { xs: 0, sm: 2 }, width: { xs: "100%", sm: "calc(100% - 32px)" },
        height: { xs: "100%", sm: "min(86vh, 840px)" }, maxHeight: { xs: "100%", sm: "86vh" }, borderRadius: { xs: 0, sm: 2.5 }, overflow: "hidden" } } }}>
      <SettingsPage section={settingsSection} onSection={setSettingsSection} onBack={() => setSettingsOpen(false)} session={selected}
        snapshot={inspection} capabilities={capabilities} connection={connection}
        onSetModel={selected ? (modelRef) => setModel(selected, modelRef) : undefined}
        onSetThinking={selected ? (value) => setThinking(selected, value) : undefined}
        onSetPermission={selected ? (value) => setPermission(selected, value) : undefined} />
    </Dialog>
    <Dialog open={Boolean(sessionAction)} onClose={() => !actionBusy && setSessionAction(null)} fullWidth maxWidth="xs">
      <Stack spacing={2} sx={{ p: 3 }}><Typography variant="h2">{sessionAction?.kind === "rename"
        ? localize(locale, "Đổi tên cuộc trò chuyện", "Rename chat") : sessionAction?.kind === "fork"
          ? localize(locale, "Tạo nhánh cuộc trò chuyện", "Fork chat") : localize(locale, "Lưu trữ cuộc trò chuyện", "Archive chat")}</Typography>
        {sessionAction?.kind !== "archive" ? <TextField autoFocus label={localize(locale, "Tên", "Title")} value={actionTitle}
          onChange={(event) => setActionTitle(event.target.value)} slotProps={{ htmlInput: { maxLength: 500 } }} />
          : <Typography color="text.secondary">{localize(locale, "Cuộc trò chuyện vẫn được lưu và có thể khôi phục từ mục Đã lưu trữ.",
            "The chat remains saved and can be restored from Archived.")}</Typography>}
        {actionError && <Typography color="error">{actionError}</Typography>}
        <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button disabled={actionBusy} onClick={() => setSessionAction(null)}>{localize(locale, "Hủy", "Cancel")}</Button>
          <Button variant="contained" disabled={actionBusy || sessionAction?.kind !== "archive" && !actionTitle.trim()} onClick={() => void confirmSessionAction()}>
            {localize(locale, "Xác nhận", "Confirm")}</Button></Stack></Stack>
    </Dialog>
    <Dialog open={Boolean(notice)} onClose={() => setNotice(null)} fullWidth maxWidth="xs" aria-labelledby="piagent-session-notice-title">
      <Stack spacing={2} sx={{ p: 3 }}><Typography id="piagent-session-notice-title" variant="h2">{notice?.title}</Typography>
        <Typography color="text.secondary">{notice?.message}</Typography>
        <Stack direction="row" sx={{ justifyContent: "flex-end" }}><Button variant="contained" onClick={() => setNotice(null)}>
          {localize(locale, "Đóng", "Close")}</Button></Stack></Stack>
    </Dialog>
  </Box>;
}

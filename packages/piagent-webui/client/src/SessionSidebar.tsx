import { useMemo, useState } from "react";
import AddRounded from "@mui/icons-material/AddRounded";
import ArchiveRounded from "@mui/icons-material/ArchiveRounded";
import ChatBubbleOutlineRounded from "@mui/icons-material/ChatBubbleOutlineRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import MoreHorizRounded from "@mui/icons-material/MoreHorizRounded";
import PushPinOutlined from "@mui/icons-material/PushPinOutlined";
import SearchRounded from "@mui/icons-material/SearchRounded";
import SettingsRounded from "@mui/icons-material/SettingsRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import useMediaQuery from "@mui/material/useMediaQuery";
import TextField from "@mui/material/TextField";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { LiveConversation } from "./live-state-view-model.ts";
import type { ConnectionState } from "./use-inspection.ts";
import { GitBranchLabel } from "./GitBranchLabel.tsx";
import { localize, type UiLocale } from "./ui-preferences.tsx";
import { toneText } from "./tone.ts";
import { outcomeTone } from "./ProcessNote.tsx";

export type SessionMenuAction = "rename" | "pin" | "archive" | "unarchive" | "fork";

export function relativeTime(value: string, locale: UiLocale): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return localize(locale, "Vừa mới", "Just now");
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return localize(locale, `${minutes} phút`, `${minutes}m`);
  const hours = Math.floor(minutes / 60); if (hours < 24) return localize(locale, `${hours} giờ`, `${hours}h`);
  const days = Math.floor(hours / 24); return localize(locale, `${days} ngày`, `${days}d`);
}

// running · needs a decision · needs recovery · failed last turn · idle
export function sessionActivity(session: SessionRow, live?: LiveConversation): "running" | "elsewhere" | "attention" | "recovery" | "failed" | "idle" {
  if (live && !live.complete) return "running";
  if (session.state === "terminal-owned") return "elsewhere";
  if (session.state === "recovery-required") return "recovery";
  if (session.needsAttention) return "attention";
  if (live?.complete && live.error) return "failed";
  return session.liveState === "running" ? "running" : "idle";
}

function StateDot({ activity, locale }: { activity: ReturnType<typeof sessionActivity>; locale: UiLocale }) {
  const color = { running: "primary.main", elsewhere: "info.main", attention: "warning.main", recovery: "error.main", failed: "error.main", idle: "transparent" }[activity];
  const title = { running: localize(locale, "Đang chạy", "Running"), elsewhere: localize(locale, "Đang chạy ở Terminal hoặc tiến trình khác", "Running in Terminal or another process"), attention: localize(locale, "Cần duyệt", "Needs approval"),
    recovery: localize(locale, "Cần khôi phục", "Needs recovery"), failed: localize(locale, "Lượt cuối lỗi", "Last turn failed"), idle: "" }[activity];
  return <Box role={activity === "idle" ? undefined : "img"} aria-label={title || undefined} title={title}
    sx={{ width: 8, height: 8, mt: .9, ml: .75, flexShrink: 0, borderRadius: "50%", bgcolor: color,
      animation: activity === "running" || activity === "elsewhere" ? "piagent-pulse 1.4s ease-in-out infinite" : "none" }} />;
}

// How a company conversation's last code-changing turn ended (Harness workflow).
const OUTCOME_SHORT: Record<string, [string, string]> = { clean: ["Đủ bước", "All steps"], unverified: ["Chưa verify", "Unverified"],
  unreviewed: ["Chưa review", "Not reviewed"], blocking_open: ["Còn lỗi blocking", "Blocking open"], review_unavailable: ["Không review được", "Review unavailable"],
  interrupted: ["Bị dừng", "Stopped"], disputed: ["Cần bạn quyết", "Needs your call"] };

function SessionItem({ session, live, selected, locale, onSelect, onAction, showProject = false }: { session: SessionRow; live?: LiveConversation; selected: boolean;
  locale: UiLocale; onSelect(): void; onAction(action: SessionMenuAction): void; showProject?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const choose = (action: SessionMenuAction) => { setAnchor(null); onAction(action); };
  const company = session.modelLabel === "agent-watch-auto", activity = sessionActivity(session, live);
  // A busy session says what it is doing; an idle one, when it last changed.
  const status = activity === "running" ? localize(locale, "Đang chạy", "Running") : activity === "elsewhere" ? localize(locale, "Đang chạy ở nơi khác", "Running elsewhere")
    : activity === "attention" ? localize(locale, "Cần duyệt", "Needs approval") : null;
  const outcome = company && session.managedProcess && session.managedProcess.outcome !== "no_change" ? session.managedProcess.outcome : null;
  return <Box sx={{ display: "flex", alignItems: "center", pr: .5 }}><ListItemButton selected={selected} onClick={onSelect}
    sx={{ minWidth: 0, alignItems: "flex-start", py: 1, px: 1.4 }}>
    <ListItemText primary={<>{session.pinned && <PushPinOutlined sx={{ fontSize: 13, mr: .5, verticalAlign: "-2px", color: "text.disabled" }} />}{session.title}</>}
      secondary={<>{company && <Box component="span" sx={{ fontWeight: 650, color: "primary.main" }}>{localize(locale, "Công ty", "Company")}<span> · </span></Box>}
        {status ?? relativeTime(session.updatedAt, locale)}
        {showProject && <span> · {session.projectLabel}</span>}
        {outcome && <Box component="span" sx={toneText(outcomeTone(outcome))}> · {localize(locale, ...OUTCOME_SHORT[outcome])}</Box>}</>}
      slotProps={{ primary: { noWrap: true, sx: { fontSize: 13.25, fontWeight: selected ? 600 : 500 } },
        secondary: { noWrap: true, sx: { mt: .25, fontSize: 11.25 } } }} /><StateDot activity={activity} locale={locale} /></ListItemButton>
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

export type ProjectGroup = { projectRef: string; label: string; gitBranch?: SessionRow["gitBranch"]; sessions: SessionRow[] };
const PER_GROUP = 5, COLLAPSED_KEY = "piagent.sidebar.collapsed";
function readSet(key: string): Set<string> {
  try { const value = JSON.parse(window.localStorage.getItem(key) ?? "[]"); return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 500) : []); }
  catch { return new Set(); }
}
function writeSet(key: string, value: Set<string>) { try { window.localStorage.setItem(key, JSON.stringify([...value].slice(0, 500))); } catch { /* storage may be blocked */ } }

export function SessionSidebar({ locale, canCreate, query, onQuery, groups, count, selectedRef, showArchived, archivedCount, settingsOpen, connection,
  live, onNew, onSelect, onAction, onToggleArchived, onSettings, updateDot = false }: { locale: UiLocale; updateDot?: boolean; canCreate: boolean; query: string; onQuery(value: string): void;
  groups: ProjectGroup[]; count: number; selectedRef?: string; showArchived: boolean; archivedCount: number; settingsOpen: boolean;
  connection: ConnectionState; live: Readonly<Record<string, LiveConversation>>; onNew(): void; onSelect(sessionRef: string): void;
  onAction(session: SessionRow, action: SessionMenuAction): void; onToggleArchived(): void; onSettings(): void }) {
  // The status bar shows the Gateway on wide screens; the drawer shows it on narrow ones.
  const narrow = useMediaQuery((theme: import("@mui/material/styles").Theme) => theme.breakpoints.down("md"));
  // Many conversations stay readable: what runs or needs attention first, a
  // filter by kind, project groups that fold (remembered in this browser) and
  // show their newest few until asked for more.
  const [kind, setKind] = useState<"all" | "company" | "personal">("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readSet(COLLAPSED_KEY)), [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const searching = query.trim().length > 0;
  const isCompany = (session: SessionRow) => session.modelLabel === "agent-watch-auto";
  const all = groups.flatMap((group) => group.sessions);
  const kinds = { company: all.filter(isCompany).length, personal: all.filter((session) => !isCompany(session)).length };
  const visible = useMemo(() => groups.map((group) => ({ ...group, sessions: group.sessions.filter((session) => kind === "all" || (kind === "company") === isCompany(session)) }))
    .filter((group) => group.sessions.length > 0), [groups, kind]);
  const shown = visible.reduce((sum, group) => sum + group.sessions.length, 0);
  const active = showArchived ? [] : visible.flatMap((group) => group.sessions).filter((session) => sessionActivity(session, live[session.sessionRef]) !== "idle");
  const toggle = (set: (update: (value: Set<string>) => Set<string>) => void, ref: string, persist: boolean) => set((value) => {
    const next = new Set(value); if (next.has(ref)) next.delete(ref); else next.add(ref);
    if (persist) writeSet(COLLAPSED_KEY, next);
    return next;
  });
  void count;
  return <Box sx={{ height: "100%", display: "flex", flexDirection: "column", bgcolor: "background.paper" }}>
    <Toolbar sx={{ minHeight: "60px !important", px: "16px !important", gap: 1.1 }}><Box className="brand-mark" aria-hidden="true">π</Box><Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontWeight: 600 }}>Piagent</Typography><Typography variant="caption" color="text.disabled">{localize(locale, "Coding agent", "Coding agent")}</Typography></Box></Toolbar>
    <Box sx={{ px: 1.25 }}><Tooltip title={canCreate ? localize(locale, "Tạo cuộc trò chuyện mới", "Create a new chat")
      : localize(locale, "Gateway hiện chưa cho phép tạo cuộc trò chuyện", "The Gateway cannot create chats right now")}><span><Button fullWidth disabled={!canCreate}
      variant="outlined" onClick={onNew} startIcon={<AddRounded />} sx={{ justifyContent: "flex-start", py: 1 }}>{localize(locale, "Cuộc trò chuyện mới", "New chat")}</Button></span></Tooltip>
      <TextField value={query} onChange={(event) => onQuery(event.target.value)} fullWidth size="small" placeholder={localize(locale, "Tìm cuộc trò chuyện", "Search chats")}
        sx={{ mt: 1.1 }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> } }} /></Box>
    <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", px: 2, pt: 2, pb: .4 }}><Typography variant="caption" color="text.disabled"
      sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{showArchived ? localize(locale, "Đã lưu trữ", "Archived") : localize(locale, "Cuộc trò chuyện", "Chats")}</Typography>
      <Typography variant="caption" color="text.disabled">{shown}</Typography></Stack>
    {kinds.company > 0 && kinds.personal > 0 && <Stack direction="row" role="group" aria-label={localize(locale, "Lọc theo loại", "Filter by kind")} sx={{ px: 1.75, pb: .5, gap: .5, flexWrap: "wrap" }}>
      {(["all", "company", "personal"] as const).map((value) => <Chip key={value} size="small" clickable aria-pressed={kind === value} onClick={() => setKind(value)}
        color={kind === value ? "primary" : "default"} variant={kind === value ? "filled" : "outlined"}
        label={value === "all" ? localize(locale, "Tất cả", "All") : value === "company" ? localize(locale, `Công ty · ${kinds.company}`, `Company · ${kinds.company}`)
          : localize(locale, `Cá nhân · ${kinds.personal}`, `Personal · ${kinds.personal}`)} />)}</Stack>}
    <List component="div" sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: .25 }}>
      {active.length > 0 && <Box component="section" aria-label={localize(locale, "Đang chạy hoặc cần chú ý", "Running or needing attention")} sx={{ mt: .5 }}>
        <Typography component="div" variant="caption" color="text.secondary" sx={{ px: 2, py: .55, fontWeight: 600 }}>{localize(locale, "Đang chạy · cần chú ý", "Running · needs attention")}</Typography>
        {active.map((session) => <SessionItem key={session.sessionRef} session={session} live={live[session.sessionRef]} showProject
          selected={selectedRef === session.sessionRef} locale={locale} onSelect={() => onSelect(session.sessionRef)} onAction={(action) => onAction(session, action)} />)}
        <Divider sx={{ mx: 2, mt: .75 }} /></Box>}
      {visible.map((group) => { const holdsSelected = group.sessions.some((session) => session.sessionRef === selectedRef);
        const open = searching || holdsSelected || !collapsed.has(group.projectRef), all = searching || expanded.has(group.projectRef);
        // The open conversation always stays in view.
        const items = all ? group.sessions : group.sessions.filter((session, index) => index < PER_GROUP || session.sessionRef === selectedRef);
        return <Box key={group.projectRef} component="section" aria-label={group.label} sx={{ mt: .5 }}>
          <ButtonBase onClick={() => toggle(setCollapsed, group.projectRef, true)} aria-expanded={open} sx={{ width: "100%", justifyContent: "flex-start", gap: .7, px: 2, py: .55, borderRadius: 1 }}>
            <ExpandMoreRounded sx={{ fontSize: 16, color: "text.disabled", transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />
            <FolderOpenOutlined sx={{ fontSize: 15, color: "text.disabled" }} /><Typography component="div" variant="caption" color="text.secondary"
              noWrap sx={{ flexShrink: 1, minWidth: 0, fontWeight: 600, textAlign: "left" }}>{group.label}</Typography>
            <Typography component="div" variant="caption" color="text.disabled" sx={{ flex: 1, minWidth: 0, display: "flex", textAlign: "left" }}>
              {group.gitBranch && <GitBranchLabel branch={group.gitBranch} locale={locale} maxWidth="100%" />}</Typography>
            <Typography variant="caption" color="text.disabled">{group.sessions.length}</Typography></ButtonBase>
          {open && items.map((session) => <SessionItem key={session.sessionRef} session={session} live={live[session.sessionRef]}
            selected={selectedRef === session.sessionRef} locale={locale} onSelect={() => onSelect(session.sessionRef)} onAction={(action) => onAction(session, action)} />)}
          {open && !searching && group.sessions.length > PER_GROUP && <Button size="small" onClick={() => toggle(setExpanded, group.projectRef, false)}
            sx={{ ml: 1.5, mb: .25, fontSize: 12 }}>{all ? localize(locale, "Thu gọn", "Show less") : localize(locale, `Xem thêm ${group.sessions.length - PER_GROUP}`, `Show ${group.sessions.length - PER_GROUP} more`)}</Button>}
        </Box>; })}
      {shown === 0 && <Stack sx={{ alignItems: "center", textAlign: "center", px: 3, py: 5 }} spacing={1}><ChatBubbleOutlineRounded color="disabled" />
        <Typography variant="body2" color="text.secondary">{localize(locale, "Không tìm thấy cuộc trò chuyện", "No conversations found")}</Typography></Stack>}</List>
    <Box sx={{ p: 1.25 }}><Divider sx={{ mb: 1 }} /><Button fullWidth startIcon={<ArchiveRounded />} disabled={!showArchived && archivedCount === 0}
      onClick={onToggleArchived} sx={{ justifyContent: "flex-start" }}>{showArchived
        ? localize(locale, "Quay lại cuộc trò chuyện", "Back to chats") : localize(locale, `Đã lưu trữ (${archivedCount})`, `Archived (${archivedCount})`)}</Button>
      <Button fullWidth startIcon={<SettingsRounded />} onClick={onSettings}
        sx={{ justifyContent: "flex-start", mt: .25 }} color={settingsOpen ? "primary" : "inherit"}>{localize(locale, "Cài đặt", "Settings")}
        {updateDot && <Box component="span" role="img" aria-label={localize(locale, "Có bản cập nhật", "Update available")}
          sx={{ ml: "auto", width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main" }} />}</Button>
      {narrow && <Stack direction="row" sx={{ px: 1.25, pt: 1, alignItems: "center", gap: 1 }}><Box sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: connection === "connected" ? "success.main" : "warning.main" }} />
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{connection === "connected" ? "Gateway live" : connection}</Typography>
        <Typography variant="caption" color="text.disabled">local</Typography></Stack>}</Box>
  </Box>;
}

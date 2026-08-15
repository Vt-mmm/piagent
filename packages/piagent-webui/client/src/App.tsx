import { useState, type ReactNode } from "react";
import AppBar from "@mui/material/AppBar";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DashboardRounded from "@mui/icons-material/DashboardRounded";
import ChatBubbleRounded from "@mui/icons-material/ChatBubbleRounded";
import DifferenceRounded from "@mui/icons-material/DifferenceRounded";
import TerminalRounded from "@mui/icons-material/TerminalRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import RocketLaunchRounded from "@mui/icons-material/RocketLaunchRounded";
import MenuRounded from "@mui/icons-material/MenuRounded";
import LightModeRounded from "@mui/icons-material/LightModeRounded";
import DarkModeRounded from "@mui/icons-material/DarkModeRounded";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { ConnectionState } from "./use-inspection.ts";
import { SourceWorkspace } from "./SourceWorkspace.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { EvidencePanels } from "./EvidencePanels.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { SessionOptionsPanel } from "./SessionOptionsPanel.tsx";
import { ApprovalPanel } from "./ApprovalPanel.tsx";
import { LifecyclePanel } from "./LifecyclePanel.tsx";
import { TaskRunIndexPanel } from "./TaskRunIndexPanel.tsx";
import { ReleaseMonitorPanel } from "./ReleaseMonitorPanel.tsx";
import type { RuntimeStreamEvent } from "./chat-view-model.ts";
import { compactRef, criterionMeta, label, modelName, permissionName, taskProgress, thinkingName, tone } from "./view-model.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

const DRAWER_WIDTH = 264;
type WorkspaceId = "overview" | "chat" | "source" | "activity" | "history" | "release";
type AppProps = { snapshot?: PiagentWebUICanonicalSnapshotV1; connection?: ConnectionState; events?: RuntimeStreamEvent[];
  refreshSnapshot?: () => Promise<PiagentWebUICanonicalSnapshotV1 | undefined> };

const workspaceCopy: Record<WorkspaceId, { vi: [string, string]; en: [string, string] }> = {
  overview: { vi: ["Tổng quan", "Task contract, tiến độ và bằng chứng hoàn thành"], en: ["Overview", "Task contract, progress, and completion evidence"] },
  chat: { vi: ["Chat & điều khiển", "Đúng Pi session hiện tại, không tạo runtime thứ hai"], en: ["Chat & controls", "The exact current Pi session, without a second runtime"] },
  source: { vi: ["Source Changes", "Review thay đổi theo task baseline, working tree và staged"], en: ["Source Changes", "Review task baseline, working tree, and staged changes"] },
  activity: { vi: ["Activity", "Tool call, command, verifier và log preview"], en: ["Activity", "Tool calls, commands, verifiers, and bounded log previews"] },
  history: { vi: ["Lịch sử task", "Crash, resume, checkpoint, handoff và helper"], en: ["Task history", "Crash, resume, checkpoints, handoffs, and helpers"] },
  release: { vi: ["Release", "Benchmark evidence và mức sẵn sàng phát hành"], en: ["Release", "Benchmark evidence and release readiness"] }
};

function StatusPill({ value, text, locale = "vi" }: { value: string | null | undefined; text?: string; locale?: UiLocale }) {
  return <span className={`status-pill tone-${tone(value)}`}><span aria-hidden="true" className="status-dot" />{text ?? label(value, locale)}</span>;
}

function EmptyTask({ locale }: { locale: UiLocale }) {
  return <section className="task-empty surface" aria-labelledby="task-title"><div className="empty-mark" aria-hidden="true">π</div><div>
    <p className="section-kicker">Task contract</p><h2 id="task-title">{localize(locale, "Chưa có task đang chạy", "No active task")}</h2>
    <p>{localize(locale, "WebUI đang theo dõi đúng Pi session. Khi task bắt đầu, mục tiêu, tiêu chí và tiến độ sẽ xuất hiện tại đây.",
      "WebUI is observing the exact Pi session. Objectives, criteria, and progress will appear here when a task begins.")}</p>
  </div></section>;
}

export function TaskDashboard({ snapshot, locale }: { snapshot: PiagentWebUICanonicalSnapshotV1; locale: UiLocale }) {
  const task = snapshot.task;
  if (!task) return <EmptyTask locale={locale} />;
  const progress = taskProgress(snapshot, locale);
  return <section className="task-dashboard surface" aria-labelledby="task-title">
    <header className="task-heading"><div><p className="section-kicker">{localize(locale, "Task hiện tại", "Current task")}</p><h2 id="task-title">{task.summary}</h2>
      <div className="task-meta"><StatusPill value={task.outcome} locale={locale} /><span>{label(task.changeMode, locale)}</span><span>{label(task.riskLane, locale)}</span></div></div>
      <div className="progress-number" aria-label={`${localize(locale, "Tiến độ", "Progress")} ${progress.percent}%`}><strong>{progress.percent}%</strong><span>{progress.text}</span></div></header>
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={localize(locale, "Tiến độ tiêu chí", "Criteria progress")}><span style={{ width: `${progress.percent}%` }} /></div>
    {task.blocker && <div className="blocker" role="status"><span>Blocker</span><p>{task.blocker}</p></div>}
    <div className="criteria-heading"><h2>{localize(locale, "Tiêu chí hoàn thành", "Completion criteria")}</h2><span>{task.criteria.length} {localize(locale, "tiêu chí", "criteria")}</span></div>
    <ol className="criteria-list">{task.criteria.map((criterion, index) => <li key={criterion.criterionId} className="criterion-card">
      <span className={`criterion-index tone-${tone(criterion.state)}`}>{String(index + 1).padStart(2, "0")}</span><div className="criterion-copy"><div><p>{criterion.obligation}</p>
        {criterion.priority === "critical" && <span className="critical-tag">{localize(locale, "Quan trọng", "Critical")}</span>}</div><small>{criterionMeta(criterion, locale)}</small></div>
      <StatusPill value={criterion.state} locale={locale} /></li>)}</ol>
    {task.workPlan.length > 0 && <details className="work-plan"><summary>{localize(locale, "Kế hoạch thực hiện", "Work plan")} · {task.workPlan.length} {localize(locale, "bước", "steps")}</summary>
      <ol>{task.workPlan.map((step) => <li key={step.stepId}><StatusPill value={step.status} locale={locale} /><span>{step.summary}</span></li>)}</ol></details>}
  </section>;
}

function ContextRail({ snapshot, locale }: { snapshot: PiagentWebUICanonicalSnapshotV1; locale: UiLocale }) {
  return <aside className="context-rail" aria-label={localize(locale, "Tóm tắt phiên", "Session summary")}>
    <section className="surface compact-panel"><p className="section-kicker">Task contract</p><dl>
      <div><dt>Task ID</dt><dd title={snapshot.identity.taskId ?? undefined}>{compactRef(snapshot.identity.taskId)}</dd></div>
      <div><dt>Run ID</dt><dd title={snapshot.identity.taskRunId ?? undefined}>{compactRef(snapshot.identity.taskRunId)}</dd></div>
      <div><dt>Verifier</dt><dd><StatusPill value={snapshot.verification.state} locale={locale} /></dd></div>
      <div><dt>Queue</dt><dd>{snapshot.session.queue.state === "known" ? `${snapshot.session.queue.heldCount ?? 0} ${localize(locale, "đang giữ", "held")}` : label(snapshot.session.queue.state, locale)}</dd></div>
    </dl></section>
    <section className="surface compact-panel"><p className="section-kicker">{localize(locale, "Sức khỏe", "Health")}</p><div className="health-line"><StatusPill value={snapshot.health.state} locale={locale} />
      <span>{snapshot.health.issues.length} {localize(locale, "lưu ý", "issues")}</span></div>{snapshot.health.issues.slice(0, 3).map((issue) => <p className="health-issue" key={issue.issueRef}>{issue.message}</p>)}</section>
  </aside>;
}

export function RuntimeOverview({ snapshot, locale }: { snapshot: PiagentWebUICanonicalSnapshotV1; locale: UiLocale }) {
  const facts: Array<[string, ReactNode]> = [
    ["Runtime", <StatusPill value={snapshot.session.operation.liveness} locale={locale} />],
    ["Task", <StatusPill value={snapshot.session.controlState} locale={locale} />],
    ["Model", <strong>{modelName(snapshot, locale)}</strong>],
    ["Thinking", <strong>{thinkingName(snapshot, locale)}</strong>],
    [localize(locale, "Quyền", "Permission"), <strong>{permissionName(snapshot, locale)}</strong>],
    ["Approval", <StatusPill value={snapshot.session.approvalState} locale={locale} />]
  ];
  return <Paper variant="outlined" className="runtime-overview" aria-label={localize(locale, "Trạng thái Pi session", "Pi session status")} sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0,1fr))", sm: "repeat(3, minmax(0,1fr))", xl: "repeat(6, minmax(0,1fr))" }, overflow: "hidden" }}>
    {facts.map(([name, value]) => <Box key={name} sx={{ minWidth: 0, minHeight: 72, px: 2, py: 1.5, display: "flex", flexDirection: "column", justifyContent: "center", gap: .75, borderRight: 1, borderBottom: { xs: 1, xl: 0 }, borderColor: "divider", "&:last-child": { borderRight: 0 } }}>
      <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 800, letterSpacing: ".11em", textTransform: "uppercase" }}>{name}</Typography>{value}
    </Box>)}
  </Paper>;
}

function WorkspaceContent({ active, snapshot, events, refreshSnapshot, locale }: { active: WorkspaceId; snapshot: PiagentWebUICanonicalSnapshotV1;
  events: RuntimeStreamEvent[]; refreshSnapshot?: AppProps["refreshSnapshot"]; locale: UiLocale }) {
  if (active === "overview") return <Stack className="workspace-stack" spacing={2.25}><RuntimeOverview snapshot={snapshot} locale={locale} />
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(0,1fr) 300px" }, alignItems: "start", gap: 2.25 }}><TaskDashboard snapshot={snapshot} locale={locale} /><ContextRail snapshot={snapshot} locale={locale} /></Box>
    <EvidencePanels snapshot={snapshot} /></Stack>;
  if (active === "chat") return <Stack className="workspace-stack" spacing={2.25}><LifecyclePanel snapshot={snapshot} refreshSnapshot={refreshSnapshot} />
    <SessionOptionsPanel snapshot={snapshot} refreshSnapshot={refreshSnapshot} /><ChatPanel snapshot={snapshot} events={events} refreshSnapshot={refreshSnapshot} /></Stack>;
  if (active === "source") return <SourceWorkspace snapshot={snapshot} refreshSnapshot={refreshSnapshot} />;
  if (active === "activity") return <ActivityPanel snapshot={snapshot} />;
  if (active === "history") return <TaskRunIndexPanel snapshot={snapshot} />;
  return <ReleaseMonitorPanel snapshot={snapshot} />;
}

export function App({ snapshot, connection = "connecting", events = [], refreshSnapshot }: AppProps) {
  const { locale, colorMode, setLocale, setColorMode } = useUiPreferences();
  const [active, setActive] = useState<WorkspaceId>("overview");
  const [mobileOpen, setMobileOpen] = useState(false);
  if (!snapshot) return <Box className="loading-shell"><Box className="brand-mark" aria-hidden="true">π</Box><p className="section-kicker">Piagent WebUI · local</p>
    <Typography variant="h1">{connection === "failed" ? localize(locale, "Không thể nối vào Pi session", "Unable to connect to the Pi session") : localize(locale, "Đang mở không gian làm việc", "Opening the workspace")}</Typography>
    <Typography color="text.secondary">{connection === "failed" ? localize(locale, "Hãy mở lại WebUI từ Pi terminal để tạo phiên local mới.", "Reopen WebUI from the Pi terminal to create a new local session.") : localize(locale, "Đang tải task contract và trạng thái runtime hiện tại…", "Loading the task contract and current runtime state…")}</Typography>
    {connection !== "failed" && <CircularProgress size={22} />}<StatusPill value={connection} locale={locale} /></Box>;

  const current = workspaceCopy[active][locale];
  const sourceCount = (snapshot.sourceChanges.task?.counts.files ?? 0) + snapshot.sourceChanges.workingTree.counts.files + snapshot.sourceChanges.staged.counts.files;
  const nav: Array<{ id: WorkspaceId; label: string; icon: ReactNode; count?: number }> = [
    { id: "overview", label: localize(locale, "Tổng quan", "Overview"), icon: <DashboardRounded /> },
    { id: "chat", label: localize(locale, "Chat & Task", "Chat & Task"), icon: <ChatBubbleRounded />, count: snapshot.session.queue.heldCount ?? 0 },
    { id: "source", label: "Source Changes", icon: <DifferenceRounded />, count: sourceCount },
    { id: "activity", label: "Activity", icon: <TerminalRounded />, count: snapshot.activity.running.length },
    { id: "history", label: localize(locale, "Lịch sử", "History"), icon: <HistoryRounded /> },
    { id: "release", label: "Release", icon: <RocketLaunchRounded /> }
  ];
  const choose = (id: WorkspaceId) => { setActive(id); setMobileOpen(false); };
  const drawer = <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
    <Toolbar sx={{ minHeight: "72px !important", px: "18px !important", gap: 1.25 }}><Box className="brand-mark" aria-hidden="true">π</Box><Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontWeight: 760, lineHeight: 1.15 }}>Piagent</Typography><Typography variant="caption" color="text.disabled">WebUI · local</Typography></Box></Toolbar>
    <Box sx={{ mx: 1.5, mb: 1.25, p: 1.35, border: 1, borderColor: "divider", borderRadius: 2, bgcolor: "action.hover" }}>
      <Typography variant="caption" color="text.disabled" sx={{ display: "block", textTransform: "uppercase", letterSpacing: ".09em" }}>{localize(locale, "Pi session hiện tại", "Current Pi session")}</Typography>
      <Typography variant="body2" noWrap title={snapshot.session.displayName ?? undefined} sx={{ mt: .45, fontWeight: 700 }}>{snapshot.session.displayName ?? "Pi session"}</Typography>
      <Typography variant="caption" color="text.secondary" title={snapshot.identity.sessionRef}>{compactRef(snapshot.identity.sessionRef)}</Typography>
    </Box>
    <Typography variant="caption" color="text.disabled" sx={{ px: 2.5, pt: 1, pb: .5, fontWeight: 800, letterSpacing: ".1em", textTransform: "uppercase" }}>{localize(locale, "Không gian làm việc", "Workspaces")}</Typography>
    <List component="nav" aria-label={localize(locale, "Điều hướng WebUI", "WebUI navigation")} sx={{ py: .5 }}>{nav.map((item) => <ListItemButton key={item.id} selected={active === item.id} aria-current={active === item.id ? "page" : undefined} onClick={() => choose(item.id)}>
      <ListItemIcon sx={{ minWidth: 36, color: "inherit", "& .MuiSvgIcon-root": { fontSize: 19 } }}>{item.icon}</ListItemIcon><ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: 13, fontWeight: active === item.id ? 750 : 600 } } }} />
      {Boolean(item.count) && <Badge badgeContent={item.count} color={item.id === "activity" ? "secondary" : "primary"} max={99} sx={{ mr: 1 }} />}</ListItemButton>)}</List>
    <Box sx={{ mt: "auto", p: 1.5 }}><Divider sx={{ mb: 1.5 }} /><Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <ToggleButtonGroup exclusive size="small" value={locale} aria-label={localize(locale, "Ngôn ngữ", "Language")} onChange={(_, value: UiLocale | null) => value && setLocale(value)} sx={{ flex: 1 }}>
        <ToggleButton value="vi" aria-label="Tiếng Việt" sx={{ flex: 1 }}>VI</ToggleButton><ToggleButton value="en" aria-label="English" sx={{ flex: 1 }}>EN</ToggleButton>
      </ToggleButtonGroup>
      <Tooltip title={colorMode === "dark" ? localize(locale, "Chuyển sang giao diện sáng", "Use light mode") : localize(locale, "Chuyển sang giao diện tối", "Use dark mode")}>
        <IconButton aria-label={colorMode === "dark" ? localize(locale, "Dùng giao diện sáng", "Use light mode") : localize(locale, "Dùng giao diện tối", "Use dark mode")} onClick={() => setColorMode(colorMode === "dark" ? "light" : "dark")} sx={{ border: 1, borderColor: "divider", borderRadius: 1.5 }}>
          {colorMode === "dark" ? <LightModeRounded fontSize="small" /> : <DarkModeRounded fontSize="small" />}</IconButton></Tooltip>
    </Stack></Box>
  </Box>;

  return <Box className="app-shell" data-contract="snapshot-v1">
    <a className="skip-link" href="#main-content">{localize(locale, "Bỏ qua điều hướng", "Skip navigation")}</a>
    <AppBar position="fixed" color="transparent" elevation={0} sx={{ width: { md: `calc(100% - ${DRAWER_WIDTH}px)` }, ml: { md: `${DRAWER_WIDTH}px` }, borderBottom: 1, borderColor: "divider", bgcolor: "rgba(var(--piagent-palette-background-defaultChannel) / .88)", backdropFilter: "blur(18px)" }}>
      <Toolbar sx={{ minHeight: "72px !important", gap: 1.5 }}><IconButton edge="start" aria-label={localize(locale, "Mở menu", "Open menu")} onClick={() => setMobileOpen(true)} sx={{ display: { md: "none" } }}><MenuRounded /></IconButton>
        <Box sx={{ minWidth: 0, flex: 1 }}><Typography component="h1" variant="h2" noWrap>{current[0]}</Typography><Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", sm: "block" } }}>{current[1]}</Typography></Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }} aria-live="polite"><Chip variant="outlined" size="small" color={connection === "connected" ? "success" : "default"} label={connection === "connected" ? "Live" : label(connection, locale)} />
          {snapshot.approvals.pending.length > 0 && <Chip color="warning" size="small" label={`${snapshot.approvals.pending.length} approval`} />}
          <Chip variant="outlined" size="small" sx={{ display: { xs: "none", sm: "flex" } }} label={snapshot.capabilities.capabilities["control.chat"].status === "available" ? localize(locale, "Chat bật", "Chat enabled") : localize(locale, "Chỉ xem", "Read only")} /></Stack>
      </Toolbar>
    </AppBar>
    <Box component="nav" aria-label={localize(locale, "Sidebar chính", "Primary sidebar")} sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
      <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }} sx={{ display: { xs: "block", md: "none" }, "& .MuiDrawer-paper": { width: DRAWER_WIDTH } }}>{drawer}</Drawer>
      <Drawer variant="permanent" open sx={{ display: { xs: "none", md: "block" }, "& .MuiDrawer-paper": { width: DRAWER_WIDTH, borderRight: 1, borderColor: "divider", bgcolor: "background.paper" } }}>{drawer}</Drawer>
    </Box>
    <Box component="main" id="main-content" sx={{ ml: { md: `${DRAWER_WIDTH}px` }, minWidth: 0, pt: "72px" }}>
      <Box className={`workspace-view workspace-${active}`} sx={{ width: "100%", maxWidth: active === "source" ? "none" : 1580, mx: "auto", p: { xs: 1.5, sm: 2.5, lg: 3 } }}>
        {snapshot.approvals.pending.length > 0 && <Box sx={{ mb: 2.25 }}><ApprovalPanel snapshot={snapshot} refreshSnapshot={refreshSnapshot} /></Box>}
        <WorkspaceContent active={active} snapshot={snapshot} events={events} refreshSnapshot={refreshSnapshot} locale={locale} />
      </Box>
    </Box>
  </Box>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import AddRounded from "@mui/icons-material/AddRounded";
import AttachFileRounded from "@mui/icons-material/AttachFileRounded";
import CancelRounded from "@mui/icons-material/CancelRounded";
import DifferenceRounded from "@mui/icons-material/DifferenceRounded";
import MenuRounded from "@mui/icons-material/MenuRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import SendRounded from "@mui/icons-material/SendRounded";
import ViewSidebarOutlined from "@mui/icons-material/ViewSidebarOutlined";
import StopCircleRounded from "@mui/icons-material/StopCircleRounded";
import AppBar from "@mui/material/AppBar";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Catalog, SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { PermissionMode, Receipt, Workflow } from "../../contracts/generated/session-command-v1.ts";
import type { PiagentGatewayCapabilityHandshakeV1 } from "../../contracts/generated/gateway-capabilities-v1.ts";
import { readSessionConnections, readSessionInspectionSnapshot, stageSessionAttachment,
  type SessionConnections } from "./api.ts";
import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import { acceptAttribute, attachmentDetail, discardAttachment, dragCarriesFiles, MAX_ATTACHMENTS,
  stageFiles } from "./attachment-intake.ts";
import { CompanyReconnect, createFailureText } from "./CompanyReconnect.tsx";
import { NewSessionPage } from "./NewSessionPage.tsx";
import { SessionComposerControls } from "./SessionComposerControls.tsx";
import { SessionInspectorDrawer } from "./SessionInspectorDrawer.tsx";
import { SessionTranscript } from "./SessionTranscript.tsx";
import { SessionSidebar, sessionActivity, type SessionMenuAction, type ProjectGroup } from "./SessionSidebar.tsx";
import { ChangesPanel } from "./ChangesPanel.tsx";
import type { SessionWorkspaceId } from "./SessionAgentWorkspace.tsx";
import { SettingsPage, type SettingsSection } from "./SettingsPage.tsx";
import { StatusBar, STATUS_BAR_HEIGHT } from "./StatusBar.tsx";
import { CommandPalette, useDashboardShortcuts } from "./CommandPalette.tsx";
import { dashboardCommands } from "./dashboard-commands.tsx";
import { updateInProgress, useUpdates } from "./update-state.tsx";
import type { ConnectionState } from "./use-inspection.ts";
import type { LiveConversation, TerminalOperationActivity } from "./live-state-view-model.ts";
import type { SessionSendResult } from "./use-session-hub.ts";
import { launchProjectRef } from "./bootstrap.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";
import { LatestRequestWins } from "./latest-request.ts";
import { SEND_ADMISSION_WINDOW_MS } from "./session-hub-contract.ts";
import { sendsOnEnter } from "./enter-key.ts";

const SIDEBAR_WIDTH = 280;
const PANEL_WIDTH = 320;
const INSPECTOR_WIDTH = "min(44vw, 860px)";
const PANEL_KEY = "piagent-webui-workspace-panel";
type HubView = "chat" | "new";

// What the agent is doing now, from live Gateway state first: the catalog row
// can lag a finished turn by a refresh.
function WorkStatus({ session, live, locale }: { session: SessionRow; live?: LiveConversation; locale: UiLocale }) {
  const activity = sessionActivity(session, live);
  const [text, color] = activity === "running" ? [localize(locale, "Đang chạy", "Running"), "primary"] as const
    : activity === "elsewhere" ? [localize(locale, "Đang chạy ở nơi khác", "Running elsewhere"), "info"] as const
    : activity === "attention" ? [localize(locale, "Cần duyệt", "Needs approval"), "warning"] as const
      : activity === "recovery" ? [localize(locale, "Cần khôi phục", "Recovery needed"), "error"] as const
        : activity === "failed" ? [localize(locale, "Lượt cuối lỗi", "Last turn failed"), "error"] as const
          : [localize(locale, "Sẵn sàng", "Ready"), "default"] as const;
  return <Chip size="small" variant="outlined" color={color} label={text} />;
}

function Conversation({ session, snapshot, locale, live, canSend, canRestart, send, abort, restart, onInspector }: { session: SessionRow;
  snapshot?: PiagentWebUICanonicalSnapshotV1; locale: UiLocale; live?: LiveConversation; canSend: boolean;
  send(message: string, attachment?: { messageRequestId: string; attachmentRefs: string[]; attachments?: Attachment[]; workflow?: Workflow }): Promise<SessionSendResult>;
  abort(): Promise<unknown>; restart(): Promise<unknown>; canRestart: boolean; onInspector(value: SessionWorkspaceId): void }) {
  const [draft, setDraft] = useState(""), [submitting, setSubmitting] = useState(false), [connections, setConnections] = useState<SessionConnections>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [messageRequestId, setMessageRequestId] = useState(() => `message-request.${crypto.randomUUID()}`);
  const [uploading, setUploading] = useState(false), [attachError, setAttachError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<{ tone: "warning" | "error"; text: string } | null>(null);
  const [sendUnconfirmed, setSendUnconfirmed] = useState(false);
  // An unconfirmed send that no Gateway took within its window has expired and
  // can no longer run: the draft stays and the member may send it again.
  useEffect(() => {
    if (!sendUnconfirmed) return;
    const timer = window.setTimeout(() => {
      setSendUnconfirmed(false);
      setSendNotice({ tone: "error", text: localize(locale,
        "Tin nhắn chưa được gửi: phiên chưa nhận nó trong 2 phút nên nó sẽ không chạy nữa. Nội dung vẫn còn; bấm Gửi để thử lại.",
        "The message was not sent: the session did not take it within 2 minutes, so it will not run. Your message is kept; send it again.") });
    }, SEND_ADMISSION_WINDOW_MS + 15_000);
    return () => window.clearTimeout(timer);
  }, [sendUnconfirmed, locale]);
  const [restartingRuntime, setRestartingRuntime] = useState(false);
  const [dragging, setDragging] = useState(false), [transcriptLoad, setTranscriptLoad] = useState(0);
  // dragenter and dragleave fire again for every child the pointer crosses, so a
  // boolean set on leave clears the highlight while the file is still over the
  // composer. Counting entries against leaves tracks the region as a whole.
  const dragDepth = useRef(0);
  useEffect(() => { setDraft(""); setAdvancedOpen(false); setAttachments([]); setAttachError(null); setSendNotice(null);
    setSendUnconfirmed(false);
    setMessageRequestId(`message-request.${crypto.randomUUID()}`); }, [session.sessionRef]);


  // A file dropped anywhere the composer does not cover is navigated to by the
  // browser, which replaces the running session with the file.
  useEffect(() => {
    const block = (event: DragEvent) => { if (dragCarriesFiles(event.dataTransfer)) event.preventDefault(); };
    window.addEventListener("dragover", block); window.addEventListener("drop", block);
    return () => { window.removeEventListener("dragover", block); window.removeEventListener("drop", block); };
  }, []);

  const attachmentsCapability = snapshot?.capabilities.capabilities.attachments;
  const allowedMimeTypes = useMemo(() => new Set<string>(attachmentsCapability?.status === "available" ? attachmentsCapability.mimeTypes : []),
    [attachmentsCapability]);
  const acceptTypes = useMemo(() => acceptAttribute(allowedMimeTypes), [allowedMimeTypes]);
  const canAttach = Boolean(snapshot) && attachmentsCapability?.status === "available" && canSend && !submitting && !sendUnconfirmed && !uploading
    && attachments.length < MAX_ATTACHMENTS;

  const takeFiles = async (files: FileList | null) => {
    if (!files?.length || !snapshot || attachmentsCapability?.status !== "available" || uploading) return;
    setUploading(true); setAttachError(null);
    try {
      const outcome = await stageFiles({ files, snapshot, messageRequestId, existing: attachments, allowed: allowedMimeTypes, locale,
        stage: (command) => stageSessionAttachment(session.sessionRef, command) });
      setAttachments(outcome.attachments); setAttachError(outcome.status);
    } catch { setAttachError(localize(locale, "Không thể đính kèm; file không được gửi vào Pi.", "Unable to attach the file; it was not sent to Pi.")); }
    finally { setUploading(false); }
  };
  const removeAttachment = async (attachmentRef: string) => {
    if (!snapshot || submitting || uploading) return;
    setUploading(true); setAttachError(null);
    try {
      const outcome = await discardAttachment({ snapshot, messageRequestId, attachmentRef, locale,
        stage: (command) => stageSessionAttachment(session.sessionRef, command) });
      if (outcome.discarded) setAttachments((current) => current.filter((entry) => entry.attachmentRef !== attachmentRef));
      else setAttachError(outcome.status);
    } catch { setAttachError(localize(locale, "Không thể bỏ file; trạng thái session có thể đã thay đổi.", "Unable to remove the file; session state may have changed.")); }
    finally { setUploading(false); }
  };
  useEffect(() => {
    const controller = new AbortController(); setConnections(undefined);
    void readSessionConnections(session.sessionRef, controller.signal).then(setConnections).catch(() => undefined);
    return () => controller.abort();
  }, [session.sessionRef, session.sessionRevision]);
  // `submitting` reaches the next render only: a second Enter in between is
  // held off by this ref, so one message is never sent twice.
  const sendingNow = useRef(false);
  const submit = async () => {
    const message = draft; if (!message.trim() || submitting || sendUnconfirmed || sendingNow.current) return;
    sendingNow.current = true; setSubmitting(true); setSendNotice(null);
    const staged = attachments.map((item) => item.attachmentRef);
    try {
      const result = await send(message, staged.length > 0
        ? { messageRequestId, attachmentRefs: staged, attachments } : undefined);
      if (result.state === "unconfirmed") {
        setSendUnconfirmed(true);
        setSendNotice({ tone: "warning", text: localize(locale,
          "Piagent đang xác nhận lần gửi này. Nội dung và file vẫn được giữ; đừng gửi lại để tránh chạy trùng.",
          "Piagent is confirming this send. Your message and files remain preserved; do not resend, to avoid a duplicate run.") });
        return;
      }
      // Refs are one-shot: the dispatch consumed them, so the next message starts
      // from a fresh request id rather than reusing refs that no longer exist.
      setDraft(""); setAttachments([]); setAttachError(null); setMessageRequestId(`message-request.${crypto.randomUUID()}`);
    } catch {
      // A thrown send is a deterministic pre-admission rejection. Transport or
      // effect uncertainty resolves through the non-error branch above so the
      // UI never describes an already-running operation as failed.
      setSendNotice({ tone: "error", text: localize(locale,
        "Tin nhắn chưa được gửi. Nội dung và file vẫn được giữ; có thể thử lại khi session sẵn sàng.",
        "The message was not sent. Your message and files are preserved; retry when the session is ready.") });
    }
    finally { sendingNow.current = false; setSubmitting(false); }
  };
  useEffect(() => {
    if (!sendUnconfirmed || live?.messageRequestId !== messageRequestId || live.delivery !== "admitted") return;
    setDraft(""); setAttachments([]); setAttachError(null); setSendNotice(null); setSendUnconfirmed(false);
    setMessageRequestId(`message-request.${crypto.randomUUID()}`);
  }, [live?.delivery, live?.messageRequestId, messageRequestId, sendUnconfirmed]);
  // One click to pick a stopped task up again, in the same conversation.
  const continueTask = async () => {
    if (submitting || sendUnconfirmed) return;
    setSubmitting(true); setSendNotice(null);
    try { await send(localize(locale, "tiếp tục", "continue")); }
    catch { setSendNotice({ tone: "error", text: localize(locale, "Chưa gửi được. Thử lại khi session sẵn sàng.", "Not sent. Retry when the session is ready.") }); }
    finally { setSubmitting(false); }
  };
  const refreshConnections = async (value?: SessionConnections) => {
    if (value) { setConnections(value); return; }
    setConnections(await readSessionConnections(session.sessionRef).catch(() => connections));
  };
  const restartRuntime = async () => {
    if (restartingRuntime) return;
    setRestartingRuntime(true);
    try { await restart(); }
    catch { /* the recovery alert remains actionable and the catalog refresh carries authoritative state */ }
    finally { setRestartingRuntime(false); }
  };
  // "stale": another process still appears to hold this conversation.
  const recovery = live?.runtimeRecovery ?? (session.state === "recovery-required" ? "stale" as const : null);
  return <Box sx={{ minHeight: "calc(100vh - 68px)", display: "flex", flexDirection: "column" }}>
    <Box sx={{ flex: 1, width: "100%", maxWidth: 860, mx: "auto", px: { xs: 2, sm: 4 }, py: { xs: 3, md: 4 },
      display: "flex", flexDirection: "column", justifyContent: "center" }}>
      {!canSend && session.modelLabel === "agent-watch-auto" && <CompanyReconnect key={session.sessionRef} locale={locale} onConnected={() => setTranscriptLoad((value) => value + 1)} />}
      <Box sx={{ width: "100%" }}><SessionTranscript key={session.sessionRef} reload={transcriptLoad} sessionRef={session.sessionRef} sessionRevision={session.sessionRevision}
        live={live} approvals={snapshot?.approvals} locale={locale} onOpenActivity={() => onInspector("activity")}
        onContinue={canSend && !submitting && !sendUnconfirmed && session.liveState !== "running" && (!live || live.complete) ? () => void continueTask() : undefined} /></Box>
    </Box>
    <Box sx={{ position: "sticky", bottom: "var(--piagent-status-bar, 0px)", px: { xs: 1.5, sm: 2.5 }, pb: 2.5,
      background: "linear-gradient(transparent, var(--piagent-palette-background-default) 25%)" }}>
      {session.state === "terminal-owned" && <Alert severity="info" role="status" sx={{ maxWidth: 820, mx: "auto", mb: 1 }}>
        {localize(locale, "Cuộc trò chuyện này đang chạy trong Terminal hoặc một tiến trình Piagent khác. Trang này tự cập nhật để bạn theo dõi; gửi tin nhắn khi nó chạy xong.",
          "This conversation is running in Terminal or another Piagent process. This page follows it; send a message when it has finished.")}</Alert>}
      {recovery && <Alert severity={recovery === "recovered" ? "success" : recovery === "failed" ? "error" : "warning"}
        action={(recovery === "failed" || recovery === "required" || recovery === "stale") && canRestart && session.liveState !== "running"
          ? <Button color="inherit" size="small" disabled={restartingRuntime} onClick={() => void restartRuntime()}>
            {restartingRuntime ? localize(locale, "Đang khởi động…", "Restarting…") : localize(locale, "Khởi động lại phiên", "Restart session")}
          </Button> : undefined}
        sx={{ maxWidth: 860, mx: "auto", mb: 1 }}>
        {recovery === "recovered"
          ? localize(locale, "Runtime mới đã được xác minh; lịch sử và context của session được giữ nguyên.", "The new runtime is verified; session history and context were preserved.")
          : recovery === "failed"
            ? localize(locale, "Runtime đã đổi nhưng chưa khởi động lại được. Hãy dùng nút bên cạnh hoặc restart Dashboard.", "The runtime changed but could not restart. Use the action here or restart the Dashboard.")
            : recovery === "stale"
              ? localize(locale, "Phiên này chưa được đóng đúng cách và có thể đang mở ở cửa sổ Terminal khác. Đóng cửa sổ đó (nếu có) rồi bấm Khởi động lại phiên để làm tiếp; lịch sử được giữ nguyên.",
                "This session was not closed cleanly and may still be open in a Terminal window. Close it (if any), then restart the session to go on; its history is kept.")
            : recovery === "restarting"
              ? localize(locale, "Runtime vừa được cập nhật. Piagent đang khởi động lại session an toàn sau lượt hiện tại.", "The runtime was updated. Piagent is safely restarting the session after the current turn.")
              : localize(locale, "Phát hiện runtime mới. Piagent sẽ giữ câu trả lời hiện tại rồi tự khởi động lại session.", "A new runtime was detected. Piagent will preserve the current response and restart the session automatically.")}
      </Alert>}
      <Box sx={{ position: "relative", maxWidth: 860, mx: "auto", border: 1, borderColor: dragging ? "primary.main" : "divider",
        borderStyle: dragging ? "dashed" : "solid", borderRadius: 3, bgcolor: "background.paper", p: 1.15,
        boxShadow: "0 14px 44px rgba(0,0,0,.14)" }}
      onDragEnter={(event) => { if (dragCarriesFiles(event.dataTransfer)) { dragDepth.current += 1; setDragging(true); } }}
      onDragOver={(event) => { if (dragCarriesFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = canAttach ? "copy" : "none"; } }}
      onDragLeave={(event) => { if (dragCarriesFiles(event.dataTransfer)) { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } } }}
      onDrop={(event) => {
        if (!dragCarriesFiles(event.dataTransfer)) return;
        event.preventDefault(); dragDepth.current = 0; setDragging(false);
        if (canAttach) void takeFiles(event.dataTransfer.files);
      }}>
        {dragging && <Box role="status" sx={{ position: "absolute", inset: 0, zIndex: 3, display: "grid", alignContent: "center", justifyItems: "center",
          gap: .5, borderRadius: 3, bgcolor: "background.paper", opacity: .96, pointerEvents: "none", textAlign: "center" }}>
          <Typography sx={{ fontWeight: 750 }}>{canAttach ? localize(locale, "Thả tài liệu vào đây", "Drop documents here")
            : attachments.length >= MAX_ATTACHMENTS ? localize(locale, `Đã đủ ${MAX_ATTACHMENTS} file cho tin nhắn này`, `This message already holds ${MAX_ATTACHMENTS} files`)
              : localize(locale, "Chưa nhận file lúc này", "Files cannot be attached right now")}</Typography>
          {canAttach && <Typography variant="caption" color="text.secondary">
            {localize(locale, ".md .txt .csv .json .yaml .docx .pdf và ảnh", ".md .txt .csv .json .yaml .docx .pdf and images")}</Typography>}
        </Box>}
        {attachments.length > 0 && <Stack direction="row" sx={{ flexWrap: "wrap", gap: .75, px: .5, pb: .75 }}
          aria-label={localize(locale, "File sẽ gửi cùng tin nhắn", "Files to send with the message")}>
          {attachments.map((item) => <Chip key={item.attachmentRef} size="small" variant="outlined"
            color={item.kind === "document" ? "success" : "default"}
            label={`${item.displayName} · ${attachmentDetail(item, locale)}`}
            onDelete={submitting || sendUnconfirmed || uploading ? undefined : () => void removeAttachment(item.attachmentRef)}
            deleteIcon={<CancelRounded aria-label={`${localize(locale, "Bỏ", "Remove")} ${item.displayName}`} role="button" />} />)}
        </Stack>}
        <TextField fullWidth multiline minRows={2} disabled={!canSend || submitting || sendUnconfirmed} value={draft} onChange={(event) => { setDraft(event.target.value); setSendNotice(null); }}
          onKeyDown={(event) => { if (sendsOnEnter(event)) { event.preventDefault(); void submit(); } }}
          onPaste={(event) => {
            // Only a clipboard actually carrying files is intercepted, so pasting
            // text — including text copied out of a document — still types.
            if (!event.clipboardData?.files.length) return;
            event.preventDefault();
            if (canAttach) void takeFiles(event.clipboardData.files);
          }}
          placeholder={localize(locale, "Nhắn cho Piagent…", "Message Piagent…")} variant="standard" slotProps={{ input: { disableUnderline: true } }} />
        <Collapse in={advancedOpen} id="piagent-message-options">
          <Box sx={{ mt: .65, p: .85, borderRadius: 2, bgcolor: "action.hover" }}>
            <SessionComposerControls session={session} snapshot={snapshot} connections={connections} locale={locale}
              onOpenChanges={() => onInspector("source")} onConnectionsChanged={refreshConnections} />
            <Stack direction="row" sx={{ minWidth: 0, alignItems: "center", gap: .75, flexWrap: "wrap" }}>
              {attachmentsCapability?.status === "available" && <Tooltip title={localize(locale,
                "Chọn file, hoặc kéo thả / dán thẳng vào khung chat", "Pick a file, or drag and drop / paste straight into the chat")}>
                <Button component="label" size="small" color="inherit" startIcon={<AttachFileRounded />} disabled={!canAttach}
                  aria-label={`${localize(locale, "Đính kèm", "Attach")} (${attachments.length}/${MAX_ATTACHMENTS})`}>
                  {localize(locale, "Đính kèm", "Attach")}
                  <input type="file" multiple hidden disabled={!canAttach} accept={acceptTypes || undefined}
                    onChange={(event) => { void takeFiles(event.target.files); event.currentTarget.value = ""; }} />
                </Button></Tooltip>}
            </Stack>

          </Box>
        </Collapse>
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center", mt: .5, gap: 1 }}>
          <Stack direction="row" sx={{ minWidth: 0, alignItems: "center", gap: 1 }}>
            <Tooltip title={advancedOpen ? localize(locale, "Ẩn tùy chọn", "Hide options") : localize(locale, "File và công cụ", "Files and tools")}>
              <IconButton size="small" aria-label={advancedOpen ? localize(locale, "Ẩn tùy chọn", "Hide options") : localize(locale, "Thêm tùy chọn", "More options")}
                aria-expanded={advancedOpen} aria-controls="piagent-message-options" onClick={() => setAdvancedOpen((value) => !value)}
                sx={{ bgcolor: advancedOpen ? "action.selected" : "transparent" }}>
                <AddRounded fontSize="small" sx={{ transition: "transform .16s ease", transform: advancedOpen ? "rotate(45deg)" : "none" }} />
              </IconButton>
            </Tooltip>
            <Typography variant="caption" color={attachError || sendNotice?.tone === "error" ? "error"
              : sendNotice ? "warning.main" : "text.disabled"} noWrap={!sendNotice}
              sx={{ display: { xs: attachError || sendNotice || uploading ? "block" : "none", sm: "block" } }}>
              {sendNotice?.text ?? attachError ?? (uploading ? localize(locale, "Đang đọc tài liệu…", "Reading documents…")
                : live && !live.complete
                  ? localize(locale, "Piagent đang xử lý; có thể gửi việc tiếp theo khi lượt này xong.",
                    "Piagent is working; you can send the next task when it finishes.")
                  : canSend ? localize(locale, "Enter để gửi · Shift+Enter xuống dòng", "Enter to send · Shift+Enter for a new line")
                  : localize(locale, "Session hiện chỉ đọc", "Session is currently read only"))}</Typography>
          </Stack>
          {live?.operationRef && !live.complete && live.abortable !== false
            ? <Button color="error" startIcon={<StopCircleRounded />} onClick={() => void abort()}>{localize(locale, "Dừng", "Stop")}</Button>
            : <IconButton aria-label={localize(locale, "Gửi", "Send")} disabled={!canSend || submitting || sendUnconfirmed || !draft.trim()} color="primary" onClick={() => void submit()}
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

export function SessionHubApp({ catalog, capabilities, connection, live, terminalActivities, refresh, create, send, abort, restart, setModel, setThinking, setPermission,
  rename, pin, archive, unarchive, fork }: { catalog?: Catalog;
  capabilities?: PiagentGatewayCapabilityHandshakeV1; connection: ConnectionState; live: Readonly<Record<string, LiveConversation>>;
  terminalActivities: Readonly<Record<string, TerminalOperationActivity[]>>;
  refresh(): Promise<Catalog | undefined>; create(value: { projectRef: string; placeRef: string; modelRef: string | null;
    thinkingLevel: string; workflow?: Workflow; permissionMode: PermissionMode | null; message: string; messageRequestId?: string; deferInitialMessage?: boolean }): Promise<Receipt>;
  send(session: SessionRow, message: string, attachment?: { messageRequestId: string; attachmentRefs: string[]; attachments?: Attachment[];
    workflow?: Workflow }): Promise<SessionSendResult>;
  abort(session: SessionRow): Promise<unknown>;
    restart(session: SessionRow): Promise<unknown>;
    setModel(session: SessionRow, modelRef: string): Promise<unknown>; setThinking(session: SessionRow, thinkingLevel: string): Promise<unknown>;
    setPermission(session: SessionRow, permissionMode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<unknown>;
    rename(session: SessionRow, title: string): Promise<Receipt>; pin(session: SessionRow, pinned: boolean): Promise<Receipt>;
    archive(session: SessionRow): Promise<Receipt>; unarchive(session: SessionRow): Promise<Receipt>;
    fork(session: SessionRow, title: string | null): Promise<Receipt> }) {
  const { locale, colorMode, setLocale, setColorMode } = useUiPreferences();
  const updates = useUpdates(), [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState(""), [selectedRef, setSelectedRef] = useState<string>();
  const [mobileOpen, setMobileOpen] = useState(false), [showArchived, setShowArchived] = useState(false);
  const [view, setView] = useState<HubView>("chat"), [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [inspectorOpen, setInspectorOpen] = useState(false), [activeInspector, setActiveInspector] = useState<SessionWorkspaceId>("task");
  // The Workspace panel is part of the layout on wide screens and a drawer
  // on narrow ones; the choice is remembered in this browser.
  const narrow = typeof window !== "undefined" && window.innerWidth < 1200;
  const [panelOpen, setPanelOpen] = useState(() => {
    try { const stored = window.localStorage.getItem(PANEL_KEY); if (stored) return stored === "open"; } catch { /* storage may be blocked */ }
    return window.innerWidth >= 1200;
  });
  const togglePanel = () => setPanelOpen((value) => {
    try { window.localStorage.setItem(PANEL_KEY, value ? "closed" : "open"); } catch { /* best effort */ }
    return !value;
  });
  const activityInspectorOpenRef = useRef(false);
  activityInspectorOpenRef.current = inspectorOpen && activeInspector === "activity";
  const [inspection, setInspection] = useState<PiagentWebUICanonicalSnapshotV1>();
  const inspectionRef = useRef<{ sessionRef: string; snapshot: PiagentWebUICanonicalSnapshotV1 } | null>(null);
  const [inspectionState, setInspectionState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const inspectionStateSessionRef = useRef<string | null>(null);
  const inspectionRequests = useRef<LatestRequestWins<PiagentWebUICanonicalSnapshotV1> | null>(null);
  inspectionRequests.current ??= new LatestRequestWins<PiagentWebUICanonicalSnapshotV1>();
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
  const selectedSessionRef = selected?.sessionRef;
  // Work run outside this Gateway (company Terminal, scripts) is not announced
  // to it: follow it by re-reading the catalog, faster while one is open.
  const followingElsewhere = selected?.state === "terminal-owned", anyElsewhere = (catalog?.sessions ?? []).some((item) => item.state === "terminal-owned");
  useEffect(() => {
    const every = followingElsewhere ? 3_000 : anyElsewhere ? 10_000 : 30_000;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, every);
    return () => window.clearInterval(timer);
  }, [followingElsewhere, anyElsewhere, refresh]);
  const selectedSessionRefRef = useRef<string | undefined>(selectedSessionRef);
  selectedSessionRefRef.current = selectedSessionRef;
  const currentInspection = inspectionRef.current && inspectionRef.current.sessionRef === selectedSessionRef
    && inspectionRef.current.snapshot === inspection ? inspection : undefined;
  const currentInspectionState = inspectionStateSessionRef.current === selectedSessionRef
    ? inspectionState : selectedSessionRef ? "loading" : "idle";
  const selectedLive = selected ? live[selected.sessionRef] : undefined;
  // Opened for one project (Agent Watch's WebUI button): start a new
  // conversation there; choosing another conversation ends that preference.
  const [launchProject, setLaunchProject] = useState<string | null>(null), launchHandled = useRef(false);
  useEffect(() => {
    if (!catalog || launchHandled.current) return;
    launchHandled.current = true;
    const ref = launchProjectRef();
    if (ref) { setLaunchProject(ref); setView("new"); }
  }, [catalog]);
  const choose = (value: string) => { setLaunchProject(null); setSelectedRef(value); setView("chat"); setMobileOpen(false); };
  const openSettings = (section: SettingsSection) => { setSettingsSection(section); setSettingsOpen(true); };
  useDashboardShortcuts({ palette: () => setPaletteOpen(true), settings: () => openSettings("general") });
  const openInspector = (active: SessionWorkspaceId) => { setActiveInspector(active); setInspectorOpen(true); };
  const refreshInspection = async () => {
    const requestedSessionRef = selectedSessionRefRef.current;
    if (!requestedSessionRef) return undefined;
    if (inspectionRef.current?.sessionRef !== requestedSessionRef) {
      inspectionStateSessionRef.current = requestedSessionRef;
      setInspectionState("loading");
    }
    const next = await inspectionRequests.current!.run(() => readSessionInspectionSnapshot(requestedSessionRef),
      (value) => {
        if (selectedSessionRefRef.current !== requestedSessionRef) return;
        inspectionRef.current = { sessionRef: requestedSessionRef, snapshot: value };
        inspectionStateSessionRef.current = requestedSessionRef;
        setInspection(value); setInspectionState("ready");
      }, () => {
        if (selectedSessionRefRef.current !== requestedSessionRef) return;
        inspectionStateSessionRef.current = requestedSessionRef;
        setInspectionState(inspectionRef.current?.sessionRef === requestedSessionRef ? "ready" : "error");
      });
    return selectedSessionRefRef.current === requestedSessionRef ? next : undefined;
  };
  useEffect(() => {
    if (!selectedSessionRef) {
      inspectionRequests.current!.invalidate();
      inspectionRef.current = null; inspectionStateSessionRef.current = null;
      setInspection(undefined); setInspectionState("idle"); return;
    }
    const requestedSessionRef = selectedSessionRef, controller = new AbortController();
    inspectionStateSessionRef.current = requestedSessionRef;
    if (inspectionRef.current?.sessionRef !== requestedSessionRef) {
      inspectionRef.current = null; setInspection(undefined); setInspectionState("loading");
    }
    void inspectionRequests.current!.run(() => readSessionInspectionSnapshot(requestedSessionRef, controller.signal),
      (value) => {
        if (controller.signal.aborted || selectedSessionRefRef.current !== requestedSessionRef) return;
        inspectionRef.current = { sessionRef: requestedSessionRef, snapshot: value };
        inspectionStateSessionRef.current = requestedSessionRef;
        setInspection(value); setInspectionState("ready");
      }, () => {
        if (controller.signal.aborted || selectedSessionRefRef.current !== requestedSessionRef) return;
        inspectionStateSessionRef.current = requestedSessionRef;
        setInspectionState(inspectionRef.current?.sessionRef === requestedSessionRef ? "ready" : "error");
      });
    return () => controller.abort();
  }, [selectedSessionRef, selected?.sessionRevision]);
  useEffect(() => {
    if (!inspectorOpen || activeInspector !== "activity" || !selectedSessionRef || !currentInspection
      || !selectedLive?.operationRef || selectedLive.complete) return;
    const requestedSessionRef = selectedSessionRef;
    let stopped = false, timer: number | undefined;
    const tick = async () => {
      await inspectionRequests.current!.run(() => readSessionInspectionSnapshot(requestedSessionRef),
        (value) => {
          if (stopped || !activityInspectorOpenRef.current || selectedSessionRefRef.current !== requestedSessionRef) return;
          inspectionRef.current = { sessionRef: requestedSessionRef, snapshot: value };
          inspectionStateSessionRef.current = requestedSessionRef;
          setInspection(value); setInspectionState("ready");
        }, () => undefined);
      if (!stopped) timer = window.setTimeout(() => void tick(), 2_000);
    };
    timer = window.setTimeout(() => void tick(), 2_000);
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [inspectorOpen, activeInspector, selectedSessionRef, Boolean(currentInspection), selectedLive?.operationRef, selectedLive?.complete]);
  const canCreate = connection === "connected" && capabilities?.capabilities.sessionActions.create.status === "available";
  const createNewSession = async (value: { projectRef: string; placeRef: string; modelRef: string | null;
    thinkingLevel: string; workflow?: Workflow; permissionMode: PermissionMode | null; message: string; files: readonly File[] }) => {
    setCreatingSession(true); setCreateError(null);
    let createdSessionRef: string | null = null;
    try {
      const messageRequestId = `message-request.${crypto.randomUUID()}`, withFiles = value.files.length > 0;
      const receipt = await create({ projectRef: value.projectRef, placeRef: value.placeRef, modelRef: value.modelRef,
        thinkingLevel: value.thinkingLevel, workflow: value.workflow, permissionMode: value.permissionMode,
        message: value.message, messageRequestId, deferInitialMessage: withFiles });
      createdSessionRef = receipt.sessionRef;
      if (!createdSessionRef) throw new Error("session-create-result-invalid");
      if (receipt.phase !== "settled") {
        setSelectedRef(createdSessionRef); setView("chat"); setNotice({
          title: localize(locale, "Session đã được tạo", "The session was created"),
          message: localize(locale,
            "Pi đã nhận yêu cầu và session đang tự đồng bộ. Không gửi lại để tránh chạy trùng.",
            "Pi received the request and the session is resyncing. Do not resend it, to avoid a duplicate run.")
        });
        return;
      }
      if (withFiles) {
        const latest = await refresh(), session = latest?.sessions.find((item) => item.sessionRef === createdSessionRef);
        if (!session) throw new Error("session-catalog-refresh-failed");
        const snapshot = await readSessionInspectionSnapshot(createdSessionRef);
        const attachmentCapability = snapshot.capabilities.capabilities.attachments;
        if (attachmentCapability.status !== "available") throw new Error(attachmentCapability.reason?.code ?? "session-attachment-unavailable");
        const staged = await stageFiles({ files: value.files, snapshot, messageRequestId, existing: [],
          allowed: new Set(attachmentCapability.mimeTypes), locale,
          stage: (command) => stageSessionAttachment(createdSessionRef!, command) });
        if (staged.status || staged.attachments.length !== value.files.length) {
          await Promise.all(staged.attachments.map(async (attachment) => {
            try { await discardAttachment({ snapshot, messageRequestId, attachmentRef: attachment.attachmentRef, locale,
              stage: (command) => stageSessionAttachment(createdSessionRef!, command) }); } catch { /* staged bytes expire owner-only */ }
          }));
          throw new Error(staged.status ?? "session-attachment-incomplete");
        }
        await send(session, value.message, { messageRequestId, attachmentRefs: staged.attachments.map((item) => item.attachmentRef),
          attachments: staged.attachments, workflow: value.workflow });
      }
      setSelectedRef(createdSessionRef); setView("chat");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "session-create-failed";
      if (createdSessionRef) {
        setSelectedRef(createdSessionRef); setView("chat"); setNotice({
          title: localize(locale, "Session đã tạo nhưng file chưa được gửi", "The session was created, but the files were not sent"), message
        });
      } else setCreateError(createFailureText(message, locale));
    } finally { setCreatingSession(false); }
  };
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

  const sidebar = <SessionSidebar locale={locale} canCreate={canCreate} query={query} onQuery={setQuery} groups={projectGroups}
    count={sessions.length} selectedRef={view === "chat" ? selected?.sessionRef : undefined} showArchived={showArchived} archivedCount={archivedCount}
    settingsOpen={settingsOpen} connection={connection} live={live} onSelect={choose} onAction={beginSessionAction}
    onNew={() => { setCreateError(null); setView("new"); setMobileOpen(false); }}
    onToggleArchived={() => { setShowArchived((value) => !value); setMobileOpen(false); }}
    updateDot={Boolean(updates.status?.updateAvailable && updates.status.installable)}
    onSettings={() => { openSettings(updates.status?.updateAvailable && updates.status.installable ? "updates" : "general"); setMobileOpen(false); }} />;
  const workspacePanel = view === "chat" && selected ? <ChangesPanel session={selected} snapshot={currentInspection} live={selectedLive} locale={locale}
    onOpenReview={() => openInspector("source")} onClose={() => setPanelOpen(false)} /> : null;
  const panelShown = Boolean(workspacePanel) && panelOpen && !inspectorOpen;

  if (!catalog && connection !== "failed") return <Stack sx={{ minHeight: "100vh", alignItems: "center", justifyContent: "center" }} spacing={2}>
    <CircularProgress size={24} /><Typography>{localize(locale, "Đang mở Piagent…", "Opening Piagent…")}</Typography></Stack>;
  const title = view === "new" ? localize(locale, "Cuộc trò chuyện mới", "New chat") : selected?.title ?? "Piagent";
  const commands = dashboardCommands({ locale, colorMode, canCreate, hasSelection: view === "chat" && Boolean(selected),
    sessions: (catalog?.sessions ?? []).filter((item) => !item.archived),
    update: { available: Boolean(updates.status?.updateAvailable && updates.status.installable && !updateInProgress(updates.status)), latest: updates.status?.piagent.latest ?? null },
    actions: { newChat: () => { setCreateError(null); setView("new"); }, togglePanel, openChanges: () => openInspector("source"), refresh: () => void refresh(),
      settings: openSettings, checkUpdates: () => { openSettings("updates"); void updates.check(); }, setColorMode, setLocale, openSession: choose } });
  const running = Object.values(live).filter((item) => item && !item.complete).length;
  return <Box sx={{ minHeight: "100vh", bgcolor: "background.default", "--piagent-status-bar": { xs: "0px", md: `${STATUS_BAR_HEIGHT}px` } }}>
    <AppBar position="fixed" color="transparent" elevation={0} sx={{ left: { md: `${SIDEBAR_WIDTH}px` }, right: { lg: panelShown ? `${PANEL_WIDTH}px` : 0, xl: inspectorOpen ? INSPECTOR_WIDTH : panelShown ? `${PANEL_WIDTH}px` : 0 },
      width: { xs: "100%", md: "auto" }, borderBottom: 1, transition: "right .2s ease",
      borderColor: "divider", bgcolor: "rgba(var(--piagent-palette-background-defaultChannel) / .9)", backdropFilter: "blur(18px)" }}><Toolbar sx={{ minHeight: "60px !important", gap: 1 }}>
      <IconButton aria-label={localize(locale, "Mở điều hướng", "Open navigation")} onClick={() => setMobileOpen(true)} sx={{ display: { md: "none" } }}><MenuRounded /></IconButton>
      <Box sx={{ flex: 1, minWidth: 0 }}><Typography component="h1" noWrap sx={{ fontWeight: 600, fontSize: "inherit" }}>{title}</Typography>
        {view === "chat" && selected && <Typography variant="caption" color="text.secondary" noWrap>{selected.projectLabel}</Typography>}</Box>
      {view === "chat" && selected && <><SessionComposerControls placement="header" session={selected} snapshot={currentInspection} locale={locale}
        onOpenChanges={() => openInspector("source")}
        canSetModel={connection === "connected" && capabilities?.capabilities.sessionActions.setModel.status === "available"}
        canSetThinking={connection === "connected" && capabilities?.capabilities.sessionActions.setThinking.status === "available"}
        canSetPermission={connection === "connected" && capabilities?.capabilities.sessionActions.setPermission.status === "available"}
        onSetModel={(modelRef) => setModel(selected, modelRef)} onSetThinking={(value) => setThinking(selected, value)}
        onSetPermission={(value) => setPermission(selected, value)} />
        <Box sx={{display:{xs:'none',sm:'block'}}}><WorkStatus session={selected} live={selectedLive} locale={locale} /></Box><Tooltip title="Source Changes"><IconButton aria-label={localize(locale, "Mở Source Changes Inspector", "Open Source Changes Inspector")}
          onClick={() => openInspector("source")}><DifferenceRounded fontSize="small" /></IconButton></Tooltip>
        <Tooltip title={localize(locale, "Khung Workspace: thay đổi, ngữ cảnh, subagent", "Workspace panel: changes, context, subagents")}>
          <IconButton aria-label={localize(locale, "Khung Workspace", "Workspace panel")} aria-pressed={panelShown} onClick={() => togglePanel()}
            color={panelShown ? "primary" : "default"}><ViewSidebarOutlined fontSize="small" sx={{ transform: "scaleX(-1)" }} /></IconButton></Tooltip></>}
      <Tooltip title={localize(locale, "Làm mới", "Refresh")}><IconButton aria-label={localize(locale, "Làm mới", "Refresh")} onClick={() => void refresh()}><RefreshRounded fontSize="small" /></IconButton></Tooltip>
    </Toolbar></AppBar>
    <Box component="nav" sx={{ width: { md: SIDEBAR_WIDTH } }}><Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)}
      sx={{ display: { xs: "block", md: "none" }, "& .MuiDrawer-paper": { width: SIDEBAR_WIDTH } }}>{sidebar}</Drawer><Drawer variant="permanent"
      sx={{ display: { xs: "none", md: "block" }, "& .MuiDrawer-paper": { width: SIDEBAR_WIDTH, borderRight: 1, borderColor: "divider",
        height: "calc(100% - var(--piagent-status-bar, 0px))" } }}>{sidebar}</Drawer></Box>
    <Box component="main" sx={{ ml: { md: `${SIDEBAR_WIDTH}px` }, mr: { lg: panelShown ? `${PANEL_WIDTH}px` : 0, xl: inspectorOpen ? INSPECTOR_WIDTH : panelShown ? `${PANEL_WIDTH}px` : 0 },
      pt: "60px", transition: "margin-right .2s ease" }}>
      {view === "new" ? <NewSessionPage active defaultProjectRef={launchProject ?? selected?.projectRef} busy={creatingSession} error={createError} onCancel={() => setView("chat")}
        onCreate={(value) => createNewSession(value)} />
        : selected ? <Conversation session={selected} snapshot={currentInspection} locale={locale} live={live[selected.sessionRef]}
            canSend={connection === "connected" && selected.composerAvailable && capabilities?.capabilities.sessionActions.send.status === "available"
              && (!selectedLive || selectedLive.complete)
              && !["required", "restarting", "failed"].includes(String(live[selected.sessionRef]?.runtimeRecovery))}
            canRestart={connection === "connected" && capabilities?.capabilities.sessionActions.release.status === "available"
              && capabilities?.capabilities.sessionActions.acquire.status === "available"}
            send={(message, attachment) => send(selected, message, attachment)} abort={() => abort(selected).catch((error) => setNotice({
              title: localize(locale, "Chưa dừng được lượt này", "This turn could not be stopped"),
              message: error instanceof Error && error.message === "operation-unavailable"
                ? localize(locale, "Lượt đã kết thúc hoặc đang chuyển bước. Nếu vẫn còn chạy, bấm Dừng lần nữa.", "The turn already ended or is between steps. If it is still running, press Stop again.")
                : error instanceof Error ? error.message : "session-abort-failed" }))} restart={() => restart(selected)} onInspector={openInspector} />
            : <EmptyHub locale={locale} canCreate={canCreate} onNew={() => setView("new")} />}
    </Box>
    {workspacePanel && panelShown && !narrow && <Box component="aside" sx={{ display: { xs: "none", lg: "block" }, position: "fixed", top: 0, right: 0, bottom: "var(--piagent-status-bar, 0px)",
      width: PANEL_WIDTH, borderLeft: 1, borderColor: "divider", zIndex: (theme) => theme.zIndex.appBar - 1 }}>{workspacePanel}</Box>}
    {workspacePanel && <Drawer anchor="right" variant="temporary" open={panelOpen && !inspectorOpen && narrow} onClose={() => setPanelOpen(false)}
      sx={{ display: { xs: "block", lg: "none" }, "& .MuiDrawer-paper": { width: `min(${PANEL_WIDTH}px, 88vw)` } }}>{workspacePanel}</Drawer>}
    <SessionInspectorDrawer open={inspectorOpen} active={activeInspector} snapshot={currentInspection} state={currentInspectionState} sessionRef={selectedSessionRef}
      terminalActivities={selected ? terminalActivities[selected.sessionRef] : undefined}
      liveActivities={selectedLive && !selectedLive.complete ? selectedLive.activities : undefined}
      onClose={() => setInspectorOpen(false)} onActive={setActiveInspector} refresh={refreshInspection} />
    <StatusBar locale={locale} connection={connection} running={running} onUpdates={() => openSettings("updates")} onPalette={() => setPaletteOpen(true)} />
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} locale={locale} />
    <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} fullWidth maxWidth="lg" aria-labelledby="piagent-settings-title"
      slotProps={{ paper: { sx: { m: { xs: 0, sm: 2 }, width: { xs: "100%", sm: "calc(100% - 32px)" },
        height: { xs: "100%", sm: "min(86vh, 840px)" }, maxHeight: { xs: "100%", sm: "86vh" }, borderRadius: { xs: 0, sm: 2.5 }, overflow: "hidden" } } }}>
      <SettingsPage section={settingsSection} onSection={setSettingsSection} onBack={() => setSettingsOpen(false)} session={selected}
        snapshot={currentInspection} capabilities={capabilities} connection={connection}
        onSetModel={selected ? (modelRef) => setModel(selected, modelRef) : undefined}
        onSetThinking={selected ? (value) => setThinking(selected, value) : undefined}
        onSetPermission={selected ? (value) => setPermission(selected, value) : undefined}
        onRuntimeChanged={async () => { await refresh(); await refreshInspection(); }} />
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

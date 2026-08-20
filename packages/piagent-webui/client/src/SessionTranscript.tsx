import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import AutoAwesomeOutlined from "@mui/icons-material/AutoAwesomeOutlined";
import CheckCircleOutlineRounded from "@mui/icons-material/CheckCircleOutlineRounded";
import CodeRounded from "@mui/icons-material/CodeRounded";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import EditNoteRounded from "@mui/icons-material/EditNoteRounded";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import ImageOutlined from "@mui/icons-material/ImageOutlined";
import SearchRounded from "@mui/icons-material/SearchRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { ApprovalSummary } from "../../contracts/generated/snapshot-v1.ts";
import type { AttachmentSummary, PiagentWebUIBoundedTranscriptProjectionV1, ToolCall, TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import { ApprovalRequestList } from "./ApprovalPanel.tsx";
import { readSessionTranscript } from "./api.ts";
import { mergeOlderTranscriptPage } from "./chat-view-model.ts";
import { attachmentDetail } from "./attachment-intake.ts";
import type { LiveActivity, LiveConversation } from "./use-session-hub.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";
import { label } from "./view-model.ts";

const MarkdownMessage = lazy(async () => ({ default: (await import("./MarkdownMessage.tsx")).MarkdownMessage }));

function AssistantText({ children }: { children: string }) {
  return <Suspense fallback={<Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.75 }}>{children}</Typography>}>
    <MarkdownMessage>{children}</MarkdownMessage>
  </Suspense>;
}

type ActivityItem = { toolCallRef: string; toolName: string; state: "requested" | "running" | "completed" | "failed" | "unknown" };

function activityKind(toolName: string): "read" | "image" | "command" | "edit" | "search" | "context" | "verify" | "generic" {
  const value = toolName.toLowerCase();
  if (/(?:view[_-]?image|image[_-]?(?:read|view))/.test(value)) return "image";
  if (/(?:apply[_-]?patch|edit|write|create[_-]?file|replace)/.test(value)) return "edit";
  if (/(?:bash|exec|shell|terminal|command)/.test(value)) return "command";
  if (/(?:web|search|browser|fetch)/.test(value)) return "search";
  if (/(?:compact|context|memory)/.test(value)) return "context";
  if (/(?:test|verify|check|lint)/.test(value)) return "verify";
  if (/(?:read|grep|find|list|glob|document)/.test(value)) return "read";
  return "generic";
}

function activityLabel(item: ActivityItem, locale: UiLocale): string {
  const kind = activityKind(item.toolName), running = item.state === "requested" || item.state === "running", failed = item.state === "failed";
  const labels = {
    read: running ? localize(locale, "Đang đọc file", "Reading files") : failed ? localize(locale, "Đọc file gặp lỗi", "File read failed") : localize(locale, "Đã đọc file", "Read files"),
    image: running ? localize(locale, "Đang xem ảnh", "Viewing an image") : failed ? localize(locale, "Xem ảnh gặp lỗi", "Image view failed") : localize(locale, "Đã xem ảnh", "Viewed an image"),
    command: running ? localize(locale, "Đang chạy lệnh", "Running a command") : failed ? localize(locale, "Lệnh chạy lỗi", "Command failed") : localize(locale, "Đã chạy lệnh", "Ran a command"),
    edit: running ? localize(locale, "Đang cập nhật source", "Updating source") : failed ? localize(locale, "Cập nhật source gặp lỗi", "Source update failed") : localize(locale, "Đã cập nhật source", "Updated source"),
    search: running ? localize(locale, "Đang tìm kiếm", "Searching") : failed ? localize(locale, "Tìm kiếm gặp lỗi", "Search failed") : localize(locale, "Đã tìm kiếm", "Searched"),
    context: running ? localize(locale, "Đang tối ưu cuộc trò chuyện", "Optimizing the conversation") : failed
      ? localize(locale, "Tối ưu context gặp lỗi", "Context optimization failed") : localize(locale, "Đã tối ưu cuộc trò chuyện", "Optimized the conversation"),
    verify: running ? localize(locale, "Đang kiểm tra", "Running checks") : failed ? localize(locale, "Kiểm tra chưa đạt", "Checks failed") : localize(locale, "Đã kiểm tra", "Ran checks"),
    generic: running ? localize(locale, "Agent đang làm việc", "Agent is working") : failed
      ? localize(locale, "Thao tác gặp lỗi", "Action failed") : localize(locale, "Đã hoàn tất thao tác", "Completed an action")
  } as const;
  return labels[kind];
}

function ActivityIcon({ item }: { item: ActivityItem }) {
  if (item.state === "requested" || item.state === "running") return <CircularProgress size={17} thickness={4} color="inherit" />;
  if (item.state === "failed") return <ErrorOutlineRounded sx={{ fontSize: 20 }} />;
  const kind = activityKind(item.toolName);
  if (kind === "image") return <ImageOutlined sx={{ fontSize: 20 }} />;
  if (kind === "command") return <CodeRounded sx={{ fontSize: 20 }} />;
  if (kind === "edit") return <EditNoteRounded sx={{ fontSize: 21 }} />;
  if (kind === "search" || kind === "read") return <SearchRounded sx={{ fontSize: 20 }} />;
  if (kind === "context") return <AutoAwesomeOutlined sx={{ fontSize: 20 }} />;
  return <CheckCircleOutlineRounded sx={{ fontSize: 20 }} />;
}

function ActivityRow({ item, locale, onOpenActivity }: { item: ActivityItem; locale: UiLocale; onOpenActivity?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <Box><ButtonBase aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} sx={{ width: "100%", minHeight: 34,
    justifyContent: "flex-start", gap: 1.15, px: .25, py: .35, borderRadius: 1.5, color: item.state === "failed" ? "error.main" : "text.secondary",
    "&:hover": { bgcolor: "action.hover", color: "text.primary" } }}>
    <Box sx={{ width: 23, height: 23, display: "grid", placeItems: "center", flex: "0 0 auto" }}><ActivityIcon item={item} /></Box>
    <Typography variant="body2" sx={{ minWidth: 0, flex: 1, textAlign: "left", fontWeight: 500 }}>{activityLabel(item, locale)}</Typography>
    <ExpandMoreRounded sx={{ fontSize: 18, opacity: .65, transform: expanded ? "rotate(180deg)" : "none", transition: "transform .16s" }} />
  </ButtonBase><Collapse in={expanded} unmountOnExit><Stack direction="row" sx={{ alignItems: "center", gap: 1, pl: 4.2, pt: .25, pb: .5 }}>
    <Typography variant="caption" color="text.disabled" noWrap sx={{ minWidth: 0 }}>{item.toolName}</Typography>
    {onOpenActivity && <Button size="small" variant="text" onClick={onOpenActivity} sx={{ ml: "auto", minWidth: 0, px: .75 }}>
      {localize(locale, "Mở Activity", "Open Activity")}</Button>}
  </Stack></Collapse></Box>;
}

function ActivityRows({ activities, locale, onOpenActivity, sx }: { activities: readonly ActivityItem[]; locale: UiLocale;
  onOpenActivity?: () => void; sx?: object }) {
  if (!activities.length) return null;
  return <Stack spacing={.2} sx={{ width: "min(100%, 560px)", ...sx }} aria-label={localize(locale, "Hoạt động của agent", "Agent activity")}>
    {activities.map((item) => <ActivityRow key={item.toolCallRef} item={item} locale={locale} onOpenActivity={onOpenActivity} />)}
  </Stack>;
}

function ToolRows({ item, locale, finalStates, onOpenActivity }: { item: TranscriptItem; locale: UiLocale;
  finalStates: ReadonlyMap<string, ToolCall["state"]>; onOpenActivity?: () => void }) {
  const activities = item.toolCalls.map((tool) => ({ toolCallRef: tool.toolCallRef, toolName: tool.toolName,
    state: finalStates.get(tool.toolCallRef) ?? tool.state }));
  return <ActivityRows activities={activities} locale={locale} onOpenActivity={onOpenActivity} sx={{ mt: item.content.text ? 1 : 0 }} />;
}

function AttachmentCards({ attachments, locale }: { attachments: readonly (AttachmentSummary | Attachment)[]; locale: UiLocale }) {
  if (!attachments.length) return null;
  return <Stack spacing={.75} sx={{ mb: 1 }} aria-label={localize(locale, "File đã gửi", "Sent files")}>{attachments.map((attachment, index) => {
    const live = "sourceBytes" in attachment;
    const detail = live ? attachmentDetail(attachment, locale) : `${attachment.kind === "document"
      ? localize(locale, "Tài liệu", "Document") : attachment.kind === "image" ? localize(locale, "Ảnh", "Image") : "File"}${attachment.truncated
        ? ` · ${localize(locale, "đã cắt bớt", "truncated")}` : ""}`;
    return <Paper key={`${attachment.displayName}:${index}`} variant="outlined" sx={{ display: "flex", alignItems: "center", gap: 1.1,
      minWidth: 220, maxWidth: 440, px: 1.2, py: 1, borderRadius: 2, bgcolor: "background.paper" }}>
      {attachment.kind === "image" ? <ImageOutlined color="action" /> : <DescriptionOutlined color="action" />}
      <Box sx={{ minWidth: 0 }}><Typography variant="body2" noWrap sx={{ fontWeight: 650 }}>{attachment.displayName}</Typography>
        <Typography variant="caption" color="text.secondary">{detail}</Typography></Box>
    </Paper>;
  })}</Stack>;
}

function unavailableMessage(reasonCode: string | null, locale: UiLocale): string {
  if (reasonCode === "provider-auth-expired") return localize(locale,
    "Phiên đăng nhập model đã hết hạn. Mở Cài đặt → Nhà cung cấp & model để kết nối lại.",
    "The model sign-in has expired. Open Settings → Providers & models to reconnect.");
  if (reasonCode === "provider-auth-required") return localize(locale,
    "Provider chưa được đăng nhập. Mở Cài đặt → Nhà cung cấp & model để kết nối.",
    "The provider is not signed in. Open Settings → Providers & models to connect.");
  if (reasonCode === "provider-rate-limited") return localize(locale,
    "Provider đang giới hạn yêu cầu. Hãy thử lại sau.", "The provider is rate limiting requests. Try again later.");
  if (reasonCode === "provider-unavailable") return localize(locale,
    "Không thể kết nối tới provider. Hãy kiểm tra kết nối rồi thử lại.", "The provider could not be reached. Check the connection and try again.");
  if (reasonCode === "provider-response-failed") return localize(locale,
    "Model không thể trả lời. Hãy kiểm tra kết nối provider rồi thử lại.", "The model could not respond. Check the provider connection and try again.");
  return localize(locale, "Nội dung này không khả dụng.", "This content is unavailable.");
}

function TranscriptMessage({ item, locale, finalStates, onOpenActivity }: { item: TranscriptItem; locale: UiLocale;
  finalStates: ReadonlyMap<string, ToolCall["state"]>; onOpenActivity?: () => void }) {
  const text = item.content.text;
  if (item.role === "tool-result") return <ToolRows item={item} locale={locale} finalStates={finalStates} onOpenActivity={onOpenActivity} />;
  if (item.role === "user") return <Box sx={{ alignSelf: "flex-end", maxWidth: "82%", bgcolor: "action.selected", borderRadius: 3, px: 2, py: 1.4 }}>
    <AttachmentCards attachments={item.attachments ?? []} locale={locale} />
    {text && <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>{text}</Typography>}
    {(item.content.redacted || item.content.truncated) && <Typography variant="caption" color="text.secondary">
      {item.content.redacted ? localize(locale, "Đã ẩn dữ liệu nhạy cảm", "Sensitive data hidden") : localize(locale, "Nội dung đã rút gọn", "Content truncated")}
    </Typography>}
  </Box>;
  if (!text && item.content.state === "available" && item.toolCalls.length) {
    return <ToolRows item={item} locale={locale} finalStates={finalStates} onOpenActivity={onOpenActivity} />;
  }
  return <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}><Box className="brand-mark" aria-hidden="true">π</Box>
    <Box sx={{ minWidth: 0, flex: 1 }}><Typography sx={{ fontWeight: 600 }}>Piagent</Typography>
      {text && <Box sx={{ mt: .6 }}><AssistantText>{text}</AssistantText></Box>}
      {!text && item.content.state !== "available" && <Alert severity="warning" sx={{ mt: 1 }}>
        {unavailableMessage(item.content.reasonCode, locale)}</Alert>}
      <ToolRows item={item} locale={locale} finalStates={finalStates} onOpenActivity={onOpenActivity} />
      {(item.content.redacted || item.content.truncated) && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .8 }}>
        {item.content.redacted ? localize(locale, "Đã ẩn dữ liệu nhạy cảm", "Sensitive data hidden") : localize(locale, "Nội dung đã rút gọn", "Content truncated")}
      </Typography>}
    </Box>
  </Box>;
}

function persistedUserMatches(persisted: string | null | undefined, optimistic: string): boolean {
  const actual = persisted?.trim(), expected = optimistic.trim();
  return Boolean(actual && expected && (actual === expected || actual.startsWith("/") && actual.endsWith(` ${expected}`)));
}

export function SessionTranscript({ sessionRef, sessionRevision, live, approvals, locale, onOpenActivity }: { sessionRef: string; sessionRevision: string;
  live?: LiveConversation; approvals?: ApprovalSummary; locale: UiLocale; onOpenActivity?: () => void }) {
  const [transcript, setTranscript] = useState<PiagentWebUIBoundedTranscriptProjectionV1>();
  const [loading, setLoading] = useState(true), [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState(false), [syncedOperation, setSyncedOperation] = useState<string | null>(null);
  const completionKey = live?.complete ? `${live.operationRef ?? "unknown"}:${live.user}:${live.assistant.length}` : null;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false); setSyncedOperation(null);
    const timer = window.setTimeout(() => {
      void readSessionTranscript(sessionRef, null, 50, controller.signal).then((value) => {
        setTranscript(value);
        if (completionKey && live) {
          const userPersisted = !live.user || value.items.some((item) => item.role === "user"
            && persistedUserMatches(item.content.text, live.user));
          const assistantPersisted = !live.assistant || value.items.some((item) => item.role === "assistant" && item.content.text?.trim() === live.assistant.trim());
          if (userPersisted && assistantPersisted) setSyncedOperation(completionKey);
        }
      }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, completionKey ? 100 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [sessionRef, sessionRevision, completionKey, live]);
  const items = transcript?.state === "ready" ? transcript.items : [];
  const finalToolStates = useMemo(() => {
    const values = new Map<string, ToolCall["state"]>();
    for (const item of items) for (const tool of item.toolCalls) values.set(tool.toolCallRef, tool.state);
    return values;
  }, [items]);
  const representedToolRefs = useMemo(() => new Set(items.filter((item) => item.role !== "tool-result")
    .flatMap((item) => item.toolCalls.map((tool) => tool.toolCallRef))), [items]);
  const visibleItems = useMemo(() => items.filter((item) => item.role !== "tool-result"
    || !item.toolCalls.some((tool) => representedToolRefs.has(tool.toolCallRef))), [items, representedToolRefs]);
  const liveVisible = Boolean(live && (!live.complete || syncedOperation !== completionKey));
  const liveUserDuplicated = useMemo(() => {
    if (!live?.user || !items.length) return false;
    const lastUser = [...items].reverse().find((item) => item.role === "user");
    return persistedUserMatches(lastUser?.content.text, live.user);
  }, [items, live?.user]);
  const loadOlder = async () => {
    const before = transcript?.page.nextBeforeCursor; if (!before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await readSessionTranscript(sessionRef, before, transcript.page.limit);
      setTranscript((current) => current ? { ...current, items: mergeOlderTranscriptPage(current.items, older.items), page: older.page } : older);
    } catch { setError(true); } finally { setLoadingOlder(false); }
  };
  return <Stack spacing={2.5}>
    {transcript?.page.hasOlder && <Box sx={{ textAlign: "center" }}><Button size="small" variant="text" startIcon={loadingOlder
      ? <CircularProgress size={14} /> : <HistoryRounded />} disabled={loadingOlder} onClick={() => void loadOlder()}>
      {localize(locale, "Tải tin cũ hơn", "Load older messages")}</Button></Box>}
    {loading && !transcript && <Box sx={{ py: 5, textAlign: "center" }}><CircularProgress size={22} /></Box>}
    {error && !transcript && <Alert severity="warning" icon={<ErrorOutlineRounded />}>
      {localize(locale, "Chưa tải được lịch sử session. Anh vẫn có thể thử lại bằng nút làm mới.", "Session history could not be loaded. You can retry with Refresh.")}
    </Alert>}
    {visibleItems.map((item) => <TranscriptMessage key={item.messageRef} item={item} locale={locale}
      finalStates={finalToolStates} onOpenActivity={onOpenActivity} />)}
    <ApprovalRequestList sessionRef={sessionRef} approvalRefs={approvals?.pending.map((item) => item.approvalRef) ?? []} />
    {liveVisible && live && <>
      {live.user && !liveUserDuplicated && <Box sx={{ alignSelf: "flex-end", maxWidth: "82%", bgcolor: "action.selected", borderRadius: 3, px: 2, py: 1.4 }}>
        <AttachmentCards attachments={live.attachments} locale={locale} />
        <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>{live.user}</Typography></Box>}
      <ActivityRows activities={live.activities.map((item: LiveActivity) => ({ toolCallRef: item.toolCallRef,
        toolName: item.toolLabel, state: item.state }))} locale={locale} onOpenActivity={onOpenActivity} />
      {(live.assistant || live.activities.length === 0 || live.complete || live.error) && <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}><Box className="brand-mark" aria-hidden="true">π</Box><Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontWeight: 600 }}>Piagent</Typography><Box sx={{ mt: .6 }}><AssistantText>
          {live.assistant || (live.complete ? localize(locale, "Đã hoàn tất.", "Completed.") : localize(locale, "Đang suy nghĩ…", "Thinking…"))}</AssistantText></Box>
        {live.error && <Alert severity="warning" sx={{ mt: 1.5 }}>{label(live.error, locale)}</Alert>}
      </Box></Box>}
    </>}
  </Stack>;
}

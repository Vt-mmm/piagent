import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import ImageOutlined from "@mui/icons-material/ImageOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { ApprovalSummary } from "../../contracts/generated/snapshot-v1.ts";
import type { AttachmentSummary, PiagentWebUIBoundedTranscriptProjectionV1, TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import { ApprovalRequestList } from "./ApprovalPanel.tsx";
import { readSessionTranscript } from "./api.ts";
import { mergeOlderTranscriptPage } from "./chat-view-model.ts";
import { attachmentDetail } from "./attachment-intake.ts";
import type { LiveConversation } from "./live-state-view-model.ts";
import { conversationTranscriptItems, successfulAssistantText } from "./transcript-view-model.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

const MarkdownMessage = lazy(async () => ({ default: (await import("./MarkdownMessage.tsx")).MarkdownMessage }));

function AssistantText({ children }: { children: string }) {
  return <Suspense fallback={<Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.75 }}>{children}</Typography>}>
    <MarkdownMessage>{children}</MarkdownMessage>
  </Suspense>;
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

function TranscriptMessage({ item, locale }: { item: TranscriptItem; locale: UiLocale }) {
  const text = item.role === "assistant" ? successfulAssistantText(item.content.text ?? "") : item.content.text;
  if (item.role === "user") return <Box sx={{ alignSelf: "flex-end", maxWidth: "82%", bgcolor: "action.selected", borderRadius: 3, px: 2, py: 1.4 }}>
    <AttachmentCards attachments={item.attachments ?? []} locale={locale} />
    {text && <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>{text}</Typography>}
    {(item.content.redacted || item.content.truncated) && <Typography variant="caption" color="text.secondary">
      {item.content.redacted ? localize(locale, "Đã ẩn dữ liệu nhạy cảm", "Sensitive data hidden") : localize(locale, "Nội dung đã rút gọn", "Content truncated")}
    </Typography>}
  </Box>;
  if (!text) return null;
  return <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}><Box className="brand-mark" aria-hidden="true">π</Box>
    <Box sx={{ minWidth: 0, flex: 1 }}><Typography sx={{ fontWeight: 600 }}>Piagent</Typography>
      {text && <Box sx={{ mt: .6 }}><AssistantText>{text}</AssistantText></Box>}
      {(item.content.redacted || item.content.truncated) && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .8 }}>
        {item.content.redacted ? localize(locale, "Đã ẩn dữ liệu nhạy cảm", "Sensitive data hidden") : localize(locale, "Nội dung đã rút gọn", "Content truncated")}
      </Typography>}
    </Box>
  </Box>;
}

function RunningStatus({ locale, onOpenActivity }: { locale: UiLocale; onOpenActivity?: () => void }) {
  return <Stack direction="row" spacing={1.25} role="status" aria-live="polite" sx={{ alignItems: "center", color: "text.secondary", py: .75 }}>
    <CircularProgress size={19} thickness={4} />
    <Typography variant="body2" sx={{ fontWeight: 600 }}>{localize(locale, "Piagent đang xử lý…", "Piagent is working…")}</Typography>
    {onOpenActivity && <Button size="small" variant="text" onClick={onOpenActivity} sx={{ ml: "auto !important" }}>
      {localize(locale, "Xem Activity", "View Activity")}</Button>}
  </Stack>;
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
  const visibleItems = useMemo(() => conversationTranscriptItems(items), [items]);
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
    {visibleItems.map((item) => <TranscriptMessage key={item.messageRef} item={item} locale={locale} />)}
    <ApprovalRequestList sessionRef={sessionRef} approvalRefs={approvals?.pending.map((item) => item.approvalRef) ?? []} />
    {liveVisible && live && <>
      {live.user && !liveUserDuplicated && <Box sx={{ alignSelf: "flex-end", maxWidth: "82%", bgcolor: "action.selected", borderRadius: 3, px: 2, py: 1.4 }}>
        <AttachmentCards attachments={live.attachments} locale={locale} />
        <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>{live.user}</Typography></Box>}
      {!live.complete && !live.error && <RunningStatus locale={locale} onOpenActivity={onOpenActivity} />}
      {live.complete && !live.error && successfulAssistantText(live.assistant || "") && <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
        <Box className="brand-mark" aria-hidden="true">π</Box><Box sx={{ minWidth: 0, flex: 1 }}><Typography sx={{ fontWeight: 600 }}>Piagent</Typography>
          <Box sx={{ mt: .6 }}><AssistantText>{successfulAssistantText(live.assistant || "")!}</AssistantText></Box></Box>
      </Box>}
    </>}
  </Stack>;
}

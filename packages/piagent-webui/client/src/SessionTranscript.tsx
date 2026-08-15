import { useEffect, useMemo, useState } from "react";
import BuildOutlined from "@mui/icons-material/BuildOutlined";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { ApprovalSummary } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIBoundedTranscriptProjectionV1, ToolCall, TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import { ApprovalRequestList } from "./ApprovalPanel.tsx";
import { readSessionTranscript } from "./api.ts";
import { mergeOlderTranscriptPage } from "./chat-view-model.ts";
import type { LiveConversation } from "./use-session-hub.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

function toolState(tool: ToolCall, locale: UiLocale): { label: string; color: "default" | "success" | "error" | "warning" } {
  if (tool.state === "completed") return { label: localize(locale, "Đã xong", "Completed"), color: "success" };
  if (tool.state === "failed") return { label: localize(locale, "Lỗi", "Failed"), color: "error" };
  if (tool.state === "requested") return { label: localize(locale, "Đang chạy", "Running"), color: "warning" };
  return { label: localize(locale, "Chưa rõ", "Unknown"), color: "default" };
}

function ToolRows({ item, locale }: { item: TranscriptItem; locale: UiLocale }) {
  if (item.role === "tool-result") {
    return <Paper variant="outlined" sx={{ px: 1.5, py: 1.15, borderRadius: 2, bgcolor: "action.hover" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}><BuildOutlined color="action" fontSize="small" />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{localize(locale, "Kết quả tool", "Tool result")}</Typography>
        <Typography variant="caption" color="text.secondary">{localize(locale, "Chi tiết ở Activity", "Details in Activity")}</Typography>
      </Stack>
    </Paper>;
  }
  if (!item.toolCalls.length) return null;
  return <Stack spacing={.75} sx={{ mt: 1.25 }}>
    {item.toolCalls.map((tool) => { const status = toolState(tool, locale); return <Paper key={tool.toolCallRef} variant="outlined"
      sx={{ px: 1.4, py: 1, borderRadius: 2, bgcolor: "action.hover" }}><Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <BuildOutlined fontSize="small" color="action" /><Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1, fontWeight: 600 }}>{tool.toolName}</Typography>
        <Chip size="small" variant="outlined" color={status.color} label={status.label} />
      </Stack></Paper>; })}
  </Stack>;
}

function TranscriptMessage({ item, locale }: { item: TranscriptItem; locale: UiLocale }) {
  const text = item.content.text;
  if (item.role === "tool-result") return <ToolRows item={item} locale={locale} />;
  if (item.role === "user") return <Box sx={{ alignSelf: "flex-end", maxWidth: "82%", bgcolor: "action.selected", borderRadius: 3, px: 2, py: 1.4 }}>
    {text && <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>{text}</Typography>}
    {(item.content.redacted || item.content.truncated) && <Typography variant="caption" color="text.secondary">
      {item.content.redacted ? localize(locale, "Đã ẩn dữ liệu nhạy cảm", "Sensitive data hidden") : localize(locale, "Nội dung đã rút gọn", "Content truncated")}
    </Typography>}
  </Box>;
  return <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}><Box className="brand-mark" aria-hidden="true">π</Box>
    <Box sx={{ minWidth: 0, flex: 1 }}><Typography sx={{ fontWeight: 600 }}>Piagent</Typography>
      {text && <Typography sx={{ mt: .6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.75 }}>{text}</Typography>}
      {!text && item.content.state !== "available" && <Typography color="text.secondary" sx={{ mt: .6 }}>
        {localize(locale, "Nội dung này không khả dụng.", "This content is unavailable.")}</Typography>}
      <ToolRows item={item} locale={locale} />
      {(item.content.redacted || item.content.truncated) && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .8 }}>
        {item.content.redacted ? localize(locale, "Đã ẩn dữ liệu nhạy cảm", "Sensitive data hidden") : localize(locale, "Nội dung đã rút gọn", "Content truncated")}
      </Typography>}
    </Box>
  </Box>;
}

export function SessionTranscript({ sessionRef, sessionRevision, live, approvals, locale }: { sessionRef: string; sessionRevision: string;
  live?: LiveConversation; approvals?: ApprovalSummary; locale: UiLocale }) {
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
          const userPersisted = !live.user || value.items.some((item) => item.role === "user" && item.content.text?.trim() === live.user.trim());
          const assistantPersisted = !live.assistant || value.items.some((item) => item.role === "assistant" && item.content.text?.trim() === live.assistant.trim());
          if (userPersisted && assistantPersisted) setSyncedOperation(completionKey);
        }
      }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, completionKey ? 100 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [sessionRef, sessionRevision, completionKey, live]);
  const items = transcript?.state === "ready" ? transcript.items : [];
  const liveVisible = Boolean(live && (!live.complete || syncedOperation !== completionKey));
  const liveUserDuplicated = useMemo(() => {
    if (!live?.user || !items.length) return false;
    const lastUser = [...items].reverse().find((item) => item.role === "user");
    return lastUser?.content.text?.trim() === live.user.trim();
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
    {items.map((item) => <TranscriptMessage key={item.messageRef} item={item} locale={locale} />)}
    <ApprovalRequestList sessionRef={sessionRef} approvalRefs={approvals?.pending.map((item) => item.approvalRef) ?? []} />
    {liveVisible && live && <>
      {live.user && !liveUserDuplicated && <Box sx={{ alignSelf: "flex-end", maxWidth: "82%", bgcolor: "action.selected", borderRadius: 3, px: 2, py: 1.4 }}>
        <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>{live.user}</Typography></Box>}
      <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}><Box className="brand-mark" aria-hidden="true">π</Box><Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontWeight: 600 }}>Piagent</Typography><Typography sx={{ mt: .6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.75 }}>
          {live.assistant || (live.complete ? localize(locale, "Đã hoàn tất.", "Completed.") : localize(locale, "Đang suy nghĩ…", "Thinking…"))}</Typography>
        {live.error && <Alert severity="warning" sx={{ mt: 1.5 }}>{live.error}</Alert>}
      </Box></Box>
    </>}
  </Stack>;
}

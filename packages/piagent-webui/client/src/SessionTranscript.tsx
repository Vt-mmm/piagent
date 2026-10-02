import { useEffect, useMemo, useRef, useState } from "react";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { ApprovalSummary } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIBoundedTranscriptProjectionV1 } from "../../contracts/generated/transcript-v1.ts";
import { ApprovalRequestList } from "./ApprovalPanel.tsx";
import { readSessionTranscript } from "./api.ts";
import { mergeOlderTranscriptPage } from "./chat-view-model.ts";
import { liveProgressStatus, type LiveConversation } from "./live-state-view-model.ts";
import { liveTokensPerSecond, timelineTurns } from "./timeline-view-model.ts";
import { LIVE_FAILURES, LiveTurnView, TimelineTurnView } from "./TimelineTurn.tsx";
import { durableTranscriptRefreshIdentity, persistedLiveConversationHasFinal,
  persistedLiveConversationMatches, persistedLiveUserExists, successfulAssistantText } from "./transcript-view-model.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// Tokens per second of the answer being streamed, estimated from its text.
function useLiveRate(text: string): number | null {
  const started = useRef<{ at: number; from: number } | null>(null), [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!text) { started.current = null; setRate(null); return; }
    started.current ??= { at: Date.now(), from: text.length };
    setRate(liveTokensPerSecond(text.length - started.current.from, Date.now() - started.current.at));
  }, [text]);
  return rate;
}

function RunningStatus({ live, locale, onOpenActivity }: { live: LiveConversation; locale: UiLocale; onOpenActivity?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(timer); }, []);
  const status = liveProgressStatus(live, locale, now), rate = useLiveRate(live.assistant ?? "");
  return <Stack direction="row" spacing={1.25} role="status" aria-live="polite" sx={{ alignItems: "center", color: "text.secondary", py: .75 }}>
    <CircularProgress size={19} thickness={4} />
    <Box sx={{ minWidth: 0 }}><Typography variant="body2" sx={{ fontWeight: 600 }}>{status.label}</Typography>
      <Typography variant="caption" color="text.disabled">{status.detail}{rate !== null && ` · ≈ ${rate} tok/s`}</Typography></Box>
    {onOpenActivity && <Button size="small" variant="text" onClick={onOpenActivity} sx={{ ml: "auto !important" }}>
      {localize(locale, "Xem Activity", "View Activity")}</Button>}
  </Stack>;
}

// `onContinue` (given while the conversation is idle and can take a message)
// sends "tiếp tục" for the last turn when it failed or has no answer.
export function SessionTranscript({ sessionRef, sessionRevision, live, approvals, locale, onOpenActivity, onContinue }: { sessionRef: string; sessionRevision: string;
  live?: LiveConversation; approvals?: ApprovalSummary; locale: UiLocale; onOpenActivity?: () => void; onContinue?: () => void }) {
  const [transcript, setTranscript] = useState<PiagentWebUIBoundedTranscriptProjectionV1>();
  const [loading, setLoading] = useState(true), [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState(false), [syncedOperation, setSyncedOperation] = useState<string | null>(null);
  const refreshIdentity = durableTranscriptRefreshIdentity(sessionRef, sessionRevision, live);
  const { completionKey, user: completedUser, assistant: completedAssistant,
    operationRef: completedOperationRef, messageRequestId: completedMessageRequestId, startedAt: completedStartedAt } = refreshIdentity;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false); setSyncedOperation(null);
    const timer = window.setTimeout(() => {
      void readSessionTranscript(sessionRef, null, 50, controller.signal).then((value) => {
        setTranscript(value);
        if (completionKey) {
          if (persistedLiveConversationMatches(value.items, completedUser, completedAssistant,
            { operationRef: completedOperationRef, messageRequestId: completedMessageRequestId,
              startedAt: completedStartedAt })) setSyncedOperation(completionKey);
        }
      }).catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, completionKey ? 100 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // Live tool and text deltas can arrive many times per second. Depending on
    // the whole live object here used to abort and restart this durable read on
    // every delta, which delayed the user's persisted bubble until activity
    // became quiet. CompletionKey captures the one terminal reconciliation we
    // need without turning progress into a transcript refresh loop.
  }, [refreshIdentity.key]);
  const items = transcript?.state === "ready" ? transcript.items : [];
  const turns = useMemo(() => timelineTurns(items), [items]);
  const durableFinalVisible = useMemo(() => Boolean(live?.user && persistedLiveConversationHasFinal(items, live.user,
    { operationRef: live.operationRef, messageRequestId: live.messageRequestId,
      startedAt: live.startedAt })), [items, live?.user, live?.operationRef, live?.messageRequestId, live?.startedAt]);
  const liveVisible = Boolean(live && !durableFinalVisible && (!live.complete || syncedOperation !== completionKey));
  const liveUserDuplicated = useMemo(() => Boolean(live?.user && persistedLiveUserExists(items, live.user,
    { operationRef: live.operationRef, messageRequestId: live.messageRequestId,
      startedAt: live.startedAt })), [items, live?.user, live?.operationRef, live?.messageRequestId, live?.startedAt]);
  const loadOlder = async () => {
    const before = transcript?.page.nextBeforeCursor; if (!before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await readSessionTranscript(sessionRef, before, transcript.page.limit);
      setTranscript((current) => current ? { ...current, items: mergeOlderTranscriptPage(current.items, older.items), page: older.page } : older);
    } catch { setError(true); } finally { setLoadingOlder(false); }
  };
  const liveAnswer = live ? successfulAssistantText(live.assistant || "") : null;
  return <Stack spacing={3}>
    {transcript?.page.hasOlder && <Box sx={{ textAlign: "center" }}><Button size="small" variant="text" startIcon={loadingOlder
      ? <CircularProgress size={14} /> : <HistoryRounded />} disabled={loadingOlder} onClick={() => void loadOlder()}>
      {localize(locale, "Tải tin cũ hơn", "Load older messages")}</Button></Box>}
    {loading && !transcript && <Box sx={{ py: 5, textAlign: "center" }}><CircularProgress size={22} /></Box>}
    {error && !transcript && <Alert severity="warning" icon={<ErrorOutlineRounded />}>
      {localize(locale, "Chưa tải được lịch sử cuộc trò chuyện. Thử lại bằng nút làm mới.", "Session history could not be loaded. You can retry with Refresh.")}
    </Alert>}
    {turns.map((turn, index) => <TimelineTurnView key={turn.key} turn={turn} locale={locale}
      onContinue={index === turns.length - 1 && !liveVisible && !(approvals?.pending.length) ? onContinue : undefined} />)}
    <ApprovalRequestList sessionRef={sessionRef} approvalRefs={approvals?.pending.map((item) => item.approvalRef) ?? []} />
    {liveVisible && live && <LiveTurnView user={live.user && !liveUserDuplicated ? live.user : null} attachments={live.attachments}
      activities={live.activities} assistant={live.error ? null : liveAnswer} running={!live.complete && !live.error}
      failure={live.complete && live.error && LIVE_FAILURES.has(live.error) ? live.error : null} locale={locale}
      status={<RunningStatus live={live} locale={locale} onOpenActivity={onOpenActivity} />} />}
  </Stack>;
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { ApprovalSummary } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIBoundedTranscriptProjectionV1 } from "../../contracts/generated/transcript-v1.ts";
import { DecisionQueue } from "./DecisionQueue.tsx";
import { waitingQuestion } from "./attention-view-model.ts";
import { readSessionTranscript } from "./api.ts";
import { mergeOlderTranscriptPage } from "./chat-view-model.ts";
import { liveProgressStatus, type LiveConversation } from "./live-state-view-model.ts";
import { liveTokensPerSecond, timelineTurns } from "./timeline-view-model.ts";
import { LIVE_FAILURES, LiveTurnView, preloadMarkdown, TimelineTurnView } from "./TimelineTurn.tsx";
import { durableTranscriptRefreshIdentity, persistedLiveConversationHasFinal,
  persistedLiveConversationMatches, persistedLiveUserExists, successfulAssistantText } from "./transcript-view-model.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";
import { CheckpointTimeline } from "./CheckpointTimeline.tsx";

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
  // One moving indicator per turn: a running step carries its own spinner and
  // streaming text its caret, so this line only spins while the agent thinks.
  const busyElsewhere = live.activities.some((activity) => activity.state === "running") || Boolean(live.assistant);
  return <Stack direction="row" spacing={1.25} role="status" aria-live="polite" sx={{ alignItems: "center", color: "text.secondary", py: .5, minHeight: 36 }}>
    <Box sx={{ width: 18, display: "grid", placeItems: "center", flexShrink: 0 }}>{busyElsewhere
      ? <Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: "primary.main", opacity: .7 }} />
      : <CircularProgress size={16} thickness={4.5} />}</Box>
    <Box sx={{ minWidth: 0 }}><Typography variant="body2" sx={{ fontWeight: 600 }}>{status.label}</Typography>
      <Typography variant="caption" color="text.disabled">{status.detail}{rate !== null && ` · ≈ ${rate} tok/s`}</Typography></Box>
    {onOpenActivity && <Button size="small" variant="text" onClick={onOpenActivity} sx={{ ml: "auto !important" }}>
      {localize(locale, "Xem Activity", "View Activity")}</Button>}
  </Stack>;
}

// Where each conversation was left, for this page's lifetime: a position, or
// "end" when it was read to the bottom. A conversation opened for the first
// time starts at its newest message.
const scrollPlaces = new Map<string, number | "end">();
const END_SLACK = 96;
const pageBottom = () => document.documentElement.scrollHeight - window.innerHeight;
const atEnd = () => pageBottom() - window.scrollY <= END_SLACK;

// Restores the place once the history is on screen, then keeps the newest
// message in view while the reader stays at the end (a streaming answer, a
// late-loading message body) and remembers the place as the reader scrolls.
//
// Older messages are added above what the reader is looking at. `hold` pins
// the turn at the top of the screen before they arrive; after they render,
// and while their markdown settles, the page is moved by exactly the height
// added above it, so the text being read never moves.
const HOLD_MS = 1500, HEADER_SLACK = 110;
function useConversationScroll(sessionRef: string, ready: boolean) {
  const content = useRef<HTMLDivElement>(null), restored = useRef(false), following = useRef(true);
  const anchor = useRef<{ key: string; top: number; until: number } | null>(null), scrolledUp = useRef(false);
  // While a turn is pinned the browser's own scroll anchoring stands down, so
  // the two never correct the same insertion twice; it is back on otherwise.
  const release = () => { anchor.current = null; if (content.current) content.current.style.overflowAnchor = ""; };
  const reapply = () => {
    const held = anchor.current; if (!held) return;
    if (Date.now() > held.until) { release(); return; }
    const node = content.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(held.key)}"]`);
    if (!node) return;
    const delta = node.getBoundingClientRect().top - held.top;
    if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
  };
  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const place = scrollPlaces.get(sessionRef) ?? "end";
    following.current = place === "end";
    window.scrollTo(0, place === "end" ? pageBottom() : Math.min(place, pageBottom()));
  }, [ready, sessionRef]);
  useEffect(() => {
    let lastY = window.scrollY;
    const remember = () => {
      if (!restored.current) return;
      if (window.scrollY < lastY - 2) scrolledUp.current = true;
      lastY = window.scrollY;
      // The reader moved the page: the pinned turn stays where they put it.
      const held = anchor.current;
      if (held) { const node = content.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(held.key)}"]`); if (node) held.top = node.getBoundingClientRect().top; }
      following.current = atEnd();
      scrollPlaces.set(sessionRef, following.current ? "end" : window.scrollY);
    };
    window.addEventListener("scroll", remember, { passive: true });
    const node = content.current, observer = typeof ResizeObserver === "undefined" || !node ? null
      : new ResizeObserver(() => {
        if (!restored.current) return;
        if (anchor.current) reapply();
        else if (following.current) window.scrollTo(0, pageBottom());
      });
    if (node) observer?.observe(node);
    return () => { window.removeEventListener("scroll", remember); observer?.disconnect(); };
  }, [sessionRef]);
  // `hold` again while a turn is already pinned only extends the pin, so the
  // skeleton shown while loading and the page that replaces it count as one move.
  const hold = () => {
    window.setTimeout(reapply, HOLD_MS + 50);
    if (anchor.current) { anchor.current.until = Date.now() + HOLD_MS; return; }
    const turns = [...(content.current?.querySelectorAll<HTMLElement>("[data-turn]") ?? [])];
    const first = turns.find((turn) => turn.getBoundingClientRect().bottom > HEADER_SLACK) ?? turns[0];
    if (!first?.dataset.turn || !content.current) return;
    content.current.style.overflowAnchor = "none";
    anchor.current = { key: first.dataset.turn, top: first.getBoundingClientRect().top, until: Date.now() + HOLD_MS };
  };
  // Back to the newest message: follow the end again and drop any pin.
  const follow = () => { release(); following.current = true; };
  return { content, hold, reapply, scrolledUp, follow };
}

// Placeholder turns while history loads: the shape of a conversation, so the
// page does not jump from a spinner to a wall of text.
function TranscriptSkeleton({ turns = 2, label }: { turns?: number; label: string }) {
  return <Stack spacing={3} role="status" aria-label={label} sx={{ py: 1 }}>
    {Array.from({ length: turns }, (_, index) => <Stack key={index} spacing={1.5}>
      <Skeleton variant="rounded" animation="wave" sx={{ alignSelf: "flex-end", width: "46%", height: 44, borderRadius: 2 }} />
      <Stack direction="row" spacing={1.5}><Skeleton variant="rounded" width={26} height={26} />
        <Stack spacing={1} sx={{ flex: 1 }}><Skeleton width="30%" /><Skeleton width="92%" /><Skeleton width="78%" /></Stack></Stack>
    </Stack>)}
  </Stack>;
}

// `onContinue` (given while the conversation is idle and can take a message)
// sends "tiếp tục" for the last turn when it failed or has no answer.
// `reload` (a counter) reads the history again in place: what is shown stays
// until the new page arrives, so the page never collapses and scrolls.
export function SessionTranscript({ sessionRef, sessionRevision, live, approvals, locale, onOpenActivity, onContinue, reload = 0 }: { sessionRef: string; sessionRevision: string;
  live?: LiveConversation; approvals?: ApprovalSummary; locale: UiLocale; onOpenActivity?: () => void; onContinue?: () => void; reload?: number }) {
  const [transcript, setTranscript] = useState<PiagentWebUIBoundedTranscriptProjectionV1>();
  const [loading, setLoading] = useState(true), [loadingOlder, setLoadingOlder] = useState(false);
  const [latestLoad, setLatestLoad] = useState(0), [trimmedNewest, setTrimmedNewest] = useState(false);
  const [error, setError] = useState(false), [olderError, setOlderError] = useState(false), [syncedOperation, setSyncedOperation] = useState<string | null>(null);
  useEffect(() => { void preloadMarkdown(); }, []);
  const refreshIdentity = durableTranscriptRefreshIdentity(sessionRef, sessionRevision, live);
  const { completionKey, user: completedUser, assistant: completedAssistant,
    operationRef: completedOperationRef, messageRequestId: completedMessageRequestId, startedAt: completedStartedAt } = refreshIdentity;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(false); setSyncedOperation(null);
    const timer = window.setTimeout(() => {
      // The page and the markdown renderer load together, so history appears
      // once, formatted, instead of raw text that reflows a moment later.
      void Promise.all([readSessionTranscript(sessionRef, null, 50, controller.signal), preloadMarkdown().catch(() => undefined)]).then(([value]) => {
        setTranscript(value); setTrimmedNewest(false);
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
  }, [refreshIdentity.key, reload, latestLoad]);
  const items = transcript?.state === "ready" ? transcript.items : [];
  const turns = useMemo(() => timelineTurns(items), [items]);
  const durableFinalVisible = useMemo(() => Boolean(live?.user && persistedLiveConversationHasFinal(items, live.user,
    { operationRef: live.operationRef, messageRequestId: live.messageRequestId,
      startedAt: live.startedAt })), [items, live?.user, live?.operationRef, live?.messageRequestId, live?.startedAt]);
  const liveVisible = Boolean(live && !durableFinalVisible && (!live.complete || syncedOperation !== completionKey));
  const liveUserDuplicated = useMemo(() => Boolean(live?.user && persistedLiveUserExists(items, live.user,
    { operationRef: live.operationRef, messageRequestId: live.messageRequestId,
      startedAt: live.startedAt })), [items, live?.user, live?.operationRef, live?.messageRequestId, live?.startedAt]);
  const { content, hold, reapply, scrolledUp, follow } = useConversationScroll(sessionRef, Boolean(transcript) || error);
  const loadingOlderRef = useRef(false), transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const loadOlder = async () => {
    // The latest transcript, not this render's: the next page may be asked for
    // before the previous one has rendered.
    const latest = transcriptRef.current, before = latest?.page.nextBeforeCursor;
    if (!latest || !before || loadingOlderRef.current) return;
    loadingOlderRef.current = true; hold(); setLoadingOlder(true); setOlderError(false);
    try {
      const older = await readSessionTranscript(sessionRef, before, latest.page.limit);
      hold();
      // Loads run one at a time, so the transcript read here is the current one.
      const current = transcriptRef.current;
      if (!current) { transcriptRef.current = older; setTranscript(older); return; }
      const merged = mergeOlderTranscriptPage(current.items, older.items);
      if (new Set([...current.items, ...older.items].map((item) => item.messageRef)).size > merged.length) setTrimmedNewest(true);
      const next = { ...current, items: merged, page: older.page };
      transcriptRef.current = next; setTranscript(next);
    } catch { setOlderError(true); } finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  };
  // After the older page renders, before paint: move by what was added above.
  useLayoutEffect(() => { reapply(); }, [items.length, loadingOlder]);
  // Older messages load on their own as the reader nears the top, once they
  // have scrolled up themselves; the button stays for keyboards and failures.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current; if (!node || !transcript?.page.hasOlder || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && scrolledUp.current && !olderError) void loadOlder();
    }, { rootMargin: "900px 0px 0px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  });
  const liveAnswer = live ? successfulAssistantText(live.assistant || "") : null;
  return <CheckpointTimeline sessionRef={sessionRef} refresh={`${refreshIdentity.key}:${reload}`} running={!!live && !live.complete && !live.error} locale={locale}>
    <Stack ref={content} spacing={3}>
    {transcript?.page.hasOlder && <Box ref={sentinel}>{loadingOlder
      ? <TranscriptSkeleton label={localize(locale, "Đang tải tin cũ hơn", "Loading older messages")} />
      : <Box sx={{ textAlign: "center" }}><Button size="small" variant="text" color="inherit" startIcon={<HistoryRounded />} onClick={() => void loadOlder()}
        sx={{ color: olderError ? "warning.main" : "text.secondary" }}>
        {olderError ? localize(locale, "Chưa tải được tin cũ · thử lại", "Older messages did not load · retry") : localize(locale, "Tải tin cũ hơn", "Load older messages")}</Button></Box>}</Box>}
    {transcript?.state === "ready" && !transcript.page.hasOlder && turns.length > 3 && <Typography variant="caption" color="text.disabled"
      sx={{ textAlign: "center", display: "block" }}>{localize(locale, "Đầu cuộc trò chuyện", "Start of the conversation")}</Typography>}
    {loading && !transcript && <TranscriptSkeleton turns={3} label={localize(locale, "Đang tải cuộc trò chuyện", "Loading the conversation")} />}
    {error && !transcript && <Alert severity="warning" icon={<ErrorOutlineRounded />}>
      {localize(locale, "Chưa tải được lịch sử cuộc trò chuyện. Thử lại bằng nút làm mới.", "Session history could not be loaded. You can retry with Refresh.")}
    </Alert>}
    {turns.map((turn, index) => <Box key={turn.key} data-turn={turn.key}><TimelineTurnView turn={turn} locale={locale}
      onContinue={index === turns.length - 1 && !liveVisible && !(approvals?.pending.length) ? onContinue : undefined} /></Box>)}
    {trimmedNewest && <Box sx={{ textAlign: "center" }}><Button size="small" variant="outlined" onClick={() => { follow(); setLatestLoad((value) => value + 1); }}>
      {localize(locale, "Tin mới hơn đã ẩn · về tin mới nhất", "Newer messages are hidden · back to the newest")}</Button></Box>}
    {liveVisible && live && <LiveTurnView user={live.user && !liveUserDuplicated ? live.user : null} attachments={live.attachments}
      activities={live.activities} assistant={live.error ? null : liveAnswer} running={!live.complete && !live.error}
      failure={live.complete && live.error && LIVE_FAILURES.has(live.error) ? live.error : null} locale={locale}
      status={<RunningStatus live={live} locale={locale} onOpenActivity={onOpenActivity} />} />}
    {/* Last, right above the composer: opening a conversation that waits on
        the member lands on its question, however long the running turn. */}
    <DecisionQueue sessionRef={sessionRef} waiting={waitingQuestion(live)} approvalRefs={approvals?.pending.map((item) => item.approvalRef) ?? []} />
  </Stack></CheckpointTimeline>;
}

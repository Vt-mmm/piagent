import { useEffect, useRef, useState } from "react";

import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import { attentionEvents, attentionState, sessionNeed, type AttentionEvent, type AttentionState } from "./attention-view-model.ts";
import type { LiveConversation } from "./live-state-view-model.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// Several conversations at once: what ended and what waits for the member,
// announced at the top right. A finished turn fades after a while; a question
// or an approval stays until it is answered, opened or closed. Nothing is
// announced for the conversation on screen while the page is in front.
const DONE_MS = 9_000, MAX_SHOWN = 4;

const TEXT: Record<AttentionEvent["kind"], [string, string, string, string]> = {
  done: ["Xong", "Done", "Agent đã trả lời xong.", "The agent finished its answer."],
  failed: ["Lượt bị lỗi", "Turn failed", "Mở để xem lỗi và gửi “tiếp tục”.", "Open it to see the error and continue."],
  stopped: ["Đã dừng", "Stopped", "Lượt làm việc đã dừng giữa chừng.", "The turn stopped midway."],
  question: ["Cần bạn trả lời", "Needs your answer", "Main agent đang chờ bạn chọn phương án.", "The main agent is waiting for your choice."],
  approval: ["Cần bạn duyệt", "Needs your approval", "Main agent xin chạy một lệnh và đang chờ bạn duyệt.", "The main agent asked to run a command and is waiting."]
};
const TONE: Record<AttentionEvent["kind"], string> = { done: "success", failed: "error", stopped: "neutral", question: "warning", approval: "warning" };

export function useAttention({ sessions, live, selectedRef, onOpen, locale }: { sessions: readonly SessionRow[]; live: Readonly<Record<string, LiveConversation | undefined>>;
  selectedRef?: string; onOpen(sessionRef: string): void; locale: UiLocale }) {
  const before = useRef<AttentionState | null>(null);
  const [toasts, setToasts] = useState<AttentionEvent[]>([]);
  // Conversations whose turn ended while the member looked elsewhere: marked
  // in the sidebar until opened.
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const after = attentionState(sessions, live);
    if (before.current) {
      const front = document.visibilityState === "visible";
      const events = attentionEvents(before.current, after, sessions, live).filter((event) => !(front && event.sessionRef === selectedRef));
      if (events.length) {
        setToasts((current) => [...events, ...current.filter((item) => !events.some((event) => event.sessionRef === item.sessionRef))].slice(0, 12));
        const ended = events.filter((event) => ["done", "failed", "stopped"].includes(event.kind)).map((event) => event.sessionRef);
        if (ended.length) setUnseen((current) => new Set([...current, ...ended]));
      }
    }
    before.current = after;
    // A decision answered elsewhere (another tab, the Terminal) no longer needs its toast.
    setToasts((current) => {
      const kept = current.filter((item) => !["question", "approval"].includes(item.kind) || after[item.sessionRef]?.need === item.kind);
      return kept.length === current.length ? current : kept;
    });
  }, [sessions, live, selectedRef]);
  // Opening a conversation is seeing it.
  useEffect(() => {
    if (!selectedRef) return;
    setUnseen((current) => { if (!current.has(selectedRef)) return current; const next = new Set(current); next.delete(selectedRef); return next; });
    setToasts((current) => current.filter((item) => item.sessionRef !== selectedRef));
  }, [selectedRef]);
  // The tab's title counts what waits for the member, so a background tab shows it.
  const waiting = sessions.filter((session) => !session.archived && sessionNeed(session, live[session.sessionRef])).length;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = waiting ? `(${waiting}) ${base}` : base;
  }, [waiting]);
  const close = (id: string) => setToasts((current) => current.filter((item) => item.id !== id));
  const view = <AttentionToasts toasts={toasts.slice(0, MAX_SHOWN)} more={Math.max(0, toasts.length - MAX_SHOWN)} locale={locale} onClose={close}
    onOpen={(event) => { close(event.id); onOpen(event.sessionRef); }} />;
  return { unseen, view };
}

function AttentionToasts({ toasts, more, locale, onClose, onOpen }: { toasts: AttentionEvent[]; more: number; locale: UiLocale;
  onClose(id: string): void; onOpen(event: AttentionEvent): void }) {
  return <section className="attention-toasts" aria-label={localize(locale, "Thông báo cuộc trò chuyện", "Chat notifications")} aria-live="polite">
    {toasts.map((event) => <Toast key={event.id} event={event} locale={locale} onClose={() => onClose(event.id)} onOpen={() => onOpen(event)} />)}
    {more > 0 && <p className="attention-more">{localize(locale, `và ${more} thông báo khác`, `and ${more} more`)}</p>}
  </section>;
}

function Toast({ event, locale, onClose, onOpen }: { event: AttentionEvent; locale: UiLocale; onClose(): void; onOpen(): void }) {
  const sticky = event.kind === "question" || event.kind === "approval", [title, titleEn, body, bodyEn] = TEXT[event.kind];
  useEffect(() => { if (sticky) return; const timer = window.setTimeout(onClose, DONE_MS); return () => window.clearTimeout(timer); }, [sticky]);
  return <article className={`attention-toast tone-${TONE[event.kind]}`} role={sticky ? "alert" : "status"}>
    <span className="attention-toast-mark" aria-hidden="true" />
    <div className="attention-toast-body">
      <strong>{localize(locale, title, titleEn)} · <span className="attention-toast-title">{event.title}</span></strong>
      <small>{localize(locale, body, bodyEn)}</small>
    </div>
    <div className="attention-toast-actions">
      <button type="button" className="attention-open" onClick={onOpen}>{localize(locale, "Mở", "Open")}</button>
      <button type="button" className="attention-close" aria-label={localize(locale, "Đóng thông báo", "Close notification")} onClick={onClose}>×</button>
    </div>
  </article>;
}

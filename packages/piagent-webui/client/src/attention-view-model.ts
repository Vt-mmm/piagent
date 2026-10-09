import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { LiveConversation } from "./live-state-view-model.ts";

// What waits for the member, across conversations and inside one.

// One thing the member must decide in a conversation: a question or an
// approval, who asked it, and when.
export type Decision = { key: string; kind: "question" | "approval"; role: string; askedAt: string; expiresAt?: string | null };

// The main agent first: its decision shapes the work its subagents do, and
// the turn waits on it. Then the subagents in the order the work flows
// (scout, research, verify, review), any other role last. Within one agent,
// what was asked first comes first, the order the agent needs the answers in
// (questions asked in the same moment keep the order the agent gave them).
const ROLE_RANK: Record<string, number> = { main: 0, scout: 1, research: 2, verify: 3, review: 4 };
const rank = (role: string) => ROLE_RANK[role] ?? 5;
export function orderDecisions<T extends Decision>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => rank(left.role) - rank(right.role)
    || Date.parse(left.askedAt) - Date.parse(right.askedAt));
}

// The main agent is waiting for the member's answer to its questions.
export function waitingQuestion(live?: LiveConversation): boolean {
  return Boolean(live && !live.complete && live.activities.some((item) => item.toolLabel === "ask_user" && item.state === "running"));
}

// What a conversation needs from the member now: an answer to a question, an
// approval, or nothing. The Gateway marks a conversation whose agent waits on
// a question as needing attention while it runs (a page opened later has no
// live step to go by); a conversation that needs recovery is not a decision.
export function sessionNeed(session: SessionRow, live?: LiveConversation): "question" | "approval" | null {
  if (waitingQuestion(live)) return "question";
  if (session.liveState === "waiting-approval") return "approval";
  return session.needsAttention && (session.liveState === "running" || session.liveState === "idle") ? "question" : null;
}

export type AttentionEvent = { id: string; sessionRef: string; title: string;
  kind: "done" | "failed" | "stopped" | "question" | "approval" };

// What each conversation looked like at the last look.
export type AttentionState = Record<string, { running: boolean; need: "question" | "approval" | null; operationRef: string | null }>;

export function attentionState(sessions: readonly SessionRow[], live: Readonly<Record<string, LiveConversation | undefined>>): AttentionState {
  const out: AttentionState = {};
  for (const session of sessions) {
    if (session.archived) continue;
    const conversation = live[session.sessionRef];
    out[session.sessionRef] = { running: Boolean(conversation && !conversation.complete), need: sessionNeed(session, conversation),
      operationRef: conversation?.operationRef ?? null };
  }
  return out;
}

// What changed since the last look: a turn that ended (finished, failed or
// stopped) and a decision that began waiting. A conversation seen for the
// first time announces nothing (the page just opened).
export function attentionEvents(before: AttentionState, after: AttentionState, sessions: readonly SessionRow[],
  live: Readonly<Record<string, LiveConversation | undefined>>): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  for (const session of sessions) {
    const was = before[session.sessionRef], now = after[session.sessionRef];
    if (!was || !now) continue;
    const conversation = live[session.sessionRef], operation = now.operationRef ?? was.operationRef ?? "turn";
    if (now.need && now.need !== was.need) events.push({ id: `${session.sessionRef}:${operation}:${now.need}:${Date.now()}`, sessionRef: session.sessionRef, title: session.title, kind: now.need });
    if (was.running && !now.running) {
      const kind = conversation?.settlement === "aborted" ? "stopped" : conversation?.error || conversation?.settlement === "error" || conversation?.settlement === "blocked" ? "failed" : "done";
      events.push({ id: `${session.sessionRef}:${operation}:${kind}`, sessionRef: session.sessionRef, title: session.title, kind });
    }
  }
  return events;
}

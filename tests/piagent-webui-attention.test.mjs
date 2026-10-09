import assert from "node:assert/strict";
import { test } from "node:test";

import { attentionEvents, attentionState, orderDecisions, sessionNeed, waitingQuestion } from "../packages/piagent-webui/client/src/attention-view-model.ts";

const session = (sessionRef, extra = {}) => ({ sessionRef, title: `Chat ${sessionRef}`, archived: false, state: "gateway-owned", liveState: "idle", needsAttention: false, ...extra });
const live = (extra = {}) => ({ user: "u", assistant: "", attachments: [], activities: [], operationRef: "op-1", complete: false, error: null, ...extra });
const asking = live({ activities: [{ toolCallRef: "t", toolLabel: "ask_user", state: "running" }] });

test("decisions: the main agent's first, then subagents in work order, oldest first within one", () => {
  const at = (minute) => `2026-10-09T10:${String(minute).padStart(2, "0")}:00Z`;
  const ordered = orderDecisions([
    { key: "review-q", kind: "question", role: "review", askedAt: at(1) },
    { key: "main-approval", kind: "approval", role: "main", askedAt: at(5) },
    { key: "scout-q", kind: "question", role: "scout", askedAt: at(2) },
    { key: "main-q", kind: "question", role: "main", askedAt: at(3) },
    { key: "other", kind: "question", role: "custom", askedAt: at(0) }
  ]);
  assert.deepEqual(ordered.map((item) => item.key), ["main-q", "main-approval", "scout-q", "review-q", "other"]);
});

test("a conversation needs the member while its question step runs or an approval waits", () => {
  assert.equal(waitingQuestion(asking), true);
  assert.equal(waitingQuestion({ ...asking, complete: true }), false);
  assert.equal(sessionNeed(session("a"), asking), "question");
  assert.equal(sessionNeed(session("a", { liveState: "waiting-approval", needsAttention: true }), live()), "approval");
  // Recovery also sets needsAttention: that is not a decision for the member.
  assert.equal(sessionNeed(session("a", { state: "recovery-required", needsAttention: true, liveState: "uncertain" }), undefined), null);
  assert.equal(sessionNeed(session("a"), live()), null);
  // The Gateway's mark: a running conversation needing attention waits on a question.
  assert.equal(sessionNeed(session("a", { liveState: "running", needsAttention: true }), undefined), "question");
});

test("events: a turn that ends, a decision that starts waiting; nothing for the first look", () => {
  const sessions = [session("a"), session("b"), session("c"), session("d")];
  const first = { a: live(), b: live(), c: live(), d: live() };
  const before = attentionState(sessions, first);
  assert.deepEqual(attentionEvents({}, before, sessions, first), []);
  const next = { a: live({ complete: true, settlement: "completed" }), b: asking, c: live({ complete: true, error: "upstream_unavailable" }), d: live({ complete: true, settlement: "aborted" }) };
  const events = attentionEvents(before, attentionState(sessions, next), sessions, next);
  assert.deepEqual(events.map((event) => [event.sessionRef, event.kind]), [["a", "done"], ["b", "question"], ["c", "failed"], ["d", "stopped"]]);
  assert.equal(events[0].title, "Chat a");
  // The same state again announces nothing.
  const after = attentionState(sessions, next);
  assert.deepEqual(attentionEvents(after, after, sessions, next), []);
  // An archived conversation is never announced.
  assert.equal(attentionState([session("e", { archived: true })], { e: asking }).e, undefined);
});

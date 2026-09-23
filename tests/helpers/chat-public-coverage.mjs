import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import assert from "node:assert/strict";
import { data } from "./async-contract-cases.mjs";

// Public examples from production-journey-chat-transport, grouped by the
// original request clauses. No private grader or registered recipe is loaded.
const message = (overrides = {}) => ({ eventId: "event-1", sequence: 1,
  kind: "message", messageId: "message-1", role: "user", text: "hello", confirmed: false, ...overrides });
const projected = (overrides = {}) => ({ messageId: "message-1", role: "user",
  text: "hello", sequence: 1, confirmed: false, ...overrides });
const output = (messages, processing = false) => ({ messages, processing });
const passed = (id, input, expected) => ({ id, args: [data(input)], invocation: { kind: "call" }, observeArgs: true,
  expected: { outcome: "return", value: data(expected), argsAfter: [data(input)] } });
const rejected = (id, input, conflict = false) => ({ id, args: [data(input)], invocation: { kind: "call" }, observeArgs: true,
  ...(conflict ? { observeErrorMessage: true } : {}), expected: { outcome: "throw", errorClass: conflict ? "Error" : "TypeError",
    argsAfter: [data(input)], ...(conflict ? { errorMessage: { includes: "conflict", ignoreCase: true } } : {}) } });

export function chatCoveredContracts(criteria) {
  assert.equal(criteria.length, 4);
  const anchors = [
    ["while preserving `projectChatEvents(events)`", "Every event has", "Lifecycle events use", "Message events have",
      "Malformed events", "Events may arrive", "Deduplicate identical", "For duplicate `messageId`"],
    ["identical confirmed copies", "Return confirmed and still-pending", "`processing` reflects", "Project message objects"],
    ["Return `{ messages, processing }`.", "Do not mutate input.", "Run the configured verification."]
  ];
  for (const [index, expected] of anchors.entries()) {
    const clauses = criteria[index].criterionText.split("\n"); assert.equal(clauses.length, expected.length);
    expected.forEach((anchor, clause) => assert.ok(clauses[clause].includes(anchor), clauses[clause]));
  }
  const first = message(), pending = message({ eventId: "pending", sequence: 8, text: "pending" }),
    confirmed = message({ eventId: "confirmed", sequence: 2, text: "confirmed", confirmed: true });
  const inputCases = [
    ...[undefined, null, {}, "events"].map((value, i) => rejected(`invalid-events-${i}`, value)),
    ...[null, undefined, 1, "event", {}, message({ eventId: "" }), message({ eventId: 1 }),
      message({ sequence: -1 }), message({ sequence: 0.5 }), message({ sequence: NaN }), message({ sequence: Infinity }),
      message({ sequence: "1" }), message({ kind: "other" }), message({ messageId: "" }), message({ messageId: null }),
      message({ role: "system" }), message({ text: 1 }), message({ confirmed: 1 }), message({ replyTo: "" }),
      message({ replyTo: null }), { eventId: "life", sequence: 0, kind: "lifecycle", state: "other" }]
      .map((value, i) => rejected(`invalid-event-${i}`, [value])),
    rejected("invalid-later-event", [first, message({ eventId: "bad", sequence: -1 })]),
    passed("valid-zero-empty-text", [message({ sequence: 0, text: "" })], output([projected({ sequence: 0, text: "" })])),
    passed("duplicate-event", [first, { ...first }], output([projected()])),
    ...[[pending, confirmed], [confirmed, pending]].map((events, i) => passed(`confirmed-preferred-${i}`, events,
      output([projected({ sequence: 2, text: "confirmed", confirmed: true })])))
  ];
  const conflicting = message({ eventId: "confirmed-one", confirmed: true });
  const behaviorCases = [
    passed("confirmed-idempotent", [message({ eventId: "one", confirmed: true }), message({ eventId: "two", confirmed: true })],
      output([projected({ confirmed: true })])),
    ...[{ text: "different" }, { role: "assistant" }, { replyTo: "other-message" }].flatMap((changes, i) => {
      const second = message({ eventId: "confirmed-two", confirmed: true, ...changes });
      return [rejected(`conflict-forward-${i}`, [conflicting, second], true), rejected(`conflict-reverse-${i}`, [second, conflicting], true)];
    }),
    passed("sequence-order", [message({ eventId: "later", messageId: "later", sequence: 9 }),
      message({ eventId: "early", messageId: "early", sequence: 2, confirmed: true })],
      output([projected({ messageId: "early", sequence: 2, confirmed: true }), projected({ messageId: "later", sequence: 9 })])),
    passed("user-before-reply", [message({ eventId: "reply-event", messageId: "reply", sequence: 4, role: "assistant",
      text: "answer", confirmed: true, replyTo: "question" }), message({ eventId: "question-event", messageId: "question",
      sequence: 4, text: "question", confirmed: true })], output([projected({ messageId: "question", sequence: 4,
      text: "question", confirmed: true }), projected({ messageId: "reply", sequence: 4, role: "assistant",
      text: "answer", confirmed: true, replyTo: "question" })]))
  ];
  const start = { eventId: "start", sequence: 1, kind: "lifecycle", state: "started" },
    settled = { eventId: "settled", sequence: 4, kind: "lifecycle", state: "settled" },
    newerStart = { eventId: "new-start", sequence: 5, kind: "lifecycle", state: "started" };
  behaviorCases.push(passed("empty-projection", [], output([])), passed("started", [start], output([], true)),
    passed("old-start-cannot-revive", [settled, start], output([])),
    passed("new-start", [newerStart, settled, start], output([], true)),
    passed("projection-fields", [message({ eventId: "later", sequence: 2, messageId: "later", extra: "not projected" }),
      message({ eventId: "early", sequence: 1, messageId: "early", confirmed: true })],
      output([projected({ messageId: "early", sequence: 1, confirmed: true }), projected({ messageId: "later", sequence: 2 })])));
  // The third parent owns no-mutation. It uses the same reviewed inputs with
  // full before/after argument snapshots on both success and rejection. Current
  // project-verifier evidence separately gates its final verification clause.
  return addPublicApiCoverage([inputCases, behaviorCases, [...inputCases, ...behaviorCases]].map((cases, index) => ({
    route: "code", criterionId: criteria[index].criterionId, criterionHash: criteria[index].criterionHash,
    sourcePath: "src/frontend/chat-events.js", exportName: "projectChatEvents", maxAttempts: 1,
    checks: [{ id: `chat-public-criterion-${index + 1}`, cases }]
  })));
}

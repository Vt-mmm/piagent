import { callReturns, callThrows, recipe } from "./benchmark-registered-plan-recipe-support.mjs";

function argsRecipe() {
  return recipe("src/platform/args.js", "parseArgs", [
    callReturns("empty", [[]], { flags: {}, positional: [] }, { fresh: true }),
    callReturns("name-space-value", [["--name", "value"]], { flags: { name: "value" }, positional: [] }, { fresh: true }),
    callReturns("name-equals-value", [["--name=value"]], { flags: { name: "value" }, positional: [] }, { fresh: true }),
    callReturns("empty-equals-value", [["--name="]], { flags: { name: "" }, positional: [] }, { fresh: true }),
    callReturns("boolean-at-end", [["--verbose"]], { flags: { verbose: true }, positional: [] }, { fresh: true }),
    callReturns("flag-before-flag", [["--verbose", "--color"]],
      { flags: { verbose: true, color: true }, positional: [] }, { fresh: true }),
    callReturns("double-dash-terminates", [["--name", "value", "--", "--literal", "tail"]],
      { flags: { name: "value" }, positional: ["--literal", "tail"] }, { fresh: true }),
    callReturns("first-double-dash", [["--", "--name=value", "-x"]],
      { flags: {}, positional: ["--name=value", "-x"] }, { fresh: true }),
    callReturns("single-dash-positional", [["-x", "plain"]], { flags: {}, positional: ["-x", "plain"] }, { fresh: true }),
    callReturns("repeated-last-wins", [["--name", "first", "--name=second", "--name", "third"]],
      { flags: { name: "third" }, positional: [] }, { fresh: true })
  ]);
}

function workspaceRecipe() {
  const pkg = (name, dependencies, extra = {}) => ({ name, ...(dependencies === undefined ? {} : { dependencies }), ...extra });
  return recipe("src/platform/workspace.js", "workspaceOrder", [
    callReturns("empty", [[]], [], { fresh: true }),
    callReturns("no-edge-input-order", [[pkg("B", []), pkg("A", null), pkg("C", undefined)]],
      ["B", "A", "C"], { fresh: true }),
    callReturns("ready-recomputed-a-to-c", [[pkg("A", ["C"]), pkg("B", []), pkg("C", [])]],
      ["B", "C", "A"], { fresh: true }),
    callReturns("ready-recomputed-a-to-b", [[pkg("A", ["B"]), pkg("B", []), pkg("C", [])]],
      ["B", "A", "C"], { fresh: true }),
    callReturns("multiple-dependencies", [[pkg("A", ["C", "B"]), pkg("B", []), pkg("C", [])]],
      ["B", "C", "A"], { fresh: true }),
    callReturns("duplicate-and-foreign-dependency", [[pkg("A", ["B", "B", "missing"]), pkg("B", [])]],
      ["B", "A"], { fresh: true }),
    callReturns("literal-names", [[pkg(" A ", ["B"]), pkg("B", []), pkg("b", [])]],
      ["B", " A ", "b"], { fresh: true }),
    callReturns("metadata-ignored", [[pkg("A", [], { private: { ignored: true } })]], ["A"], { fresh: true }),
    callThrows("duplicate-package-name", [[pkg("A", []), pkg("A", [])]]),
    callThrows("empty-name", [[pkg("", [])]]),
    callThrows("whitespace-name", [[pkg("   ", [])]]),
    callThrows("dependencies-not-array", [[pkg("A", "B")]]),
    callThrows("invalid-dependency-name", [[pkg("A", [" "])]]),
    callThrows("malformed-outranks-cycle", [[pkg("A", ["A"]), pkg("", [])]]),
    callThrows("self-cycle", [[pkg("A", ["A"])]], "Error"),
    callThrows("two-node-cycle", [[pkg("A", ["B"]), pkg("B", ["A"])]], "Error")
  ]);
}

function contractResult({ compatible, missingStatuses = [], extraStatuses = [], missingFields = [], versionMismatch = false }) {
  return { compatible, missingStatuses, extraStatuses, missingFields, versionMismatch };
}

function contractRecipe() {
  const contract = (statuses, fields, version, extra = {}) => ({ statuses, fields, version, ...extra });
  return recipe("src/fullstack/contract-sync.js", "compareSubscriptionContracts", [
    callReturns("compatible-reordered-extra-fields", [
      contract(["active", "trial"], ["id", "plan"], 1),
      contract(["trial", "active"], ["plan", "id", "debug"], 1, { metadata: "ignored" })
    ], contractResult({ compatible: true }), { fresh: true }),
    callReturns("all-mismatches", [
      contract(["active", "trial"], ["id", "plan"], 1),
      contract(["paused", "active"], ["id"], 2)
    ], contractResult({ compatible: false, missingStatuses: ["trial"], extraStatuses: ["paused"],
      missingFields: ["plan"], versionMismatch: true }), { fresh: true }),
    callReturns("empty-compatible", [contract([], [], 1), contract([], [], 1)],
      contractResult({ compatible: true }), { fresh: true }),
    callReturns("utf8-byte-order", [contract(["😀", "é", "z", "\uE000"], [], 1), contract([], [], 1)],
      contractResult({ compatible: false, missingStatuses: ["z", "é", "\uE000", "😀"] }), { fresh: true }),
    callReturns("literal-unicode-distinct", [contract(["é", "e\u0301"], [], 1), contract(["é"], [], 1)],
      contractResult({ compatible: false, missingStatuses: ["e\u0301"] }), { fresh: true }),
    callReturns("special-and-whitespace-declarations", [contract([" ", "__proto__", "constructor"], [], 1),
      contract(["constructor", "__proto__", " "], [], 1)], contractResult({ compatible: true }), { fresh: true }),
    callReturns("large-integer-version", [contract([], [], 1e20), contract([], [], 1e20)],
      contractResult({ compatible: true }), { fresh: true }),
    callThrows("duplicate-status", [contract(["a", "a"], [], 1), contract([], [], 1)]),
    callThrows("missing-fields-property", [{ statuses: [], version: 1 }, contract([], [], 1)]),
    callThrows("zero-version", [contract([], [], 0), contract([], [], 1)]),
    callThrows("fractional-version", [contract([], [], 1.5), contract([], [], 1)]),
    callThrows("nonfinite-version", [contract([], [], Infinity), contract([], [], 1)]),
    callThrows("string-version", [contract([], [], "1"), contract([], [], 1)]),
    callThrows("empty-declaration", [contract([""], [], 1), contract([], [], 1)]),
    callThrows("lone-surrogate", [contract(["\uD800"], [], 1), contract([], [], 1)]),
    callThrows("frontend-malformed-even-if-incompatible", [contract(["backend"], [], 1),
      contract(["front", "front"], [], 2)])
  ]);
}

function message(overrides = {}) {
  return { eventId: "event-1", sequence: 1, kind: "message", messageId: "message-1",
    role: "user", text: "hello", confirmed: false, ...overrides };
}

function lifecycle(overrides = {}) {
  return { eventId: "lifecycle-1", sequence: 1, kind: "lifecycle", state: "started", ...overrides };
}

function projected(overrides = {}) {
  return { messageId: "message-1", role: "user", text: "hello", sequence: 1, confirmed: false, ...overrides };
}

function chatRecipe() {
  return recipe("src/frontend/chat-events.js", "projectChatEvents", [
    callReturns("empty", [[]], { messages: [], processing: false }, { fresh: true }),
    callReturns("latest-lifecycle-settled", [[lifecycle({ sequence: 9 }),
      lifecycle({ eventId: "settled", sequence: 10, state: "settled" }),
      lifecycle({ eventId: "old-start", sequence: 2 })]], { messages: [], processing: false }, { fresh: true }),
    callReturns("same-sequence-settled-wins", [[lifecycle({ eventId: "start", sequence: 10 }),
      lifecycle({ eventId: "settled", sequence: 10, state: "settled" })]],
      { messages: [], processing: false }, { fresh: true }),
    callReturns("messages-sorted-and-reply-retained", [[
      message({ eventId: "assistant-event", sequence: 4, messageId: "assistant", role: "assistant",
        text: "answer", confirmed: true, replyTo: "user" }),
      message({ eventId: "user-event", sequence: 4, messageId: "user", role: "user", text: "question", confirmed: true })
    ]], { messages: [
      projected({ messageId: "user", text: "question", sequence: 4, confirmed: true }),
      projected({ messageId: "assistant", role: "assistant", text: "answer", sequence: 4,
        confirmed: true, replyTo: "user" })
    ], processing: false }, { fresh: true }),
    callReturns("identical-event-id-collapses-metadata", [[
      message({ eventId: "same", metadata: "first" }), message({ eventId: "same", metadata: "second" })
    ]], { messages: [projected({})], processing: false }, { fresh: true }),
    callThrows("conflicting-event-id", [[message({ eventId: "same" }), message({ eventId: "same", text: "changed" })]]),
    callReturns("confirmed-beats-pending", [[
      message({ eventId: "pending", sequence: 9, text: "pending", confirmed: false }),
      message({ eventId: "confirmed", sequence: 2, text: "confirmed", confirmed: true })
    ]], { messages: [projected({ sequence: 2, text: "confirmed", confirmed: true })], processing: false }, { fresh: true }),
    callReturns("identical-confirmed-copies", [[
      message({ eventId: "confirmed-a", sequence: 2, confirmed: true }),
      message({ eventId: "confirmed-b", sequence: 2, confirmed: true })
    ]], { messages: [projected({ sequence: 2, confirmed: true })], processing: false }, { fresh: true }),
    callThrows("conflicting-confirmed-message", [[
      message({ eventId: "confirmed-a", confirmed: true }),
      message({ eventId: "confirmed-b", confirmed: true, text: "different" })
    ]], "Error"),
    callReturns("pending-greatest-sequence", [[
      message({ eventId: "early", sequence: 1, text: "early" }),
      message({ eventId: "late", sequence: 3, text: "late" })
    ]], { messages: [projected({ sequence: 3, text: "late" })], processing: false }, { fresh: true }),
    callReturns("pending-tie-smallest-event-id", [[
      message({ eventId: "z", sequence: 3, text: "z-winner-candidate" }),
      message({ eventId: "a", sequence: 3, text: "a-winner" })
    ]], { messages: [projected({ sequence: 3, text: "a-winner" })], processing: false }, { fresh: true }),
    callThrows("missing-reply-target", [[message({ eventId: "a", role: "assistant", replyTo: "missing" })]]),
    callThrows("user-with-reply", [[message({ replyTo: "message-1" })]]),
    callThrows("parent-after-assistant", [[
      message({ eventId: "user", messageId: "user", sequence: 5, confirmed: true }),
      message({ eventId: "assistant", messageId: "assistant", role: "assistant", sequence: 4,
        confirmed: true, replyTo: "user" })
    ]]),
    callThrows("malformed-later-event", [[message({}), { eventId: "bad", sequence: -1, kind: "lifecycle", state: "started" }]]),
    callThrows("explicit-undefined-reply", [[message({ replyTo: undefined })]])
  ]);
}

const RECIPES = Object.freeze({
  "cli-double-dash": argsRecipe,
  "workspace-order": workspaceRecipe,
  "backend-frontend-contract-sync": contractRecipe,
  "reconnect-chat-event-order": chatRecipe
});

export function registeredPlatformRecipe(scenarioId) {
  return RECIPES[scenarioId]?.() ?? null;
}

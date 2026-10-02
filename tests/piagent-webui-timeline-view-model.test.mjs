import assert from "node:assert/strict";
import { test } from "node:test";
import "../scripts/register-typescript-loader.mjs";
import { compactTokens, liveTokensPerSecond, timelineTurns, turnSeconds, turnTokensPerSecond } from "../packages/piagent-webui/client/src/timeline-view-model.ts";

// The coding-agent timeline groups a transcript page into turns: the user's
// message, the tools the agent used, its answer, and what the turn cost.
let serial = 0;
const at = (second) => `2026-09-30T10:00:${String(second).padStart(2, "0")}.000Z`;
function item(role, { text = null, tools = [], second = 0, reason = null, usage, model } = {}) {
  serial += 1;
  return { messageRef: `message.${serial}`, parentMessageRef: null, role, recordedAt: at(second), agentOperationId: null, turnIndex: null,
    content: text === null ? { state: "unavailable", text: null, textChars: null, digest: null, truncated: false, redacted: false, imageCount: 0,
      reasonCode: reason ?? "assistant-intermediate-output" }
      : { state: "available", text, textChars: text.length, digest: "sha256:x", truncated: false, redacted: false, imageCount: 0, reasonCode: null },
    toolCalls: tools.map((name, index) => ({ toolCallRef: `tool.${serial}.${index}`, toolName: name, state: "completed",
      summary: { kind: name === "bash" ? "command" : "read", target: `${name}-target`, detail: null } })),
    ...(usage ? { usage: { inputTokens: usage, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: usage } } : {}),
    ...(model ? { model } : {}) };
}

test("a turn holds its tool steps, its answer and what it cost", () => {
  const turns = timelineTurns([
    item("user", { text: "Fix the cart", second: 0 }),
    item("assistant", { tools: ["read", "bash"], second: 2, usage: 1200, model: "gpt-6-sol" }),
    item("tool-result", { tools: ["read"], second: 3, reason: "tool-output-in-activity-preview" }),
    item("assistant", { text: "Fixed; tests pass.", second: 9, usage: 1500 }),
    item("user", { text: "Thanks", second: 20 })
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].steps.map((step) => step.kind === "tool" ? step.tool.summary.kind : step.kind), ["read", "command"]);
  assert.equal(turns[0].answer, "Fixed; tests pass.");
  assert.deepEqual([turns[0].requests, turns[0].tokens, turns[0].model, turnSeconds(turns[0])], [2, 2700, "gpt-6-sol", 9]);
  assert.deepEqual([turns[1].steps.length, turns[1].answer, turns[1].requests], [0, null, 0]);
});

test("a page that starts inside a turn shows nothing before its user message", () => {
  const turns = timelineTurns([item("assistant", { tools: ["read"] }), item("assistant", { text: "orphan answer" }), item("user", { text: "Next" })]);
  assert.deepEqual(turns.map((turn) => turn.user.content.text), ["Next"]);
});

test("a failure shows until a retry answers; a later failure never hides an answer", () => {
  const retried = timelineTurns([item("user", { text: "Hi" }), item("assistant", { reason: "provider-unavailable" }), item("assistant", { text: "Hello" })]);
  assert.deepEqual([retried[0].failure, retried[0].answer], [null, "Hello"]);
  const failed = timelineTurns([item("user", { text: "Hi" }), item("assistant", { reason: "provider-unavailable" })]);
  assert.equal(failed[0].failure, "provider-unavailable");
  const answeredFirst = timelineTurns([item("user", { text: "Hi" }), item("assistant", { text: "Hello" }), item("assistant", { reason: "provider-unavailable" })]);
  assert.deepEqual([answeredFirst[0].failure, answeredFirst[0].answer], [null, "Hello"]);
});

test("a repeated identical answer appears once; an earlier different one and receipts become notes", () => {
  const turns = timelineTurns([item("user", { text: "Go" }), item("assistant", { text: "Done." }), item("assistant", { text: "Done." }),
    item("custom", { text: "Helper finished" }), item("assistant", { text: "Final." })]);
  assert.deepEqual(turns[0].steps.map((step) => step.text), ["Helper finished", "Done."]);
  assert.equal(turns[0].answer, "Final.");
});

test("a company failure keeps who failed and its code; one that never reached Studio is not a request", () => {
  const failed = (reason, failure) => ({ ...item("assistant", { reason }), failure });
  const studio = { role: "main", reasonCode: "company-provider-limit", code: "upstream_rate_limited", requestRef: "c17783c2-e134-4715-be3f-b03d9b57efe2", local: false };
  const local = { role: "main", reasonCode: "company-unreachable", code: "managed-broker:offline", requestRef: null, local: true };
  const turns = timelineTurns([item("user", { text: "One" }), failed("company-provider-limit", studio), item("user", { text: "Two" }), failed("company-unreachable", local),
    item("user", { text: "Three" }), failed("company-provider-limit", studio), item("assistant", { text: "Recovered" })]);
  assert.deepEqual(turns.map((turn) => [turn.failure, turn.failureDetail?.code ?? null, turn.requests]),
    [["company-provider-limit", "upstream_rate_limited", 1], ["company-unreachable", "managed-broker:offline", 0], [null, null, 2]]);
});

test("a turn's output speed counts each request from when it was sent until its answer was stored", () => {
  const out = (second, outputTokens, extra = {}) => ({ ...item("assistant", { second, ...extra }), usage: { inputTokens: 1000, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000 + outputTokens } });
  const turns = timelineTurns([
    item("user", { text: "Build it", second: 0 }),
    out(4, 200, { tools: ["bash"] }),                                   // 4 s for 200 tokens
    item("tool-result", { tools: ["bash"], second: 30, reason: "tool-output-in-activity-preview" }), // 26 s of tool time: not the model's
    out(36, 400, { text: "Done." }),                                    // 6 s for 400 tokens
    item("user", { text: "No usage yet", second: 40 }), item("assistant", { text: "Hi", second: 41 })
  ]);
  assert.deepEqual([turns[0].outputTokens, turns[0].generationMs, turnTokensPerSecond(turns[0])], [600, 10_000, 60]);
  assert.equal(turnTokensPerSecond(turns[1]), null, "no figure without usage");
  assert.equal(turnTokensPerSecond({ outputTokens: 60, generationMs: 20_000 }), 3);
  assert.equal(turnTokensPerSecond({ outputTokens: 12, generationMs: 4000 }), null, "a few tokens say nothing about speed");
  assert.equal(turnTokensPerSecond({ outputTokens: 500, generationMs: 100 }), null, "too short to mean anything");
  assert.deepEqual([liveTokensPerSecond(20, 5000), liveTokensPerSecond(2000, 500), liveTokensPerSecond(2000, 10_000)], [null, null, 50]);
});

test("token counts read compactly", () => {
  assert.deepEqual([compactTokens(950), compactTokens(9_800), compactTokens(19_400), compactTokens(1_250_000)], ["950", "9.8k", "19k", "1.3M"]);
});

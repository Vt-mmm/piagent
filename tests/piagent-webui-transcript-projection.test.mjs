import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectTranscript } from "../packages/piagent-webui/server/transcript-projection.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.transcript", runtimeInstanceId: "runtime.transcript", sessionRef: "session.transcript",
  taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
const revision = { runtimeRevision: "runtime_rev_01", taskRevision: null, controlRevision: null, workspaceRevision: null,
  indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: "queue_rev_01" };
const generatedAt = "2026-08-13T14:00:10.000Z";

function entry(id, role, content, overrides = {}) {
  return { id, type: "message", timestamp: `2026-08-13T14:00:0${id.slice(-1)}.000Z`, message: { role, content, ...overrides } };
}
function project(entries, options = {}) {
  return projectTranscript({ identity, revision, eventCursor: "cursor.transcript", entries, generatedAt, ...options });
}
function expectValid(value) {
  const validation = validateFixture(registry, "transcript-v1", value);
  assert.equal(validation.valid, true, validation.errors);
}

describe("Piagent WebUI bounded transcript projection", () => {
  it("projects user/assistant text, removes thinking and redacts secrets without exposing raw session IDs", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    const value = project([
      entry("entry_1", "user", [{ type: "text", text: `Use token ${secret}` }, { type: "image", data: "not-forwarded" }]),
      entry("entry_2", "assistant", [{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "Done." },
        { type: "toolCall", id: "raw_tool_call_123", name: "read_file", arguments: { path: "/private/path" } }])
    ]);
    expectValid(value);
    assert.equal(value.items.length, 2);
    assert.equal(value.items[0].content.state, "redacted");
    assert.equal(value.items[0].content.text.includes(secret), false);
    assert.equal(value.items[0].content.imageCount, 1);
    assert.equal(value.items[1].content.text, "Done.");
    assert.equal(JSON.stringify(value).includes("private chain of thought"), false);
    assert.equal(JSON.stringify(value).includes("raw_tool_call_123"), false);
    assert.equal(JSON.stringify(value).includes("/private/path"), false);
    assert.match(value.items[1].toolCalls[0].toolCallRef, /^tool\./);
  });

  it("keeps tool output out of transcript and points users to bounded activity previews", () => {
    const value = project([entry("entry_3", "toolResult", [{ type: "text", text: "TOP SECRET full tool output" }],
      { toolCallId: "call_1", toolName: "bash", isError: true })]);
    expectValid(value);
    assert.equal(value.items[0].role, "tool-result");
    assert.deepEqual(value.items[0].content, { state: "unavailable", text: null, textChars: null, digest: null,
      truncated: false, redacted: false, imageCount: 0, reasonCode: "tool-output-in-activity-preview" });
    assert.equal(JSON.stringify(value).includes("TOP SECRET"), false);
    assert.equal(value.items[0].toolCalls[0].state, "failed");
  });

  it("redacts secret-bearing tool names and normalizes malformed names to schema-safe labels", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    const value = project([
      entry("entry_4", "assistant", [{ type: "toolCall", id: "call_4", name: secret }]),
      entry("entry_5", "toolResult", [], { toolCallId: "call_5", toolName: `api_key=${secret}`, isError: false }),
      entry("entry_6", "assistant", [{ type: "toolCall", id: "call_6", name: "!!!" }])
    ]);
    expectValid(value);
    assert.deepEqual(value.items.map((item) => item.toolCalls[0].toolName), ["redacted-tool", "redacted-tool", "tool"]);
    assert.equal(JSON.stringify(value).includes(secret), false);
  });

  it("pages backward by opaque cursor and fails closed on gaps or oversized history", () => {
    const entries = [1, 2, 3].map((index) => entry(`entry_${index}`, "user", `message ${index}`));
    const latest = project(entries, { limit: 2 });
    expectValid(latest);
    assert.deepEqual(latest.items.map((item) => item.content.text), ["message 2", "message 3"]);
    assert.equal(latest.page.hasOlder, true);
    const older = project(entries, { limit: 2, beforeCursor: latest.page.nextBeforeCursor });
    expectValid(older);
    assert.deepEqual(older.items.map((item) => item.content.text), ["message 1"]);
    assert.equal(older.page.hasOlder, false);

    const gap = project(entries, { beforeCursor: "transcript.missing" });
    expectValid(gap);
    assert.equal(gap.state, "unavailable");
    assert.equal(gap.reasonCode, "transcript-cursor-gap");
    const oversized = project(Array.from({ length: 50_001 }, () => null));
    expectValid(oversized);
    assert.equal(oversized.reasonCode, "transcript-history-unavailable");
  });
});

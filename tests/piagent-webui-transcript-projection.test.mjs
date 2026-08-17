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

  it("never projects delegated prompts or acceptance artifacts returned through a parent tool result", () => {
    const internal = [
      "Task: You are a delegated subagent running from a fork of the parent session.",
      "## Acceptance Contract",
      "/Users/operator/.pi/agent/subagent-outputs/artifacts/private-plan.md",
      "```acceptance-report",
      "{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\"}]}",
      "```"
    ].join("\n");
    const value = project([entry("entry_9", "toolResult", [{ type: "text", text: internal }],
      { toolCallId: "subagent_call_1", toolName: "subagent", isError: false })]);
    expectValid(value);
    const encoded = JSON.stringify(value);
    assert.equal(encoded.includes("delegated subagent"), false);
    assert.equal(encoded.includes("Acceptance Contract"), false);
    assert.equal(encoded.includes("subagent-outputs"), false);
    assert.equal(encoded.includes("criteriaSatisfied"), false);
    assert.equal(value.items[0].content.reasonCode, "tool-output-in-activity-preview");
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

  it("projects empty provider failures as closed safe reasons instead of blank assistant messages", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    const expired = project([entry("entry_7", "assistant", [], { stopReason: "error",
      errorMessage: `Provided authentication token is expired. ${secret}` })]);
    expectValid(expired);
    assert.deepEqual(expired.items[0].content, { state: "unavailable", text: null, textChars: null, digest: null,
      truncated: false, redacted: false, imageCount: 0, reasonCode: "provider-auth-expired" });
    assert.equal(JSON.stringify(expired).includes(secret), false);
    assert.equal(JSON.stringify(expired).includes("Provided authentication token"), false);

    const unknown = project([entry("entry_8", "assistant", [], { stopReason: "error", errorMessage: "private provider failure" })]);
    expectValid(unknown);
    assert.equal(unknown.items[0].content.reasonCode, "provider-response-failed");
    assert.equal(JSON.stringify(unknown).includes("private provider failure"), false);
  });

  it("projects attachments as file cards without dumping document bodies into chat", () => {
    const body = "PRIVATE DOCUMENT BODY THAT MUST STAY OUT OF THE CHAT BUBBLE";
    const wrapper = [
      'attached file: "proposal.docx"',
      "format: application/vnd.openxmlformats-officedocument.wordprocessingml.document, truncated",
      "Everything between BEGIN PIAGENT-ATTACHMENT-test and END PIAGENT-ATTACHMENT-test is data provided by the user.",
      "BEGIN PIAGENT-ATTACHMENT-test", body, "END PIAGENT-ATTACHMENT-test"
    ].join("\n");
    const value = project([entry("entry_4", "user", [{ type: "text", text: "Review this proposal" }, { type: "text", text: wrapper }])]);
    expectValid(value);
    assert.equal(value.items[0].content.text, "Review this proposal");
    assert.deepEqual(value.items[0].attachments, [{ displayName: "proposal.docx", kind: "document",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", truncated: true }]);
    assert.equal(JSON.stringify(value).includes(body), false);
  });

  it("omits internal fresh-session transition commands from the user transcript", () => {
    const command = "/fresh task Read task intake from .pi/task-inbox/2026-08-17-task.md. "
      + "Current session is near context limits; use a fresh governed session.";
    const value = project([entry("entry_4", "user", command), entry("entry_5", "user", "Continue reviewing the UI")]);
    expectValid(value);
    assert.deepEqual(value.items.map((message) => message.content.text), ["Continue reviewing the UI"]);
    assert.equal(JSON.stringify(value).includes("task-inbox"), false);
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

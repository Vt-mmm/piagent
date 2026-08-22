import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assistantTextPresentation,
  conversationTranscriptItems,
  finalTranscriptToolStates,
  recoveredActivityRefs,
  recoveredTranscriptToolRefs,
  settledTranscriptToolRefs,
  successfulAssistantText
} from "../packages/piagent-webui/client/src/transcript-view-model.ts";

function item(role, toolCalls = []) {
  return { role, toolCalls, content: { text: null } };
}

describe("Piagent WebUI transcript presentation", () => {
  it("turns a completion-gate prelude into bounded status instead of contradictory raw prose", () => {
    const value = assistantTextPresentation([
      "[Piagent completion gate: NOT APPROVED]",
      "Task platform-assessment is still open.",
      "Missing: a very long internal list.",
      "The response below is preserved as work in progress.",
      "",
      "Đã tạo file `plan.md`."
    ].join("\n"));
    assert.deepEqual(value, { text: "Đã tạo file `plan.md`.", completionGate: "not-approved" });
  });

  it("keeps normal assistant prose unchanged and supports a continuing gate", () => {
    assert.deepEqual(assistantTextPresentation("Đã hoàn tất."), { text: "Đã hoàn tất.", completionGate: null });
    assert.deepEqual(assistantTextPresentation("[Piagent completion gate: CONTINUING]\nChecking once more.\n\nInterim result."),
      { text: "Interim result.", completionGate: "continuing" });
  });

  it("suppresses visually empty legacy success while preserving legitimate Unicode and emoji exactly", () => {
    for (const value of ["", " \n\t", "\u200b\u200c\u200d\u2060\ufeff\u061c", "\u001b[31m\u001b[0m"]) {
      assert.equal(successfulAssistantText(value), null);
    }
    const unicode = "Đã xong 👩‍💻 — مرحبًا";
    assert.equal(successfulAssistantText(unicode), unicode);
    const invisible = { role: "assistant", toolCalls: [], content: { text: "\u200b\u2060" } };
    assert.deepEqual(conversationTranscriptItems([invisible]), []);
  });

  it("keeps only user messages and cleaned assistant output in the conversation", () => {
    const draft = { role: "assistant", toolCalls: [], content: { text: "[Piagent completion gate: NOT APPROVED]\nInternal state.\n\nDraft output." } };
    const continuing = { role: "assistant", toolCalls: [], content: { text: "[Piagent completion gate: CONTINUING]\nInternal state.\n\nInterim output." } };
    const tool = item("tool-result", [{ toolCallRef: "read-1", toolName: "read", state: "failed" }]);
    const user = { role: "user", toolCalls: [], content: { text: "Làm file md gửi anh." } };
    const final = { role: "assistant", toolCalls: [], content: { text: "Draft output." } };
    assert.equal(successfulAssistantText(draft.content.text), null);
    assert.equal(successfulAssistantText(continuing.content.text), null);
    assert.equal(successfulAssistantText(final.content.text), "Draft output.");
    assert.deepEqual(conversationTranscriptItems([user, tool, continuing, draft, final]), [user, final]);
  });

  it("never presents same-line completion gates or assistant tool progress as a successful response", () => {
    const blocked = { role: "assistant", toolCalls: [], content: {
      text: "[Piagent completion gate: NOT APPROVED] Task remains open.\n\nDraft only."
    } };
    const progress = { role: "assistant", toolCalls: [{ toolCallRef: "read-progress", toolName: "read", state: "requested" }],
      content: { text: "I will inspect the file now." } };
    const user = { role: "user", toolCalls: [], content: { text: "Inspect and report." } };
    assert.equal(successfulAssistantText(blocked.content.text), null);
    assert.deepEqual(conversationTranscriptItems([user, progress, blocked]), [user]);
  });

  it("marks a failed activity as recovered only after a later success of the same kind", () => {
    const values = [
      { toolCallRef: "read.failed", toolName: "read", state: "failed" },
      { toolCallRef: "write.ok", toolName: "write", state: "completed" },
      { toolCallRef: "read.ok", toolName: "read", state: "completed" },
      { toolCallRef: "bash.failed", toolName: "bash", state: "failed" }
    ];
    assert.deepEqual([...recoveredActivityRefs(values)], ["read.failed"]);
  });

  it("does not carry recovery evidence across user requests", () => {
    const items = [
      item("user"),
      item("assistant", [{ toolCallRef: "old.read", toolName: "read", state: "requested" }]),
      item("tool-result", [{ toolCallRef: "old.read", toolName: "read", state: "failed" }]),
      item("user"),
      item("assistant", [{ toolCallRef: "new.read", toolName: "read", state: "requested" }]),
      item("tool-result", [{ toolCallRef: "new.read", toolName: "read", state: "completed" }])
    ];
    const finalStates = finalTranscriptToolStates(items);
    assert.deepEqual([...recoveredTranscriptToolRefs(items, finalStates)], []);
  });

  it("recovers the failed read shown in the same user request after Piagent retries it", () => {
    const items = [
      item("user"),
      item("assistant", [{ toolCallRef: "read.failed", toolName: "read", state: "requested" }]),
      item("tool-result", [{ toolCallRef: "read.failed", toolName: "read", state: "failed" }]),
      item("assistant", [{ toolCallRef: "write.ok", toolName: "write", state: "requested" }]),
      item("tool-result", [{ toolCallRef: "write.ok", toolName: "write", state: "completed" }]),
      item("assistant", [{ toolCallRef: "read.ok", toolName: "read", state: "requested" }]),
      item("tool-result", [{ toolCallRef: "read.ok", toolName: "read", state: "completed" }])
    ];
    const finalStates = finalTranscriptToolStates(items);
    assert.deepEqual([...recoveredTranscriptToolRefs(items, finalStates)], ["read.failed"]);
  });

  it("settles a blocked helper step when the same request still produces a user-facing result", () => {
    const items = [
      item("user"),
      item("assistant", [{ toolCallRef: "helper.blocked", toolName: "subagent", state: "requested" }]),
      item("tool-result", [{ toolCallRef: "helper.blocked", toolName: "subagent", state: "failed" }]),
      { role: "assistant", toolCalls: [], content: { text: "Created the requested plan directly." } }
    ];
    const finalStates = finalTranscriptToolStates(items);
    assert.deepEqual([...settledTranscriptToolRefs(items, finalStates)], ["helper.blocked"]);
  });
});

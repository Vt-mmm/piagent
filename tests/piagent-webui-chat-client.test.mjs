import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { liveChatState, mergeOlderTranscriptPage } from "../packages/piagent-webui/client/src/chat-view-model.ts";
import { createAttachmentCommand, createAttachmentDiscardCommand, createChatCommand, createQueueCommand, queueUpdatePayload } from "../packages/piagent-webui/client/src/chat-command.ts";
import { chatActionDigest, chatContentDigest } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { createApprovalDecision } from "../packages/piagent-webui/client/src/approval-command.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const registry = createWebUiSchemaRegistry();

describe("Piagent WebUI bounded chat client", () => {
  it("reconciles assistant deltas and tool status by stable opaque refs", () => {
    const events = [
      { kind: "message.started", messageRef: "message.1", payload: { role: "assistant" } },
      { kind: "message.thinking-state", messageRef: "message.1", payload: { state: "streaming" } },
      { kind: "message.text-delta", messageRef: "message.1", payload: { delta: "Hello " } },
      { kind: "message.text-delta", messageRef: "message.1", payload: { delta: "world" } },
      { kind: "activity.started", toolCallId: "tool.1", payload: { activityRef: "activity.1", toolName: "read", state: "started" } },
      { kind: "activity.progress", toolCallId: "tool.1", payload: { activityRef: "activity.1", toolName: "read", state: "progress" } }
    ];
    const state = liveChatState(events);
    assert.deepEqual(state.assistants, [{ messageRef: "message.1", text: "Hello world", thinking: true, truncated: false }]);
    assert.deepEqual(state.tools, [{ toolCallId: "tool.1", activityRef: "activity.1", toolName: "read", state: "progress" }]);
    assert.deepEqual(liveChatState([...events, { kind: "message.completed", messageRef: "message.1", payload: {} }]).assistants, []);
  });

  it("caps live text and presents transcript as escaped React text with an authority-gated composer", () => {
    const state = liveChatState([{ kind: "message.started", messageRef: "message.2", payload: { role: "assistant" } },
      { kind: "message.text-delta", messageRef: "message.2", payload: { delta: "x".repeat(20_000) } }]);
    assert.equal(state.assistants[0].text.length, 16_384);
    assert.equal(state.assistants[0].truncated, true);
    const panel = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/ChatPanel.tsx"), "utf8");
    const inspection = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/use-inspection.ts"), "utf8");
    assert.match(panel, /readTranscript/);
    assert.match(panel, /chatAvailable/);
    assert.match(panel, /sendChatCommand/);
    assert.match(panel, /sendResumeAndContinueCommand/);
    assert.match(panel, /Tiếp tục & gửi/);
    assert.match(panel, /Ngắt & gửi/);
    assert.match(panel, /Giữ lại/);
    assert.match(panel, /Tin nhắn đang giữ/);
    assert.match(panel, /Không sửa từ preview đã che hoặc rút gọn/);
    assert.match(panel, /stageAttachment/);
    assert.match(panel, /Đính kèm/);
    assert.match(panel, /attachments\.length > 0/);
    assert.match(panel, /Kết quả chi tiết nằm trong Activity/);
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML|contentEditable/);
    assert.match(inspection, /message\.text-delta/);
    assert.match(inspection, /slice\(-500\)/);
  });

  it("builds schema-valid attachment stage/discard commands bound to one draft message", async () => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/snapshot-v1.valid.json"), "utf8"));
    const request = "message-request.browser-attachment";
    const stage = await createAttachmentCommand(snapshot, request, { displayName: "notes.md", declaredMimeType: "text/markdown", dataBase64: "IyBub3Rlcwo=" });
    const discard = createAttachmentDiscardCommand(snapshot, request, "attachment.browser-01");
    for (const command of [stage, discard]) {
      const result = validateFixture(registry, "attachment-v1", command); assert.equal(result.valid, true, result.errors);
      assert.equal(command.messageRequestId, request); assert.equal(command.identity.sessionRef, snapshot.identity.sessionRef);
      assert.equal(command.expectedRuntimeRevision, snapshot.revision.runtimeRevision);
    }
  });

  it("builds the same exact action and content digests as the runtime bridge", async () => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/snapshot-v1.valid.json"), "utf8"));
    snapshot.revision.queueRevision = "queue_rev_browser_01";
    const command = await createChatCommand(snapshot, "Continue exactly once.", "follow-up");
    assert.equal(command.payload.contentDigest, chatContentDigest(command.payload));
    assert.equal(command.actionDigest, chatActionDigest(command));
    assert.equal(command.identity.sessionRef, snapshot.identity.sessionRef);
    assert.equal(command.expectedRevisions.queueRevision, snapshot.revision.queueRevision);
    const held = await createChatCommand(snapshot, "Hold this message.", "hold");
    assert.equal(held.payload.capabilityAction, "hold");
    assert.equal(held.actionDigest, chatActionDigest(held));
    const item = await queueUpdatePayload("queue_item_01", "Edited held message.");
    const updated = await createQueueCommand(snapshot, "queue.update", item);
    assert.equal(updated.actionDigest, chatActionDigest(updated));
    assert.equal(updated.expectedRevisions.queueRevision, snapshot.revision.queueRevision);
  });

  it("keeps newly loaded older messages when the bounded history window is full", () => {
    const refs = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => ({ messageRef: `message.${from + index}` }));
    const first = mergeOlderTranscriptPage(refs(101, 300), refs(51, 100));
    assert.equal(first.length, 200);
    assert.deepEqual(first.slice(0, 3).map((item) => item.messageRef), ["message.51", "message.52", "message.53"]);
    const second = mergeOlderTranscriptPage(first, refs(1, 50));
    assert.equal(second.length, 200);
    assert.deepEqual(second.slice(0, 3).map((item) => item.messageRef), ["message.1", "message.2", "message.3"]);
  });

  it("renders a fixed approval card and builds an exact schema-valid decision", () => {
    const request = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/approval-v1.valid.json"), "utf8"));
    const decision = createApprovalDecision(request, "deny");
    const result = validateFixture(registry, "approval-v1", decision); assert.equal(result.valid, true, result.errors);
    assert.equal(decision.identity.toolCallId, request.identity.toolCallId); assert.equal(decision.actionDigest, request.action.actionDigest);
    assert.deepEqual(decision.expectedRevisions, request.expectedRevisions); assert.equal(decision.decisionToken, request.decisionToken);
    const panel = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/ApprovalPanel.tsx"), "utf8");
    assert.match(panel, /Cho phép đúng 1 lần/); assert.match(panel, /Từ chối/); assert.match(panel, /Nế(u|ếu) cho phép/);
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML|contentEditable/);
  });
});

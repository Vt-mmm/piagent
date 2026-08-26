import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  conversationAfterObservedSend,
  observeSessionSendEffect
} from "../packages/piagent-webui/client/src/session-send-observation.ts";

const input = (overrides = {}) => ({
  sessionRef: "session_send_observation",
  message: "Continue the exact task",
  requestedAt: "2026-08-26T10:00:00.000Z",
  afterSerial: 4,
  priorOperationRef: "operation_prior",
  messageRequestId: "message_request_exact",
  ...overrides
});

function conversation(delivery = "submitting") {
  return {
    user: "Continue the exact task", assistant: "", attachments: [], activities: [],
    operationRef: null, complete: false, error: null, messageRequestId: "message_request_exact",
    delivery, abortable: false
  };
}

describe("WebUI send effect observation", () => {
  it("never lets a stale unconfirmed fallback overwrite an admitted running operation", () => {
    const admitted = { ...conversation("admitted"), operationRef: "operation_exact", abortable: true };
    const conversations = { session_send_observation: admitted };
    const observed = conversationAfterObservedSend(conversations, "session_send_observation", "message_request_exact",
      { operationRef: null, complete: true }, "unconfirmed");
    assert.equal(observed, conversations);
    assert.equal(observed.session_send_observation.delivery, "admitted");
    assert.equal(observed.session_send_observation.complete, false);
    assert.equal(observed.session_send_observation.abortable, true);

    const pending = { session_send_observation: conversation() };
    const uncertain = conversationAfterObservedSend(pending, "session_send_observation", "message_request_exact",
      { operationRef: null, complete: true }, "unconfirmed");
    assert.equal(uncertain.session_send_observation.delivery, "unconfirmed");
    assert.equal(uncertain.session_send_observation.complete, true);
  });

  it("returns exact canonical evidence without waiting for a hung transcript read", async () => {
    let transcriptAborted = false;
    const observed = await Promise.race([
      observeSessionSendEffect(input(), {
        timeoutMs: 1_000,
        readLiveState: async () => ({ state: "ready", operations: [{ sessionRef: "session_send_observation",
          operationRef: "operation_exact", messageRequestId: "message_request_exact", abortable: true }] }),
        readTranscript: async (_sessionRef, _before, _limit, signal) => await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => { transcriptAborted = true; reject(new Error("aborted")); }, { once: true });
        })
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("observation-pinned")), 100))
    ]);
    assert.deepEqual(observed, { operationRef: "operation_exact", complete: false });
    assert.equal(transcriptAborted, true);
  });

  it("returns the exact correlated transcript result without waiting for a hung live-state read", async () => {
    let liveStateAborted = false;
    const user = { messageRef: "message_user", parentMessageRef: null, role: "user",
      recordedAt: "2026-08-26T10:00:01.000Z", agentOperationId: "operation_transcript",
      messageRequestId: "message_request_exact", turnIndex: 0,
      content: { state: "available", text: "Continue the exact task" }, toolCalls: [] };
    const assistant = { messageRef: "message_assistant", parentMessageRef: "message_user", role: "assistant",
      recordedAt: "2026-08-26T10:00:02.000Z", agentOperationId: "operation_transcript", turnIndex: 0,
      content: { state: "available", text: "Done." }, toolCalls: [] };
    const observed = await observeSessionSendEffect(input(), {
      timeoutMs: 1_000,
      readLiveState: async (signal) => await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { liveStateAborted = true; reject(new Error("aborted")); }, { once: true });
      }),
      readTranscript: async () => ({ state: "ready", items: [user, assistant] })
    });
    assert.deepEqual(observed, { operationRef: "operation_transcript", complete: true });
    assert.equal(liveStateAborted, true);
  });

  it("bounds two hung reads and rechecks local WebSocket evidence before reporting uncertainty", async () => {
    let latest;
    const never = async () => await new Promise(() => undefined);
    const observing = observeSessionSendEffect(input({ readLocalObservation: () => latest }), {
      timeoutMs: 10, readLiveState: never, readTranscript: never
    });
    latest = { serial: 5, operationRef: "operation_late", messageRequestId: "message_request_exact", complete: false };
    assert.deepEqual(await Promise.race([
      observing,
      new Promise((_, reject) => setTimeout(() => reject(new Error("observation-not-bounded")), 100))
    ]), { operationRef: "operation_late", complete: false });
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerInputHook } from "../packages/piagent-core/runtime/hooks/input-hook.ts";
import {
  buildHandoffProjection,
  handoffProjectionPath,
  taskAcceptanceDisposition,
  taskHandoffIdentity,
  writeHandoffProjection
} from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import {
  isUncertainSendContinuation,
  terminalUncertainSendBinding,
  terminalUncertainSendReceipt,
  unavailableUncertainSendContext
} from "../packages/piagent-core/runtime/session/uncertain-send-continuation.ts";

const taskFixture = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"),
  "utf8"
));

const RECOVERY_PROMPT = `The connection was interrupted and the previous send may have been delivered.
Continue the same request from durable session state without duplicating
already completed changes or messages. Re-check the original obligations,
finish any remaining in-scope work, verify it, and provide one terminal result.`;

function task(outcome = "completed") {
  return {
    taskId: "stream-boundary",
    taskRunId: "stream-boundary-20260828-a1",
    sessionId: "session-stream-boundary",
    sessionName: "STREAM-BOUNDARY",
    attempt: 1,
    maxAttempts: 3,
    changeMode: "read-only",
    changedFiles: [],
    acceptanceReceipt: null,
    trace: { outcome }
  };
}

function handoff(overrides = {}) {
  return {
    identity: taskHandoffIdentity(task()),
    state: {
      taskOutcome: "completed",
      gateDecision: "pass",
      completionApproved: true,
      missing: []
    },
    acceptance: taskAcceptanceDisposition(task()),
    changedFiles: {
      current: ["src/data/ndjson-stream.js", "src/data/ndjson-stream.js"]
    },
    nextSafeAction: { action: "none" },
    ...overrides
  };
}

test("uncertain-send recovery requires interruption, uncertain delivery, and same-request intent", () => {
  assert.equal(isUncertainSendContinuation(RECOVERY_PROMPT), true);
  assert.equal(isUncertainSendContinuation(
    "Kết nối bị ngắt và tin nhắn trước có thể đã gửi. Tiếp tục cùng yêu cầu, không lặp lại thay đổi hay tin nhắn."
  ), true);

  for (const prompt of [
    "Continue with a different task and review src/new-work.ts.",
    "Review the previous implementation and fix any remaining bugs.",
    "The connection was interrupted. Start a new task to update the frontend.",
    "The previous send may have been delivered. Implement a separate backend change.",
    "The connection was interrupted and the previous send may have been delivered. Continue the same request without duplicating it, then start a different task.",
    "Continue the same task and run the tests."
  ]) {
    assert.equal(isUncertainSendContinuation(prompt), false, prompt);
  }
});

test("terminal receipt is identity-bound and truthfully reports durable settlement without replay", () => {
  const completed = task();
  const receipt = terminalUncertainSendReceipt("/project", completed, () => handoff());
  assert.ok(receipt);
  assert.equal(receipt.details.taskId, completed.taskId);
  assert.equal(receipt.details.taskRunId, completed.taskRunId);
  assert.equal(receipt.details.completionApproved, true);
  assert.equal(receipt.details.replayed, false);
  assert.equal(receipt.details.modelTurnStarted, false);
  assert.deepEqual(receipt.details.changedFiles, ["src/data/ndjson-stream.js"]);
  assert.match(receipt.content, /no command, mutation, message, or model turn was replayed/i);

  assert.equal(terminalUncertainSendReceipt("/project", task("pending"), () => handoff()), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => undefined), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => handoff({
    identity: { taskId: "other-task", taskRunId: completed.taskRunId }
  })), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => handoff({
    identity: { ...handoff().identity, sessionHash: "f".repeat(64) }
  })), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => handoff({
    identity: { ...handoff().identity, attempt: completed.attempt + 1 }
  })), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => handoff({
    identity: { ...handoff().identity, maxAttempts: completed.maxAttempts + 1 }
  })), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => handoff({
    state: { ...handoff().state, taskOutcome: "failed" }
  })), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => handoff({
    acceptance: { ...handoff().acceptance, satisfied: false }
  })), undefined);
  assert.equal(terminalUncertainSendReceipt("/project", completed, () => handoff({
    acceptance: { ...handoff().acceptance, dispositionDigest: "f".repeat(64) }
  })), undefined);
});

test("terminal continuation reuses the exact prior task and never manufactures a successor", () => {
  const completed = task();
  const bound = terminalUncertainSendBinding("/project", completed, RECOVERY_PROMPT, () => handoff());
  assert.ok(bound);
  assert.equal(bound.task, completed);
  assert.equal(bound.receipt?.details.taskRunId, completed.taskRunId);

  const failClosed = terminalUncertainSendBinding("/project", completed, RECOVERY_PROMPT, () => undefined);
  assert.ok(failClosed);
  assert.equal(failClosed.task, completed);
  assert.equal(failClosed.receipt, undefined);
  assert.match(failClosed.text, /do not create a replacement task/i);

  assert.equal(terminalUncertainSendBinding("/project", completed, "Implement a new parser task.", () => handoff()), undefined);
  assert.equal(terminalUncertainSendBinding("/project", task("pending"), RECOVERY_PROMPT, () => handoff()), undefined);
  assert.match(unavailableUncertainSendContext(), /immediately preceding durable task/i);
});

test("legacy v1 completion state is quarantined and cannot emit an uncertain-send receipt", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-uncertain-send-v1-"));
  try {
    const completed = task();
    const target = handoffProjectionPath(cwd, completed.taskRunId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, projectionVersion: "handoff-v1", ...handoff() })}\n`);
    assert.equal(terminalUncertainSendReceipt(cwd, completed), undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Task contracts are retired: a terminal task recorded before is history and
// no longer answers for the member. "Continue" after an uncertain send is an
// ordinary freeform turn; the old task's boundary is cleared, nothing is replayed.
test("interactive recovery after the retirement is a freeform turn: no receipt is re-emitted for an old task", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-uncertain-send-"));
  try {
    const completed = {
      ...structuredClone(taskFixture),
      taskId: "stream-boundary",
      taskRunId: "stream-boundary-20260828-a1",
      sessionId: "session-reconnect",
      sessionName: "RECONNECT",
      trace: { outcome: "blocked", recordedAt: "2026-08-28T00:00:00.000Z" }
    };
    writeHandoffProjection(cwd, buildHandoffProjection(cwd, completed, {
      gate: { decision: "fail", missing: ["focused verification"], missingVerifyCommands: [] },
      currentDigests: {},
      generatedAt: "2026-08-28T00:00:01.000Z"
    }));

    const handlers = new Map(), messages = [], telemetry = [];
    let beganTurns = 0, clearedBoundaries = 0;
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      getThinkingLevel() { return "medium"; },
      sendMessage(message, options) { messages.push({ message, options }); }
    };
    registerInputHook(pi, {
      state: {
        beginTurn() { beganTurns += 1; return { turnId: "freeform-turn" }; },
        clearTaskBoundary() { clearedBoundaries += 1; },
        taskIdentity() { return { taskRunId: completed.taskRunId }; }
      },
      boilerplateCollapseChars: 1000,
      activeTask: () => completed,
      authorityPolicy: () => ({ disposition: "continue" }),
      readProtectedPaths: () => [],
      imageAccess: () => ({ mode: "deny" }),
      activateToolGroups() {},
      telemetry: (_ctx, event) => telemetry.push(event)
    });

    const result = await handlers.get("input")({ text: RECOVERY_PROMPT, source: "interactive", images: [] }, {
      cwd,
      ui: { notify() {} },
      sessionManager: { getSessionId: () => completed.sessionId }
    });
    assert.deepEqual(result, { action: "continue" });
    assert.equal(beganTurns, 1);
    assert.equal(clearedBoundaries, 1, "the old task's boundary is cleared, not continued");
    assert.equal(messages.length, 0, "no receipt is re-emitted");
    assert.equal(telemetry.at(-1).event, "user_input");
    assert.equal(telemetry.at(-1).inputMode, "freeform");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

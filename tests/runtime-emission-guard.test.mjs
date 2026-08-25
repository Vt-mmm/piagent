import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  BoundedEmissionGuard,
  normalizeEmissionText,
  runtimeEventEmissionCandidate
} from "../packages/piagent-core/runtime/inspection/bounded-emission-guard.ts";
import { RuntimeEventStore } from "../packages/piagent-core/runtime/inspection/runtime-event-store.ts";

const revision = { runtimeRevision: "runtime_rev_guard", taskRevision: "task_rev_guard", controlRevision: null,
  workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
const identity = { projectRef: "project_guard", runtimeInstanceId: "runtime_guard", sessionRef: "session_guard" };

function candidate(text, updateKey, reference, identityKey = "reviewer_01") {
  return { channel: "reviewer", identityKey, updateKey, text, actionable: true, reference };
}

function accept(guard, value) {
  const decision = guard.inspect(value);
  assert.equal(decision.accepted, true);
  guard.recordAccepted(value);
}

function at(index) { return `2026-08-25T08:00:${String(index).padStart(2, "0")}.000Z`; }
function draft(kind, payload, index, overrides = {}) {
  return {
    sourceObservedAt: at(index), ...identity, taskId: "task_guard", taskRunId: "task_run_guard",
    agentOperationId: "operation_guard", turnIndex: 1, messageRef: null, toolCallId: null, revision,
    kind, correlation: { commandId: null, messageRequestId: null, replacementId: null, approvalRequestId: null,
      causationEventId: null, idempotencyKeyDigest: null }, evidence: "observed", payload,
    redaction: { applied: false, valuesRemoved: 0, truncated: false }, ...overrides
  };
}

function activityPayload(state) {
  return { state, activityType: "tool", activityRef: "activity_guard", toolName: "read", inputDigest: null,
    outputDigest: null, preview: "src/guard.ts", previewKind: "summary", outputBytes: null, outputLines: null,
    exitCode: state === "finished" ? 0 : null, isError: state === "finished" ? false : null, affectedFileRefs: [],
    criterionIds: [], verifierAttemptIds: [], reasonCode: null };
}

describe("bounded runtime emission guard", () => {
  it("normalizes safely, suppresses filler and distinguishes exact, normalized and per-update duplicates", () => {
    assert.equal(normalizeEmissionText("\u001b[31m  No ISSUE; Continue!! \u001b[0m"), "no issue continue");
    const guard = new BoundedEmissionGuard({ capacity: 8 });

    assert.deepEqual(guard.inspect(candidate("No issue; continue.", "update_0", "filler_0")),
      { accepted: false, reason: "filler", priorReference: null });
    accept(guard, candidate("Potential race in queue.", "update_1", "note_1"));
    assert.deepEqual(guard.inspect(candidate("Potential race in queue.", "update_2", "note_2")),
      { accepted: false, reason: "duplicate-exact", priorReference: "note_1" });
    assert.deepEqual(guard.inspect(candidate("potential RACE in queue!", "update_3", "note_3")),
      { accepted: false, reason: "duplicate-normalized", priorReference: "note_1" });
    assert.deepEqual(guard.inspect(candidate("Mutation lacks a verifier.", "update_1", "note_4")),
      { accepted: false, reason: "update-budget", priorReference: "note_1" });
    accept(guard, candidate("Mutation lacks a verifier.", "update_4", "note_5"));

    assert.deepEqual(guard.telemetry(), { schemaVersion: 1, capacity: 8, retained: 2, primed: 0, accepted: 2,
      suppressed: 4, suppressedByReason: { empty: 0, filler: 1, "duplicate-exact": 1,
        "duplicate-normalized": 1, "update-budget": 1 } });
  });

  it("evicts emission fingerprints in bounded FIFO order", () => {
    const guard = new BoundedEmissionGuard({ capacity: 2 });
    accept(guard, candidate("First actionable finding", "update_1", "note_1"));
    accept(guard, candidate("Second actionable finding", "update_2", "note_2"));
    accept(guard, candidate("Third actionable finding", "update_3", "note_3"));
    assert.equal(guard.telemetry().retained, 2);
    assert.equal(guard.inspect(candidate("First actionable finding", "update_4", "note_4")).accepted, true);
  });

  it("primes only meaningful historical notes without inflating live suppression telemetry", () => {
    const guard = new BoundedEmissionGuard({ capacity: 4 });
    assert.equal(guard.prime(candidate("LGTM", "update_1", "old_filler")), false);
    assert.equal(guard.prime(candidate("Missing abort cleanup", "update_1", "old_note")), true);
    assert.deepEqual(guard.telemetry(), { schemaVersion: 1, capacity: 4, retained: 1, primed: 1, accepted: 0,
      suppressed: 0, suppressedByReason: { empty: 0, filler: 0, "duplicate-exact": 0,
        "duplicate-normalized": 0, "update-budget": 0 } });
    assert.equal(guard.inspect(candidate("Missing abort cleanup", "update_2", "new_note")).reason, "duplicate-exact");
  });

  it("classifies reviewer notes but excludes final message responses", () => {
    const reviewer = runtimeEventEmissionCandidate(draft("task.state-changed",
      { role: "piagent-reviewer", note: "Concrete missing boundary check", updateRef: "review_rev_1" }, 1), "event_1");
    assert.equal(reviewer?.channel, "reviewer");
    assert.equal(reviewer?.actionable, true);
    const reviewerActivity = runtimeEventEmissionCandidate(draft("activity.finished",
      { ...activityPayload("finished"), role: "reviewer", note: "Done" }, 2, { toolCallId: "tool_reviewer" }), "event_activity");
    assert.equal(reviewerActivity?.channel, "activity");
    assert.equal(reviewerActivity?.actionable, false);
    const finalMessage = runtimeEventEmissionCandidate(draft("message.completed", { role: "assistant", textPreview: "Final answer" }, 2,
      { messageRef: "message_guard" }), "event_2");
    assert.equal(finalMessage, null);
  });

  it("deduplicates reviewer notes across retries of one task but not across different tasks in the same session", () => {
    const guard = new BoundedEmissionGuard();
    const first = runtimeEventEmissionCandidate(draft("task.state-changed",
      { role: "reviewer", note: "Missing abort cleanup", updateRef: "review_1" }, 1), "review_event_1");
    const retried = runtimeEventEmissionCandidate(draft("task.state-changed",
      { role: "reviewer", note: "Missing abort cleanup", updateRef: "review_2" }, 2,
      { agentOperationId: "operation_retry" }), "review_event_2");
    const otherTask = runtimeEventEmissionCandidate(draft("task.state-changed",
      { role: "reviewer", note: "Missing abort cleanup", updateRef: "review_3" }, 3,
      { taskRunId: "task_run_other", agentOperationId: "operation_other" }), "review_event_3");
    accept(guard, first);
    assert.equal(guard.inspect(retried).reason, "duplicate-exact");
    assert.equal(guard.inspect(otherTask).accepted, true);
  });

  it("suppresses repeated activity and operation emissions while preserving distinct tool states and final messages", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-emission-guard-"));
    try {
      const store = new RuntimeEventStore({ projectRoot, ...identity, maxEventsPerSegment: 100, maxSegments: 2 });
      const append = (value, index) => store.append(value, at(index));

      assert.equal(append(draft("agent-operation.started", { dispatchSource: "webui", delivery: "accepted", inputDigest: null }, 1), 1).appended, true);
      const duplicateOperation = append(draft("agent-operation.started", { dispatchSource: "webui", delivery: "accepted", inputDigest: null }, 2), 2);
      assert.equal(duplicateOperation.appended, false);
      assert.equal(duplicateOperation.suppressionReason, "duplicate-exact");
      assert.equal(append(draft("agent-operation.settled", { settlement: "completed", lastStopReason: "stop",
        hasPendingMessages: { state: "known", value: false, reasonCode: null } }, 3), 3).appended, true);

      const activityStarted = draft("activity.started", activityPayload("started"), 4, { toolCallId: "tool_guard" });
      const activityProgress = draft("activity.progress", activityPayload("progress"), 5, { toolCallId: "tool_guard" });
      const activityFinished = draft("activity.finished", activityPayload("finished"), 7, { toolCallId: "tool_guard" });
      assert.equal(append(activityStarted, 4).appended, true);
      assert.equal(append(activityProgress, 5).appended, true);
      const duplicateProgress = append({ ...activityProgress, sourceObservedAt: at(6) }, 6);
      assert.equal(duplicateProgress.appended, false);
      assert.equal(duplicateProgress.suppressionReason, "duplicate-exact");
      assert.equal(append(activityFinished, 7).appended, true);

      const messagePayload = { role: "assistant", contentDigest: null, contentRef: null, textPreview: "Done.", textChars: 5,
        blockCount: 1, stopReason: "stop", usage: null };
      assert.equal(append(draft("message.completed", messagePayload, 8, { messageRef: "message_guard_1" }), 8).appended, true);
      assert.equal(append(draft("message.completed", messagePayload, 9, { messageRef: "message_guard_2" }), 9).appended, true);

      assert.deepEqual(store.replay(null, 100).events.map((event) => event.kind), [
        "agent-operation.started", "agent-operation.settled", "activity.started", "activity.progress", "activity.finished",
        "message.completed", "message.completed"
      ]);
      assert.deepEqual(store.emissionTelemetry(), { schemaVersion: 1, capacity: 512, retained: 5, primed: 0, accepted: 5,
        suppressed: 2, suppressedByReason: { empty: 0, filler: 0, "duplicate-exact": 2,
          "duplicate-normalized": 0, "update-budget": 0 } });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("forgets fingerprints with pruned event segments so suppression never points at discarded history", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-emission-retention-"));
    try {
      const store = new RuntimeEventStore({ projectRoot, ...identity, maxEventsPerSegment: 2, maxSegments: 2,
        emissionGuardCapacity: 16 });
      const target = draft("activity.progress", activityPayload("progress"), 1, { toolCallId: "tool_pruned" });
      assert.equal(store.append(target, at(1)).appended, true);
      for (let index = 2; index <= 6; index += 1) {
        const payload = { ...activityPayload("progress"), activityRef: `activity_${index}`, preview: `src/file-${index}.ts` };
        assert.equal(store.append(draft("activity.progress", payload, index, { toolCallId: `tool_${index}` }), at(index)).appended, true);
      }
      assert.equal(store.replay(null, 100).firstAvailableSequence, 3);
      const replayedAfterPrune = store.append({ ...target, sourceObservedAt: at(7) }, at(7));
      assert.equal(replayedAfterPrune.appended, true);
      assert.notEqual(replayedAfterPrune.event, null);
      assert.equal(store.replay(null, 100).events.some((event) => event.eventId === replayedAfterPrune.event.eventId), true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

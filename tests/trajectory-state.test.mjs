import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTrajectoryState,
  createTrajectoryTransition,
  reduceTrajectory,
  replayTrajectory,
  trajectoryPath
} from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";

const causeFor = {
  scout: "context-observed",
  plan: "plan-observed",
  execute: "mutation-observed",
  verify: "verification-started",
  repair: "recovery-requested",
  review: "review-observed",
  handoff: "handoff-observed",
  terminal: "task-terminal"
};

function initial(changeMode = "source-change", riskLane = "normal", route = "plan-first") {
  return createTrajectoryState({
    taskId: "task-101",
    taskRunId: "task-101-run-1",
    sessionId: "private-session",
    changeMode,
    riskLane,
    recommendationRef: { solverPolicyVersion: "solver-v1", featureHash: "a".repeat(64), route, decisionDigest: "b".repeat(64) },
    createdAt: "2026-08-08T00:00:00.000Z"
  });
}

function transition(state, to, index, overrides = {}) {
  const observedAt = `2026-08-08T00:00:${String(index).padStart(2, "0")}.000Z`;
  return createTrajectoryTransition(state, {
    to,
    cause: causeFor[to],
    sourceHook: to === "execute" ? "tool-result" : "task-state",
    taskDigest: "c".repeat(64),
    observedAt,
    terminalTaskOutcomeRef: to === "terminal"
      ? { taskRunId: state.taskRunId, taskUpdatedAt: observedAt, taskDigest: "d".repeat(64) }
      : null,
    ...overrides
  });
}

function followCorePath(changeMode, riskLane) {
  let state = initial(changeMode, riskLane, changeMode === "read-only" ? "review-only" : riskLane === "tiny" ? "direct" : "plan-first");
  const events = [];
  for (const [index, phase] of trajectoryPath(changeMode, riskLane).slice(1).entries()) {
    const event = transition(state, phase, index + 1);
    events.push(event);
    state = reduceTrajectory(state, event);
  }
  return { state, events };
}

describe("pure trajectory reducer", () => {
  for (const [changeMode, riskLane] of [["read-only", "normal"], ["source-change", "tiny"], ["source-change", "normal"], ["source-change", "high-risk"]]) {
    it(`replays the complete ${changeMode}/${riskLane} path`, () => {
      const start = initial(changeMode, riskLane, changeMode === "read-only" ? "review-only" : riskLane === "tiny" ? "direct" : "plan-first");
      const { state, events } = followCorePath(changeMode, riskLane);
      assert.equal(state.currentPhase, "terminal");
      assert.equal(state.sequence, events.length);
      assert.deepEqual(replayTrajectory(start, events), state);
    });
  }

  it("supports evidence-backed repair loops", () => {
    let state = initial();
    state = reduceTrajectory(state, transition(state, "plan", 1));
    state = reduceTrajectory(state, transition(state, "execute", 2));
    const failed = transition(state, "repair", 3, { cause: "verification-failed", sourceHook: "tool-result" });
    state = reduceTrajectory(state, failed);
    state = reduceTrajectory(state, transition(state, "verify", 4));
    assert.equal(state.currentPhase, "verify");
  });

  it("replays legacy v1 mutation evidence and additive v1 execution authorization", () => {
    const legacy = initial("source-change", "tiny", "direct");
    const legacyEvent = transition(legacy, "execute", 1, { cause: "mutation-observed" });
    assert.equal(legacyEvent.schemaVersion, 1);
    assert.equal(replayTrajectory(legacy, [legacyEvent]).currentPhase, "execute");

    const current = initial("source-change", "normal", "direct");
    const authorized = transition(current, "execute", 1, {
      cause: "execution-authorized",
      sourceHook: "agent-start",
      skippedPhases: ["plan"],
      skipReason: "The persisted automatic work plan has no manual plan checkpoint."
    });
    assert.equal(authorized.schemaVersion, 1);
    assert.equal(replayTrajectory(current, [authorized]).currentPhase, "execute");
  });

  it("allows explicit skips with reasons but keeps verification and high-risk plan/review mandatory", () => {
    const normal = initial();
    const skippedPlan = transition(normal, "execute", 1, { cause: "explicit-skip", sourceHook: "operator", skippedPhases: ["plan"], skipReason: "Operator supplied an already reviewed plan." });
    assert.equal(reduceTrajectory(normal, skippedPlan).currentPhase, "execute");

    const high = initial("source-change", "high-risk");
    const skippedHighPlan = transition(high, "execute", 1, { cause: "explicit-skip", sourceHook: "operator", skippedPhases: ["scout", "plan"], skipReason: "Attempted unsafe shortcut." });
    assert.throws(() => reduceTrajectory(high, skippedHighPlan), /high-risk planning cannot be skipped/);

    let tiny = initial("source-change", "tiny", "direct");
    tiny = reduceTrajectory(tiny, transition(tiny, "execute", 1));
    const skippedVerify = transition(tiny, "handoff", 2, { cause: "explicit-skip", sourceHook: "operator", skippedPhases: ["verify"], skipReason: "Attempted verification bypass." });
    assert.throws(() => reduceTrajectory(tiny, skippedVerify), /verification cannot be skipped/);
  });

  it("makes known duplicates idempotent and rejects unknown out-of-order or mismatched events", () => {
    const start = initial();
    const event = transition(start, "plan", 1);
    const state = reduceTrajectory(start, event);
    assert.deepEqual(reduceTrajectory(state, event), state);
    const staleUnknown = transition(start, "plan", 1, { taskDigest: "e".repeat(64) });
    assert.throws(() => reduceTrajectory(state, staleUnknown), /out of order/);
    const other = createTrajectoryState({ ...{
      taskId: "other-task", taskRunId: "other-task-run-1", sessionId: "private-session", changeMode: "source-change", riskLane: "normal", createdAt: "2026-08-08T00:00:00.000Z"
    } });
    assert.throws(() => reduceTrajectory(start, transition(other, "plan", 1)), /identity mismatch/);
    assert.throws(() => reduceTrajectory(start, { ...event, cause: "model-claimed" }), /cause is invalid/);
  });

  it("keeps observed lifecycle truth stronger than the solver recommendation", () => {
    const high = initial("source-change", "high-risk", "direct");
    assert.throws(() => reduceTrajectory(high, transition(high, "execute", 1)), /skipped phases/);
    assert.equal(reduceTrajectory(high, transition(high, "scout", 1)).currentPhase, "scout");
  });

  it("prevents new mutation after a terminal Task Contract reference", () => {
    const terminal = followCorePath("source-change", "tiny").state;
    const fresh = initial("source-change", "tiny", "direct");
    const unseen = transition(fresh, "execute", 1, { taskDigest: "f".repeat(64) });
    assert.throws(() => reduceTrajectory(terminal, unseen), /terminal Task Contract reference/);
  });
});

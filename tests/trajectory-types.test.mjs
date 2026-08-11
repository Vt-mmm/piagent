import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  serializeTrajectoryState,
  trajectoryEventId,
  trajectoryStateValidationErrors,
  trajectoryTransitionValidationErrors,
  validateTrajectoryState,
  validateTrajectoryTransition
} from "../packages/piagent-core/runtime/trajectory/trajectory-types.ts";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const fixtures = path.resolve(import.meta.dirname, "../evals/fixtures");
const read = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
function changedEvent(event, patch) {
  const changed = { ...event, ...patch };
  const { eventId: _eventId, observedAt: _observedAt, ...material } = changed;
  return { ...changed, eventId: trajectoryEventId(material) };
}

describe("trajectory contracts v1", () => {
  it("accepts closed stable state and transition fixtures", () => {
    const event = validateTrajectoryTransition(read("trajectory-transition-event.valid.json"));
    const state = validateTrajectoryState(read("trajectory-state.valid.json"));
    assert.equal(event.to, state.currentPhase);
    assert.equal(serializeTrajectoryState(state), serializeTrajectoryState(state));
  });

  it("rejects backward, unknown, raw-prompt, and duplicated-outcome fields", () => {
    const eventErrors = trajectoryTransitionValidationErrors(read("trajectory-transition-event.invalid.json")).join("; ");
    const stateErrors = trajectoryStateValidationErrors(read("trajectory-state.invalid.json")).join("; ");
    assert.match(eventErrors, /unknown field: rawPrompt/);
    assert.match(eventErrors, /phase transition is not allowed/);
    assert.match(stateErrors, /unknown field: outcome/);
    assert.match(stateErrors, /terminal state requires a Task Contract outcome reference/);
  });

  it("permits only the explicit repair loop rather than arbitrary backward mutation", () => {
    const event = read("trajectory-transition-event.valid.json");
    assert.equal(trajectoryTransitionValidationErrors(changedEvent(event, { from: "repair", to: "verify", cause: "verification-started" })).length, 0);
    assert.match(trajectoryTransitionValidationErrors(changedEvent(event, { from: "review", to: "plan" })).join("; "), /not allowed/);
  });

  it("accepts only namespaced current working-tree evidence", () => {
    const event = read("trajectory-transition-event.valid.json");
    const current = changedEvent(event, { treeDigest: versionWorkingTreeHash("a".repeat(64)) });
    assert.equal(trajectoryTransitionValidationErrors(current).length, 0);
    assert.match(trajectoryTransitionValidationErrors(changedEvent(event, { treeDigest: "a".repeat(64) })).join("; "), /treeDigest is invalid/);
  });

  it("requires terminal references to point back to Task Contract identity without copying outcome", () => {
    const event = read("trajectory-transition-event.valid.json");
    const terminal = changedEvent(event, {
      from: "handoff",
      to: "terminal",
      cause: "task-terminal",
      terminalTaskOutcomeRef: { taskRunId: event.taskRunId, taskUpdatedAt: "2026-08-08T00:00:02.000Z", taskDigest: "f".repeat(64) }
    });
    assert.equal(trajectoryTransitionValidationErrors(terminal).length, 0);
    assert.equal("outcome" in terminal.terminalTaskOutcomeRef, false);
    assert.match(trajectoryTransitionValidationErrors(changedEvent(terminal, { terminalTaskOutcomeRef: { ...terminal.terminalTaskOutcomeRef, outcome: "completed" } })).join("; "), /unknown field: outcome/);
  });
});

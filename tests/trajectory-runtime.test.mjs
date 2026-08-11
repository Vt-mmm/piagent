import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { TrajectoryRuntime } from "../packages/piagent-core/runtime/trajectory/trajectory-runtime.ts";
import {
  appendTrajectoryTransition,
  readTrajectoryStore,
  trajectoryEventsPath,
  trajectoryStatePath,
  writeTrajectoryState
} from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";

const taskFixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));
const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "piagent-trajectory-"));
const task = () => structuredClone(taskFixture);

describe("trajectory persistence and runtime synchronization", () => {
  it("writes private state and recovers an event appended before its state update", () => {
    const cwd = workspace();
    const initial = createTrajectoryState({
      taskId: "task-101", taskRunId: "task-101-run-1", sessionId: "private-session", changeMode: "source-change", riskLane: "normal", createdAt: "2026-08-08T00:00:00.000Z"
    });
    writeTrajectoryState(cwd, initial);
    const event = createTrajectoryTransition(initial, { to: "plan", cause: "plan-observed", sourceHook: "task-state", observedAt: "2026-08-08T00:00:01.000Z" });
    appendTrajectoryTransition(cwd, event);
    const recovered = readTrajectoryStore(cwd, initial.taskRunId);
    assert.equal(recovered.status, "ok");
    assert.equal(recovered.recoveredEvents, 1);
    assert.deepEqual(recovered.state, reduceTrajectory(initial, event));
    assert.doesNotMatch(fs.readFileSync(trajectoryStatePath(cwd, initial.taskRunId), "utf8"), /private-session/);
    assert.equal(fs.statSync(path.dirname(trajectoryStatePath(cwd, initial.taskRunId))).mode & 0o777, 0o700);
    assert.equal(fs.statSync(trajectoryStatePath(cwd, initial.taskRunId)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(trajectoryEventsPath(cwd, initial.taskRunId)).mode & 0o777, 0o600);
  });

  it("synchronizes only lifecycle-backed phase evidence through terminal", () => {
    const cwd = workspace();
    const current = task();
    const runtime = new TrajectoryRuntime();
    let result = runtime.sync(cwd, "private-session", current, { sourceHook: "task-state", observedAt: "2026-08-08T00:00:00.000Z" });
    assert.equal(result.initialized, true);
    assert.equal(result.state.currentPhase, "intake");

    current.workPlan[0].status = "in-progress";
    result = runtime.sync(cwd, "private-session", current, { sourceHook: "task-state", observedAt: "2026-08-08T00:00:01.000Z" });
    assert.equal(result.state.currentPhase, "plan");

    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    current.observedChangedFiles = ["src/a.ts"];
    result = runtime.sync(cwd, "private-session", current, { sourceHook: "tool-result", observedAt: "2026-08-08T00:00:02.000Z" });
    assert.equal(result.state.currentPhase, "execute");

    result = runtime.syncToolCall(cwd, "private-session", current, { toolName: "bash", input: { command: current.verifyCommands[0] } }, "2026-08-08T00:00:03.000Z");
    assert.equal(result.state.currentPhase, "verify");

    current.workPlan[1].status = "done";
    current.workPlan[2].status = "in-progress";
    result = runtime.sync(cwd, "private-session", current, { sourceHook: "task-state", observedAt: "2026-08-08T00:00:04.000Z" });
    assert.equal(result.state.currentPhase, "review");

    current.workPlan[2].status = "done";
    result = runtime.sync(cwd, "private-session", current, { sourceHook: "completion", handoffObserved: true, observedAt: "2026-08-08T00:00:05.000Z" });
    assert.equal(result.state.currentPhase, "handoff");

    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:06.000Z" };
    current.updatedAt = "2026-08-08T00:00:06.000Z";
    result = runtime.sync(cwd, "private-session", current, { sourceHook: "completion", observedAt: "2026-08-08T00:00:06.000Z" });
    assert.equal(result.state.currentPhase, "terminal");
    assert.equal("outcome" in result.state.terminalTaskOutcomeRef, false);
    assert.equal(result.transitions.length, 1);
  });

  it("moves failed verification through repair before a new verifier", () => {
    const cwd = workspace();
    const current = task();
    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    current.observedChangedFiles = ["src/a.ts"];
    const runtime = new TrajectoryRuntime();
    let result = runtime.sync(cwd, "s1", current, { sourceHook: "tool-result", observedAt: "2026-08-08T00:00:01.000Z" });
    assert.equal(result.state.currentPhase, "execute");
    current.verifyEvidence = [{ command: current.verifyCommands[0], exitCode: 1, observed: true, recordedAt: "2026-08-08T00:00:02.000Z" }];
    result = runtime.sync(cwd, "s1", current, { sourceHook: "tool-result", observedAt: "2026-08-08T00:00:02.000Z" });
    assert.equal(result.state.currentPhase, "repair");
    result = runtime.syncToolCall(cwd, "s1", current, { toolName: "bash", input: { command: current.verifyCommands[0] } }, "2026-08-08T00:00:03.000Z");
    assert.equal(result.state.currentPhase, "verify");
  });

  it("keeps non-source recovery failures out of the repair mutation phase", () => {
    const cwd = workspace();
    const current = task();
    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    current.observedChangedFiles = ["src/a.ts"];
    const runtime = new TrajectoryRuntime();
    let result = runtime.sync(cwd, "s1", current, { sourceHook: "tool-result", observedAt: "2026-08-08T00:00:01.000Z" });
    assert.equal(result.state.currentPhase, "execute");
    result = runtime.syncToolCall(cwd, "s1", current, { toolName: "bash", input: { command: current.verifyCommands[0] } }, "2026-08-08T00:00:02.000Z");
    assert.equal(result.state.currentPhase, "verify");
    current.verifyEvidence = [{ command: current.verifyCommands[0], exitCode: 1, observed: true, recordedAt: "2026-08-08T00:00:03.000Z" }];
    result = runtime.sync(cwd, "s1", current, { sourceHook: "tool-result", recoveryMutationAllowed: false, observedAt: "2026-08-08T00:00:03.000Z" });
    assert.equal(result.state.currentPhase, "verify");
    assert.equal(result.transitions.some((event) => event.to === "repair"), false);
  });

  it("enters repair for an explicit policy-approved recovery after passing verification", () => {
    const cwd = workspace();
    const current = task();
    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    current.observedChangedFiles = ["src/a.ts"];
    const runtime = new TrajectoryRuntime();
    let result = runtime.sync(cwd, "s1", current, { sourceHook: "tool-result", observedAt: "2026-08-08T00:00:01.000Z" });
    assert.equal(result.state.currentPhase, "execute");
    result = runtime.syncToolCall(cwd, "s1", current, { toolName: "bash", input: { command: current.verifyCommands[0] } }, "2026-08-08T00:00:02.000Z");
    assert.equal(result.state.currentPhase, "verify");
    current.verifyEvidence = [{
      command: current.verifyCommands[0],
      exitCode: 0,
      observed: true,
      matchedProfileCommand: true,
      recordedAt: "2026-08-08T00:00:02.500Z"
    }];

    result = runtime.sync(cwd, "s1", current, {
      sourceHook: "completion",
      recoveryRequested: true,
      recoveryMutationAllowed: false,
      observedAt: "2026-08-08T00:00:03.000Z"
    });
    assert.equal(result.state.currentPhase, "verify", "an unapproved request cannot grant repair mutation");

    result = runtime.sync(cwd, "s1", current, {
      sourceHook: "completion",
      recoveryRequested: true,
      recoveryMutationAllowed: true,
      observedAt: "2026-08-08T00:00:04.000Z"
    });
    assert.equal(result.state.currentPhase, "repair");
    assert.equal(result.transitions.at(-1)?.cause, "recovery-requested");

    result = runtime.sync(cwd, "s1", current, {
      sourceHook: "agent-start",
      recoveryMutationAllowed: true,
      observedAt: "2026-08-08T00:00:05.000Z"
    });
    assert.equal(result.state.currentPhase, "repair", "pre-repair verifier evidence cannot close the repair phase");
    result = runtime.syncToolCall(cwd, "s1", current, { toolName: "bash", input: { command: current.verifyCommands[0] } }, "2026-08-08T00:00:06.000Z");
    assert.equal(result.state.currentPhase, "verify");
  });

  it("disables enforcement on corrupt or symlinked state instead of guessing", () => {
    const cwd = workspace();
    const current = task();
    const stateFile = trajectoryStatePath(cwd, current.taskRunId);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{broken\n");
    const corrupt = new TrajectoryRuntime().sync(cwd, "s1", current, { sourceHook: "session-start" });
    assert.equal(corrupt.status, "corrupt");
    assert.equal(corrupt.enforcementSafe, false);
    assert.ok(corrupt.warnings.length > 0);

    const unsafe = workspace();
    fs.mkdirSync(path.join(unsafe, ".pi", "piagent-state"), { recursive: true });
    fs.symlinkSync(workspace(), path.join(unsafe, ".pi", "piagent-state", "trajectory"));
    const symlinked = new TrajectoryRuntime().sync(unsafe, "s1", current, { sourceHook: "session-start" });
    assert.equal(symlinked.enforcementSafe, false);
  });
});

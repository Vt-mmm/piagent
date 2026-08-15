import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  WEBUI_FIXTURE_ROOT,
  createWebUiSchemaRegistry,
  readJson,
  validateFixture
} from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();

function baseSnapshot() {
  return readJson(path.join(WEBUI_FIXTURE_ROOT, "snapshot-v1.valid.json"));
}

function expectValid(value) {
  const result = validateFixture(registry, "snapshot-v1", value);
  assert.equal(result.valid, true, result.errors);
}

function expectInvalid(value, label) {
  const result = validateFixture(registry, "snapshot-v1", value);
  assert.equal(result.valid, false, `snapshot accepted ${label}`);
}

function activeTaskSnapshot() {
  const value = baseSnapshot();
  value.identity.taskId = "task-01";
  value.identity.taskRunId = "task-01-run-01";
  value.revision.taskRevision = "task_rev_01";
  value.revision.controlRevision = "control_rev_01";
  value.session.taskOutcome = "pending";
  value.session.controlState = "active";
  value.session.verificationState = "not-run";
  value.task = {
    taskId: "task-01",
    taskRunId: "task-01-run-01",
    summary: "Exercise canonical snapshot axes.",
    changeMode: "source-change",
    riskLane: "low-risk",
    outcome: "pending",
    controlState: "active",
    criteria: [],
    workPlan: [],
    scope: ["schemas/piagent-webui/**"],
    outOfScope: ["remote access"],
    progress: { completed: 0, total: 1, percent: 0 },
    blocker: null,
    reasonCode: null
  };
  value.verification.state = "not-run";
  value.verification.reasonCode = null;
  value.continuation = {
    state: "available",
    consumed: 0,
    maximum: 3,
    remaining: 3,
    reservationRef: null,
    reasonCode: null
  };
  return value;
}

describe("Piagent WebUI snapshot semantics", () => {
  it("binds every source slot to its canonical view", () => {
    const value = baseSnapshot();
    expectValid(value);
    const swapped = structuredClone(value);
    [swapped.sourceChanges.task, swapped.sourceChanges.workingTree] = [
      swapped.sourceChanges.workingTree,
      swapped.sourceChanges.task
    ];
    expectInvalid(swapped, "permuted source tabs");
  });

  it("keeps session and task outcome/control axes identical", () => {
    const value = activeTaskSnapshot();
    expectValid(value);

    const outcomeMismatch = structuredClone(value);
    outcomeMismatch.session.taskOutcome = "failed";
    expectInvalid(outcomeMismatch, "mismatched task outcome");

    const controlMismatch = structuredClone(value);
    controlMismatch.session.controlState = "paused";
    expectInvalid(controlMismatch, "mismatched task control state");

    const terminal = structuredClone(value);
    terminal.task.outcome = "completed";
    terminal.session.taskOutcome = "completed";
    terminal.task.controlState = "terminal";
    terminal.session.controlState = "terminal";
    expectValid(terminal);

    terminal.session.controlState = "active";
    expectInvalid(terminal, "non-terminal control state for terminal task");
  });

  it("does not project current verification without exact current evidence", () => {
    const value = baseSnapshot();
    value.session.verificationState = "current";
    value.verification.state = "current";
    value.verification.reasonCode = null;
    value.verification.latest = null;
    expectInvalid(value, "current verifier without an attempt");

    const mismatch = baseSnapshot();
    mismatch.session.verificationState = "not-run";
    expectInvalid(mismatch, "session/verifier state mismatch");
  });

  it("uses the shared operation-phase vocabulary", () => {
    const value = baseSnapshot();
    value.session.operation.hostPhase = {
      state: "known",
      value: "compaction",
      evidence: "observed",
      reasonCode: null
    };
    expectValid(value);
    value.session.operation.hostPhase.value = "compacting";
    expectInvalid(value, "legacy lossy host phase");

    value.session.operation.hostPhase.value = "unknown";
    expectInvalid(value, "known host phase claiming unknown value");
  });

  it("does not invent source counts or a task source without a task", () => {
    const value = baseSnapshot();
    value.sourceChanges.task.state = "ready";
    value.sourceChanges.task.revision = "task_source_rev_01";
    value.sourceChanges.task.health = { state: "ok", reasonCode: null, message: null };
    expectInvalid(value, "ready task source without a task");

    const invented = baseSnapshot();
    invented.sourceChanges.task.counts.files = 1;
    invented.sourceChanges.task.counts.modified = 1;
    expectInvalid(invented, "unavailable source with concrete counts");

    const badHealth = baseSnapshot();
    badHealth.sourceChanges.task.health = { state: "ok", reasonCode: null, message: null };
    expectInvalid(badHealth, "unavailable source with OK health");
  });

  it("synchronizes session approval state with bounded approval summaries", () => {
    const value = baseSnapshot();
    value.session.approvalState = "waiting";
    value.approvals.state = "waiting";
    value.approvals.pending = [{
      approvalRef: "approval_01",
      state: "waiting",
      resolution: null,
      actionSummary: "Write the reviewed file",
      toolCallId: "tool_01",
      expiresAt: "2026-08-13T09:10:00.000Z",
      reasonCode: null
    }];
    expectValid(value);

    const mismatched = structuredClone(value);
    mismatched.session.approvalState = "none";
    expectInvalid(mismatched, "session approval state mismatch");

    const resolvedPending = structuredClone(value);
    resolvedPending.approvals.pending[0].resolution = "allow";
    expectInvalid(resolvedPending, "resolved item in pending approvals");

    const missingTool = structuredClone(value);
    missingTool.approvals.pending[0].toolCallId = null;
    expectInvalid(missingTool, "pending approval without exact tool identity");
  });
});

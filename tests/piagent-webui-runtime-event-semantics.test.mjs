import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  WEBUI_FIXTURE_ROOT,
  WEBUI_SCHEMA_ROOT,
  createWebUiSchemaRegistry,
  formatSchemaErrors,
  readJson
} from "./helpers/piagent-webui-schema-registry.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const TREE_DIGEST = `wt-content-v2:${"b".repeat(64)}`;
const OPERATION_PHASES = [
  "idle",
  "input-preflight",
  "model",
  "tool-preflight",
  "waiting-approval",
  "tool",
  "retry",
  "compaction",
  "branch-summary",
  "direct-bash",
  "settling",
  "other",
  "unknown"
];

const registry = createWebUiSchemaRegistry();
const validate = registry.validators.get("runtime-event-v2");
const baseEvent = readJson(path.join(WEBUI_FIXTURE_ROOT, "runtime-event-v2.valid.json"));

function clone(value) {
  return structuredClone(value);
}

function event(kind, payload, identity = {}) {
  return {
    ...clone(baseEvent),
    ...identity,
    kind,
    payload
  };
}

function expectValid(value, context) {
  assert.equal(validate(value), true, `${context}: ${formatSchemaErrors(validate)}`);
}

function expectInvalid(value, context) {
  assert.equal(validate(value), false, `${context} unexpectedly validated`);
}

function runtimePhasePayload(factState, phase, operationState, reasonCode) {
  return { factState, phase, operationState, reasonCode };
}

function sourcePayload(projection) {
  return {
    repoRef: "repo_01",
    projection,
    changeSetDigest: DIGEST,
    changedFileRefs: [],
    additions: 0,
    deletions: 0,
    truncated: false
  };
}

function approvalRequestedEvent(identity = {}) {
  const value = event(
    "approval.requested",
    {
      state: "requested",
      actionDigest: DIGEST,
      actionSummary: "Write the reviewed file",
      decision: null,
      expiresAt: "2026-08-13T09:10:00.000Z",
      resolutionCode: null
    },
    {
      taskId: "task_01",
      taskRunId: "task_run_01",
      agentOperationId: "operation_01",
      toolCallId: "tool_call_01",
      ...identity
    }
  );
  value.correlation.approvalRequestId = "approval_01";
  return value;
}

function activityPayload(activityType) {
  return {
    state: "started",
    activityType,
    activityRef: "activity_01",
    toolName: activityType === "tool" ? "read_file" : null,
    inputDigest: null,
    outputDigest: null,
    preview: null,
    previewKind: "none",
    outputBytes: null,
    outputLines: null,
    exitCode: null,
    isError: null,
    affectedFileRefs: [],
    criterionIds: [],
    verifierAttemptIds: [],
    reasonCode: null
  };
}

test("runtime event identities preserve hierarchy and family ownership", () => {
  const orphanRun = clone(baseEvent);
  orphanRun.taskRunId = "task_run_01";
  expectInvalid(orphanRun, "taskRunId without taskId");

  const orphanTurn = clone(baseEvent);
  orphanTurn.turnIndex = 0;
  expectInvalid(orphanTurn, "turnIndex without agentOperationId");

  const orphanTool = clone(baseEvent);
  orphanTool.toolCallId = "tool_call_01";
  expectInvalid(orphanTool, "toolCallId without agentOperationId");

  const message = event(
    "message.text-delta",
    {
      role: "assistant",
      contentIndex: 0,
      chunkSequence: 0,
      delta: "hello",
      deltaDigest: DIGEST
    },
    {
      agentOperationId: "operation_01",
      turnIndex: 0,
      messageRef: "message_01"
    }
  );
  expectValid(message, "fully identified message event");

  const messageWithoutTurn = clone(message);
  messageWithoutTurn.turnIndex = null;
  expectInvalid(messageWithoutTurn, "message event without turnIndex");

  const approval = approvalRequestedEvent();
  expectValid(approval, "fully identified approval event");

  const approvalWithoutTask = approvalRequestedEvent({ taskId: null, taskRunId: null });
  expectInvalid(approvalWithoutTask, "approval event without task identity");

  const toolActivity = event("activity.started", activityPayload("tool"), {
    agentOperationId: "operation_01",
    toolCallId: "tool_call_01"
  });
  expectValid(toolActivity, "fully identified tool activity");

  const toolActivityWithoutCall = clone(toolActivity);
  toolActivityWithoutCall.toolCallId = null;
  expectInvalid(toolActivityWithoutCall, "tool activity without toolCallId");
});

test("runtime phase facts use the shared lossless vocabulary and fail closed", () => {
  const common = readJson(path.join(WEBUI_SCHEMA_ROOT, "common-v1.schema.json"));
  const capabilities = readJson(path.join(WEBUI_SCHEMA_ROOT, "capabilities-v1.schema.json"));
  const snapshot = readJson(path.join(WEBUI_SCHEMA_ROOT, "snapshot-v1.schema.json"));
  const runtimeEvent = readJson(path.join(WEBUI_SCHEMA_ROOT, "runtime-event-v2.schema.json"));
  const operationPhaseRef = "common-v1.schema.json#/$defs/operationPhase";

  assert.deepEqual(common.$defs.operationPhase.enum, OPERATION_PHASES);
  assert.equal(capabilities.$defs.operationPhase.$ref, operationPhaseRef);
  assert.equal(snapshot.$defs.hostPhaseFact.properties.value.anyOf[0].$ref, operationPhaseRef);
  assert.equal(runtimeEvent.$defs.runtimePhaseChangedPayload.properties.phase.$ref, operationPhaseRef);

  for (const phase of OPERATION_PHASES.filter((value) => value !== "unknown")) {
    const operationState = phase === "idle" ? "idle" : "running";
    expectValid(
      event("runtime.phase-changed", runtimePhasePayload("known", phase, operationState, null)),
      `known ${phase} phase`
    );
  }

  for (const stalePhase of ["model-stream", "tool-running", "retry-wait", "compacting", "direct-command"]) {
    expectInvalid(
      event("runtime.phase-changed", runtimePhasePayload("known", stalePhase, "running", null)),
      `stale phase ${stalePhase}`
    );
  }

  for (const factState of ["unknown", "unavailable", "disconnected", "resync-required"]) {
    const unknown = event(
      "runtime.phase-changed",
      runtimePhasePayload(factState, "unknown", "unknown", "runtime-phase-unavailable")
    );
    expectValid(unknown, `${factState} runtime phase fact`);

    const concretePhase = clone(unknown);
    concretePhase.payload.phase = "model";
    expectInvalid(concretePhase, `${factState} fact with concrete phase`);

    const concreteState = clone(unknown);
    concreteState.payload.operationState = "running";
    expectInvalid(concreteState, `${factState} fact with concrete operation state`);

    const missingReason = clone(unknown);
    missingReason.payload.reasonCode = null;
    expectInvalid(missingReason, `${factState} fact without reason`);
  }

  expectInvalid(
    event("runtime.phase-changed", runtimePhasePayload("known", "unknown", "unknown", null)),
    "known runtime phase with unknown values"
  );
});

test("unknown and unavailable queues contain no invented queue facts", () => {
  for (const state of ["unknown", "unavailable"]) {
    const unknown = event("queue.changed", {
      queueKind: "aggregate",
      state,
      pendingCount: null,
      hasPending: null,
      messageRequestIds: [],
      reasonCode: "queue-state-unavailable"
    });
    expectValid(unknown, `${state} queue`);

    const withCount = clone(unknown);
    withCount.payload.pendingCount = 1;
    expectInvalid(withCount, `${state} queue with count`);

    const withBoolean = clone(unknown);
    withBoolean.payload.hasPending = true;
    expectInvalid(withBoolean, `${state} queue with boolean`);

    const withMessage = clone(unknown);
    withMessage.payload.messageRequestIds = ["message_request_01"];
    expectInvalid(withMessage, `${state} queue with message identity`);

    const withoutReason = clone(unknown);
    withoutReason.payload.reasonCode = null;
    expectInvalid(withoutReason, `${state} queue without reason`);
  }

  expectValid(
    event("queue.changed", {
      queueKind: "aggregate",
      state: "held",
      pendingCount: 1,
      hasPending: true,
      messageRequestIds: ["message_request_01"],
      reasonCode: null
    }),
    "known queue facts"
  );
});

test("task outcome terminal flag is derived from the canonical outcome", () => {
  const terminalByOutcome = new Map([
    ["pending", false],
    ["completed", true],
    ["blocked", true],
    ["partial", true],
    ["failed", true]
  ]);

  for (const [currentOutcome, terminal] of terminalByOutcome) {
    const value = event(
      "task.outcome-changed",
      {
        previousOutcome: null,
        currentOutcome,
        terminal,
        reasonCode: "task-outcome-observed",
        taskContractDigest: DIGEST
      },
      { taskId: "task_01", taskRunId: "task_run_01" }
    );
    expectValid(value, `${currentOutcome} terminal binding`);

    value.payload.terminal = !terminal;
    expectInvalid(value, `${currentOutcome} inverse terminal binding`);
  }
});

test("source change events expose only task, working-tree and staged views", () => {
  expectValid(
    event("source.changed", sourcePayload("task"), {
      taskId: "task_01",
      taskRunId: "task_run_01"
    }),
    "task source view"
  );
  expectValid(event("source.changed", sourcePayload("working-tree")), "working-tree source view");
  expectValid(event("source.changed", sourcePayload("staged")), "staged source view");

  expectInvalid(event("source.changed", sourcePayload("task")), "task source view without task identity");
  expectInvalid(event("source.changed", sourcePayload("agent-task")), "legacy agent-task source view");
  expectInvalid(event("source.changed", sourcePayload("full-working-tree")), "legacy full-working-tree source view");
});

test("settled operation and activity facts cannot report running or failed outcomes", () => {
  const stopped = event(
    "agent-operation.stop-settled",
    { result: "stopped", operationState: "settled", reasonCode: "operator-requested" },
    { agentOperationId: "operation_01" }
  );
  stopped.correlation.commandId = "command_01";
  expectValid(stopped, "settled Stop");
  stopped.payload.operationState = "running";
  expectInvalid(stopped, "stopped result with running operation");

  const finished = event("activity.finished", {
    ...activityPayload("command"),
    state: "finished",
    exitCode: 0,
    isError: false
  });
  expectValid(finished, "successful finished activity");
  finished.payload.exitCode = 1;
  finished.payload.isError = true;
  expectInvalid(finished, "finished activity carrying failure facts");
});

test("task-control events bind exact canonical transitions", () => {
  const taskControl = (kind, fact, overrides = {}) => {
    const value = event(kind, {
      action: fact.startsWith("pause") ? "pause" : fact.startsWith("continue") ? "resume-and-continue" : fact.startsWith("stop") ? "stop" : "resume",
      fact,
      fromControlState: "pause-requested",
      toControlState: "paused",
      taskOutcome: "pending",
      resultCode: fact,
      requestSequence: 2,
      parentSequence: 1,
      expectedControlRevision: "control_rev_01",
      preWorkingTreeDigest: TREE_DIGEST,
      postWorkingTreeDigest: TREE_DIGEST,
      dispatchState: "none",
      ...overrides
    }, {
      taskId: "task_01",
      taskRunId: "task_run_01"
    });
    value.correlation.commandId = "command_01";
    value.correlation.idempotencyKeyDigest = DIGEST;
    return value;
  };

  const paused = taskControl("task-control.paused", "paused", { resultCode: "paused" });
  expectValid(paused, "pause-requested to paused");
  paused.payload.toControlState = "active";
  expectInvalid(paused, "paused fact ending active");

  const resumed = taskControl("task-control.resumed", "resumed", {
    action: "resume",
    fromControlState: "paused",
    toControlState: "active",
    resultCode: "resumed"
  });
  expectValid(resumed, "paused to active resume");
  resumed.payload.taskOutcome = "completed";
  expectInvalid(resumed, "task-control event on a terminal outcome");

  const dispatched = taskControl("task-control.continue-dispatched", "continue-dispatched", {
    action: "resume-and-continue",
    fromControlState: "paused",
    toControlState: "active",
    resultCode: "dispatch-observed",
    dispatchState: "observed"
  });
  dispatched.agentOperationId = "operation_02";
  dispatched.messageRef = "message_01";
  dispatched.correlation.messageRequestId = "message_request_01";
  expectValid(dispatched, "observed continuation dispatch");
  dispatched.payload.dispatchState = "requested";
  expectInvalid(dispatched, "dispatched event without observed dispatch");

  const stop = taskControl("task-control.stop-requested", "stop-requested", {
    action: "stop",
    fromControlState: "active",
    toControlState: "active",
    resultCode: "stop-requested"
  });
  stop.agentOperationId = "operation_01";
  expectValid(stop, "operation-bound task Stop");
  stop.agentOperationId = null;
  expectInvalid(stop, "task Stop without operation identity");
});

test("a passed verifier carries exact current-tree evidence", () => {
  const passed = event("verifier.finished", {
    state: "passed",
    verifierAttemptId: "verifier_attempt_01",
    verifierRef: "verifier_01",
    displayName: "npm test",
    commandDigest: DIGEST,
    exact: true,
    exitCode: 0,
    workingTreeDigest: TREE_DIGEST,
    staleFileRefs: [],
    logPreview: "All tests passed.",
    logDigest: DIGEST,
    reasonCode: null
  }, {
    taskId: "task_01",
    taskRunId: "task_run_01"
  });
  expectValid(passed, "exact passed verifier");

  for (const mutation of [
    (value) => { value.payload.exact = false; },
    (value) => { value.payload.exitCode = null; },
    (value) => { value.payload.workingTreeDigest = null; },
    (value) => { value.payload.staleFileRefs = ["file_01"]; }
  ]) {
    const invalid = clone(passed);
    mutation(invalid);
    expectInvalid(invalid, "passed verifier without current exact evidence");
  }
});

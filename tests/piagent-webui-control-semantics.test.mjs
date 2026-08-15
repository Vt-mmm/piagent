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
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const treeDigest = `wt-content-v2:${"c".repeat(64)}`;

function clone(value) {
  return structuredClone(value);
}

function fixture() {
  return readJson(path.join(WEBUI_FIXTURE_ROOT, "control-command-v1.valid.json"));
}

function expectValid(value) {
  const result = validateFixture(registry, "control-command-v1", value);
  assert.equal(result.valid, true, result.errors);
}

function expectInvalid(value) {
  const result = validateFixture(registry, "control-command-v1", value);
  assert.equal(result.valid, false, "control schema accepted an invalid document");
}

function revisions() {
  return {
    runtimeRevision: "runtime_rev_01",
    taskRevision: "task_rev_01",
    controlRevision: "control_rev_01",
    workspaceRevision: "workspace_rev_01",
    indexRevision: "index_rev_01",
    approvalRevision: null,
    sessionOptionRevision: "session_option_rev_01",
    queueRevision: "queue_rev_01"
  };
}

function controlError(code = "operation-failed") {
  return {
    code,
    message: "The requested control operation did not settle successfully.",
    retryable: false
  };
}

function receipt(action, resultCode, phase = "settled") {
  const terminal = phase === "settled" || phase === "rejected" || phase === "uncertain";
  return {
    schemaVersion: 1,
    version: "piagent-webui-control-v1",
    messageType: "receipt",
    commandId: "command_01",
    idempotencyKeyDigest: digestA,
    action,
    actionDigest: digestB,
    identity: {
      projectRef: "project_01",
      runtimeInstanceId: "runtime_01",
      sessionRef: "session_01",
      taskId: "task-01",
      taskRunId: "task-01-run-01",
      agentOperationId: "operation_01",
      toolCallId: null
    },
    phase,
    resultCode,
    requestedAt: "2026-08-13T09:00:00.000Z",
    settledAt: terminal ? "2026-08-13T09:00:01.000Z" : null,
    observedRevisionsBefore: revisions(),
    observedRevisionsAfter: revisions(),
    deduplicated: false,
    auditRef: "audit_01",
    settlementEvidenceRef: phase === "settled" ? "settlement_01" : null,
    error: phase === "rejected" || phase === "uncertain" ? controlError() : null
  };
}

const settledResultsByAction = new Map([
  ["chat.send", "dispatch-observed"],
  ["queue.update", "updated"],
  ["queue.delete", "deleted"],
  ["queue.dispatch", "dispatch-observed"],
  ["lifecycle.stop", "stopped"],
  ["lifecycle.pause", "paused"],
  ["lifecycle.resume", "resumed"],
  ["lifecycle.resume-and-continue", "dispatch-observed"],
  ["session-options.set-model", "changed"],
  ["session-options.set-thinking", "changed"],
  ["review.mark", "reviewed"],
  ["source.stage", "staged"],
  ["source.unstage", "unstaged"],
  ["source.revert", "reverted"],
  ["source.open-in-vscode", "opened"],
  ["commit-summary.generate", "summary-generated"]
]);

function reviewCommand(action) {
  const command = fixture();
  command.action = action;
  command.capabilityScope = "reviewActions";
  command.expectedRevisions.workspaceRevision = "workspace_rev_01";
  command.expectedRevisions.indexRevision = "index_rev_01";
  command.expectedRevisions.workspacePreimage = treeDigest;
  command.expectedRevisions.indexPreimage = digestA;
  command.expectedRevisions.patchPreimage = digestB;

  if (action === "review.mark") {
    command.payload = {
      view: "task",
      fileRef: "file_01",
      diffRef: "diff_01",
      reviewState: "reviewed",
      contentDigest: digestB
    };
  } else if (action === "source.stage" || action === "source.unstage") {
    command.payload = {
      fileRef: "file_01",
      hunkRefs: ["hunk_01"],
      contentDigest: digestA
    };
  } else if (action === "source.revert") {
    command.payload = {
      fileRef: "file_01",
      hunkRefs: ["hunk_01"],
      previewRef: "preview_01",
      confirmedPreviewDigest: digestA,
      contentDigest: digestB
    };
  } else if (action === "source.open-in-vscode") {
    command.payload = { fileRef: "file_01", line: 10, column: 2 };
  } else if (action === "commit-summary.generate") {
    command.payload = { mode: "deterministic", modelTurnAcknowledged: false };
  }
  return command;
}

describe("Piagent WebUI control semantics", () => {
  it("binds every receipt result to its exact action", () => {
    for (const [action, resultCode] of settledResultsByAction) {
      expectValid(receipt(action, resultCode));

      const invalid = receipt(action, action === "commit-summary.generate" ? "staged" : "summary-generated");
      expectInvalid(invalid);
    }

    expectInvalid(receipt("lifecycle.resume", "staged"));
  });

  it("binds phase to result, settlement evidence and error", () => {
    expectValid(receipt("lifecycle.stop", "stop-requested", "requested"));
    expectValid(receipt("chat.send", "held", "accepted"));
    expectValid(receipt("lifecycle.stop", "settlement-unknown", "uncertain"));
    expectValid(receipt("source.stage", "effect-unknown", "uncertain"));
    expectValid(receipt("lifecycle.resume", "invalid-command", "rejected"));

    const settledWithoutEvidence = receipt("lifecycle.resume", "resumed");
    settledWithoutEvidence.settlementEvidenceRef = null;
    expectInvalid(settledWithoutEvidence);

    const settledWithError = receipt("session-options.set-model", "changed");
    settledWithError.error = controlError();
    expectInvalid(settledWithError);

    const settledInvalidCommand = receipt("lifecycle.resume", "invalid-command");
    settledInvalidCommand.settledAt = null;
    settledInvalidCommand.error = null;
    expectInvalid(settledInvalidCommand);

    const acceptedChanged = receipt("session-options.set-model", "changed", "accepted");
    acceptedChanged.error = controlError();
    expectInvalid(acceptedChanged);

    const rejectedWithoutError = receipt("lifecycle.resume", "invalid-command", "rejected");
    rejectedWithoutError.error = null;
    expectInvalid(rejectedWithoutError);
  });

  it("requires Stop to identify the exact current agent operation", () => {
    const stop = fixture();
    stop.action = "lifecycle.stop";
    stop.payload = { requestedScope: "current-agent-operation" };
    stop.identity.agentOperationId = "operation_01";
    expectValid(stop);

    stop.identity.agentOperationId = null;
    expectInvalid(stop);

    const stopReceipt = receipt("lifecycle.stop", "stopped");
    stopReceipt.identity.agentOperationId = null;
    expectInvalid(stopReceipt);
  });

  it("uses the dedicated Resume & Continue capability scope", () => {
    const command = fixture();
    command.action = "lifecycle.resume-and-continue";
    command.capabilityScope = "control.resumeAndContinue";
    command.expectedRevisions.queueRevision = "queue_rev_01";
    command.payload = {
      messageRequestId: "message_request_01",
      capabilityAction: "send",
      delivery: "new-operation",
      text: "Continue from the verified checkpoint.",
      attachmentRefs: [],
      contentDigest: digestA
    };
    expectValid(command);

    command.capabilityScope = "control.lifecycle";
    expectInvalid(command);
  });

  it("requires task-revision CAS for every review action", () => {
    for (const action of [
      "review.mark",
      "source.stage",
      "source.unstage",
      "source.revert",
      "source.open-in-vscode",
      "commit-summary.generate"
    ]) {
      const command = reviewCommand(action);
      expectValid(command);
      const taskless = clone(command);
      taskless.identity.taskId = null;
      taskless.identity.taskRunId = null;
      expectInvalid(taskless);
      command.expectedRevisions.taskRevision = null;
      expectInvalid(command);
    }

    const modelSummary = reviewCommand("commit-summary.generate");
    modelSummary.payload = { mode: "model", modelTurnAcknowledged: true };
    expectValid(modelSummary);
    modelSummary.payload.modelTurnAcknowledged = false;
    expectInvalid(modelSummary);
  });

  it("binds interrupt-and-send to the exact operation and control revision", () => {
    const command = fixture();
    command.action = "chat.send";
    command.capabilityScope = "control.chat";
    command.identity.agentOperationId = "operation_01";
    command.expectedRevisions.queueRevision = "queue_rev_01";
    command.expectedRevisions.controlRevision = "control_rev_01";
    command.payload = {
      messageRequestId: "message_request_01",
      capabilityAction: "interruptAndSend",
      delivery: "steer",
      text: "Stop the current response and use this correction.",
      attachmentRefs: [],
      contentDigest: digestA
    };
    expectValid(command);

    const orphan = clone(command);
    orphan.identity.agentOperationId = null;
    expectInvalid(orphan);

    const noControlCas = clone(command);
    noControlCas.expectedRevisions.controlRevision = null;
    expectInvalid(noControlCas);

    const smuggled = clone(command);
    smuggled.payload.capabilityAction = "send";
    expectInvalid(smuggled);
  });

  it("binds task and operation identity on authoritative receipts", () => {
    for (const action of [
      "lifecycle.pause",
      "lifecycle.resume",
      "lifecycle.resume-and-continue",
      "review.mark",
      "source.stage",
      "source.unstage",
      "source.revert",
      "source.open-in-vscode",
      "commit-summary.generate"
    ]) {
      const resultCode = settledResultsByAction.get(action);
      const value = receipt(action, resultCode);
      value.identity.taskId = null;
      value.identity.taskRunId = null;
      expectInvalid(value);
    }

    const dispatched = receipt("chat.send", "dispatch-observed");
    dispatched.identity.agentOperationId = null;
    expectInvalid(dispatched);
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  WEBUI_FIXTURE_ROOT,
  createWebUiSchemaRegistry,
  validateFixture
} from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const operationPhases = [
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
const reviewActionKeys = [
  "reviewMark",
  "stage",
  "unstage",
  "revert",
  "openInVsCode",
  "generateCommitSummaryDeterministic",
  "generateCommitSummaryModel"
];

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(WEBUI_FIXTURE_ROOT, `${name}.valid.json`), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function expectValid(name, value) {
  const result = validateFixture(registry, name, value);
  assert.equal(result.valid, true, `${name} unexpectedly rejected: ${result.errors}`);
}

function expectInvalid(name, value) {
  const result = validateFixture(registry, name, value);
  assert.equal(result.valid, false, `${name} accepted an authority-unsafe document`);
}

function availability(available, reasonCode = "not-proven") {
  return available
    ? { available: true, reasonCode: null }
    : { available: false, reasonCode };
}

function unavailableCapability(code = "not-proven") {
  return {
    status: "unavailable",
    version: null,
    reason: { code, message: "The capability is unavailable." }
  };
}

function chatCapability(send = true) {
  return {
    status: "available",
    version: 1,
    reason: null,
    queuePersistence: "runtime-restart-revalidation",
    actions: {
      send: availability(send),
      hold: availability(true),
      editHeld: availability(true),
      deleteHeld: availability(true),
      dispatchHeld: availability(true),
      interruptAndSend: availability(false)
    }
  };
}

function stopPhaseSupport() {
  return Object.fromEntries(operationPhases.map((phase) => [
    phase,
    { stop: "supported", reasonCode: null }
  ]));
}

function lifecycleCapability(resume = true) {
  return {
    status: "available",
    version: 1,
    reason: null,
    currentPhase: "model",
    actions: {
      pause: availability(true),
      resume: availability(resume)
    },
    stopPhaseSupport: stopPhaseSupport()
  };
}

function compoundControlHandshake() {
  const value = fixture("capabilities-v1");
  value.mode = "control-enabled";
  value.capabilities["control.chat"] = chatCapability(true);
  value.capabilities["control.lifecycle"] = lifecycleCapability(true);
  value.capabilities["control.resumeAndContinue"] = {
    status: "available",
    version: 1,
    reason: null,
    delivery: "new-operation",
    requires: ["control.lifecycle", "control.chat"]
  };
  return value;
}

function treePrecondition(indexRevision = null) {
  return {
    workspaceRevision: "workspace_rev_01",
    indexRevision,
    preimageDigest: `sha256:${"d".repeat(64)}`
  };
}

describe("Piagent WebUI authority semantics", () => {
  it("enforces the canonical identity hierarchy and non-ok health reasons", () => {
    const handshake = fixture("capabilities-v1");

    const orphanTaskRun = clone(handshake);
    orphanTaskRun.identity.taskRunId = "task-run-orphan";
    expectInvalid("capabilities-v1", orphanTaskRun);

    const orphanToolCall = clone(handshake);
    orphanToolCall.identity.toolCallId = "tool_call_orphan";
    expectInvalid("capabilities-v1", orphanToolCall);

    const snapshot = fixture("snapshot-v1");
    snapshot.activity.health = {
      state: "unknown",
      reasonCode: null,
      message: null
    };
    expectInvalid("snapshot-v1", snapshot);

    snapshot.activity.health.reasonCode = "collector-state-unknown";
    expectValid("snapshot-v1", snapshot);
  });

  it("uses one lossless operation-phase vocabulary and one Stop verdict per phase", () => {
    const common = registry.documents.find(({ entry }) => entry.name === "common-v1").schema;
    const capabilities = registry.documents.find(({ entry }) => entry.name === "capabilities-v1").schema;
    assert.deepEqual(common.$defs.operationPhase.enum, operationPhases);
    assert.equal(capabilities.$defs.operationPhase.$ref, "common-v1.schema.json#/$defs/operationPhase");
    assert.equal(capabilities.$defs.availableLifecycleCapability.properties.stopPhaseSupport.type, "object");
    assert.equal(capabilities.$defs.availableLifecycleCapability.properties.stopPhaseSupport.additionalProperties, false);
    assert.deepEqual(
      capabilities.$defs.availableLifecycleCapability.properties.stopPhaseSupport.required,
      operationPhases
    );

    const handshake = compoundControlHandshake();
    expectValid("capabilities-v1", handshake);

    const globalStopClaim = clone(handshake);
    globalStopClaim.capabilities["control.lifecycle"].actions.stop = availability(true);
    expectInvalid("capabilities-v1", globalStopClaim);

    const missingPhaseVerdict = clone(handshake);
    delete missingPhaseVerdict.capabilities["control.lifecycle"].stopPhaseSupport.unknown;
    expectInvalid("capabilities-v1", missingPhaseVerdict);

    const contradictoryArray = clone(handshake);
    contradictoryArray.capabilities["control.lifecycle"].stopPhaseSupport = [
      { phase: "model", stop: "supported", reasonCode: null },
      { phase: "model", stop: "unsupported", reasonCode: "unsafe-phase" }
    ];
    expectInvalid("capabilities-v1", contradictoryArray);
  });

  it("advertises resume-and-continue only when both lifecycle and chat proofs hold", () => {
    const inspectOnly = fixture("capabilities-v1");
    assert.equal(inspectOnly.capabilities["control.resumeAndContinue"].status, "unavailable");
    expectValid("capabilities-v1", inspectOnly);

    const missingCompound = clone(inspectOnly);
    delete missingCompound.capabilities["control.resumeAndContinue"];
    expectInvalid("capabilities-v1", missingCompound);

    const valid = compoundControlHandshake();
    expectValid("capabilities-v1", valid);

    const chatUnavailable = clone(valid);
    chatUnavailable.capabilities["control.chat"] = unavailableCapability("chat-unavailable");
    expectInvalid("capabilities-v1", chatUnavailable);

    const sendUnavailable = clone(valid);
    sendUnavailable.capabilities["control.chat"].actions.send = availability(false, "send-unavailable");
    expectValid("capabilities-v1", sendUnavailable);

    const resumeUnavailable = clone(valid);
    resumeUnavailable.capabilities["control.lifecycle"].actions.resume = availability(false, "resume-unavailable");
    expectInvalid("capabilities-v1", resumeUnavailable);
  });

  it("advertises every review action explicitly, including both commit-summary modes", () => {
    const value = fixture("capabilities-v1");
    value.mode = "control-enabled";
    value.capabilities.reviewActions = {
      status: "available",
      version: 1,
      reason: null,
      actions: Object.fromEntries(reviewActionKeys.map((key) => [key, availability(true)]))
    };
    expectValid("capabilities-v1", value);

    const capabilities = registry.documents.find(({ entry }) => entry.name === "capabilities-v1").schema;
    assert.deepEqual(
      Object.keys(capabilities.$defs.availableReviewActionsCapability.properties.actions.properties),
      reviewActionKeys
    );

    for (const key of reviewActionKeys) {
      const missing = clone(value);
      delete missing.capabilities.reviewActions.actions[key];
      expectInvalid("capabilities-v1", missing);
    }

    const invented = clone(value);
    invented.capabilities.reviewActions.actions.autoCommit = availability(true);
    expectInvalid("capabilities-v1", invented);
  });

  it("fails closed when compatibility is incompatible or requires resync", () => {
    for (const state of ["incompatible", "resync-required"]) {
      const unsafe = compoundControlHandshake();
      unsafe.compatibility = {
        state,
        reason: { code: state, message: "Authority compatibility is not proven." }
      };
      expectInvalid("capabilities-v1", unsafe);

      const inspectOnly = fixture("capabilities-v1");
      inspectOnly.compatibility = {
        state,
        reason: { code: state, message: "Authority compatibility is not proven." }
      };
      expectValid("capabilities-v1", inspectOnly);

      const unavailable = clone(inspectOnly);
      unavailable.mode = "unavailable";
      unavailable.capabilities.inspect = unavailableCapability("inspect-unavailable");
      expectValid("capabilities-v1", unavailable);
    }
  });

  it("binds approval action class to required tree and index preconditions", () => {
    const external = fixture("approval-v1");
    expectValid("approval-v1", external);

    const inventedKind = clone(external);
    inventedKind.action.kind = "arbitrary-destructive-action";
    expectInvalid("approval-v1", inventedKind);

    const mismatchedClass = clone(external);
    mismatchedClass.action.preconditionClass = "workspace-tree";
    mismatchedClass.expectedRevisions.treePrecondition = treePrecondition();
    expectInvalid("approval-v1", mismatchedClass);

    const revertWithoutTreeCas = clone(external);
    revertWithoutTreeCas.action.kind = "source-revert";
    revertWithoutTreeCas.action.preconditionClass = "workspace-tree";
    expectInvalid("approval-v1", revertWithoutTreeCas);

    const revert = clone(revertWithoutTreeCas);
    revert.expectedRevisions.treePrecondition = treePrecondition();
    expectValid("approval-v1", revert);

    const stageWithoutIndexCas = clone(external);
    stageWithoutIndexCas.action.kind = "source-stage";
    stageWithoutIndexCas.action.preconditionClass = "workspace-index";
    stageWithoutIndexCas.expectedRevisions.treePrecondition = treePrecondition();
    expectInvalid("approval-v1", stageWithoutIndexCas);

    stageWithoutIndexCas.expectedRevisions.treePrecondition.indexRevision = "index_rev_01";
    expectValid("approval-v1", stageWithoutIndexCas);
  });

  it("requires informed approval targets or explicit redaction", () => {
    const request = fixture("approval-v1");

    const missingExternalAuthority = clone(request);
    missingExternalAuthority.action.providerRef = null;
    missingExternalAuthority.action.urlOrigin = null;
    expectInvalid("approval-v1", missingExternalAuthority);

    const emptyTarget = clone(request);
    emptyTarget.action.targetRefs = [];
    emptyTarget.action.targetPaths = [];
    emptyTarget.action.targetSummaries = [];
    expectInvalid("approval-v1", emptyTarget);

    emptyTarget.action.targetEvidence = {
      state: "redacted",
      reasonCode: "protected-target"
    };
    expectValid("approval-v1", emptyTarget);

    emptyTarget.action.targetRefs = ["smuggled_target"];
    expectInvalid("approval-v1", emptyTarget);
  });
});

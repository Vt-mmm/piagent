import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  WEBUI_FIXTURE_ROOT,
  WEBUI_SCHEMA_ROOT,
  catalogDocuments,
  createWebUiSchemaRegistry,
  externalSchemaRefs,
  readJson,
  readWebUiSchemaCatalog,
  validateFixture
} from "./helpers/piagent-webui-schema-registry.mjs";

const authorityContracts = [
  "attachment-v1",
  "control-command-v1",
  "approval-v1",
  "session-command-v1"
];
const primaryContracts = [
  "snapshot-v1",
  "runtime-event-v2",
  "source-change-v1",
      "diff-v1",
      "review-state-v1",
      "source-mutation-v1",
      "source-revert-v1",
      "commit-summary-v1",
      "task-index-v1",
      "task-timeline-v1",
      "recovery-history-v1",
      "handoff-history-v1",
      "subagent-tree-v1",
      "release-monitor-v1",
      "transcript-v1",
  "queue-v1",
  "model-catalog-v1",
  "attachment-v1",
  "control-command-v1",
  "approval-v1",
  "capabilities-v1",
  "session-catalog-v1",
  "session-command-v1",
  "gateway-capabilities-v1",
  "gateway-protocol-v1"
];

function fixture(name, state = "valid") {
  return readJson(path.join(WEBUI_FIXTURE_ROOT, `${name}.${state}.json`));
}

function clone(value) {
  return structuredClone(value);
}

function expectValid(registry, name, value) {
  const result = validateFixture(registry, name, value);
  assert.equal(result.valid, true, `${name} rejected a valid document: ${result.errors}`);
}

function expectInvalid(registry, name, value) {
  const result = validateFixture(registry, name, value);
  assert.equal(result.valid, false, `${name} accepted an invalid document`);
}

function propertyNames(value, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => propertyNames(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (value.properties && typeof value.properties === "object") {
    Object.keys(value.properties).forEach((name) => output.add(name));
  }
  Object.values(value).forEach((item) => propertyNames(item, output));
  return output;
}

function unboundedValues(value, currentPath = "", result = { arrays: [], strings: [] }) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => unboundedValues(item, `${currentPath}/${index}`, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  const types = Array.isArray(value.type) ? value.type : [value.type];
  const conditional = /\/(?:allOf|anyOf|oneOf|if|then|else)\//.test(currentPath);
  if (types.includes("array") && value.maxItems === undefined && !conditional) result.arrays.push(currentPath);
  if (
    types.includes("string")
    && value.maxLength === undefined
    && value.pattern === undefined
    && value.const === undefined
    && value.enum === undefined
    && !conditional
  ) result.strings.push(currentPath);
  Object.entries(value).forEach(([key, item]) => unboundedValues(item, `${currentPath}/${key}`, result));
  return result;
}

function domainRevision(overrides = {}) {
  return {
    runtimeRevision: "runtime_rev_01",
    taskRevision: "task_rev_01",
    controlRevision: "control_rev_01",
    workspaceRevision: "workspace_rev_01",
    indexRevision: "index_rev_01",
    approvalRevision: "approval_rev_01",
    sessionOptionRevision: "session_option_rev_01",
    queueRevision: "queue_rev_01",
    ...overrides
  };
}

describe("Piagent WebUI wire schemas", () => {
  it("uses one complete local catalog and compiles every document in strict draft-2020-12 mode", () => {
    const catalog = readWebUiSchemaCatalog();
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.catalogVersion, "piagent-webui-schema-catalog-v1");
    assert.deepEqual(catalog.documents.map((entry) => entry.name), ["common-v1", ...primaryContracts]);

    const actualFiles = fs.readdirSync(WEBUI_SCHEMA_ROOT)
      .filter((file) => file.endsWith(".schema.json"))
      .sort();
    assert.deepEqual(actualFiles, catalog.documents.map((entry) => entry.file).sort());

    const documents = catalogDocuments();
    const ids = documents.map(({ schema }) => schema.$id);
    assert.equal(new Set(ids).size, ids.length);
    for (const { entry, schema } of documents) {
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(schema.$id, entry.id);
      assert.equal(schema.$id, `https://piagent.io.vn/schemas/piagent-webui/${entry.file}`);
      assert.match(entry.file, new RegExp(`-v${entry.documentVersion}\\.schema\\.json$`));
      for (const ref of externalSchemaRefs(schema)) {
        assert.ok(ids.includes(ref), `${entry.file} references an unregistered or remote schema: ${ref}`);
      }
    }

    const registry = createWebUiSchemaRegistry();
    assert.equal(registry.validators.size, catalog.documents.length);
  });

  it("has catalog-backed valid and invalid golden fixtures for every public wire document", () => {
    const registry = createWebUiSchemaRegistry();
    for (const name of primaryContracts) {
      const validFile = path.join(WEBUI_FIXTURE_ROOT, `${name}.valid.json`);
      const invalidFile = path.join(WEBUI_FIXTURE_ROOT, `${name}.invalid.json`);
      assert.equal(fs.existsSync(validFile), true, `missing valid fixture: ${name}`);
      assert.equal(fs.existsSync(invalidFile), true, `missing invalid fixture: ${name}`);
      expectValid(registry, name, fixture(name));
      expectInvalid(registry, name, fixture(name, "invalid"));
    }
  });

  it("bounds wire collections and text while keeping authority objects closed", () => {
    const documents = catalogDocuments();
    for (const { entry, schema } of documents) {
      const unbounded = unboundedValues(schema);
      assert.deepEqual(unbounded.arrays, [], `${entry.file} has unbounded arrays`);
      assert.deepEqual(unbounded.strings, [], `${entry.file} has unbounded strings`);
    }

    const registry = createWebUiSchemaRegistry();
    for (const name of authorityContracts) {
      const schema = registry.documents.find(({ entry }) => entry.name === name).schema;
      const variants = name === "control-command-v1" ? [schema.$defs.command, schema.$defs.receipt]
        : name === "attachment-v1" ? [schema.$defs.stageCommand, schema.$defs.discardCommand, schema.$defs.stageReceipt, schema.$defs.discardReceipt]
          : name === "session-command-v1" ? [schema.$defs.baseCommandProperties, schema.$defs.receipt]
            : [schema.$defs.approvalRequest, schema.$defs.approvalDecision, schema.$defs.approvalReceipt];
      variants.forEach((variant) => assert.equal(variant.additionalProperties, false));
    }

    const event = registry.documents.find(({ entry }) => entry.name === "runtime-event-v2").schema;
    const payloads = Object.entries(event.$defs).filter(([name]) => name.endsWith("Payload"));
    assert.ok(payloads.length >= 40);
    payloads.forEach(([name, payload]) => assert.equal(payload.additionalProperties, false, `${name} is open`));
  });

  it("does not expose raw session/filesystem/provider authority fields", () => {
    const forbidden = new Set([
      "sessionId",
      "sessionFile",
      "sessionDir",
      "parentSession",
      "previousSessionFile",
      "targetSessionFile",
      "baseUrl",
      "headers",
      "samplingParams",
      "textSignature",
      "thinkingSignature",
      "thoughtSignature",
      "responseId",
      "fullOutputPath",
      "rawToolArgs",
      "rawToolResult",
      "nonce"
    ]);
    for (const { entry, schema } of catalogDocuments()) {
      const exposed = [...propertyNames(schema)].filter((name) => forbidden.has(name));
      assert.deepEqual(exposed, [], `${entry.file} exposes forbidden fields`);
    }
  });

  it("keeps the three source views and Git status alphabet canonical", () => {
    const registry = createWebUiSchemaRegistry();
    const source = registry.documents.find(({ entry }) => entry.name === "source-change-v1").schema;
    const snapshot = registry.documents.find(({ entry }) => entry.name === "snapshot-v1").schema;
    const capabilities = registry.documents.find(({ entry }) => entry.name === "capabilities-v1").schema;
    const views = ["task", "working-tree", "staged"];
    assert.deepEqual(source.$defs.view.enum, views);
    assert.deepEqual(snapshot.$defs.sourceViewSummary.properties.view.enum, views);
    assert.deepEqual(capabilities.$defs.availableInspectCapability.allOf[1].properties.sourceViews.items.enum, views);
    assert.deepEqual(source.$defs.fileChange.properties.status.enum, ["A", "M", "D", "R", "U", "C"]);
    assert.equal(source.$defs.fileChange.properties.status.enum.includes("E"), false);
  });

  it("binds snapshot task/tool hierarchy and explicit unknown facts", () => {
    const registry = createWebUiSchemaRegistry();
    const base = fixture("snapshot-v1");

    const active = clone(base);
    active.identity.taskId = "task-01";
    active.identity.taskRunId = "task-01-run-01";
    active.revision.taskRevision = "task_rev_01";
    active.revision.controlRevision = "control_rev_01";
    active.session.taskOutcome = "pending";
    active.session.verificationState = "not-run";
    active.verification.state = "not-run";
    active.verification.reasonCode = null;
    active.task = {
      taskId: "task-01",
      taskRunId: "task-01-run-01",
      summary: "Implement the bounded WebUI contract.",
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
    active.continuation = { state: "available", consumed: 0, maximum: 3, remaining: 3, reservationRef: null, reasonCode: null };
    expectValid(registry, "snapshot-v1", active);

    const orphanTool = clone(base);
    orphanTool.identity.toolCallId = "tool_01";
    expectInvalid(registry, "snapshot-v1", orphanTool);

    const taskIdsWithoutTask = clone(base);
    taskIdsWithoutTask.identity.taskId = "task-01";
    taskIdsWithoutTask.identity.taskRunId = "task-01-run-01";
    expectInvalid(registry, "snapshot-v1", taskIdsWithoutTask);

    const inventedQueue = clone(base);
    inventedQueue.session.queue.hasPending = false;
    expectInvalid(registry, "snapshot-v1", inventedQueue);

    const inventedPermission = clone(base);
    inventedPermission.session.permissionProfile = { state: "unknown", value: "workspace-write", evidence: null, reasonCode: "runtime-disconnected" };
    expectInvalid(registry, "snapshot-v1", inventedPermission);
  });

  it("separates zero-turn lifecycle commands from chat and requires settled evidence", () => {
    const registry = createWebUiSchemaRegistry();
    const resume = fixture("control-command-v1");
    expectValid(registry, "control-command-v1", resume);

    const hiddenChat = clone(resume);
    hiddenChat.payload = { text: "continue" };
    expectInvalid(registry, "control-command-v1", hiddenChat);

    const missingControlCas = clone(resume);
    missingControlCas.expectedRevisions.controlRevision = null;
    expectInvalid(registry, "control-command-v1", missingControlCas);

    const resumeAndContinue = clone(resume);
    resumeAndContinue.action = "lifecycle.resume-and-continue";
    resumeAndContinue.capabilityScope = "control.resumeAndContinue";
    resumeAndContinue.expectedRevisions.queueRevision = "queue_rev_01";
    resumeAndContinue.payload = {
      messageRequestId: "message_request_01",
      capabilityAction: "send",
      delivery: "new-operation",
      text: "Continue from the verified checkpoint.",
      attachmentRefs: [],
      contentDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    };
    expectValid(registry, "control-command-v1", resumeAndContinue);
    resumeAndContinue.payload.delivery = "steer";
    expectInvalid(registry, "control-command-v1", resumeAndContinue);

    const stopped = {
      schemaVersion: 1,
      version: "piagent-webui-control-v1",
      messageType: "receipt",
      commandId: "command_02",
      idempotencyKeyDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      action: "lifecycle.stop",
      actionDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      identity: { ...resume.identity, agentOperationId: "operation_01" },
      phase: "settled",
      resultCode: "stopped",
      requestedAt: "2026-08-13T09:10:00.000Z",
      settledAt: "2026-08-13T09:10:01.000Z",
      observedRevisionsBefore: domainRevision(),
      observedRevisionsAfter: domainRevision({ runtimeRevision: "runtime_rev_02" }),
      deduplicated: false,
      auditRef: "audit_01",
      settlementEvidenceRef: "settlement_01",
      error: null
    };
    expectValid(registry, "control-command-v1", stopped);
    stopped.settlementEvidenceRef = null;
    expectInvalid(registry, "control-command-v1", stopped);
  });

  it("keeps approval decisions exact-action-bound and Pi-guard-executed", () => {
    const registry = createWebUiSchemaRegistry();
    const request = fixture("approval-v1");
    expectValid(registry, "approval-v1", request);

    const browserExecutes = clone(request);
    browserExecutes.directExecution = true;
    expectInvalid(registry, "approval-v1", browserExecutes);

    const nonceSmuggling = clone(request);
    nonceSmuggling.nonce = nonceSmuggling.decisionToken;
    expectInvalid(registry, "approval-v1", nonceSmuggling);

    const decision = {
      schemaVersion: 1,
      version: "piagent-webui-approval-v1",
      recordType: "decision",
      approvalRef: request.approvalRef,
      decisionId: "decision_01",
      decisionToken: request.decisionToken,
      identity: request.identity,
      actionDigest: request.action.actionDigest,
      expectedRevisions: request.expectedRevisions,
      decision: "allow",
      reason: null,
      decidedAt: "2026-08-13T09:02:10.000Z",
      expiresAt: request.expiresAt,
      decisionSurface: "webui",
      executor: "pi-guard",
      directExecution: false
    };
    expectValid(registry, "approval-v1", decision);
    decision.actionDigest = "not-a-digest";
    expectInvalid(registry, "approval-v1", decision);
  });

  it("rejects inspect-only authority, unsupported protocol and missing unavailability reasons", () => {
    const registry = createWebUiSchemaRegistry();
    const inspectOnly = fixture("capabilities-v1");
    expectValid(registry, "capabilities-v1", inspectOnly);
    expectInvalid(registry, "capabilities-v1", fixture("capabilities-v1", "invalid"));

    const unknownProtocol = clone(inspectOnly);
    unknownProtocol.protocolMax = 2;
    expectInvalid(registry, "capabilities-v1", unknownProtocol);

    const noReason = clone(inspectOnly);
    noReason.capabilities["control.lifecycle"].reason = null;
    expectInvalid(registry, "capabilities-v1", noReason);

    const fakeControlMode = clone(inspectOnly);
    fakeControlMode.mode = "control-enabled";
    expectInvalid(registry, "capabilities-v1", fakeControlMode);
  });

  it("rejects non-Git status, unsafe provenance, rename/conflict mismatches and traversal paths", () => {
    const registry = createWebUiSchemaRegistry();
    const changes = fixture("source-change-v1");
    expectValid(registry, "source-change-v1", changes);
    expectInvalid(registry, "source-change-v1", fixture("source-change-v1", "invalid"));

    const renameWithoutOrigin = clone(changes);
    renameWithoutOrigin.files[0].status = "R";
    expectInvalid(registry, "source-change-v1", renameWithoutOrigin);

    const falseConflict = clone(changes);
    falseConflict.files[0].status = "C";
    expectInvalid(registry, "source-change-v1", falseConflict);

    const inventedAuthorship = clone(changes);
    inventedAuthorship.files[0].provenance = {
      classification: "runtime-observed-agent",
      evidence: "derived",
      baselineEvidenceRef: null,
      mutationEvidenceRefs: [],
      reasonCode: null
    };
    expectInvalid(registry, "source-change-v1", inventedAuthorship);

    const traversal = clone(changes);
    traversal.files[0].path = "../secret.txt";
    expectInvalid(registry, "source-change-v1", traversal);

    const taskChanges = clone(changes);
    taskChanges.view = "task";
    taskChanges.identity.taskId = "task-01";
    taskChanges.identity.taskRunId = "task-01-run-01";
    taskChanges.bases = [{
      basisRef: "task_basis_01",
      repoRef: "repo_01",
      view: "task",
      state: "current",
      reasonCode: null,
      basisRevision: "task_basis_rev_01",
      taskRunId: "task-01-run-01",
      taskRevision: "task_rev_01",
      workspaceRevision: "workspace_rev_01",
      baselineManifestRef: "baseline_manifest_01",
      baselineTreeDigest: "wt-content-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }];
    taskChanges.files[0].basisRef = "task_basis_01";
    expectValid(registry, "source-change-v1", taskChanges);
    taskChanges.identity.taskId = null;
    taskChanges.identity.taskRunId = null;
    expectInvalid(registry, "source-change-v1", taskChanges);
  });

  it("binds diff line shape and fails closed for stale, binary and protected content", () => {
    const registry = createWebUiSchemaRegistry();
    const diff = fixture("diff-v1");
    expectValid(registry, "diff-v1", diff);

    const malformedAddition = clone(diff);
    malformedAddition.hunks[0].lines[1].oldLineNumber = 1;
    expectInvalid(registry, "diff-v1", malformedAddition);

    const staleWithContent = clone(diff);
    staleWithContent.availability = { state: "stale", reasonCode: "stale-retry", message: "Workspace changed.", retryable: true };
    staleWithContent.fallback = { kind: "stale", reasonCode: "stale-retry", message: "Reload the current revision." };
    expectInvalid(registry, "diff-v1", staleWithContent);

    const binaryWithText = clone(diff);
    binaryWithText.file.content = { kind: "binary", access: "available", reasonCode: null };
    binaryWithText.file.stats = { state: "unavailable", additions: null, deletions: null, reasonCode: "binary-content" };
    binaryWithText.fallback = { kind: "binary", reasonCode: "binary-content", message: "Text diff is unavailable." };
    expectInvalid(registry, "diff-v1", binaryWithText);

    const taskDiff = clone(diff);
    taskDiff.view = "task";
    taskDiff.identity.taskId = "task-01";
    taskDiff.identity.taskRunId = "task-01-run-01";
    taskDiff.basis = {
      basisRef: "task_basis_01",
      repoRef: "repo_01",
      view: "task",
      state: "current",
      reasonCode: null,
      basisRevision: "task_basis_rev_01",
      taskRunId: "task-01-run-01",
      taskRevision: "task_rev_01",
      workspaceRevision: "workspace_rev_01",
      baselineManifestRef: "baseline_manifest_01",
      baselineTreeDigest: "wt-content-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    };
    taskDiff.file.basisRef = "task_basis_01";
    expectValid(registry, "diff-v1", taskDiff);
    taskDiff.identity.taskId = null;
    taskDiff.identity.taskRunId = null;
    expectInvalid(registry, "diff-v1", taskDiff);
  });

  it("requires ordered event sequence, bounded kind payload and command correlation", () => {
    const registry = createWebUiSchemaRegistry();
    const started = fixture("runtime-event-v2");
    expectValid(registry, "runtime-event-v2", started);

    const zeroSequence = clone(started);
    zeroSequence.writerSequence = 0;
    expectInvalid(registry, "runtime-event-v2", zeroSequence);

    const falseRedaction = clone(started);
    falseRedaction.redaction.valuesRemoved = 1;
    expectInvalid(registry, "runtime-event-v2", falseRedaction);

    const rawPath = clone(started);
    rawPath.payload.sessionFile = "/private/session.jsonl";
    expectInvalid(registry, "runtime-event-v2", rawPath);

    const stopRequested = clone(started);
    stopRequested.kind = "agent-operation.stop-requested";
    stopRequested.agentOperationId = "operation_01";
    stopRequested.correlation.commandId = "command_01";
    stopRequested.payload = { phase: "running", emergency: false, auditAvailable: true, reasonCode: "operator-requested" };
    stopRequested.evidence = "derived";
    expectValid(registry, "runtime-event-v2", stopRequested);
    stopRequested.correlation.commandId = null;
    expectInvalid(registry, "runtime-event-v2", stopRequested);
  });
});

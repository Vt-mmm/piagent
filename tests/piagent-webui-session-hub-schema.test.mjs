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

function fixture(name, state = "valid") {
  return JSON.parse(fs.readFileSync(path.join(WEBUI_FIXTURE_ROOT, `${name}.${state}.json`), "utf8"));
}

function expectValid(name, value) {
  const result = validateFixture(registry, name, value);
  assert.equal(result.valid, true, `${name} unexpectedly rejected: ${result.errors}`);
}

function expectInvalid(name, value) {
  const result = validateFixture(registry, name, value);
  assert.equal(result.valid, false, `${name} accepted an invalid Session Hub document`);
}

describe("Piagent Session Hub wire authority", () => {
  it("keeps ownership, archive, and offline state internally consistent", () => {
    const catalog = fixture("session-catalog-v1");
    expectValid("session-catalog-v1", catalog);

    const offlineWithOwner = structuredClone(catalog);
    offlineWithOwner.sessions[0].state = "offline";
    offlineWithOwner.sessions[0].liveState = "offline";
    expectInvalid("session-catalog-v1", offlineWithOwner);

    const archivedComposer = structuredClone(catalog);
    archivedComposer.sessions[0].state = "archived";
    archivedComposer.sessions[0].archived = true;
    archivedComposer.sessions[0].liveState = "offline";
    archivedComposer.sessions[0].composerAvailable = true;
    archivedComposer.sessions[0].owner = {
      kind: "none",
      ownerEpoch: null,
      gatewayInstanceRef: null,
      runtimeInstanceRef: null,
      continuity: "released"
    };
    expectInvalid("session-catalog-v1", archivedComposer);

    const unavailableWithFacts = structuredClone(catalog);
    unavailableWithFacts.state = "unavailable";
    unavailableWithFacts.reasonCode = "gateway-offline";
    expectInvalid("session-catalog-v1", unavailableWithFacts);
  });

  it("binds every session mutation to the intended session and operation", () => {
    const send = fixture("session-command-v1");
    expectValid("session-command-v1", send);

    const followUpWithoutOperation = structuredClone(send);
    followUpWithoutOperation.payload.delivery = "follow-up";
    expectInvalid("session-command-v1", followUpWithoutOperation);

    const smuggledPath = structuredClone(send);
    smuggledPath.payload.projectPath = "/Users/operator/private";
    expectInvalid("session-command-v1", smuggledPath);

    const createWithExistingSession = structuredClone(send);
    createWithExistingSession.action = "session.create";
    createWithExistingSession.expectedSessionRevision = null;
    createWithExistingSession.payload = {
      projectRef: "project_01",
      placeRef: "place_01",
      modelRef: null,
      thinkingLevel: "high",
      message: "Create a session.",
      messageRequestId: "message_request_02"
    };
    expectInvalid("session-command-v1", createWithExistingSession);
  });

  it("makes settled and uncertain receipts evidence-bearing and unambiguous", () => {
    const send = fixture("session-command-v1");
    const settled = {
      schemaVersion: 1,
      version: "piagent-session-receipt-v1",
      messageType: "receipt",
      commandId: send.commandId,
      idempotencyKeyDigest: `sha256:${"a".repeat(64)}`,
      action: "session.send",
      phase: "settled",
      resultCode: "started",
      requestedAt: send.requestedAt,
      settledAt: "2026-08-14T04:30:01.000Z",
      sessionRef: send.sessionRef,
      operationRef: "operation_01",
      catalogRevisionAfter: "catalog_rev_02",
      sessionRevisionAfter: "session_rev_02",
      deduplicated: false,
      evidenceRef: "evidence_01",
      error: null
    };
    expectValid("session-command-v1", settled);

    const settledWithoutEvidence = structuredClone(settled);
    settledWithoutEvidence.evidenceRef = null;
    expectInvalid("session-command-v1", settledWithoutEvidence);

    const uncertainClaimingSuccess = structuredClone(settled);
    uncertainClaimingSuccess.phase = "uncertain";
    uncertainClaimingSuccess.error = { code: "effect-unknown", message: "The runtime outcome is unknown." };
    expectInvalid("session-command-v1", uncertainClaimingSuccess);
  });

  it("fails closed when gateway protocol compatibility is not proven", () => {
    const capabilities = fixture("gateway-capabilities-v1");
    expectValid("gateway-capabilities-v1", capabilities);

    const incompatible = structuredClone(capabilities);
    incompatible.protocol.compatibility = "incompatible";
    incompatible.protocol.selected = null;
    incompatible.reasonCode = "protocol-incompatible";
    expectInvalid("gateway-capabilities-v1", incompatible);
  });

  it("binds protocol methods and event kinds to exact payload shapes", () => {
    const listRequest = fixture("gateway-protocol-v1");
    expectValid("gateway-protocol-v1", listRequest);

    const methodSmuggling = structuredClone(listRequest);
    methodSmuggling.method = "sessions.get";
    expectInvalid("gateway-protocol-v1", methodSmuggling);

    const catalogEvent = {
      schemaVersion: 1,
      version: "piagent-gateway-protocol-v1",
      messageType: "event",
      sequence: 4,
      stateVersion: 9,
      generatedAt: "2026-08-14T04:30:02.000Z",
      kind: "catalog.changed",
      payload: { catalogRevision: "catalog_rev_02" }
    };
    expectValid("gateway-protocol-v1", catalogEvent);

    const eventSmuggling = structuredClone(catalogEvent);
    eventSmuggling.kind = "resync.required";
    expectInvalid("gateway-protocol-v1", eventSmuggling);
  });

  it("binds successful response methods to their declared result type", () => {
    const response = {
      schemaVersion: 1,
      version: "piagent-gateway-protocol-v1",
      messageType: "response",
      requestId: "request_abcdefgh01",
      method: "sessions.list",
      ok: true,
      stateVersion: 11,
      result: fixture("session-catalog-v1"),
      error: null
    };
    expectValid("gateway-protocol-v1", response);

    const wrongMethod = structuredClone(response);
    wrongMethod.method = "gateway.health";
    expectInvalid("gateway-protocol-v1", wrongMethod);
  });
});

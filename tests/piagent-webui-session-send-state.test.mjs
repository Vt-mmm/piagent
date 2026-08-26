import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalOperationAfter, GatewayCommandTransportError, gatewayCommandMayHaveEffect, newerOperationObservation,
  sessionSendDisposition }
  from "../packages/piagent-webui/client/src/session-send-state.ts";

function receipt(phase, resultCode) {
  return { phase, resultCode };
}

describe("Piagent WebUI session send state", () => {
  it("treats a new runtime operation after a transport timeout as observed, not failed", () => {
    const old = { serial: 7, operationRef: "operation_old", complete: true };
    const current = { serial: 8, operationRef: "operation_new", complete: false };
    assert.equal(newerOperationObservation(old, 7), null);
    assert.deepEqual(newerOperationObservation(current, 7), current);
    assert.equal(sessionSendDisposition(null, current), "observed");
  });

  it("does not false-confirm from an event that predates this send", () => {
    const stale = newerOperationObservation({ serial: 12, operationRef: "operation_previous", complete: true }, 12);
    assert.equal(stale, null);
    assert.equal(newerOperationObservation({ serial: 13, operationRef: "operation_previous", complete: true },
      12, "operation_previous"), null);
    assert.equal(sessionSendDisposition(null, stale), "unconfirmed");
    assert.equal(canonicalOperationAfter({ operationRef: "operation_previous", abortable: true }, "operation_previous"), null);
    assert.deepEqual(canonicalOperationAfter({ operationRef: "operation_new", abortable: true }, "operation_previous"),
      { operationRef: "operation_new", complete: false });
  });

  it("uses request correlation to reject a misordered event and accept canonical reconnect state", () => {
    const wrong = { serial: 14, operationRef: "operation_wrong", messageRequestId: "message-request.other", complete: false };
    assert.equal(newerOperationObservation(wrong, 13, "operation_previous", "message-request.current"), null);
    const exact = { serial: 15, operationRef: "operation_current", messageRequestId: "message-request.current", complete: false };
    assert.deepEqual(newerOperationObservation(exact, 13, "operation_previous", "message-request.current"), exact);
    assert.equal(canonicalOperationAfter({ operationRef: "operation_other", messageRequestId: "message-request.other", abortable: true },
      "operation_previous", "message-request.current"), null);
    assert.deepEqual(canonicalOperationAfter({ operationRef: "operation_current", messageRequestId: "message-request.current", abortable: true },
      "operation_previous", "message-request.current"), { operationRef: "operation_current", complete: false });
  });

  it("rolls back a request that never left the browser but preserves uncertainty after a sent timeout", () => {
    assert.equal(gatewayCommandMayHaveEffect(new GatewayCommandTransportError("gateway-not-connected", false), true), false);
    assert.equal(gatewayCommandMayHaveEffect(new GatewayCommandTransportError("socket-send-failed", false), true), false);
    assert.equal(gatewayCommandMayHaveEffect(new GatewayCommandTransportError("gateway-command-response-timeout", true), true), true);
    assert.equal(gatewayCommandMayHaveEffect(new GatewayCommandTransportError("gateway-connection-lost", true), true), true);
  });

  it("separates confirmed, definitive rejection and effect uncertainty", () => {
    assert.equal(sessionSendDisposition(receipt("settled", "started"), null), "confirmed");
    assert.equal(sessionSendDisposition(receipt("accepted", "accepted"), null), "confirmed");
    assert.equal(sessionSendDisposition(receipt("rejected", "unavailable"), null), "rejected");
    assert.equal(sessionSendDisposition(receipt("uncertain", "effect-unknown"), null), "unconfirmed");
  });

  it("lets exact runtime evidence override a contradictory late receipt to prevent duplicate runs", () => {
    const observed = { operationRef: "operation_running", complete: false };
    assert.equal(sessionSendDisposition(receipt("uncertain", "effect-unknown"), observed), "observed");
    assert.equal(sessionSendDisposition(receipt("rejected", "unavailable"), observed), "observed");
  });
});

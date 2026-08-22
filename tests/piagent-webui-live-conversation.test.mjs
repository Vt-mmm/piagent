import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyOperationSettlement, canonicalLiveStateSequence, connectionStateAfterCatalogRefresh, liveStateConfirmsAbort,
  mergeTerminalOperationActivities, parseGatewayCursor,
  reconcileSessionLiveState, reconcileTerminalOperationActivities,
  terminalOperationActivity } from "../packages/piagent-webui/client/src/use-session-hub.ts";

function running() {
  return { user: "Check the plan.", assistant: "Unconfirmed streamed draft.", attachments: [], activities: [],
    operationRef: "operation_live_settlement", complete: false, error: null, settlement: null };
}

describe("Piagent WebUI live conversation settlement", () => {
  it("exits loading for every canonical terminal outcome and keeps prose only for success", () => {
    for (const settlement of ["completed", "blocked", "aborted", "error", "unknown"]) {
      const value = applyOperationSettlement(running(), { operationRef: "operation_live_settlement", settlement,
        reasonCode: settlement === "completed" ? null : `operation-${settlement}` });
      assert.equal(value.complete, true);
      assert.equal(value.settlement, settlement);
      assert.equal(value.assistant, settlement === "completed" ? "Unconfirmed streamed draft." : "");
      assert.equal(value.error, settlement === "completed" ? null : `operation-${settlement}`);
    }
  });

  it("fails an unrecognized settlement closed instead of leaving the composer loading", () => {
    const value = applyOperationSettlement(running(), { operationRef: "operation_live_settlement", settlement: "future-state" });
    assert.equal(value.complete, true);
    assert.equal(value.settlement, "unknown");
    assert.equal(value.assistant, "");
    assert.equal(value.error, "operation-settlement-unknown");
  });

  it("seeds Stop/loading from canonical live state and reconciles a finished operation without a false error", () => {
    const projection = {
      schemaVersion: 1, version: "piagent-session-live-state-v1", generatedAt: "2026-08-21T08:00:00.000Z",
      gatewayInstanceRef: "gateway_live_reload", eventSequence: 17, state: "ready",
      operations: [{ sessionRef: "session_live_reload", operationRef: "operation_live_reload", state: "running", abortable: true }],
      settlements: [],
      reasonCode: null
    };
    const seeded = reconcileSessionLiveState({}, projection);
    assert.equal(seeded.session_live_reload.operationRef, "operation_live_reload");
    assert.equal(seeded.session_live_reload.complete, false);
    assert.equal(seeded.session_live_reload.abortable, true);
    assert.equal(seeded.session_live_reload.user, "");

    const preserved = reconcileSessionLiveState({ session_live_reload: { ...seeded.session_live_reload,
      user: "Admitted input", assistant: "stream", activities: [{ toolCallRef: "tool_1", toolLabel: "read", state: "running" }] } }, projection);
    assert.equal(preserved.session_live_reload.user, "Admitted input");
    assert.equal(preserved.session_live_reload.assistant, "stream");

    const settling = reconcileSessionLiveState(preserved, { ...projection, eventSequence: 18,
      operations: [{ ...projection.operations[0], state: "settling", abortable: false }] });
    assert.equal(settling.session_live_reload.complete, false);
    assert.equal(settling.session_live_reload.abortable, false);

    const settledSnapshot = { ...projection, eventSequence: 19, operations: [] };
    const cleared = reconcileSessionLiveState(settling, settledSnapshot);
    assert.equal(cleared.session_live_reload.complete, true);
    assert.equal(cleared.session_live_reload.operationRef, null);
    assert.equal(cleared.session_live_reload.user, "");
    assert.equal(cleared.session_live_reload.assistant, "");
    assert.equal(cleared.session_live_reload.settlement, "unknown");
    assert.equal(cleared.session_live_reload.error, "operation-settlement-unavailable");
  });

  it("binds a persisted event cursor to one exact Gateway epoch", () => {
    const raw = JSON.stringify({ gatewayInstanceRef: "gateway_epoch_a", sequence: 42 });
    assert.equal(parseGatewayCursor(raw, "gateway_epoch_a"), 42);
    assert.equal(parseGatewayCursor(raw, "gateway_epoch_b"), null);
    assert.equal(parseGatewayCursor('{"gatewayInstanceRef":"gateway_epoch_a","sequence":-1}', "gateway_epoch_a"), null);
    assert.equal(parseGatewayCursor("not-json", "gateway_epoch_a"), null);
  });

  it("requires matching ready live state before a bootstrap or canonical resync may advance its cursor", () => {
    const ready = { schemaVersion: 1, version: "piagent-session-live-state-v1", generatedAt: "2026-08-21T08:00:00.000Z",
      gatewayInstanceRef: "gateway_canonical", eventSequence: 42, state: "ready", operations: [], settlements: [], reasonCode: null };
    assert.equal(canonicalLiveStateSequence(ready, "gateway_canonical"), 42);
    assert.equal(canonicalLiveStateSequence(undefined, "gateway_canonical"), null);
    assert.equal(canonicalLiveStateSequence({ ...ready, gatewayInstanceRef: "gateway_other" }, "gateway_canonical"), null);
    assert.equal(canonicalLiveStateSequence({ ...ready, state: "unavailable", operations: [], settlements: [],
      reasonCode: "session-live-state-unavailable" }, "gateway_canonical"), null);
    assert.equal(canonicalLiveStateSequence({ ...ready, eventSequence: "42" }, "gateway_canonical"), null);
    assert.equal(canonicalLiveStateSequence({ ...ready, settlements: undefined }, "gateway_canonical"), null);
  });

  it("never labels a catalog-only refresh live while its Gateway socket is closed", () => {
    assert.equal(connectionStateAfterCatalogRefresh(false, false), "reconnecting");
    assert.equal(connectionStateAfterCatalogRefresh(false, true), "reconnecting");
    assert.equal(connectionStateAfterCatalogRefresh(true, true), "reconnecting");
    assert.equal(connectionStateAfterCatalogRefresh(true, false), "connected");
  });

  it("allows a stale Stop retry only for the same canonical abortable operation", () => {
    const projection = { schemaVersion: 1, version: "piagent-session-live-state-v1", generatedAt: "2026-08-21T08:00:00.000Z",
      gatewayInstanceRef: "gateway_abort", eventSequence: 9, state: "ready",
      operations: [{ sessionRef: "session_abort", operationRef: "operation_abort", state: "running", abortable: true }],
      settlements: [], reasonCode: null };
    assert.equal(liveStateConfirmsAbort(projection, "gateway_abort", "session_abort", "operation_abort"), true);
    assert.equal(liveStateConfirmsAbort(projection, "gateway_other", "session_abort", "operation_abort"), false);
    assert.equal(liveStateConfirmsAbort(projection, "gateway_abort", "session_abort", "operation_replaced"), false);
    assert.equal(liveStateConfirmsAbort({ ...projection, operations: [{ ...projection.operations[0], state: "settling", abortable: false }] },
      "gateway_abort", "session_abort", "operation_abort"), false);
  });

  it("maps every non-success terminal outcome to one safe canonical Activity record", () => {
    const expected = { error: "failed", blocked: "blocked", aborted: "aborted", unknown: "unknown" };
    for (const [settlement, state] of Object.entries(expected)) {
      const value = terminalOperationActivity({ operationRef: `operation_${settlement}`, settlement,
        reasonCode: `operation-${settlement}`, settledAt: "2026-08-21T08:00:00.000Z", sequence: 12 });
      assert.equal(value.activityRef, `operation_${settlement}`);
      assert.equal(value.state, state);
      assert.equal(value.reasonCode, `operation-${settlement}`);
    }
    assert.equal(terminalOperationActivity({ operationRef: "operation_success", settlement: "completed",
      reasonCode: null, settledAt: "2026-08-21T08:00:00.000Z", sequence: 12 }), null);
    const unknown = terminalOperationActivity({ operationRef: "operation_future", settlement: "future-outcome",
      reasonCode: "provider secret is not a reason code", settledAt: "2026-08-21T08:00:00.000Z", sequence: 13 });
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.reasonCode, "operation-settlement-unknown");
  });

  it("deduplicates replayed settlements and replaces volatile Activity on canonical reload", () => {
    const first = terminalOperationActivity({ operationRef: "operation_terminal_once", settlement: "error",
      reasonCode: "assistant-response-failed", settledAt: "2026-08-21T08:00:00.000Z", sequence: 20 });
    const contradictory = terminalOperationActivity({ operationRef: "operation_terminal_once", settlement: "aborted",
      reasonCode: "operation-aborted", settledAt: "2026-08-21T08:00:01.000Z", sequence: 21 });
    const merged = mergeTerminalOperationActivities([first], [first, contradictory]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].state, "failed");
    assert.equal(merged[0].sequence, 20);

    const projection = { schemaVersion: 1, version: "piagent-session-live-state-v1", generatedAt: "2026-08-21T08:00:02.000Z",
      gatewayInstanceRef: "gateway_activity", eventSequence: 21, state: "ready", operations: [], settlements: [
        { sessionRef: "session_activity", operationRef: "operation_terminal_once", settlement: "error",
          reasonCode: "assistant-response-failed", settledAt: "2026-08-21T08:00:00.000Z", sequence: 20 }
      ], reasonCode: null };
    const seeded = reconcileTerminalOperationActivities(projection);
    assert.equal(seeded.session_activity.length, 1);
    assert.deepEqual(reconcileTerminalOperationActivities({ ...projection, gatewayInstanceRef: "gateway_restarted",
      eventSequence: 0, settlements: [] }), {});
  });
});

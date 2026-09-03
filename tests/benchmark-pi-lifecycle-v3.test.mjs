import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareIncidentClaims, comparePolicyRefusalOutput }
  from "../adapters/common/structured-assurance-facts.mjs";
import { registerIndependentAcceptanceProvider, settleIndependentWebUiOperation }
  from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { compositeSettlementTaskStatus }
  from "../packages/piagent-core/runtime/verification/composite-runtime-binding.ts";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewaySessionStream } from "../packages/piagent-webui/gateway/gateway-session-stream.ts";
import { terminalLifecycleOutcome } from "../scripts/benchmark-webui-journey.mjs";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const fixtureRoot = path.join(import.meta.dirname, "fixtures", "pi-lifecycle-v3");
const readFixture = name => JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));
const schemaRegistry = createWebUiSchemaRegistry();

test("P3 applicability keeps a non-composite provider out of the composite settlement callback", async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-p3-applicability-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const task = { sessionId: "session-p3-non-composite", taskRunId: "task-run-p3-non-composite" };
  let settlementCalls = 0, evidenceCalls = 0;
  t.after(registerIndependentAcceptanceProvider(cwd, task, {
    read: () => ({ entries: [] }),
    webUiSettlementApplicability: () => "not-applicable",
    async settleWebUi() { settlementCalls += 1; return { status: "settled", taskStatus: "completed" }; }
  }));
  const result = await settleIndependentWebUiOperation(cwd, task, {
    operationRef: "operation-p3-non-composite", messageRequestId: "request-p3-non-composite",
    evidence() { evidenceCalls += 1; return {}; }
  });
  assert.deepEqual(result, { status: "not-applicable" });
  assert.equal(settlementCalls, 0);
  assert.equal(evidenceCalls, 0);
});

test("P3 composite settlement registration requires explicit applicability", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-p3-explicit-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const task = { sessionId: "session-p3-explicit", taskRunId: "task-run-p3-explicit" };
  assert.throws(() => registerIndependentAcceptanceProvider(cwd, task, {
    read: () => ({ entries: [] }), settleWebUi: async () => ({ status: "settled", taskStatus: "completed" })
  }), /invalid independent acceptance provider/);
});

test("P3 Gateway emits independent operation and task states for every settlement row", () => {
  const fixture = readFixture("settlement-matrix.json");
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.rows.length, 7);
  for (const row of fixture.rows) {
    const events = new GatewayEventStore(), observed = [];
    events.subscribe(event => observed.push(event));
    const stream = new GatewaySessionStream({ sessionRef: `session-${row.id}`,
      operationRef: `operation-${row.id}`, events });
    if (row.assistantText) {
      stream.observe({ type: "message_start", message: { role: "assistant" } });
      stream.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: row.assistantText } });
      stream.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: row.assistantText }] } });
    }
    if (row.forcedOperationStatus === "blocked") stream.markBlocked("composite-settlement-blocked");
    if (row.forcedOperationStatus === "error") stream.markError("tool-or-task-failed");
    if (row.forcedOperationStatus === "aborted") stream.markAborted();
    stream.complete(`revision-${row.id}`, row.taskOutcome, row.taskStatusOverride);
    const settlement = observed.find(event => event.kind === "operation.settled");
    assert.ok(settlement, row.id);
    assert.equal(settlement.payload.settlement, row.expectedOperationStatus, row.id);
    assert.equal(settlement.payload.taskStatus, row.expectedTaskStatus, row.id);
    assert.equal(observed.some(event => event.kind === "message.completed"), row.expectedMessageCompleted, row.id);
    for (const event of observed) {
      const validation = validateFixture(schemaRegistry, "gateway-protocol-v1", event);
      assert.equal(validation.valid, true, `${row.id}: ${validation.errors}`);
    }
  }
});

test("P3 terminal lifecycle comparison rejects operation/task conflation", () => {
  assert.equal(terminalLifecycleOutcome({ expectedOperationStatus: "completed", expectedTaskStatus: "pending",
    observedOperationStatus: "completed", observedTaskStatus: "pending", turnIndex: 1 }), null);
  assert.equal(terminalLifecycleOutcome({ expectedOperationStatus: "completed", expectedTaskStatus: "refused",
    observedOperationStatus: "completed", observedTaskStatus: "refused", turnIndex: 1 }), null);
  assert.deepEqual(terminalLifecycleOutcome({ expectedOperationStatus: "completed", expectedTaskStatus: "refused",
    observedOperationStatus: "completed", observedTaskStatus: "completed", turnIndex: 1 }), {
    schemaVersion: 2, kind: "terminal-lifecycle-mismatch", expectedOperationStatus: "completed",
    observedOperationStatus: "completed", expectedTaskStatus: "refused", observedTaskStatus: "completed", turnIndex: 1
  });
});

test("P3 incident diagnosis fixture requires exact correlated read/output evidence", () => {
  const fixture = readFixture("incident-diagnosis.json");
  const positive = compareIncidentClaims(fixture.logText, fixture.positiveResponse, fixture.materialId);
  assert.equal(positive.matched, true);
  assert.equal(positive.reason, "structured-claims-match");
  for (const response of fixture.negativeResponses) {
    const negative = compareIncidentClaims(fixture.logText, response, fixture.materialId);
    assert.equal(negative.matched, false);
    assert.equal(negative.reason, "response-bytes-mismatch");
  }
});

test("P3 protected-env and destructive-history refusals require exact safe output", () => {
  const fixture = readFixture("correct-refusals.json");
  assert.deepEqual(fixture.cases.map(entry => entry.scenarioId),
    ["protected-env-refusal", "destructive-history-refusal"]);
  for (const entry of fixture.cases) {
    assert.equal(comparePolicyRefusalOutput(entry.rule, entry.positiveResponse, "assistant").matched, true, entry.scenarioId);
    assert.equal(comparePolicyRefusalOutput(entry.rule, entry.negativeResponse, "assistant").matched, false, entry.scenarioId);
  }
  assert.equal(compositeSettlementTaskStatus(["workspace-scope", "policy-refusal-output", "terminal-delivery"]), "refused");
  assert.equal(compositeSettlementTaskStatus(["workspace-scope", "structured-log-claims", "terminal-delivery"]), "completed");
});

test("P3 canonical replay cannot duplicate or rewrite a settlement/task decision", () => {
  const events = new GatewayEventStore(), observed = [];
  events.subscribe(event => observed.push(event));
  const first = events.publish("operation.settled", { sessionRef: "session-p3-reconnect",
    operationRef: "operation-p3-reconnect", messageRequestId: "request-p3-reconnect",
    messageRef: "message-p3-reconnect", sessionRevision: "revision-p3-reconnect",
    settlement: "completed", taskStatus: "pending", reasonCode: null });
  const duplicate = events.publish("operation.settled", { sessionRef: "session-p3-reconnect",
    operationRef: "operation-p3-reconnect", messageRequestId: "request-p3-reconnect",
    messageRef: "message-p3-reconnect", sessionRevision: "revision-p3-reconnect-late",
    settlement: "error", taskStatus: "failed", reasonCode: "late-contradiction" });
  assert.equal(first.payload.settlement, "completed");
  assert.equal(first.payload.taskStatus, "pending");
  assert.equal(duplicate.payload.settlement, "completed");
  assert.equal(duplicate.payload.taskStatus, "pending");
  assert.equal(observed.length, 2);
});

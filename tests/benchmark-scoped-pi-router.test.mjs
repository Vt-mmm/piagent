import assert from "node:assert/strict";
import test from "node:test";

import { createScopedBrokerPiOperationRouter } from "../scripts/benchmark-scoped-pi-router.mjs";
import { SCOPED_TOOL_DEFINITIONS } from "../scripts/benchmark-scoped-verification-supervisor.mjs";

function loaded(identity, label) {
  const calls = [], state = { actions: 0, blocked: false, ended: false, cancelled: false,
    journalSha256: "0".repeat(64), g0Qualified: false, verificationAvailable: false,
    inflightVerification: null }, lifecycle = { disposals: 0 };
  const broker = {
    identity,
    async invokeAsync(name, args, nonce) {
      assert.equal(nonce, identity.nonce); assert.equal(state.ended, false);
      calls.push({ name, args }); state.actions++;
      return { label, name, args };
    },
    status: () => ({ ...state }),
    cancel() { state.cancelled = true; },
    async reconcileVerification() { return null; },
    close() { state.ended = true; }
  };
  return { broker, nonce: identity.nonce, identity, calls, lifecycle,
    async dispose() { lifecycle.disposals++; },
    settlementEvidence: () => {
      assert.equal(state.ended, true); assert.equal(state.cancelled, false);
      return { label, actions: state.actions };
    } };
}

function piFixture(router) {
  const handlers = new Map(), definitions = [], state = { active: [] };
  const pi = {
    registerTool(tool) { definitions.push(tool); },
    on(name, handler) { handlers.set(name, handler); },
    setActiveTools(names) { state.active = [...names]; },
    getActiveTools() { return state.active.map(name => ({ name })); }
  };
  router.extensionFactory(pi);
  const resourceLoader = { getExtensions: () => ({ extensions: [{ tools: new Map(definitions
    .map(definition => [definition.name, { definition }])) }] }) };
  return { pi, handlers, definitions, state, resourceLoader };
}

const operation = (suffix, text = `turn ${suffix}`) => ({ sessionId: "session-native",
  operationRef: `operation-${suffix}`, messageRequestId: `message-${suffix}`, inputText: text });

test("Pi operation router opens fresh exact-identity custody per turn and settles once", async () => {
  const opened = [];
  const router = createScopedBrokerPiOperationRouter({ open: async reservation => {
    const value = loaded({ sessionId: reservation.sessionId, operationId: reservation.operationRef,
      nonce: reservation.messageRequestId }, reservation.operationRef);
    opened.push({ reservation, value }); return value;
  } });
  const pi = piFixture(router), names = SCOPED_TOOL_DEFINITIONS.map(tool => tool.name);
  await pi.handlers.get("session_start")(); assert.deepEqual(pi.state.active, names);
  const ownership = router.assertOwnership(pi.resourceLoader);
  assert.deepEqual(ownership.names, names); assert.match(ownership.toolDefinitionsSha256, /^[a-f0-9]{64}$/);
  assert.equal(ownership.handlersOwned, true);

  const finishOne = router.beginOperation(operation("one"));
  await pi.handlers.get("before_agent_start")({}, { sessionManager: { getSessionId: () => "session-native" } });
  const result = await pi.definitions[0].execute("call-one", { materialId: "input" });
  assert.equal(result.details.label, "operation-one");
  await pi.handlers.get("agent_end")(); finishOne("operation-settled");
  assert.equal(opened[0].value.lifecycle.disposals, 1);
  assert.deepEqual(router.settlementEvidence(), { label: "operation-one", actions: 1 });
  assert.throws(() => router.settlementEvidence(), /pi-router-settlement-unavailable/);

  const finishTwo = router.beginOperation(operation("two"));
  await pi.handlers.get("before_agent_start")({}, { sessionManager: { getSessionId: () => "session-native" } });
  await pi.definitions[1].execute("call-two", { materialId: "document", expectedSha256: "a", utf8: "b" });
  await pi.handlers.get("agent_end")(); finishTwo("operation-settled");
  assert.equal(opened[1].value.lifecycle.disposals, 1);
  assert.deepEqual(router.settlementEvidence(), { label: "operation-two", actions: 1 });
  assert.equal(opened.length, 2); assert.notEqual(opened[0].value.broker, opened[1].value.broker);
  assert.equal(opened[0].reservation.inputSha256 === opened[1].reservation.inputSha256, false);
});

test("Pi operation router rejects reuse, identity mismatch, widening and aborted settlement", async () => {
  let mismatched = false;
  const router = createScopedBrokerPiOperationRouter({ open: reservation => loaded({
    sessionId: reservation.sessionId, operationId: mismatched ? "wrong-operation" : reservation.operationRef,
    nonce: reservation.messageRequestId }, "fixture") });
  const pi = piFixture(router);
  const finish = router.beginOperation(operation("one"));
  assert.throws(() => router.beginOperation(operation("duplicate")), /pi-router-operation-reuse/);
  await pi.handlers.get("before_agent_start")({}, { sessionManager: { getSessionId: () => "session-native" } });
  assert.throws(() => router.beginOperation(operation("active")), /pi-router-operation-reuse/);
  finish("operation-aborted"); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => router.settlementEvidence(), /pi-router-settlement-unavailable/);

  const widened = createScopedBrokerPiOperationRouter({ open: () => { throw new Error("unused"); } });
  const badPi = piFixture(widened);
  badPi.pi.getActiveTools = () => [...badPi.state.active.map(name => ({ name })), { name: "read" }];
  assert.throws(() => badPi.handlers.get("session_start")(), /pi-router-tool-surface/);

  const wrong = createScopedBrokerPiOperationRouter({ open: reservation => loaded({
    sessionId: reservation.sessionId, operationId: "wrong", nonce: reservation.messageRequestId }, "wrong") });
  const wrongPi = piFixture(wrong); mismatched = true;
  wrong.beginOperation(operation("wrong"));
  await assert.rejects(wrongPi.handlers.get("before_agent_start")({},
    { sessionManager: { getSessionId: () => "session-native" } }), /pi-router-broker-identity/);
  assert.equal(wrong.status().shuttingDown, true);
});

test("Pi operation router exposes an exact one-shot fatal channel for custody open denial", async () => {
  const marker = Object.assign(new Error("session-custody-arm-drift"), {
    brokerCode: "session-custody-arm-drift"
  });
  const router = createScopedBrokerPiOperationRouter({ open: async () => {
    await Promise.resolve();
    throw marker;
  } });
  const runtime = piFixture(router), finish = router.beginOperation(operation("denied"));
  await assert.rejects(runtime.handlers.get("before_agent_start")({},
    { sessionManager: { getSessionId: () => "session-native" } }), error => error === marker);
  assert.throws(() => router.assertProviderDispatchReady(), error => error === marker,
    "the actual SDK payload boundary must fail with the same custody error");
  assert.equal(router.takeFatalProviderBoundaryError(), null,
    "the fatal is not released until the matching operation settles");
  finish("operation-settled");
  assert.equal(router.takeFatalProviderBoundaryError(), marker);
  assert.equal(router.takeFatalProviderBoundaryError(), null, "the trusted fatal channel is one-shot");
  assert.throws(() => router.settlementEvidence(), /pi-router-settlement-unavailable/);
});

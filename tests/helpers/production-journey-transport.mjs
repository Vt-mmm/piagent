import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { GatewayProtocolService } from "../../packages/piagent-webui/gateway/gateway-protocol-service.ts";
import { buildSessionLiveState } from "../../packages/piagent-webui/gateway/session-live-state.ts";
import { startLoopbackServer } from "../../packages/piagent-webui/server/loopback-server.ts";
import { GatewayJourneyClient, bootstrapBrowserSession, recoverOperationFromEvents } from "../../scripts/benchmark-webui-journey.mjs";
import { createWebUiSchemaRegistry, validateFixture } from "./piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const HTTP_SCHEMAS = { "/api/v1/session-catalog": "session-catalog-v1", "/api/v1/session-live-state": "session-live-state-v1" };

export function assertLoopbackHello(hello, gatewayInstanceRef) {
  assert.equal(hello.messageType, "hello");
  const validation = validateFixture(registry, "gateway-protocol-v1", hello);
  assert.equal(validation.valid, true, validation.errors);
  assert.equal(hello.capabilities.gatewayInstanceRef, gatewayInstanceRef, "gateway-identity-mismatch");
}

export function assertSupportedLoopbackTurn(turn, sessionRef = null) {
  // Never count an ignored fault-injection instruction as transport coverage.
  if (turn.receiptUncertain === true && !sessionRef) throw new Error("offline-loopback-uncertain-send-requires-existing-session");
  if (turn.abortAfterMs !== undefined) throw new Error("offline-loopback-abort-not-supported");
}

export async function productionJourneyTransport({ root, repositoryRoot, gatewayInstanceRef, catalog, controller, events, supervisor, readSessionModel }) {
  const staticRoot = path.join(root, "transport-static");
  fs.mkdirSync(staticRoot, { mode: 0o700 });
  // A transport fixture only: this is not the production browser bundle, DOM,
  // complete daemon startup or native model/auth-provider qualification.
  fs.writeFileSync(path.join(staticRoot, "index.html"), '<!doctype html><main>offline transport fixture</main>');
  const capabilities = { ...JSON.parse(fs.readFileSync(path.join(repositoryRoot,
    "evals/fixtures/piagent-webui/gateway-capabilities-v1.valid.json"), "utf8")),
    gatewayInstanceRef, generatedAt: new Date().toISOString() };
  const counters = { kind: "loopback-http-websocket", bootstrapCount: 0, connections: 0, reconnects: 0,
    commandDispatches: 0, unauthenticatedCatalogStatus: null, reconnectCursors: [], uncertainSends: 0, droppedConnections: 0 };
  const frames = [], frameErrors = [], clients = [];
  const protocol = new GatewayProtocolService({ capabilities: () => capabilities, catalog, events,
    command: { execute(command) { counters.commandDispatches++; return controller.execute(command); } } });
  const server = await startLoopbackServer({ staticRoot, mode: "gateway", readCapabilities: () => capabilities,
    readSessionCatalog: catalog, gatewayProtocol: protocol, readSessionModel,
    readSessionLiveState: () => buildSessionLiveState({ gatewayInstanceRef, eventSequence: events.stateVersion,
      operations: supervisor.currentOperations(), settlements: events.recentOperationSettlements() }) });
  let client, browser;
  async function readHttpDocument(pathname, schema, deadline) {
    const timeout = deadline - Date.now(); assert.ok(timeout > 0);
    const response = await fetch(`${server.origin}${pathname}`, { signal: AbortSignal.timeout(timeout),
      headers: { Accept: "application/json", Origin: browser.origin, Cookie: browser.cookie } });
    assert.equal(response.status, 200);
    const value = await response.json(), validation = validateFixture(registry, schema, value);
    assert.equal(validation.valid, true, validation.errors); return value;
  }
  async function connect(deadline, cursor = null) {
    client = new GatewayJourneyClient(browser); clients.push(client);
    const connected = client.connect(deadline, cursor);
    client.socket.on("message", body => {
      try {
        const frame = JSON.parse(body.toString()), validation = validateFixture(registry, "gateway-protocol-v1", frame);
        frames.push(frame);
        if (!validation.valid) frameErrors.push(validation.errors);
      } catch { frameErrors.push("invalid-wire-json"); }
    });
    await connected;
    assert.equal(client.socket.readyState, WebSocket.OPEN);
    assertLoopbackHello(client.hello, gatewayInstanceRef);
    assert.deepEqual(frameErrors, []);
    counters.connections++;
  }
  async function close() {
    for (const item of clients) item.drop();
    await server.close();
  }
  async function replaceConnection(deadline, cursor, abrupt = false) {
    const oldSocket = client.socket;
    const closed = once(oldSocket, "close", { signal: AbortSignal.timeout(5000) });
    if (abrupt) client.drop(); else client.close();
    await closed;
    assert.equal(oldSocket.readyState, WebSocket.CLOSED);
    await connect(deadline, cursor);
    assert.notEqual(client.socket, oldSocket);
    counters.reconnects++; counters.reconnectCursors.push(cursor);
    if (abrupt) counters.droppedConnections++;
  }
  try {
    const deadline = Date.now() + 10000;
    const unauthenticated = await fetch(`${server.origin}/api/v1/session-catalog`, { signal: AbortSignal.timeout(5000) });
    counters.unauthenticatedCatalogStatus = unauthenticated.status;
    await unauthenticated.arrayBuffer();
    assert.equal(unauthenticated.status, 401);
    browser = await bootstrapBrowserSession(server.launchUrl, deadline); counters.bootstrapCount++;
    await connect(deadline);
  } catch (error) { await close(); throw error; }
  return {
    snapshot() {
      assert.deepEqual(frameErrors, [], "every received wire frame must satisfy the real protocol schema");
      return { ...structuredClone(counters), wireFrames: frames.length,
        wireSettlements: frames.filter(frame => frame.kind === "operation.settled").length };
    },
    async beforeTurn(turn, sessionRef, deadline) {
      assertSupportedLoopbackTurn(turn, sessionRef);
      if (!turn.reconnectBefore) return;
      assert.ok(sessionRef, "reconnect requires an existing durable session");
      await replaceConnection(deadline, client.lastSequence);
    },
    readCatalog: deadline => client.request("sessions.list", {
      cursor: null, limit: 100, filter: "all", query: null, projectRef: null
    }, deadline),
    command: (command, deadline) => client.request("sessions.command", { command }, deadline),
    async sendUncertain(command, deadline) {
      assert.equal(command.action, "session.send");
      assert.ok(command.sessionRef, "uncertain send cannot discover a new session through a discarded ack");
      const replayCursor = client.lastSequence;
      const matches = event => ["runtime.changed", "operation.settled"].includes(event.kind)
        && event.payload?.sessionRef === command.sessionRef
        && event.payload?.messageRequestId === command.payload.messageRequestId;
      counters.uncertainSends++;
      const discarded = await client.requestAndDiscardResponse("sessions.command", { command }, deadline);
      assert.equal(discarded.responseObserved, true);
      assert.equal(discarded.responseDiscarded, true);
      const eventsBeforeDisconnect = client.events.filter(matches).map(event => event.sequence);
      await replaceConnection(deadline, replayCursor, true);
      const event = await client.waitForEvent(matches, deadline, "offline-uncertain-operation-correlation");
      assert.ok(matches(event), "disconnect cannot supply operation identity");
      // Only the new socket's correlated events recover identity. Do not use
      // the discarded receipt, old client cache, or supervisor/event-store reads.
      const recovered = recoverOperationFromEvents(client.events, command.sessionRef, command.payload.messageRequestId);
      assert.ok(recovered, "uncertain send must recover an unambiguous operation through wire events");
      return { receipt: null, sessionRef: command.sessionRef, operationRef: recovered.operationRef,
        recovery: { responseObserved: true, responseDiscarded: true, connectionDropped: true,
          replayCursor, ...recovered, eventsBeforeDisconnect, correlatedByMessageRequestId: true, sendAttempts: 1 } };
    },
    async readHttp(pathname, deadline) {
      assert.ok(Object.hasOwn(HTTP_SCHEMAS, pathname), "only fixture-owned loopback projections may receive the private cookie");
      return readHttpDocument(pathname, HTTP_SCHEMAS[pathname], deadline);
    },
    async readTranscript(sessionRef, deadline) {
      assert.match(sessionRef, /^session_[A-Za-z0-9_-]{16,100}$/);
      assert.equal(typeof readSessionModel, "function", "canonical inspection provider is required");
      return readHttpDocument(`/api/v1/sessions/${encodeURIComponent(sessionRef)}/inspection/transcript?limit=100`,
        "transcript-v1", deadline);
    },
    async waitSettlement(receipt, messageRequestId, deadline) {
      const matches = event => event.kind === "operation.settled"
        && event.payload?.sessionRef === receipt.sessionRef && event.payload?.operationRef === receipt.operationRef
        && event.payload?.messageRequestId === messageRequestId;
      const event = await client.waitForEvent(matches, deadline, "offline-wire-settlement");
      assert.ok(matches(event), "disconnect is not a terminal settlement");
      assert.equal(client.events.filter(matches).length, 1, "one wire settlement for the submitted operation");
      assert.deepEqual(frameErrors, []);
      return structuredClone(event);
    },
    close
  };
}

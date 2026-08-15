import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WebSocket } from "ws";

import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewayProtocolService } from "../packages/piagent-webui/gateway/gateway-protocol-service.ts";
import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const registry = createWebUiSchemaRegistry();

async function authenticate(server) {
  const target = new URL(server.issueLaunchUrl());
  const capability = new URLSearchParams(target.hash.slice(1)).get("bootstrap");
  const result = await fetch(`${target.origin}/api/v1/bootstrap`, {
    method: "POST", headers: { Origin: target.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability })
  });
  assert.equal(result.status, 200);
  return { origin: target.origin, cookie: result.headers.get("set-cookie").split(";", 1)[0] };
}

function connect(origin, cookie) {
  return new WebSocket(`${origin.replace("http:", "ws:")}/api/v1/gateway`, "piagent.gateway.v1", {
    origin, headers: { Cookie: cookie }
  });
}

function bounded(promise, label, timeoutMs = 2_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}-timeout`)), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

function opened(socket) { return bounded(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), "websocket-open"); }
function inbox(socket) {
  const queued = [], waiting = [];
  socket.on("message", (data) => {
    let value;
    try { value = JSON.parse(data.toString()); } catch (error) { waiting.shift()?.reject(error); return; }
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(value); else queued.push(value);
  });
  socket.on("error", (error) => { while (waiting.length) waiting.shift().reject(error); });
  return { next(label) {
    if (queued.length) return Promise.resolve(queued.shift());
    return bounded(new Promise((resolve, reject) => waiting.push({ resolve, reject })), label);
  } };
}

describe("Piagent authenticated typed Gateway transport", () => {
  it("negotiates, filters reads, replays events and requires canonical resync after a cursor gap", async (t) => {
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-gateway-transport-static-"));
    fs.mkdirSync(path.join(staticRoot, "assets"));
    fs.writeFileSync(path.join(staticRoot, "index.html"), '<!doctype html><meta name="csp-nonce" content="__PIAGENT_CSP_NONCE__"><main>gateway</main>');
    fs.writeFileSync(path.join(staticRoot, "assets", "app.js"), "document.body.dataset.ready='true';\n");
    t.after(() => fs.rmSync(staticRoot, { recursive: true, force: true }));
    const capabilities = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/gateway-capabilities-v1.valid.json"), "utf8"));
    const catalog = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/session-catalog-v1.valid.json"), "utf8"));
    const events = new GatewayEventStore({ maximumCount: 1, maximumAgeMs: 60_000 });
    const protocol = new GatewayProtocolService({ capabilities: () => capabilities, catalog: async () => catalog, events });
    const server = await startLoopbackServer({ staticRoot, mode: "gateway",
      readCapabilities: () => capabilities, readSessionCatalog: () => catalog, gatewayProtocol: protocol });
    t.after(() => server.close());
    const auth = await authenticate(server), socket = connect(auth.origin, auth.cookie); t.after(() => socket.terminate());
    const messages = inbox(socket);
    await opened(socket);
    socket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "connect",
      clientRef: "client_transport_test", minimumProtocol: 1, maximumProtocol: 1, lastEventSequence: null, catalogRevision: null }));
    const hello = await messages.next("gateway-hello");
    assert.equal(validateFixture(registry, "gateway-protocol-v1", hello).valid, true);
    assert.equal(hello.messageType, "hello");
    socket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "request",
      requestId: "request_list_0001", method: "sessions.list",
      params: { cursor: null, limit: 20, filter: "active", query: "Session Hub", projectRef: null } }));
    const listed = await messages.next("sessions-list-response");
    assert.equal(validateFixture(registry, "gateway-protocol-v1", listed).valid, true);
    assert.equal(listed.result.sessions.length, 1);
    assert.equal(listed.result.page.limit, 20);

    events.publish("catalog.changed", { catalogRevision: "catalog_revision_live_01" }, new Date("2026-08-14T07:00:00.000Z"));
    const live = await messages.next("live-event");
    assert.equal(validateFixture(registry, "gateway-protocol-v1", live).valid, true);
    assert.equal(live.kind, "catalog.changed");
    socket.terminate();

    events.publish("catalog.changed", { catalogRevision: "catalog_revision_live_02" }, new Date("2026-08-14T07:00:01.000Z"));
    const replaySocket = connect(auth.origin, auth.cookie); t.after(() => replaySocket.terminate());
    const replayMessages = inbox(replaySocket);
    await opened(replaySocket);
    replaySocket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "connect",
      clientRef: "client_transport_test", minimumProtocol: 1, maximumProtocol: 1, lastEventSequence: 0, catalogRevision: "catalog_rev_01" }));
    assert.equal((await replayMessages.next("replay-hello")).messageType, "hello");
    const resync = await replayMessages.next("resync-event");
    assert.equal(validateFixture(registry, "gateway-protocol-v1", resync).valid, true);
    assert.equal(resync.kind, "resync.required");
    assert.equal(resync.payload.currentSequence, 2);

    const unauthorized = connect(auth.origin, "piagent_webui_session=invalid"); t.after(() => unauthorized.terminate());
    const denied = await bounded(new Promise((resolve) => {
      unauthorized.once("unexpected-response", (_request, response) => { const status = response.statusCode; response.resume(); unauthorized.terminate(); resolve(status); });
      unauthorized.once("error", () => resolve(403));
    }), "websocket-auth-rejection");
    assert.equal(denied, 403);
  });
});

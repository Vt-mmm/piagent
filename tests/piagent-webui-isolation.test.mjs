import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";

const roots = new Set(), servers = new Set();
function staticRoot() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-isolation-")); roots.add(value); fs.writeFileSync(path.join(value, "index.html"), "<!doctype html><main>isolated</main>"); return value; }
function request(origin, pathname, options = {}) { return new Promise((resolve, reject) => { const req = http.request(new URL(pathname, origin), { method: options.method ?? "GET", headers: options.headers }, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })); }); req.on("error", reject); if (options.body) req.write(options.body); req.end(); }); }
function token(server) { return new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get("bootstrap"); }
async function auth(server) { const response = await request(server.origin, "/api/v1/bootstrap", { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: token(server) }) }); return response.headers["set-cookie"][0].split(";", 1)[0]; }
function provider(state) { return { snapshot: () => state.snapshot, sourceChanges: (view) => ({ view }), diff: (ref) => ({ ref }), activity: () => ({ running: [], recent: [] }), logPreview: (ref) => ({ ref }), replay: () => ({ state: "current", events: [], nextCursor: "cursor.0", latestCursor: "cursor.0", reasonCode: null }), subscribe: () => () => {} }; }
async function close(server) { if (servers.delete(server)) await server.close(); }
afterEach(async () => { await Promise.all([...servers].map(close)); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

describe("Piagent WebUI failure isolation", () => {
  it("restarts with the same read truth, invalidates browser authority and never mutates runtime state", async () => {
    const runtime = { snapshot: { identity: { sessionRef: "session.stable" }, revision: { runtimeRevision: "revision.stable" } }, taskWrites: 0, providerCalls: 0 };
    const readModel = provider(runtime);
    const first = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => ({ mode: "inspect-only" }), readModel }); servers.add(first);
    const oldCookie = await auth(first);
    assert.equal((await request(first.origin, "/api/v1/snapshot", { headers: { Cookie: oldCookie } })).status, 200);
    await close(first);
    assert.equal(runtime.taskWrites, 0); assert.equal(runtime.providerCalls, 0);
    const second = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => ({ mode: "inspect-only" }), readModel }); servers.add(second);
    assert.equal((await request(second.origin, "/api/v1/snapshot", { headers: { Cookie: oldCookie } })).status, 401);
    const nextCookie = await auth(second), next = await request(second.origin, "/api/v1/snapshot", { headers: { Cookie: nextCookie } });
    assert.equal(JSON.parse(next.body).revision.runtimeRevision, "revision.stable");
    assert.equal(runtime.taskWrites, 0); assert.equal(runtime.providerCalls, 0);
  });

  it("fails corrupt and oversized projections closed while keeping the server usable", async () => {
    const state = { snapshot: { ok: true } }, readModel = provider(state);
    const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => ({ mode: "inspect-only" }), readModel }); servers.add(server);
    const cookie = await auth(server), headers = { Cookie: cookie };
    state.snapshot = { payload: "x".repeat(17 * 1024 * 1024) };
    assert.equal((await request(server.origin, "/api/v1/snapshot", { headers })).status, 503);
    readModel.snapshot = () => { throw new Error("corrupt projection"); };
    assert.equal((await request(server.origin, "/api/v1/snapshot", { headers })).status, 503);
    readModel.snapshot = () => ({ recovered: true });
    assert.equal((await request(server.origin, "/api/v1/snapshot", { headers })).status, 200);
  });

  it("has no mutation route and closes a slow SSE client without hanging", async () => {
    const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => ({ mode: "inspect-only" }), readModel: provider({ snapshot: {} }) }); servers.add(server);
    const cookie = await auth(server), headers = { Cookie: cookie };
    for (const route of ["/api/v1/stage", "/api/v1/unstage", "/api/v1/revert", "/api/v1/commit", "/api/v1/control"]) {
      assert.equal((await request(server.origin, route, { method: "POST", headers })).status, 405, route);
    }
    const connected = new Promise((resolve, reject) => { const req = http.request(new URL("/api/v1/events", server.origin), { headers }); req.on("response", resolve); req.on("error", reject); req.end(); });
    await connected;
    await Promise.race([close(server), new Promise((_, reject) => setTimeout(() => reject(new Error("slow-client-close-timeout")), 1_000))]);
  });
});

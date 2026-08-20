import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { SessionAuthority } from "../packages/piagent-webui/server/session-auth.ts";
import { loadStaticBundle } from "../packages/piagent-webui/server/static-bundle.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const capabilities = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/capabilities-v1.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry();
const temporaryRoots = new Set();
const servers = new Set();

function staticRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-static-"));
  temporaryRoots.add(directory);
  fs.mkdirSync(path.join(directory, "assets"));
  fs.writeFileSync(path.join(directory, "index.html"), '<!doctype html><meta name="csp-nonce" content="__PIAGENT_CSP_NONCE__"><main>local</main>');
  fs.writeFileSync(path.join(directory, "assets/app.js"), "document.body.dataset.ready='true';\n");
  return directory;
}

function request(origin, pathname, options = {}) {
  const target = new URL(pathname, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method: options.method ?? "GET", headers: options.headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function bootstrapValue(launchUrl) {
  const url = new URL(launchUrl);
  return new URLSearchParams(url.hash.slice(1)).get("bootstrap");
}

async function start(options = {}) {
  const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => capabilities, ...options });
  servers.add(server);
  return server;
}

async function close(server) { if (servers.delete(server)) await server.close(); }

afterEach(async () => {
  await Promise.all([...servers].map((server) => close(server)));
  for (const directory of temporaryRoots) fs.rmSync(directory, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("Piagent WebUI loopback server", () => {
  it("binds exact loopback, keeps bootstrap in the fragment, and serves local CSP assets", async () => {
    const server = await start();
    const origin = new URL(server.origin), launch = new URL(server.launchUrl), capability = bootstrapValue(server.launchUrl);
    assert.equal(origin.hostname, "127.0.0.1");
    assert.ok(Number(origin.port) > 0);
    assert.equal(launch.search, "");
    assert.match(capability, /^[A-Za-z0-9_-]{43}$/);
    const page = await request(server.origin, "/");
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /local/);
    const csp = String(page.headers["content-security-policy"]), html = page.body.toString();
    assert.match(csp, /default-src 'self'/);
    const nonce = html.match(/name="csp-nonce" content="([^"]+)"/)?.[1];
    assert.match(nonce ?? "", /^[A-Za-z0-9+/]{22}==$/);
    assert.equal(csp.includes(`style-src-elem 'self' 'nonce-${nonce}'`), true);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(html, /__PIAGENT_CSP_NONCE__/);
    assert.equal(page.body.includes(Buffer.from(capability)), false);
    const asset = await request(server.origin, "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers["content-type"], /^text\/javascript/);
    assert.equal((await request(server.origin, "/../package.json")).status, 404);
  });

  it("exchanges one capability for an HttpOnly strict cookie and serves schema-valid inspect-only authority", async () => {
    let reads = 0;
    const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => { reads += 1; return capabilities; } });
    servers.add(server);
    assert.equal((await request(server.origin, "/api/v1/capabilities")).status, 401);
    const capability = bootstrapValue(server.launchUrl);
    const body = JSON.stringify({ capability });
    const exchange = await request(server.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body
    });
    assert.equal(exchange.status, 200, exchange.body.toString());
    assert.equal(exchange.body.includes(Buffer.from(capability)), false);
    const cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    assert.match(exchange.headers["set-cookie"][0], /HttpOnly; SameSite=Strict; Path=\//);
    assert.match(JSON.parse(exchange.body).csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await request(server.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body
    })).status, 403);
    const response = await request(server.origin, "/api/v1/capabilities", { headers: { Cookie: cookie, Origin: server.origin } });
    assert.equal(response.status, 200);
    assert.equal(reads, 1);
    const document = JSON.parse(response.body);
    const validation = validateFixture(registry, "capabilities-v1", document);
    assert.equal(validation.valid, true, validation.errors);
    assert.equal(document.mode, "inspect-only");
    assert.equal(document.capabilities.inspect.status, "available");
    for (const [name, value] of Object.entries(document.capabilities)) if (name !== "inspect") assert.equal(value.status, "unavailable", name);
    const control = await request(server.origin, "/api/v1/control/pause", {
      method: "POST", headers: { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json" }, body: "{}"
    });
    assert.equal(control.status, 405);
  });

  it("scopes read-only Inspector and connection projections to one opaque Gateway session ref", async () => {
    const reads = [];
    const provider = {
      snapshot: () => ({ version: "selected-session-snapshot", marker: "snapshot" }),
      sourceChanges: (view) => ({ version: "selected-session-source", view }),
      diff: (view, fileRef) => ({ version: "selected-session-diff", view, fileRef })
    };
    const server = await start({
      readSessionModel: async (sessionRef) => { reads.push(["provider", sessionRef]); return provider; },
      readSessionConnections: async (sessionRef) => { reads.push(["connections", sessionRef]); return { version: "connections", sessionRef }; },
      readSessionCreationOptions: async () => { reads.push(["creation-options"]); return { version: "creation-options", projects: [] }; }
    });
    assert.equal((await request(server.origin, "/api/v1/sessions/session_safe/inspection/snapshot")).status, 401);
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const cookie = exchange.headers["set-cookie"][0].split(";", 1)[0], headers = { Cookie: cookie, Origin: server.origin };
    const snapshot = await request(server.origin, "/api/v1/sessions/session_safe/inspection/snapshot", { headers });
    assert.equal(snapshot.status, 200); assert.equal(JSON.parse(snapshot.body).marker, "snapshot");
    const source = await request(server.origin, "/api/v1/sessions/session_safe/inspection/source-changes?view=staged", { headers });
    assert.equal(source.status, 200); assert.equal(JSON.parse(source.body).view, "staged");
    const connections = await request(server.origin, "/api/v1/sessions/session_safe/inspection/connections", { headers });
    assert.equal(connections.status, 200); assert.equal(JSON.parse(connections.body).sessionRef, "session_safe");
    const creation = await request(server.origin, "/api/v1/session-creation-options", { headers });
    assert.equal(creation.status, 200); assert.equal(JSON.parse(creation.body).version, "creation-options");
    assert.deepEqual(reads, [["provider", "session_safe"], ["provider", "session_safe"], ["connections", "session_safe"], ["creation-options"]]);
    assert.equal((await request(server.origin, "/api/v1/sessions/not%2Fsafe/inspection/snapshot", { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/sessions/session_safe/inspection/connections?raw=1", { headers })).status, 404);
    assert.equal((await request(server.origin, "/api/v1/session-creation-options?raw=1", { headers })).status, 400);
  });

  it("requires exact Origin, cookie and CSRF before forwarding bounded control commands", async () => {
    const forwarded = [];
    const server = await start({ executeControl: async (command) => {
      forwarded.push(command); return { messageType: "receipt", resultCode: "dispatch-requested" };
    } });
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    const body = JSON.stringify({ action: "chat.send" });
    const baseHeaders = { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json" };
    assert.equal((await request(server.origin, "/api/v1/chat/messages", { method: "POST", headers: baseHeaders, body })).status, 403);
    assert.equal((await request(server.origin, "/api/v1/chat/messages", { method: "POST",
      headers: { ...baseHeaders, Origin: "http://attacker.invalid", "X-Piagent-CSRF": session.csrfToken }, body })).status, 403);
    const accepted = await request(server.origin, "/api/v1/chat/messages", { method: "POST",
      headers: { ...baseHeaders, "X-Piagent-CSRF": session.csrfToken }, body });
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), { messageType: "receipt", resultCode: "dispatch-requested" });
    assert.deepEqual(forwarded, [{ action: "chat.send" }]);
    const option = await request(server.origin, "/api/v1/session-options", { method: "POST",
      headers: { ...baseHeaders, "X-Piagent-CSRF": session.csrfToken }, body: JSON.stringify({ action: "session-options.set-thinking" }) });
    assert.equal(option.status, 200);
    const lifecycle = await request(server.origin, "/api/v1/lifecycle", { method: "POST",
      headers: { ...baseHeaders, "X-Piagent-CSRF": session.csrfToken }, body: JSON.stringify({ action: "lifecycle.pause" }) });
    assert.equal(lifecycle.status, 200);
    const compound = await request(server.origin, "/api/v1/control/resume-and-continue", { method: "POST",
      headers: { ...baseHeaders, "X-Piagent-CSRF": session.csrfToken }, body: JSON.stringify({ action: "lifecycle.resume-and-continue" }) });
    assert.equal(compound.status, 200);
    const review = await request(server.origin, "/api/v1/reviews", { method: "POST",
      headers: { ...baseHeaders, "X-Piagent-CSRF": session.csrfToken }, body: JSON.stringify({ action: "review.mark" }) });
    assert.equal(review.status, 200);
    const mutation = await request(server.origin, "/api/v1/source-mutations", { method: "POST",
      headers: { ...baseHeaders, "X-Piagent-CSRF": session.csrfToken }, body: JSON.stringify({ action: "source.stage" }) });
    assert.equal(mutation.status, 200);
    const handoff = await request(server.origin, "/api/v1/source-handoffs", { method: "POST",
      headers: { ...baseHeaders, "X-Piagent-CSRF": session.csrfToken }, body: JSON.stringify({ action: "source.open-in-vscode" }) });
    assert.equal(handoff.status, 200);
    assert.deepEqual(forwarded, [{ action: "chat.send" }, { action: "session-options.set-thinking" }, { action: "lifecycle.pause" },
      { action: "lifecycle.resume-and-continue" }, { action: "review.mark" }, { action: "source.stage" }, { action: "source.open-in-vscode" }]);
    const browserSession = await request(server.origin, "/api/v1/browser-session", { headers: { Cookie: cookie, Origin: server.origin } });
    assert.equal(browserSession.status, 200);
    assert.equal(JSON.parse(browserSession.body).csrfToken, session.csrfToken);
  });

  it("opens project import only behind authenticated same-origin CSRF authority", async () => {
    let imports = 0;
    const project = { projectRef: "project_safe", placeRef: "project_safe", label: "safe-project" };
    const server = await start({ executeProjectImport: async () => { imports += 1; return {
      schemaVersion: 1, version: "piagent-project-import-result-v1", importedAt: "2026-08-14T10:00:00.000Z", project
    }; } });
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    const headers = { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json", "X-Piagent-CSRF": session.csrfToken };
    assert.equal((await request(server.origin, "/api/v1/projects/import", { method: "POST",
      headers: { ...headers, "X-Piagent-CSRF": "wrong" }, body: JSON.stringify({ action: "project.import" }) })).status, 403);
    assert.equal((await request(server.origin, "/api/v1/projects/import", { method: "POST", headers,
      body: JSON.stringify({ action: "project.import", path: "/private" }) })).status, 400);
    const accepted = await request(server.origin, "/api/v1/projects/import", { method: "POST", headers,
      body: JSON.stringify({ action: "project.import" }) });
    assert.equal(accepted.status, 200); assert.deepEqual(JSON.parse(accepted.body).project, project); assert.equal(imports, 1);
  });

  it("keeps provider OAuth catalog and jobs authenticated and mutations CSRF-bound", async () => {
    const forwarded = [];
    const catalog = { schemaVersion: 1, version: "piagent-provider-auth-catalog-v1", providers: [] };
    const job = { schemaVersion: 1, version: "piagent-provider-auth-job-v1", jobRef: "authjob.safe", state: "running" };
    const server = await start({ readProviderAuthCatalog: () => catalog, readProviderAuthJob: (jobRef) => ({ ...job, jobRef }),
      executeProviderAuth: (command) => { forwarded.push(command); return job; } });
    assert.equal((await request(server.origin, "/api/v1/provider-auth")).status, 401);
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    const readHeaders = { Cookie: cookie, Origin: server.origin };
    const headers = { ...readHeaders, "Content-Type": "application/json", "X-Piagent-CSRF": session.csrfToken };
    assert.equal((await request(server.origin, "/api/v1/provider-auth", { headers: readHeaders })).status, 200);
    assert.equal((await request(server.origin, "/api/v1/provider-auth?raw=1", { headers: readHeaders })).status, 400);
    const body = JSON.stringify({ action: "provider-auth.start", providerRef: "provider.safe" });
    assert.equal((await request(server.origin, "/api/v1/provider-auth", { method: "POST",
      headers: { ...headers, "X-Piagent-CSRF": "wrong" }, body })).status, 403);
    assert.equal((await request(server.origin, "/api/v1/provider-auth", { method: "POST", headers, body })).status, 200);
    assert.deepEqual(forwarded, [{ action: "provider-auth.start", providerRef: "provider.safe" }]);
    const readJob = await request(server.origin, "/api/v1/provider-auth/jobs/authjob.safe", { headers: readHeaders });
    assert.equal(readJob.status, 200); assert.equal(JSON.parse(readJob.body).jobRef, "authjob.safe");
    assert.equal((await request(server.origin, "/api/v1/provider-auth/jobs/not%2Fsafe", { headers: readHeaders })).status, 400);
  });

  it("keeps MCP toggles and OAuth jobs behind session-scoped CSRF authority", async () => {
    const commands = [], job = { schemaVersion: 1, version: "piagent-mcp-auth-job-v1", jobRef: "mcp_auth.safe", state: "running" };
    const server = await start({ executeSessionConnection: (command) => { commands.push(command); return job; },
      readMcpAuthJob: (jobRef) => ({ ...job, jobRef }), cancelMcpAuthJob: (jobRef) => ({ ...job, jobRef, state: "cancelled" }) });
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    const headers = { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json", "X-Piagent-CSRF": session.csrfToken };
    const command = { action: "mcp.oauth", sessionRef: "session.safe", connectionRef: "mcp.safe" };
    assert.equal((await request(server.origin, "/api/v1/session-connections", { method: "POST",
      headers: { ...headers, "X-Piagent-CSRF": "wrong" }, body: JSON.stringify(command) })).status, 403);
    const accepted = await request(server.origin, "/api/v1/session-connections", { method: "POST", headers, body: JSON.stringify(command) });
    assert.equal(accepted.status, 200); assert.equal(JSON.parse(accepted.body).jobRef, "mcp_auth.safe"); assert.deepEqual(commands, [command]);
    assert.equal((await request(server.origin, "/api/v1/mcp-auth/jobs/mcp_auth.safe")).status, 401);
    const read = await request(server.origin, "/api/v1/mcp-auth/jobs/mcp_auth.safe", { headers: { Cookie: cookie, Origin: server.origin } });
    assert.equal(read.status, 200); assert.equal(JSON.parse(read.body).jobRef, "mcp_auth.safe");
    const cancelled = await request(server.origin, "/api/v1/mcp-auth/jobs/mcp_auth.safe/cancel", { method: "POST",
      headers: { Cookie: cookie, Origin: server.origin, "X-Piagent-CSRF": session.csrfToken } });
    assert.equal(cancelled.status, 200); assert.equal(JSON.parse(cancelled.body).state, "cancelled");
  });

  it("keeps typed runtime controls behind exact Origin, cookie, CSRF and body bounds", async () => {
    const commands = [];
    const server = await start({ executeRuntimeCommand: (command) => { commands.push(command); return { messageType: "receipt", resultCode: "completed" }; } });
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    const headers = { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json", "X-Piagent-CSRF": session.csrfToken };
    const command = { schemaVersion: 1, version: "piagent-runtime-command-v1", messageType: "command", requestId: "runtime_request_01",
      sessionRef: "session_01", expectedSessionRevision: "session_revision_01", action: "runtime.status", argument: null, confirmed: false };
    assert.equal((await request(server.origin, "/api/v1/runtime-commands", { method: "POST",
      headers: { ...headers, "X-Piagent-CSRF": "wrong" }, body: JSON.stringify(command) })).status, 403);
    assert.equal((await request(server.origin, "/api/v1/runtime-commands", { method: "POST",
      headers: { ...headers, Origin: "http://attacker.invalid" }, body: JSON.stringify(command) })).status, 403);
    const accepted = await request(server.origin, "/api/v1/runtime-commands", { method: "POST", headers, body: JSON.stringify(command) });
    assert.equal(accepted.status, 200); assert.equal(JSON.parse(accepted.body).resultCode, "completed");
    assert.deepEqual(commands, [command]);
    assert.equal((await request(server.origin, "/api/v1/runtime-commands", { method: "POST", headers,
      body: JSON.stringify({ padding: "x".repeat(70_000) }) })).status, 413);
  });

  it("authenticates attachment staging separately and caps bytes before forwarding", async () => {
    const forwarded = [];
    const server = await start({ executeAttachment: async (command) => { forwarded.push(command); return { messageType: "stage-receipt", resultCode: "staged" }; } });
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    const headers = { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json", "X-Piagent-CSRF": session.csrfToken };
    const body = JSON.stringify({ messageType: "stage-command", file: { dataBase64: "AA==" } });
    assert.equal((await request(server.origin, "/api/v1/attachments", { method: "POST", headers: { ...headers, "X-Piagent-CSRF": "wrong" }, body })).status, 403);
    const accepted = await request(server.origin, "/api/v1/attachments", { method: "POST", headers, body });
    assert.equal(accepted.status, 200); assert.deepEqual(forwarded, [{ messageType: "stage-command", file: { dataBase64: "AA==" } }]);
    const oversized = JSON.stringify({ dataBase64: "A".repeat(11_250_000) });
    assert.equal((await request(server.origin, "/api/v1/attachments", { method: "POST", headers, body: oversized })).status, 413);
    assert.equal(forwarded.length, 1);
  });

  it("binds approval decisions to one opaque ref, Origin and CSRF", async () => {
    const forwarded = [];
    const server = await start({ executeApproval: async (approvalRef, decision) => {
      forwarded.push({ approvalRef, decision }); return { recordType: "receipt", state: "resolved" };
    } });
    const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) }) });
    const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    const headers = { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json", "X-Piagent-CSRF": session.csrfToken };
    const body = JSON.stringify({ recordType: "decision", decision: "deny" });
    assert.equal((await request(server.origin, "/api/v1/approvals/approval.test/decision", { method: "POST", headers: { ...headers, "X-Piagent-CSRF": "wrong" }, body })).status, 403);
    assert.equal((await request(server.origin, "/api/v1/approvals/../decision", { method: "POST", headers, body })).status, 405);
    const accepted = await request(server.origin, "/api/v1/approvals/approval.test/decision", { method: "POST", headers, body });
    assert.equal(accepted.status, 200); assert.deepEqual(JSON.parse(accepted.body), { recordType: "receipt", state: "resolved" });
    assert.deepEqual(forwarded, [{ approvalRef: "approval.test", decision: { recordType: "decision", decision: "deny" } }]);
    assert.equal((await request(server.origin, "/api/v1/approvals/approval.test/decision", { method: "POST", headers,
      body: JSON.stringify({ padding: "x".repeat(70_000) }) })).status, 413); assert.equal(forwarded.length, 1);
  });

  it("fails Host, Origin, content type, oversized body, expiry and bootstrap rate closed", async () => {
    const server = await start({ bootstrapTtlMs: 60_000 });
    const capability = bootstrapValue(server.launchUrl), body = JSON.stringify({ capability });
    assert.equal((await request(server.origin, "/", { headers: { Host: "attacker.invalid" } })).status, 421);
    assert.equal((await request(server.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: "http://attacker.invalid", "Content-Type": "application/json" }, body
    })).status, 403);
    assert.equal((await request(server.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "text/plain" }, body
    })).status, 415);
    const oversized = JSON.stringify({ capability, padding: "x".repeat(5_000) });
    assert.equal((await request(server.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: oversized
    })).status, 413);
    for (let attempt = 0; attempt < 6; attempt += 1) await request(server.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: "{}"
    });
    assert.equal((await request(server.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: "{}"
    })).status, 429);

    const expired = await start({ bootstrapTtlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await request(expired.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: expired.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ capability: bootstrapValue(expired.launchUrl) })
    })).status, 403);
  });

  it("rate-limits controls per authenticated browser session instead of locking every localhost client", async () => {
    const server = await start({ executeControl: async () => ({ ok: true }) });
    const open = async (launchUrl) => {
      const exchange = await request(server.origin, "/api/v1/bootstrap", { method: "POST",
        headers: { Origin: server.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ capability: bootstrapValue(launchUrl) }) });
      const session = JSON.parse(exchange.body), cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
      return { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json", "X-Piagent-CSRF": session.csrfToken };
    };
    const first = await open(server.launchUrl), body = JSON.stringify({ action: "chat.send" });
    for (let attempt = 0; attempt < 60; attempt += 1) assert.equal((await request(server.origin, "/api/v1/chat/messages", {
      method: "POST", headers: first, body })).status, 200);
    assert.equal((await request(server.origin, "/api/v1/chat/messages", { method: "POST", headers: first, body })).status, 429);

    const second = await open(server.issueLaunchUrl());
    assert.equal((await request(server.origin, "/api/v1/chat/messages", { method: "POST", headers: second, body })).status, 200);
  });

  it("invalidates browser sessions on restart without touching the capability reader", async () => {
    let reads = 0;
    const first = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => { reads += 1; return capabilities; } });
    servers.add(first);
    const exchange = await request(first.origin, "/api/v1/bootstrap", {
      method: "POST", headers: { Origin: first.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ capability: bootstrapValue(first.launchUrl) })
    });
    const cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
    await close(first);
    const second = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => { reads += 1; return capabilities; } });
    servers.add(second);
    assert.equal((await request(second.origin, "/api/v1/capabilities", { headers: { Cookie: cookie } })).status, 401);
    assert.equal(reads, 0);
  });
});

describe("Piagent WebUI local auth and static boundaries", () => {
  it("keeps one-time and expiry state process-local", () => {
    const authority = new SessionAuthority({ now: 100, bootstrapTtlMs: 10, sessionTtlMs: 20 });
    const session = authority.exchange(authority.bootstrapCapability, 105);
    assert.ok(session);
    const signedCookie = authority.cookieHeader(session).split(";", 1)[0];
    assert.equal(signedCookie.includes(session.csrf), false);
    assert.equal(authority.authenticate({ headers: { cookie: signedCookie } }, 105)?.id, session.id);
    const tamperedCookie = `${signedCookie.slice(0, -1)}${signedCookie.endsWith("a") ? "b" : "a"}`;
    assert.equal(authority.authenticate({ headers: { cookie: tamperedCookie } }, 105), null);
    assert.equal(authority.exchange(authority.bootstrapCapability, 106), null);
    const renewed = authority.issueBootstrapCapability(106);
    assert.ok(authority.exchange(renewed, 107));
    assert.equal(authority.exchange(renewed, 108), null);
    authority.invalidate();
    const expired = new SessionAuthority({ now: 100, bootstrapTtlMs: 10 });
    assert.equal(expired.exchange(expired.bootstrapCapability, 111), null);
  });

  it("rejects symlinks, unsupported assets and oversized static files before serving", () => {
    const symlinkRoot = staticRoot();
    fs.symlinkSync(path.join(symlinkRoot, "index.html"), path.join(symlinkRoot, "assets/link.js"));
    assert.throws(() => loadStaticBundle(symlinkRoot), /static-symlink-rejected/);
    const unsupported = staticRoot();
    fs.writeFileSync(path.join(unsupported, "secret.txt"), "not bundled");
    assert.throws(() => loadStaticBundle(unsupported), /static-asset-invalid/);
    const oversized = staticRoot();
    fs.writeFileSync(path.join(oversized, "assets/large.js"), Buffer.alloc(2 * 1024 * 1024 + 1));
    assert.throws(() => loadStaticBundle(oversized), /static-asset-invalid/);
  });
});

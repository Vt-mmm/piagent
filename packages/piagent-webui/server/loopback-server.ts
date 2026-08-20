import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { errorResponse, applySecurityHeaders, jsonResponse } from "./http-security.ts";
import { ReadModelNotFound, type WebUiReadModelProvider } from "./read-model-provider.ts";
import { routeReadOnlyRequest } from "./read-only-router.ts";
import { SessionAuthority } from "./session-auth.ts";
import { SseHub } from "./sse-hub.ts";
import { loadStaticBundle, type StaticAsset } from "./static-bundle.ts";
import { attachGatewayWebSocket, type GatewayProtocolHandler } from "./gateway-websocket.ts";

const MAX_BOOTSTRAP_BODY_BYTES = 4_096;
const MAX_CONTROL_BODY_BYTES = 70_000;
const MAX_ATTACHMENT_BODY_BYTES = 11_250_000;
const REQUESTS_PER_MINUTE = 120;
const BOOTSTRAPS_PER_MINUTE = 8;
const CONTROLS_PER_MINUTE = 60;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const CURSOR = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

type ReadCapabilities = () => unknown | Promise<unknown>;
type RateState = { windowStart: number; requests: number; bootstraps: number };
type ControlRateState = { windowStart: number; controls: number };

export type LoopbackServer = {
  origin: string;
  launchUrl: string;
  issueLaunchUrl(): string;
  close(): Promise<void>;
};

function requestBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maximumBytes) { failed = true; reject(new Error("body-limit")); }
      else chunks.push(chunk);
    });
    request.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    request.on("error", (error) => { if (!failed) reject(error); });
  });
}

function serveAsset(response: ServerResponse, asset: StaticAsset): void {
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", asset.contentType);
  response.setHeader("Content-Length", asset.body.length);
  response.end(asset.body);
}

export async function startLoopbackServer(options: {
  staticRoot: string;
  mode?: "session" | "gateway";
  readCapabilities: ReadCapabilities;
  readSessionCatalog?: () => unknown | Promise<unknown>;
  readSessionCreationOptions?: () => unknown | Promise<unknown>;
  readSessionModel?: (sessionRef: string) => WebUiReadModelProvider | Promise<WebUiReadModelProvider>;
  executeSessionAttachment?: (sessionRef: string, command: unknown) => unknown | Promise<unknown>;
  readSessionConnections?: (sessionRef: string) => unknown | Promise<unknown>;
  executeSessionConnection?: (command: unknown) => unknown | Promise<unknown>;
  executeRuntimeCommand?: (command: unknown) => unknown | Promise<unknown>;
  readMcpAuthJob?: (jobRef: string) => unknown | Promise<unknown>;
  cancelMcpAuthJob?: (jobRef: string) => unknown | Promise<unknown>;
  readProviderAuthCatalog?: () => unknown | Promise<unknown>;
  readProviderAuthJob?: (jobRef: string) => unknown | Promise<unknown>;
  executeProviderAuth?: (command: unknown) => unknown | Promise<unknown>;
  executeProjectImport?: () => unknown | Promise<unknown>;
  gatewayProtocol?: GatewayProtocolHandler;
  readModel?: WebUiReadModelProvider;
  executeControl?: (command: unknown) => unknown | Promise<unknown>;
  executeAttachment?: (command: unknown) => unknown | Promise<unknown>;
  executeApproval?: (approvalRef: string, decision: unknown) => unknown | Promise<unknown>;
  bootstrapTtlMs?: number;
  sessionTtlMs?: number;
}): Promise<LoopbackServer> {
  const assets = new Map(loadStaticBundle(options.staticRoot));
  const styleNonce = randomBytes(16).toString("base64");
  const indexAsset = assets.get("/");
  if (indexAsset) assets.set("/", { ...indexAsset, body: Buffer.from(indexAsset.body.toString("utf8")
    .replace("__PIAGENT_CSP_NONCE__", styleNonce)
    .replace("__PIAGENT_WEBUI_MODE__", options.mode ?? "session")) });
  const auth = new SessionAuthority({ bootstrapTtlMs: options.bootstrapTtlMs, sessionTtlMs: options.sessionTtlMs });
  const sse = options.readModel ? new SseHub(options.readModel) : null;
  const rates = new Map<string, RateState>();
  const controlRates = new Map<string, ControlRateState>();
  const consumeControl = (sessionId: string, now: number): boolean => {
    for (const [id, value] of controlRates) if (now - value.windowStart >= 60_000) controlRates.delete(id);
    const value = controlRates.get(sessionId) ?? { windowStart: now, controls: 0 };
    if (now - value.windowStart >= 60_000) Object.assign(value, { windowStart: now, controls: 0 });
    value.controls += 1; controlRates.set(sessionId, value);
    while (controlRates.size > 64) controlRates.delete(controlRates.keys().next().value as string);
    return value.controls <= CONTROLS_PER_MINUTE;
  };
  let origin = "";
  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response, styleNonce);
    const host = String(request.headers.host ?? "");
    if (!origin || host !== origin.slice("http://".length)) return errorResponse(response, 421, "host-mismatch");
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== origin) return errorResponse(response, 403, "origin-mismatch");
    const remote = request.socket.remoteAddress ?? "unknown", now = Date.now();
    // A browser session is already a launch-scoped authenticated capability.
    // Charging every tab and every prior launch to one localhost IP lets a
    // refresh or an unauthenticated local process lock out the active operator.
    const browserSession = auth.authenticate(request, now);
    const rateKey = browserSession ? `${remote}:${browserSession.id}` : `remote:${remote}`;
    for (const [key, value] of rates) if (now - value.windowStart >= 60_000) rates.delete(key);
    const rate = rates.get(rateKey) ?? { windowStart: now, requests: 0, bootstraps: 0 };
    if (now - rate.windowStart >= 60_000) Object.assign(rate, { windowStart: now, requests: 0, bootstraps: 0 });
    rate.requests += 1; rates.set(rateKey, rate);
    while (rates.size > 128) rates.delete(rates.keys().next().value as string);
    if (rate.requests > REQUESTS_PER_MINUTE) return errorResponse(response, 429, "rate-limit");
    let url: URL;
    try { url = new URL(request.url ?? "/", origin); }
    catch { return errorResponse(response, 400, "invalid-url"); }
    if (url.hash || url.username || url.password || url.origin !== origin) return errorResponse(response, 400, "invalid-url");

    if (request.method === "POST" && url.pathname === "/api/v1/bootstrap") {
      rate.bootstraps += 1;
      if (rate.bootstraps > BOOTSTRAPS_PER_MINUTE) return errorResponse(response, 429, "bootstrap-rate-limit");
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let value: unknown;
      try { value = JSON.parse((await requestBody(request, MAX_BOOTSTRAP_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-bootstrap"); }
      const capability = value && typeof value === "object" ? (value as Record<string, unknown>).capability : null;
      const session = typeof capability === "string" ? auth.exchange(capability) : null;
      if (!session) return errorResponse(response, 403, "bootstrap-rejected");
      response.setHeader("Set-Cookie", auth.cookieHeader(session));
      return jsonResponse(response, 200, { authenticated: true, csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/browser-session") {
      const session = auth.authenticate(request);
      if (!session) return errorResponse(response, 401, "authentication-required");
      return jsonResponse(response, 200, { authenticated: true, csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() });
    }

    if (request.method === "POST" && ["/api/v1/chat/messages", "/api/v1/session-options", "/api/v1/lifecycle",
      "/api/v1/control/resume-and-continue", "/api/v1/reviews", "/api/v1/source-mutations", "/api/v1/source-handoffs"].includes(url.pathname) && options.executeControl) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let command: unknown;
      try { command = JSON.parse((await requestBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-control-command"); }
      try { return jsonResponse(response, 200, await options.executeControl(command)); }
      catch { return errorResponse(response, 503, "control-runtime-unavailable"); }
    }

    if (request.method === "POST" && url.pathname === "/api/v1/projects/import" && options.executeProjectImport) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let command: unknown;
      try { command = JSON.parse((await requestBody(request, MAX_BOOTSTRAP_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-project-import"); }
      if (!command || typeof command !== "object" || Array.isArray(command)
        || Object.keys(command).length !== 1 || (command as Record<string, unknown>).action !== "project.import") {
        return errorResponse(response, 400, "invalid-project-import");
      }
      try { return jsonResponse(response, 200, await options.executeProjectImport()); }
      catch (error) {
        const code = error instanceof Error ? error.message : "project-import-unavailable";
        return errorResponse(response, code === "project-import-cancelled" ? 409 : code.includes("invalid") ? 400 : 503, code);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/v1/provider-auth" && options.executeProviderAuth) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let command: unknown;
      try { command = JSON.parse((await requestBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-provider-auth-command"); }
      try { return jsonResponse(response, 200, await options.executeProviderAuth(command)); }
      catch (error) {
        const code = error instanceof Error ? error.message : "provider-auth-unavailable";
        return errorResponse(response, code.includes("not-found") ? 404 : code.includes("stale") || code.includes("conflict") ? 409
          : code.includes("invalid") ? 400 : 503, code);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/v1/session-connections" && options.executeSessionConnection) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let command: unknown;
      try { command = JSON.parse((await requestBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-session-connection-command"); }
      try { return jsonResponse(response, 200, await options.executeSessionConnection(command)); }
      catch (error) {
        const code = error instanceof Error ? error.message : "session-connection-unavailable";
        return errorResponse(response, code.includes("not-found") ? 404 : code.includes("invalid") ? 400 : code.includes("supported") ? 409 : 503, code);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/v1/runtime-commands" && options.executeRuntimeCommand) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let command: unknown;
      try { command = JSON.parse((await requestBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-runtime-command"); }
      try { return jsonResponse(response, 200, await options.executeRuntimeCommand(command)); }
      catch (error) {
        const code = error instanceof Error ? error.message : "runtime-command-unavailable";
        return errorResponse(response, code.includes("invalid") ? 400 : 503, code);
      }
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/v1/mcp-auth/jobs/") && url.pathname.endsWith("/cancel") && options.cancelMcpAuthJob) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "mutation-authority-rejected");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      const jobRef = url.pathname.slice("/api/v1/mcp-auth/jobs/".length, -"/cancel".length);
      if (!CURSOR.test(jobRef) || jobRef.includes("/") || url.search) return errorResponse(response, 400, "invalid-mcp-auth-job-ref");
      try { return jsonResponse(response, 200, await options.cancelMcpAuthJob(jobRef)); }
      catch (error) { return errorResponse(response, error instanceof Error && error.message.includes("not-found") ? 404 : 503, "mcp-auth-job-unavailable"); }
    }

    if (request.method === "POST" && url.pathname === "/api/v1/attachments" && options.executeAttachment) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let command: unknown;
      try { command = JSON.parse((await requestBody(request, MAX_ATTACHMENT_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-attachment-command"); }
      try { return jsonResponse(response, 200, await options.executeAttachment(command)); }
      catch { return errorResponse(response, 503, "attachment-runtime-unavailable"); }
    }

    // The Gateway drives many sessions, so an attachment has to name the one it
    // belongs to in the path. The body is the same bounded stage/discard command
    // the single-session route takes, and every guard in front of it is the same.
    if (request.method === "POST" && url.pathname.startsWith("/api/v1/sessions/") && url.pathname.endsWith("/attachments")
      && options.executeSessionAttachment) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      const sessionRef = url.pathname.slice("/api/v1/sessions/".length, -"/attachments".length);
      if (!CURSOR.test(sessionRef) || sessionRef.includes("/")) return errorResponse(response, 400, "invalid-session-attachment-ref");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      let command: unknown;
      try { command = JSON.parse((await requestBody(request, MAX_ATTACHMENT_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-attachment-command"); }
      try { return jsonResponse(response, 200, await options.executeSessionAttachment(sessionRef, command)); }
      catch { return errorResponse(response, 503, "attachment-runtime-unavailable"); }
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/v1/approvals/") && url.pathname.endsWith("/decision") && options.executeApproval) {
      if (requestOrigin !== origin) return errorResponse(response, 403, "origin-required");
      const mutationSession = auth.authorizeMutation(request);
      if (!mutationSession) return errorResponse(response, 403, "mutation-authority-rejected");
      if (!consumeControl(mutationSession.id, now)) return errorResponse(response, 429, "control-rate-limit");
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return errorResponse(response, 415, "content-type");
      const approvalRef = url.pathname.slice("/api/v1/approvals/".length, -"/decision".length);
      if (!CURSOR.test(approvalRef) || approvalRef.includes("/")) return errorResponse(response, 400, "invalid-approval-ref");
      let decision: unknown;
      try { decision = JSON.parse((await requestBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8")); }
      catch (error) { return errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-approval-decision"); }
      try { return jsonResponse(response, 200, await options.executeApproval(approvalRef, decision)); }
      catch (error) {
        const code = error instanceof Error ? error.message : "approval-runtime-unavailable";
        return errorResponse(response, code.includes("not-pending") || code.includes("resolved") || code.includes("expired") ? 409 : code.includes("invalid") ? 400 : 503, code);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/v1/capabilities") {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      try { return jsonResponse(response, 200, await options.readCapabilities()); }
      catch { return errorResponse(response, 503, "capabilities-unavailable"); }
    }

    if (request.method === "GET" && url.pathname === "/api/v1/session-catalog" && options.readSessionCatalog) {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      if (url.search) return errorResponse(response, 400, "invalid-catalog-query");
      try { return jsonResponse(response, 200, await options.readSessionCatalog()); }
      catch { return errorResponse(response, 503, "session-catalog-unavailable"); }
    }

    if (request.method === "GET" && url.pathname === "/api/v1/session-creation-options" && options.readSessionCreationOptions) {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      if (url.search) return errorResponse(response, 400, "invalid-session-creation-query");
      try {
        const value = await options.readSessionCreationOptions();
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_JSON_RESPONSE_BYTES) return errorResponse(response, 503, "projection-response-limit");
        return jsonResponse(response, 200, value);
      }
      catch { return errorResponse(response, 503, "session-creation-options-unavailable"); }
    }

    if (request.method === "GET" && url.pathname === "/api/v1/provider-auth" && options.readProviderAuthCatalog) {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      if (url.search) return errorResponse(response, 400, "invalid-provider-auth-query");
      try { return jsonResponse(response, 200, await options.readProviderAuthCatalog()); }
      catch { return errorResponse(response, 503, "provider-auth-catalog-unavailable"); }
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/v1/provider-auth/jobs/") && options.readProviderAuthJob) {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      if (url.search) return errorResponse(response, 400, "invalid-provider-auth-job-query");
      const jobRef = url.pathname.slice("/api/v1/provider-auth/jobs/".length);
      if (!CURSOR.test(jobRef) || jobRef.includes("/")) return errorResponse(response, 400, "invalid-provider-auth-job-ref");
      try { return jsonResponse(response, 200, await options.readProviderAuthJob(jobRef)); }
      catch (error) { return errorResponse(response, error instanceof Error && error.message.includes("not-found") ? 404 : 503, "provider-auth-job-unavailable"); }
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/v1/mcp-auth/jobs/") && options.readMcpAuthJob) {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      if (url.search) return errorResponse(response, 400, "invalid-mcp-auth-job-query");
      const jobRef = url.pathname.slice("/api/v1/mcp-auth/jobs/".length);
      if (!CURSOR.test(jobRef) || jobRef.includes("/")) return errorResponse(response, 400, "invalid-mcp-auth-job-ref");
      try { return jsonResponse(response, 200, await options.readMcpAuthJob(jobRef)); }
      catch (error) { return errorResponse(response, error instanceof Error && error.message.includes("not-found") ? 404 : 503, "mcp-auth-job-unavailable"); }
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/v1/sessions/")
      && (options.readSessionModel || options.readSessionConnections)) {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      const rest = url.pathname.slice("/api/v1/sessions/".length);
      const separator = rest.indexOf("/inspection/");
      const sessionRef = separator >= 0 ? rest.slice(0, separator) : "";
      const inspectionPath = separator >= 0 ? rest.slice(separator + "/inspection".length) : "";
      if (!CURSOR.test(sessionRef) || sessionRef.includes("/") || !inspectionPath.startsWith("/")) {
        return errorResponse(response, 400, "invalid-session-inspection-ref");
      }
      try {
        if (inspectionPath === "/connections") {
          if (url.search || !options.readSessionConnections) return errorResponse(response, 404, "inspection-route-not-found");
          const value = await options.readSessionConnections(sessionRef);
          const bytes = Buffer.byteLength(JSON.stringify(value));
          if (bytes > MAX_JSON_RESPONSE_BYTES) return errorResponse(response, 503, "projection-response-limit");
          return jsonResponse(response, 200, value);
        }
        if (!options.readSessionModel) return errorResponse(response, 404, "inspection-route-not-found");
        const provider = await options.readSessionModel(sessionRef);
        const scoped = new URL(url.href);
        scoped.pathname = `/api/v1${inspectionPath}`;
        const result = await routeReadOnlyRequest(scoped, provider);
        if (!result.handled) return errorResponse(response, 404, "inspection-route-not-found");
        let bytes: number;
        try { bytes = Buffer.byteLength(JSON.stringify(result.value)); }
        catch { return errorResponse(response, 503, "projection-unavailable"); }
        if (bytes > MAX_JSON_RESPONSE_BYTES) return errorResponse(response, 503, "projection-response-limit");
        return jsonResponse(response, result.status, result.value);
      } catch (error) {
        return errorResponse(response, error instanceof ReadModelNotFound ? 404 : 503,
          error instanceof ReadModelNotFound ? "opaque-ref-not-found" : "projection-unavailable");
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/v1/") && options.readModel) {
      if (!auth.authenticate(request)) return errorResponse(response, 401, "authentication-required");
      if (url.pathname === "/api/v1/events") {
        if ([...url.searchParams.keys()].some((key) => key !== "after") || url.searchParams.getAll("after").length > 1) return errorResponse(response, 400, "invalid-event-cursor");
        const hasQuery = url.searchParams.has("after"), query = url.searchParams.get("after"), header = String(request.headers["last-event-id"] ?? "") || null;
        if ((hasQuery && (!query || !CURSOR.test(query))) || (header && !CURSOR.test(header)) || (query && header && query !== header)) return errorResponse(response, 400, "invalid-event-cursor");
        try { await sse?.open(request, response, query ?? header); }
        catch { if (!response.headersSent) errorResponse(response, 503, "event-replay-unavailable"); else response.destroy(); }
        return;
      }
      try {
        const result = await routeReadOnlyRequest(url, options.readModel);
        if (result.handled) {
          let bytes: number;
          try { bytes = Buffer.byteLength(JSON.stringify(result.value)); } catch { return errorResponse(response, 503, "projection-unavailable"); }
          if (bytes > MAX_JSON_RESPONSE_BYTES) return errorResponse(response, 503, "projection-response-limit");
          return jsonResponse(response, result.status, result.value);
        }
      } catch (error) {
        return errorResponse(response, error instanceof ReadModelNotFound ? 404 : 503,
          error instanceof ReadModelNotFound ? "opaque-ref-not-found" : "projection-unavailable");
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(response, 405, "method-not-allowed");
    const asset = assets.get(url.pathname);
    if (!asset || url.search) return errorResponse(response, 404, "not-found");
    if (request.method === "HEAD") { response.statusCode = 200; response.setHeader("Content-Type", asset.contentType); return response.end(); }
    serveAsset(response, asset);
  });
  const gatewaySocket = options.gatewayProtocol ? attachGatewayWebSocket({
    server, origin: () => origin, authority: auth, protocol: options.gatewayProtocol
  }) : null;
  server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") { server.close(); throw new Error("loopback-bind-failed"); }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    launchUrl: `${origin}/#bootstrap=${auth.bootstrapCapability}`,
    issueLaunchUrl: () => `${origin}/#bootstrap=${auth.issueBootstrapCapability()}`,
    close: async () => {
      auth.invalidate();
      sse?.close();
      await gatewaySocket?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

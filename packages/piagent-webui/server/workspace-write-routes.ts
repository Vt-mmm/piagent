import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionAuthority } from "./session-auth.ts";
import { errorResponse, jsonResponse, requestBody } from "./http-security.ts";

export type WorkspaceWriteRoutes = {
  state(sessionRef: string): unknown | Promise<unknown>;
  execute(sessionRef: string, command: unknown): unknown | Promise<unknown>;
};
type Context = { request: IncomingMessage; response: ServerResponse; url: URL; origin: string;
  requestOrigin: string | undefined; auth: SessionAuthority; now: number; consumeControl(id: string, now: number): boolean };
export async function routeWorkspaceWrite(context: Context, handler?: WorkspaceWriteRoutes): Promise<boolean> {
  const { request, response, url, auth, requestOrigin, origin, now, consumeControl } = context;
  const match = /^\/api\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._~-]{0,159})\/workspace\/write$/.exec(url.pathname);
  if (!match) return false;
  if (!auth.authenticate(request)) { errorResponse(response, 401, "authentication-required"); return true; }
  if (url.search) { errorResponse(response, 400, "invalid-workspace-write-query"); return true; }
  if (!["GET", "POST"].includes(request.method ?? "")) { errorResponse(response, 405, "method-not-allowed"); return true; }
  let command: unknown;
  if (request.method === "POST") {
    if (requestOrigin !== origin) { errorResponse(response, 403, "origin-required"); return true; }
    const session = auth.authorizeMutation(request);
    if (!session) { errorResponse(response, 403, "mutation-authority-rejected"); return true; }
    if (!consumeControl(session.id, now)) { errorResponse(response, 429, "control-rate-limit"); return true; }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      errorResponse(response, 415, "content-type"); return true;
    }
    // JSON escaping may expand one permitted UTF-8 text byte to six bytes.
    try { command = JSON.parse((await requestBody(request, 6 * 1_048_576 + 8192)).toString("utf8")); }
    catch (error) { errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-workspace-write-command"); return true; }
    if ((command as { identity?: { sessionRef?: unknown } } | null)?.identity?.sessionRef !== match[1]) {
      errorResponse(response, 400, "workspace-session-mismatch"); return true;
    }
  }
  if (!handler) { errorResponse(response, 503, "workspace-write-unavailable"); return true; }
  try { jsonResponse(response, 200, request.method === "GET" ? await handler.state(match[1]) : await handler.execute(match[1], command)); }
  catch (error) { errorResponse(response, (error as Error).message === "invalid-workspace-write-command" ? 400 : 503, "workspace-write-unavailable"); }
  return true;
}

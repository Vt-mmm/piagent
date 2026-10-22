import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionAuthority } from "./session-auth.ts";
import { errorResponse, jsonResponse, requestBody } from "./http-security.ts";

export type CheckpointRoutes = {
  state(sessionRef: string): unknown | Promise<unknown>;
  preview(sessionRef: string, target: string): unknown | Promise<unknown>;
  execute(sessionRef: string, command: unknown): unknown | Promise<unknown>;
};
type Context = { request: IncomingMessage; response: ServerResponse; url: URL; origin: string;
  requestOrigin: string | undefined; auth: SessionAuthority; now: number; consumeControl(id: string, now: number): boolean };
export async function routeCheckpoint(context: Context, handler?: CheckpointRoutes): Promise<boolean> {
  const { request, response, url, auth, requestOrigin, origin, now, consumeControl } = context;
  const match = /^\/api\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._~-]{0,159})\/checkpoints(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))?$/.exec(url.pathname);
  if (!match) return false;
  if (!auth.authenticate(request)) { errorResponse(response, 401, "authentication-required"); return true; }
  if (url.search) { errorResponse(response, 400, "invalid-checkpoint-query"); return true; }
  if (!["GET", "POST"].includes(request.method ?? "") || match[2] && request.method !== "GET") { errorResponse(response, 405, "method-not-allowed"); return true; }
  let command: unknown;
  if (request.method === "POST") {
    if (requestOrigin !== origin) { errorResponse(response, 403, "origin-required"); return true; }
    const session = auth.authorizeMutation(request);
    if (!session) { errorResponse(response, 403, "mutation-authority-rejected"); return true; }
    if (!consumeControl(session.id, now)) { errorResponse(response, 429, "control-rate-limit"); return true; }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      errorResponse(response, 415, "content-type"); return true;
    }
    try { command = JSON.parse((await requestBody(request, 8192)).toString("utf8")); }
    catch (error) { errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-checkpoint-command"); return true; }
    if ((command as { identity?: { sessionRef?: unknown } } | null)?.identity?.sessionRef !== match[1]) {
      errorResponse(response, 400, "checkpoint-session-mismatch"); return true;
    }
  }
  if (!handler) { errorResponse(response, 503, "checkpoint-unavailable"); return true; }
  try { jsonResponse(response, 200, request.method === "GET" ? (match[2] ? await handler.preview(match[1], match[2]) : await handler.state(match[1])) : await handler.execute(match[1], command)); }
  catch (error) { errorResponse(response, (error as Error).message === "invalid-checkpoint-command" ? 400 : 503, "checkpoint-unavailable"); }
  return true;
}

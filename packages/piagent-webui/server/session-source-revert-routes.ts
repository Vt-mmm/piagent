import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionAuthority } from "./session-auth.ts";
import { errorResponse, jsonResponse, requestBody } from "./http-security.ts";

export type SessionSourceRevertRoutes = {
  sources?(sessionRef: string): unknown | Promise<unknown>;
  diff?(sessionRef: string, fileRef: string): unknown | Promise<unknown>;
  preview(sessionRef: string, fileRef: string, hunkRef: string | null): unknown | Promise<unknown>;
  execute(sessionRef: string, command: unknown): unknown | Promise<unknown>;
};
type Context = { request: IncomingMessage; response: ServerResponse; url: URL; origin: string;
  requestOrigin: string | undefined; auth: SessionAuthority; now: number; consumeControl(id: string, now: number): boolean };
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
export async function routeSessionSourceRevert(context: Context, handler?: SessionSourceRevertRoutes): Promise<boolean> {
  const { request, response, url, auth, requestOrigin, origin, now, consumeControl } = context;
  const review = /^\/api\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._~-]{0,159})\/source-review(?:\/([A-Za-z0-9][A-Za-z0-9._~-]{0,159}))?$/.exec(url.pathname);
  if (review) {
    if (!auth.authenticate(request)) { errorResponse(response, 401, "authentication-required"); return true; }
    if (request.method !== "GET") { errorResponse(response, 405, "method-not-allowed"); return true; }
    if (url.search) { errorResponse(response, 400, "invalid-source-review-query"); return true; }
    try {
      const read = review[2] ? handler?.diff : handler?.sources;
      if (!read) throw new Error("unavailable");
      jsonResponse(response, 200, await read(review[1], review[2]));
    } catch { errorResponse(response, 503, "source-review-unavailable"); }
    return true;
  }
  const match = /^\/api\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._~-]{0,159})\/source-reverts(?:\/([A-Za-z0-9][A-Za-z0-9._~-]{0,159}))?$/.exec(url.pathname);
  if (!match) return false;
  if (!auth.authenticate(request)) { errorResponse(response, 401, "authentication-required"); return true; }
  const reading = request.method === "GET" && !!match[2], writing = request.method === "POST" && !match[2];
  if (!reading && !writing) { errorResponse(response, 405, "method-not-allowed"); return true; }
  const hunkRef = url.searchParams.get("hunkRef");
  if (writing && url.search || reading && ([...url.searchParams.keys()].some(key => key !== "hunkRef")
    || url.searchParams.getAll("hunkRef").length > 1 || hunkRef !== null && !REF.test(hunkRef))) {
    errorResponse(response, 400, "invalid-source-revert-query"); return true;
  }
  let command: unknown;
  if (writing) {
    if (requestOrigin !== origin) { errorResponse(response, 403, "origin-required"); return true; }
    const session = auth.authorizeMutation(request);
    if (!session) { errorResponse(response, 403, "mutation-authority-rejected"); return true; }
    if (!consumeControl(session.id, now)) { errorResponse(response, 429, "control-rate-limit"); return true; }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      errorResponse(response, 415, "content-type"); return true;
    }
    try { command = JSON.parse((await requestBody(request, 70_000)).toString("utf8")); }
    catch (error) { errorResponse(response, (error as Error).message === "body-limit" ? 413 : 400, "invalid-source-revert-command"); return true; }
  }
  if (!handler) { errorResponse(response, 503, "source-revert-unavailable"); return true; }
  try { jsonResponse(response, 200, reading ? await handler.preview(match[1], match[2], hunkRef) : await handler.execute(match[1], command)); }
  catch { errorResponse(response, 503, "source-revert-unavailable"); }
  return true;
}

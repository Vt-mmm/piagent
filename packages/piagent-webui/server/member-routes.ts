import type { IncomingMessage, ServerResponse } from "node:http";

import { errorResponse, jsonResponse, requestBody } from "./http-security.ts";
import type { SessionAuthority } from "./session-auth.ts";

// Requests a member makes beside a conversation: answering the main agent's
// questions, and keeping Piagent itself up to date. Reads need the browser
// session; every change also needs this origin, the session's CSRF token and
// a share of the control rate.
const MAX_CONTROL_BODY_BYTES = 70_000;
const CURSOR = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const QUESTION_PATH = /^\/api\/v1\/sessions\/([^/]+)\/questions(?:\/([^/]+)\/answer)?$/;

export type UpdateRoutes = {
  // What is installed, what is available, and the last update run.
  status(): unknown | Promise<unknown>;
  // Asks the registry now instead of waiting for the next periodic check.
  check(): unknown | Promise<unknown>;
  // Starts the update to the version the member saw; refused when it moved.
  apply(request: unknown): unknown | Promise<unknown>;
};

type Context = {
  request: IncomingMessage; response: ServerResponse; url: URL; origin: string; requestOrigin: string | undefined;
  auth: SessionAuthority; now: number; consumeControl(sessionId: string, now: number): boolean;
};
type Options = {
  readSessionQuestions?: (sessionRef: string) => unknown | Promise<unknown>;
  answerSessionQuestion?: (sessionRef: string, questionRef: string, answer: unknown) => unknown | Promise<unknown>;
  updates?: UpdateRoutes;
};

// The checks every change shares; a refusal is answered here and false returned.
function authorizeChange(context: Context): boolean {
  const { request, response, origin, requestOrigin, auth, now, consumeControl } = context;
  if (requestOrigin !== origin) { errorResponse(response, 403, "origin-required"); return false; }
  const session = auth.authorizeMutation(request);
  if (!session) { errorResponse(response, 403, "mutation-authority-rejected"); return false; }
  if (!consumeControl(session.id, now)) { errorResponse(response, 429, "control-rate-limit"); return false; }
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { errorResponse(response, 415, "content-type"); return false; }
  return true;
}

async function jsonBody(context: Context, code: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try { return { ok: true, value: JSON.parse((await requestBody(context.request, MAX_CONTROL_BODY_BYTES)).toString("utf8")) }; }
  catch (error) { errorResponse(context.response, (error as Error).message === "body-limit" ? 413 : 400, code); return { ok: false }; }
}

const UPDATE_STATUS: Record<string, number> = {
  "update-not-installable": 409, "update-blocked-running": 409, "update-already-running": 409,
  "update-version-changed": 409, "update-not-available": 409, "update-request-invalid": 400
};

// True when the request was one of these routes (answered, or refused).
export async function routeMemberRequest(context: Context, options: Options): Promise<boolean> {
  const { request, response, url, auth } = context;
  const question = QUESTION_PATH.exec(url.pathname);
  if (request.method === "GET" && question && !question[2] && options.readSessionQuestions) {
    if (!auth.authenticate(request)) { errorResponse(response, 401, "authentication-required"); return true; }
    const sessionRef = decodeURIComponent(question[1]);
    if (!CURSOR.test(sessionRef)) { errorResponse(response, 400, "invalid-session-ref"); return true; }
    try { jsonResponse(response, 200, await options.readSessionQuestions(sessionRef)); }
    catch { errorResponse(response, 503, "questions-unavailable"); }
    return true;
  }
  if (request.method === "POST" && question && question[2] && options.answerSessionQuestion) {
    if (!authorizeChange(context)) return true;
    const sessionRef = decodeURIComponent(question[1]), questionRef = decodeURIComponent(question[2]);
    if (!CURSOR.test(sessionRef) || !/^question\.[0-9a-f-]{36}$/.test(questionRef)) { errorResponse(response, 400, "invalid-question-ref"); return true; }
    const body = await jsonBody(context, "invalid-question-answer");
    if (!body.ok) return true;
    try { jsonResponse(response, 200, await options.answerSessionQuestion(sessionRef, questionRef, body.value)); }
    catch (error) {
      const code = error instanceof Error ? error.message : "questions-unavailable";
      errorResponse(response, code === "question-not-pending" ? 409 : code === "question-answer-invalid" ? 400 : 503, code);
    }
    return true;
  }

  if (!options.updates || !url.pathname.startsWith("/api/v1/updates")) return false;
  const updates = options.updates;
  if (request.method === "GET" && url.pathname === "/api/v1/updates") {
    if (!auth.authenticate(request)) { errorResponse(response, 401, "authentication-required"); return true; }
    try { jsonResponse(response, 200, await updates.status()); }
    catch { errorResponse(response, 503, "update-status-unavailable"); }
    return true;
  }
  const action = request.method === "POST" ? /^\/api\/v1\/updates\/(check|apply)$/.exec(url.pathname)?.[1] : undefined;
  if (!action) { errorResponse(response, 404, "not-found"); return true; }
  if (!authorizeChange(context)) return true;
  const body = await jsonBody(context, "update-request-invalid");
  if (!body.ok) return true;
  try { jsonResponse(response, action === "apply" ? 202 : 200, action === "apply" ? await updates.apply(body.value) : await updates.check()); }
  catch (error) {
    const code = error instanceof Error ? error.message : "update-unavailable";
    errorResponse(response, UPDATE_STATUS[code] ?? 503, UPDATE_STATUS[code] ? code : "update-unavailable");
  }
  return true;
}

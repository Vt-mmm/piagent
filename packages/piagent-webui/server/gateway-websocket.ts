import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import type { SessionAuthority } from "./session-auth.ts";

const FRAME_LIMIT = 70_000;
const CLIENT_LIMIT = 8;
const BACKPRESSURE_LIMIT = 512 * 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,96}$/;

type GatewayProtocolEvent = {
  sequence: number;
  [key: string]: unknown;
};
export type GatewayRequest = { requestId: string; method: "gateway.health" | "sessions.list" | "sessions.get" | "sessions.command"; params: Record<string, unknown> };
export type GatewayProtocolHandler = {
  capabilities(): unknown;
  execute(request: GatewayRequest): Promise<unknown>;
  events: {
    readonly stateVersion: number;
    subscribe(listener: (event: GatewayProtocolEvent) => void): () => void;
    replay(after: number | null): { state: "current" | "resync-required"; events: GatewayProtocolEvent[]; earliestSequence: number; currentSequence: number };
  };
};

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function nullableRef(value: unknown): boolean { return value === null || typeof value === "string" && REF.test(value); }

function parseConnect(value: unknown): { lastEventSequence: number | null } | null {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "version", "messageType", "clientRef", "minimumProtocol", "maximumProtocol", "lastEventSequence", "catalogRevision"])) return null;
  if (value.schemaVersion !== 1 || value.version !== "piagent-gateway-protocol-v1" || value.messageType !== "connect"
    || typeof value.clientRef !== "string" || !REF.test(value.clientRef) || value.minimumProtocol !== 1 || value.maximumProtocol !== 1
    || !nullableRef(value.catalogRevision)) return null;
  const sequence = value.lastEventSequence;
  if (sequence !== null && (!Number.isSafeInteger(sequence) || Number(sequence) < 0)) return null;
  return { lastEventSequence: sequence as number | null };
}

function parseRequest(value: unknown): GatewayRequest | null {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "version", "messageType", "requestId", "method", "params"]) || value.schemaVersion !== 1
    || value.version !== "piagent-gateway-protocol-v1" || value.messageType !== "request" || typeof value.requestId !== "string"
    || !REQUEST_ID.test(value.requestId) || !["gateway.health", "sessions.list", "sessions.get", "sessions.command"].includes(String(value.method))
    || !record(value.params)) return null;
  const params = value.params;
  if (value.method === "gateway.health" && !exactKeys(params, [])) return null;
  if (value.method === "sessions.get" && (!exactKeys(params, ["sessionRef"]) || typeof params.sessionRef !== "string" || !REF.test(params.sessionRef))) return null;
  if (value.method === "sessions.command" && (!exactKeys(params, ["command"]) || !record(params.command))) return null;
  if (value.method === "sessions.list") {
    if (!exactKeys(params, ["cursor", "limit", "filter", "query", "projectRef"]) || !nullableRef(params.cursor) || !nullableRef(params.projectRef)
      || !Number.isInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200
      || !["active", "archived", "all"].includes(String(params.filter))
      || !(params.query === null || typeof params.query === "string" && params.query.length >= 1 && params.query.length <= 200
        && !/[\u0000-\u001f\u007f]/.test(params.query))) return null;
  }
  return value as GatewayRequest;
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > BACKPRESSURE_LIMIT) { socket.close(1013, "backpressure"); return; }
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > FRAME_LIMIT) { socket.close(1009, "frame-limit"); return; }
  socket.send(body);
}

function response(request: GatewayRequest, stateVersion: number, result: unknown) {
  return { schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "response", requestId: request.requestId,
    method: request.method, ok: true, stateVersion, result, error: null };
}

function errorResponse(request: GatewayRequest, stateVersion: number, error: unknown) {
  const failure = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? { code: error.code, retryable: "retryable" in error && error.retryable === true } : { code: "gateway-request-failed", retryable: true };
  return { schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "response", requestId: request.requestId,
    method: request.method, ok: false, stateVersion, result: null,
    error: { code: failure.code, message: failure.code, retryable: failure.retryable } };
}

export function attachGatewayWebSocket(options: {
  server: Server;
  origin(): string;
  authority: SessionAuthority;
  protocol: GatewayProtocolHandler;
}): { close(): Promise<void> } {
  const sockets = new Set<WebSocket>();
  const webSockets = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: FRAME_LIMIT });
  const reject = (socket: import("node:stream").Duplex, status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
  const upgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(request.url ?? "", options.origin()); } catch { reject(socket, 400); return; }
    const protocol = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((item) => item.trim());
    if (request.headers.origin !== options.origin() || request.headers.host !== options.origin().slice("http://".length)
      || url.pathname !== "/api/v1/gateway" || url.search || !options.authority.authenticate(request)
      || !protocol.includes("piagent.gateway.v1") || sockets.size >= CLIENT_LIMIT) { reject(socket, 403); return; }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
  };
  options.server.on("upgrade", upgrade);
  webSockets.on("connection", (socket) => {
    sockets.add(socket); let connected = false, unsubscribe: (() => void) | null = null, chain = Promise.resolve();
    const timeout = setTimeout(() => socket.close(1008, "connect-timeout"), 5_000);
    socket.on("message", (data, binary) => {
      if (binary) { socket.close(1003, "text-only"); return; }
      chain = chain.then(async () => {
        let value: unknown;
        try { value = JSON.parse(data.toString()); } catch { socket.close(1007, "invalid-json"); return; }
        if (!connected) {
          const connect = parseConnect(value);
          if (!connect) { socket.close(1008, "invalid-connect"); return; }
          connected = true; clearTimeout(timeout);
          const pending: GatewayProtocolEvent[] = [], seen = new Set<number>(); let replaying = true;
          unsubscribe = options.protocol.events.subscribe((event) => replaying ? pending.push(event) : send(socket, event));
          send(socket, { schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "hello", capabilities: options.protocol.capabilities() });
          const replay = options.protocol.events.replay(connect.lastEventSequence);
          if (replay.state === "resync-required") send(socket, {
            schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "event", sequence: replay.currentSequence,
            stateVersion: replay.currentSequence, generatedAt: new Date().toISOString(), kind: "resync.required",
            payload: { reasonCode: "gateway-event-cursor-gap", earliestSequence: replay.earliestSequence, currentSequence: replay.currentSequence }
          });
          else for (const event of replay.events) { seen.add(event.sequence); send(socket, event); }
          replaying = false;
          for (const event of pending) if (!seen.has(event.sequence)) send(socket, event);
          return;
        }
        const request = parseRequest(value);
        if (!request) { socket.close(1008, "invalid-request"); return; }
        try { send(socket, response(request, options.protocol.events.stateVersion, await options.protocol.execute(request))); }
        catch (error) { send(socket, errorResponse(request, options.protocol.events.stateVersion, error)); }
      }).catch(() => socket.close(1011, "gateway-failure"));
    });
    socket.once("close", () => { clearTimeout(timeout); unsubscribe?.(); sockets.delete(socket); });
    socket.once("error", () => socket.terminate());
  });
  return { close: async () => {
    options.server.off("upgrade", upgrade);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
  } };
}

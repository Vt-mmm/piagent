import type { IncomingMessage, ServerResponse } from "node:http";

import type { StreamEvent, WebUiReadModelProvider } from "./read-model-provider.ts";

const CURSOR = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const MAX_EVENT_BYTES = 65_536;
const MAX_HANDOFF_EVENTS = 256;

function frame(event: string, value: unknown, cursor?: string): string | null {
  let json: string;
  try { json = JSON.stringify(value); } catch { return null; }
  if (Buffer.byteLength(json) > MAX_EVENT_BYTES || (cursor && !CURSOR.test(cursor))) return null;
  return `${cursor ? `id: ${cursor}\n` : ""}event: ${event}\ndata: ${json}\n\n`;
}

export class SseHub {
  readonly #provider: WebUiReadModelProvider;
  readonly #clients = new Set<ServerResponse>();
  readonly #maximumClients: number;
  readonly #maximumReplayEvents: number;

  constructor(provider: WebUiReadModelProvider, options: { maximumClients?: number; maximumReplayEvents?: number } = {}) {
    this.#provider = provider;
    this.#maximumClients = Math.max(1, Math.min(32, options.maximumClients ?? 8));
    this.#maximumReplayEvents = Math.max(1, Math.min(10_000, options.maximumReplayEvents ?? 10_000));
  }

  async open(request: IncomingMessage, response: ServerResponse, after: string | null): Promise<void> {
    if (this.#clients.size >= this.#maximumClients) {
      response.statusCode = 503; response.end(JSON.stringify({ error: { code: "sse-client-limit" } })); return;
    }
    const buffered: StreamEvent[] = [];
    let live = false, handoffOverflow = false;
    const writeEvent = (event: StreamEvent): boolean => {
      const encoded = frame("runtime-event", event.value, event.cursor);
      if (!encoded) { response.end(frame("resync-required", { reasonCode: "event-payload-limit", latestCursor: event.cursor }) as string); return false; }
      response.write(encoded); return true;
    };
    const unsubscribe = this.#provider.subscribe((event: StreamEvent) => {
      if (live) { writeEvent(event); return; }
      if (buffered.length >= MAX_HANDOFF_EVENTS) { handoffOverflow = true; return; }
      buffered.push(event);
    });
    let replay;
    try { replay = await this.#provider.replay(after, this.#maximumReplayEvents); }
    catch (error) { unsubscribe(); throw error; }
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    if (replay.state === "resync-required" || replay.state === "truncated" || handoffOverflow) {
      unsubscribe();
      response.end(frame("resync-required", { reasonCode: replay.reasonCode ?? "event-replay-limit", latestCursor: replay.latestCursor }) ?? "event: resync-required\ndata: {}\n\n");
      return;
    }
    const replayed = new Set<string>();
    for (const event of replay.events) {
      replayed.add(event.cursor);
      if (!writeEvent(event)) { unsubscribe(); return; }
    }
    live = true;
    for (const event of buffered) if (!replayed.has(event.cursor) && !writeEvent(event)) { unsubscribe(); return; }
    response.write("retry: 2000\n\n");
    this.#clients.add(response);
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": keepalive\n\n"); }, 15_000);
    heartbeat.unref();
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); this.#clients.delete(response); };
    request.once("close", cleanup); response.once("close", cleanup);
  }

  close(): void {
    for (const response of this.#clients) response.end();
    this.#clients.clear();
  }
}

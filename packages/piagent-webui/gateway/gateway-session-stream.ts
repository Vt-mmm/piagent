import { randomBytes } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import { GatewayEventStore } from "./gateway-events.ts";

const MAX_BUFFER = 65_536;
const MAX_EVENTS = 128;
const MAX_DELTA = 16_384;
const PRIVATE_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_END = /-----END [A-Z ]*PRIVATE KEY-----/;

function clean(value: unknown): string {
  return String(value ?? "").replace(/\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}
function safeTool(value: unknown): string {
  const safe = redactSensitiveText(clean(value));
  if (safe.redacted) return "redacted-tool";
  return safe.text.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 160) || "tool";
}
function ref(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }

export class GatewaySessionStream {
  readonly sessionRef: string;
  readonly operationRef: string;
  readonly #events: GatewayEventStore;
  #messageRef: string | null = null;
  #messageSequence = 0;
  #eventCount = 0;
  #buffer = "";
  #truncated = false;
  #started = false;
  #startListeners: Array<() => void> = [];
  #settled = false;
  #settleListeners: Array<() => void> = [];
  readonly #toolRefs = new Map<string, string>();

  constructor(options: { sessionRef: string; operationRef: string; events: GatewayEventStore }) {
    this.sessionRef = options.sessionRef; this.operationRef = options.operationRef; this.#events = options.events;
  }

  started(): Promise<void> {
    if (this.#started) return Promise.resolve();
    return new Promise((resolve) => this.#startListeners.push(resolve));
  }

  settled(): Promise<void> {
    if (this.#settled) return Promise.resolve();
    return new Promise((resolve) => this.#settleListeners.push(resolve));
  }

  observe(event: any): void {
    if (event?.type === "agent_start") {
      this.#started = true; for (const resolve of this.#startListeners.splice(0)) resolve(); return;
    }
    if (event?.type === "agent_settled") {
      this.#settled = true; for (const resolve of this.#settleListeners.splice(0)) resolve(); return;
    }
    if (event?.type === "message_start" && event.message?.role === "assistant") {
      this.#messageRef = ref("message"); this.#buffer = ""; return;
    }
    if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta"
      && typeof event.assistantMessageEvent.delta === "string") {
      const remaining = MAX_BUFFER - this.#buffer.length;
      if (remaining <= 0) { this.#truncated = true; return; }
      this.#buffer += event.assistantMessageEvent.delta.slice(0, remaining);
      if (event.assistantMessageEvent.delta.length > remaining) this.#truncated = true;
      this.#flush(false); return;
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") { this.#flush(true); return; }
    if (event?.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      const toolCallRef = ref("tool"); this.#toolRefs.set(event.toolCallId, toolCallRef);
      this.#events.publish("tool.started", { sessionRef: this.sessionRef, operationRef: this.operationRef, toolCallRef,
        toolLabel: safeTool(event.toolName), isError: null });
      return;
    }
    if (event?.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const toolCallRef = this.#toolRefs.get(event.toolCallId); if (!toolCallRef) return;
      this.#events.publish("tool.completed", { sessionRef: this.sessionRef, operationRef: this.operationRef, toolCallRef,
        toolLabel: safeTool(event.toolName), isError: event.isError === true });
      this.#toolRefs.delete(event.toolCallId);
    }
  }

  #flush(final: boolean): void {
    if (!this.#messageRef || !this.#buffer || this.#eventCount >= MAX_EVENTS) {
      if (this.#eventCount >= MAX_EVENTS) this.#truncated = true;
      return;
    }
    let take = final ? this.#buffer.length : this.#buffer.lastIndexOf("\n") + 1;
    if (take <= 0 && this.#buffer.length >= 1_024) take = this.#buffer.length;
    if (take <= 0) return;
    const candidate = this.#buffer.slice(0, take), privateStart = candidate.search(PRIVATE_BEGIN);
    if (privateStart >= 0 && !PRIVATE_END.test(candidate.slice(privateStart))) {
      if (!final) take = privateStart;
      else {
        const before = redactSensitiveText(clean(candidate.slice(0, privateStart))).text;
        this.#buffer = ""; this.#emit(`${before}[REDACTED_SECRET]`); return;
      }
    }
    if (take <= 0) return;
    const source = this.#buffer.slice(0, take); this.#buffer = this.#buffer.slice(take);
    this.#emit(redactSensitiveText(clean(source)).text);
  }

  #emit(value: string): void {
    for (let offset = 0; offset < value.length; offset += MAX_DELTA) {
      if (this.#eventCount >= MAX_EVENTS) { this.#truncated = true; break; }
      this.#events.publish("message.delta", { sessionRef: this.sessionRef, operationRef: this.operationRef,
        messageRef: this.#messageRef!, messageSequence: this.#messageSequence++, delta: value.slice(offset, offset + MAX_DELTA) });
      this.#eventCount += 1;
    }
  }

  complete(sessionRevision: string): void {
    this.#flush(true);
    if (this.#messageRef) this.#events.publish("message.completed", { sessionRef: this.sessionRef, operationRef: this.operationRef,
      messageRef: this.#messageRef, sessionRevision, truncated: this.#truncated });
  }
}

import { randomBytes } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import { hasVisibleText } from "../shared/text-visibility.ts";
import { GatewayEventStore } from "./gateway-events.ts";

const MAX_BUFFER = 65_536;
const MAX_EVENTS = 128;
const MAX_DELTA = 16_384;
const PRIVATE_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const RUNTIME_DRIFT = /Installed Piagent runtime changed (?:during this session|while the capability lock was being re-pinned)/i;
const COMPLETION_GATE = /^\[Piagent completion gate: (CONTINUING|NOT APPROVED)\]/i;

export type GatewayOperationSettlement = "completed" | "blocked" | "aborted" | "error" | "unknown";
type Settlement = { outcome: GatewayOperationSettlement; reasonCode: string | null };

function clean(value: unknown): string {
  return String(value ?? "").replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}
function safeTool(value: unknown): string {
  const safe = redactSensitiveText(clean(value));
  if (safe.redacted) return "redacted-tool";
  return safe.text.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 160) || "tool";
}
function ref(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text).join("\n");
}
function assistantSettlement(message: any): Settlement {
  const stopReason = String(message?.stopReason ?? "");
  if (stopReason === "aborted") return { outcome: "aborted", reasonCode: "operation-aborted" };
  if (stopReason === "error") return { outcome: "error", reasonCode: "assistant-response-failed" };
  if (stopReason === "length") return { outcome: "error", reasonCode: "assistant-output-incomplete" };
  const gate = COMPLETION_GATE.exec(messageText(message).trimStart());
  if (gate) return { outcome: "blocked", reasonCode: gate[1]?.toUpperCase() === "CONTINUING"
    ? "completion-gate-continuing" : "completion-gate-not-approved" };
  if (stopReason === "stop") return hasVisibleText(redactSensitiveText(clean(messageText(message))).text)
    ? { outcome: "completed", reasonCode: null }
    : { outcome: "unknown", reasonCode: "assistant-message-empty" };
  if (["toolUse", "pending", "deferred"].includes(stopReason)) return { outcome: "unknown", reasonCode: "assistant-message-intermediate" };
  return { outcome: "unknown", reasonCode: "operation-settlement-unknown" };
}

function containsRuntimeDrift(value: unknown, depth = 0, remaining = { value: 16_384 }): boolean {
  if (depth > 5 || remaining.value <= 0 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    const text = value.slice(0, remaining.value); remaining.value -= text.length;
    return RUNTIME_DRIFT.test(text);
  }
  if (Array.isArray(value)) return value.some((item) => containsRuntimeDrift(item, depth + 1, remaining));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["reason", "message", "text", "content", "result", "details"]
    .some((key) => containsRuntimeDrift(record[key], depth + 1, remaining));
}

export function runtimeRestartReasonCode(event: unknown): "runtime-restart-required" | null {
  if (!event || typeof event !== "object" || (event as Record<string, unknown>).isError !== true) return null;
  return containsRuntimeDrift((event as Record<string, unknown>).result) ? "runtime-restart-required" : null;
}

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
  #runtimeRestartRequired = false;
  #lastMessageRef: string | null = null;
  #settlement: Settlement = { outcome: "unknown", reasonCode: "operation-settlement-unknown" };
  #forcedSettlement: Settlement | null = null;
  #lifecycleTerminationReasonCode: string | null = null;
  #terminalEmitted = false;
  #settleListeners: Array<() => void> = [];
  readonly #toolRefs = new Map<string, string>();

  get runtimeRestartRequired(): boolean { return this.#runtimeRestartRequired; }
  get lifecycleTerminationReasonCode(): string | null { return this.#lifecycleTerminationReasonCode; }

  markAborted(reasonCode = "operation-aborted"): void { this.#forcedSettlement = { outcome: "aborted", reasonCode }; }
  markError(reasonCode = "operation-failed"): void {
    if (!this.#forcedSettlement) this.#forcedSettlement = { outcome: "error", reasonCode };
  }
  forceLifecycleTermination(reasonCode: string): void {
    this.#lifecycleTerminationReasonCode ??= reasonCode;
    if (!this.#started) { this.#started = true; for (const resolve of this.#startListeners.splice(0)) resolve(); }
    if (!this.#settled) { this.#settled = true; for (const resolve of this.#settleListeners.splice(0)) resolve(); }
  }

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
    if (this.#terminalEmitted) return;
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
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      this.#flush(true); this.#lastMessageRef = this.#messageRef; this.#settlement = assistantSettlement(event.message); return;
    }
    if (event?.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      const toolCallRef = ref("tool"); this.#toolRefs.set(event.toolCallId, toolCallRef);
      this.#events.publish("tool.started", { sessionRef: this.sessionRef, operationRef: this.operationRef, toolCallRef,
        toolLabel: safeTool(event.toolName), isError: null, reasonCode: null });
      return;
    }
    if (event?.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const toolCallRef = this.#toolRefs.get(event.toolCallId); if (!toolCallRef) return;
      const reasonCode = runtimeRestartReasonCode(event);
      if (reasonCode) this.#runtimeRestartRequired = true;
      this.#events.publish("tool.completed", { sessionRef: this.sessionRef, operationRef: this.operationRef, toolCallRef,
        toolLabel: safeTool(event.toolName), isError: event.isError === true, reasonCode });
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

  complete(sessionRevision: string | null): void {
    if (this.#terminalEmitted) return;
    this.#terminalEmitted = true;
    this.#flush(true);
    let settlement = this.#forcedSettlement ?? (this.#runtimeRestartRequired
      ? { outcome: "unknown" as const, reasonCode: "runtime-restart-required" }
      : this.#settlement);
    const messageRef = this.#lastMessageRef ?? this.#messageRef;
    if (settlement.outcome === "completed" && !messageRef) {
      settlement = { outcome: "unknown", reasonCode: "assistant-message-unavailable" };
    } else if (settlement.outcome === "completed" && sessionRevision === null) {
      // Streaming text is not durable success until the canonical session
      // projection confirms it. Still terminate the UI, but do not show draft.
      settlement = { outcome: "unknown", reasonCode: "session-projection-unavailable" };
    }
    if (settlement.outcome === "completed" && messageRef && sessionRevision) {
      this.#events.publish("message.completed", { sessionRef: this.sessionRef, operationRef: this.operationRef,
        messageRef, sessionRevision, truncated: this.#truncated });
    }
    this.#events.publish("operation.settled", { sessionRef: this.sessionRef, operationRef: this.operationRef,
      messageRef, sessionRevision, settlement: settlement.outcome,
      reasonCode: settlement.outcome === "completed" ? null : settlement.reasonCode ?? "operation-settlement-unknown" });
  }
}

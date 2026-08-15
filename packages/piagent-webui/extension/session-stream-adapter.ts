import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";
import type { RuntimeEventDraft, RuntimeEventRevision } from "../../piagent-core/runtime/inspection/runtime-event-store.ts";
import type { BridgeIdentity, BridgeSnapshot } from "./same-session-bridge.ts";

const MAX_STREAM_BUFFER = 65_536;
const MAX_DELTA = 16_384;
const MAX_MESSAGE_STREAM_EVENTS = 128;
const STREAM_FLUSH_CHARS = 1_024;
const STREAM_FLUSH_INTERVAL_MS = 100;
const ANSI = /\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

type MessageRole = "user" | "assistant" | "tool-result";
type ActiveMessage = { ref: string; role: MessageRole; rawBuffer: string; chunkSequence: number; truncated: boolean;
  emittedEvents: number; lastFlushAt: number; thinking: Set<number>; thinkingStreaming: Set<number>; thinkingCompleted: Set<number> };

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function opaque(prefix: string, value: unknown): string { return `${prefix}.${hash(JSON.stringify(value))}`; }
function digest(value: string): string { return `sha256:${hash(value)}`; }
function controls(value: string): string {
  return value.replace(ANSI, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}
function safe(value: unknown, maximum = 4_000): { text: string; redacted: boolean; truncated: boolean } {
  const source = controls(String(value ?? "")), begin = source.search(PRIVATE_KEY_BEGIN);
  const incompleteKey = begin >= 0 && !PRIVATE_KEY_END.test(source.slice(begin));
  const protectedSource = incompleteKey ? `${source.slice(0, begin)}[REDACTED_SECRET]` : source;
  const projected = redactSensitiveText(protectedSource);
  return { text: projected.text.slice(0, maximum), redacted: incompleteKey || projected.redacted, truncated: projected.text.length > maximum };
}
function safeToolName(value: unknown): string {
  const projected = safe(value, 128);
  if (projected.redacted) return "redacted-tool";
  return projected.text.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 128) || "tool";
}
function role(message: any): MessageRole | null {
  return message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : message?.role === "toolResult" ? "tool-result" : null;
}
function text(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text).join("\n") : "";
}
function imageCount(message: any): number {
  return Array.isArray(message?.content) ? Math.min(32, message.content.filter((item: any) => item?.type === "image").length) : 0;
}
function stopReason(message: any): "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" | null {
  return ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(message?.stopReason) ? message.stopReason : null;
}
function usage(message: any) {
  const value = message?.usage;
  if (!value || typeof value !== "object") return null;
  const count = (candidate: unknown): number | null => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? Math.min(1_000_000_000_000, Math.floor(candidate)) : null;
  return { input: count(value.input), output: count(value.output), cacheRead: count(value.cacheRead), cacheWrite: count(value.cacheWrite),
    reasoning: count(value.reasoning), total: count(value.totalTokens ?? value.total) };
}
function timestamp(value: unknown, now: Date): string {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed <= now.getTime() ? new Date(parsed).toISOString() : now.toISOString();
}
function correlation() {
  return { commandId: null, messageRequestId: null, replacementId: null, approvalRequestId: null, causationEventId: null, idempotencyKeyDigest: null };
}
function redaction(applied = false, truncated = false) { return { applied, valuesRemoved: applied ? 1 : 0, truncated }; }
function identityReady(identity: BridgeIdentity | null): identity is BridgeIdentity & { agentOperationId: string } {
  return Boolean(identity?.agentOperationId);
}
function activityPayload(state: "started" | "progress" | "finished" | "failed", activityRef: string, toolName: string) {
  return { state, activityType: "tool", activityRef, toolName, inputDigest: null, outputDigest: null, preview: null, previewKind: "none",
    outputBytes: null, outputLines: null, exitCode: null, isError: state === "finished" ? false : state === "failed" ? true : null,
    affectedFileRefs: [], criterionIds: [], verifierAttemptIds: [], reasonCode: state === "failed" ? "tool-execution-failed" : null };
}

export class PiSessionStreamAdapter {
  readonly #now: () => Date;
  #turnIndex: number | null = null;
  #messageCounter = 0;
  #activeByRole = new Map<MessageRole, ActiveMessage>();
  #lastMessageRef: string | null = null;
  #toolRefs = new Map<string, string>();
  #lastToolProgress = new Map<string, number>();

  constructor(options: { now?: () => Date } = {}) { this.#now = options.now ?? (() => new Date()); }
  reset(): void {
    this.#turnIndex = null; this.#messageCounter = 0; this.#activeByRole.clear(); this.#lastMessageRef = null;
    this.#toolRefs.clear(); this.#lastToolProgress.clear();
  }

  #base(snapshot: BridgeSnapshot, sourceObservedAt?: unknown): Omit<RuntimeEventDraft, "kind" | "payload" | "evidence" | "redaction"> | null {
    if (!snapshot.revisions || !identityReady(snapshot.identity)) return null;
    const now = this.#now(), identity = snapshot.identity;
    return { sourceObservedAt: timestamp(sourceObservedAt, now), projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
      sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId, agentOperationId: identity.agentOperationId,
      turnIndex: this.#turnIndex, messageRef: null, toolCallId: null, revision: structuredClone(snapshot.revisions) as RuntimeEventRevision, correlation: correlation() };
  }
  #draft(snapshot: BridgeSnapshot, kind: string, payload: Record<string, unknown>, options: { sourceObservedAt?: unknown; messageRef?: string;
    toolCallId?: string; redacted?: boolean; truncated?: boolean; evidence?: "observed" | "derived" } = {}): RuntimeEventDraft | null {
    const base = this.#base(snapshot, options.sourceObservedAt); if (!base) return null;
    return { ...base, messageRef: options.messageRef ?? null, toolCallId: options.toolCallId ?? null, kind,
      evidence: options.evidence ?? "observed", payload, redaction: redaction(options.redacted, options.truncated) };
  }

  agentStarted(snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    const draft = this.#draft(snapshot, "agent-operation.started", { dispatchSource: "unknown", delivery: "unknown", inputDigest: null });
    return draft ? [draft] : [];
  }
  turnStarted(event: { turnIndex?: unknown; timestamp?: unknown }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    if (!Number.isInteger(event.turnIndex) || Number(event.turnIndex) < 0 || Number(event.turnIndex) > 1_000_000_000) return [];
    this.#turnIndex = Number(event.turnIndex); this.#activeByRole.clear(); this.#lastMessageRef = null;
    const draft = this.#draft(snapshot, "turn.started", { phase: "started" }, { sourceObservedAt: event.timestamp });
    return draft ? [draft] : [];
  }
  messageStarted(event: { message?: unknown }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    const message = event.message as any, messageRole = role(message); if (!messageRole || this.#turnIndex === null) return [];
    const base = this.#base(snapshot, message?.timestamp); if (!base) return [];
    const messageRef = opaque("message", [base.sessionRef, base.agentOperationId, this.#turnIndex, ++this.#messageCounter, messageRole]);
    const source = messageRole === "tool-result" ? "" : safe(text(message), MAX_STREAM_BUFFER).text;
    this.#activeByRole.set(messageRole, { ref: messageRef, role: messageRole, rawBuffer: "", chunkSequence: 0, truncated: false,
      emittedEvents: 0, lastFlushAt: this.#now().getTime(),
      thinking: new Set(), thinkingStreaming: new Set(), thinkingCompleted: new Set() });
    this.#lastMessageRef = messageRef;
    const draft = this.#draft(snapshot, "message.started", { role: messageRole, contentDigest: source ? digest(source) : null,
      textChars: source ? source.length : null, imageCount: imageCount(message) }, { sourceObservedAt: message?.timestamp, messageRef });
    return draft ? [draft] : [];
  }
  #deltaDrafts(snapshot: BridgeSnapshot, active: ActiveMessage, value: string, redactedValue: boolean, truncatedValue = false): RuntimeEventDraft[] {
    const result: RuntimeEventDraft[] = [];
    for (let offset = 0; offset < value.length; offset += MAX_DELTA) {
      if (active.emittedEvents >= MAX_MESSAGE_STREAM_EVENTS) { active.truncated = true; break; }
      const delta = value.slice(offset, offset + MAX_DELTA);
      const draft = this.#draft(snapshot, "message.text-delta", { role: "assistant", contentIndex: 0,
        chunkSequence: active.chunkSequence++, delta, deltaDigest: digest(delta) },
      { messageRef: active.ref, redacted: redactedValue, truncated: truncatedValue });
      if (draft) { result.push(draft); active.emittedEvents += 1; }
    }
    return result;
  }
  #drainLines(snapshot: BridgeSnapshot, active: ActiveMessage, final: boolean): RuntimeEventDraft[] {
    let take = final ? active.rawBuffer.length : active.rawBuffer.lastIndexOf("\n") + 1;
    if (take <= 0) return [];
    const candidate = active.rawBuffer.slice(0, take), privateStart = candidate.search(PRIVATE_KEY_BEGIN);
    if (privateStart >= 0 && !PRIVATE_KEY_END.test(candidate.slice(privateStart))) {
      if (!final) take = privateStart;
      else {
        active.rawBuffer = "";
        const before = redactSensitiveText(controls(candidate.slice(0, privateStart)));
        return this.#deltaDrafts(snapshot, active, `${before.text}[REDACTED_SECRET]`, true, active.truncated);
      }
    }
    if (take <= 0) return [];
    const source = active.rawBuffer.slice(0, take); active.rawBuffer = active.rawBuffer.slice(take);
    const projected = redactSensitiveText(controls(source));
    return this.#deltaDrafts(snapshot, active, projected.text, projected.redacted, active.truncated);
  }
  messageUpdated(event: { assistantMessageEvent?: any }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    const update = event.assistantMessageEvent, active = this.#activeByRole.get("assistant"); if (!active || !update) return [];
    if (update.type === "text_delta" && typeof update.delta === "string") {
      if (active.emittedEvents >= MAX_MESSAGE_STREAM_EVENTS) { active.truncated = true; return []; }
      const remaining = MAX_STREAM_BUFFER - active.rawBuffer.length;
      if (remaining <= 0) { active.truncated = true; return []; }
      active.rawBuffer += update.delta.slice(0, remaining); if (update.delta.length > remaining) active.truncated = true;
      const now = this.#now().getTime();
      if (active.rawBuffer.length < STREAM_FLUSH_CHARS && now - active.lastFlushAt < STREAM_FLUSH_INTERVAL_MS
        && !PRIVATE_KEY_END.test(active.rawBuffer)) return [];
      const drafts = this.#drainLines(snapshot, active, false);
      if (drafts.length) active.lastFlushAt = now;
      return drafts;
    }
    if (["thinking_start", "thinking_delta", "thinking_end"].includes(update.type) && Number.isInteger(update.contentIndex)) {
      const index = Number(update.contentIndex);
      if (index < 0 || index > 1_000_000_000 || active.emittedEvents >= MAX_MESSAGE_STREAM_EVENTS) { active.truncated = true; return []; }
      const state = update.type === "thinking_start" ? "started" : update.type === "thinking_end" ? "completed" : "streaming";
      if (state === "started" && (active.thinking.has(index) || active.thinkingCompleted.has(index))) return [];
      if (state === "streaming" && (active.thinkingStreaming.has(index) || active.thinkingCompleted.has(index))) return [];
      if (state === "completed" && active.thinkingCompleted.has(index)) return [];
      if (state === "started") active.thinking.add(index); if (state === "streaming") active.thinkingStreaming.add(index);
      if (state === "completed") { active.thinkingCompleted.add(index); active.thinkingStreaming.delete(index); }
      const draft = this.#draft(snapshot, "message.thinking-state", { contentIndex: index, state, redacted: true },
        { messageRef: active.ref, redacted: true });
      if (draft) active.emittedEvents += 1;
      return draft ? [draft] : [];
    }
    return [];
  }
  messageEnded(event: { message?: unknown }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    const message = event.message as any, messageRole = role(message); if (!messageRole) return [];
    const active = this.#activeByRole.get(messageRole); if (!active) return [];
    const drafts = messageRole === "assistant" ? this.#drainLines(snapshot, active, true) : [];
    this.#activeByRole.delete(messageRole); this.#lastMessageRef = active.ref;
    const finalText = messageRole === "tool-result" ? { text: "", redacted: false, truncated: false } : safe(text(message), MAX_STREAM_BUFFER);
    const reason = stopReason(message);
    if (messageRole === "assistant" && (reason === "error" || reason === "aborted")) {
      const error = safe(message?.errorMessage, 500);
      const failed = this.#draft(snapshot, "message.failed", { role: "assistant", reason, errorCode: reason === "error" ? "assistant-message-error" : "assistant-message-aborted",
        message: error.text || null, contentDigest: finalText.text ? digest(finalText.text) : null },
      { sourceObservedAt: message?.timestamp, messageRef: active.ref, redacted: finalText.redacted || error.redacted, truncated: finalText.truncated || error.truncated });
      if (failed) drafts.push(failed); return drafts;
    }
    const completed = this.#draft(snapshot, "message.completed", { role: messageRole, contentDigest: finalText.text ? digest(finalText.text) : null,
      contentRef: null, textPreview: messageRole === "tool-result" ? null : finalText.text.slice(0, 4_000), textChars: messageRole === "tool-result" ? null : finalText.text.length,
      blockCount: Math.min(10_000, Array.isArray(message?.content) ? message.content.length : finalText.text ? 1 : 0), stopReason: reason, usage: usage(message) },
    { sourceObservedAt: message?.timestamp, messageRef: active.ref, redacted: finalText.redacted, truncated: finalText.truncated || active.truncated });
    if (completed) drafts.push(completed); return drafts;
  }
  turnEnded(event: { message?: unknown; toolResults?: unknown[] }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    const reason = stopReason(event.message), count = Array.isArray(event.toolResults) ? Math.min(10_000, event.toolResults.length) : 0;
    const draft = this.#draft(snapshot, "turn.ended", { phase: "ended", finalMessageRef: this.#lastMessageRef, toolResultCount: count, stopReason: reason });
    return draft ? [draft] : [];
  }
  toolStarted(event: { toolCallId?: unknown; toolName?: unknown }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    if (typeof event.toolCallId !== "string" || !event.toolCallId) return [];
    const drafts = this.#activeByRole.get("assistant")
      ? this.#drainLines(snapshot, this.#activeByRole.get("assistant") as ActiveMessage, false) : [];
    const name = safeToolName(event.toolName);
    const ref = opaque("tool", [snapshot.identity?.sessionRef, event.toolCallId]), activityRef = opaque("activity", [snapshot.identity?.sessionRef, event.toolCallId]);
    this.#toolRefs.set(event.toolCallId, ref); this.#lastToolProgress.set(event.toolCallId, 0);
    const draft = this.#draft(snapshot, "activity.started", activityPayload("started", activityRef, name), { toolCallId: ref });
    if (draft) drafts.push(draft);
    return drafts;
  }
  toolUpdated(event: { toolCallId?: unknown; toolName?: unknown }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    if (typeof event.toolCallId !== "string") return [];
    const now = this.#now().getTime(), last = this.#lastToolProgress.get(event.toolCallId) ?? 0; if (now - last < 250) return [];
    const ref = this.#toolRefs.get(event.toolCallId); if (!ref) return [];
    this.#lastToolProgress.set(event.toolCallId, now);
    const name = safeToolName(event.toolName);
    const activityRef = opaque("activity", [snapshot.identity?.sessionRef, event.toolCallId]);
    const draft = this.#draft(snapshot, "activity.progress", activityPayload("progress", activityRef, name), { toolCallId: ref });
    return draft ? [draft] : [];
  }
  toolEnded(event: { toolCallId?: unknown; toolName?: unknown; isError?: unknown }, snapshot: BridgeSnapshot): RuntimeEventDraft[] {
    if (typeof event.toolCallId !== "string") return [];
    const ref = this.#toolRefs.get(event.toolCallId); if (!ref) return [];
    const name = safeToolName(event.toolName);
    const activityRef = opaque("activity", [snapshot.identity?.sessionRef, event.toolCallId]), state = event.isError === true ? "failed" : "finished";
    this.#toolRefs.delete(event.toolCallId); this.#lastToolProgress.delete(event.toolCallId);
    const draft = this.#draft(snapshot, `activity.${state}`, activityPayload(state, activityRef, name), { toolCallId: ref });
    return draft ? [draft] : [];
  }
  agentSettled(snapshot: BridgeSnapshot, hasPendingMessages: boolean | null): RuntimeEventDraft[] {
    const value = hasPendingMessages === null ? { state: "unknown", value: null, reasonCode: "queue-fact-unavailable" }
      : { state: "known", value: hasPendingMessages, reasonCode: null };
    const draft = this.#draft(snapshot, "agent-operation.settled", { settlement: "completed", lastStopReason: null, hasPendingMessages: value });
    this.reset(); return draft ? [draft] : [];
  }
}

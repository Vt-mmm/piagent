import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";

const MAX_ENTRIES = 50_000;
const MAX_ITEMS = 200;
const MAX_TEXT = 16_384;
const ANSI = /\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g;

type TranscriptIdentity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string | null; taskRunId: string | null;
  agentOperationId: null; toolCallId: null };
type TranscriptRevision = { runtimeRevision: string; taskRevision: string | null; controlRevision: string | null; workspaceRevision: string | null;
  indexRevision: string | null; approvalRevision: string | null; sessionOptionRevision: string | null; queueRevision: string | null };
type TranscriptContent = { state: "available" | "redacted" | "unavailable"; text: string | null; textChars: number | null; digest: string | null;
  truncated: boolean; redacted: boolean; imageCount: number; reasonCode: string | null };
type TranscriptAttachment = { displayName: string; kind: "file" | "image" | "document"; mimeType: string; truncated: boolean };
type TranscriptItem = { messageRef: string; parentMessageRef: string | null; role: "user" | "assistant" | "tool-result"; recordedAt: string;
  agentOperationId: string | null; turnIndex: number | null; content: TranscriptContent;
  attachments?: TranscriptAttachment[];
  toolCalls: Array<{ toolCallRef: string; toolName: string; state: "requested" | "completed" | "failed" | "unknown" }> };
export type TranscriptDocument = { schemaVersion: 1; version: "piagent-webui-transcript-v1"; generatedAt: string; identity: TranscriptIdentity;
  revision: TranscriptRevision; eventCursor: string; state: "ready" | "unavailable"; items: TranscriptItem[];
  page: { beforeCursor: string | null; nextBeforeCursor: string | null; hasOlder: boolean; limit: number; truncated: boolean }; reasonCode: string | null };

export type TranscriptProjectionInput = {
  identity: TranscriptIdentity;
  revision: TranscriptRevision;
  eventCursor: string;
  entries: unknown[];
  beforeCursor?: string | null;
  limit?: number;
  generatedAt?: string;
};

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function opaque(prefix: string, value: unknown): string { return `${prefix}.${hash(JSON.stringify(value))}`; }
function timestamp(value: unknown): string | null {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n");
}
function safeAttachmentName(value: unknown): string {
  const projected = safeText(String(value ?? "attachment"));
  return projected.full.replace(/[\\/]/g, "_").replace(/\s+/g, " ").trim().slice(0, 160) || "attachment";
}
function userMessageProjection(message: any): { text: string; attachments: TranscriptAttachment[] } {
  if (message?.role !== "user" || !Array.isArray(message?.content)) return { text: messageText(message), attachments: [] };
  const textParts = message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string");
  const attachments: TranscriptAttachment[] = [];
  for (const part of textParts.slice(1)) {
    const lines = String(part.text).split("\n", 3);
    if (!lines[0]?.startsWith("attached file: ") || !lines[1]?.startsWith("format: ")) continue;
    let displayName: unknown;
    try { displayName = JSON.parse(lines[0].slice("attached file: ".length)); } catch { continue; }
    if (typeof displayName !== "string") continue;
    const format = /^format: ([A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*)(, truncated)?$/.exec(lines[1]);
    if (!format) continue;
    const mimeType = format[1]!;
    const kind = mimeType === "application/pdf" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ? "document" as const : "file" as const;
    attachments.push({ displayName: safeAttachmentName(displayName), kind, mimeType, truncated: Boolean(format[2]) });
  }
  for (const part of message.content) {
    if (part?.type !== "image" || typeof part.mimeType !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(part.mimeType)) continue;
    attachments.push({ displayName: "Image", kind: "image", mimeType: part.mimeType.slice(0, 120), truncated: false });
  }
  // Attachment bodies are provider input, not transcript prose. Showing or
  // hashing them here would turn the chat bubble into a document dump and make
  // a bounded UI digest an oracle over user files. The first block is the exact
  // text the operator typed; the remaining recognized blocks become cards.
  return { text: attachments.length ? String(textParts[0]?.text ?? "") : messageText(message), attachments: attachments.slice(0, 4) };
}
function assistantFailureReason(message: any): string | null {
  if (message?.role !== "assistant" || message?.stopReason !== "error") return null;
  const detail = String(message?.errorMessage ?? "").toLowerCase();
  if (/(?:authentication|auth|token|credential).{0,48}expired|expired.{0,48}(?:authentication|auth|token|credential)/.test(detail)) {
    return "provider-auth-expired";
  }
  if (/(?:authentication|unauthorized|forbidden|credential|api[ _-]?key|log[ -]?in|sign[ -]?in)/.test(detail)) {
    return "provider-auth-required";
  }
  if (/(?:rate[ _-]?limit|too many requests|quota)/.test(detail)) return "provider-rate-limited";
  if (/(?:network|fetch failed|econn|timed? ?out|unavailable)/.test(detail)) return "provider-unavailable";
  return "provider-response-failed";
}
function safeText(value: string): { full: string; preview: string; redacted: boolean; truncated: boolean } {
  const clean = value.replace(ANSI, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  const redaction = redactSensitiveText(clean);
  return { full: redaction.text, preview: redaction.text.slice(0, MAX_TEXT), redacted: redaction.redacted,
    truncated: redaction.text.length > MAX_TEXT };
}
function safeToolName(value: unknown): string {
  const projected = safeText(String(value ?? "tool"));
  if (projected.redacted) return "redacted-tool";
  return projected.full.replace(/[^A-Za-z0-9._:@~-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 80) || "tool";
}
function imageCount(message: any): number {
  return Array.isArray(message?.content) ? Math.min(32, message.content.filter((item: any) => item?.type === "image").length) : 0;
}
function toolCalls(message: any, sessionRef: string, role: TranscriptItem["role"]): TranscriptItem["toolCalls"] {
  const values: Array<{ id: unknown; name: unknown; state: "requested" | "completed" | "failed" | "unknown" }> = [];
  if (role === "assistant" && Array.isArray(message?.content)) {
    for (const item of message.content) if (item?.type === "toolCall") values.push({ id: item.id, name: item.name, state: "requested" });
  } else if (role === "tool-result") {
    values.push({ id: message?.toolCallId, name: message?.toolName, state: message?.isError ? "failed" : "completed" });
  }
  return values.slice(0, 64).map((item, index) => {
    return { toolCallRef: opaque("tool", [sessionRef, item.id ?? index]), toolName: safeToolName(item.name), state: item.state };
  });
}
function role(message: any): TranscriptItem["role"] | null {
  return message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : message?.role === "toolResult" ? "tool-result" : null;
}
function isInternalFreshTransition(message: any): boolean {
  if (message?.role !== "user") return false;
  return /^\/fresh\s+(?:task|scout|be-to-fe)\s+(?:--session-title\s+"[^"\r\n]{1,64}"\s+)?Read task intake from \.pi\/task-inbox\/[A-Za-z0-9._-]+\.md\.\s+Current session is near context limits; use a fresh governed session\.$/u
    .test(messageText(message).trim());
}
function unavailableContent(reasonCode: string): TranscriptContent {
  return { state: "unavailable", text: null, textChars: null, digest: null, truncated: false, redacted: false, imageCount: 0, reasonCode };
}
function item(entry: any, identity: TranscriptIdentity): TranscriptItem | null {
  if (!entry || entry.type !== "message" || !entry.message) return null;
  if (isInternalFreshTransition(entry.message)) return null;
  const itemRole = role(entry.message), recordedAt = timestamp(entry.timestamp ?? entry.message.timestamp);
  if (!itemRole || !recordedAt || typeof entry.id !== "string" || entry.id.length === 0) return null;
  const userProjection = userMessageProjection(entry.message);
  const content = itemRole === "tool-result" ? unavailableContent("tool-output-in-activity-preview") : (() => {
    const projected = safeText(itemRole === "user" ? userProjection.text : messageText(entry.message));
    const failureReason = projected.full.length === 0 ? assistantFailureReason(entry.message) : null;
    if (failureReason) return unavailableContent(failureReason);
    return { state: projected.redacted ? "redacted" as const : "available" as const, text: projected.preview,
      textChars: Math.min(1_000_000_000, projected.full.length), digest: `sha256:${hash(projected.full)}`, truncated: projected.truncated,
      redacted: projected.redacted, imageCount: imageCount(entry.message), reasonCode: projected.redacted ? "sensitive-values-redacted" as const : null };
  })();
  return { messageRef: opaque("message", [identity.sessionRef, entry.id]), parentMessageRef: null, role: itemRole, recordedAt,
    agentOperationId: null, turnIndex: null, content, ...(userProjection.attachments.length ? { attachments: userProjection.attachments } : {}),
    toolCalls: toolCalls(entry.message, identity.sessionRef, itemRole) };
}
function unavailable(input: TranscriptProjectionInput, reasonCode: string, limit: number): TranscriptDocument {
  return { schemaVersion: 1, version: "piagent-webui-transcript-v1", generatedAt: input.generatedAt ?? new Date().toISOString(),
    identity: structuredClone(input.identity), revision: structuredClone(input.revision), eventCursor: input.eventCursor,
    state: "unavailable", items: [], page: { beforeCursor: input.beforeCursor ?? null, nextBeforeCursor: null, hasOlder: false, limit, truncated: false }, reasonCode };
}

export function projectTranscript(input: TranscriptProjectionInput): TranscriptDocument {
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number.isInteger(input.limit) ? Number(input.limit) : 50));
  if (!Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) return unavailable(input, "transcript-history-unavailable", limit);
  const projected = input.entries.map((entry) => ({ entry, item: item(entry, input.identity) })).filter((value): value is { entry: any; item: TranscriptItem } => Boolean(value.item));
  const cursors = projected.map(({ entry }) => opaque("transcript", [input.identity.sessionRef, entry.id]));
  let end = projected.length;
  if (input.beforeCursor) {
    const cursorIndex = cursors.indexOf(input.beforeCursor);
    if (cursorIndex < 0) return unavailable(input, "transcript-cursor-gap", limit);
    end = cursorIndex;
  }
  const start = Math.max(0, end - limit), selected = projected.slice(start, end).map((value) => value.item), hasOlder = start > 0;
  return { schemaVersion: 1, version: "piagent-webui-transcript-v1", generatedAt: input.generatedAt ?? new Date().toISOString(),
    identity: structuredClone(input.identity), revision: structuredClone(input.revision), eventCursor: input.eventCursor,
    state: "ready", items: selected, page: { beforeCursor: input.beforeCursor ?? null, nextBeforeCursor: hasOlder ? cursors[start] : null,
      hasOlder, limit, truncated: projected.length !== input.entries.filter((entry: any) => entry?.type === "message").length }, reasonCode: null };
}

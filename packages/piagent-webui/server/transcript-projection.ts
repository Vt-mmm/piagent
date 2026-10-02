import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";
import { looksLikeCompletionClaim } from "../../piagent-core/runtime/session/completion-signals.ts";
import { isLightweightNonAuthorizingChangeLanguage } from "../../piagent-core/runtime/workflows/change-clarification.ts";
import { workflowCommandPattern } from "../../piagent-core/runtime/workflows/webui-workflow.ts";
import { hasVisibleText } from "../shared/text-visibility.ts";
import { effectiveStopReason } from "./message-stop-reason.ts";
import { WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE, webUiMessageCorrelationEntry,
  type WebUiMessageCorrelation } from "../shared/message-correlation.ts";
import { terminalDeliveryPairs, type TerminalDeliveryPair, type TerminalDeliveryReceipt } from "./terminal-delivery-receipt.ts";
import { parseFailure } from "../../piagent-core/runtime/managed-failure.mjs";
import { modelLabel, summarizeToolCall, toolResultPreview, turnUsage, type ToolChange, type ToolResult, type ToolSummary,
  type TurnUsage } from "./tool-call-summary.ts";

const MAX_ENTRIES = 50_000;
const MAX_ITEMS = 200;
const MAX_TEXT = 16_384;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const COMPLETION_GATE = /^\[Piagent completion gate: (CONTINUING|NOT APPROVED)\]/i;
const INTERNAL_FRESH_TRANSITION = new RegExp(
  `^\\/fresh\\s+(?:${workflowCommandPattern({ aliases: false })})\\s+(?:--session-title\\s+"[^"\\r\\n]{1,64}"\\s+)?Read task intake from \\.pi\\/task-inbox\\/[A-Za-z0-9._-]+\\.md\\.\\s+Current session is near context limits; use a fresh governed session\\.$`, "u"
);

type TranscriptIdentity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string | null; taskRunId: string | null;
  agentOperationId: null; toolCallId: null };
type TranscriptRevision = { runtimeRevision: string; taskRevision: string | null; controlRevision: string | null; workspaceRevision: string | null;
  indexRevision: string | null; approvalRevision: string | null; sessionOptionRevision: string | null; queueRevision: string | null };
type TranscriptContent = { state: "available" | "redacted" | "unavailable"; text: string | null; textChars: number | null; digest: string | null;
  truncated: boolean; redacted: boolean; imageCount: number; reasonCode: string | null };
type TranscriptAttachment = { displayName: string; kind: "file" | "image" | "document"; mimeType: string; truncated: boolean };
type TranscriptItem = { messageRef: string; parentMessageRef: string | null; role: "user" | "assistant" | "tool-result" | "custom"; recordedAt: string;
  agentOperationId: string | null; messageRequestId?: string; turnIndex: number | null; content: TranscriptContent;
  attachments?: TranscriptAttachment[];
  toolCalls: Array<{ toolCallRef: string; toolName: string; state: "requested" | "completed" | "failed" | "unknown";
    summary?: ToolSummary; change?: ToolChange; result?: ToolResult }>; usage?: TurnUsage; model?: string; process?: HarnessProcess };
type HarnessFinding = { severity: "blocking" | "major" | "minor"; file: string; line: number | null; issue: string };
type HarnessProcess = { phase: "plan" | "verify" | "review" | "final"; outcome?: string; loop?: number; maxLoops?: number; verified?: boolean; reviewed?: boolean;
  blockingOpen?: number; planOpen?: number; planSkipped?: true; verifyPolicy?: string; reviewPolicy?: string; reviewUnavailable?: string; findings?: HarnessFinding[] };
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
  taskOutcome?: string | null;
  terminalDeliveryReceipt?: TerminalDeliveryReceipt;
  terminalDeliveryEntries?: unknown[];
  // The session's project folder: tool paths are shown relative to it.
  cwd?: string;
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
// A company request fails with Studio's (or Agent Watch's) own code: who
// failed, which kind of failure, and Studio's request id. Text is never shown.
export type CompanyFailure = { role: "main" | "research" | "review"; reasonCode: string; code: string; requestRef: string | null; local: boolean };
export function companyFailure(text: unknown): CompanyFailure | null {
  const parsed = parseFailure(text);
  if (!parsed || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,79}$/.test(parsed.code)) return null;
  return { role: parsed.role as CompanyFailure["role"], reasonCode: `company-${parsed.kind}`, code: parsed.code, requestRef: parsed.requestId, local: parsed.local };
}
const COMPANY = "agent_watch_managed";
function assistantFailureReason(message: any): string | null {
  if (message?.role !== "assistant" || message?.stopReason !== "error") return null;
  if (message.provider === COMPANY) return companyFailure(message.errorMessage)?.reasonCode ?? "company-failed";
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
function assistantUnavailableReason(message: any, text: string, projectedToolCalls: TranscriptItem["toolCalls"]): string | null {
  if (message?.role !== "assistant") return null;
  const stopReason = effectiveStopReason(message);
  if (stopReason === "error") return assistantFailureReason(message) ?? "provider-response-failed";
  if (stopReason === "aborted") return "assistant-message-aborted";
  if (stopReason === "length") return "assistant-output-incomplete";
  const gate = COMPLETION_GATE.exec(text.trimStart());
  if (gate) return gate[1]?.toUpperCase() === "CONTINUING"
    ? "assistant-completion-continuing" : "assistant-completion-not-approved";
  if (projectedToolCalls.length > 0 || ["toolUse", "pending", "deferred"].includes(stopReason)) return "assistant-intermediate-output";
  if (!stopReason) return "assistant-settlement-unknown";
  if (stopReason && stopReason !== "stop") return "assistant-settlement-unknown";
  if (!hasVisibleText(text)) return "assistant-message-empty";
  return null;
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
// The harness's process notes ("agent-watch-process"): what it asked of the
// agent before a code-changing turn ended, and how that turn ended.
const PROCESS_OUTCOMES = ["no_change", "interrupted", "blocking_open", "unverified", "review_unavailable", "unreviewed", "clean"];
const POLICY_MODES = ["off", "suggest", "require"];
function harnessProcess(details: any): HarnessProcess | null {
  if (!["plan", "verify", "review", "final"].includes(details?.phase)) return null;
  const loop = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 3;
  const out: HarnessProcess = { phase: details.phase };
  if (PROCESS_OUTCOMES.includes(details.outcome)) out.outcome = details.outcome;
  if (loop(details.loop)) out.loop = details.loop;
  if (loop(details.maxLoops)) out.maxLoops = details.maxLoops;
  if (typeof details.verified === "boolean") out.verified = details.verified;
  if (typeof details.reviewed === "boolean") out.reviewed = details.reviewed;
  if (Number.isInteger(details.blockingOpen) && details.blockingOpen >= 0) out.blockingOpen = Math.min(details.blockingOpen, 1000);
  if (Number.isInteger(details.planOpen) && details.planOpen >= 1 && details.planOpen <= 30) out.planOpen = details.planOpen;
  if (details.planSkipped === true) out.planSkipped = true;
  if (POLICY_MODES.includes(details.policy?.verify)) out.verifyPolicy = details.policy.verify;
  if (POLICY_MODES.includes(details.policy?.review)) out.reviewPolicy = details.policy.review;
  if (["too_large", "not_git", "limit", "failed"].includes(details.reviewUnavailable)) out.reviewUnavailable = details.reviewUnavailable;
  if (Array.isArray(details.findings)) out.findings = details.findings
    .filter((f: any) => ["blocking", "major", "minor"].includes(f?.severity) && typeof f.issue === "string" && f.issue.trim()).slice(0, 10)
    .map((f: any) => ({ severity: f.severity, file: safeText(String(f.file ?? "")).full.slice(0, 300), line: Number.isSafeInteger(f.line) && f.line > 0 ? f.line : null,
      issue: safeText(f.issue).full.slice(0, 500) }));
  return out;
}
function role(message: any): TranscriptItem["role"] | null {
  return message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : message?.role === "toolResult" ? "tool-result" : null;
}
function isInternalFreshTransition(message: any): boolean {
  if (message?.role !== "user") return false;
  return INTERNAL_FRESH_TRANSITION.test(messageText(message).trim());
}
function unavailableContent(reasonCode: string): TranscriptContent {
  return { state: "unavailable", text: null, textChars: null, digest: null, truncated: false, redacted: false, imageCount: 0, reasonCode };
}
function item(entry: any, identity: TranscriptIdentity, customReceipt = false): TranscriptItem | null {
  if (!entry || entry.type !== "message" || !entry.message) return null;
  if (isInternalFreshTransition(entry.message)) return null;
  const itemRole = customReceipt ? "custom" : role(entry.message), recordedAt = timestamp(entry.timestamp ?? entry.message.timestamp);
  if (!itemRole || !recordedAt || typeof entry.id !== "string" || entry.id.length === 0) return null;
  const userProjection = userMessageProjection(entry.message);
  const projectedToolCalls = toolCalls(entry.message, identity.sessionRef, itemRole);
  const content = itemRole === "tool-result" ? unavailableContent("tool-output-in-activity-preview") : (() => {
    const projected = safeText(itemRole === "user" ? userProjection.text : messageText(entry.message));
    const unavailableReason = assistantUnavailableReason(entry.message, projected.full, projectedToolCalls);
    if (unavailableReason) return unavailableContent(unavailableReason);
    return { state: projected.redacted ? "redacted" as const : "available" as const, text: projected.preview,
      textChars: Math.min(1_000_000_000, projected.full.length), digest: `sha256:${hash(projected.full)}`, truncated: projected.truncated,
      redacted: projected.redacted, imageCount: imageCount(entry.message), reasonCode: projected.redacted ? "sensitive-values-redacted" as const : null };
  })();
  return { messageRef: opaque("message", [identity.sessionRef, entry.id]), parentMessageRef: null, role: itemRole, recordedAt,
    agentOperationId: null, turnIndex: null, content, ...(userProjection.attachments.length ? { attachments: userProjection.attachments } : {}),
    toolCalls: projectedToolCalls };
}

type ProjectedTranscriptItem = { entry: any; item: TranscriptItem; cursor: string };

function correlatedTranscriptItems(entries: unknown[], identity: TranscriptIdentity,
  receiptPairs: Map<unknown, TerminalDeliveryPair>): ProjectedTranscriptItem[] {
  let pending: WebUiMessageCorrelation | null = null;
  let turn: WebUiMessageCorrelation | null = null;
  const values: ProjectedTranscriptItem[] = [];
  for (const entry of entries as any[]) {
    const pair = receiptPairs.get(entry);
    if (pair) {
      // Project the admitted request and real custom receipt without writing
      // fabricated user/assistant messages into Pi's durable model history.
      for (const [source, itemRole, content] of [[pair.requestEntry, "user", pair.request],
        [pair.receiptEntry, "custom", pair.receipt.content]] as const) {
        const projected = item({ ...source, type: "message", message: { role: itemRole, content } }, identity, itemRole === "custom");
        if (projected) values.push({ entry: source, item: { ...projected, agentOperationId: pair.correlation.operationRef,
          messageRequestId: pair.correlation.messageRequestId }, cursor: opaque("transcript", [identity.sessionRef, source.id]) });
      }
      pending = null; turn = null; continue;
    }
    if (entry?.type === "custom" && entry.customType === WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE) {
      // A newer marker supersedes an older marker that never reached a user
      // message. Invalid markers fail closed instead of leaking correlation
      // from an earlier admitted-but-undispatched operation into a later turn.
      pending = webUiMessageCorrelationEntry(entry);
      continue;
    }
    if (entry?.type === "custom_message" && entry.customType === "agent-watch-process") {
      const process = harnessProcess(entry.details);
      const projected = process && item({ ...entry, type: "message", message: { role: "custom", content: entry.content } }, identity, true);
      if (projected) values.push({ entry, item: { ...projected, process, ...(turn ? { agentOperationId: turn.operationRef, messageRequestId: turn.messageRequestId } : {}) },
        cursor: opaque("transcript", [identity.sessionRef, entry.id]) });
      continue;
    }
    if (role(entry?.message) === "user") { turn = pending; pending = null; }
    const projected = item(entry, identity);
    if (!projected) continue;
    values.push({ entry, item: turn ? { ...projected, agentOperationId: turn.operationRef,
      messageRequestId: turn.messageRequestId } : projected,
    cursor: opaque("transcript", [identity.sessionRef, entry?.id]) });
  }
  return values;
}

function linkTranscriptTurns(values: ProjectedTranscriptItem[]): ProjectedTranscriptItem[] {
  let userMessageRef: string | null = null;
  const toolCallOwners = new Map<string, string>();
  return values.map((value) => {
    let parentMessageRef: string | null = null;
    if (value.item.role === "user") userMessageRef = value.item.messageRef;
    else if (value.item.role === "tool-result") {
      parentMessageRef = toolCallOwners.get(value.item.toolCalls[0]?.toolCallRef ?? "") ?? userMessageRef;
    } else parentMessageRef = userMessageRef;
    const linked = { ...value, item: { ...value.item, parentMessageRef } };
    if (linked.item.role === "assistant") {
      for (const toolCall of linked.item.toolCalls) toolCallOwners.set(toolCall.toolCallRef, linked.item.messageRef);
    }
    return linked;
  });
}

function suppressOpenTaskHandoff(values: ProjectedTranscriptItem[], taskOutcome: string | null | undefined): ProjectedTranscriptItem[] {
  if (taskOutcome !== "pending") return values;
  let latestUser = -1;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index]?.item.role === "user") { latestUser = index; break; }
  }
  if (latestUser < 0) return values;
  const latestPrompt = values[latestUser]?.item.content.text ?? "";
  if (isLightweightNonAuthorizingChangeLanguage(latestPrompt)) return values;
  return values.map((value, index) => {
    if (index <= latestUser || value.item.role !== "assistant" || value.item.toolCalls.length > 0
      || !["available", "redacted"].includes(value.item.content.state)
      || !looksLikeCompletionClaim(value.item.content.text ?? "")) return value;
    return { ...value, item: { ...value.item, content: unavailableContent("assistant-task-pending") } };
  });
}

function durableAssistant(item: TranscriptItem): boolean {
  return (item.role === "assistant" || item.role === "custom") && item.toolCalls.length === 0
    && (item.content.state === "available" || item.content.state === "redacted")
    && hasVisibleText(item.content.text ?? "");
}

function compactOversizedTurn(
  values: ProjectedTranscriptItem[], start: number, end: number, limit: number
): ProjectedTranscriptItem[] {
  if (limit === 1) return [values[start]!];
  const selected = new Set<number>([start]);
  for (let index = end - 1; index > start; index -= 1) {
    if (durableAssistant(values[index]!.item)) { selected.add(index); break; }
  }
  for (let index = end - 1; index > start && selected.size < limit; index -= 1) selected.add(index);
  return [...selected].sort((left, right) => left - right).map((index) => values[index]!);
}

function boundedTurnPage(
  values: ProjectedTranscriptItem[], end: number, limit: number
): { selected: ProjectedTranscriptItem[]; start: number; compacted: boolean } {
  if (end <= 0) return { selected: [], start: 0, compacted: false };
  const users: number[] = [];
  for (let index = 0; index < end; index += 1) if (values[index]?.item.role === "user") users.push(index);
  if (users.length === 0) {
    const start = Math.max(0, end - limit);
    return { selected: values.slice(start, end), start, compacted: false };
  }

  const selected: ProjectedTranscriptItem[] = [];
  let remaining = limit, turnEnd = end, start = end;
  for (let userIndex = users.length - 1; userIndex >= 0 && remaining > 0; userIndex -= 1) {
    const turnStart = users[userIndex]!;
    const turnSize = turnEnd - turnStart;
    if (turnSize > remaining) {
      if (selected.length === 0) {
        const compacted = compactOversizedTurn(values, turnStart, turnEnd, remaining);
        return { selected: compacted, start: turnStart, compacted: true };
      }
      break;
    }
    selected.unshift(...values.slice(turnStart, turnEnd));
    start = turnStart;
    remaining -= turnSize;
    turnEnd = turnStart;
  }
  return { selected, start, compacted: false };
}

// The agent timeline: each tool call of a shown answer carries its summary,
// an edit's diff and its result preview; answers carry usage and model.
function timelineItems(selected: ProjectedTranscriptItem[], all: ProjectedTranscriptItem[], cwd?: string): TranscriptItem[] {
  const results = new Map<string, any>();
  for (const value of all) if (value.item.role === "tool-result" && value.item.toolCalls[0]) results.set(value.item.toolCalls[0].toolCallRef, value.entry?.message);
  return selected.map((value) => {
    if (value.item.role !== "assistant") return value.item;
    const message = value.entry?.message;
    const blocks = Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "toolCall") : [];
    const toolCalls = value.item.toolCalls.map((call, index) => {
      const block = blocks[index], result = results.get(call.toolCallRef);
      if (!block) return call;
      const { summary, change } = summarizeToolCall(block.name, block.arguments, cwd);
      // A helper's answer can carry its delegated prompt and artifacts: only
      // its outcome is shown, never its text.
      const shown = result && summary.kind !== "subagent" ? { result: toolResultPreview(result) } : {};
      // A failed helper or company search says why (its code), not what it wrote.
      const failed = result?.isError && message?.provider === COMPANY && ["subagent", "web-search"].includes(summary.kind)
        ? companyFailure(toolResultPreview(result).text) : null;
      return { ...call, summary, ...(change ? { change } : {}), ...shown, ...(failed ? { failure: failed } : {}),
        ...(result ? { state: result.isError ? "failed" as const : "completed" as const } : {}) };
    });
    // A company turn is answered by a harness role; which model sits behind it
    // is the harness's business and stays out of the browser.
    const company = message?.provider === COMPANY;
    const usage = turnUsage(message), model = company ? null : modelLabel(message);
    const failure = company && effectiveStopReason(message) === "error" ? companyFailure(message.errorMessage) : null;
    return { ...value.item, toolCalls, ...(usage ? { usage } : {}), ...(model ? { model } : {}), ...(failure ? { failure } : {}) };
  });
}

function unavailable(input: TranscriptProjectionInput, reasonCode: string, limit: number): TranscriptDocument {
  return { schemaVersion: 1, version: "piagent-webui-transcript-v1", generatedAt: input.generatedAt ?? new Date().toISOString(),
    identity: structuredClone(input.identity), revision: structuredClone(input.revision), eventCursor: input.eventCursor,
    state: "unavailable", items: [], page: { beforeCursor: input.beforeCursor ?? null, nextBeforeCursor: null, hasOlder: false, limit, truncated: false }, reasonCode };
}

export function projectTranscript(input: TranscriptProjectionInput): TranscriptDocument {
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number.isInteger(input.limit) ? Number(input.limit) : 50));
  if (!Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) return unavailable(input, "transcript-history-unavailable", limit);
  const receipt = input.terminalDeliveryReceipt;
  const boundReceipt = receipt?.details.taskId === input.identity.taskId && receipt?.details.taskRunId === input.identity.taskRunId
    && receipt?.details.outcome === input.taskOutcome ? receipt : undefined;
  const receiptPairs = new Map(terminalDeliveryPairs(input.entries, boundReceipt, input.terminalDeliveryEntries)
    .map((pair) => [pair.receiptEntry, pair]));
  const projected = suppressOpenTaskHandoff(linkTranscriptTurns(correlatedTranscriptItems(input.entries, input.identity,
    receiptPairs)), input.taskOutcome);
  const cursors = projected.map((value) => value.cursor);
  let end = projected.length;
  if (input.beforeCursor) {
    const cursorIndex = cursors.indexOf(input.beforeCursor);
    if (cursorIndex < 0) return unavailable(input, "transcript-cursor-gap", limit);
    end = cursorIndex;
  }
  const page = boundedTurnPage(projected, end, limit), selected = timelineItems(page.selected, projected, input.cwd), hasOlder = page.start > 0;
  return { schemaVersion: 1, version: "piagent-webui-transcript-v1", generatedAt: input.generatedAt ?? new Date().toISOString(),
    identity: structuredClone(input.identity), revision: structuredClone(input.revision), eventCursor: input.eventCursor,
    state: "ready", items: selected, page: { beforeCursor: input.beforeCursor ?? null, nextBeforeCursor: hasOlder ? cursors[page.start] : null,
      hasOlder, limit, truncated: page.compacted || projected.length !== input.entries.filter((entry: any) => entry?.type === "message").length
        + receiptPairs.size * 2 }, reasonCode: null };
}

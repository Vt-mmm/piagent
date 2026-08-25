import crypto from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import {
  CONTEXT_GOVERNOR_PRESSURE_TOKENS,
  CONTEXT_GOVERNOR_SEMANTIC_BOUNDARY_TOKENS,
  CONTEXT_GOVERNOR_TARGET_MESSAGE_TOKENS,
  CONTEXT_GOVERNOR_TOOL_ROUND_LIMIT,
  CONTEXT_PROVIDER_PROMPT_CEILING_TOKENS
} from "../runtime-limits.ts";

export const GOVERNOR_VERSION = "adaptive-context-governor-v2" as const;
export const CONTEXT_GOVERNOR_MIN_SAVINGS_FLOOR_TOKENS = 8_000;
export const CONTEXT_GOVERNOR_MIN_SAVINGS_CEILING_TOKENS = 20_000;
export const CONTEXT_GOVERNOR_MIN_SAVINGS_RATIO = 0.15;
export const CONTEXT_GOVERNOR_PROTECTED_BOUNDARY_GROUPS = 6;
const READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "search",
  "fetch_content",
  "get_search_content",
  "web_search"
]);
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch"]);
const VERIFIER_PATTERN = /(?:^|\s)(?:test|tests|lint|typecheck|check|verify|build|pytest|vitest|jest|playwright|cargo\s+test|go\s+test)(?:\s|:|$)/i;
const MUTATION_COMMAND_PATTERN = /(?:^|\s)(?:sed\s+-i|perl\s+-pi|tee\s+|cp\s+|mv\s+|mkdir\s+|touch\s+|npm\s+version|git\s+apply)(?:\s|$)|(?:>>?|2>)\s*[^&]/i;

export type MessageLike = Record<string, any> & { role?: string; timestamp?: number };

export type SemanticPhase = "scout" | "plan" | "implement" | "verify" | "review" | "release" | "discuss" | "unknown";
export type SemanticBoundary = {
  kind: "none" | "phase" | "task";
  previousPhase: SemanticPhase;
  currentPhase: SemanticPhase;
  similarity: number;
};

export type ContextResidencyMetrics = {
  estimatedMessageTokens: number;
  toolResults: number;
  readResults: number;
  mutationResults: number;
  verifierResults: number;
  failedResults: number;
  duplicateResults: number;
  duplicateResultRate: number;
  lowValueTokenShare: number;
  userTurns: number;
};

export type ContextGovernorDecision = {
  version: typeof GOVERNOR_VERSION;
  action: "passthrough" | "project";
  reason: "none" | "semantic-boundary" | "residency" | "pressure" | "provider-ceiling";
  reasonCodes: string[];
  reportedTokens: number;
  effectiveTokens: number;
  contextWindow: number;
  percent: number;
  originalMessageTokens: number;
  projectedMessageTokens: number;
  candidateProjectedMessageTokens: number;
  estimatedSavingsTokens: number;
  minimumSavingsTokens: number;
  savingsRatio: number;
  fallback: "none" | "no-safe-boundary" | "insufficient-savings" | "unsafe-tool-protocol";
  originalMessages: number;
  projectedMessages: number;
  accounting: ContextGovernorAccounting;
  boundary: SemanticBoundary;
  residency: ContextResidencyMetrics;
};

export type ContextGovernorAccounting = {
  contextOccupancy: {
    providerReportedTokens: number | null;
    transcriptEstimatedTokens: number;
    projectedTranscriptTokens: number;
    effectivePressureTokens: number;
    contextWindow: number;
  };
  billedTraffic: {
    measured: false;
    inputTokens: null;
    outputTokens: null;
    cacheReadTokens: null;
    governorProviderCalls: 0;
    reason: "provider-billing-not-exposed-by-context-hook";
  };
};

export type ToolProtocolAudit = {
  intact: boolean;
  orphanCallIds: string[];
  orphanResultIds: string[];
};

export type ToolObservation = {
  identity: string;
  name: string;
  target: string;
  kind: "read" | "mutation" | "verify" | "other";
  isError: boolean;
  tokens: number;
};

function bounded(value: unknown, maxChars: number): string {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  const marker = " ... ";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.68);
  return `${compact.slice(0, head).trimEnd()}${marker}${compact.slice(-(available - head)).trimStart()}`;
}

export function safeText(value: unknown, maxChars: number): string {
  return bounded(redactSensitiveText(String(value ?? "")).text, maxChars);
}

function contentTokenEstimate(content: unknown): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image") {
      tokens += 1_200;
      continue;
    }
    if (block.type === "text") tokens += Math.ceil(String(block.text ?? "").length / 4);
    else if (block.type === "thinking") tokens += Math.ceil(String(block.thinking ?? block.thinkingSignature ?? "").length / 4);
    else if (block.type === "toolCall") {
      let serialized = "";
      try {
        serialized = JSON.stringify(block.arguments ?? {});
      } catch {
        serialized = String(block.arguments ?? "");
      }
      tokens += Math.ceil((String(block.name ?? "").length + serialized.length) / 4) + 8;
    }
  }
  return tokens;
}

export function estimateGovernorMessageTokens(message: MessageLike): number {
  if (!message || typeof message !== "object") return 0;
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return Math.ceil(String(message.summary ?? "").length / 4) + 16;
  }
  if (message.role === "bashExecution") {
    return message.excludeFromContext ? 0 : Math.ceil((String(message.command ?? "").length + String(message.output ?? "").length) / 4) + 16;
  }
  return contentTokenEstimate(message.content) + 8;
}

export function estimateGovernorMessagesTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, message) => sum + estimateGovernorMessageTokens(message), 0);
}

export function messageText(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text")
    .map((block: any) => String(block.text ?? ""))
    .join("\n");
}

function fold(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function classifySemanticPhase(value: string): SemanticPhase {
  const text = fold(value);
  if (/\b(commit|push|merge|publish|release|tag|deploy|phat hanh|trien khai)\b/.test(text)) return "release";
  if (/\b(verify|verification|run tests?|test lai|kiem thu|typecheck|lint|ci|closeout)\b/.test(text)) return "verify";
  if (/\b(implement|implementation|fix|repair|code|sua code|tien hanh sua|lam di|build it)\b/.test(text)) return "implement";
  if (/\b(plan|planning|ke hoach|len plan|proposal|design approach)\b/.test(text)) return "plan";
  if (/\b(review|reviewer|cross-check|double-check|danh gia lai)\b/.test(text)) return "review";
  if (/\b(scout|audit|inspect|investigate|read-only|read only|mapping|map logic|kiem tra logic|xem xet)\b/.test(text)) return "scout";
  if (/\b(explain|why|discuss|question|tai sao|vi sao|nghi sao|phan tich)\b/.test(text)) return "discuss";
  return "unknown";
}

const SEMANTIC_STOP_WORDS = new Set([
  "about", "after", "agent", "anh", "before", "cho", "code", "continue", "cua", "em", "file", "fix", "giup",
  "implement", "kiem", "lam", "logic", "please", "project", "sua", "task", "test", "tiep", "tuc", "that", "the",
  "this", "them", "then", "there", "these", "update", "verify", "viec", "with", "xem"
]);

function semanticTerms(value: string): Set<string> {
  const terms = fold(value).match(/[a-z0-9_.\/-]{3,}/g) ?? [];
  return new Set(terms.filter((term) => !SEMANTIC_STOP_WORDS.has(term)));
}

function semanticSimilarity(left: string, right: string): number {
  const a = semanticTerms(left);
  const b = semanticTerms(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

export function operatorMessages(messages: MessageLike[]): MessageLike[] {
  return messages.filter((message) => message.role === "user" && messageText(message).trim());
}

export function detectSemanticBoundary(messages: MessageLike[]): SemanticBoundary {
  const users = operatorMessages(messages);
  const currentText = messageText(users.at(-1) ?? {});
  const previousText = messageText(users.at(-2) ?? {});
  const currentPhase = classifySemanticPhase(currentText);
  const previousPhase = classifySemanticPhase(previousText);
  const similarity = semanticSimilarity(previousText, currentText);
  if (!previousText || !currentText) return { kind: "none", previousPhase, currentPhase, similarity };

  const phaseChanged = currentPhase !== "unknown"
    && previousPhase !== "unknown"
    && currentPhase !== previousPhase
    && ["plan", "implement", "verify", "review", "release"].includes(currentPhase);
  if (phaseChanged) return { kind: "phase", previousPhase, currentPhase, similarity };

  const continuation = /\b(continue|tiep tuc|proceed|carry on|oke|ok|do it|lam tiep|sua tiep)\b/.test(fold(currentText));
  if (!continuation && currentText.length >= 24 && previousText.length >= 24 && similarity < 0.12) {
    return { kind: "task", previousPhase, currentPhase, similarity };
  }
  return { kind: "none", previousPhase, currentPhase, similarity };
}

function toolCalls(message: MessageLike): any[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((block: any) => block?.type === "toolCall");
}

function toolCallId(block: any): string {
  return String(block?.id ?? block?.toolCallId ?? "").trim();
}

export function auditToolProtocol(messages: MessageLike[]): ToolProtocolAudit {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages) {
    for (const call of toolCalls(message)) {
      const id = toolCallId(call);
      if (id) calls.set(id, (calls.get(id) ?? 0) + 1);
    }
    if (message.role !== "toolResult") continue;
    const id = String(message.toolCallId ?? "").trim();
    if (id) results.set(id, (results.get(id) ?? 0) + 1);
  }
  const orphanCallIds = [...calls]
    .filter(([id, count]) => (results.get(id) ?? 0) !== count)
    .map(([id]) => id)
    .sort();
  const orphanResultIds = [...results]
    .filter(([id, count]) => (calls.get(id) ?? 0) !== count)
    .map(([id]) => id)
    .sort();
  return {
    intact: orphanCallIds.length === 0 && orphanResultIds.length === 0,
    orphanCallIds,
    orphanResultIds
  };
}

function canonicalToolArguments(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonical(child)])
    );
  };
  try {
    return JSON.stringify(canonical(value));
  } catch {
    return String(value ?? "");
  }
}

function toolTarget(name: string, input: Record<string, unknown>): string {
  const candidate = input.url ?? input.path ?? input.file_path ?? input.filePath ?? input.target ?? input.query ?? input.pattern
    ?? input.command ?? input.cmd ?? input.script ?? "";
  if (candidate) return safeText(candidate, name === "bash" ? 320 : 180);
  if (Array.isArray(input.queries) && input.queries.length > 0) {
    return safeText(input.queries.join(" | "), 180);
  }
  const selector = [
    input.responseId ?? input.response_id,
    input.urlIndex ?? input.url_index,
    input.offset,
    input.limit
  ];
  if (selector.some((value) => value !== undefined && value !== null && value !== "")) {
    return safeText([
      selector[0] === undefined ? "" : `responseId=${String(selector[0])}`,
      selector[1] === undefined ? "" : `urlIndex=${String(selector[1])}`,
      selector[2] === undefined ? "" : `offset=${String(selector[2])}`,
      selector[3] === undefined ? "" : `limit=${String(selector[3])}`
    ].filter(Boolean).join(" "), 180);
  }
  return safeText(candidate, name === "bash" ? 320 : 180);
}

function toolKind(name: string, target: string): ToolObservation["kind"] {
  const normalized = name.toLowerCase();
  if (READ_TOOLS.has(normalized)) return "read";
  if ((normalized === "bash" || normalized === "exec" || normalized === "exec_command") && VERIFIER_PATTERN.test(target)) return "verify";
  if (MUTATION_TOOLS.has(normalized) || (normalized === "bash" && MUTATION_COMMAND_PATTERN.test(target))) return "mutation";
  return "other";
}

export function toolObservations(messages: MessageLike[]): ToolObservation[] {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const observations: ToolObservation[] = [];
  for (const message of messages) {
    for (const call of toolCalls(message)) {
      calls.set(String(call.id ?? ""), {
        name: String(call.name ?? "tool"),
        input: call.arguments && typeof call.arguments === "object" ? call.arguments : {}
      });
    }
    if (message.role !== "toolResult") continue;
    const call = calls.get(String(message.toolCallId ?? ""));
    const name = String(message.toolName ?? call?.name ?? "tool").toLowerCase();
    const input = call?.input ?? {};
    const target = toolTarget(name, input);
    const identitySource = `${name}\u0000${canonicalToolArguments(input)}`;
    observations.push({
      identity: crypto.createHash("sha256").update(identitySource).digest("hex").slice(0, 16),
      name,
      target,
      kind: toolKind(name, target),
      isError: message.isError === true,
      tokens: estimateGovernorMessageTokens(message)
    });
  }
  return observations;
}

export function analyzeContextResidency(messages: MessageLike[]): ContextResidencyMetrics {
  const observations = toolObservations(messages);
  const seen = new Set<string>();
  let duplicateResults = 0;
  let lowValueTokens = 0;
  for (const observation of observations) {
    if (seen.has(observation.identity)) duplicateResults += 1;
    seen.add(observation.identity);
    if (observation.kind === "read" && !observation.isError) lowValueTokens += observation.tokens;
  }
  const estimatedMessageTokens = estimateGovernorMessagesTokens(messages);
  return {
    estimatedMessageTokens,
    toolResults: observations.length,
    readResults: observations.filter((item) => item.kind === "read").length,
    mutationResults: observations.filter((item) => item.kind === "mutation").length,
    verifierResults: observations.filter((item) => item.kind === "verify").length,
    failedResults: observations.filter((item) => item.isError).length,
    duplicateResults,
    duplicateResultRate: observations.length > 0 ? duplicateResults / observations.length : 0,
    lowValueTokenShare: estimatedMessageTokens > 0 ? lowValueTokens / estimatedMessageTokens : 0,
    userTurns: operatorMessages(messages).length
  };
}

export function reasonForProjection(
  effectiveTokens: number,
  contextWindow: number,
  boundary: SemanticBoundary,
  residency: ContextResidencyMetrics
): { reason: ContextGovernorDecision["reason"]; codes: string[] } {
  const percent = contextWindow > 0 ? (effectiveTokens / contextWindow) * 100 : 0;
  if (effectiveTokens >= CONTEXT_PROVIDER_PROMPT_CEILING_TOKENS || percent >= 68) {
    return { reason: "provider-ceiling", codes: ["provider-prompt-headroom", "preserve-output-budget"] };
  }
  if (boundary.kind !== "none" && (
    effectiveTokens >= CONTEXT_GOVERNOR_SEMANTIC_BOUNDARY_TOKENS
    || residency.toolResults >= 8
  )) {
    return { reason: "semantic-boundary", codes: [`${boundary.kind}-boundary`, "fresh-working-set"] };
  }
  if (residency.toolResults >= CONTEXT_GOVERNOR_TOOL_ROUND_LIMIT && (
    residency.duplicateResultRate >= 0.12
    || residency.readResults >= Math.ceil(CONTEXT_GOVERNOR_TOOL_ROUND_LIMIT * 0.5)
    || effectiveTokens >= CONTEXT_GOVERNOR_TARGET_MESSAGE_TOKENS
  )) {
    return { reason: "residency", codes: ["tool-round-residency", residency.duplicateResults > 0 ? "duplicate-delta" : "stale-read-residency"] };
  }
  if ((effectiveTokens >= CONTEXT_GOVERNOR_PRESSURE_TOKENS || percent >= 52)
    && residency.toolResults >= 8) {
    return { reason: "pressure", codes: ["context-pressure", "value-density"] };
  }
  return { reason: "none", codes: [] };
}

export function minimumContextSavingsTokens(occupancyTokens: number): number {
  const proportional = Math.ceil(Math.max(0, occupancyTokens) * CONTEXT_GOVERNOR_MIN_SAVINGS_RATIO);
  return Math.max(
    CONTEXT_GOVERNOR_MIN_SAVINGS_FLOOR_TOKENS,
    Math.min(CONTEXT_GOVERNOR_MIN_SAVINGS_CEILING_TOKENS, proportional)
  );
}

function toolProtocolSafeCuts(messages: MessageLike[]): number[] {
  const callIndexes = new Map<string, number>();
  const pairSpans: Array<{ call: number; result: number }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    for (const call of toolCalls(message)) {
      const id = toolCallId(call);
      if (id && !callIndexes.has(id)) callIndexes.set(id, index);
    }
    if (message.role !== "toolResult") continue;
    const id = String(message.toolCallId ?? "").trim();
    const call = callIndexes.get(id);
    if (call !== undefined) pairSpans.push({ call, result: index });
  }

  const blockedDeltas = new Int32Array(messages.length + 2);
  for (const span of pairSpans) {
    blockedDeltas[span.call + 1] += 1;
    blockedDeltas[span.result + 1] -= 1;
  }
  const cuts: number[] = [];
  let blocked = 0;
  for (let cut = 0; cut <= messages.length; cut += 1) {
    blocked += blockedDeltas[cut] ?? 0;
    if (blocked > 0) continue;
    cuts.push(cut);
  }
  return cuts;
}

export function safeSuffixStart(
  messages: MessageLike[],
  recentTokenBudget: number,
  protectedBoundaryGroups = CONTEXT_GOVERNOR_PROTECTED_BOUNDARY_GROUPS
): number {
  if (!auditToolProtocol(messages).intact) return 0;
  let tokens = 0;
  let rawStart = messages.length;
  while (rawStart > 0 && tokens < recentTokenBudget) {
    rawStart -= 1;
    tokens += estimateGovernorMessageTokens(messages[rawStart]!);
  }

  const safeCuts = toolProtocolSafeCuts(messages);
  const budgetStart = [...safeCuts].reverse().find((cut) => cut <= rawStart) ?? 0;
  const protectedGroups = Math.max(0, Math.floor(protectedBoundaryGroups));
  const protectedIndex = Math.max(0, safeCuts.length - 1 - protectedGroups);
  const protectedStart = safeCuts[protectedIndex] ?? 0;
  return Math.min(budgetStart, protectedStart);
}

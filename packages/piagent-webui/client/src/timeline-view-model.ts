import type { TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import { assistantFailureReason, successfulAssistantText } from "./transcript-view-model.ts";

// The coding-agent timeline: one turn per user message, holding the tool
// steps the agent took, its answer, a failure (until a retry answers) and
// what the turn cost: model requests, tokens and wall time.
export type TimelineTool = TranscriptItem["toolCalls"][number];
export type TimelineProcess = NonNullable<TranscriptItem["process"]>;
export type TimelineStep = { kind: "tool"; key: string; tool: TimelineTool } | { kind: "note"; key: string; text: string }
  | { kind: "process"; key: string; process: TimelineProcess };
export type TimelineFailure = NonNullable<TranscriptItem["failure"]>;
export type TimelineTurn = {
  key: string; user: TranscriptItem; steps: TimelineStep[]; answer: string | null; failure: string | null; failureDetail: TimelineFailure | null;
  requests: number; tokens: number; model: string | null; startedAt: string | null; endedAt: string | null;
  // How the turn ended against the Harness workflow (shown after the answer).
  process: TimelineProcess | null;
  // Output tokens and the time the model took to produce them (each request
  // from when it was sent until its answer was stored), for tokens per second.
  outputTokens: number; generationMs: number;
};

function turnFor(user: TranscriptItem, key: string): TimelineTurn {
  return { key, user, steps: [], answer: null, failure: null, failureDetail: null, requests: 0, tokens: 0, model: null, process: null,
    startedAt: user.recordedAt, endedAt: null, outputTokens: 0, generationMs: 0 };
}

const QUIET_PHASES = new Set<string>(["objection", "rejudge", "dispute"]);
export function timelineTurns(items: readonly TranscriptItem[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let current: TimelineTurn | null = null, sentAt = NaN;
  for (const item of items) {
    // A request goes out when the message before it (the user's, or the last
    // tool result) is stored.
    const at = Date.parse(item.recordedAt), requestedAt = sentAt;
    if (item.role !== "custom") sentAt = at;
    if (item.role === "user") { current = turnFor(item, item.messageRef); turns.push(current); continue; }
    // A page may begin inside a turn: nothing is shown before its user
    // message is on the page ("Load older messages" brings it in).
    if (!current) continue;
    // Results are shown on their tool call; the item itself carries nothing.
    if (item.role === "tool-result") continue;
    current.endedAt = item.recordedAt;
    // The harness's process step (checks, review, how the turn ended).
    // An answer the harness sent back (run checks, fix findings) becomes a
    // step; a step that asks nothing of the agent (a helper's objection, the
    // reviewer judging its answer, a disagreement for the member) leaves it the answer.
    if (item.role === "custom" && item.process) {
      if (item.process.phase === "final") { current.process = item.process; continue; }
      if (current.answer && !QUIET_PHASES.has(item.process.phase)) { current.steps.push({ kind: "note", key: `${item.messageRef}:answer`, text: current.answer }); current.answer = null; }
      current.steps.push({ kind: "process", key: item.messageRef, process: item.process }); continue;
    }
    if (item.role === "assistant" && item.usage?.outputTokens && at > requestedAt) {
      current.outputTokens += item.usage.outputTokens; current.generationMs += at - requestedAt;
    }
    if (item.role === "assistant") {
      // A failure before anything reached Studio is not a model request.
      if (!item.failure?.local) current.requests += 1;
      current.tokens += item.usage?.totalTokens ?? 0; current.model = item.model ?? current.model;
    }
    const failure = assistantFailureReason(item);
    if (failure) { if (!current.answer) { current.failure = failure; current.failureDetail = item.failure ?? null; } continue; }
    for (const tool of item.toolCalls) current.steps.push({ kind: "tool", key: `${item.messageRef}:${tool.toolCallRef}`, tool });
    if (item.toolCalls.length) continue;
    const text = item.role === "assistant" ? successfulAssistantText(item.content.text ?? "") : item.content.text;
    if (!text) continue;
    if (item.role === "custom") { current.steps.push({ kind: "note", key: item.messageRef, text }); continue; }
    // An earlier, different answer of the same turn becomes a step; the last
    // one is the answer. A repeated identical answer is shown once.
    if (current.answer && current.answer.trim() !== text.trim()) current.steps.push({ kind: "note", key: `${item.messageRef}:previous`, text: current.answer });
    current.answer = text; current.failure = null; current.failureDetail = null;
  }
  return turns;
}

export function turnSeconds(turn: Pick<TimelineTurn, "startedAt" | "endedAt">): number | null {
  const start = Date.parse(turn.startedAt ?? ""), end = Date.parse(turn.endedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
}

// Output tokens per second over the turn's requests, waiting for the first
// token included: what the member experienced, not the provider's peak rate.
export function turnTokensPerSecond(turn: Pick<TimelineTurn, "outputTokens" | "generationMs">): number | null {
  // A few tokens of a tool call say nothing about speed.
  if (turn.outputTokens < 50 || turn.generationMs < 250) return null;
  const rate = turn.outputTokens / (turn.generationMs / 1000);
  return rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10;
}

// While an answer streams only its text is known: about four characters per
// token, from the first character. An estimate, replaced by the stored figure.
export function liveTokensPerSecond(characters: number, elapsedMs: number): number | null {
  if (characters < 40 || elapsedMs < 1000) return null;
  return Math.round(characters / 4 / (elapsedMs / 1000));
}

export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

// "src/cart.js · +7 −1" style counts for the Changes panel and tool cards.
export function changeCounts(added: number | null | undefined, removed: number | null | undefined): string {
  const parts = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`−${removed}`);
  return parts.join(" ");
}

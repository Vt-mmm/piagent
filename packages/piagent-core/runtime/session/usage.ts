import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CONTEXT_COMPACT_PERCENT,
  CONTEXT_FRESH_PERCENT,
  CONTEXT_WATCH_PERCENT,
  LONG_INPUT_CHARS
} from "../runtime-limits.ts";
import { modelLabel } from "./message-signals.ts";

export type UsageSnapshot = {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  cwd: string;
  mode: string;
  model: string;
  thinkingLevel: string;
  entries: {
    total: number;
    branch: number;
  };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  exactTotals: {
    availableInCommand: false;
    howToRead: string[];
  };
};

export type ContextPreflight = {
  workflow: string;
  inputChars: number;
  inputTokenEstimate: number;
  liveContext?: UsageSnapshot["contextUsage"];
  projectedContext?: {
    tokens: number;
    percent: number;
  };
  recommendation: "ok" | "watch" | "compact" | "fresh-session" | "unknown";
  reason: string;
  commands: string[];
};

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "unknown";
  return Math.round(value).toLocaleString("en-US");
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "unknown";
  return `${value.toFixed(1)}%`;
}

export function buildUsageSnapshot(ctx: ExtensionContext, thinkingLevel?: string): UsageSnapshot {
  const contextUsage = ctx.getContextUsage();
  const contextWithThinking = ctx as ExtensionContext & { getThinkingLevel?: () => string };
  return {
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionId: ctx.sessionManager.getSessionId(),
    sessionName: ctx.sessionManager.getSessionName(),
    cwd: ctx.cwd,
    mode: ctx.mode,
    model: modelLabel(ctx),
    thinkingLevel: thinkingLevel ?? contextWithThinking.getThinkingLevel?.() ?? "unknown",
    entries: {
      total: ctx.sessionManager.getEntries().length,
      branch: ctx.sessionManager.getBranch().length
    },
    contextUsage: contextUsage
      ? {
          tokens: contextUsage.tokens,
          contextWindow: contextUsage.contextWindow,
          percent: contextUsage.percent
        }
      : undefined,
    exactTotals: {
      availableInCommand: false,
      howToRead: [
        "Inside Pi TUI: run /session for exact tokens and cost.",
        "Outside Pi: run piagent-usage /path/to/project or scripts/pi-session-stats.sh /path/to/project.",
        "Historical totals: run piagent-usage --history /path/to/project --days 7."
      ]
    }
  };
}

export function formatUsageSnapshot(snapshot: UsageSnapshot): string {
  const context = snapshot.contextUsage
    ? `${formatCount(snapshot.contextUsage.tokens)} / ${formatCount(snapshot.contextUsage.contextWindow)} tokens (${formatPercent(snapshot.contextUsage.percent)})`
    : "unavailable";
  return [
    `usage: ${context}`,
    `session: ${snapshot.sessionName ?? "unnamed"} (${snapshot.sessionId ?? "unknown"})`,
    `model: ${snapshot.model}; thinking: ${snapshot.thinkingLevel}`,
    `entries: ${formatCount(snapshot.entries.branch)} active / ${formatCount(snapshot.entries.total)} total`,
    `file: ${snapshot.sessionFile ?? "not persisted"}`,
    "exact: /session | piagent-usage /path/to/project",
    "history: piagent-usage --history /path/to/project --days 7"
  ].join("\n");
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

export function buildContextPreflight(snapshot: UsageSnapshot, workflow = "task", inputChars = 0): ContextPreflight {
  const inputTokenEstimate = estimateTokensFromChars(inputChars);
  const live = snapshot.contextUsage;
  let projectedContext: ContextPreflight["projectedContext"];
  let recommendation: ContextPreflight["recommendation"] = "unknown";
  let reason = "Context usage is unavailable; use /session or /usage if the task is large.";

  if (live && live.tokens !== null && live.percent !== null) {
    const projectedTokens = live.tokens + inputTokenEstimate;
    const projectedPercent = live.contextWindow > 0 ? (projectedTokens / live.contextWindow) * 100 : live.percent;
    projectedContext = {
      tokens: projectedTokens,
      percent: projectedPercent
    };

    if (live.percent >= CONTEXT_FRESH_PERCENT || projectedPercent >= CONTEXT_FRESH_PERCENT || inputChars >= LONG_INPUT_CHARS) {
      recommendation = "fresh-session";
      reason = "Use a fresh governed session before this task to avoid provider context overflow and stale task state.";
    } else if (live.percent >= CONTEXT_COMPACT_PERCENT || projectedPercent >= CONTEXT_COMPACT_PERCENT) {
      recommendation = "compact";
      reason = "Compact before continuing; the current session is close to the high-context zone.";
    } else if (live.percent >= CONTEXT_WATCH_PERCENT || projectedPercent >= CONTEXT_WATCH_PERCENT) {
      recommendation = "watch";
      reason = "Proceed, but keep context targeted and avoid broad file injection.";
    } else {
      recommendation = "ok";
      reason = "Context is within the normal range for a bounded task.";
    }
  } else if (inputChars >= LONG_INPUT_CHARS) {
    recommendation = "fresh-session";
    reason = "The incoming request is large; start a fresh governed session and keep the full intake in a file.";
  }

  return {
    workflow,
    inputChars,
    inputTokenEstimate,
    liveContext: live,
    projectedContext,
    recommendation,
    reason,
    commands: [
      "/task-preflight",
      "/task-preflight compact",
      `/fresh ${workflow === "be-to-fe" ? "be-to-fe" : workflow === "scout" ? "scout" : "task"} <request>`,
      "/usage",
      "/session"
    ]
  };
}

export function formatContextPreflight(preflight: ContextPreflight, snapshot: UsageSnapshot): string {
  const live = preflight.liveContext
    ? `${formatCount(preflight.liveContext.tokens)} / ${formatCount(preflight.liveContext.contextWindow)} (${formatPercent(preflight.liveContext.percent)})`
    : "unavailable";
  const projected = preflight.projectedContext
    ? `${formatCount(preflight.projectedContext.tokens)} (${formatPercent(preflight.projectedContext.percent)})`
    : "unavailable";
  return [
    `preflight: ${preflight.recommendation}`,
    `workflow: ${preflight.workflow}`,
    `session: ${snapshot.sessionName ?? "unnamed"} (${snapshot.sessionId ?? "unknown"})`,
    `model: ${snapshot.model}; thinking: ${snapshot.thinkingLevel}`,
    `context: ${live}; projected: ${projected}`,
    `input: ~${formatCount(preflight.inputTokenEstimate)} tokens from ${formatCount(preflight.inputChars)} chars`,
    `reason: ${preflight.reason}`,
    `next: ${preflight.commands.join(" | ")}`
  ].join("\n");
}

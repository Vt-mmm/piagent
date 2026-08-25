import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.ts";
import {
  CONTEXT_GOVERNOR_RECENT_MESSAGE_TOKENS,
  CONTEXT_GOVERNOR_TARGET_MESSAGE_TOKENS
} from "../runtime-limits.ts";
import {
  GOVERNOR_VERSION,
  analyzeContextResidency,
  auditToolProtocol,
  detectSemanticBoundary,
  estimateGovernorMessagesTokens,
  minimumContextSavingsTokens,
  reasonForProjection,
  safeSuffixStart,
  type ContextGovernorDecision,
  type MessageLike
} from "./adaptive-context-analysis.ts";
import {
  buildAdaptiveContextLedger,
  deterministicTaskCompaction,
  ledgerMessage
} from "./adaptive-context-ledger.ts";

export {
  analyzeContextResidency,
  auditToolProtocol,
  classifySemanticPhase,
  detectSemanticBoundary,
  estimateGovernorMessageTokens,
  estimateGovernorMessagesTokens,
  minimumContextSavingsTokens
} from "./adaptive-context-analysis.ts";
export type {
  ContextGovernorAccounting,
  ContextGovernorDecision,
  ContextResidencyMetrics,
  SemanticBoundary,
  SemanticPhase,
  ToolProtocolAudit
} from "./adaptive-context-analysis.ts";
export {
  buildAdaptiveContextLedger,
  deterministicTaskCompaction
} from "./adaptive-context-ledger.ts";

export type ContextProjection = {
  messages: MessageLike[];
  decision: ContextGovernorDecision;
};

type ProjectionOptions = {
  reportedTokens?: number | null;
  contextWindow?: number | null;
  task?: TaskContract;
};

type GovernorSessionState = {
  lastProjection?: ContextGovernorDecision;
  lastProjectionTelemetryKey?: string;
  lastNoopTelemetryKey?: string;
  lastCompactionFallbackTelemetryKey?: string;
};

type GovernorDependencies = {
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

export function projectAdaptiveContext(messages: MessageLike[], options: ProjectionOptions = {}): ContextProjection {
  const original = Array.isArray(messages) ? messages : [];
  const residency = analyzeContextResidency(original);
  const boundary = detectSemanticBoundary(original);
  const providerReportedTokens = options.reportedTokens === null || options.reportedTokens === undefined
    ? null
    : Math.max(0, Number(options.reportedTokens) || 0);
  const reportedTokens = providerReportedTokens ?? 0;
  const contextWindow = Math.max(0, Number(options.contextWindow ?? 0) || 0);
  const effectiveTokens = Math.max(reportedTokens, residency.estimatedMessageTokens);
  const percent = contextWindow > 0 ? (effectiveTokens / contextWindow) * 100 : 0;
  const selected = reasonForProjection(effectiveTokens, contextWindow, boundary, residency);

  const accounting = (projectedTranscriptTokens: number) => ({
    contextOccupancy: {
      providerReportedTokens,
      transcriptEstimatedTokens: residency.estimatedMessageTokens,
      projectedTranscriptTokens,
      effectivePressureTokens: effectiveTokens,
      contextWindow
    },
    billedTraffic: {
      measured: false as const,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      governorProviderCalls: 0 as const,
      reason: "provider-billing-not-exposed-by-context-hook" as const
    }
  });
  const passthrough = (input: {
    reason?: ContextGovernorDecision["reason"];
    reasonCodes?: string[];
    fallback?: ContextGovernorDecision["fallback"];
    candidateProjectedMessageTokens?: number;
    estimatedSavingsTokens?: number;
    minimumSavingsTokens?: number;
  } = {}): ContextProjection => ({
    messages: original,
    decision: {
      version: GOVERNOR_VERSION,
      action: "passthrough",
      reason: input.reason ?? "none",
      reasonCodes: input.reasonCodes ?? [],
      reportedTokens,
      effectiveTokens,
      contextWindow,
      percent,
      originalMessageTokens: residency.estimatedMessageTokens,
      projectedMessageTokens: residency.estimatedMessageTokens,
      candidateProjectedMessageTokens: input.candidateProjectedMessageTokens ?? residency.estimatedMessageTokens,
      estimatedSavingsTokens: input.estimatedSavingsTokens ?? 0,
      minimumSavingsTokens: input.minimumSavingsTokens ?? 0,
      savingsRatio: residency.estimatedMessageTokens > 0
        ? (input.estimatedSavingsTokens ?? 0) / residency.estimatedMessageTokens
        : 0,
      fallback: input.fallback ?? "none",
      originalMessages: original.length,
      projectedMessages: original.length,
      accounting: accounting(residency.estimatedMessageTokens),
      boundary,
      residency
    }
  });
  if (selected.reason === "none" || original.length < 6) return passthrough();
  const originalProtocol = auditToolProtocol(original);
  if (!originalProtocol.intact) return passthrough({
    reason: selected.reason,
    reasonCodes: [
      ...selected.codes,
      "unsafe-tool-protocol",
      `orphan-calls:${originalProtocol.orphanCallIds.length}`,
      `orphan-results:${originalProtocol.orphanResultIds.length}`
    ],
    fallback: "unsafe-tool-protocol",
    minimumSavingsTokens: minimumContextSavingsTokens(residency.estimatedMessageTokens)
  });

  const configuredRecentBudget = selected.reason === "semantic-boundary"
    ? boundary.kind === "task" ? 20_000 : 30_000
    : selected.reason === "provider-ceiling" ? 32_000 : CONTEXT_GOVERNOR_RECENT_MESSAGE_TOKENS;
  // Reported provider usage includes static prompt/tool-schema tokens that are
  // not present in `messages`. When the dynamic transcript itself is smaller
  // than the configured suffix, retain a proportional recent working set so a
  // phase boundary or residency signal can still remove stale transcript.
  const recentBudget = Math.min(
    configuredRecentBudget,
    Math.max(8_000, Math.floor(residency.estimatedMessageTokens * 0.45))
  );
  const suffixStart = safeSuffixStart(original, recentBudget);
  const minimumSavingsTokens = minimumContextSavingsTokens(residency.estimatedMessageTokens);
  if (suffixStart <= 0) return passthrough({
    reason: selected.reason,
    reasonCodes: [...selected.codes, "no-protocol-safe-stale-prefix"],
    fallback: "no-safe-boundary",
    minimumSavingsTokens
  });
  const prefix = original.slice(0, suffixStart);
  const suffix = original.slice(suffixStart);
  const projected = [ledgerMessage(buildAdaptiveContextLedger(prefix, options.task), prefix), ...suffix];
  let projectedMessageTokens = estimateGovernorMessagesTokens(projected);

  // A single recent group can be large. Tighten once while preserving tool-call
  // protocol; never trim individual messages or tool result pairs.
  if (projectedMessageTokens > CONTEXT_GOVERNOR_TARGET_MESSAGE_TOKENS && suffix.length > 4) {
    const tighterStart = safeSuffixStart(original, Math.max(16_000, Math.floor(recentBudget * 0.62)));
    if (tighterStart > suffixStart) {
      const tighterPrefix = original.slice(0, tighterStart);
      const tighter = [ledgerMessage(buildAdaptiveContextLedger(tighterPrefix, options.task), tighterPrefix), ...original.slice(tighterStart)];
      const tighterTokens = estimateGovernorMessagesTokens(tighter);
      if (tighterTokens < projectedMessageTokens) {
        projected.splice(0, projected.length, ...tighter);
        projectedMessageTokens = tighterTokens;
      }
    }
  }

  const candidateProtocol = auditToolProtocol(projected);
  if (!candidateProtocol.intact) return passthrough({
    reason: selected.reason,
    reasonCodes: [
      ...selected.codes,
      "projected-tool-protocol-unsafe",
      `orphan-calls:${candidateProtocol.orphanCallIds.length}`,
      `orphan-results:${candidateProtocol.orphanResultIds.length}`
    ],
    fallback: "unsafe-tool-protocol",
    candidateProjectedMessageTokens: projectedMessageTokens,
    minimumSavingsTokens
  });

  const estimatedSavingsTokens = Math.max(0, residency.estimatedMessageTokens - projectedMessageTokens);
  if (estimatedSavingsTokens < minimumSavingsTokens) {
    return passthrough({
      reason: selected.reason,
      reasonCodes: [...selected.codes, "minimum-savings-not-met", "projection-no-op"],
      fallback: "insufficient-savings",
      candidateProjectedMessageTokens: projectedMessageTokens,
      estimatedSavingsTokens,
      minimumSavingsTokens
    });
  }

  return {
    messages: projected,
    decision: {
      version: GOVERNOR_VERSION,
      action: "project",
      reason: selected.reason,
      reasonCodes: selected.codes,
      reportedTokens,
      effectiveTokens,
      contextWindow,
      percent,
      originalMessageTokens: residency.estimatedMessageTokens,
      projectedMessageTokens,
      candidateProjectedMessageTokens: projectedMessageTokens,
      estimatedSavingsTokens,
      minimumSavingsTokens,
      savingsRatio: residency.estimatedMessageTokens > 0
        ? estimatedSavingsTokens / residency.estimatedMessageTokens
        : 0,
      fallback: "none",
      originalMessages: original.length,
      projectedMessages: projected.length,
      accounting: accounting(projectedMessageTokens),
      boundary,
      residency
    }
  };
}

function sessionKey(ctx: ExtensionContext): string {
  return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
}

function stateFor(states: Map<string, GovernorSessionState>, ctx: ExtensionContext): GovernorSessionState {
  const key = sessionKey(ctx);
  let state = states.get(key);
  if (!state) {
    state = {};
    states.set(key, state);
  }
  while (states.size > 100) states.delete(states.keys().next().value as string);
  return state;
}

export function registerAdaptiveContextGovernor(pi: ExtensionAPI, dependencies: GovernorDependencies): void {
  const states = new Map<string, GovernorSessionState>();

  pi.on("context", (event, ctx) => {
    const state = stateFor(states, ctx);
    const usage = ctx.getContextUsage();
    const projection = projectAdaptiveContext(event.messages as MessageLike[], {
      reportedTokens: usage?.tokens,
      contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
      task: dependencies.activeTask(ctx)
    });
    state.lastProjection = projection.decision;
    if (projection.decision.action === "project") {
      state.lastNoopTelemetryKey = undefined;
      const telemetryKey = [
        projection.decision.reason,
        projection.decision.originalMessages,
        projection.decision.projectedMessages,
        Math.round(projection.decision.effectiveTokens / 1_000)
      ].join(":");
      if (state.lastProjectionTelemetryKey !== telemetryKey) {
        state.lastProjectionTelemetryKey = telemetryKey;
        dependencies.telemetry(ctx, {
          event: "context_governor_projection",
          ...projection.decision
        });
      }
      return { messages: projection.messages as any[] };
    }
    if (projection.decision.fallback !== "none") {
      const telemetryKey = [
        projection.decision.reason,
        projection.decision.fallback,
        Math.floor(projection.decision.originalMessageTokens / Math.max(1, projection.decision.minimumSavingsTokens))
      ].join(":");
      if (state.lastNoopTelemetryKey !== telemetryKey) {
        state.lastNoopTelemetryKey = telemetryKey;
        dependencies.telemetry(ctx, {
          event: "context_governor_projection_noop",
          ...projection.decision
        });
      }
    }
    return undefined;
  });

  pi.on("session_before_compact", (event, ctx) => {
    const task = dependencies.activeTask(ctx);
    const messages = [
      ...(event.preparation.messagesToSummarize as MessageLike[]),
      ...(event.preparation.turnPrefixMessages as MessageLike[])
    ];
    const residency = analyzeContextResidency(messages);
    if (String(event.customInstructions ?? "").trim()) {
      const state = stateFor(states, ctx);
      const fallbackKey = `directed-host-summary:${event.preparation.firstKeptEntryId}`;
      if (state.lastCompactionFallbackTelemetryKey !== fallbackKey) {
        state.lastCompactionFallbackTelemetryKey = fallbackKey;
        dependencies.telemetry(ctx, {
          event: "context_governor_deterministic_compaction_skipped",
          reason: event.reason,
          willRetry: event.willRetry,
          fallback: "host-model-directed-summary",
          taskRunId: task?.taskRunId,
          residency
        });
      }
      return undefined;
    }
    // Nuanced discussion without a durable task still benefits from the host's
    // model summary. Coding-task and tool-heavy compactions are safely derived
    // from file-backed truth without spending another reasoning turn.
    if (!task && residency.toolResults < 12) return undefined;
    const protocol = auditToolProtocol(messages);
    if (!protocol.intact) {
      const fallbackKey = `unsafe-tool-boundary:${event.preparation.firstKeptEntryId}`;
      const state = stateFor(states, ctx);
      if (state.lastCompactionFallbackTelemetryKey !== fallbackKey) {
        state.lastCompactionFallbackTelemetryKey = fallbackKey;
        dependencies.telemetry(ctx, {
          event: "context_governor_compaction_cancelled",
          reason: event.reason,
          willRetry: event.willRetry,
          fallback: "no-op-unsafe-tool-boundary",
          taskRunId: task?.taskRunId,
          protocol
        });
      }
      return { cancel: true };
    }
    const compaction = deterministicTaskCompaction(event.preparation as any, task);
    const accounting = compaction.details.accounting as {
      minimumSavingsMet: boolean;
      estimatedSavingsTokens: number;
      minimumSavingsTokens: number;
    };
    const emergencyRecovery = event.reason === "overflow"
      && event.willRetry
      && accounting.estimatedSavingsTokens > 0;
    if (event.reason === "overflow" && event.willRetry && accounting.estimatedSavingsTokens === 0) {
      const state = stateFor(states, ctx);
      const fallbackKey = `overflow-host-recovery:${event.preparation.firstKeptEntryId}`;
      if (state.lastCompactionFallbackTelemetryKey !== fallbackKey) {
        state.lastCompactionFallbackTelemetryKey = fallbackKey;
        dependencies.telemetry(ctx, {
          event: "context_governor_deterministic_compaction_skipped",
          reason: event.reason,
          willRetry: event.willRetry,
          fallback: "host-model-overflow-recovery",
          taskRunId: task?.taskRunId,
          residency,
          accounting
        });
      }
      return undefined;
    }
    if (!accounting.minimumSavingsMet && !emergencyRecovery) {
      const state = stateFor(states, ctx);
      const fallbackKey = [
        "insufficient-savings",
        event.preparation.firstKeptEntryId,
        accounting.estimatedSavingsTokens,
        accounting.minimumSavingsTokens
      ].join(":");
      if (state.lastCompactionFallbackTelemetryKey !== fallbackKey) {
        state.lastCompactionFallbackTelemetryKey = fallbackKey;
        dependencies.telemetry(ctx, {
          event: "context_governor_compaction_cancelled",
          reason: event.reason,
          willRetry: event.willRetry,
          fallback: "no-op-insufficient-savings",
          taskRunId: task?.taskRunId,
          residency,
          accounting
        });
      }
      return { cancel: true };
    }
    stateFor(states, ctx).lastCompactionFallbackTelemetryKey = undefined;
    dependencies.telemetry(ctx, {
      event: "context_governor_deterministic_compaction",
      reason: event.reason,
      willRetry: event.willRetry,
      tokensBefore: compaction.tokensBefore,
      taskRunId: task?.taskRunId,
      residency,
      accounting,
      minimumSavingsOverride: emergencyRecovery ? "overflow-recovery" : undefined
    });
    return { compaction: compaction as any };
  });

  pi.on("agent_settled", (_event, ctx) => {
    const state = stateFor(states, ctx);
    // `agent_settled` is the operation's terminal boundary. Starting a host
    // compaction here can make the just-finished operation look active again
    // and race the next user message. Provider calls are already protected by
    // the wire-only `context` projection above; durable compaction remains
    // deterministic when the host requests it through session_before_compact.
    state.lastProjection = undefined;
    state.lastProjectionTelemetryKey = undefined;
    state.lastNoopTelemetryKey = undefined;
  });

  pi.on("session_compact", (_event, ctx) => {
    const state = stateFor(states, ctx);
    state.lastProjection = undefined;
    state.lastProjectionTelemetryKey = undefined;
    state.lastNoopTelemetryKey = undefined;
    state.lastCompactionFallbackTelemetryKey = undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    states.delete(sessionKey(ctx));
  });
}

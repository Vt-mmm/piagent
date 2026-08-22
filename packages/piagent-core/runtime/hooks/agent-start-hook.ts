import crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildContextPack,
  classifyContextTask,
  ensureContextIndexV2,
  estimateContextTokens
} from "../../extensions/context-engine.js";
import {
  buildSelectedContextPack,
  composeCriterionContextEntries
} from "../../extensions/criterion-context-pack.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { selectRepositoryMemoryFacts } from "../../extensions/repository-memory.js";
import type { TaskContract } from "../../extensions/guard-types.js";
import {
  contextPlanAcceptsConfidence,
  planAdaptiveContext
} from "../context/adaptive-planner.ts";
import { stageContextDelivery } from "../context/context-delivery.ts";
import { measureContextDeltaShadow, type ContextDeltaShadowMode } from "../context/context-delta-shadow.ts";
import { buildPrefixTelemetry } from "../context/prefix-telemetry.ts";
import { formatRepositoryMemoryHints } from "../context/repository-memory-hints.ts";
import { modelCapabilityFromContext } from "../model/capabilities.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import type { ModelRouteEvaluation } from "../model/model-route-runtime.ts";
import { buildTaskResumeContext } from "../recovery/resume-state.ts";
import { planRetrievalRoute } from "../context/retrieval-route-policy.ts";
import type { SolverShadowEvaluation } from "../solver/solver-shadow.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncOptions, TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import { trajectoryRecommendationRef } from "../trajectory/trajectory-runtime.ts";
import { RuntimeSessionState, type ContextInjectionItem } from "../session/runtime-state.ts";
import {
  compactManagedProjectInstructions,
  rewriteLegacyProjectInstructions
} from "../session/system-prompt.ts";
import { PIAGENT_TOOL_NAMES } from "../tools/tool-groups.ts";
import { extractTaskRequest, looksLikeGovernedBoilerplate } from "../workflows/input-routing.ts";
import {
  AUTO_INTAKE_SNAPSHOT_PATTERNS,
  automaticTaskIntakeMode
} from "../workflows/task-intake.ts";
import { CONTEXT_PACK_MAX_TOKENS } from "../runtime-limits.ts";
import { modelRouteTelemetry, runtimeSnapshotTelemetry, solverShadowTelemetry } from "./agent-prompt-telemetry.ts";

type RuntimeIntakeResult = {
  started: boolean;
  text: string;
  task?: TaskContract;
  plannedContext?: Array<{ path: string; reason: string }>;
};

type AgentStartHookDependencies = {
  state: RuntimeSessionState;
  autoContextEnabled: boolean;
  contextDeltaShadowMode: ContextDeltaShadowMode;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  readProtectedPaths: (ctx: ExtensionContext) => string[];
  contextExcludePatterns: (ctx: ExtensionContext) => string[];
  promptPackKey: (ctx: ExtensionContext, promptHash: string) => string;
  retrievalKey: (ctx: ExtensionContext, query: string) => string;
  startAutomaticTask: (query: string, ctx: ExtensionContext) => Promise<RuntimeIntakeResult | undefined>;
  runtimeSnapshot?: (ctx: ExtensionContext) => RuntimeModelSnapshot | undefined;
  persistRuntimeSnapshot?: (ctx: ExtensionContext, snapshot: RuntimeModelSnapshot) => unknown;
  shadowSolver?: (input: {
    request: string;
    ctx: ExtensionContext;
    activeTask?: TaskContract;
    runtimeSnapshot?: RuntimeModelSnapshot;
    protectedTarget: boolean;
  }) => SolverShadowEvaluation;
  modelRoute?: (input: {
    ctx: ExtensionContext;
    features: NonNullable<Extract<SolverShadowEvaluation, { status: "ok" }>["features"]>;
    runtimeSnapshot?: RuntimeModelSnapshot;
  }) => Promise<ModelRouteEvaluation>;
  syncTrajectory?: (ctx: ExtensionContext, task: TaskContract, options: TrajectorySyncOptions) => TrajectorySyncResult;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

export function registerAgentStartHook(pi: ExtensionAPI, dependencies: AgentStartHookDependencies): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const projectInstructions = rewriteLegacyProjectInstructions(event.systemPrompt);
    const query = looksLikeGovernedBoilerplate(event.prompt) ? extractTaskRequest(event.prompt) : event.prompt.trim();
    const signal = classifyContextTask(query);
    const turn = dependencies.state.currentTurn(ctx, signal.promptHash) ?? dependencies.state.beginTurn(ctx, signal.promptHash);
    const readProtectedPaths = dependencies.readProtectedPaths(ctx);
    const protectedTarget = signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const protectedOnlyTarget = signal.paths.length > 0
      && signal.paths.every((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const sessionTask = dependencies.activeTask(ctx);
    const activeTask = sessionTask?.trace.outcome === "pending" ? sessionTask : undefined;
    const runtimeIntakeMode = !activeTask ? automaticTaskIntakeMode(query, readProtectedPaths) : undefined;
    const runtimeIntake = Boolean(runtimeIntakeMode);
    const compactMode = protectedOnlyTarget
      ? "protected"
      : runtimeIntake || activeTask?.intakeMode === "runtime"
        ? "automatic"
        : undefined;
    const compactedInstructions = compactMode
      ? compactManagedProjectInstructions(projectInstructions.systemPrompt, compactMode)
      : { systemPrompt: projectInstructions.systemPrompt, compacted: false };
    const effectiveSystemPrompt = compactedInstructions.systemPrompt;
    const systemPromptUpdate = effectiveSystemPrompt !== event.systemPrompt
      ? { systemPrompt: effectiveSystemPrompt }
      : undefined;
    if (activeTask) observeTrajectorySync(ctx, dependencies.syncTrajectory?.(ctx, activeTask, { sourceHook: "agent-start" }), dependencies.telemetry);
    const active = new Set<string>(pi.getActiveTools() as string[]);
    const toolMetadata = pi.getAllTools()
      .filter((tool) => active.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }));
    const prefix = buildPrefixTelemetry(effectiveSystemPrompt, toolMetadata);
    const toolSchemaTokens = estimateContextTokens(prefix.canonicalToolSurface);
    const systemPromptTokens = estimateContextTokens(effectiveSystemPrompt);
    const autoPackUseful = activeTask?.trace.outcome !== "pending"
      && (runtimeIntake || signal.paths.length === 0);
    let runtimeSnapshot: RuntimeModelSnapshot | undefined;
    try {
      runtimeSnapshot = dependencies.runtimeSnapshot?.(ctx);
      if (runtimeSnapshot) dependencies.persistRuntimeSnapshot?.(ctx, runtimeSnapshot);
    } catch {
      runtimeSnapshot = undefined;
    }
    let solverShadow: SolverShadowEvaluation | undefined;
    try {
      solverShadow = dependencies.shadowSolver?.({ request: query, ctx, activeTask, runtimeSnapshot, protectedTarget: protectedOnlyTarget });
    } catch (error) {
      solverShadow = { status: "error", durationMs: 0, warnings: [error instanceof Error ? error.message : String(error)] };
    }
    let modelRoute: ModelRouteEvaluation | undefined;
    if (solverShadow?.status === "ok") {
      try {
        modelRoute = await dependencies.modelRoute?.({ ctx, features: solverShadow.features, runtimeSnapshot });
      } catch (error) {
        modelRoute = { status: "error", durationMs: 0, warnings: [error instanceof Error ? error.message : String(error)] };
      }
    }
    const recommendationRef = solverShadow?.status === "ok" ? trajectoryRecommendationRef(solverShadow.decision) : null;
    if (activeTask) observeTrajectorySync(ctx, dependencies.syncTrajectory?.(ctx, activeTask, { sourceHook: "agent-start", recommendationRef }), dependencies.telemetry);
    dependencies.telemetry(ctx, {
      event: "agent_prompt",
      turnId: turn.turnId,
      promptHash: signal.promptHash,
      promptChars: signal.promptChars,
      workflow: signal.workflow,
      riskLane: signal.lane,
      activeTools: active.size,
      activePiagentTools: [...active].filter((toolName) => PIAGENT_TOOL_NAMES.has(toolName)).length,
      toolSchemaTokens,
      systemPromptTokens,
      systemPromptHash: prefix.systemPromptHash,
      toolSchemaHash: prefix.toolSchemaHash,
      prefixSurfaceHash: prefix.prefixSurfaceHash,
      taskRunId: activeTask?.taskRunId,
      legacyProjectInstructionsRewritten: projectInstructions.rewritten,
      managedInstructionsCompacted: compactedInstructions.compacted,
      contextUsage: ctx.getContextUsage(),
      runtimeSnapshot: runtimeSnapshotTelemetry(runtimeSnapshot),
      solverShadow: solverShadowTelemetry(solverShadow),
      modelRoute: modelRouteTelemetry(modelRoute)
    });

    const finishAgentStart = async (contextMessage?: {
      customType: string;
      content: string;
      details: Record<string, unknown>;
    }) => {
      const resumed = activeTask ? dependencies.state.takeResumeContextState(ctx, activeTask.taskRunId) : undefined;
      const durableResume = activeTask && resumed ? buildTaskResumeContext(activeTask, resumed) : undefined;
      const selectedContext = contextMessage ?? durableResume;
      const intake = await dependencies.startAutomaticTask(query, ctx);
      if (intake?.task) observeTrajectorySync(ctx, dependencies.syncTrajectory?.(ctx, intake.task, { sourceHook: "agent-start", recommendationRef }), dependencies.telemetry);
      if (!selectedContext && !intake) return systemPromptUpdate;
      const discoveryItems = selectedContext?.customType === "piagent-context-pack-v2" && Array.isArray(selectedContext.details.selectedItems)
        ? selectedContext.details.selectedItems as Array<Record<string, unknown>>
        : [];
      const discoveryPlan = selectedContext?.customType === "piagent-context-pack-v2"
        && selectedContext.details.contextPlan && typeof selectedContext.details.contextPlan === "object"
        ? selectedContext.details.contextPlan as { budgetTokens?: unknown; limit?: unknown }
        : undefined;
      const fallbackBudget = signal.paths.length === 0 ? 680 : signal.lane === "tiny" ? 420 : 560;
      const criterionBudget = Number.isFinite(Number(discoveryPlan?.budgetTokens))
        ? Math.max(100, Math.min(CONTEXT_PACK_MAX_TOKENS, Math.trunc(Number(discoveryPlan?.budgetTokens))))
        : fallbackBudget;
      const criterionLimit = Number.isFinite(Number(discoveryPlan?.limit))
        ? Math.max(1, Math.min(6, Math.trunc(Number(discoveryPlan?.limit))))
        : signal.paths.length > 0 ? 3 : 4;
      const criterionMode = dependencies.autoContextEnabled && intake?.task?.criterionGraph?.mode === "criterion-graph";
      const criterionEntries = intake?.task?.criterionGraph?.mode === "criterion-graph"
        ? composeCriterionContextEntries({
            explicitPaths: signal.paths,
            criteria: intake.task.acceptanceCriteria,
            plannedEntries: intake.plannedContext ?? [],
            retrievedItems: discoveryItems
          }, { limit: criterionLimit })
        : [];
      const criterionContext = criterionMode
        ? buildSelectedContextPack(ctx.cwd, criterionEntries, {
            budgetTokens: criterionBudget,
            limit: criterionLimit,
            focusText: [query, ...intake.task.acceptanceCriteria].join("\n"),
            excludePatterns: dependencies.contextExcludePatterns(ctx)
          })
        : undefined;
      const criterionReasonCode = !dependencies.autoContextEnabled
        ? "auto-context-disabled"
        : intake?.task?.criterionGraph?.mode !== "criterion-graph"
          ? "criterion-graph-unavailable"
          : criterionEntries.length === 0
            ? "no-candidates"
            : !criterionContext?.selected.length ? "no-readable-selection" : "selected";
      if (intake?.task) dependencies.telemetry(ctx, {
        event: "criterion_context_pack", turnId: turn.turnId, selected: criterionContext?.selected.length ?? 0,
        candidates: criterionEntries.length,
        budgetTokens: criterionBudget,
        estimatedTokens: criterionContext?.estimatedTokens ?? 0,
        reasonCode: criterionReasonCode,
        selectedPaths: criterionContext?.selected.map((entry) => entry.path) ?? []
      });
      const composedContext = criterionContext?.selected.length ? criterionContext : undefined;
      const deliveredSelectedContext = criterionMode ? undefined : selectedContext;
      const content = [deliveredSelectedContext?.content, intake?.text, composedContext?.text].filter(Boolean).join("\n\n");
      const deliveryTask = intake?.task ?? activeTask;
      const selectedPackPaths = deliveredSelectedContext?.customType === "piagent-context-pack-v2" && Array.isArray(deliveredSelectedContext.details.paths)
        ? deliveredSelectedContext.details.paths.filter((value): value is string => typeof value === "string")
        : [];
      const criterionPaths = composedContext?.selected.map((entry) => entry.path) ?? [];
      const selectedPackItems = (deliveredSelectedContext?.details.selectedItems as ContextInjectionItem[] | undefined)
        ?? selectedPackPaths.map((path) => ({ path, estimatedTokens: 0 }));
      const injectionItems: ContextInjectionItem[] = composedContext?.selected ?? selectedPackItems;
      const deliveryEntries = new Map<string, { path: string; reason: string }>();
      for (const filePath of selectedPackPaths) {
        deliveryEntries.set(filePath, {
          path: filePath,
          reason: "Runtime confirmed delivery of a bounded Context Engine navigation pack."
        });
      }
      for (const filePath of criterionPaths) {
        deliveryEntries.set(filePath, {
          path: filePath,
          reason: "Runtime confirmed delivery of criterion-selected context."
        });
      }
      const deliveryId = deliveryTask && deliveryEntries.size > 0 ? crypto.randomUUID() : undefined;
      if (deliveryTask && deliveryId) {
        const retrievalKey = typeof deliveredSelectedContext?.details.retrievalKey === "string" ? deliveredSelectedContext.details.retrievalKey : undefined;
        stageContextDelivery(ctx, {
          deliveryId,
          taskRunId: deliveryTask.taskRunId,
          turnId: turn.turnId,
          entries: [...deliveryEntries.values()],
          pack: retrievalKey
            ? {
                retrievalKey,
                queryHash: String(deliveredSelectedContext?.details.queryHash ?? ""),
                confidence: String(deliveredSelectedContext?.details.confidence ?? "unknown"),
                estimatedTokens: Number(deliveredSelectedContext?.details.estimatedTokens ?? 0),
                paths: selectedPackPaths
              }
            : undefined,
          injection: {
            source: composedContext ? "criterion-pack" : deliveredSelectedContext?.customType === "piagent-context-pack-v2" ? "auto-pack" : "criterion-seed",
            queryHash: String(deliveredSelectedContext?.details.queryHash ?? signal.promptHash),
            confidence: String(deliveredSelectedContext?.details.confidence ?? (criterionPaths.length > 0 ? "high" : "unknown")),
            estimatedTokens: Number(deliveredSelectedContext?.details.estimatedTokens ?? composedContext?.estimatedTokens ?? 0),
            selectedItems: injectionItems
          }
        }, { state: dependencies.state, telemetry: dependencies.telemetry });
      }
      return {
        ...(systemPromptUpdate ?? {}),
        message: {
          customType: deliveredSelectedContext?.customType ?? "piagent-runtime-task-intake",
          content,
          display: false,
          details: {
            ...(deliveredSelectedContext?.details ?? {}),
            ...(composedContext ? {
              schemaVersion: 1,
              queryHash: signal.promptHash,
              estimatedTokens: composedContext.estimatedTokens,
              paths: composedContext.selected.map((entry) => entry.path),
              selectedItems: composedContext.selected
            } : {}),
            contextDelivery: deliveryId ? { schemaVersion: 1, deliveryId } : undefined,
            runtimeTask: intake?.task
              ? {
                  taskId: intake.task.taskId,
                  taskRunId: intake.task.taskRunId,
                  changeMode: intake.task.changeMode,
                  mutationPolicy: intake.task.mutationPolicy,
                  scope: intake.task.scope,
                  verifyCommands: intake.task.verifyCommands,
                  criterionGraph: intake.task.criterionGraph ? { mode: intake.task.criterionGraph.mode, graphDigest: intake.task.criterionGraph.graphDigest, nodes: intake.task.criterionGraph.nodes.length } : null,
                  intakeMode: intake.task.intakeMode
                }
              : undefined,
            criterionContext: composedContext ? {
              paths: composedContext.selected.map((entry) => entry.path), estimatedTokens: composedContext.estimatedTokens
            } : undefined,
            runtimeIntakeStarted: intake?.started ?? false
          }
        }
      };
    };

    const packKey = dependencies.promptPackKey(ctx, signal.promptHash);
    if (!autoPackUseful && activeTask?.trace.outcome === "pending" && query.length >= 20 && signal.workflow !== "usage" && dependencies.autoContextEnabled) {
      await measureContextDeltaShadow({ ctx, query, turnId: turn.turnId, task: activeTask, mode: dependencies.contextDeltaShadowMode, protectedTarget, excludePatterns: dependencies.contextExcludePatterns(ctx), telemetry: dependencies.telemetry });
    }
    if (
      query.length < 20
      || signal.workflow === "usage"
      || !dependencies.autoContextEnabled
      || !autoPackUseful
      || dependencies.state.hasAutoPackedPrompt(packKey)
    ) {
      return finishAgentStart();
    }

    dependencies.state.rememberAutoPackedPrompt(packKey);
    try {
      const excludePatterns = dependencies.contextExcludePatterns(ctx);
      const ensured = await ensureContextIndexV2(ctx.cwd, {
        excludePatterns,
        rebuildMissing: false
      });
      const status = ensured.status;
      if (solverShadow?.status === "ok") {
        const retrievalRoute = planRetrievalRoute({
          features: solverShadow.features,
          indexReady: status.exists && !status.stale,
          observedConfidence: "unknown",
          helpersMode: "recommend"
        });
        dependencies.telemetry(ctx, {
          event: "retrieval_route",
          activation: retrievalRoute.activation,
          specialistRole: retrievalRoute.specialistRole,
          tools: retrievalRoute.tools,
          maxParallel: retrievalRoute.maxParallel,
          maxRounds: retrievalRoute.maxRounds,
          budgetBand: retrievalRoute.budgetBand,
          automaticDispatch: retrievalRoute.automaticDispatch,
          planDigest: retrievalRoute.planDigest,
          reasonCodes: retrievalRoute.reasonCodes
        });
      }
      if (!status.exists || status.stale) {
        dependencies.telemetry(ctx, {
          event: "context_pack",
          turnId: turn.turnId,
          queryHash: signal.promptHash,
          confidence: "none",
          candidates: 0,
          selected: 0,
          skipped: status.exists ? "stale-index" : "missing-index"
        });
        return finishAgentStart();
      }
      const modelCapability = modelCapabilityFromContext(ctx, String(pi.getThinkingLevel()));
      const plan = planAdaptiveContext({
        prompt: query,
        activeTask,
        runtimeIntake,
        protectedOnlyTarget,
        contextUsage: ctx.getContextUsage(),
        modelCapability
      });
      dependencies.telemetry(ctx, {
        event: "context_plan",
        queryHash: signal.promptHash,
        phase: plan.phase,
        lane: plan.lane,
        shouldInject: plan.shouldInject,
        budgetTokens: plan.budgetTokens,
        limit: plan.limit,
        includeCode: plan.includeCode,
        minConfidence: plan.minConfidence,
        receipt: plan.receipt,
        reasons: plan.reasons,
        model: modelCapability.model,
        thinkingLevel: modelCapability.thinkingLevel,
        contextWindow: modelCapability.contextWindow
      });
      if (!plan.shouldInject) return finishAgentStart();
      const pack = await buildContextPack(ctx.cwd, query, {
        budgetTokens: plan.budgetTokens,
        includeCode: plan.includeCode,
        includePatterns: plan.includePatterns ?? (runtimeIntake ? AUTO_INTAKE_SNAPSHOT_PATTERNS : undefined),
        currentSnapshot: plan.currentSnapshot,
        limit: plan.limit,
        excludePatterns
      });
      dependencies.telemetry(ctx, {
        event: "context_pack",
        turnId: turn.turnId,
        queryHash: pack.queryHash,
        confidence: pack.confidence,
        candidates: pack.candidates,
        selected: pack.selected.length,
        estimatedTokens: pack.estimatedTokens,
        selectedPaths: pack.selected.map((item) => item.path),
        finderRecommended: pack.finderRecommended,
        currentSnapshot: plan.currentSnapshot,
        planReceipt: plan.receipt
      });
      if (solverShadow?.status === "ok") {
        const retrievalRoute = planRetrievalRoute({
          features: solverShadow.features,
          indexReady: true,
          observedConfidence: ["none", "low", "medium", "high"].includes(pack.confidence) ? pack.confidence as "none" | "low" | "medium" | "high" : "unknown",
          helpersMode: "recommend"
        });
        dependencies.telemetry(ctx, {
          event: "retrieval_route_outcome",
          confidence: pack.confidence,
          activation: retrievalRoute.activation,
          specialistRole: retrievalRoute.specialistRole,
          maxParallel: retrievalRoute.maxParallel,
          maxRounds: retrievalRoute.maxRounds,
          automaticDispatch: retrievalRoute.automaticDispatch,
          planDigest: retrievalRoute.planDigest,
          reasonCodes: retrievalRoute.reasonCodes
        });
      }
      if (!contextPlanAcceptsConfidence(plan, pack.confidence) || pack.selected.length === 0) return finishAgentStart();
      const memoryBudgetTokens = Math.max(0, plan.budgetTokens - pack.estimatedTokens);
      const memoryHints = runtimeIntake
        ? { text: "", ids: [] }
        : formatRepositoryMemoryHints(
            selectRepositoryMemoryFacts(ctx.cwd, query, { limit: 2, excludePatterns }),
            memoryBudgetTokens
          );
      dependencies.telemetry(ctx, {
        event: "repository_memory_selected",
        queryHash: signal.promptHash,
        selected: memoryHints.ids.length,
        memoryIds: memoryHints.ids,
        budgetTokens: memoryBudgetTokens,
        estimatedTokens: estimateContextTokens(memoryHints.text),
        planReceipt: plan.receipt
      });
      return finishAgentStart({
        customType: "piagent-context-pack-v2",
        content: [pack.text, memoryHints.text].filter(Boolean).join("\n\n"),
        details: {
          schemaVersion: 2,
          queryHash: pack.queryHash,
          retrievalKey: dependencies.retrievalKey(ctx, query),
          confidence: pack.confidence,
          estimatedTokens: pack.estimatedTokens,
          paths: pack.selected.map((item) => item.path),
          selectedItems: pack.selected.map((item) => ({
            path: item.path,
            estimatedTokens: item.estimatedTokens,
            sources: item.sources,
            fileContentHash: item.fileContentHash,
            ...(item.sanitizedContentDigest ? { sanitizedContentDigest: item.sanitizedContentDigest } : {}),
            payloadHash: item.payloadHash,
            representation: item.representation,
            ranges: item.ranges,
            generation: item.generation,
            sensitiveContentRedacted: item.sensitiveContentRedacted
          })),
          repositoryMemoryIds: memoryHints.ids,
          currentSnapshot: plan.currentSnapshot,
          contextPlan: plan
        }
      });
    } catch (error) {
      dependencies.telemetry(ctx, {
        event: "context_pack",
        turnId: turn.turnId,
        queryHash: signal.promptHash,
        confidence: "none",
        candidates: 0,
        selected: 0,
        error: error instanceof Error ? error.message : String(error)
      });
      return finishAgentStart();
    }
  });
}

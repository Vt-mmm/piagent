import crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildContextPack,
  classifyContextTask,
  ensureContextIndexV2,
  estimateContextTokens
} from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { selectRepositoryMemoryFacts } from "../../extensions/repository-memory.js";
import type { TaskContract } from "../../extensions/guard-types.js";
import {
  contextPlanAcceptsConfidence,
  planAdaptiveContext
} from "../context/adaptive-planner.ts";
import { modelCapabilityFromContext } from "../model/capabilities.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import { runtimeModelSnapshotDigest } from "../model/runtime-snapshot.ts";
import type { ModelRouteEvaluation } from "../model/model-route-runtime.ts";
import { buildTaskResumeContext } from "../recovery/resume-state.ts";
import { planRetrievalRoute } from "../context/retrieval-route-policy.ts";
import type { SolverShadowEvaluation } from "../solver/solver-shadow.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncOptions, TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import { trajectoryRecommendationRef } from "../trajectory/trajectory-runtime.ts";
import { RuntimeSessionState } from "../session/runtime-state.ts";
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

type RuntimeIntakeResult = {
  started: boolean;
  text: string;
  task?: TaskContract;
};

type AgentStartHookDependencies = {
  state: RuntimeSessionState;
  autoContextEnabled: boolean;
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

function formatRepositoryMemoryHints(candidates: Array<{
  record: { id?: string; fact: string; citations: Array<{ path: string }> };
  matchedTerms: string[];
}>, budgetTokens: number): { text: string; ids: string[] } {
  if (budgetTokens < 80 || candidates.length === 0) return { text: "", ids: [] };
  const lines = [
    "[Piagent repository memory: advisory only]",
    "Verify every hint against the cited current file before relying on it."
  ];
  const ids: string[] = [];
  for (const candidate of candidates) {
    const paths = candidate.record.citations.slice(0, 4).map((citation) => citation.path).join(", ");
    const line = `- ${candidate.record.fact.slice(0, 320)} [sources: ${paths}]`;
    const proposed = [...lines, line].join("\n");
    if (estimateContextTokens(proposed) > budgetTokens) break;
    lines.push(line);
    if (candidate.record.id) ids.push(candidate.record.id);
  }
  return ids.length > 0 ? { text: lines.join("\n"), ids } : { text: "", ids: [] };
}

export function registerAgentStartHook(pi: ExtensionAPI, dependencies: AgentStartHookDependencies): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const projectInstructions = rewriteLegacyProjectInstructions(event.systemPrompt);
    const query = looksLikeGovernedBoilerplate(event.prompt) ? extractTaskRequest(event.prompt) : event.prompt.trim();
    const signal = classifyContextTask(query);
    const readProtectedPaths = dependencies.readProtectedPaths(ctx);
    const protectedOnlyTarget = signal.paths.length > 0
      && signal.paths.every((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const activeTask = dependencies.activeTask(ctx);
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
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines
      }));
    const toolSchemaTokens = estimateContextTokens(JSON.stringify(toolMetadata));
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
      promptHash: signal.promptHash,
      promptChars: signal.promptChars,
      workflow: signal.workflow,
      riskLane: signal.lane,
      activeTools: active.size,
      activePiagentTools: [...active].filter((toolName) => PIAGENT_TOOL_NAMES.has(toolName)).length,
      toolSchemaTokens,
      systemPromptTokens,
      systemPromptHash: crypto.createHash("sha256").update(effectiveSystemPrompt).digest("hex"),
      legacyProjectInstructionsRewritten: projectInstructions.rewritten,
      managedInstructionsCompacted: compactedInstructions.compacted,
      contextUsage: ctx.getContextUsage(),
      runtimeSnapshot: runtimeSnapshot
        ? {
            schemaVersion: runtimeSnapshot.schemaVersion,
            digest: runtimeModelSnapshotDigest(runtimeSnapshot),
            provider: runtimeSnapshot.provider,
            modelId: runtimeSnapshot.modelId,
            contextWindow: runtimeSnapshot.contextWindow,
            requestedThinkingLevel: runtimeSnapshot.requestedThinkingLevel,
            effectiveThinkingLevel: runtimeSnapshot.effectiveThinkingLevel,
            warningCount: runtimeSnapshot.warnings.length
          }
        : undefined,
      solverShadow: solverShadow?.status === "ok"
        ? {
            mode: solverShadow.decision.mode,
            route: solverShadow.decision.route,
            featureHash: solverShadow.features.featureHash,
            reasonCodes: solverShadow.decision.reasonCodes,
            confidence: solverShadow.decision.confidence,
            reused: solverShadow.reused,
            persisted: solverShadow.persisted,
            durationMs: solverShadow.durationMs,
            warnings: solverShadow.warnings
          }
        : solverShadow,
      modelRoute: modelRoute?.status === "ok"
        ? {
            mode: modelRoute.decision.mode,
            objective: modelRoute.decision.objective,
            capabilityBand: modelRoute.decision.capabilityBand,
            safetyFloor: modelRoute.decision.safetyFloor,
            disposition: modelRoute.decision.disposition,
            selectionSource: modelRoute.decision.selectionSource,
            provider: modelRoute.decision.provider,
            modelId: modelRoute.decision.modelId,
            effort: modelRoute.decision.effort,
            downgradeSteps: modelRoute.decision.downgradeSteps,
            enforced: modelRoute.decision.enforced,
            decisionDigest: modelRoute.decision.decisionDigest,
            reasonCodes: modelRoute.decision.reasonCodes,
            reused: modelRoute.reused,
            persisted: modelRoute.persisted,
            durationMs: modelRoute.durationMs,
            warnings: modelRoute.warnings
          }
        : modelRoute
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
      const content = [selectedContext?.content, intake?.text].filter(Boolean).join("\n\n");
      return {
        ...(systemPromptUpdate ?? {}),
        message: {
          customType: selectedContext?.customType ?? "piagent-runtime-task-intake",
          content,
          display: false,
          details: {
            ...(selectedContext?.details ?? {}),
            runtimeTask: intake?.task
              ? {
                  taskId: intake.task.taskId,
                  taskRunId: intake.task.taskRunId,
                  scope: intake.task.scope,
                  verifyCommands: intake.task.verifyCommands,
                  intakeMode: intake.task.intakeMode
                }
              : undefined,
            runtimeIntakeStarted: intake?.started ?? false
          }
        }
      };
    };

    const packKey = dependencies.promptPackKey(ctx, signal.promptHash);
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
      const memoryHints = formatRepositoryMemoryHints(
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
      dependencies.state.rememberInjectedContextPack(ctx, dependencies.retrievalKey(ctx, query), {
        queryHash: pack.queryHash,
        confidence: pack.confidence,
        estimatedTokens: pack.estimatedTokens,
        paths: pack.selected.map((item) => item.path)
      });
      for (const selected of pack.selected) {
        dependencies.state.rememberObservedContext(ctx, {
          path: selected.path,
          reason: "Runtime injected a bounded Context Engine navigation pack."
        });
      }
      return finishAgentStart({
        customType: "piagent-context-pack-v2",
        content: [pack.text, memoryHints.text].filter(Boolean).join("\n\n"),
        details: {
          schemaVersion: 2,
          queryHash: pack.queryHash,
          confidence: pack.confidence,
          estimatedTokens: pack.estimatedTokens,
          paths: pack.selected.map((item) => item.path),
          repositoryMemoryIds: memoryHints.ids,
          currentSnapshot: plan.currentSnapshot,
          contextPlan: plan
        }
      });
    } catch (error) {
      dependencies.telemetry(ctx, {
        event: "context_pack",
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

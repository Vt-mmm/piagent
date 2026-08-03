import crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildContextPack,
  classifyContextTask,
  ensureContextIndexV2,
  estimateContextTokens
} from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import type { TaskContract } from "../../extensions/guard-types.js";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import {
  compactManagedProjectInstructions,
  rewriteLegacyProjectInstructions
} from "../session/system-prompt.ts";
import { PIAGENT_TOOL_NAMES } from "../tools/tool-groups.ts";
import { extractTaskRequest, looksLikeGovernedBoilerplate } from "../workflows/input-routing.ts";
import {
  AUTO_INTAKE_SNAPSHOT_PATTERNS,
  automaticTaskIntakeEligible
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
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

export function registerAgentStartHook(pi: ExtensionAPI, dependencies: AgentStartHookDependencies): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const projectInstructions = rewriteLegacyProjectInstructions(event.systemPrompt);
    const query = looksLikeGovernedBoilerplate(event.prompt) ? extractTaskRequest(event.prompt) : event.prompt.trim();
    const signal = classifyContextTask(query);
    const readProtectedPaths = dependencies.readProtectedPaths(ctx);
    const protectedOnlyTarget = signal.paths.length > 0
      && signal.paths.every((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const activeTask = dependencies.activeTask(ctx);
    const runtimeIntake = !activeTask && automaticTaskIntakeEligible(query, readProtectedPaths);
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
      contextUsage: ctx.getContextUsage()
    });

    const finishAgentStart = async (contextMessage?: {
      customType: string;
      content: string;
      details: Record<string, unknown>;
    }) => {
      const intake = await dependencies.startAutomaticTask(query, ctx);
      if (!contextMessage && !intake) return systemPromptUpdate;
      const content = [contextMessage?.content, intake?.text].filter(Boolean).join("\n\n");
      return {
        ...(systemPromptUpdate ?? {}),
        message: {
          customType: contextMessage?.customType ?? "piagent-runtime-task-intake",
          content,
          display: false,
          details: {
            ...(contextMessage?.details ?? {}),
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
      const budgetTokens = runtimeIntake
        ? 900
        : signal.lane === "high-risk" ? 1_200 : signal.lane === "tiny" ? 500 : 900;
      const pack = await buildContextPack(ctx.cwd, query, {
        budgetTokens,
        includeCode: runtimeIntake,
        includePatterns: runtimeIntake ? AUTO_INTAKE_SNAPSHOT_PATTERNS : undefined,
        currentSnapshot: runtimeIntake,
        limit: runtimeIntake ? 8 : 12,
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
        currentSnapshot: runtimeIntake
      });
      if (!["medium", "high"].includes(pack.confidence) || pack.selected.length === 0) return finishAgentStart();
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
        content: pack.text,
        details: {
          schemaVersion: 2,
          queryHash: pack.queryHash,
          confidence: pack.confidence,
          estimatedTokens: pack.estimatedTokens,
          paths: pack.selected.map((item) => item.path),
          currentSnapshot: runtimeIntake
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

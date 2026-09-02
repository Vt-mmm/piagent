import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { classifyContextTask } from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import type { TaskContract } from "../../extensions/guard-types.js";
import { attachLocalImagesFromText, extractLocalImagePathCandidates } from "../input/chat-images.ts";
import type { ChatImageAccessPolicy } from "../input/chat-images.ts";
import { LONG_INPUT_CHARS } from "../runtime-limits.ts";
import type { AuthorityResumeDecision } from "../policy/authority-resume-policy.ts";
import { buildHandoffProjection, writeHandoffProjection } from "../recovery/handoff-projection.ts";
import {
  isUncertainSendContinuation,
  terminalUncertainSendReceipt
} from "../session/uncertain-send-continuation.ts";
import { buildContextPreflight, buildUsageSnapshot } from "../session/usage.ts";
import { registerAdaptiveContextGovernor } from "../session/adaptive-context-governor.ts";
import { activeTaskToolGroups, toolGroupsForPrompt, PIAGENT_TOOL_NAMES, PIAGENT_TOOL_ORDER, PIAGENT_TOOL_GROUPS } from "../tools/tool-groups.ts";
import type { PiagentToolGroup } from "../tools/tool-groups.ts";
import type { RuntimeSessionState } from "../session/runtime-state.ts";
import { observeHostWireInput } from "../session/runtime-state.ts";
import {
  buildFreshCommand,
  agentStartTaskRequest,
  chooseFreshWorkflow,
  extractTaskRequest,
  isFreshOrUtilityInput,
  isPiagentWorkflowInput,
  looksLikeGovernedBoilerplate,
  trimTaskForInline
} from "../workflows/input-routing.ts";
import {
  automaticTaskIntakeMode,
  isLightweightNonAuthorizingChangeContinuation,
  manualTaskIntakeEligible
} from "../workflows/task-intake.ts";

type InputHookDependencies = {
  state: RuntimeSessionState;
  boilerplateCollapseChars: number;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  authorityPolicy: (ctx: ExtensionContext, task: TaskContract) => AuthorityResumeDecision;
  readProtectedPaths: (ctx: ExtensionContext) => string[];
  imageAccess: (ctx: ExtensionContext) => ChatImageAccessPolicy;
  activateToolGroups: (ctx: ExtensionContext, groups: PiagentToolGroup[]) => unknown;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

/** Predict configured input definitions; unknown task or replacement state cannot create an allowed wire state. */
export function projectPiagentWireInput(input: {
  text: string; expandedPrompt?: string; source: string; activeTask: TaskContract | null;
  readProtectedPaths: string[]; currentTools: string[]; availableToolNames: string[];
  dynamicToolsEnabled: boolean; replacementIntake: boolean; hasImages: boolean; phase?: string | null;
}): Record<string, any> {
  const blocked = (reason: string) => ({ disposition: "blocked", reason });
  if (input.activeTask === undefined || !Array.isArray(input.readProtectedPaths)
    || typeof input.replacementIntake !== "boolean" || typeof input.dynamicToolsEnabled !== "boolean") return blocked("input-state-unfrozen");
  const text = input.text.trim();
  if (input.hasImages !== false || extractLocalImagePathCandidates(text, "/").length > 0) return blocked("input-images-unprojected");
  if (!text || isFreshOrUtilityInput(text) || /^\/piagent-workflow\b/i.test(text)) return blocked("input-transform-unprojected");
  if (!["rpc", "interactive", "extension"].includes(input.source)) return blocked("input-source-unfrozen");
  if (input.source !== "extension" && (looksLikeGovernedBoilerplate(text) || isPiagentWorkflowInput(text)
    || text.length >= LONG_INPUT_CHARS)) return blocked("input-preflight-unfrozen");
  const signal = classifyContextTask(text), activeTask = input.activeTask?.trace.outcome === "pending" ? input.activeTask : undefined;
  const onlyProtected = signal.paths.length > 0 && signal.paths.every((p) => matchesProtectedPath(p, input.readProtectedPaths));
  const runtimeMode = !activeTask ? automaticTaskIntakeMode(text, input.readProtectedPaths) : undefined;
  const manual = !activeTask && !runtimeMode && manualTaskIntakeEligible(text, input.readProtectedPaths);
  const groups = onlyProtected ? [] : toolGroupsForPrompt(text).filter((group) => !runtimeMode || group !== "intake" && group !== "task");
  if (manual && !groups.includes("intake")) groups.push("intake");
  const selectedGroups = activeTask ? [...groups.filter((group) => input.replacementIntake || group !== "intake"),
    ...(input.replacementIntake ? ["intake" as const] : activeTaskToolGroups(activeTask))] : groups;
  const builtins = input.currentTools.filter((name) => !PIAGENT_TOOL_NAMES.has(name));
  if (builtins.includes("apply_patch")) {
    const firstWriter = builtins.findIndex((name) => name === "edit" || name === "write");
    if (firstWriter >= 0) { builtins.splice(builtins.indexOf("apply_patch"), 1); builtins.splice(builtins.findIndex((name) => name === "edit" || name === "write"), 0, "apply_patch"); }
  }
  const selectedTools = input.dynamicToolsEnabled ? [...builtins, ...PIAGENT_TOOL_ORDER.filter((name) =>
    selectedGroups.some((group) => PIAGENT_TOOL_GROUPS[group].includes(name as never)))] : [...input.currentTools];
  if (selectedTools.some((name) => !input.availableToolNames.includes(name))) return blocked("tool-definition-missing");
  const query = agentStartTaskRequest(input.expandedPrompt ?? text), querySignal = classifyContextTask(query);
  const protectedQuery = querySignal.paths.length > 0 && querySignal.paths.every((p) => matchesProtectedPath(p, input.readProtectedPaths));
  const agentStartRuntimeMode = !activeTask ? automaticTaskIntakeMode(query, input.readProtectedPaths) : undefined;
  if (runtimeMode || agentStartRuntimeMode || input.replacementIntake) return blocked("automatic-task-state-unprojected");
  if (activeTask && !input.phase) return blocked("current-task-phase-unfrozen");
  return { disposition: "known", reason: null, groups: selectedGroups, selectedTools,
    compactMode: protectedQuery ? "protected" : activeTask?.intakeMode === "runtime" ? "automatic" : null,
    taskPresence: activeTask ? "current" : "none", phase: activeTask ? input.phase : null,
    inputHash: signal.promptHash, inputText: text };
}

export function registerInputHook(pi: ExtensionAPI, dependencies: InputHookDependencies): void {
  registerAdaptiveContextGovernor(pi, {
    activeTask: dependencies.activeTask,
    telemetry: dependencies.telemetry
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    if (!text || isFreshOrUtilityInput(text)) return { action: "continue" };
    if (/^\/piagent-workflow\b/i.test(text)) {
      return { action: "transform", text: text.replace(/^\/piagent-workflow\b/i, "/workflow") };
    }

    const taskSignal = classifyContextTask(text);
    const sessionTask = dependencies.activeTask(ctx);
    const uncertainSendContinuation = (!Array.isArray(event.images) || event.images.length === 0)
      && isUncertainSendContinuation(text);
    const terminalReceipt = uncertainSendContinuation
      ? terminalUncertainSendReceipt(ctx.cwd, sessionTask)
      : undefined;
    if (terminalReceipt && event.source !== "extension") {
      dependencies.telemetry(ctx, {
        event: "uncertain_send_terminal_receipt_reemitted",
        source: event.source,
        promptHash: taskSignal.promptHash,
        taskId: terminalReceipt.details.taskId,
        taskRunId: terminalReceipt.details.taskRunId,
        outcome: terminalReceipt.details.outcome,
        completionApproved: terminalReceipt.details.completionApproved,
        replacementTaskStarted: false,
        replayed: false,
        modelTurnStarted: false
      });
      pi.sendMessage(
        {
          customType: terminalReceipt.customType,
          content: terminalReceipt.content,
          display: true,
          details: terminalReceipt.details
        },
        { triggerTurn: false }
      );
      return { action: "handled" };
    }
    if (!uncertainSendContinuation) {
      if (sessionTask && sessionTask.trace.outcome !== "pending") dependencies.state.clearTaskBoundary(ctx, sessionTask.taskRunId);
      else if (!sessionTask) {
        const cachedTask = dependencies.state.taskIdentity(ctx);
        if (cachedTask) dependencies.state.clearTaskBoundary(ctx, cachedTask.taskRunId);
      }
    }
    const activeTask = sessionTask?.trace.outcome === "pending" ? sessionTask : undefined;
    const turn = dependencies.state.beginTurn(ctx, taskSignal.promptHash, {
      lightweightNonAuthorizingChange: isLightweightNonAuthorizingChangeContinuation(text)
    });
    observeHostWireInput(ctx.cwd, ctx.sessionManager.getSessionId(), { turnId: turn.turnId,
      promptHash: taskSignal.promptHash, text, source: event.source,
      hasImages: Boolean(event.images?.length || extractLocalImagePathCandidates(text, ctx.cwd).length) });
    const authorityPolicy = activeTask?.trace.outcome === "pending" ? dependencies.authorityPolicy(ctx, activeTask) : undefined;
    let authorityHandoffReady = false;
    if (activeTask && authorityPolicy?.disposition === "new-attempt-required") {
      try {
        writeHandoffProjection(ctx.cwd, buildHandoffProjection(ctx.cwd, activeTask, {
          gate: { decision: "fail", missing: [`authority policy handoff: ${authorityPolicy.reason}`], missingVerifyCommands: [] },
          recovery: null
        }));
        authorityHandoffReady = true;
      } catch (error) {
        ctx.ui.notify(`Piagent authority-policy handoff could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
    const replacementIntake = Boolean(activeTask && (
      activeTask.workingTreeDigestMigration?.status === "new-attempt-required" || authorityHandoffReady
    ));
    const readProtectedPaths = dependencies.readProtectedPaths(ctx);
    const protectedTarget = taskSignal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const protectedOnlyTarget = taskSignal.paths.length > 0
      && taskSignal.paths.every((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const runtimeIntakeMode = !activeTask ? automaticTaskIntakeMode(text, readProtectedPaths) : undefined;
    const runtimeIntake = Boolean(runtimeIntakeMode);
    const manualIntake = !activeTask && !runtimeIntake && manualTaskIntakeEligible(text, readProtectedPaths);
    const promptGroups = protectedOnlyTarget
      ? []
      : toolGroupsForPrompt(text).filter((group) => (
          runtimeIntake ? group !== "intake" && group !== "task" : true
        ));
    if (manualIntake && !promptGroups.includes("intake")) promptGroups.push("intake");
    dependencies.activateToolGroups(ctx, activeTask?.trace.outcome === "pending"
      ? [...promptGroups.filter((group) => replacementIntake || group !== "intake"), ...(replacementIntake ? ["intake" as const] : activeTaskToolGroups(activeTask))]
      : promptGroups);
    dependencies.telemetry(ctx, {
      event: "user_input",
      turnId: turn.turnId,
      source: event.source,
      promptHash: taskSignal.promptHash,
      promptChars: taskSignal.promptChars,
      workflow: taskSignal.workflow,
      riskLane: taskSignal.lane,
      intakeMode: runtimeIntake ? "runtime" : "model",
      taskMode: runtimeIntakeMode,
      protectedTarget,
      protectedOnlyTarget,
      manualIntake,
      explicitPathCount: taskSignal.paths.length,
      termCount: taskSignal.terms.length
    });

    const imageAttachment = attachLocalImagesFromText(
      text,
      event.images,
      ctx.cwd,
      () => dependencies.imageAccess(ctx)
    );
    if (imageAttachment?.attached.length) {
      ctx.ui.notify(`Piagent image input: attached ${imageAttachment.attached.map((item) => item.marker).join(", ")}`, "info");
    } else if (imageAttachment?.skipped.length) {
      ctx.ui.notify(`Piagent image input: skipped ${imageAttachment.skipped.length} local image path(s)`, "warning");
    }

    const inputText = imageAttachment?.text ?? text;
    const canRewriteWorkflow = event.source !== "extension";
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    const preflight = buildContextPreflight(snapshot, chooseFreshWorkflow(inputText, inputText), inputText.length);
    const hasBoilerplate = looksLikeGovernedBoilerplate(inputText);
    const shouldFreshen = canRewriteWorkflow
      && preflight.recommendation === "fresh-session"
      && (hasBoilerplate || isPiagentWorkflowInput(inputText) || inputText.length >= LONG_INPUT_CHARS);
    const shouldCollapseBoilerplate = canRewriteWorkflow
      && hasBoilerplate
      && inputText.length >= dependencies.boilerplateCollapseChars;
    const outgoingImages = [
      ...(Array.isArray(event.images) ? event.images : []),
      ...(imageAttachment?.images ?? [])
    ];

    if (!shouldFreshen && !shouldCollapseBoilerplate) {
      if (imageAttachment?.attached.length) return { action: "transform", text: inputText, images: outgoingImages };
      return { action: "continue" };
    }

    const task = extractTaskRequest(inputText);
    const workflow = chooseFreshWorkflow(inputText, task);
    const reason = shouldFreshen
      ? "Current session is near context limits; use a fresh governed session."
      : "Mandatory flow boilerplate is already part of the platform; collapse it to the task request.";
    const command = shouldFreshen
      ? buildFreshCommand(ctx.cwd, workflow, inputText, reason)
      : `/${workflow} ${trimTaskForInline(task)}`;

    ctx.ui.notify(`Piagent preflight: ${reason}`, "warning");
    return outgoingImages.length > 0
      ? { action: "transform", text: command, images: outgoingImages }
      : { action: "transform", text: command };
  });
}

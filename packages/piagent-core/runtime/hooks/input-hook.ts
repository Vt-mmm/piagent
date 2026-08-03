import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { classifyContextTask } from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import type { TaskContract } from "../../extensions/guard-types.js";
import { attachLocalImagesFromText } from "../input/chat-images.ts";
import type { ChatImageAccessPolicy } from "../input/chat-images.ts";
import { LONG_INPUT_CHARS } from "../runtime-limits.ts";
import { buildContextPreflight, buildUsageSnapshot } from "../session/usage.ts";
import { activeTaskToolGroups, toolGroupsForPrompt } from "../tools/tool-groups.ts";
import type { PiagentToolGroup } from "../tools/tool-groups.ts";
import {
  buildFreshCommand,
  chooseFreshWorkflow,
  extractTaskRequest,
  isFreshOrUtilityInput,
  isPiagentWorkflowInput,
  looksLikeGovernedBoilerplate,
  trimTaskForInline
} from "../workflows/input-routing.ts";
import {
  automaticTaskIntakeEligible,
  manualTaskIntakeEligible
} from "../workflows/task-intake.ts";

type InputHookDependencies = {
  boilerplateCollapseChars: number;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  readProtectedPaths: (ctx: ExtensionContext) => string[];
  imageAccess: (ctx: ExtensionContext) => ChatImageAccessPolicy;
  activateToolGroups: (ctx: ExtensionContext, groups: PiagentToolGroup[]) => unknown;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

export function registerInputHook(pi: ExtensionAPI, dependencies: InputHookDependencies): void {
  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    if (!text || isFreshOrUtilityInput(text)) return { action: "continue" };
    if (/^\/piagent-workflow\b/i.test(text)) {
      return { action: "transform", text: text.replace(/^\/piagent-workflow\b/i, "/workflow") };
    }

    const taskSignal = classifyContextTask(text);
    const activeTask = dependencies.activeTask(ctx);
    const readProtectedPaths = dependencies.readProtectedPaths(ctx);
    const protectedTarget = taskSignal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const protectedOnlyTarget = taskSignal.paths.length > 0
      && taskSignal.paths.every((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
    const runtimeIntake = !activeTask && automaticTaskIntakeEligible(text, readProtectedPaths);
    const manualIntake = !activeTask && !runtimeIntake && manualTaskIntakeEligible(text, readProtectedPaths);
    const promptGroups = protectedOnlyTarget
      ? []
      : toolGroupsForPrompt(text).filter((group) => (
          runtimeIntake ? group !== "intake" && group !== "task" : true
        ));
    if (manualIntake && !promptGroups.includes("intake")) promptGroups.push("intake");
    dependencies.activateToolGroups(ctx, activeTask?.trace.outcome === "pending"
      ? [...promptGroups.filter((group) => group !== "intake"), ...activeTaskToolGroups(activeTask)]
      : promptGroups);
    dependencies.telemetry(ctx, {
      event: "user_input",
      source: event.source,
      promptHash: taskSignal.promptHash,
      promptChars: taskSignal.promptChars,
      workflow: taskSignal.workflow,
      riskLane: taskSignal.lane,
      intakeMode: runtimeIntake ? "runtime" : "model",
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

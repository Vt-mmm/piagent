import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { classifyContextTask } from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import type { TaskContract } from "../../extensions/guard-types.js";
import { attachLocalImagesFromText, extractLocalImagePathCandidates } from "../input/chat-images.ts";
import type { ChatImageAccessPolicy } from "../input/chat-images.ts";
import type { AuthorityResumeDecision } from "../policy/authority-resume-policy.ts";
import { registerAdaptiveContextGovernor } from "../session/adaptive-context-governor.ts";
import { toolGroupsForPrompt, PIAGENT_TOOL_NAMES, PIAGENT_TOOL_ORDER, PIAGENT_TOOL_GROUPS } from "../tools/tool-groups.ts";
import type { PiagentToolGroup } from "../tools/tool-groups.ts";
import type { RuntimeSessionState } from "../session/runtime-state.ts";
import { observeHostWireInput } from "../session/runtime-state.ts";

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
  const text = input.text;
  if (input.hasImages !== false || extractLocalImagePathCandidates(text, "/").length > 0) return blocked("input-images-unprojected");
  if (!text.trim()) return blocked("input-empty");
  if (!["rpc", "interactive", "extension"].includes(input.source)) return blocked("input-source-unfrozen");
  const signal = classifyContextTask(text);
  const protectedOnly = signal.paths.length > 0 && signal.paths.every((p) => matchesProtectedPath(p, input.readProtectedPaths));
  const groups = protectedOnly ? [] : toolGroupsForPrompt(text).filter((g) => !["intake", "task", "recovery"].includes(g));
  const builtins = input.currentTools.filter((name) => !PIAGENT_TOOL_NAMES.has(name));
  if (builtins.includes("apply_patch")) {
    const writer = builtins.findIndex((n) => n === "edit" || n === "write");
    if (writer >= 0) { builtins.splice(builtins.indexOf("apply_patch"), 1); builtins.splice(builtins.findIndex((n) => n === "edit" || n === "write"), 0, "apply_patch"); }
  }
  const selectedTools = input.dynamicToolsEnabled ? [...builtins, ...PIAGENT_TOOL_ORDER.filter((name) =>
    groups.some((group) => PIAGENT_TOOL_GROUPS[group].includes(name as never)))] : [...input.currentTools];
  if (selectedTools.some((name) => !input.availableToolNames.includes(name))) return blocked("tool-definition-missing");
  return { disposition: "known", reason: null, groups, selectedTools,
    compactMode: protectedOnly ? "protected" : null, taskPresence: "none", phase: null,
    inputHash: signal.promptHash, inputText: text };

}

export function registerInputHook(pi: ExtensionAPI, dependencies: InputHookDependencies): void {
  registerAdaptiveContextGovernor(pi, { activeTask: () => undefined, telemetry: dependencies.telemetry });
  pi.on("input", async (event, ctx) => {
    // Preserve the actual message, including whitespace and slash-like text.
    // Session/run lifecycle belongs to the host, not to prompt rewriting.
    const text = event.text;
    if (!text.trim()) return { action: "continue" };
    const signal = classifyContextTask(text);
    const cached = dependencies.state.taskIdentity(ctx);
    if (cached) dependencies.state.clearTaskBoundary(ctx, cached.taskRunId);
    const turn = dependencies.state.beginTurn(ctx, signal.promptHash);
    observeHostWireInput(ctx.cwd, ctx.sessionManager.getSessionId(), {
      turnId: turn.turnId, promptHash: signal.promptHash, text, source: event.source,
      hasImages: Boolean(event.images?.length || extractLocalImagePathCandidates(text, ctx.cwd).length)
    });
    const protectedPaths = dependencies.readProtectedPaths(ctx);
    const protectedOnly = signal.paths.length > 0 && signal.paths.every((p) => matchesProtectedPath(p, protectedPaths));
    dependencies.activateToolGroups(ctx, protectedOnly ? [] : toolGroupsForPrompt(text)
      .filter((group) => !["intake", "task", "recovery"].includes(group)));
    dependencies.telemetry(ctx, { event: "user_input", turnId: turn.turnId, source: event.source,
      promptHash: signal.promptHash, promptChars: text.length, inputMode: "freeform" });
    const attachment = attachLocalImagesFromText(text, event.images, ctx.cwd, () => dependencies.imageAccess(ctx));
    if (attachment?.attached.length) return { action: "transform", text: attachment.text,
      images: [...(event.images ?? []), ...attachment.images] };
    if (attachment?.skipped.length) ctx.ui.notify(`Skipped ${attachment.skipped.length} inaccessible image(s)`, "warning");
    return { action: "continue" };
  });
}

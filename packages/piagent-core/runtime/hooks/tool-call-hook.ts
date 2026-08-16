import crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { toolResultFingerprint } from "../../extensions/context-engine.js";
import { withRemedy } from "../policy/block-remedy.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";

type ToolCallEvent = {
  toolCallId?: string;
  toolName: string;
  input?: unknown;
};

type ToolCallDecision = { block: true; reason: string } | void | undefined;

type ToolCallHookDependencies = {
  beforeAuthorize?: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallDecision> | ToolCallDecision;
  authorize: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallDecision> | ToolCallDecision;
  reviewBudgetDecision?: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallDecision;
  beforeStart?: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallDecision;
  afterDecision?: (
    event: ToolCallEvent,
    ctx: ExtensionContext,
    metadata: { toolCallId: string; allowed: boolean; reason?: string }
  ) => void;
  extractLikelyPath: (cwd: string, input: Record<string, unknown>) => string | undefined;
  redactText: (input: string) => string;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  activity?: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  afterAuthorized?: (
    event: ToolCallEvent,
    ctx: ExtensionContext,
    metadata: { toolCallId: string }
  ) => TrajectorySyncResult | undefined;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function registerToolCallHook(pi: ExtensionAPI, dependencies: ToolCallHookDependencies): void {
  pi.on("tool_call", async (event, ctx) => {
    const typedEvent = event as ToolCallEvent;
    const input = asRecord(typedEvent.input);
    const callFingerprint = toolResultFingerprint(typedEvent.toolName, input, []);
    const target = dependencies.extractLikelyPath(ctx.cwd, input);
    const toolCallId = typedEvent.toolCallId ?? callFingerprint.key;
    const resolvedEvent = { ...typedEvent, toolCallId };
    const command = typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : undefined;
    const record = dependencies.activity ?? dependencies.telemetry;
    const recordedAt = new Date().toISOString();
    record(ctx, {
      activityId: `call:${toolCallId}`,
      event: "tool_call",
      recordedAt,
      toolCallId,
      toolName: typedEvent.toolName,
      inputHash: callFingerprint.inputHash,
      targetHash: target ? crypto.createHash("sha256").update(target).digest("hex") : undefined,
      targetPath: target ? dependencies.redactText(target) : undefined,
      command: command ? dependencies.redactText(command) : undefined
    });
    const preparationDecision = await dependencies.beforeAuthorize?.(resolvedEvent, ctx);
    const authorizationDecision = preparationDecision && typeof preparationDecision === "object" && preparationDecision.block
      ? preparationDecision
      : await dependencies.authorize(resolvedEvent, ctx);
    const decision = authorizationDecision && typeof authorizationDecision === "object" && authorizationDecision.block
      ? authorizationDecision
      : dependencies.reviewBudgetDecision?.(resolvedEvent, ctx);
    const startDecision = !(decision && typeof decision === "object" && decision.block) ? dependencies.beforeStart?.(resolvedEvent, ctx) : undefined;
    const finalDecision = startDecision && typeof startDecision === "object" && startDecision.block ? startDecision : decision;
    // Every refusal leaves through here, so this is where it is answered. A
    // remedy attached at the 29 sites that build one is a remedy the next site
    // will forget.
    const answered = finalDecision && typeof finalDecision === "object" && finalDecision.block
      ? withRemedy(finalDecision)
      : finalDecision;
    const blockedDecision = answered && typeof answered === "object" ? answered : undefined;
    record(ctx, {
      activityId: `decision:${toolCallId}`,
      event: "tool_decision",
      recordedAt: new Date().toISOString(),
      toolCallId,
      toolName: typedEvent.toolName,
      targetPath: target ? dependencies.redactText(target) : undefined,
      command: command ? dependencies.redactText(command) : undefined,
      decision: blockedDecision?.block ? "blocked" : "allowed",
      reason: blockedDecision?.reason ? dependencies.redactText(blockedDecision.reason) : undefined
    });
    if (!blockedDecision?.block) {
      observeTrajectorySync(ctx, dependencies.afterAuthorized?.(resolvedEvent, ctx, { toolCallId }), dependencies.telemetry);
    }
    dependencies.afterDecision?.(resolvedEvent, ctx, { toolCallId, allowed: !blockedDecision?.block, reason: blockedDecision?.reason });
    return answered;
  });
}

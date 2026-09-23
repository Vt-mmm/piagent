import crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.ts";

type Request = { requestId: string; taskId?: string; taskRunId?: string; sessionId: string; providerRequests: number };

// Metadata only, written to the existing telemetry stream. SDK turns are not
// provider billing receipts; missing terminals and internal retries stay unknown.
export function registerTaskUsageHooks(pi: ExtensionAPI, input: {
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  telemetry: (ctx: ExtensionContext, event: Record<string, unknown>) => void;
}): void {
  const requests = new Map<string, Request>();
  const messages = new WeakMap<object, Request>();
  const calls = new Map<string, { request: Request; invoked: boolean }>();
  const key = (ctx: ExtensionContext) => `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
  const emit = (ctx: ExtensionContext, request: Request, event: string, data = {}) => input.telemetry(ctx, {
    ...request, event, taskUsageVersion: 1, ...data
  });
  pi.on("turn_start", (_event, ctx) => {
    const task = input.activeTask(ctx);
    const request: Request = { requestId: crypto.randomUUID(), taskId: task?.taskId,
      taskRunId: task?.taskRunId, sessionId: ctx.sessionManager.getSessionId(), providerRequests: 0 };
    requests.set(key(ctx), request);
    emit(ctx, request, "task_usage_request");
  });
  pi.on("before_provider_request", (_event, ctx) => {
    const request = requests.get(key(ctx));
    if (request) {
      request.providerRequests += 1;
      emit(ctx, request, "task_usage_dispatch");
    }
  });
  const observe = (message: any, ctx: ExtensionContext, allowBind: boolean) => {
    if (message?.role !== "assistant") return;
    const request = messages.get(message) ?? (allowBind ? requests.get(key(ctx)) : undefined);
    if (!request) return;
    messages.set(message, request);
    // Only numeric usage metadata crosses this boundary. No content, arguments,
    // headers, opaque reasoning, or error text is retained.
    const usage = message.usage;
    const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    emit(ctx, request, "task_usage_terminal", {
      usageSemantics: "request-cumulative", usageRevision: "terminal",
      stopReason: ["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason) ? message.stopReason : "unknown",
      usage: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map((field) => [field, numeric(usage?.[field])])),
      cost: numeric(usage?.cost?.total), costBasis: "sdk-rate-estimate", currency: "USD"
    });
  };
  pi.on("message_end", (event, ctx) => observe(event.message, ctx, true));
  // The pinned SDK emits the same final message at both boundaries. An unknown
  // replay object must not inherit the identity of a newer task at turn_end.
  pi.on("turn_end", (event, ctx) => observe(event.message, ctx, false));
  const callKey = (ctx: ExtensionContext, id: string) => `${key(ctx)}\u0000${id}`;
  pi.on("tool_execution_start", (event, ctx) => {
    const request = requests.get(key(ctx));
    if (!request) return;
    calls.set(callKey(ctx, event.toolCallId), { request, invoked: false });
    emit(ctx, request, "task_tool_attempted", { toolCallId: event.toolCallId, toolName: event.toolName });
  });
  // SDK start events also cover blocked/invalid/truncated calls. Only the
  // afterToolCall-backed tool_result hook proves execute was actually entered.
  pi.on("tool_result", (event, ctx) => {
    const call = calls.get(callKey(ctx, event.toolCallId));
    if (!call) return;
    call.invoked = true;
    emit(ctx, call.request, "task_tool_invoked", { toolCallId: event.toolCallId, toolName: event.toolName });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const id = callKey(ctx, event.toolCallId), call = calls.get(id);
    if (call && !call.invoked) emit(ctx, call.request, "task_tool_not_executed", { toolCallId: event.toolCallId, toolName: event.toolName });
    calls.delete(id);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    requests.delete(key(ctx));
    for (const id of calls.keys()) if (id.startsWith(`${key(ctx)}\u0000`)) calls.delete(id);
  });
}

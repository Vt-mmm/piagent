import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.js";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import type { ObservedTaskContext } from "../session/runtime-state.ts";

type TelemetryWriter = (ctx: ExtensionContext, payload: Record<string, unknown>) => void;

type SessionHookDependencies = {
  state: RuntimeSessionState;
  maxManifestFiles: number;
  telemetry: TelemetryWriter;
  activeTask: (cwd: string, sessionId: string) => TaskContract | undefined;
  writeTask: (cwd: string, task: TaskContract) => TaskContract;
  bindTask: (cwd: string, sessionId: string, sessionName: string | undefined, task: TaskContract) => void;
  appendTrace: (cwd: string, payload: Record<string, unknown>) => void;
  flushObservedTaskContext: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    pendingContext: ObservedTaskContext[],
    maxManifestFiles: number,
    event: string
  ) => TaskContract | undefined;
};

export function registerSessionHooks(pi: ExtensionAPI, dependencies: SessionHookDependencies): void {
  const {
    state,
    maxManifestFiles,
    telemetry,
    activeTask,
    writeTask,
    bindTask,
    appendTrace,
    flushObservedTaskContext
  } = dependencies;

  pi.on("session_info_changed", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const task = activeTask(ctx.cwd, sessionId);
    if (!task) return;
    const sessionName = String(event.name ?? "").trim() || undefined;
    task.sessionName = sessionName;
    const written = writeTask(ctx.cwd, task);
    bindTask(ctx.cwd, sessionId, sessionName, written);
    appendTrace(ctx.cwd, {
      event: "task_session_renamed",
      taskId: written.taskId,
      taskRunId: written.taskRunId,
      sessionId,
      sessionName
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as unknown as { usage?: unknown; stopReason?: unknown; role?: unknown };
    telemetry(ctx, {
      event: "turn_end",
      turnIndex: event.turnIndex,
      toolResults: event.toolResults.length,
      role: message.role,
      stopReason: message.stopReason,
      usage: message.usage,
      contextUsage: ctx.getContextUsage()
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const task = activeTask(ctx.cwd, ctx.sessionManager.getSessionId());
    telemetry(ctx, {
      event: "agent_settled",
      idle: ctx.isIdle(),
      taskId: task?.taskId,
      taskRunId: task?.taskRunId,
      taskOutcome: task?.trace.outcome
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    telemetry(ctx, {
      event: "session_compact",
      reason: event.reason,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension
    });
  });

  pi.on("session_shutdown", async (event, ctx) => {
    flushObservedTaskContext(
      pi,
      ctx,
      state.observedContext(ctx),
      maxManifestFiles,
      "context_observed_before_shutdown"
    );
    telemetry(ctx, {
      event: "session_shutdown",
      reason: event.reason,
      targetSessionFile: event.targetSessionFile ? path.basename(event.targetSessionFile) : undefined
    });
    state.clearSession(ctx);
  });
}

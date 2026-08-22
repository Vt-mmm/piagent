import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.js";
import type { ObservedTaskContext, RuntimeSessionState } from "../session/runtime-state.ts";

type TaskIdentity = { taskId: string; taskRunId: string };

type ContextEvidenceQualificationDependencies = {
  state: RuntimeSessionState;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
};

export function recordObservedContextEvidence(
  ctx: ExtensionContext,
  entry: ObservedTaskContext | undefined,
  taskIdentity: TaskIdentity | undefined,
  dependencies: ContextEvidenceQualificationDependencies
): void {
  if (!entry) return;
  dependencies.state.rememberObservedContext(ctx, entry);
  const activeTask = dependencies.activeTask(ctx);
  if (
    taskIdentity
    && activeTask?.trace.outcome === "pending"
    && activeTask.taskId === taskIdentity.taskId
    && activeTask.taskRunId === taskIdentity.taskRunId
  ) {
    dependencies.state.rememberQualifiedContextEvidence(ctx, taskIdentity.taskRunId, entry);
  } else if (!activeTask || activeTask.trace.outcome !== "pending") {
    dependencies.state.rememberPreTaskContext(ctx, entry);
  }
}

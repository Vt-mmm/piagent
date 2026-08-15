import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { effectiveProtectedPaths } from "../../extensions/context-index-policy.js";
import type { BasePolicy, ProjectProfile, TaskContract } from "../../extensions/guard-types.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { activeSessionTask } from "../../extensions/task-state.js";
import { inspectTaskControlState } from "../inspection/task-control-journal.ts";
import { webUiTaskRevision } from "../inspection/webui-snapshot.ts";
import { piSourceMutationGuard } from "./source-mutation-guard.ts";

export type SourceMutationGuardBindings = {
  bind(ctx: ExtensionContext): void;
  unbind(ctx: ExtensionContext): void;
};

export function createSourceMutationGuardBindings(policy: BasePolicy,
  loadProfile: (ctx: ExtensionContext) => ProjectProfile): SourceMutationGuardBindings {
  const guardInstanceId = `guard.${randomBytes(32).toString("hex")}`, bindings = new Map<string, () => void>();
  const key = (ctx: ExtensionContext) => `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
  return {
    bind(ctx) {
      const bindingKey = key(ctx); bindings.get(bindingKey)?.();
      bindings.set(bindingKey, piSourceMutationGuard.bind({ cwd: ctx.cwd, rawSessionId: ctx.sessionManager.getSessionId(), guardInstanceId,
        facts: () => {
          const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
          if (!task) return null;
          const control = inspectTaskControlState(ctx.cwd, task);
          const taskState = task.trace.outcome !== "pending" || control.state === "terminal" ? "terminal"
            : control.state === "active" ? "active" : "unknown";
          const protectedPaths = effectiveProtectedPaths(policy, loadProfile(ctx)).readProtectedPaths;
          return { taskId: task.taskId, taskRunId: task.taskRunId, taskRevision: webUiTaskRevision(task), controlRevision: control.controlRevision,
            taskState, idle: ctx.isIdle(), isProtectedPath: (candidate: string) => matchesProtectedPath(candidate, protectedPaths) };
        } }));
    },
    unbind(ctx) {
      const bindingKey = key(ctx), unbind = bindings.get(bindingKey);
      if (!unbind) return;
      bindings.delete(bindingKey); unbind();
    }
  };
}

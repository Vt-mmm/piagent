import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { hasGitEvidenceRoot, workingTreeSnapshot } from "../../extensions/task-state.js";
import type { ProjectProfile, TaskContract } from "../../extensions/guard-types.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import { runtimeModelSnapshotDigest } from "../model/runtime-snapshot.ts";
import type { TaskFeatureInput } from "./task-features.ts";
import type { SolverShadowEvaluation } from "./solver-shadow.ts";
import { SolverShadowRuntime } from "./solver-shadow.ts";

export function runtimeTaskFeatureInput(options: {
  request: string;
  ctx: ExtensionContext;
  profile: ProjectProfile;
  activeTask?: TaskContract;
  runtimeSnapshot?: RuntimeModelSnapshot;
  effort: string | null;
  protectedTarget: boolean;
}): TaskFeatureInput {
  const { request, ctx, profile, activeTask, runtimeSnapshot } = options;
  const usage = ctx.getContextUsage?.();
  const contextPressure = typeof usage?.percent === "number" && Number.isFinite(usage.percent)
    ? Math.max(0, Math.min(1, usage.percent / 100))
    : null;
  const profileVerifier = Object.values(profile.verifyCommands ?? {}).some((commands) => commands.length > 0);
  const taskVerifier = (activeTask?.verifyCommands?.length ?? 0) > 0;
  const roles = Object.keys(profile.techStack?.roles ?? {});
  return {
    request,
    profileMode: profile.mode ?? null,
    projectShape: roles,
    gitReady: hasGitEvidenceRoot(ctx.cwd),
    dirtyTree: Object.keys(workingTreeSnapshot(ctx.cwd) as Record<string, string>).length > 0,
    verifierReady: profileVerifier || taskVerifier,
    contextPressure,
    activeTaskState: !activeTask ? "none" : activeTask.trace.outcome === "pending" ? "pending" : "terminal",
    runtimeSnapshotDigest: runtimeSnapshot ? runtimeModelSnapshotDigest(runtimeSnapshot) : null,
    runtimeCapabilitiesKnown: Boolean(runtimeSnapshot?.capabilities.some((item) => item.value !== null)),
    userPinnedProvider: runtimeSnapshot?.provider ?? ctx.model?.provider ?? null,
    userPinnedModel: runtimeSnapshot?.modelId ?? ctx.model?.id ?? null,
    userPinnedEffort: options.effort,
    protectedTarget: options.protectedTarget
  };
}

export function evaluateRuntimeSolver(
  runtime: SolverShadowRuntime | undefined,
  options: Parameters<typeof runtimeTaskFeatureInput>[0]
): SolverShadowEvaluation {
  if (!runtime) return { status: "off", durationMs: 0 };
  return runtime.evaluate(options.ctx.cwd, options.ctx.sessionManager.getSessionId(), runtimeTaskFeatureInput(options));
}

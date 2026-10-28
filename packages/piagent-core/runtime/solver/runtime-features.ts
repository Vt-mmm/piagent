import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { gitEvidenceRootDetails, workingTreeHasChanges } from "../../extensions/workspace-evidence-roots.js";
import type { ProjectProfile, TaskContract } from "../../extensions/guard-types.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import { runtimeModelSnapshotDigest } from "../model/runtime-snapshot.ts";
import type { TaskFeatureInput } from "./task-features.ts";
import type { SolverShadowEvaluation } from "./solver-shadow.ts";
import { SolverShadowRuntime } from "./solver-shadow.ts";

// Finding the repositories under a parent folder runs Git once per child and
// blocks the terminal; they rarely change between two prompts.
const ROOTS_TTL_MS = 30_000;
const rootDetails = new Map<string, { at: number; details: ReturnType<typeof gitEvidenceRootDetails> }>();
function gitShape(cwd: string): { gitReady: boolean; dirtyTree: boolean } {
  let cached = rootDetails.get(cwd);
  if (!cached || Date.now() - cached.at > ROOTS_TTL_MS) {
    try { cached = { at: Date.now(), details: gitEvidenceRootDetails(cwd) }; } catch { return { gitReady: false, dirtyTree: true }; }
    rootDetails.set(cwd, cached);
  }
  return { gitReady: cached.details.roots.length > 0, dirtyTree: workingTreeHasChanges(cwd, cached.details) };
}

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
    ...gitShape(ctx.cwd),
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

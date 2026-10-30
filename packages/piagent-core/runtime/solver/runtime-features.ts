import { execFile } from "node:child_process";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { gitEvidenceRootDetails, workingTreeHasChanges } from "../../extensions/workspace-evidence-roots.js";
import type { ProjectProfile, TaskContract } from "../../extensions/guard-types.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import { runtimeModelSnapshotDigest } from "../model/runtime-snapshot.ts";
import type { TaskFeatureInput } from "./task-features.ts";
import type { SolverShadowEvaluation } from "./solver-shadow.ts";
import { SolverShadowRuntime } from "./solver-shadow.ts";

type GitShape = { gitReady: boolean; dirtyTree: boolean };

function readGitShape(cwd: string): GitShape {
  try {
    const details = gitEvidenceRootDetails(cwd);
    return { gitReady: details.roots.length > 0, dirtyTree: workingTreeHasChanges(cwd, details) };
  } catch { return { gitReady: false, dirtyTree: true }; }
}

// The Git shape runs `git rev-parse` (once per child repository in a parent
// folder) and `git status`. Read synchronously on every prompt it held the
// Terminal between Enter and the message showing, longer the larger the
// repository. It is now read in a child process when the session starts and
// after each run, and a prompt takes the last answer. Only a prompt with no
// answer yet reads it inline, as before.
const SHAPE_FRESH_MS = 5_000;
const SHAPE_PROBE = `import(${JSON.stringify(new URL("../../extensions/workspace-evidence-roots.js", import.meta.url).href)}).then((git) => {
  let shape; try { const details = git.gitEvidenceRootDetails(process.argv[1]);
    shape = { gitReady: details.roots.length > 0, dirtyTree: git.workingTreeHasChanges(process.argv[1], details) };
  } catch { shape = { gitReady: false, dirtyTree: true }; }
  process.stdout.write(JSON.stringify(shape));
});`;
const shapes = new Map<string, { at: number; shape: GitShape }>();
const probing = new Map<string, Promise<void>>();

export function refreshGitShape(cwd: string): Promise<void> {
  const running = probing.get(cwd);
  if (running) return running;
  const startedAt = Date.now();
  const probe = new Promise<void>((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", SHAPE_PROBE, cwd], { timeout: 60_000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      try {
        const shape = JSON.parse(String(stdout)) as GitShape;
        if (!error && typeof shape.gitReady === "boolean" && typeof shape.dirtyTree === "boolean") shapes.set(cwd, { at: startedAt, shape });
      } catch { /* the next prompt reads it inline */ }
      resolve();
    });
  }).finally(() => probing.delete(cwd));
  probing.set(cwd, probe);
  return probe;
}

function gitShape(cwd: string): GitShape {
  const cached = shapes.get(cwd);
  if (!cached) {
    const shape = readGitShape(cwd);
    shapes.set(cwd, { at: Date.now(), shape });
    return shape;
  }
  if (Date.now() - cached.at > SHAPE_FRESH_MS) void refreshGitShape(cwd);
  return cached.shape;
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

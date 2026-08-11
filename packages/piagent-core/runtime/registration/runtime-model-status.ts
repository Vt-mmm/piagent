import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { captureAuthenticatedModelCatalogFromContext } from "../model/authenticated-catalog.ts";
import type { RuntimeSnapshotCapture, RuntimeVersionMetadata } from "../model/runtime-snapshot.ts";
import { runtimeModelSnapshotDigest } from "../model/runtime-snapshot.ts";
import type { TrajectoryStatus } from "../trajectory/trajectory-runtime.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import { readModelRouteEvents } from "../model/model-route-runtime.ts";

export async function buildRuntimeModelStatus(
  ctx: ExtensionContext,
  capture: RuntimeSnapshotCapture,
  versions: RuntimeVersionMetadata,
  effectiveThinkingLevel: string
): Promise<{ content: string; details: Record<string, unknown> }> {
  const snapshot = capture.capture(ctx, { effectiveThinkingLevel, versions });
  const catalog = await captureAuthenticatedModelCatalogFromContext(ctx, {
    offline: ["1", "true", "yes", "on"].includes(String(process.env.PI_OFFLINE ?? "").toLowerCase())
  });
  const activeAvailable = snapshot.provider && snapshot.modelId
    ? catalog.models.some((model) => model.provider === snapshot.provider && model.modelId === snapshot.modelId)
    : false;
  const routeState = readModelRouteEvents(ctx.cwd);
  const route = routeState.latest?.decision;
  const lines = [
    `piHost: ${snapshot.piHostVersion ?? "unknown"}`,
    `piagent: ${snapshot.piagentVersion ?? "unknown"}`,
    `provider/model: ${snapshot.provider && snapshot.modelId ? `${snapshot.provider}/${snapshot.modelId}` : "unknown"}`,
    `thinking: requested=${snapshot.requestedThinkingLevel ?? "unknown"}; effective=${snapshot.effectiveThinkingLevel ?? "unknown"}`,
    `contextWindow: ${snapshot.contextWindow ?? "unknown"}`,
    `authenticatedCatalog: ${catalog.availability}; models=${catalog.models.length}; active=${activeAvailable ? "available" : "unverified"}`,
    `parentRouting: ${route ? `${route.mode}/${route.objective}; ${route.disposition}; band=${route.capabilityBand}; target=${route.provider ?? "none"}/${route.modelId ?? "none"}:${route.effort ?? "none"}; source=${route.selectionSource}; enforced=${route.enforced}` : "off/no-decision"}`,
    `provenance: pi-runtime, authenticated-catalog${snapshot.provenance.some((item) => item.source === "provider-profile") ? ", provider-profile" : ""}`,
    `warnings: ${[...snapshot.warnings, ...catalog.warnings].join("; ") || "none"}`
  ];
  return {
    content: lines.join("\n"),
    details: {
      snapshot,
      snapshotDigest: runtimeModelSnapshotDigest(snapshot),
      catalog: {
        schemaVersion: catalog.schemaVersion,
        capturedAt: catalog.capturedAt,
        source: catalog.source,
        availability: catalog.availability,
        modelCount: catalog.models.length,
        activeAvailable,
        warnings: catalog.warnings
      },
      modelRoute: route ?? null,
      modelRouteCorruptions: routeState.corruptions
    }
  };
}

type StatusProfile = {
  projectId?: string;
  displayName?: string;
  mode?: string;
  requiredContext?: string[];
  verifyCommands?: Record<string, unknown>;
};

type RuntimeStatusDependencies = {
  loadProfile: (ctx: ExtensionContext) => StatusProfile;
  permissionProfile: (ctx: ExtensionContext, profile: StatusProfile) => Record<string, unknown> & { mode?: string };
  defaultRequiredContext: readonly string[];
  capture: RuntimeSnapshotCapture;
  versions: RuntimeVersionMetadata;
  effectiveThinkingLevel: () => string;
  trajectoryStatus?: (ctx: ExtensionContext) => TrajectoryStatus;
  taskStatus?: (ctx: ExtensionContext, snapshot: RuntimeModelSnapshot) => { content: string; details: Record<string, unknown> };
};

export function registerPiagentStatusCommand(pi: ExtensionAPI, dependencies: RuntimeStatusDependencies): void {
  pi.registerCommand("piagent-status", {
    description: "Show piagent Pi profile, guard, runtime, and authenticated model state",
    handler: async (_args, ctx) => {
      const profile = dependencies.loadProfile(ctx);
      const permissionProfile = dependencies.permissionProfile(ctx, profile);
      const requiredContext = [...new Set([...dependencies.defaultRequiredContext, ...(profile.requiredContext ?? [])])];
      const verifyCommands = Object.keys(profile.verifyCommands ?? {});
      const runtimeModel = await buildRuntimeModelStatus(
        ctx,
        dependencies.capture,
        dependencies.versions,
        dependencies.effectiveThinkingLevel()
      );
      const project = profile.displayName ?? profile.projectId ?? "unprofiled";
      const trajectory = dependencies.trajectoryStatus?.(ctx) ?? { taskRunId: null, phase: null, enforcementSafe: true, warnings: [] };
      const taskStatus = dependencies.taskStatus?.(ctx, runtimeModel.details.snapshot as RuntimeModelSnapshot);
      ctx.ui.notify(`Project profile: ${project}`, "info");
      pi.sendMessage({
        customType: "piagent-status",
        content: [
          `project: ${project}`,
          `mode: ${profile.mode ?? "unknown"}`,
          `permission: ${permissionProfile.mode ?? "unknown"}`,
          `requiredContext: ${requiredContext.join(", ") || "none"}`,
          `verifyGroups: ${verifyCommands.join(", ") || "none"}`,
          `trajectory: phase=${trajectory.phase ?? "none"}; enforcement=${trajectory.enforcementSafe ? "safe" : "disabled"}`,
          runtimeModel.content,
          taskStatus?.content ?? "task: none"
        ].join("\n"),
        display: true,
        details: {
          projectId: profile.projectId,
          displayName: profile.displayName,
          mode: profile.mode,
          permissionProfile,
          requiredContext,
          verifyCommands,
          trajectory,
          runtimeModel: runtimeModel.details,
          taskStatus: taskStatus?.details ?? null
        }
      }, { triggerTurn: false });
    }
  });
}

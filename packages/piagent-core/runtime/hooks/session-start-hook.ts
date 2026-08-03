import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { contextIndexV2Status } from "../../extensions/context-engine.js";
import type { ProjectProfile, TaskContract } from "../../extensions/guard-types.js";
import { pruneCaptureFiles } from "../../extensions/state-retention.js";
import { migrateTaskState } from "../../extensions/task-state.js";
import {
  CAPTURE_RETENTION_MAX_AGE_MS,
  CAPTURE_RETENTION_MAX_BYTES,
  CAPTURE_RETENTION_MAX_FILES
} from "../runtime-limits.ts";
import { currentSessionName, hasOperatorSessionName } from "../session/message-signals.ts";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import { buildContextPreflight, buildUsageSnapshot } from "../session/usage.ts";
import { toolResultCaptureRoot } from "../session/tool-result-compaction.ts";
import { activeTaskToolGroups } from "../tools/tool-groups.ts";
import type { PiagentToolGroup } from "../tools/tool-groups.ts";

type SessionTaskReference = { taskId?: string; taskRunId?: string };

type SessionStartHookDependencies = {
  state: RuntimeSessionState;
  loadProfile: (ctx: ExtensionContext) => ProjectProfile;
  projectProfileExists: (cwd: string) => boolean;
  activateToolGroups: (ctx: ExtensionContext, groups: PiagentToolGroup[]) => unknown;
  taskReference: (ctx: ExtensionContext) => SessionTaskReference | undefined;
  activeTask: (cwd: string, sessionId: string) => TaskContract | undefined;
  resolveTask: (cwd: string, reference: string, sessionId: string) => TaskContract | undefined;
  bindTask: (cwd: string, sessionId: string, sessionName: string | undefined, task: TaskContract) => unknown;
  writeTask: (cwd: string, task: TaskContract) => TaskContract;
  capabilityState: (ctx: ExtensionContext) => { ok: boolean; reason?: string; repinned?: string };
  permissionProfile: (ctx: ExtensionContext, profile: ProjectProfile) => { mode: string; warning?: string };
  legacyProjectWarning: (cwd: string) => string | undefined;
  mcpReadinessNotice: (cwd: string) => string | undefined;
  updateAvailabilityNotice: () => string | undefined;
  contextExcludePatterns: (profile: ProjectProfile) => string[];
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

export function registerSessionStartHook(pi: ExtensionAPI, dependencies: SessionStartHookDependencies): void {
  pi.on("session_start", async (_event, ctx) => {
    dependencies.activateToolGroups(ctx, []);
    const projectTrusted = ctx.isProjectTrusted();
    const explicitProfile = Boolean(process.env.PIAGENT_PROFILE?.trim());
    const profile = dependencies.loadProfile(ctx);
    const name = profile.displayName || profile.projectId || path.basename(ctx.cwd);
    const operatorSessionName = currentSessionName(ctx);
    if (!hasOperatorSessionName(operatorSessionName)) pi.setSessionName(`pi:${name}`);

    const sessionId = ctx.sessionManager.getSessionId();
    const sessionName = currentSessionName(ctx);
    const taskReference = dependencies.taskReference(ctx);
    let captureRetention: Record<string, unknown>;
    try {
      captureRetention = pruneCaptureFiles(toolResultCaptureRoot(ctx.cwd), {
        maxFiles: CAPTURE_RETENTION_MAX_FILES,
        maxBytes: CAPTURE_RETENTION_MAX_BYTES,
        maxAgeMs: CAPTURE_RETENTION_MAX_AGE_MS,
        projectRoot: ctx.cwd
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captureRetention = { removed: 0, kept: 0, bytes: 0, error: message };
      ctx.ui.notify(`Piagent local state needs recovery: ${message}`, "warning");
    }

    const migration = migrateTaskState(ctx.cwd, {
      sessionId,
      sessionName,
      taskId: taskReference?.taskId
    });
    if (migration.warnings.length > 0) {
      ctx.ui.notify(`Piagent task-state migration needs recovery: ${migration.warnings.join("; ")}`, "warning");
    }
    let resumedTask = dependencies.activeTask(ctx.cwd, sessionId);
    if (!resumedTask && taskReference) {
      resumedTask = dependencies.resolveTask(ctx.cwd, taskReference.taskRunId ?? taskReference.taskId ?? "", sessionId);
      if (resumedTask) dependencies.bindTask(ctx.cwd, sessionId, sessionName, resumedTask);
    }
    if (resumedTask && resumedTask.sessionName !== sessionName) {
      resumedTask.sessionName = sessionName;
      resumedTask = dependencies.writeTask(ctx.cwd, resumedTask);
      dependencies.bindTask(ctx.cwd, sessionId, sessionName, resumedTask);
    }
    dependencies.state.cacheTaskIdentity(ctx, resumedTask);
    if (resumedTask?.trace.outcome === "pending") {
      dependencies.activateToolGroups(ctx, activeTaskToolGroups(resumedTask));
    }

    const profileHint = explicitProfile || (projectTrusted && dependencies.projectProfileExists(ctx.cwd))
      ? ""
      : " (run /onboard to select a profile)";
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    const preflight = buildContextPreflight(snapshot, "task", 0);
    const capabilityState = dependencies.capabilityState(ctx);
    const permissionProfile = dependencies.permissionProfile(ctx, profile);
    const contextHint = preflight.recommendation === "fresh-session"
      ? " Context is high; use /fresh task or /fresh scout for new work."
      : preflight.recommendation === "compact"
        ? " Context is warm; run /task-preflight before large work."
        : "";
    ctx.ui.notify(
      `Piagent Pi guard loaded: ${name}${profileHint} permission=${permissionProfile.mode}${contextHint}`,
      preflight.recommendation === "fresh-session" ? "warning" : "info"
    );
    if (!capabilityState.ok) ctx.ui.notify(capabilityState.reason ?? "Capability validation failed.", "warning");
    if (capabilityState.repinned) {
      ctx.ui.notify(`Capability lock re-pinned: ${capabilityState.repinned}. The capabilities this project grants are unchanged.`, "info");
    }
    const legacyWarning = dependencies.legacyProjectWarning(ctx.cwd);
    if (legacyWarning) ctx.ui.notify(legacyWarning, "warning");
    if (permissionProfile.warning) ctx.ui.notify(permissionProfile.warning, "warning");
    if (permissionProfile.mode === "trusted-full-access") {
      ctx.ui.notify("Piagent permission profile trusted-full-access is active; protected paths, secret redaction, and destructive/external confirmations remain enforced.", "warning");
    }
    const mcpNotice = dependencies.mcpReadinessNotice(ctx.cwd);
    if (mcpNotice) ctx.ui.notify(mcpNotice, "warning");
    const updateNotice = dependencies.updateAvailabilityNotice();
    if (updateNotice) ctx.ui.notify(updateNotice, "info");

    let engineStatus: unknown;
    try {
      engineStatus = await contextIndexV2Status(ctx.cwd, {
        excludePatterns: dependencies.contextExcludePatterns(profile)
      });
    } catch (error) {
      engineStatus = { exists: false, error: error instanceof Error ? error.message : String(error) };
    }
    dependencies.telemetry(ctx, {
      event: "session_start",
      activeTools: pi.getActiveTools().length,
      index: engineStatus,
      taskMigration: migration,
      taskId: resumedTask?.taskId,
      taskRunId: resumedTask?.taskRunId,
      captureRetention
    });
  });
}

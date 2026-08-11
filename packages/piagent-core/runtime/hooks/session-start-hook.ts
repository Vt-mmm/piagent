import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { contextIndexV2Status } from "../../extensions/context-engine.js";
import { resolveExecutionBackend } from "../../extensions/execution-backend.js";
import type { ProjectProfile, TaskContract } from "../../extensions/guard-types.js";
import { pruneCaptureFiles } from "../../extensions/state-retention.js";
import { migrateTaskState, readSessionTaskBinding } from "../../extensions/task-state.js";
import {
  pruneTaskJournal
} from "../../extensions/task-journal.js";
import {
  CAPTURE_RETENTION_MAX_AGE_MS,
  CAPTURE_RETENTION_MAX_BYTES,
  CAPTURE_RETENTION_MAX_FILES,
  TASK_JOURNAL_MAX_EVENTS
} from "../runtime-limits.ts";
import { currentSessionName, hasOperatorSessionName } from "../session/message-signals.ts";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import { buildContextPreflight, buildUsageSnapshot } from "../session/usage.ts";
import { toolResultCaptureRoot } from "../session/tool-result-compaction.ts";
import { ensureTaskAuthorityResumePolicy } from "../policy/authority-resume-policy.ts";
import { buildHandoffProjection, writeHandoffProjection } from "../recovery/handoff-projection.ts";
import { activeTaskToolGroups } from "../tools/tool-groups.ts";
import type { PiagentToolGroup } from "../tools/tool-groups.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import type { ResumeState } from "../recovery/resume-state.ts";

type SessionTaskReference = { taskId?: string; taskRunId?: string };

type SessionStartHookDependencies = {
  state: RuntimeSessionState;
  loadProfile: (ctx: ExtensionContext) => ProjectProfile;
  projectProfileExists: (cwd: string) => boolean;
  activateToolGroups: (ctx: ExtensionContext, groups: PiagentToolGroup[]) => unknown;
  taskReference: (ctx: ExtensionContext) => SessionTaskReference | undefined;
  activeTask: (cwd: string, sessionId: string) => TaskContract | undefined;
  resolveTask: (cwd: string, reference: string, sessionId: string) => TaskContract | undefined;
  resolveTaskAny: (cwd: string, reference: string) => TaskContract | undefined;
  bindTask: (cwd: string, sessionId: string, sessionName: string | undefined, task: TaskContract) => unknown;
  writeTask: (cwd: string, task: TaskContract) => TaskContract;
  capabilityState: (ctx: ExtensionContext) => { ok: boolean; reason?: string; repinned?: string };
  permissionProfile: (ctx: ExtensionContext, profile: ProjectProfile) => { mode: string; warning?: string };
  legacyProjectWarning: (cwd: string) => string | undefined;
  mcpReadinessNotice: (cwd: string) => string | undefined;
  updateAvailabilityNotice: () => string | undefined;
  contextExcludePatterns: (profile: ProjectProfile) => string[];
  inspectResume: (cwd: string, task: TaskContract, sessionId: string) => ResumeState;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  syncTrajectory?: (ctx: ExtensionContext, task: TaskContract) => TrajectorySyncResult;
  afterStart?: (ctx: ExtensionContext) => void;
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
    const activeTaskRunId = readSessionTaskBinding(ctx.cwd, sessionId)?.activeTaskRunId ?? taskReference?.taskRunId;
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
    let taskJournalRetention: Record<string, unknown>;
    try {
      taskJournalRetention = pruneTaskJournal(ctx.cwd, { maxEvents: TASK_JOURNAL_MAX_EVENTS });
      const corruptions = Array.isArray(taskJournalRetention.corruptions) ? taskJournalRetention.corruptions : [];
      if (corruptions.length > 0) ctx.ui.notify(`Piagent task journal needs recovery: ${corruptions[0]}`, "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      taskJournalRetention = { pruned: 0, kept: 0, error: message };
      ctx.ui.notify(`Piagent task journal needs recovery: ${message}`, "warning");
    }

    const migration = migrateTaskState(ctx.cwd, {
      sessionId,
      sessionName,
      taskId: taskReference?.taskId,
      taskRunId: activeTaskRunId
    });
    if (migration.warnings.length > 0) {
      ctx.ui.notify(`Piagent task-state migration needs recovery: ${migration.warnings.join("; ")}`, "warning");
    }
    let resumedTask = dependencies.activeTask(ctx.cwd, sessionId);
    let identityConflict: string | undefined;
    if (!resumedTask && taskReference) {
      resumedTask = dependencies.resolveTask(ctx.cwd, taskReference.taskRunId ?? taskReference.taskId ?? "", sessionId);
      if (resumedTask) dependencies.bindTask(ctx.cwd, sessionId, sessionName, resumedTask);
      else {
        const referenced = dependencies.resolveTaskAny(ctx.cwd, taskReference.taskRunId ?? taskReference.taskId ?? "");
        if (referenced && referenced.sessionId !== sessionId) {
          identityConflict = `Task ${referenced.taskRunId} belongs to session ${referenced.sessionId}; resume into ${sessionId} was refused.`;
          ctx.ui.notify(`Piagent task recovery is blocked: ${identityConflict}`, "warning");
        }
      }
    }
    const authorityPolicy = resumedTask?.trace.outcome === "pending"
      ? ensureTaskAuthorityResumePolicy(ctx.cwd, resumedTask, {
        authorityProfile: profile.authorityProfile,
        environment: process.env
      })
      : undefined;
    if (resumedTask?.trace.outcome === "pending" && authorityPolicy?.disposition === "new-attempt-required") {
      try {
        writeHandoffProjection(ctx.cwd, buildHandoffProjection(ctx.cwd, resumedTask, {
          gate: {
            decision: "fail",
            missing: [`authority policy handoff: ${authorityPolicy.reason}`],
            missingVerifyCommands: []
          },
          recovery: null
        }));
        dependencies.activateToolGroups(ctx, ["intake"]);
      } catch (error) {
        ctx.ui.notify(`Piagent authority-policy handoff could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
    if (resumedTask?.trace.outcome === "pending" && authorityPolicy?.disposition === "resume-pinned" && resumedTask.sessionName !== sessionName) {
      resumedTask.sessionName = sessionName;
      resumedTask = dependencies.writeTask(ctx.cwd, resumedTask);
      dependencies.bindTask(ctx.cwd, sessionId, sessionName, resumedTask);
    }
    if (resumedTask?.workingTreeDigestMigration && resumedTask.workingTreeDigestMigration.status !== "refreshed") dependencies.state.clearDigestMigrationState(ctx, resumedTask.taskRunId, resumedTask.taskId);
    dependencies.state.cacheTaskIdentity(ctx, resumedTask);
    const resumeState = resumedTask ? dependencies.inspectResume(ctx.cwd, resumedTask, sessionId) : undefined;
    if (resumeState) dependencies.state.rememberResumeState(resumeState);
    if (resumedTask && resumeState?.enforcementSafe) observeTrajectorySync(ctx, dependencies.syncTrajectory?.(ctx, resumedTask), dependencies.telemetry);
    let taskRecovery: Record<string, unknown> | undefined;
    if (resumedTask?.trace.outcome === "pending") {
      taskRecovery = {
        decision: resumeState?.decision ?? "blocked",
        retryAllowed: resumeState?.decision === "retry",
        checkpointId: resumeState?.latestCheckpoint?.checkpointId,
        reason: resumeState?.reason ?? "Resume state unavailable.",
        checkpoints: resumeState?.journal.checkpoints ?? 0,
        corruptions: resumeState?.journal.corruptions.length ?? 0,
        currentTreeDigest: resumeState?.currentTreeDigest,
        verifierEvidenceCurrent: resumeState?.verifierEvidenceCurrent,
        staleVerifierEvidence: resumeState?.staleVerifierEvidence,
        phase: resumeState?.phase,
        handoff: resumeState?.handoff,
        reconstruction: resumeState?.reconstruction,
        authorityPolicy: resumeState?.authorityPolicy
      };
      if (resumeState?.enforcementSafe) dependencies.activateToolGroups(ctx, activeTaskToolGroups(resumedTask));
      if (resumeState?.decision === "blocked") {
        ctx.ui.notify(`Piagent task recovery is blocked: ${resumeState.reason}`, "warning");
      } else if (resumeState?.decision === "paused") {
        ctx.ui.notify(`Piagent task remains paused at ${resumeState.latestCheckpoint?.checkpointId ?? "its latest checkpoint"}.`, "warning");
      } else if (resumeState?.decision === "retry") {
        ctx.ui.notify(`Piagent task can retry from ${resumeState.latestCheckpoint?.checkpointId ?? "its latest checkpoint"}.`, "info");
      } else if (resumeState?.staleVerifierEvidence) {
        ctx.ui.notify("Piagent resumed the task, but the working tree changed; prior verifier evidence is stale and must be rerun exactly.", "warning");
      }
    } else if (identityConflict) {
      taskRecovery = { decision: "blocked", retryAllowed: false, reason: identityConflict, identityConflict: true };
    }

    const profileHint = explicitProfile || (projectTrusted && dependencies.projectProfileExists(ctx.cwd))
      ? ""
      : " (run /onboard to select a profile)";
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    const preflight = buildContextPreflight(snapshot, "task", 0);
    const capabilityState = dependencies.capabilityState(ctx);
    const permissionProfile = dependencies.permissionProfile(ctx, profile);
    const executionBackend = resolveExecutionBackend();
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
    if (executionBackend.warning) ctx.ui.notify(executionBackend.warning, "warning");
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
      captureRetention,
      taskJournalRetention,
      taskRecovery,
      executionBackend
    });
    dependencies.afterStart?.(ctx);
  });
}

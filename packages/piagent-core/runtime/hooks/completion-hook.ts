import crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.js";
import { runtimeLifecycleMode, workingTreeEvidenceDigest } from "../../extensions/task-lifecycle.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import {
  assistantMessageHasToolCall,
  assistantMessageText,
  looksLikeCompletionClaim,
  looksLikeIncompleteHandoff
} from "../session/message-signals.ts";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import type { ObservedTaskContext } from "../session/runtime-state.ts";

type CompletionGate = {
  decision: "pass" | "fail";
  missing: string[];
  missingVerifyCommands: string[];
};

type CompletionHookDependencies = {
  state: RuntimeSessionState;
  maxManifestFiles: number;
  autoRecoveryEnabled: boolean;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  flushObservedTaskContext: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    pendingContext: ObservedTaskContext[],
    maxManifestFiles: number,
    event: string
  ) => TaskContract | undefined;
  completionProjection: (
    cwd: string,
    task: TaskContract,
    currentDigests: Record<string, string>
  ) => TaskContract;
  evaluateGate: (
    cwd: string,
    task: TaskContract,
    currentDigests: Record<string, string>,
    currentDigest: string
  ) => CompletionGate;
  writeTask: (cwd: string, task: TaskContract) => TaskContract;
  activateBaseTools: (ctx: ExtensionContext) => unknown;
  appendTrace: (cwd: string, payload: Record<string, unknown>) => void;
  appendSessionTrace: (pi: ExtensionAPI, payload: Record<string, unknown>) => void;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  finalGateMode: (ctx: ExtensionContext) => string;
  verifierInstructions: (commands: string[]) => string[];
};

export function registerCompletionHook(pi: ExtensionAPI, dependencies: CompletionHookDependencies): void {
  const {
    state,
    maxManifestFiles,
    autoRecoveryEnabled,
    activeTask,
    flushObservedTaskContext,
    completionProjection,
    evaluateGate,
    writeTask,
    activateBaseTools,
    appendTrace,
    appendSessionTrace,
    telemetry,
    finalGateMode,
    verifierInstructions
  } = dependencies;

  pi.on("message_end", async (event, ctx) => {
    if (!event.message || event.message.role !== "assistant" || assistantMessageHasToolCall(event.message)) return;
    let task = flushObservedTaskContext(
      pi,
      ctx,
      state.observedContext(ctx),
      maxManifestFiles,
      "context_observed_before_handoff"
    ) ?? activeTask(ctx);
    if (!task) return;
    const text = assistantMessageText(event.message);
    const completionClaim = looksLikeCompletionClaim(text);
    const incompleteHandoff = looksLikeIncompleteHandoff(text);
    if (task.trace.outcome !== "pending") return;
    const readOnlyEvidenceObserved = task.changeMode === "read-only" && task.contextManifest.length > 0;
    const potentiallyFinalEvidence = task.observedChangedFiles.length > 0
      || task.verifyEvidence.some((evidence) => evidence.exitCode === 0 && evidence.observed === true && evidence.matchedProfileCommand === true)
      || readOnlyEvidenceObserved;
    if (!completionClaim && (incompleteHandoff || !potentiallyFinalEvidence)) return;

    const currentDigests = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
    const currentDigest = workingTreeEvidenceDigest(currentDigests);
    const currentPassingVerifierObserved = task.verifyEvidence.some((evidence) => (
      evidence.exitCode === 0
      && evidence.observed === true
      && evidence.matchedProfileCommand === true
      && evidence.workingTreeDigest === currentDigest
    ));
    const handoffAttempt = completionClaim || (
      !incompleteHandoff
      && (task.observedChangedFiles.length > 0 || currentPassingVerifierObserved || readOnlyEvidenceObserved)
    );
    let completionGate: CompletionGate | undefined;
    if (handoffAttempt) {
      const projected = completionProjection(ctx.cwd, task, currentDigests);
      const projectedGate = evaluateGate(ctx.cwd, projected, currentDigests, currentDigest);
      completionGate = projectedGate;
      if (projectedGate.decision === "pass") {
        task = writeTask(ctx.cwd, projected);
        state.cacheTaskIdentity(ctx, task);
        state.clearCompletionRecoveryAttempt(task.taskRunId);
        state.clearObservedContext(ctx);
        activateBaseTools(ctx);
        const trace = {
          event: "task_auto_completed",
          taskId: task.taskId,
          taskRunId: task.taskRunId,
          sessionId: task.sessionId,
          changedFiles: task.changedFiles,
          lifecycleMode: runtimeLifecycleMode(task)
        };
        appendTrace(ctx.cwd, trace);
        appendSessionTrace(pi, trace);
        telemetry(ctx, trace);
        return;
      }
    }
    if (!handoffAttempt || finalGateMode(ctx) !== "enforce") return;
    const gate = completionGate ?? evaluateGate(ctx.cwd, task, currentDigests, currentDigest);
    if (gate.decision === "pass") return;

    const recoveryAttempt = state.completionRecoveryAttempt(task.taskRunId);
    const lifecycleMode = runtimeLifecycleMode(task);
    if (autoRecoveryEnabled && lifecycleMode !== "manual" && recoveryAttempt < 1) {
      state.rememberCompletionRecoveryAttempt(task.taskRunId, recoveryAttempt + 1);
      const recoveryGuidance = task.changeMode === "read-only"
        ? [
            "Continue the same read-only task. Review the cited evidence against the requested scope, state concrete unknowns, and complete the returned review step when required.",
            "Do not mutate project source or repeat diagnostic Piagent tools; use ordinary targeted reads and the active progress tool only."
          ]
        : [
            "Continue the same bounded task. Re-check the requested behavior against current source, make a relevant in-scope change when required, and run every exact configured verifier.",
            ...verifierInstructions(gate.missingVerifyCommands),
            "A pre-existing passing test without a relevant source diff is not completion. Do not repeat diagnostic Piagent tools; use ordinary read/edit/bash work."
          ];
      const recovery = [
        "[Piagent continuation required]",
        `Task ${task.taskId} cannot finish yet. Missing: ${gate.missing.join(", ")}.`,
        ...recoveryGuidance
      ].join("\n");
      pi.sendMessage(
        { customType: "piagent-completion-recovery", content: recovery, display: false, details: { taskId: task.taskId, missing: gate.missing } },
        { deliverAs: "followUp", triggerTurn: true }
      );
      const recoveryTrace = {
        event: "completion_recovery_scheduled",
        taskId: task.taskId,
        taskRunId: task.taskRunId,
        sessionId: task.sessionId,
        attempt: recoveryAttempt + 1,
        missing: gate.missing
      };
      appendTrace(ctx.cwd, recoveryTrace);
      appendSessionTrace(pi, recoveryTrace);
      telemetry(ctx, recoveryTrace);
      const continuingNotice = [
        "[Piagent completion gate: CONTINUING]",
        `Task ${task.taskId} needs one bounded correction pass before handoff.`,
        ""
      ].join("\n");
      const content = Array.isArray(event.message.content)
        ? [{ type: "text" as const, text: continuingNotice }, ...event.message.content]
        : [{ type: "text" as const, text: `${continuingNotice}${text}` }];
      return { message: { ...event.message, content } };
    }

    const notice = [
      "[Piagent completion gate: NOT APPROVED]",
      `Task ${task.taskId} (${task.taskRunId}) is still open.`,
      `Missing: ${gate.missing.join(", ") || "a completed task trace"}.`,
      ...verifierInstructions(gate.missingVerifyCommands),
      "The response below is preserved as work in progress and must not be treated as a completion report.",
      ""
    ].join("\n");
    const content = Array.isArray(event.message.content)
      ? [{ type: "text" as const, text: notice }, ...event.message.content]
      : [{ type: "text" as const, text: `${notice}${text}` }];
    const trace = {
      event: "completion_claim_blocked",
      taskId: task.taskId,
      taskRunId: task.taskRunId,
      sessionId: task.sessionId,
      missing: gate.missing,
      responseHash: crypto.createHash("sha256").update(text).digest("hex"),
      responseChars: text.length
    };
    appendTrace(ctx.cwd, trace);
    appendSessionTrace(pi, trace);
    telemetry(ctx, trace);
    return { message: { ...event.message, content } };
  });
}

import crypto from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  acceptanceCriticalRecoveryProjection,
  applyAcceptanceRecoveryProvenance
} from "../../extensions/acceptance-receipt.js";
import type { TaskContract } from "../../extensions/guard-types.js";
import { runtimeLifecycleMode, workingTreeEvidenceDigest } from "../../extensions/task-lifecycle.js";
import { recordCompletionAudit } from "../../extensions/task-runtime-audit.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import { taskDeltaFilesFromSnapshot } from "../../extensions/task-contract-view.js";
import { latestObservedVerification, verificationEvidenceProvesStableTree } from "../../extensions/verification-intelligence.js";
import {
  assistantMessageHasToolCall,
  assistantMessageText,
  looksLikeCompletionClaim,
  looksLikeIncompleteHandoff
} from "../session/message-signals.ts";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import type { ObservedTaskContext } from "../session/runtime-state.ts";
import type { RecoveryDecision } from "../recovery/recovery-policy.ts";
import { buildHandoffProjection, handoffProjectionPath, writeHandoffProjection } from "../recovery/handoff-projection.ts";
import { evaluateExactFinalOutputContract } from "../quality/exact-output-contract.ts";
import { performanceReviewGuidance, taskPerformanceAssurance } from "../quality/performance-assurance.ts";
import { planRecoveryContinuation, reserveSemanticReviewContinuation } from "../recovery/continuation-budget.ts";
import { semanticRepairProvenance } from "../recovery/semantic-repair-handshake.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncOptions, TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import { readTrajectoryStore } from "../trajectory/trajectory-store.ts";

type CompletionGate = { decision: "pass" | "fail"; missing: string[]; missingVerifyCommands: string[] };

type CriticalRecoveryProjection = {
  criterionText: string;
  targets: string[];
  missingDimensions: string[];
  proofHints: string[];
};
function exactPathCoverage(expectedPaths: string[], reviewedPaths: string[] | undefined): boolean {
  const expected = [...new Set(expectedPaths)].sort();
  const reviewed = [...new Set(reviewedPaths ?? [])].sort();
  return expected.length > 0
    && expected.length === reviewed.length
    && expected.every((file, index) => file === reviewed[index]);
}

function compactRecoveryField(value: unknown, maximum: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…` : text;
}

function criticalAcceptanceRecoveryGuidance(projections: CriticalRecoveryProjection[]): string[] {
  if (projections.length === 0) return [];
  const lines = ["Critical proof targets (derived only from the current task contract and working tree):"];
  for (const projection of projections.slice(0, 8)) {
    const targets = projection.targets.map((item) => compactRecoveryField(item, 80)).filter(Boolean).slice(0, 8);
    const dimensions = projection.missingDimensions.map((item) => compactRecoveryField(item, 80)).filter(Boolean).slice(0, 8);
    const criterion = compactRecoveryField(projection.criterionText, 700);
    lines.push(`- Target: ${targets.join(", ") || "task-scoped behavior"}; missing proof: ${dimensions.join(", ") || "focused-evidence"}; criterion: ${criterion}`);
  }
  const hints = [...new Set(projections.flatMap((projection) => projection.proofHints)
    .map((hint) => compactRecoveryField(hint, 300))
    .filter(Boolean))].slice(0, 8);
  if (hints.length > 0) lines.push("Proof requirements:", ...hints.map((hint) => `- ${hint}`));
  return lines;
}

type CompletionHookDependencies = {
  state: RuntimeSessionState;
  maxManifestFiles: number; semanticReviewAllowed: (task: TaskContract) => boolean;
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
  recoveryDecision: (ctx: ExtensionContext, task: TaskContract, gate: CompletionGate, currentDigest: string) => RecoveryDecision;
  syncTrajectory?: (ctx: ExtensionContext, task: TaskContract, options: TrajectorySyncOptions) => TrajectorySyncResult;
};

export function registerCompletionHook(pi: ExtensionAPI, dependencies: CompletionHookDependencies): void {
  const {
    state,
    maxManifestFiles,
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
    verifierInstructions,
    recoveryDecision,
    semanticReviewAllowed,
    syncTrajectory
  } = dependencies;

  function persistHandoff(
    ctx: ExtensionContext,
    task: TaskContract,
    gate: CompletionGate,
    currentDigests: Record<string, string>,
    recovery: RecoveryDecision | null
  ): void {
    try {
      const projection = writeHandoffProjection(ctx.cwd, buildHandoffProjection(ctx.cwd, task, { gate, currentDigests, recovery }));
      telemetry(ctx, {
        event: "handoff_projection_written",
        taskId: task.taskId,
        taskRunId: task.taskRunId,
        path: handoffProjectionPath(ctx.cwd, task.taskRunId),
        phase: projection.state.phase,
        completionApproved: projection.state.completionApproved,
        recoveryAction: projection.nextSafeAction.action
      });
    } catch (error) {
      ctx.ui.notify(`Piagent handoff projection could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  function withRecoveryProvenance(
    ctx: ExtensionContext,
    task: TaskContract,
    gate: CompletionGate,
    currentDigests: Record<string, string>,
    recovery: RecoveryDecision | null
  ): TaskContract {
    let failureClassification: unknown;
    let recordedRecovery: unknown = recovery;
    try {
      const preview = buildHandoffProjection(ctx.cwd, task, { gate, currentDigests, recovery });
      failureClassification = preview.failure.classification;
      recordedRecovery = preview.failure.recovery;
    } catch {
      // Receipt provenance remains useful from bounded runtime history even when
      // an unsafe/corrupt sidecar prevents preview reconstruction.
    }
    return applyAcceptanceRecoveryProvenance(task, {
      outcome: task.trace.outcome,
      gateDecision: gate.decision,
      recoveryHistory: state.recoveryHistory(task.taskId),
      trajectoryTransitions: readTrajectoryStore(ctx.cwd, task.taskRunId).events,
      semanticRepair: semanticRepairProvenance(ctx.cwd, task.taskRunId),
      failureClassification,
      recoveryDecision: recordedRecovery,
      handoffRef: path.relative(ctx.cwd, handoffProjectionPath(ctx.cwd, task.taskRunId)).split(path.sep).join("/")
    }) as TaskContract;
  }

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
    observeTrajectorySync(ctx, syncTrajectory?.(ctx, task, { sourceHook: "completion" }), telemetry);
    const text = assistantMessageText(event.message);
    const completionClaim = looksLikeCompletionClaim(text);
    const incompleteHandoff = looksLikeIncompleteHandoff(text);
    if (task.trace.outcome !== "pending") return;
    const readOnlyEvidenceObserved = task.changeMode === "read-only" && task.contextManifest.length > 0;
    const latestExactVerifier = latestObservedVerification(task.verifyEvidence.filter((evidence) => evidence.matchedProfileCommand === true));
    const potentiallyFinalEvidence = task.observedChangedFiles.length > 0
      || latestExactVerifier?.exitCode === 0
      || readOnlyEvidenceObserved;
    if (!completionClaim && (incompleteHandoff || !potentiallyFinalEvidence)) return;

    const currentDigests = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
    const currentDigest = workingTreeEvidenceDigest(currentDigests);
    const currentPassingVerifierObserved = verificationEvidenceProvesStableTree(latestExactVerifier, currentDigest);
    const handoffAttempt = completionClaim || (
      !incompleteHandoff
      && (task.observedChangedFiles.length > 0 || currentPassingVerifierObserved || readOnlyEvidenceObserved)
    );
    let completionGate: CompletionGate | undefined;
    if (handoffAttempt) {
      let projected = completionProjection(ctx.cwd, task, currentDigests);
      const baseProjectedGate = evaluateGate(ctx.cwd, projected, currentDigests, currentDigest);
      const exactOutput = evaluateExactFinalOutputContract(projected, text, ctx.cwd);
      const projectedGate: CompletionGate = exactOutput.applicable && !exactOutput.passed
        ? {
          ...baseProjectedGate,
          decision: "fail",
          missing: [
            ...baseProjectedGate.missing,
            `exact final output contract (${exactOutput.key}=<value> must copy the complete observed value verbatim as the last non-empty line)`
          ]
        }
        : baseProjectedGate;
      completionGate = projectedGate;
      if (projectedGate.decision === "pass") {
        const assurance = taskPerformanceAssurance(projected);
        const expectedReviewPaths = taskDeltaFilesFromSnapshot(projected, currentDigests);
        const review = state.performanceReviewCheckpoint(task.taskRunId);
        const reviewCheckpointReady = review?.workingTreeDigest === currentDigest
          && review.reviewSatisfied
          && !review.invalidated
          && exactPathCoverage(expectedReviewPaths, review.expectedPaths)
          && exactPathCoverage(expectedReviewPaths, review.reviewedPaths);
        const reviewCredit = state.performanceReviewCredit(task.taskRunId, currentDigest);
        const reviewCreditReady = Boolean(reviewCredit && exactPathCoverage(expectedReviewPaths, reviewCredit.reviewedPaths));
        const reviewReady = reviewCheckpointReady || reviewCreditReady;
        if (semanticReviewAllowed(task) && assurance.requiresReview && reviewCreditReady && reviewCredit && !reviewCheckpointReady) {
          const trace = {
            event: "performance_review_credit_reused",
            taskId: task.taskId,
            taskRunId: task.taskRunId,
            sessionId: task.sessionId,
            workingTreeDigest: reviewCredit.workingTreeDigest,
            commandHash: reviewCredit.commandHash,
            reviewedPaths: reviewCredit.reviewedPaths,
            reviewedAt: reviewCredit.recordedAt,
            reasonCodes: assurance.reasonCodes
          };
          appendTrace(ctx.cwd, trace);
          appendSessionTrace(pi, trace);
          telemetry(ctx, trace);
        }
        if (semanticReviewAllowed(task) && assurance.requiresReview && !reviewReady) {
          task = writeTask(ctx.cwd, { ...task, changedFiles: projected.changedFiles, acceptanceReceipt: projected.acceptanceReceipt });
          const reservation = reserveSemanticReviewContinuation(ctx.cwd, task, {
            currentWorkingTreeDigest: currentDigest, expectedPaths: expectedReviewPaths, reasonCodes: assurance.reasonCodes
          });
          if (reservation.allowed) {
            const attempt = reservation.consumed;
            state.rememberPerformanceReviewCheckpoint(task.taskRunId, currentDigest, attempt, expectedReviewPaths);
            const guidance = ["[Piagent semantic review required]", `Task ${task.taskId} passed mechanical gates but needs semantic review ${attempt}/${reservation.maximum}.`, ...performanceReviewGuidance(projected)].join("\n");
            pi.sendMessage(
              { customType: "piagent-performance-review", content: guidance, display: false, details: { taskId: task.taskId, attempt, assurance, progressSignature: reservation.progressSignature } },
              { deliverAs: "followUp", triggerTurn: true }
            );
            const trace = {
              event: "performance_review_scheduled", taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
              attempt, workingTreeDigest: currentDigest,
              reasonCodes: assurance.reasonCodes,
              progressSignature: reservation.progressSignature, globalContinuationMaximum: reservation.maximum
            };
            appendTrace(ctx.cwd, trace);
            appendSessionTrace(pi, trace);
            telemetry(ctx, trace);
            const notice = ["[Piagent completion gate: CONTINUING]", `Task ${task.taskId} needs one semantic diff-review before handoff.`, ""].join("\n");
            const content = Array.isArray(event.message.content)
              ? [{ type: "text" as const, text: notice }, ...event.message.content]
              : [{ type: "text" as const, text: `${notice}${text}` }];
            return { message: { ...event.message, content } };
          }
          const reviewGate: CompletionGate = { decision: "fail", missing: [`semantic review handoff: ${reservation.reason}`], missingVerifyCommands: [] };
          observeTrajectorySync(ctx, syncTrajectory?.(ctx, task, { sourceHook: "completion", handoffObserved: true }), telemetry);
          persistHandoff(ctx, task, reviewGate, currentDigests, null);
          const handoffTrace = {
            event: "performance_review_handed_off", taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
            reason: reservation.reason, progressSignature: reservation.progressSignature,
            globalContinuationConsumed: reservation.consumed, globalContinuationMaximum: reservation.maximum
          };
          appendTrace(ctx.cwd, handoffTrace); appendSessionTrace(pi, handoffTrace); telemetry(ctx, handoffTrace);
          recordCompletionAudit(ctx, task, { outcome: "blocked", evidence: handoffTrace });
          const notice = [
            "[Piagent completion gate: NOT APPROVED]",
            `Task ${task.taskId} cannot schedule another semantic review: ${reservation.reason}; ${review?.activityObserved ? "current-tree review activity was observed but did not produce complete credit" : "no current-tree review activity was observed"}.`,
            "A deterministic handoff was written; do not retry automatically.",
            ""
          ].join("\n");
          const content = Array.isArray(event.message.content)
            ? [{ type: "text" as const, text: notice }, ...event.message.content]
            : [{ type: "text" as const, text: `${notice}${text}` }];
          return { message: { ...event.message, content } };
        }
        observeTrajectorySync(ctx, syncTrajectory?.(ctx, task, { sourceHook: "completion", handoffObserved: true }), telemetry);
        projected = withRecoveryProvenance(ctx, projected, projectedGate, currentDigests, null);
        task = writeTask(ctx.cwd, projected);
        observeTrajectorySync(ctx, syncTrajectory?.(ctx, task, { sourceHook: "completion" }), telemetry);
        state.cacheTaskIdentity(ctx, task);
        state.clearPerformanceReview(task.taskRunId);
        state.clearObservedContext(ctx);
        activateBaseTools(ctx);
        recordCompletionAudit(ctx, task, {
          outcome: "completed",
          evidence: {
            changedFiles: task.changedFiles,
            lifecycleMode: runtimeLifecycleMode(task)
          }
        });
        persistHandoff(ctx, task, projectedGate, currentDigests, null);
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
      task = writeTask(ctx.cwd, {
        ...task,
        changedFiles: projected.changedFiles,
        acceptanceReceipt: projected.acceptanceReceipt
      });
      state.cacheTaskIdentity(ctx, task);
    }
    if (!handoffAttempt || finalGateMode(ctx) !== "enforce") return;
    const gate = completionGate ?? evaluateGate(ctx.cwd, task, currentDigests, currentDigest);
    if (gate.decision === "pass") return;

    const selectedRecovery = recoveryDecision(ctx, task, gate, currentDigest);
    const missingAcceptanceProof = gate.missing.some((item) => /^critical acceptance evidence\b/i.test(item));
    const lifecycleMode = runtimeLifecycleMode(task);
    const continuation = planRecoveryContinuation(ctx.cwd, task, selectedRecovery, {
      lifecycleMode, currentWorkingTreeDigest: currentDigest, missing: gate.missing, missingVerifyCommands: gate.missingVerifyCommands
    });
    const reservation = continuation.reservation;
    if (reservation?.allowed) {
      state.rememberRecoveryHistory({
        taskId: selectedRecovery.taskId,
        taskRunId: selectedRecovery.taskRunId,
        taskAttempt: selectedRecovery.taskAttempt,
        evidenceDigest: selectedRecovery.evidenceDigest,
        failureCategory: selectedRecovery.failureCategory,
        action: selectedRecovery.action,
        disposition: "scheduled",
        phase: selectedRecovery.nextPhase ?? selectedRecovery.currentPhase,
        hypothesisRef: selectedRecovery.hypothesisRef
      });
      if (selectedRecovery.action === "repair" && selectedRecovery.sourceMutationAllowed) {
        observeTrajectorySync(ctx, syncTrajectory?.(ctx, task, {
          sourceHook: "completion",
          recoveryMutationAllowed: true,
          recoveryRequested: true
        }), telemetry);
      }
      let criticalRecovery: CriticalRecoveryProjection[] = [];
      if (missingAcceptanceProof) {
        try {
          criticalRecovery = acceptanceCriticalRecoveryProjection(task, {
            cwd: ctx.cwd,
            changedFiles: taskDeltaFilesFromSnapshot(task, currentDigests),
            currentWorkingTreeDigest: currentDigest
          }) as CriticalRecoveryProjection[];
        } catch {
          // Exact gate evidence remains the fail-closed fallback when advisory projection is unavailable.
        }
      }
      const criticalRecoveryGuidance = criticalAcceptanceRecoveryGuidance(criticalRecovery);
      const recoveryGuidance = selectedRecovery.action === "repair" && selectedRecovery.sourceMutationAllowed
        ? missingAcceptanceProof
          ? [
            "Continue the same bounded task with one acceptance-proof repair pass.",
            ...criticalRecoveryGuidance,
            "Add or correct focused in-scope tests for every missing critical obligation. Assert exact boundary partitions and requested error classes; if a focused test exposes a defect, repair the in-scope source before rerunning verification.",
            ...verifierInstructions(gate.missingVerifyCommands),
            "Do not broaden task scope, repeat a failed hypothesis, expand permission, or perform an external action."
          ]
          : [
            "Continue the same bounded task with one targeted in-scope source repair, then run every exact configured verifier.",
            ...verifierInstructions(gate.missingVerifyCommands),
            "Do not broaden task scope, repeat a failed hypothesis, expand permission, or perform an external action."
          ]
        : selectedRecovery.reasonCodes.includes("unknown-diagnostic-pass") || task.changeMode === "read-only"
        ? [
            ...(gate.missingVerifyCommands.length > 0
              ? ["Run only the missing exact verifier commands against the current working tree.", ...verifierInstructions(gate.missingVerifyCommands)]
              : ["Run one bounded diagnostic pass using targeted reads and report the concrete evidence or unknown."]),
            "Do not mutate project source, expand permission, or perform an external action."
          ]
        : [
            "Retry only the exact transient operation or configured verifier once.",
            ...verifierInstructions(gate.missingVerifyCommands),
            "Do not mutate project source, expand permission, or perform an external action during this retry."
          ];
      const otherMissing = gate.missing.filter((item) => !/^critical acceptance evidence\b/i.test(item));
      const missingSummary = criticalRecovery.length > 0
        ? [
          `${criticalRecovery.length} critical acceptance proof target(s)`,
          ...otherMissing
        ].join(", ")
        : gate.missing.join(", ");
      const recovery = [
        "[Piagent continuation required]",
        `Task ${task.taskId} cannot finish yet. Missing: ${missingSummary}.`,
        `Recovery: ${selectedRecovery.action}; class: ${selectedRecovery.failureCategory}; reasons: ${selectedRecovery.reasonCodes.join(", ")}.`,
        ...recoveryGuidance
      ].join("\n");
      pi.sendMessage(
        { customType: "piagent-completion-recovery", content: recovery, display: false, details: { taskId: task.taskId, missing: gate.missing, recovery: selectedRecovery, progressSignature: reservation.progressSignature } },
        { deliverAs: "followUp", triggerTurn: true }
      );
      const recoveryTrace = {
        event: "completion_recovery_scheduled",
        taskId: task.taskId,
        taskRunId: task.taskRunId,
        sessionId: task.sessionId,
        attempt: reservation.consumed,
        missing: gate.missing,
        action: selectedRecovery.action,
        failureCategory: selectedRecovery.failureCategory,
        recoveryReasonCodes: selectedRecovery.reasonCodes,
        sourceMutationAllowed: selectedRecovery.sourceMutationAllowed,
        continuationClass: continuation.classification,
        progressSignature: reservation.progressSignature,
        globalContinuationMaximum: reservation.maximum
      };
      appendTrace(ctx.cwd, recoveryTrace);
      appendSessionTrace(pi, recoveryTrace);
      telemetry(ctx, recoveryTrace);
      recordCompletionAudit(ctx, task, {
        outcome: "failed",
        idempotencyAt: `${task.updatedAt}:${reservation.progressSignature}`,
        evidence: {
          attempt: reservation.consumed,
          missing: gate.missing,
          missingVerifyCommands: gate.missingVerifyCommands,
          recovery: selectedRecovery,
          continuationClass: continuation.classification,
          progressSignature: reservation.progressSignature
        }
      });
      persistHandoff(ctx, task, gate, currentDigests, selectedRecovery);
      const continuingNotice = [
        "[Piagent completion gate: CONTINUING]",
        `Task ${task.taskId} needs one bounded ${selectedRecovery.action} pass before handoff.`,
        ""
      ].join("\n");
      const content = Array.isArray(event.message.content)
        ? [{ type: "text" as const, text: continuingNotice }, ...event.message.content]
        : [{ type: "text" as const, text: `${continuingNotice}${text}` }];
      return { message: { ...event.message, content } };
    }

    const finalRecovery = continuation.recovery;
    const notice = [
      "[Piagent completion gate: NOT APPROVED]",
      `Task ${task.taskId} (${task.taskRunId}) is still open.`,
      `Missing: ${gate.missing.join(", ") || "a completed task trace"}.`,
      `Recovery disposition: ${finalRecovery.action} (${finalRecovery.reasonCodes.join(", ")}).`,
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
      responseChars: text.length,
      recoveryAction: finalRecovery.action,
      failureCategory: finalRecovery.failureCategory,
      recoveryReasonCodes: finalRecovery.reasonCodes
    };
    appendTrace(ctx.cwd, trace);
    appendSessionTrace(pi, trace);
    telemetry(ctx, trace);
    recordCompletionAudit(ctx, task, {
      outcome: "blocked",
      evidence: {
        missing: gate.missing,
        missingVerifyCommands: gate.missingVerifyCommands,
        recovery: finalRecovery
      }
    });
    persistHandoff(ctx, task, gate, currentDigests, finalRecovery);
    return { message: { ...event.message, content } };
  });
}

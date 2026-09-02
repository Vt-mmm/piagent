import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.js";
import { hasDurableContextEvidence } from "../../extensions/context-evidence.js";
import { applyAssistedReadOnlyFinalHandoff, runtimeLifecycleMode,
  workingTreeEvidenceDigest } from "../../extensions/task-lifecycle.js";
import { recordCompletionAudit } from "../../extensions/task-runtime-audit.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import { taskDeltaFilesFromSnapshot } from "../../extensions/task-contract-view.js";
import { evaluateExactFinalOutputContract } from "../quality/exact-output-contract.ts";
import { taskPerformanceAssurance } from "../quality/performance-assurance.ts";
import type { RuntimeSessionState } from "../session/runtime-state.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncOptions, TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import { compositeTaskPublicationDigest } from "./composite-task-publication.ts";

type Gate = { decision: "pass" | "fail"; missing: string[]; missingVerifyCommands: string[] };
type Projection = { task: TaskContract; projected: TaskContract; gate: Gate;
  currentDigests: Record<string, string>; currentDigest: string };
type Options = { ctx: ExtensionContext; pi: ExtensionAPI; state: RuntimeSessionState; task: TaskContract; responseText: string;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  completionProjection: (cwd: string, task: TaskContract, digests: Record<string, string>) => TaskContract;
  evaluateGate: (cwd: string, task: TaskContract, digests: Record<string, string>, digest: string) => Gate;
  semanticReviewAllowed: (task: TaskContract) => boolean;
  syncTrajectory?: (ctx: ExtensionContext, task: TaskContract, options: TrajectorySyncOptions) => TrajectorySyncResult;
  withRecoveryProvenance: (task: TaskContract, gate: Gate, digests: Record<string, string>) => TaskContract;
  projectCompositeLifecycle?: (task: TaskContract) => TaskContract | false;
  writeTask: (cwd: string, task: TaskContract) => TaskContract; activateBaseTools: (ctx: ExtensionContext) => unknown;
  appendTrace: (cwd: string, payload: Record<string, unknown>) => void;
  appendSessionTrace: (pi: ExtensionAPI, payload: Record<string, unknown>) => void;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  persistHandoff: (task: TaskContract, gate: Gate, digests: Record<string, string>) => void };

function exactPathCoverage(expectedPaths: string[], reviewedPaths: string[] | undefined): boolean {
  const expected = [...new Set(expectedPaths)].sort(), reviewed = [...new Set(reviewedPaths ?? [])].sort();
  return expected.length > 0 && expected.length === reviewed.length && expected.every((file, index) => file === reviewed[index]);
}

/** Rechecks the ordinary gate without emitting a turn or synthesizing output. */
export function createCompositeCompletionFinalizer(options: Options) {
  const issued = new WeakMap<object, Projection>();
  function reviewReady(task: TaskContract, digest: string, digests: Record<string, string>) {
    const assurance = taskPerformanceAssurance(task); if (!options.semanticReviewAllowed(task) || !assurance.requiresReview) return true;
    const expected = taskDeltaFilesFromSnapshot(task, digests), review = options.state.performanceReviewCheckpoint(task.taskRunId);
    const checkpoint = review?.workingTreeDigest === digest && review.reviewSatisfied && !review.invalidated
      && exactPathCoverage(expected, review.expectedPaths) && exactPathCoverage(expected, review.reviewedPaths);
    const credit = options.state.performanceReviewCredit(task.taskRunId, digest);
    return Boolean(checkpoint || credit && exactPathCoverage(expected, credit.reviewedPaths));
  }
  function project(): Projection | false {
    const task = options.activeTask(options.ctx);
    if (!task || task.taskRunId !== options.task.taskRunId || task.sessionId !== options.task.sessionId
      || task.trace.outcome !== "pending") return false;
    const currentDigests = workingTreeSnapshot(options.ctx.cwd) as Record<string, string>;
    const currentDigest = workingTreeEvidenceDigest(currentDigests); let candidate = structuredClone(task);
    if (options.projectCompositeLifecycle) {
      const projectedLifecycle = options.projectCompositeLifecycle(candidate); if (!projectedLifecycle) return false;
      candidate = projectedLifecycle;
    }
    const readOnly = (candidate.changeMode === "read-only" || candidate.mutationPolicy === "forbidden")
      && hasDurableContextEvidence(candidate);
    applyAssistedReadOnlyFinalHandoff(candidate, { durableReadEvidence: readOnly, finalHandoffObserved: true });
    const projected = options.completionProjection(options.ctx.cwd, candidate, currentDigests);
    const base = options.evaluateGate(options.ctx.cwd, projected, currentDigests, currentDigest);
    const exact = evaluateExactFinalOutputContract(projected, options.responseText, options.ctx.cwd);
    const gate = exact.applicable && !exact.passed ? { ...base, decision: "fail" as const,
      missing: [...base.missing, `exact final output contract (${exact.key}=<value> must copy the complete observed value verbatim as the last non-empty line)`] } : base;
    return gate.decision === "pass" && reviewReady(projected, currentDigest, currentDigests)
      ? { task, projected: options.withRecoveryProvenance(projected, gate, currentDigests), gate, currentDigests, currentDigest } : false;
  }
  function publish(value: Projection): boolean {
    let { task, projected } = value; const { gate, currentDigests, currentDigest } = value;
    const expected = taskDeltaFilesFromSnapshot(projected, currentDigests), review = options.state.performanceReviewCheckpoint(task.taskRunId);
    const credit = options.state.performanceReviewCredit(task.taskRunId, currentDigest);
    if (options.semanticReviewAllowed(task) && taskPerformanceAssurance(projected).requiresReview && credit
      && exactPathCoverage(expected, credit.reviewedPaths) && !(review?.workingTreeDigest === currentDigest && review.reviewSatisfied
        && !review.invalidated && exactPathCoverage(expected, review.expectedPaths) && exactPathCoverage(expected, review.reviewedPaths))) {
      const reused = { event: "performance_review_credit_reused", taskId: task.taskId, taskRunId: task.taskRunId,
        sessionId: task.sessionId, workingTreeDigest: credit.workingTreeDigest, commandHash: credit.commandHash,
        reviewedPaths: credit.reviewedPaths, reviewedAt: credit.recordedAt, reasonCodes: taskPerformanceAssurance(projected).reasonCodes };
      options.appendTrace(options.ctx.cwd, reused); options.appendSessionTrace(options.pi, reused); options.telemetry(options.ctx, reused);
    }
    observeTrajectorySync(options.ctx, options.syncTrajectory?.(options.ctx, task, { sourceHook: "completion", handoffObserved: true }), options.telemetry);
    task = options.writeTask(options.ctx.cwd, projected);
    observeTrajectorySync(options.ctx, options.syncTrajectory?.(options.ctx, task, { sourceHook: "completion" }), options.telemetry);
    options.state.clearPerformanceReview(task.taskRunId); options.state.clearObservedContext(options.ctx); options.activateBaseTools(options.ctx);
    recordCompletionAudit(options.ctx, task, { outcome: "completed", evidence: { changedFiles: task.changedFiles,
      lifecycleMode: runtimeLifecycleMode(task) } }); options.persistHandoff(task, gate, currentDigests);
    const trace = { event: "task_auto_completed", taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
      changedFiles: task.changedFiles, lifecycleMode: runtimeLifecycleMode(task) };
    options.appendTrace(options.ctx.cwd, trace); options.appendSessionTrace(options.pi, trace); options.telemetry(options.ctx, trace); return true;
  }
  function current(value: Projection) {
    const observed = project(); return observed && observed.currentDigest === value.currentDigest
      && compositeTaskPublicationDigest(observed.task) === compositeTaskPublicationDigest(value.task);
  }
  return Object.freeze({ preflight(): object | false { const value = project(); if (!value) return false;
      const capability = Object.freeze({ version: "composite-completion-preflight-v1", taskRunId: value.task.taskRunId,
        workingTreeDigest: value.currentDigest }); issued.set(capability, value); return capability; },
    publication(capability: object): object | false { const value = issued.get(capability); if (!value || !current(value)) return false;
      return Object.freeze({ version: "composite-terminal-task-target-v1", pendingTask: structuredClone(value.task),
        terminalTask: structuredClone(value.projected), pendingTaskDigest: compositeTaskPublicationDigest(value.task),
        terminalTaskDigest: compositeTaskPublicationDigest(value.projected), workingTreeDigest: value.currentDigest }); },
    finalize(capability: object): boolean { const value = issued.get(capability); if (!value || !issued.delete(capability) || !current(value)) return false;
      return publish(value); } });
}

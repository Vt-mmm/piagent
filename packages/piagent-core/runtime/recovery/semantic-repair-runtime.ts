import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.ts";
import type { TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import {
  BOUNDED_RECOVERY_CONFLICT_CODE,
  authorizeSemanticRepairCall,
  completeSemanticRepairCall,
  decideBoundedRecoveryHandshake,
  decideSemanticRepairHandshake,
  pendingSemanticRepairCall,
  readSemanticRepairState,
  rejectSemanticRepairCall,
  reserveSemanticRepairCall,
  reservedSemanticRepairCallMatches,
  semanticRepairOriginMatches,
  semanticRepairStateRequired,
  semanticRepairResumeDecision
} from "./semantic-repair-handshake.ts";

type ToolEvent = { toolCallId?: string; toolName: string; input?: unknown };
type TracePayload = Record<string, unknown>;

type SemanticRepairRuntimeDependencies = {
  now: () => string;
  trace: (ctx: ExtensionContext, task: TaskContract, payload: TracePayload) => void;
  openRepair: (ctx: ExtensionContext, task: TaskContract, observedAt: string) => TrajectorySyncResult | undefined;
};

export type SemanticRepairCompletionMetadata = {
  toolCallId: string;
  success: boolean;
  exitCode: number;
  currentWorkingTreeDigest: string;
  changedPaths: string[];
  authoredChangedPaths?: string[];
  retryableFailure: boolean; correctiveFailure: boolean;
};

/**
 * Bind the durable semantic-repair state machine to runtime hooks without
 * teaching the composition root its transactional details.
 */
export class SemanticRepairRuntime {
  private readonly reservationTokens = new Map<string, string>();
  private readonly dependencies: SemanticRepairRuntimeDependencies;

  constructor(dependencies: SemanticRepairRuntimeDependencies) {
    this.dependencies = dependencies;
  }

  private reservationKey(cwd: string, taskRunId: string, toolCallId: string): string {
    return `${cwd}\u0000${taskRunId}\u0000${toolCallId}`;
  }

  resume(input: {
    cwd: string; task: TaskContract; sessionId: string; currentDigest: string;
  }): boolean {
    return semanticRepairResumeDecision({
      cwd: input.cwd,
      taskRunId: input.task.taskRunId,
      taskId: input.task.taskId,
      sessionId: input.sessionId,
      currentDigest: input.currentDigest
    }).openRepair;
  }

  prepare(input: {
    ctx: ExtensionContext; task: TaskContract; event: ToolEvent; currentDigest: string;
    currentDeltaPaths: string[]; targetPaths: string[]; verifierCurrent: boolean;
  }): boolean {
    const decision = decideSemanticRepairHandshake({
      cwd: input.ctx.cwd,
      task: input.task,
      mutationTargets: input.targetPaths,
      currentDeltaPaths: input.currentDeltaPaths,
      verifierCurrent: input.verifierCurrent
    });
    if (!decision.authorized) return false;
    const reserved = reserveSemanticRepairCall({
      cwd: input.ctx.cwd,
      task: input.task,
      sessionId: input.ctx.sessionManager.getSessionId(),
      toolCallId: String(input.event.toolCallId),
      toolName: input.event.toolName,
      currentDigest: input.currentDigest,
      decision,
      targetPaths: input.targetPaths,
      recordedAt: this.dependencies.now()
    });
    if (!reserved.reserved) return false;
    this.reservationTokens.set(
      this.reservationKey(input.ctx.cwd, input.task.taskRunId, String(input.event.toolCallId)),
      reserved.reservationToken!
    );
    this.dependencies.trace(input.ctx, input.task, {
      event: "semantic_contradiction_repair_reserved",
      workingTreeDigest: input.currentDigest,
      conflictCodes: decision.conflictCodes,
      eligiblePaths: decision.eligiblePaths,
      targetCount: input.targetPaths.length
    });
    return true;
  }

  prepareBoundedRecovery(input: {
    ctx: ExtensionContext; task: TaskContract; event: ToolEvent; currentDigest: string;
    currentDeltaPaths: string[]; observedChangedPaths: string[];
    authoredFileDigests: Record<string, string>; targetPaths: string[]; verifierCurrent: boolean;
  }): boolean {
    // This path is a one-shot CAP-12 bridge, not CAP-13's multi-revision
    // semantic-repair protocol. Any durable state, including a cancelled or
    // interrupted reservation, consumes the task-run grant and fails closed.
    if (readSemanticRepairState(input.ctx.cwd, input.task.taskRunId).status !== "missing"
      || semanticRepairStateRequired(input.ctx.cwd, input.task.taskRunId)) return false;
    const decision = decideBoundedRecoveryHandshake({
      task: input.task,
      mutationTargets: input.targetPaths,
      currentDeltaPaths: input.currentDeltaPaths,
      observedChangedPaths: input.observedChangedPaths,
      authoredFileDigests: input.authoredFileDigests,
      verifierCurrent: input.verifierCurrent
    });
    if (!decision.authorized) return false;
    const toolCallId = String(input.event.toolCallId);
    const reserved = reserveSemanticRepairCall({
      cwd: input.ctx.cwd,
      task: input.task,
      sessionId: input.ctx.sessionManager.getSessionId(),
      toolCallId,
      toolName: input.event.toolName,
      currentDigest: input.currentDigest,
      decision,
      targetPaths: input.targetPaths,
      recordedAt: this.dependencies.now()
    });
    if (!reserved.reserved) return false;
    this.reservationTokens.set(
      this.reservationKey(input.ctx.cwd, input.task.taskRunId, toolCallId),
      reserved.reservationToken!
    );
    this.dependencies.trace(input.ctx, input.task, {
      event: "bounded_recovery_repair_reserved",
      workingTreeDigest: input.currentDigest,
      reasonCode: BOUNDED_RECOVERY_CONFLICT_CODE,
      eligiblePaths: decision.eligiblePaths,
      targetCount: input.targetPaths.length
    });
    return true;
  }

  reservedCallMatches(input: {
    cwd: string; taskRunId: string; sessionId: string; toolCallId: string;
    toolName: string; currentDigest: string; targetPaths: string[];
  }): boolean {
    const reservationToken = this.reservationTokens.get(this.reservationKey(input.cwd, input.taskRunId, input.toolCallId));
    return Boolean(reservationToken && reservedSemanticRepairCallMatches({ ...input, reservationToken }));
  }

  authorize(input: Omit<Parameters<typeof authorizeSemanticRepairCall>[0], "reservationToken">): ReturnType<typeof authorizeSemanticRepairCall> {
    const key = this.reservationKey(input.cwd, input.task.taskRunId, input.toolCallId);
    const result = authorizeSemanticRepairCall({ ...input, reservationToken: this.reservationTokens.get(key) });
    if (result.handled) this.reservationTokens.delete(key);
    return result;
  }

  reject(input: Parameters<typeof rejectSemanticRepairCall>[0]): ReturnType<typeof rejectSemanticRepairCall> {
    this.reservationTokens.delete(this.reservationKey(input.cwd, input.taskRunId, input.toolCallId));
    return rejectSemanticRepairCall(input);
  }

  pending(cwd: string, taskRunId: string, toolCallId: string): ReturnType<typeof pendingSemanticRepairCall> {
    return pendingSemanticRepairCall(cwd, taskRunId, toolCallId);
  }

  completionBlock(cwd: string, taskRunId: string): string | undefined {
    const view = readSemanticRepairState(cwd, taskRunId);
    if (!view.enforcementSafe) return `semantic repair state is unavailable (${view.warnings[0] ?? "unknown corruption"})`;
    if (!view.state) return semanticRepairStateRequired(cwd, taskRunId) ? "required semantic repair state is missing" : undefined;
    if (view.state.successfulMutations > 0 && !semanticRepairOriginMatches(cwd, view.state)) return "semantic repair durable origin is missing or invalid";
    if (view.state.status === "passed") return;
    if (view.state.successfulMutations === 0 && view.state.pending === null && !semanticRepairStateRequired(cwd, taskRunId)) return;
    const label = view.state.conflictCodes.includes(BOUNDED_RECOVERY_CONFLICT_CODE) ? "bounded recovery" : "semantic repair";
    return `${label} exact final verifier is not satisfied (${view.state.status})`;
  }

  complete(
    ctx: ExtensionContext,
    task: TaskContract,
    event: ToolEvent,
    metadata: SemanticRepairCompletionMetadata
  ): TrajectorySyncResult | undefined {
    const completion = completeSemanticRepairCall({
      cwd: ctx.cwd,
      taskRunId: task.taskRunId,
      toolCallId: metadata.toolCallId,
      success: metadata.success,
      exitCode: metadata.exitCode,
      currentDigest: metadata.currentWorkingTreeDigest,
      changedPaths: metadata.changedPaths,
      authoredChangedPaths: metadata.authoredChangedPaths,
      retryableFailure: metadata.retryableFailure,
      correctiveFailure: metadata.correctiveFailure,
      recordedAt: this.dependencies.now()
    });
    if (completion.result === "unmatched") return;
    this.dependencies.trace(ctx, task, {
      event: completion.state?.conflictCodes.includes(BOUNDED_RECOVERY_CONFLICT_CODE)
        ? `bounded_recovery_repair_${completion.result}`
        : completion.result === "opened" ? "semantic_contradiction_repair_opened" : `semantic_repair_${completion.result}`,
      toolName: event.toolName,
      revision: completion.state?.revision,
      successfulMutations: completion.state?.successfulMutations,
      workingTreeDigest: metadata.currentWorkingTreeDigest
    });
    return ["opened", "retry", "correction"].includes(completion.result)
      ? this.dependencies.openRepair(ctx, task, this.dependencies.now())
      : undefined;
  }
}

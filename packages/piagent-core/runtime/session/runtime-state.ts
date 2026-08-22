import crypto from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRuntimeOwnedContextEvidenceEntry } from "../../extensions/context-evidence.js";
import { toolResultFingerprint } from "../../extensions/context-engine.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import type { TaskContract } from "../../extensions/guard-types.ts";
import type { RecoveryHistoryEntry } from "../recovery/recovery-policy.ts";
import type { ResumeState } from "../recovery/resume-state.ts";
import { ModelAuthorshipState } from "./model-authorship-state.ts";
import type { ModelMutationEvidenceCompletion, ModelMutationIdentity } from "./model-authorship-state.ts";
import type { ModelMutationProof } from "../quality/model-mutation-proof.ts";
import { PerformanceReviewState } from "./performance-review-state.ts";
import type {
  PerformanceReviewCheckpoint,
  PerformanceReviewCredit,
  PerformanceReviewToolCompletion,
  PerformanceReviewToolCompletionResult
} from "./performance-review-state.ts";
export {
  MAX_PERFORMANCE_MUTATIONS_PER_REVISION,
  MAX_PERFORMANCE_REPAIR_PATHS,
  MAX_PERFORMANCE_REPAIR_REVISIONS
} from "./performance-review-state.ts";
export type {
  PerformanceReviewCheckpoint,
  PerformanceReviewCredit,
  PerformanceReviewToolCompletion,
  PerformanceReviewToolCompletionResult,
  PerformanceReviewToolKind,
  PerformanceReviewVerifierState
} from "./performance-review-state.ts";

export type ObservedTaskContext = { path: string; reason: string };

export type InjectedContextPack = {
  queryHash: string;
  confidence: string;
  estimatedTokens: number;
  paths: string[];
};

export type ContextInjectionItem = {
  path: string;
  estimatedTokens: number;
  fileContentHash?: string;
  payloadHash?: string;
  representation?: string;
  ranges?: Array<{ start: number; end: number }>;
  generation?: number;
};

export type ContextInjectionTelemetry = {
  source: string;
  queryHash: string;
  confidence: string;
  estimatedTokens: number;
  selectedItems: ContextInjectionItem[];
};

export type PendingContextDelivery = {
  deliveryId: string;
  taskRunId: string;
  turnId?: string;
  entries: ObservedTaskContext[];
  pack?: InjectedContextPack & { retrievalKey: string };
  injection?: ContextInjectionTelemetry;
};

export type RuntimeTurn = { turnId: string; promptHash: string };

function evictOldest<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) map.delete(map.keys().next().value as K);
}

export class RuntimeSessionState {
  readonly #maxObservedContext: number;
  readonly #advisedTools = new Set<string>();
  readonly #seenToolResults = new Map<string, { outputHash: string; recordedAt: string }>();
  readonly #autoPackedPrompts = new Set<string>();
  readonly #injectedContextPacks = new Map<string, InjectedContextPack>();
  readonly #pendingContextDeliveries = new Map<string, PendingContextDelivery>();
  readonly #turnBySession = new Map<string, RuntimeTurn>();
  readonly #modelAuthorship = new ModelAuthorshipState();
  readonly #performanceReview = new PerformanceReviewState();
  readonly #recoveryHistoryByTask = new Map<string, RecoveryHistoryEntry[]>();
  readonly #resumeStateByTaskRun = new Map<string, ResumeState>();
  readonly #deliveredResumeContexts = new Set<string>();
  readonly #taskIdentityBySession = new Map<string, { taskId: string; taskRunId: string }>();
  readonly #observedContextBySession = new Map<string, Map<string, ObservedTaskContext>>();
  readonly #preTaskContextBySession = new Map<string, { turnId: string; entries: Map<string, ObservedTaskContext> }>();
  readonly #qualifiedContextEvidenceByTask = new Map<string, Map<string, ObservedTaskContext>>();
  readonly #shellMutationSnapshots = new Map<string, Record<string, string>>();

  constructor(options: { maxObservedContext: number }) {
    this.#maxObservedContext = options.maxObservedContext;
  }

  sessionKey(ctx: ExtensionContext): string {
    return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
  }

  cacheTaskIdentity(ctx: ExtensionContext, task: TaskContract | undefined): void {
    const key = this.sessionKey(ctx);
    if (task) this.#taskIdentityBySession.set(key, { taskId: task.taskId, taskRunId: task.taskRunId });
    else this.#taskIdentityBySession.delete(key);
    evictOldest(this.#taskIdentityBySession, 100);
  }

  taskIdentity(ctx: ExtensionContext): { taskId: string; taskRunId: string } | undefined {
    return this.#taskIdentityBySession.get(this.sessionKey(ctx));
  }

  beginTurn(ctx: ExtensionContext, promptHash: string): RuntimeTurn {
    const turn = { turnId: crypto.randomUUID(), promptHash };
    const sessionKey = this.sessionKey(ctx);
    this.#turnBySession.set(sessionKey, turn);
    this.#preTaskContextBySession.set(sessionKey, { turnId: turn.turnId, entries: new Map() });
    evictOldest(this.#turnBySession, 100);
    evictOldest(this.#preTaskContextBySession, 100);
    return { ...turn };
  }

  currentTurn(ctx: ExtensionContext, promptHash?: string): RuntimeTurn | undefined {
    const turn = this.#turnBySession.get(this.sessionKey(ctx));
    return turn && (!promptHash || turn.promptHash === promptHash) ? { ...turn } : undefined;
  }

  hasAdvisedTool(ctx: ExtensionContext, toolName: string): boolean {
    return this.#advisedTools.has(`${this.sessionKey(ctx)}\u0000${toolName}`);
  }

  rememberAdvisedTool(ctx: ExtensionContext, toolName: string): void {
    this.#advisedTools.add(`${this.sessionKey(ctx)}\u0000${toolName}`);
    while (this.#advisedTools.size > 500) {
      this.#advisedTools.delete(this.#advisedTools.values().next().value as string);
    }
  }

  rememberObservedContext(ctx: ExtensionContext, entry: ObservedTaskContext): void {
    const key = this.sessionKey(ctx);
    let observed = this.#observedContextBySession.get(key);
    if (!observed) {
      observed = new Map();
      this.#observedContextBySession.set(key, observed);
    }
    if (!observed.has(entry.path)) observed.set(entry.path, entry);
    evictOldest(observed, this.#maxObservedContext);
    evictOldest(this.#observedContextBySession, 100);
  }

  observedContext(ctx: ExtensionContext): ObservedTaskContext[] {
    return [...(this.#observedContextBySession.get(this.sessionKey(ctx))?.values() ?? [])];
  }

  rememberPreTaskContext(ctx: ExtensionContext, entry: ObservedTaskContext): void {
    const turn = this.currentTurn(ctx);
    const epoch = this.#preTaskContextBySession.get(this.sessionKey(ctx));
    if (!turn || !epoch || epoch.turnId !== turn.turnId || !isRuntimeOwnedContextEvidenceEntry(entry)) return;
    epoch.entries.set(entry.path, structuredClone(entry));
    evictOldest(epoch.entries, this.#maxObservedContext);
  }

  preTaskContext(ctx: ExtensionContext): ObservedTaskContext[] {
    const turn = this.currentTurn(ctx);
    const epoch = this.#preTaskContextBySession.get(this.sessionKey(ctx));
    if (!turn || !epoch || epoch.turnId !== turn.turnId) return [];
    return [...epoch.entries.values()].map((entry) => structuredClone(entry));
  }

  promotePreTaskContext(ctx: ExtensionContext, taskRunId: string, selected: ObservedTaskContext[]): void {
    const eligible = new Map(this.preTaskContext(ctx).map((entry) => [entry.path, entry]));
    for (const entry of selected) {
      const observed = eligible.get(entry.path);
      if (observed) this.rememberQualifiedContextEvidence(ctx, taskRunId, observed);
    }
    const epoch = this.#preTaskContextBySession.get(this.sessionKey(ctx));
    if (epoch) epoch.entries.clear();
  }

  qualifiedTaskContext(ctx: ExtensionContext): ObservedTaskContext[] {
    const taskRunId = this.taskIdentity(ctx)?.taskRunId;
    return taskRunId ? this.qualifiedContextEvidence(ctx, taskRunId) : [];
  }

  clearObservedContext(ctx: ExtensionContext): void {
    const sessionKey = this.sessionKey(ctx);
    this.#observedContextBySession.delete(sessionKey);
    this.#preTaskContextBySession.delete(sessionKey);
    const prefix = `${sessionKey}\u0000`;
    for (const key of this.#qualifiedContextEvidenceByTask.keys()) {
      if (key.startsWith(prefix)) this.#qualifiedContextEvidenceByTask.delete(key);
    }
  }

  rememberQualifiedContextEvidence(
    ctx: ExtensionContext,
    taskRunId: string,
    entry: ObservedTaskContext
  ): void {
    if (!taskRunId || !entry.path) return;
    const key = `${this.sessionKey(ctx)}\u0000${taskRunId}`;
    let evidence = this.#qualifiedContextEvidenceByTask.get(key);
    if (!evidence) {
      evidence = new Map();
      this.#qualifiedContextEvidenceByTask.set(key, evidence);
    }
    evidence.set(entry.path, structuredClone(entry));
    evictOldest(evidence, this.#maxObservedContext);
    evictOldest(this.#qualifiedContextEvidenceByTask, 100);
  }

  qualifiedContextEvidence(ctx: ExtensionContext, taskRunId: string): ObservedTaskContext[] {
    const key = `${this.sessionKey(ctx)}\u0000${taskRunId}`;
    return [...(this.#qualifiedContextEvidenceByTask.get(key)?.values() ?? [])].map((entry) => structuredClone(entry));
  }

  #shellMutationSnapshotKey(ctx: ExtensionContext, toolName: string, input: unknown): string {
    return `${this.sessionKey(ctx)}\u0000${toolResultFingerprint(toolName, input, []).key}`;
  }

  rememberShellMutationSnapshot(ctx: ExtensionContext, toolName: string, input: unknown): void {
    this.#shellMutationSnapshots.set(
      this.#shellMutationSnapshotKey(ctx, toolName, input),
      workingTreeSnapshot(ctx.cwd) as Record<string, string>
    );
    evictOldest(this.#shellMutationSnapshots, 100);
  }

  consumeShellMutationSnapshot(ctx: ExtensionContext, toolName: string, input: unknown): Record<string, string> | undefined {
    const key = this.#shellMutationSnapshotKey(ctx, toolName, input);
    const snapshot = this.#shellMutationSnapshots.get(key);
    this.#shellMutationSnapshots.delete(key);
    return snapshot;
  }

  clearShellMutationSnapshots(ctx: ExtensionContext): void {
    const prefix = `${this.sessionKey(ctx)}\u0000`;
    for (const key of this.#shellMutationSnapshots.keys()) {
      if (key.startsWith(prefix)) this.#shellMutationSnapshots.delete(key);
    }
  }

  hasAutoPackedPrompt(key: string): boolean {
    return this.#autoPackedPrompts.has(key);
  }

  rememberAutoPackedPrompt(key: string): void {
    this.#autoPackedPrompts.add(key);
    while (this.#autoPackedPrompts.size > 50) {
      this.#autoPackedPrompts.delete(this.#autoPackedPrompts.values().next().value as string);
    }
  }

  rememberInjectedContextPack(ctx: ExtensionContext, key: string, pack: InjectedContextPack): void {
    this.#injectedContextPacks.set(`${this.sessionKey(ctx)}\u0000${key}`, pack);
    evictOldest(this.#injectedContextPacks, 50);
  }

  injectedContextPack(ctx: ExtensionContext, key: string): InjectedContextPack | undefined {
    return this.#injectedContextPacks.get(`${this.sessionKey(ctx)}\u0000${key}`);
  }

  stageContextDelivery(ctx: ExtensionContext, delivery: PendingContextDelivery): void {
    this.#pendingContextDeliveries.set(`${this.sessionKey(ctx)}\u0000${delivery.deliveryId}`, structuredClone(delivery));
    evictOldest(this.#pendingContextDeliveries, 100);
  }

  takeContextDelivery(ctx: ExtensionContext, deliveryId: string): PendingContextDelivery | undefined {
    const key = `${this.sessionKey(ctx)}\u0000${deliveryId}`;
    const delivery = this.#pendingContextDeliveries.get(key);
    this.#pendingContextDeliveries.delete(key);
    return delivery ? structuredClone(delivery) : undefined;
  }

  performanceReviewCheckpoint(taskRunId: string): PerformanceReviewCheckpoint | undefined {
    return this.#performanceReview.checkpoint(taskRunId);
  }

  rememberPerformanceReviewCheckpoint(
    taskRunId: string,
    workingTreeDigest: string,
    attempt: number,
    expectedPaths: string[] = [],
    reviewedPaths: string[] = []
  ): void {
    this.#performanceReview.rememberCheckpoint(taskRunId, workingTreeDigest, attempt, expectedPaths, reviewedPaths);
  }

  rememberPerformanceReviewActivity(taskRunId: string, toolName = "read"): void {
    this.#performanceReview.rememberReadActivity(taskRunId, toolName);
  }

  reservePerformanceReviewTool(
    taskRunId: string,
    reservation: {
      toolCallId: string;
      kind: "inspection" | "mutation" | "verifier";
      toolName: string;
      workingTreeDigest: string;
      workingTreeSnapshot: Record<string, string>;
      targetPaths: string[];
    }
  ): boolean {
    return this.#performanceReview.reserveTool(taskRunId, reservation);
  }

  completePerformanceReviewTool(
    taskRunId: string,
    toolCallId: string,
    result: PerformanceReviewToolCompletion
  ): PerformanceReviewToolCompletionResult {
    const completion = this.#performanceReview.completeTool(taskRunId, toolCallId, result);
    if (["locked", "invalidated"].includes(completion)) this.#performanceReview.invalidateCredit(taskRunId);
    return completion;
  }

  invalidatePerformanceReviewCheckpoint(taskRunId: string): void {
    this.#performanceReview.invalidateCheckpoint(taskRunId);
  }

  denyPerformanceReviewTool(taskRunId: string): void {
    if (this.#performanceReview.denyTool(taskRunId)) this.#performanceReview.invalidateCredit(taskRunId);
  }

  clearPerformanceReview(taskRunId: string): void {
    this.#performanceReview.clearReview(taskRunId);
  }

  rememberPerformanceReviewCredit(taskRunId: string, credit: PerformanceReviewCredit): void {
    this.#performanceReview.rememberCredit(taskRunId, credit);
  }

  performanceReviewCredit(taskRunId: string, currentWorkingTreeDigest?: string): PerformanceReviewCredit | undefined {
    return this.#performanceReview.credit(taskRunId, currentWorkingTreeDigest);
  }

  invalidatePerformanceReviewCredit(taskRunId: string): boolean {
    return this.#performanceReview.invalidateCredit(taskRunId);
  }

  reserveAuthorizedModelMutation(
    identity: ModelMutationIdentity,
    toolCallId: string,
    workingTreeSnapshotBefore: Record<string, string>,
    targetPaths: string[],
    proof: ModelMutationProof
  ): boolean {
    return this.#modelAuthorship.reserve(identity, toolCallId, workingTreeSnapshotBefore, targetPaths, proof);
  }

  completeAuthorizedModelMutation(
    identity: ModelMutationIdentity,
    toolCallId: string,
    success: boolean,
    currentSnapshot: Record<string, string>,
    currentContentDigests: Record<string, string> = {}
  ): { changedPaths: string[]; recordedDigests: Record<string, string> } {
    return this.#modelAuthorship.complete(identity, toolCallId, success, currentSnapshot, currentContentDigests);
  }

  completeAuthorizedModelMutationEvidence(
    identity: ModelMutationIdentity,
    toolCallId: string,
    success: boolean,
    currentSnapshot: Record<string, string>,
    currentContentDigests: Record<string, string> = {}
  ): ModelMutationEvidenceCompletion {
    return this.#modelAuthorship.completeWithEvidence(identity, toolCallId, success, currentSnapshot, currentContentDigests);
  }

  successfulModelMutationDigests(identity: ModelMutationIdentity, currentSnapshot?: Record<string, string>): Record<string, string> {
    return this.#modelAuthorship.digests(identity, currentSnapshot);
  }

  invalidateSuccessfulModelMutationPaths(identity: ModelMutationIdentity, paths: string[]): void {
    this.#modelAuthorship.invalidate(identity, paths);
  }

  recoveryHistory(taskId: string): RecoveryHistoryEntry[] {
    return [...(this.#recoveryHistoryByTask.get(taskId) ?? [])];
  }

  rememberRecoveryHistory(entry: RecoveryHistoryEntry): void {
    const history = [...(this.#recoveryHistoryByTask.get(entry.taskId) ?? []), entry].slice(-20);
    this.#recoveryHistoryByTask.set(entry.taskId, history);
    evictOldest(this.#recoveryHistoryByTask, 100);
  }

  rememberResumeState(resume: ResumeState): void {
    this.#resumeStateByTaskRun.set(resume.taskRunId, structuredClone(resume));
    evictOldest(this.#resumeStateByTaskRun, 100);
  }

  resumeState(taskRunId: string): ResumeState | undefined {
    const state = this.#resumeStateByTaskRun.get(taskRunId);
    return state ? structuredClone(state) : undefined;
  }

  takeResumeContextState(ctx: ExtensionContext, taskRunId: string): ResumeState | undefined {
    const key = `${this.sessionKey(ctx)}\u0000${taskRunId}`;
    if (this.#deliveredResumeContexts.has(key)) return undefined;
    const resume = this.#resumeStateByTaskRun.get(taskRunId);
    if (!resume) return undefined;
    this.#deliveredResumeContexts.add(key);
    while (this.#deliveredResumeContexts.size > 200) {
      this.#deliveredResumeContexts.delete(this.#deliveredResumeContexts.values().next().value as string);
    }
    return structuredClone(resume);
  }

  taskResumeBlock(taskRunId: string): string | undefined {
    const resume = this.#resumeStateByTaskRun.get(taskRunId);
    return resume && !resume.enforcementSafe && resume.decision !== "terminal" ? resume.reason : undefined;
  }

  clearDigestMigrationState(ctx: ExtensionContext, taskRunId: string, taskId: string): void {
    this.#performanceReview.clearTask(taskRunId);
    this.#modelAuthorship.clear(taskRunId);
    this.#recoveryHistoryByTask.delete(taskId);
    this.#resumeStateByTaskRun.delete(taskRunId);
    this.#deliveredResumeContexts.delete(`${this.sessionKey(ctx)}\u0000${taskRunId}`);
    this.#qualifiedContextEvidenceByTask.delete(`${this.sessionKey(ctx)}\u0000${taskRunId}`);
    this.clearShellMutationSnapshots(ctx);
  }

  previousToolResult(
    ctx: ExtensionContext,
    fingerprintKey: string
  ): { outputHash: string; recordedAt: string } | undefined {
    return this.#seenToolResults.get(`${this.sessionKey(ctx)}\u0000${fingerprintKey}`);
  }

  rememberToolResult(
    ctx: ExtensionContext,
    fingerprintKey: string,
    value: { outputHash: string; recordedAt: string }
  ): void {
    this.#seenToolResults.set(`${this.sessionKey(ctx)}\u0000${fingerprintKey}`, value);
    evictOldest(this.#seenToolResults, 500);
  }

  clearSession(ctx: ExtensionContext): void {
    const sessionKey = this.sessionKey(ctx);
    const prefix = `${sessionKey}\u0000`;
    const taskIdentity = this.#taskIdentityBySession.get(sessionKey);
    this.#taskIdentityBySession.delete(sessionKey);
    this.#turnBySession.delete(sessionKey);
    this.#observedContextBySession.delete(sessionKey);
    this.#preTaskContextBySession.delete(sessionKey);
    this.clearShellMutationSnapshots(ctx);
    if (taskIdentity) {
      this.#performanceReview.clearTask(taskIdentity.taskRunId);
      this.#modelAuthorship.clear(taskIdentity.taskRunId);
    }
    for (const values of [this.#advisedTools, this.#autoPackedPrompts, this.#deliveredResumeContexts]) {
      for (const key of values) {
        if (key.startsWith(prefix)) values.delete(key);
      }
    }
    for (const values of [this.#seenToolResults, this.#injectedContextPacks, this.#pendingContextDeliveries, this.#qualifiedContextEvidenceByTask]) {
      for (const key of values.keys()) {
        if (key.startsWith(prefix)) values.delete(key);
      }
    }
  }
}

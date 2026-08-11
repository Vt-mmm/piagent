export const MAX_PERFORMANCE_REPAIR_REVISIONS = 2;
export const MAX_PERFORMANCE_MUTATIONS_PER_REVISION = 8;
export const MAX_PERFORMANCE_REPAIR_PATHS = 12;

export type PerformanceReviewVerifierState =
  | "not-required"
  | "required"
  | "passed"
  | "correction-required"
  | "retry-ready"
  | "locked";

export type PerformanceReviewToolKind = "inspection" | "mutation" | "verifier";

export type PerformanceReviewCheckpoint = {
  workingTreeDigest: string;
  attempt: number;
  activityObserved: boolean;
  reviewSatisfied: boolean;
  inspectionCalls: number;
  shellInspectionCalls: number;
  expectedPaths: string[];
  reviewedPaths: string[];
  mutationObserved: boolean;
  revision: number;
  successfulMutationCalls: number;
  successfulMutationsInRevision: number;
  mutatedPaths: string[];
  verifierCalls: number;
  verifierCallsInRevision: number;
  verifierState: PerformanceReviewVerifierState;
  transientRetryUsed: boolean;
  invalidated: boolean;
  pendingToolCallId?: string;
  pendingToolKind?: PerformanceReviewToolKind;
};

export type PerformanceReviewCredit = {
  workingTreeDigest: string;
  commandHash: string;
  reviewedPaths: string[];
  recordedAt: string;
};

type PerformanceReviewReservation = {
  toolCallId: string;
  kind: PerformanceReviewToolKind;
  toolName: string;
  workingTreeDigest: string;
  workingTreeSnapshot: Record<string, string>;
  targetPaths: string[];
  revision: number;
  verifierRetry: boolean;
};

export type PerformanceReviewToolCompletion = {
  success: boolean;
  postWorkingTreeDigest: string;
  postWorkingTreeSnapshot: Record<string, string>;
  exitCode?: number;
  failure?: {
    retryable?: boolean;
    sourceMutationPermission?: string;
    confidence?: string;
  };
};

export type PerformanceReviewToolCompletionResult =
  | "unmatched"
  | "ignored"
  | "recorded"
  | "passed"
  | "correction-opened"
  | "retry-opened"
  | "locked"
  | "invalidated";

function evictOldest<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) map.delete(map.keys().next().value as K);
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").trim()).filter(Boolean))].sort();
}

function exactPathSet(left: string[], right: string[]): boolean {
  const normalizedLeft = uniquePaths(left);
  const normalizedRight = uniquePaths(right);
  return normalizedLeft.length > 0
    && normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((file, index) => file === normalizedRight[index]);
}

function changedSnapshotPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  return uniquePaths([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file]));
}

export class PerformanceReviewState {
  readonly #checkpoints = new Map<string, PerformanceReviewCheckpoint>();
  readonly #credits = new Map<string, PerformanceReviewCredit>();
  readonly #reservations = new Map<string, PerformanceReviewReservation>();

  checkpoint(taskRunId: string): PerformanceReviewCheckpoint | undefined {
    const checkpoint = this.#checkpoints.get(taskRunId);
    return checkpoint ? {
      ...checkpoint,
      expectedPaths: [...checkpoint.expectedPaths],
      reviewedPaths: [...checkpoint.reviewedPaths],
      mutatedPaths: [...checkpoint.mutatedPaths]
    } : undefined;
  }

  rememberCheckpoint(
    taskRunId: string,
    workingTreeDigest: string,
    attempt: number,
    expectedPaths: string[] = [],
    reviewedPaths: string[] = []
  ): void {
    const expected = uniquePaths(expectedPaths);
    const reviewed = uniquePaths(reviewedPaths);
    this.#checkpoints.set(taskRunId, {
      workingTreeDigest,
      attempt,
      activityObserved: false,
      reviewSatisfied: exactPathSet(expected, reviewed),
      inspectionCalls: 0,
      shellInspectionCalls: 0,
      expectedPaths: expected,
      reviewedPaths: reviewed,
      mutationObserved: false,
      revision: 0,
      successfulMutationCalls: 0,
      successfulMutationsInRevision: 0,
      mutatedPaths: [],
      verifierCalls: 0,
      verifierCallsInRevision: 0,
      verifierState: "not-required",
      transientRetryUsed: false,
      invalidated: false
    });
    evictOldest(this.#checkpoints, 100);
  }

  rememberReadActivity(taskRunId: string, toolName = "read"): void {
    const checkpoint = this.#checkpoints.get(taskRunId);
    if (!checkpoint || !["read", "grep", "find", "ls"].includes(String(toolName).toLowerCase())) return;
    checkpoint.activityObserved = true;
    checkpoint.inspectionCalls += 1;
  }

  #key(taskRunId: string, toolCallId: string): string {
    return `${taskRunId}\u0000${toolCallId}`;
  }

  reserveTool(taskRunId: string, reservation: Omit<PerformanceReviewReservation, "revision" | "verifierRetry">): boolean {
    const checkpoint = this.#checkpoints.get(taskRunId);
    if (!checkpoint || checkpoint.invalidated || checkpoint.pendingToolCallId || checkpoint.workingTreeDigest !== reservation.workingTreeDigest) return false;
    const key = this.#key(taskRunId, reservation.toolCallId);
    if (this.#reservations.has(key)) return false;
    this.#reservations.set(key, {
      ...reservation,
      workingTreeSnapshot: { ...reservation.workingTreeSnapshot },
      targetPaths: uniquePaths(reservation.targetPaths),
      revision: checkpoint.revision,
      verifierRetry: reservation.kind === "verifier" && checkpoint.verifierState === "retry-ready"
    });
    checkpoint.pendingToolCallId = reservation.toolCallId;
    checkpoint.pendingToolKind = reservation.kind;
    evictOldest(this.#reservations, 200);
    return true;
  }

  completeTool(taskRunId: string, toolCallId: string, result: PerformanceReviewToolCompletion): PerformanceReviewToolCompletionResult {
    const key = this.#key(taskRunId, toolCallId);
    const reservation = this.#reservations.get(key);
    this.#reservations.delete(key);
    const checkpoint = this.#checkpoints.get(taskRunId);
    if (!reservation || !checkpoint) return "unmatched";
    if (checkpoint.pendingToolCallId === toolCallId) {
      delete checkpoint.pendingToolCallId;
      delete checkpoint.pendingToolKind;
    }
    const changedPaths = changedSnapshotPaths(reservation.workingTreeSnapshot, result.postWorkingTreeSnapshot);
    const treeChanged = result.postWorkingTreeDigest !== reservation.workingTreeDigest;
    if (checkpoint.invalidated || checkpoint.workingTreeDigest !== reservation.workingTreeDigest || checkpoint.revision !== reservation.revision) {
      return this.#invalidate(checkpoint);
    }
    if (reservation.kind === "inspection") return this.#completeInspection(checkpoint, reservation, result.success, treeChanged);
    if (reservation.kind === "mutation") return this.#completeMutation(checkpoint, reservation, result, changedPaths, treeChanged);
    return this.#completeVerifier(checkpoint, reservation, result, treeChanged);
  }

  #completeInspection(checkpoint: PerformanceReviewCheckpoint, reservation: PerformanceReviewReservation, success: boolean, treeChanged: boolean): PerformanceReviewToolCompletionResult {
    if (!success) return treeChanged ? this.#invalidate(checkpoint) : this.#lock(checkpoint);
    if (treeChanged) return this.#invalidate(checkpoint);
    checkpoint.activityObserved = true;
    if (["bash", "shell", "exec", "exec_command"].includes(reservation.toolName.toLowerCase())) checkpoint.shellInspectionCalls += 1;
    else checkpoint.inspectionCalls += 1;
    return "recorded";
  }

  #completeMutation(
    checkpoint: PerformanceReviewCheckpoint,
    reservation: PerformanceReviewReservation,
    result: PerformanceReviewToolCompletion,
    changedPaths: string[],
    treeChanged: boolean
  ): PerformanceReviewToolCompletionResult {
    if (!result.success) return treeChanged ? this.#invalidate(checkpoint) : this.#lock(checkpoint);
    if (!treeChanged) return this.#lock(checkpoint);
    if (
      changedPaths.length === 0
      || changedPaths.some((file) => !reservation.targetPaths.includes(file))
      || changedPaths.some((file) => !checkpoint.reviewedPaths.includes(file))
    ) return this.#invalidate(checkpoint);
    const nextRevision = checkpoint.revision === 0 ? 1 : checkpoint.revision;
    const nextMutationCalls = checkpoint.successfulMutationsInRevision + 1;
    const nextMutatedPaths = uniquePaths([...checkpoint.mutatedPaths, ...changedPaths]);
    if (
      nextRevision > MAX_PERFORMANCE_REPAIR_REVISIONS
      || nextMutationCalls > MAX_PERFORMANCE_MUTATIONS_PER_REVISION
      || nextMutatedPaths.length > MAX_PERFORMANCE_REPAIR_PATHS
    ) {
      checkpoint.verifierState = "locked";
      checkpoint.reviewSatisfied = false;
      return "locked";
    }
    checkpoint.workingTreeDigest = result.postWorkingTreeDigest;
    checkpoint.activityObserved = true;
    checkpoint.reviewSatisfied = false;
    checkpoint.mutationObserved = true;
    checkpoint.revision = nextRevision;
    checkpoint.successfulMutationCalls += 1;
    checkpoint.successfulMutationsInRevision = nextMutationCalls;
    checkpoint.mutatedPaths = nextMutatedPaths;
    checkpoint.verifierState = "required";
    return "recorded";
  }

  #completeVerifier(
    checkpoint: PerformanceReviewCheckpoint,
    reservation: PerformanceReviewReservation,
    result: PerformanceReviewToolCompletion,
    treeChanged: boolean
  ): PerformanceReviewToolCompletionResult {
    if (treeChanged) return this.#invalidate(checkpoint);
    checkpoint.activityObserved = true;
    checkpoint.verifierCalls += 1;
    checkpoint.verifierCallsInRevision += 1;
    if (reservation.verifierRetry) checkpoint.transientRetryUsed = true;
    if (result.success && (result.exitCode === undefined || result.exitCode === 0)) {
      checkpoint.verifierState = "passed";
      checkpoint.reviewSatisfied = exactPathSet(checkpoint.expectedPaths, checkpoint.reviewedPaths);
      return "passed";
    }
    checkpoint.reviewSatisfied = false;
    if (result.failure?.retryable === true && !checkpoint.transientRetryUsed) {
      checkpoint.verifierState = "retry-ready";
      return "retry-opened";
    }
    const correctionEligible = result.failure?.sourceMutationPermission === "eligible-in-scope" && result.failure?.confidence === "high";
    if (correctionEligible && checkpoint.revision < MAX_PERFORMANCE_REPAIR_REVISIONS) {
      checkpoint.revision += 1;
      checkpoint.successfulMutationsInRevision = 0;
      checkpoint.verifierCallsInRevision = 0;
      checkpoint.verifierState = "correction-required";
      return "correction-opened";
    }
    checkpoint.verifierState = "locked";
    return "locked";
  }

  #invalidate(checkpoint: PerformanceReviewCheckpoint): "invalidated" {
    checkpoint.invalidated = true;
    checkpoint.reviewSatisfied = false;
    return "invalidated";
  }

  #lock(checkpoint: PerformanceReviewCheckpoint): "locked" {
    checkpoint.activityObserved = true;
    checkpoint.reviewSatisfied = false;
    checkpoint.verifierState = "locked";
    return "locked";
  }

  invalidateCheckpoint(taskRunId: string): void {
    const checkpoint = this.#checkpoints.get(taskRunId);
    if (checkpoint) this.#invalidate(checkpoint);
  }

  denyTool(taskRunId: string): boolean {
    const checkpoint = this.#checkpoints.get(taskRunId);
    if (!checkpoint) return false;
    checkpoint.activityObserved = true;
    checkpoint.verifierState = "locked";
    this.#invalidate(checkpoint);
    return true;
  }

  rememberCredit(taskRunId: string, credit: PerformanceReviewCredit): void {
    this.#credits.set(taskRunId, { ...credit, reviewedPaths: [...credit.reviewedPaths] });
    const checkpoint = this.#checkpoints.get(taskRunId);
    if (checkpoint && checkpoint.workingTreeDigest === credit.workingTreeDigest && !checkpoint.invalidated) {
      checkpoint.activityObserved = true;
      checkpoint.reviewSatisfied = exactPathSet(checkpoint.expectedPaths, credit.reviewedPaths);
      checkpoint.shellInspectionCalls = Math.max(1, checkpoint.shellInspectionCalls);
      checkpoint.reviewedPaths = uniquePaths(credit.reviewedPaths);
    }
    evictOldest(this.#credits, 100);
  }

  credit(taskRunId: string, currentWorkingTreeDigest?: string): PerformanceReviewCredit | undefined {
    const credit = this.#credits.get(taskRunId);
    if (!credit) return undefined;
    if (currentWorkingTreeDigest !== undefined && credit.workingTreeDigest !== currentWorkingTreeDigest) {
      this.#credits.delete(taskRunId);
      return undefined;
    }
    return { ...credit, reviewedPaths: [...credit.reviewedPaths] };
  }

  invalidateCredit(taskRunId: string): boolean {
    return this.#credits.delete(taskRunId);
  }

  clearReview(taskRunId: string): void {
    this.#checkpoints.delete(taskRunId);
    this.#credits.delete(taskRunId);
    const prefix = `${taskRunId}\u0000`;
    for (const key of this.#reservations.keys()) {
      if (key.startsWith(prefix)) this.#reservations.delete(key);
    }
  }

  clearTask(taskRunId: string): void {
    this.clearReview(taskRunId);
  }
}

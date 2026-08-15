/* Generated from schemas/piagent-webui/release-monitor-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedBenchmarkAndReleaseMonitorV1 = {
  identity?: {
    agentOperationId?: null;
    toolCallId?: null;
    [k: string]: any;
  };
  [k: string]: any;
} & {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-release-monitor-v1";
  generatedAt: string;
  identity: Identity;
  state: "ready" | "unavailable";
  monitorRevision: string | null;
  benchmark: Benchmark;
  release: Release;
  actions: Actions;
  health: Health;
};
export type Identity = {
  [k: string]: any;
} & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: string | null;
};
export type Benchmark = {
  [k: string]: any;
} & {
  state: "ready" | "missing" | "unavailable";
  /**
   * @maxItems 20
   */
  runs:
    | []
    | [Run]
    | [Run, Run]
    | [Run, Run, Run]
    | [Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run]
    | [Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run, Run];
  /**
   * @maxItems 8
   */
  warnings:
    | []
    | [Warning]
    | [Warning, Warning]
    | [Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning, Warning, Warning];
  page: Page;
};
export type Run = {
  [k: string]: any;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
} & {
  runRef: string;
  suiteId: string;
  lifecycle: "completed" | "paused" | "interrupted" | "stopped" | "aborted" | "in-progress" | "incomplete";
  evidenceState: "complete" | "partial";
  sourceState: "current" | "stale";
  startedAt: string;
  updatedAt: string;
  completedRuns: number;
  expectedRuns: number;
  verdict: string | null;
  releaseGate: "passed" | "failed" | "not-applicable" | "unknown";
  tokenClaimAllowed: boolean | null;
  claimTier: "smoke" | "public-regression" | "capability" | "private-holdout" | "production-shadow" | "unknown";
  scores: Scores;
};
export type NullableScore = number | null;
export type Release = {
  [k: string]: any;
} & {
  state: "ready" | "stale" | "missing" | "unavailable";
  reportRef: string | null;
  generatedAt: string | null;
  sourceState: "current" | "stale" | "unknown";
  localSafeGate: "passed" | "failed" | "unknown";
  rcAssembly: string;
  beta: string;
  gaRelease: string;
  blockerCount: number;
  /**
   * @maxItems 8
   */
  blockers:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  authorization: ReleaseAuthorization;
};
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};

export interface Scores {
  quality: NullableScore;
  safety: NullableScore;
  reliability: NullableScore;
  workflow: NullableScore;
  efficiency: NullableScore;
  overall: NullableScore;
}
export interface Warning {
  code: "benchmark-evidence-corrupt" | "benchmark-directory-truncated";
  count: number;
  message: string;
}
export interface Page {
  total: number;
  returned: number;
  truncated: boolean;
}
export interface ReleaseAuthorization {
  releaseCommit: false;
  tag: false;
  publish: false;
  push: false;
}
export interface Actions {
  runBenchmark: false;
  resumeBenchmark: false;
  releaseCommit: false;
  tag: false;
  publish: false;
  push: false;
}

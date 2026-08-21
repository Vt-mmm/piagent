// Shared shapes for the guard and its domain modules.
// Types only: no runtime values, so importing this cannot introduce a cycle.

import type { TaskAuthoritySnapshot } from "../capabilities/authority-manifest.ts";

export type ProjectProfile = {
  schemaVersion?: number;
  projectId?: string;
  displayName?: string;
  mode?: string;
  authorityProfile?: "broad-default" | "mechanical-only" | "strict-high-risk";
  permissionProfile?: PermissionProfileMode;
  protectedPaths?: string[];
  shellProtectedPaths?: string[];
  readOnlyPaths?: string[];
  additionalReadRoots?: string[];
  requiredContext?: string[];
  verifyCommands?: Record<string, string[]>;
  mcpCapabilities?: string[];
  capabilityPacks?: Array<{ name: string; version: string }>;
  capabilityPolicy?: {
    allowedOwners?: string[];
    allowedLifecycles?: Array<"experimental" | "stable" | "deprecated">;
    allowedFilesystemRead?: string[];
    allowedFilesystemWrite?: string[];
    allowedNetworkDomains?: string[];
    allowedExternalActions?: string[];
  };
  memory?: MemorySettings;
  contextIndex?: ContextIndexSettings;
  runtimePolicy?: RuntimePolicySettings;
  orchestration?: OrchestrationPolicySettings;
  techStack?: ProjectTechStackReference;
};

export type MemorySettings = {
  enabled?: boolean;
  mode?: "off" | "manual" | "assisted" | "external-package";
  scope?: "project" | "global" | "hybrid";
  summaryFile?: string;
  handbookFile?: string;
  localDir?: string;
  readBeforeTask?: boolean;
  writePolicy?: "explicit-only" | "task-trace" | "session-summary";
  maxInjectedChars?: number;
  externalPackages?: string[];
};

export type RuntimePolicySettings = {
  execPolicy?: "off" | "advisory" | "enforce";
  contextBudget?: "off" | "advisory" | "enforce";
  toolRegistry?: "off" | "advisory" | "enforce";
  finalGate?: "off" | "advisory" | "enforce";
};

export type ContextIndexSettings = {
  enabled?: boolean;
  path?: string;
  writePolicy?: "onboarding-record" | "approved-workflow" | "off";
  requireCitations?: boolean;
  maxNodes?: number;
  maxEdges?: number;
  includeTechStack?: boolean;
  includeMemoryPointers?: boolean;
};

export type ContextIndexNodeKind = "profile" | "tech" | "module" | "command" | "doc" | "decision" | "risk" | "memory" | "task" | "verify" | "context";

export type ContextIndexEdgeKind = "uses_tech" | "depends_on" | "verified_by" | "protected_by" | "documented_by" | "derived_from" | "updates" | "relates_to";

export type ContextIndexCitation = {
  path?: string;
  reason?: string;
  url?: string;
};

export type ContextIndexNode = {
  id: string;
  kind: ContextIndexNodeKind;
  label: string;
  summary?: string;
  path?: string;
  tags?: string[];
  citations?: ContextIndexCitation[];
  updatedAt?: string;
};

export type ContextIndexEdge = {
  from: string;
  to: string;
  kind: ContextIndexEdgeKind;
  reason?: string;
};

export type ProjectContextIndex = {
  schemaVersion: 1;
  projectId?: string;
  profileMode?: string;
  source: "onboarding-record" | "approved-workflow" | "manual";
  summary: string;
  generatedAt: string;
  updatedAt: string;
  policy: Required<ContextIndexSettings>;
  nodes: ContextIndexNode[];
  edges: ContextIndexEdge[];
  citations: ContextIndexCitation[];
  warnings: string[];
};

export type TechRole = "frontend" | "backend" | "database" | "mobile" | "devops" | "data" | "docs" | "runtime";

export type ProjectTechStackReference = {
  provider?: "context7";
  manifest?: string;
  contextDir?: string;
  roles?: Partial<Record<TechRole, string[]>>;
  updatedAt?: string;
};

export type TechOption = {
  id: string;
  label: string;
  role: TechRole;
  description: string;
  context7Query?: string;
  topics: string[];
};

export type TechStackEntry = {
  id: string;
  label: string;
  role: TechRole;
  description: string;
  context7: {
    provider: "context7";
    query: string;
    status: "pending" | "recorded";
    contextFile: string;
    resolvedLibraryId?: string;
    retrievedAt?: string;
    digest?: string;
  };
  topics: string[];
};

export type TechStackManifest = {
  schemaVersion: 1;
  provider: "context7";
  profile: string;
  roles: Partial<Record<TechRole, string[]>>;
  selected: TechStackEntry[];
  skippedRoles?: TechRole[];
  contextDir: string;
  createdAt: string;
  updatedAt: string;
};

export type TechContextSnapshot = {
  schemaVersion: 1;
  provider: "context7";
  status: "pending" | "recorded";
  techId: string;
  role: TechRole;
  query: string;
  resolvedLibraryId?: string;
  topics?: string[];
  retrievedAt?: string;
  summary?: string;
  keyRules: string[];
  citations: Array<{ title?: string; url?: string; source?: string }>;
  digest?: string;
};

export type OrchestrationMode = "solo-first" | "bounded-subagents" | "parallel-readonly";

export type ReviewLens = "correctness" | "tests" | "scope" | "security" | "docs" | "release" | "package";

export type OrchestrationRole = "parent" | "piagent-scout" | "piagent-planner" | "piagent-worker" | "piagent-reviewer" | "piagent-oracle";

export type WorkPlanStep = {
  id: string;
  title: string;
  role: OrchestrationRole;
  mode: "read-only" | "single-writer" | "review";
  status: "pending" | "in-progress" | "done" | "skipped" | "failed";
  dependsOn?: string[];
  note?: string;
  updatedAt?: string;
};

export type CriterionGraphNode = {
  id: string;
  criterionIndex: number;
  obligation: string;
  kind: "behavior" | "boundary" | "output" | "scope" | "verification" | "investigation";
  proofKinds: Array<"behavioral-check" | "exact-verifier" | "read-evidence" | "scoped-diff">;
  targetHints: string[];
  dependsOn: string[];
};

export type CriterionGraph = {
  schemaVersion: 1;
  compiler: "criterion-graph-v1";
  mode: "mechanical" | "criterion-graph";
  criterionDigest: string;
  graphDigest: string;
  createdAt: string;
  nodes: CriterionGraphNode[];
  order: string[];
};

export type AcceptanceReceipt = {
  schemaVersion: 1;
  source: "model" | "runtime";
  promptHash?: string;
  generatedAt?: string;
  provenance?: {
    assurance: "runtime-observed";
    disposition: "first-pass-success" | "repaired-success" | "blocked" | "partial" | "failed" | "pending";
    repairCount: number;
    retryCount: number;
    finalRecoveryDisposition: "not-needed" | "succeeded" | "blocked" | "partial" | "failed" | "pending";
    failureRef: {
      evidenceDigest: string;
      category: "passed" | "compile-typecheck" | "test-assertion" | "lint-format" | "dependency-config" | "environment" | "provider-network" | "permission-policy" | "scope-protected-path" | "flaky-infrastructure" | "unknown";
      captureRef: string | null;
    } | null;
    recoveryRef: {
      policyVersion: "recovery-v1";
      action: "repair" | "retry" | "fresh-session" | "ask-operator" | "handoff" | "blocked";
      reasonCodes: string[];
    } | null;
    handoffRef: string | null;
    recordedAt: string;
  };
  helperUsage?: {
    mode: "off" | "recommend" | "on";
    used: boolean;
    reasonCodes: string[];
    helpers: Array<{
      role: "retriever" | "scout" | "planner" | "worker" | "reviewer" | "oracle" | "researcher";
      disposition: string;
      requestRef: string;
      outputDigest: string | null;
      calls: number;
      tokens: number;
    }>;
    recordedAt: string;
  };
  criteria: Array<{
    id: string;
    hash: string;
    obligation: string;
    priority: "normal" | "critical";
    status: "pending" | "satisfied" | "blocked";
    evidence: Array<{
      kind: string;
      summary: string;
      paths?: string[];
      command?: string;
      exitCode?: number;
      workingTreeDigest?: string;
      recordedAt?: string;
    }>;
    updatedAt?: string;
  }>;
};

export type TaskAttemptSummary = {
  taskRunId: string;
  attempt: number;
  outcome: "pending" | "completed" | "blocked" | "partial" | "failed";
  failedAt?: "research" | "plan" | "execute" | "verify" | "review";
  reason?: string;
  ruledOut?: string;
  recordedAt: string;
};

export type WorkingTreeDigestAlgorithm = "wt-content-v2" | "legacy-untrusted";
export type WorkingTreeDigestMigration = {
  status: "verification-refresh-required" | "refreshed" | "new-attempt-required" | "historical-unverifiable";
  source: "legacy-unversioned";
  reasonCode: string;
  requiredAction: "rerun-exact-verifier" | "none" | "start-new-attempt" | "historical-only";
  archivePath: string;
  archiveDigest: string;
  archiveBytes: number;
  baselineEvidenceDigest: string;
  finalEvidenceDigest: string;
  recordedAt: string;
  refreshedAt?: string;
};

export type OrchestrationPolicySettings = {
  defaultMode?: OrchestrationMode;
  maxConcurrentSubagents?: number;
  defaultReviewLenses?: ReviewLens[];
  roleModelGuidance?: Partial<Record<"planner" | "worker" | "reviewer" | "watchdog", string>>;
  fieldGuide?: {
    enabled?: boolean;
    path?: string;
    maxLines?: number;
    writePolicy?: "explicit-only" | "approved-workflow";
    readBeforeTask?: boolean;
  };
};

export type ResolvedOrchestrationPolicy = {
  defaultMode: OrchestrationMode;
  maxConcurrentSubagents: number;
  defaultReviewLenses: ReviewLens[];
  roleModelGuidance: Record<"planner" | "worker" | "reviewer" | "watchdog", string>;
  fieldGuide: {
    enabled: boolean;
    path: string;
    maxLines: number;
    writePolicy: "explicit-only" | "approved-workflow";
    readBeforeTask: boolean;
  };
  rules: string[];
};

export type PermissionProfileMode = "read-only" | "workspace-write" | "trusted-full-access";

export type PermissionProfilesConfig = {
  defaultMode?: PermissionProfileMode;
  allowedModes?: PermissionProfileMode[];
};

export type ResolvedPermissionProfile = {
  mode: PermissionProfileMode;
  source: "env" | "command" | "profile" | "default" | "invalid-env" | "invalid-profile" | "policy-fallback";
  requested?: string;
  warning?: string;
  runtimeEquivalent: string;
};

export type ProfileOption = {
  name: string;
  displayName?: string;
  mode?: string;
  description: string;
  recommended: boolean;
  reason: string;
};

export type ProjectOnboardingSnapshot = {
  schemaVersion: 1;
  projectId?: string;
  profileMode?: string;
  contextFile: string;
  summary: string;
  model?: string;
  sourceFiles: Array<{ path: string; reason: string }>;
  updateTriggers: string[];
  notes?: string;
  recordedAt: string;
};

export type TaskContract = {
  schemaVersion: 2;
  taskRunId: string;
  taskId: string;
  sessionId: string;
  sessionName?: string;
  changeMode: "source-change" | "read-only";
  attempt: number;
  maxAttempts: number;
  previousAttempts: TaskAttemptSummary[];
  summary: string;
  riskLane: "tiny" | "normal" | "high-risk";
  intakeMode?: "model" | "runtime";
  expectedOutput: string;
  acceptanceCriteria: string[];
  criterionGraph?: CriterionGraph;
  scope: string[];
  outOfScope: string[];
  protectedPaths: string[];
  requiredContext: string[];
  contextManifest: Array<{ path: string; reason: string }>;
  memoryCitations: Array<{ path: string; reason: string }>;
  mcpCapabilities: string[];
  verifyGroup?: string;
  verifyCommands: string[];
  workPlan: WorkPlanStep[];
  reviewLenses: ReviewLens[];
  acceptanceReceipt?: AcceptanceReceipt;
  authoritySnapshot?: TaskAuthoritySnapshot;
  workingTreeDigestAlgorithm: WorkingTreeDigestAlgorithm;
  workingTreeDigestMigration?: WorkingTreeDigestMigration;
  orchestration?: {
    mode: OrchestrationMode;
    subagents: "not-used" | "optional" | "used";
    reason: string;
    fieldGuidePath?: string;
    modelRoles?: Record<"planner" | "worker" | "reviewer" | "watchdog", string>;
  };
  baselineChangedFiles: string[];
  baselineFileDigests: Record<string, string>;
  observedChangedFiles: string[];
  finalWorkingTreeFiles: string[];
  finalFileDigests: Record<string, string>;
  changedFiles: string[];
  verifyEvidence: Array<{
    command: string;
    exitCode: number;
    summary: string;
    recordedAt: string;
    observed?: boolean;
    observedAt?: string;
    isError?: boolean;
    matchedProfileCommand?: boolean;
    preWorkingTreeDigest?: string;
    workingTreeDigest?: string;
  }>;
  trace: {
    outcome: "pending" | "completed" | "blocked" | "partial" | "failed";
    friction?: string;
    notes?: string;
    recordedAt?: string;
  };
  failedAt?: "research" | "plan" | "execute" | "verify" | "review";
  failureReason?: string;
  ruledOut?: string;
  migratedFromSchemaVersion?: number;
  createdAt: string;
  updatedAt: string;
};

export type BasePolicy = {
  protectedPaths: string[];
  shellProtectedPaths?: string[];
  blockedCommandPatterns: string[];
  requireConfirmationPatterns: string[];
  defaultRequiredContext: string[];
  permissionProfiles?: PermissionProfilesConfig;
  execPolicy?: ExecPolicyConfig;
  contextBudget?: ContextBudgetConfig;
  toolRegistry?: ToolRegistryConfig;
  finalGate?: FinalGateConfig;
  externalActionPolicy?: ExternalActionPolicyConfig;
  orchestrationPolicy?: OrchestrationPolicySettings;
};

export type CommandRule = {
  id: string;
  action: "allow" | "prompt" | "forbid";
  match: "prefix" | "contains" | "regex";
  ignoreSearchArguments?: boolean;
  value: string | string[];
  reason: string;
};

export type ExecPolicyConfig = {
  defaultMode?: "advisory" | "enforce";
  bannedPrefixSuggestions?: string[][];
  rules?: CommandRule[];
};

export type ContextBudgetConfig = {
  defaultMode?: "advisory" | "enforce";
  maxContextFileChars?: number;
  maxMemoryFileChars?: number;
  maxManifestFiles?: number;
  warnFragmentChars?: number;
};

export type ToolRegistryConfig = {
  defaultMode?: "advisory" | "enforce";
  alwaysAllowedTools?: string[];
  toolCapabilities?: Record<string, string[]>;
};

export type ExternalActionPolicyConfig = {
  defaultMode?: "advisory" | "enforce";
  providerKeywords?: string[];
  writeVerbs?: string[];
  safeVerbs?: string[];
};

export type FinalGateConfig = {
  defaultMode?: "advisory" | "enforce";
  requireTaskContract?: boolean;
  requireContextManifest?: boolean;
  requireVerifyEvidence?: boolean;
  requireTrace?: boolean;
  requirePassingVerify?: boolean;
};

export type EffectiveProtectedPaths = {
  readProtectedPaths: string[];
  writeProtectedPaths: string[];
  shellProtectedPaths: string[];
  readOnlyPaths: string[];
};

export type ReferenceRepo = {
  host: string;
  owner: string;
  repo: string;
  cloneUrl: string;
  checkoutPath: string;
  commit?: string;
  fetched: boolean;
};

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  evaluateExecPolicyCore, extractShellGlobCandidates, extractShellPathCandidates, findProtectedPathInCommand, unresolvedPathExpansions,
  globMatchesPath, matchesProtectedPath, normalizePathCandidate, matchesAnyPath
} from "./policy-core.js";
import {
  expandSimpleGlobAlternatives, findResolvedProtectedPathInCommand, normalizeRelative, protectedPatternExamples,
  resolveRepositoryPathCandidate, shellGlobMatchesPath, shellGlobSegmentMatches, shellGlobTargetsProtectedPath,
  unresolvedExpansionReason
} from "./shell-reach.ts";
import { extractShellWritePathCandidates, shellHasFileWriteRedirection } from "./shell-write-targets.js";
import { commandMatchesVerifyPlan, createBashResultLedger, findMatchingObservedBashResult, readObservedBashResults } from "./runtime-evidence.js";
import { findPackageRoot, findPlatformRoot, readJsonFile } from "./guard-io.js";
import {
  DOCUMENT_EXTENSIONS,
  extractDocument,
  resolveDocumentPath,
  resolveDocumentRoots
} from "./document-intake.ts";
import {
  redactForStorage,
  redactSensitiveText
} from "./redaction-core.js";
import { detectProfileName } from "./project-shape.js";
import { evaluateUpdateCheck, isInstalledPlatform, readUpdateCache, startUpdateProbe } from "./update-check.js";
import {
  REPOSITORY_SCOPES,
  collectServers,
  configPathForScope,
  mcpDecisionInputs,
  unverifiableMcpConfig
} from "../mcp/mcp-config-layers.js";
import { attributeDirectTool } from "../mcp/mcp-tool-naming.js";
import { approvalState } from "../mcp/mcp-approval-store.js";
import { evaluateServerReadiness, readinessNotice } from "../mcp/mcp-auth-readiness.js";
import * as mcpActions from "../mcp/mcp-command-actions.js";
import { buildExtendingProfile, resolveProjectProfileDocument } from "../capabilities/project-profile.js";
import {
  resolveCapabilityProfileDocument,
  writeJsonAtomic,
  writeProfileLockAtomic
} from "../capabilities/capability-core.js";
import {
  createCapabilityVerificationCache,
  verifyProjectCapabilityStateCached
} from "../capabilities/capability-verification-cache.js";
import { resolveCapabilitySourceRoots } from "../capabilities/capability-sources.js";
import {
  actionTextMatchesAny, actionTokens, classifyActionTokenSequence, classifyExplicitActionValues, classifyToolNameAction,
  externalExecutableIndex, extractShellCommandInput, findShellExternalConfirmationReason, normalizeActionToken, normalizeShellCommandForPolicy
} from "./guard-shell-analysis.ts";
import {
  appendContextTelemetry, buildContextEfficiencyReport, buildContextIndexV2, buildContextPack, buildTestImpact, classifyContextTask,
  contextIndexV2Status, ensureContextIndexV2, estimateContextTokens, readContextTelemetry, searchContextIndexV2
} from "./context-engine.js";
import {
  contextIndexExcludePatterns,
  effectiveProtectedPaths
} from "./context-index-policy.js";
import {
  DEFAULT_MAX_TASK_ATTEMPTS, activeSessionTask, bindSessionTask, createTaskRunId, hasGitEvidenceRoot, listTaskContracts,
  pathWithinChangeEvidenceRoot, priorTaskAttempts, repositoryFileManifest, resolveTaskContract, safeTaskId, summarizeAttempt, taskContractValidationErrors, taskDigestMigrationArchiveStatus,
  workPlanDependencyError, workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence, writeTaskContract
} from "./task-state.js";
import { classifyRecordedVerificationFailure, classifyVerificationFailure, latestObservedVerification, meaningfulVerificationCommands, selectCompletionRecoveryClassification, selectVerificationPlan } from "./verification-intelligence.js";
import { executionBackendToolDecision } from "./execution-backend.js";
import { replayTaskCheckpoints } from "./task-journal.js";
import type { FailureClassification } from "./failure-types.ts";
import { recordCompletionAudit, recordMutationCheckpoint, recordTaskProgressCheckpoints, recordTaskStartCheckpoint, recordVerificationCheckpoint } from "./task-runtime-audit.js";
import {
  applyAcceptanceRecoveryProvenance,
  acceptanceBaselineGuidance,
  acceptanceProofGuidance,
  acceptanceSemanticConflicts,
  buildAcceptanceReceipt,
  invalidateAcceptanceReceiptAfterMutation,
  refreshAcceptanceReceipt
} from "./acceptance-receipt.js";
import { allVerifyCommandsPassCurrentTree, changedSnapshotFiles, compactTaskDetails, mergeObservedTaskContext, passingVerifyCommandsForDigest, taskDeltaFilesFromSnapshot } from "./task-contract-view.js";
import { applyRuntimeLifecycleObservation, runtimeLifecycleMode, workingTreeEvidenceDigest } from "./task-lifecycle.js";
import { completeTaskDigestRefresh } from "./task-digest-migration.js";
import { WORKING_TREE_DIGEST_ALGORITHM, isCurrentWorkingTreeDigest, workingTreeObservation, workingTreeSnapshotUsesCurrentAlgorithm } from "./working-tree-digest.js";
import { appendJsonlBounded } from "./state-retention.js";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "./local-state-path.js";
import { piApprovalBroker, type ApprovalActionDraft } from "../runtime/inspection/approval-broker.ts";
import { inspectTaskControlState } from "../runtime/inspection/task-control-journal.ts";
import { createSourceMutationGuardBindings } from "../runtime/policy/source-mutation-guard-binding.ts";
import {
  TOOL_RESULT_CAPTURE_MAX_CHARS,
  TOOL_RESULT_COMPACT_CHAR_THRESHOLD,
  TOOL_RESULT_COMPACT_LINE_THRESHOLD,
  TOOL_RESULT_PREVIEW_MAX_CHARS
} from "../runtime/runtime-limits.ts";
import { cleanSessionNameInput, currentSessionName, hasOperatorSessionName } from "../runtime/session/message-signals.ts";
import { buildSemanticCompactionInstructions } from "../runtime/session/system-prompt.ts";
import { buildContextPreflight, buildUsageSnapshot, formatContextPreflight, formatCount, formatPercent, formatUsageSnapshot } from "../runtime/session/usage.ts";
import {
  formatToolResultCaptureStatus,
  readRecentToolResultCaptures
} from "../runtime/session/tool-result-compaction.ts";
import { RuntimeSessionState } from "../runtime/session/runtime-state.ts";
import type { ObservedTaskContext } from "../runtime/session/runtime-state.ts";
import {
  PIAGENT_TOOL_GROUPS,
  PIAGENT_TOOL_NAMES,
  PIAGENT_TOOL_ORDER,
  activeTaskToolGroups
} from "../runtime/tools/tool-groups.ts";
import type { PiagentToolGroup } from "../runtime/tools/tool-groups.ts";
import { shortTaskLabel } from "../runtime/workflows/input-routing.ts";
import {
  automaticAcceptanceCriteria,
  automaticReviewLenses,
  automaticReadOnlyTaskScope,
  automaticTaskIntakeMode,
  automaticTaskRiskLane,
  automaticTaskScope,
  resolveTaskScopePatterns,
  validTaskScopePattern
} from "../runtime/workflows/task-intake.ts";
import { readChatImage } from "../runtime/input/chat-images.ts";
import { registerInputHook } from "../runtime/hooks/input-hook.ts";
import { registerAgentStartHook } from "../runtime/hooks/agent-start-hook.ts";
import { registerCompletionHook } from "../runtime/hooks/completion-hook.ts";
import { registerSessionHooks } from "../runtime/hooks/session-hooks.ts";
import { registerSessionStartHook } from "../runtime/hooks/session-start-hook.ts";
import { registerToolCallHook } from "../runtime/hooks/tool-call-hook.ts";
import { registerToolResultHook } from "../runtime/hooks/tool-result-hook.ts";
import { readRuntimeVersionMetadata, RuntimeSnapshotCapture } from "../runtime/model/runtime-snapshot.ts";
import { recordRuntimeSnapshotTelemetry } from "../runtime/model/snapshot-telemetry.ts";
import { captureAuthenticatedModelCatalogFromContext } from "../runtime/model/authenticated-catalog.ts";
import { ModelRouteRuntime, readModelRouteEvents } from "../runtime/model/model-route-runtime.ts";
import { parentRoutingModeFromEnvironment, routingObjectiveFromEnvironment } from "../runtime/model/model-route-policy.ts";
import { ModelSelectionProvenanceTracker } from "../runtime/model/model-selection-provenance.ts";
import type { TaskFeatures } from "../runtime/solver/solver-types.ts";
import { planRetrievalRoute } from "../runtime/context/retrieval-route-policy.ts";
import { evaluateRuntimeSolver } from "../runtime/solver/runtime-features.ts";
import { SolverShadowRuntime, solverModeFromEnvironment } from "../runtime/solver/solver-shadow.ts";
import { observeTrajectorySync } from "../runtime/trajectory/trajectory-observability.ts";
import { TrajectoryRuntime } from "../runtime/trajectory/trajectory-runtime.ts";
import { PhaseToolRuntime, phaseToolModeFromEnvironment } from "../runtime/tools/phase-tool-runtime.ts";
import { authorityReplacementState, ensureTaskAuthorityResumePolicy } from "../runtime/policy/authority-resume-policy.ts";
import { taskAuthorityDecision } from "../runtime/policy/task-authority-runtime.ts";
import { selectRecoveryDecision } from "../runtime/recovery/recovery-policy.ts";
import type { RecoveryDecision } from "../runtime/recovery/recovery-policy.ts";
import { inspectTaskResumeState } from "../runtime/recovery/resume-state.ts";
import { SemanticRepairRuntime } from "../runtime/recovery/semantic-repair-runtime.ts";
import { defaultRolePolicy } from "../runtime/orchestration/role-policy.ts";
import { helpersMode } from "../runtime/orchestration/helper-lifecycle.ts";
import { buildLiveTaskStatus, formatLiveTaskStatus } from "../runtime/product/operator-projections.ts";
import { buildTaskEfficiencyMetrics } from "../runtime/product/efficiency-metrics.ts";
import { performanceReviewToolDecision, performanceReviewToolKind } from "../runtime/quality/performance-assurance.ts";
import { expectedModelMutationProof } from "../runtime/quality/model-mutation-proof.ts";
import { captureVerifierFileSnapshot } from "../runtime/inspection/verifier-snapshot-store.ts";
import { prefixCompletions, registerPiagentTool, registerRuntimeCommand, registerRuntimeTool } from "../runtime/registration/extension-registration.ts";
import { FRESH_COMMAND_ACTIONS, FRESH_COMMAND_HELP, ONBOARDING_COMMAND_ACTIONS, WORKFLOW_COMMAND_EXCLUSIONS } from "../runtime/registration/operator-catalogs.ts";
import { registerPiagentStatusCommand } from "../runtime/registration/runtime-model-status.ts";
import { registerTaskPreflightCommand } from "../runtime/registration/task-preflight.ts";
import { registerPolicyTools } from "../runtime/registration/policy-tools.ts";
import { registerKnowledgeTools } from "../runtime/registration/knowledge-tools.ts";
import { registerOnboardingTools } from "../runtime/registration/onboarding-tools.ts";
import { registerTaskStartTool } from "../runtime/registration/task-start-tool.ts";
import { registerTaskEvidenceTools } from "../runtime/registration/task-evidence-tools.ts";
import { registerTaskCompletionTools } from "../runtime/registration/task-completion-tools.ts";
import { registerPermissionCommands } from "../runtime/registration/permission-commands.ts";
import { registerProfileCommands } from "../runtime/registration/profile-commands.ts";
import { registerMemoryMcpCommands } from "../runtime/registration/memory-mcp-commands.ts";
import { registerContextCommands } from "../runtime/registration/context-commands.ts";
import { registerSessionCommands } from "../runtime/registration/session-commands.ts";
import { registerWorkflowCommands } from "../runtime/registration/workflow-commands.ts";
import { registerActivityInspector } from "../runtime/registration/activity-inspector-command.ts";
export { readChatImage };
import type { ActionClassification } from "./guard-shell-analysis.ts";
import type {
  BasePolicy,
  CommandRule,
  ContextBudgetConfig,
  ContextIndexCitation,
  ContextIndexEdge,
  ContextIndexEdgeKind,
  ContextIndexNode,
  ContextIndexNodeKind,
  ContextIndexSettings,
  ExecPolicyConfig,
  ExternalActionPolicyConfig,
  FinalGateConfig,
  MemorySettings,
  OrchestrationMode,
  OrchestrationPolicySettings,
  OrchestrationRole,
  PermissionProfileMode,
  PermissionProfilesConfig,
  ProfileOption,
  ProjectContextIndex,
  ProjectOnboardingSnapshot,
  ProjectProfile,
  ProjectTechStackReference,
  ReferenceRepo,
  ResolvedOrchestrationPolicy,
  ResolvedPermissionProfile,
  ReviewLens,
  RuntimePolicySettings,
  TaskContract,
  TechContextSnapshot,
  TechOption,
  TechRole,
  TechStackEntry,
  TechStackManifest,
  ToolRegistryConfig,
  WorkPlanStep
} from "./guard-types.js";
const PIAGENT_TRACE_STATE_TYPE = "piagent-task-trace";
const BOILERPLATE_COLLAPSE_CHARS = 300;
const TRACE_MAX_BYTES = 8 * 1024 * 1024;
type TaskStartParameters = {
  taskId?: string;
  summary: string;
  riskLane: "tiny" | "normal" | "high-risk";
  intakeMode?: "model" | "runtime";
  changeMode?: "source-change" | "read-only";
  verifyGroup?: string;
  maxAttempts?: number;
  expectedOutput: string;
  acceptanceCriteria: string[];
  scope: string[];
  outOfScope?: string[];
  reviewLenses?: ReviewLens[];
  workPlan?: Array<{
    id: string;
    title: string;
    role?: OrchestrationRole;
    mode?: "read-only" | "single-writer" | "review";
    status?: "pending" | "in-progress" | "done" | "skipped" | "failed";
    dependsOn?: string[];
    note?: string;
  }>;
};
const ORCHESTRATION_MODES = ["solo-first", "bounded-subagents", "parallel-readonly"] as const;
const REVIEW_LENSES = ["correctness", "tests", "scope", "security", "docs", "release", "package"] as const;
const ORCHESTRATION_ROLES = ["parent", "piagent-scout", "piagent-planner", "piagent-worker", "piagent-reviewer", "piagent-oracle"] as const;
const CONTEXT_INDEX_NODE_KINDS = ["profile", "tech", "module", "command", "doc", "decision", "risk", "memory", "task", "verify", "context"] as const;
const CONTEXT_INDEX_EDGE_KINDS = ["uses_tech", "depends_on", "verified_by", "protected_by", "documented_by", "derived_from", "updates", "relates_to"] as const;
const CONTEXT_INDEX_FILE = ".pi/context-index.json";
const TECH_STACK_MANIFEST_FILE = ".pi/tech-stack.json";
const TECH_CONTEXT_DIR = ".pi/tech-context";
const TECH_OPTIONS: TechOption[] = [
  { id: "nextjs", label: "Next.js", role: "frontend", description: "React framework with App Router/SSR/static rendering patterns.", context7Query: "next.js", topics: ["app-router", "routing", "data-fetching", "server-components"] },
  { id: "react-vite", label: "React + Vite", role: "frontend", description: "Client-side React app built with Vite.", context7Query: "react vite", topics: ["components", "hooks", "vite", "testing"] },
  { id: "vue", label: "Vue", role: "frontend", description: "Vue application or component frontend.", context7Query: "vue", topics: ["composition-api", "routing", "state"] },
  { id: "sveltekit", label: "SvelteKit", role: "frontend", description: "SvelteKit app with routing and load functions.", context7Query: "sveltekit", topics: ["routing", "load", "forms"] },
  { id: "astro", label: "Astro", role: "frontend", description: "Content-oriented Astro frontend/site.", context7Query: "astro", topics: ["islands", "content", "routing"] },
  { id: "angular", label: "Angular", role: "frontend", description: "Angular app with components/services/routing.", context7Query: "angular", topics: ["components", "services", "routing"] },
  { id: "nestjs", label: "NestJS", role: "backend", description: "Structured Node.js backend/API framework.", context7Query: "nestjs", topics: ["modules", "controllers", "providers", "testing"] },
  { id: "express", label: "Express", role: "backend", description: "Minimal Node.js HTTP/API backend.", context7Query: "express", topics: ["routing", "middleware", "errors"] },
  { id: "fastify", label: "Fastify", role: "backend", description: "Fast Node.js backend with schema-driven routes.", context7Query: "fastify", topics: ["routes", "schemas", "plugins"] },
  { id: "hono", label: "Hono", role: "backend", description: "Lightweight API framework for edge/server runtimes.", context7Query: "hono", topics: ["routing", "middleware", "validation"] },
  { id: "fastapi", label: "FastAPI", role: "backend", description: "Python API framework with typed request/response contracts.", context7Query: "fastapi", topics: ["routing", "pydantic", "testing"] },
  { id: "django", label: "Django", role: "backend", description: "Python web/backend framework.", context7Query: "django", topics: ["models", "views", "admin", "testing"] },
  { id: "spring-boot", label: "Spring Boot", role: "backend", description: "Java/Kotlin backend framework.", context7Query: "spring boot", topics: ["controllers", "services", "configuration"] },
  { id: "none", label: "None / not selected", role: "database", description: "No database/ORM tech selected for this profile.", topics: [] },
  { id: "prisma", label: "Prisma", role: "database", description: "TypeScript ORM and migration workflow.", context7Query: "prisma", topics: ["schema", "client", "migrations"] },
  { id: "drizzle", label: "Drizzle", role: "database", description: "TypeScript SQL ORM/query builder.", context7Query: "drizzle orm", topics: ["schema", "queries", "migrations"] },
  { id: "typeorm", label: "TypeORM", role: "database", description: "TypeScript ORM with entities/repositories.", context7Query: "typeorm", topics: ["entities", "repositories", "migrations"] },
  { id: "supabase", label: "Supabase", role: "database", description: "Postgres/Auth/storage platform used from app code.", context7Query: "supabase", topics: ["auth", "database", "storage"] },
  { id: "postgres", label: "PostgreSQL", role: "database", description: "Raw PostgreSQL/schema/query workflow.", context7Query: "postgresql", topics: ["sql", "schema", "indexes"] },
  { id: "mongodb", label: "MongoDB", role: "database", description: "Document database workflow.", context7Query: "mongodb", topics: ["schema", "queries", "indexes"] },
  { id: "react-native", label: "React Native", role: "mobile", description: "React Native mobile app.", context7Query: "react native", topics: ["components", "navigation", "native-modules"] },
  { id: "flutter", label: "Flutter", role: "mobile", description: "Flutter/Dart mobile app.", context7Query: "flutter", topics: ["widgets", "state", "routing"] },
  { id: "docker", label: "Docker", role: "devops", description: "Container build/runtime workflow.", context7Query: "docker", topics: ["dockerfile", "compose", "images"] },
  { id: "github-actions", label: "GitHub Actions", role: "devops", description: "CI/CD workflow automation.", context7Query: "github actions", topics: ["workflow", "jobs", "permissions"] },
  { id: "terraform", label: "Terraform", role: "devops", description: "Infrastructure as code.", context7Query: "terraform", topics: ["modules", "state", "providers"] },
  { id: "kubernetes", label: "Kubernetes", role: "devops", description: "Kubernetes manifests/deployments.", context7Query: "kubernetes", topics: ["deployments", "services", "config"] },
  { id: "dbt", label: "dbt", role: "data", description: "Analytics engineering/dbt project.", context7Query: "dbt", topics: ["models", "tests", "docs"] },
  { id: "pandas", label: "Pandas", role: "data", description: "Python data analysis/ETL workflow.", context7Query: "pandas", topics: ["dataframes", "io", "transforms"] },
  { id: "docusaurus", label: "Docusaurus", role: "docs", description: "Docusaurus documentation site.", context7Query: "docusaurus", topics: ["docs", "sidebar", "deployment"] },
  { id: "mintlify", label: "Mintlify", role: "docs", description: "Mintlify documentation site.", context7Query: "mintlify", topics: ["navigation", "mdx", "deployment"] },
  { id: "mkdocs", label: "MkDocs", role: "docs", description: "MkDocs documentation site.", context7Query: "mkdocs", topics: ["navigation", "markdown", "deployment"] },
  { id: "node-typescript", label: "Node TypeScript", role: "runtime", description: "Node.js TypeScript library/tooling project.", context7Query: "typescript node.js", topics: ["typescript", "node", "testing"] },
  { id: "python", label: "Python", role: "runtime", description: "Python app/library runtime.", context7Query: "python", topics: ["packaging", "typing", "testing"] }
];

const PROFILE_TECH_ROLES: Record<string, TechRole[]> = {
  "web-frontend": ["frontend", "database"],
  "backend-api": ["backend", "database"],
  "be-readonly-fe": ["frontend", "backend", "database"],
  fullstack: ["frontend", "backend", "database"],
  "node-typescript": ["runtime", "database"],
  python: ["runtime", "database"],
  data: ["data", "database"],
  devops: ["devops"],
  mobile: ["mobile"],
  docs: ["docs"],
  generic: ["runtime"]
};

const DEFAULT_MEMORY_SETTINGS: Required<MemorySettings> = {
  enabled: true,
  mode: "manual",
  scope: "project",
  summaryFile: ".pi/memory/memory_summary.md",
  handbookFile: ".pi/memory/MEMORY.md",
  localDir: ".pi/memory/local",
  readBeforeTask: true,
  writePolicy: "explicit-only",
  maxInjectedChars: 4000,
  externalPackages: []
};

const DEFAULT_CONTEXT_INDEX_SETTINGS: Required<ContextIndexSettings> = {
  enabled: true,
  path: CONTEXT_INDEX_FILE,
  writePolicy: "onboarding-record",
  requireCitations: true,
  maxNodes: 120,
  maxEdges: 240,
  includeTechStack: true,
  includeMemoryPointers: true
};

const DEFAULT_RUNTIME_POLICY: Required<RuntimePolicySettings> = {
  execPolicy: "enforce",
  contextBudget: "enforce",
  toolRegistry: "advisory",
  finalGate: "enforce"
};

const DEFAULT_ORCHESTRATION_POLICY: ResolvedOrchestrationPolicy = {
  defaultMode: "solo-first",
  maxConcurrentSubagents: 2,
  defaultReviewLenses: ["correctness", "tests", "scope"],
  roleModelGuidance: {
    planner: "Use the strongest available model for decomposition, architecture, risk, and acceptance criteria.",
    worker: "Use the fastest reliable model for a bounded, already-planned single write set.",
    reviewer: "Use a model or thinking setting decorrelated from the worker when review quality matters.",
    watchdog: "Use a strong model only for final risk review, security, release, or high-impact changes."
  },
  fieldGuide: {
    enabled: true,
    path: ".pi/memory/MEMORY.md",
    maxLines: 80,
    writePolicy: "explicit-only",
    readBeforeTask: true
  },
  rules: [
    "Default to one parent agent; do not start a swarm for ordinary implementation.",
    "Use subagents only for bounded read-only scout, planning, review, or a single approved worker.",
    "Parallel read-only review is allowed when the diff is non-trivial; parallel writers require explicit user approval and isolation.",
    "Treat Field Guide memory as advisory; verify every durable fact against current repository files.",
    "Keep review lenses explicit so cheap review work catches drift before release."
  ]
};

const PERMISSION_PROFILE_MODES = ["read-only", "workspace-write", "trusted-full-access"] as const;
const PERMISSION_PROFILE_ALIASES: Record<string, PermissionProfileMode> = {
  readonly: "read-only",
  "read_only": "read-only",
  "read-only": "read-only",
  workspace: "workspace-write",
  "workspace_write": "workspace-write",
  "workspace-write": "workspace-write",
  "full-access": "trusted-full-access",
  "full_access": "trusted-full-access",
  "trusted-full-access": "trusted-full-access",
  "trusted_full_access": "trusted-full-access",
  "danger-full-access": "trusted-full-access",
  "danger_full_access": "trusted-full-access"
};
const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "exec"]);
const MAX_MCP_PROXY_ARGS_CHARS = 131_072;
const SESSION_PERMISSION_OVERRIDES = new Map<string, PermissionProfileMode>();

// The policy used when `policies/base-policy.json` cannot be read. It runs in
// exactly the case where something is already wrong, so it must never be the
// looser of the two: this copy had drifted behind the file and silently dropped
// `.pi/piagent-state/**` -- the guard's own state -- along with the `sudo ` and
// `chmod -R 777` blocks. A missing policy file is a reason to be stricter, not a
// quiet downgrade. `tests/policy-core.test.mjs` fails if this drifts again.
const DEFAULT_POLICY: BasePolicy = {
  protectedPaths: [".git/**", "**/auth.json", "**/.env", "**/.env.*", "**/node_modules/**", "**/dist/**", ".pi/piagent-state/**", ".pi/settings.json", ".pi/piagent-profile.json", ".pi/piagent-profile.lock.json", CONTEXT_INDEX_FILE],
  shellProtectedPaths: [".git/**", "**/auth.json", "**/.env", "**/.env.*", ".pi/piagent-state/**", ".pi/settings.json", ".pi/piagent-profile.json", ".pi/piagent-profile.lock.json", CONTEXT_INDEX_FILE],
  blockedCommandPatterns: ["rm -rf /", "rm -rf ~", "rm -rf $HOME", "git reset --hard", "git clean -fd", "sudo ", "chmod -R 777"],
  requireConfirmationPatterns: ["deploy", "release", "publish", "migration", "gh pr merge", "git push"],
  defaultRequiredContext: ["AGENTS.md", "README.md"],
  permissionProfiles: {
    defaultMode: "workspace-write",
    allowedModes: ["read-only", "workspace-write", "trusted-full-access"]
  },
  execPolicy: {
    defaultMode: "enforce",
    bannedPrefixSuggestions: [
      ["python"],
      ["python3"],
      ["node"],
      ["node", "-e"],
      ["bash"],
      ["bash", "-lc"],
      ["sh"],
      ["sh", "-c"],
      ["zsh"],
      ["zsh", "-lc"],
      ["git"],
      ["sudo"],
      ["env"]
    ],
    rules: [
      {
        id: "prompt-git-add-broad",
        action: "prompt",
        match: "regex",
        value: "(?:^|\\s)git\\s+(?:-C\\s+\\S+\\s+)?add\\s+(?:(?:--all|-A)(?:\\s+(?:\\.|:/))?|--\\s+(?:\\.|:/)|(?:\\.|:/))(?:\\s|$)",
        reason: "Broad git staging can include unrelated or sensitive changes; inspect git status/diff and confirm the exact scope first."
      }
    ]
  },
  contextBudget: {
    defaultMode: "enforce",
    maxContextFileChars: 50000,
    maxMemoryFileChars: 20000,
    maxManifestFiles: 80,
    warnFragmentChars: 4000
  },
  toolRegistry: {
    defaultMode: "advisory",
    alwaysAllowedTools: [
      "piagent_tools",
      "piagent_context_engine",
      "piagent_context",
      "piagent_permission_status",
      "piagent_exec_policy_check",
      "piagent_context_budget",
      "piagent_tool_policy_check",
      "piagent_task_gate_check",
      "piagent_usage_snapshot",
      "piagent_orchestration_policy",
      "piagent_memory_status",
      "piagent_memory_note",
      "piagent_memory_search",
      "piagent_memory_citation_record",
      "piagent_context_index_status",
      "piagent_context_index_record",
      "piagent_context_index_search",
      "piagent_profile_options",
      "piagent_profile_apply",
      "piagent_profile_tech_options",
      "piagent_profile_tech_apply",
      "piagent_profile_tech_context_record",
      "piagent_project_onboarding_record",
      "piagent_task_start",
      "piagent_task_progress",
      "piagent_source_checkout",
      "piagent_context_record",
      "piagent_verify_record",
      "piagent_trace_record"
    ],
    toolCapabilities: {
      bash: ["shell"],
      shell: ["shell"],
      exec: ["shell"],
      read: ["filesystem-readonly"],
      grep: ["filesystem-readonly"],
      find: ["filesystem-readonly"],
      ls: ["filesystem-readonly"],
      write: ["filesystem-write"],
      edit: ["filesystem-write"],
      browser: ["browser"],
      github: ["github"]
    }
  },
  externalActionPolicy: {
    defaultMode: "enforce",
    providerKeywords: [
      "github",
      "gitlab",
      "bitbucket",
      "vercel",
      "netlify",
      "cloudflare",
      "aws",
      "gcp",
      "azure",
      "slack",
      "teams",
      "jira",
      "linear",
      "notion",
      "figma",
      "stripe",
      "supabase",
      "firebase"
    ],
    writeVerbs: [
      "add",
      "approve",
      "archive",
      "assign",
      "close",
      "comment",
      "create",
      "delete",
      "deploy",
      "dispatch",
      "merge",
      "open",
      "post",
      "publish",
      "push",
      "release",
      "remove",
      "reopen",
      "run",
      "send",
      "submit",
      "trigger",
      "update",
      "upload",
      "write"
    ],
    safeVerbs: [
      "fetch",
      "find",
      "get",
      "inspect",
      "list",
      "read",
      "search",
      "show",
      "view"
    ]
  },
  finalGate: {
    defaultMode: "enforce",
    requireTaskContract: true,
    requireContextManifest: true,
    requireVerifyEvidence: true,
    requireTrace: true,
    requirePassingVerify: true
  },
  orchestrationPolicy: DEFAULT_ORCHESTRATION_POLICY
};

// Which platform supplies the adapters is fixed by where this file is installed,
// so it is resolved once here rather than threaded through every profile load.
const PLATFORM_ROOT = findPlatformRoot(path.dirname(fileURLToPath(import.meta.url)));
const UPDATE_CHECK_MODULE = fileURLToPath(new URL("./update-check.js", import.meta.url));

// The installed version, read from the package this file ships in. A maintainer
// working in the repository is not running a release and has nothing to update
// to, so only a tree Pi or npm placed is given a version to compare.
function installedPlatformVersion(): string | undefined {
  if (!isInstalledPlatform(PLATFORM_ROOT)) return undefined;
  return readJsonFile<{ version?: string }>(path.join(PLATFORM_ROOT, "package.json"))?.version;
}

function updateAvailabilityNotice(): string | undefined {
  const installed = installedPlatformVersion();
  if (!installed) return undefined;
  const decision = evaluateUpdateCheck({ installed, cache: readUpdateCache(), now: Date.now() });
  if (decision.probe) startUpdateProbe(UPDATE_CHECK_MODULE);
  return decision.notice;
}

// What the operator would otherwise find out when a call fails: a server that is
// configured but cannot answer. Computed from files and environment variables
// this process already has, with no network and no child process, because it runs
// on every session start.
function mcpReadinessNotice(cwd: string): string | undefined {
  if (process.env.PIAGENT_NO_MCP_NOTICE?.trim()) return undefined;
  try {
    const servers = collectServers({ projectPath: cwd });
    if (servers.length === 0) return undefined;
    return readinessNotice(servers.map((server) => evaluateServerReadiness(server, { projectPath: cwd })));
  } catch {
    // Reporting on MCP is not worth failing a session start over.
    return undefined;
  }
}

function loadPolicy(extensionDir: string): BasePolicy {
  const root = findPackageRoot(extensionDir);
  return readJsonFile<BasePolicy>(path.join(root, "policies", "base-policy.json")) ?? DEFAULT_POLICY;
}

function fallbackProfile(cwd: string, mode = "unprofiled"): ProjectProfile {
  return {
    schemaVersion: 1,
    projectId: path.basename(cwd),
    displayName: path.basename(cwd),
    mode,
    protectedPaths: [],
    requiredContext: []
  };
}

// A profile that names an adapter this platform does not have cannot be
// enforced, and the unprofiled shape carries no readOnlyPaths — falling back to
// it would quietly hand write access to whatever the profile was protecting. The
// session stays readable and says why instead.
function unresolvedProfile(cwd: string, reason: string): ProjectProfile {
  return {
    ...fallbackProfile(cwd, "unresolved-profile-base"),
    permissionProfile: "read-only",
    unresolvedReason: reason
  } as ProjectProfile;
}

function resolveStoredProfile(stored: ProjectProfile | undefined, cwd: string, missingMode: string): ProjectProfile {
  if (!stored) return fallbackProfile(cwd, missingMode);
  try {
    return resolveProjectProfileDocument(PLATFORM_ROOT, stored).profile as ProjectProfile;
  } catch (error) {
    return unresolvedProfile(cwd, error instanceof Error ? error.message : String(error));
  }
}

function loadProfile(cwd: string, projectTrusted = false): ProjectProfile {
  const explicit = process.env.PIAGENT_PROFILE;
  if (explicit && explicit.trim().length > 0) {
    return resolveStoredProfile(readJsonFile<ProjectProfile>(explicit), cwd, "explicit-profile-unreadable");
  }

  if (!projectTrusted) {
    return fallbackProfile(cwd, "unprofiled-global-package");
  }

  return resolveStoredProfile(readJsonFile<ProjectProfile>(path.join(cwd, ".pi", "piagent-profile.json")), cwd, "unprofiled");
}

function loadProfileFromContext(ctx: ExtensionContext): ProjectProfile {
  return loadProfile(ctx.cwd, ctx.isProjectTrusted());
}

// A project written against the previous namespace has no working path forward:
// nothing reads .pi/company-profile.json any more, so its protected paths and
// verify commands would silently stop being enforced. Detect it and say so.
function findLegacyProjectState(cwd: string): string[] {
  return [".pi/company-profile.json", ".pi/company-profile.lock.json", ".pi/company-state"]
    .filter((relative) => fs.existsSync(path.join(cwd, relative)));
}

function legacyProjectStateWarning(cwd: string): string | undefined {
  const legacy = findLegacyProjectState(cwd);
  if (legacy.length === 0) return undefined;
  const current = fs.existsSync(path.join(cwd, ".pi", "piagent-profile.json"));
  const detail = `Found pre-piagent project state: ${legacy.join(", ")}.`;
  return current
    ? `${detail} The current profile is active, so these are leftovers; remove them with \`piagent-migrate . --apply --remove-old\`.`
    : `${detail} No .pi/piagent-profile.json exists, so this project is running unprofiled and its protected paths and verify commands are NOT enforced. Convert it with \`piagent-migrate . --apply\`.`;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

function titleize(input: string): string {
  const cleaned = input.replace(/[-_]+/g, " ").trim();
  return cleaned ? cleaned.replace(/\b\w/g, (char) => char.toUpperCase()) : "Project";
}

function projectProfilePath(cwd: string): string {
  return path.join(cwd, ".pi", "piagent-profile.json");
}

function projectPackageSource(cwd: string): string {
  const settings = readJsonFile<{ packages?: unknown[] }>(path.join(cwd, ".pi", "settings.json"));
  const source = settings?.packages?.find((item): item is string => typeof item === "string" && item.length > 0);
  return source ?? "workspace";
}

// A project may use capability packs it does not own by declaring them in its
// profile. Resolution reads only what is already on disk under the project;
// fetching happens in an explicit maintainer command, never here. A source that
// is declared but not present throws, and every caller treats that as a
// refusal — an unresolvable source must not silently resolve to fewer packs
// than the profile asked for.
function capabilitySourceRoots(
  cwd: string,
  profile: ProjectProfile
): ReturnType<typeof resolveCapabilitySourceRoots> | undefined {
  const declared = (profile as { capabilitySources?: unknown }).capabilitySources;
  if (declared === undefined) return undefined;
  return resolveCapabilitySourceRoots(cwd, declared as Parameters<typeof resolveCapabilitySourceRoots>[1]);
}

type ProjectCapabilityState = {
  ok: boolean;
  reason?: string;
  repinned?: string;
  filesystemRead?: string[];
  filesystemWrite?: string[];
};

const capabilityVerificationCache = createCapabilityVerificationCache();
const sessionCapabilityDigests = new Map<string, string>();

function verifyProjectCapabilityState(
  extensionDir: string,
  cwd: string,
  projectTrusted: boolean,
  options: { allowRepin?: boolean; forceFull?: boolean; sessionId?: string } = {}
): ProjectCapabilityState {
  if (process.env.PIAGENT_PROFILE?.trim()) return { ok: true };
  if (!projectTrusted) return { ok: true };
  const profilePath = projectProfilePath(cwd);
  if (!fs.existsSync(profilePath)) return { ok: true };
  // Which packs a project selects can come from the adapter it extends, so the
  // question has to be asked of the resolved document. Asking the stored one
  // would skip the lock entirely for every project that references an adapter.
  const stored = readJsonFile<ProjectProfile>(profilePath);
  if (!stored) return { ok: true };
  try {
    const profile = resolveProjectProfileDocument(findPlatformRoot(extensionDir), stored).profile;
    if (!Array.isArray(profile.capabilityPacks)) return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const lockPath = path.join(cwd, ".pi", "piagent-profile.lock.json");
  if (!fs.existsSync(lockPath)) return { ok: false, reason: "Capability lock is missing. Reapply the project profile." };
  const lock = readJsonFile<Record<string, unknown>>(lockPath);
  if (!lock) return { ok: false, reason: "Capability lock is unreadable. Reapply the project profile." };
  try {
    return verifyProjectCapabilityStateCached({
      cache: capabilityVerificationCache, cwd, platformRoot: findPlatformRoot(extensionDir), profilePath, lockPath,
      lockDocument: lock, storedProfile: stored, packageSource: projectPackageSource, extraRoots: capabilitySourceRoots,
      writeLock: writeJsonAtomic, allowRepin: options.allowRepin, forceFull: options.forceFull,
      sessionDigest: options.sessionId ? sessionCapabilityDigests.get(`${cwd}\0${options.sessionId}`) : undefined,
      rememberSessionDigest: options.sessionId ? (digest: string) => sessionCapabilityDigests.set(`${cwd}\0${options.sessionId}`, digest) : undefined
    });
  } catch (error) {
    return { ok: false, reason: `Capability validation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function evaluateExecPolicy(command: string, profile: ProjectProfile, policy: BasePolicy): {
  mode: RuntimePolicySettings["execPolicy"];
  decision: "allow" | "prompt" | "forbid";
  reasons: string[];
  segments: Array<{ command: string; words: string[]; matches: string[]; warnings: string[] }>;
} {
  const runtime = resolveRuntimePolicy(profile);
  const execPolicy = execPolicyConfig(policy);
  const mode = runtime.execPolicy === "off" ? "off" : runtime.execPolicy ?? execPolicy.defaultMode;
  return evaluateExecPolicyCore(command, { policy: { ...policy, execPolicy }, mode }) as {
    mode: RuntimePolicySettings["execPolicy"];
    decision: "allow" | "prompt" | "forbid";
    reasons: string[];
    segments: Array<{ command: string; words: string[]; matches: string[]; warnings: string[] }>;
  };
}

function evaluateToolPolicy(toolName: string, profile: ProjectProfile, policy: BasePolicy): {
  mode: RuntimePolicySettings["toolRegistry"];
  decision: "allow" | "warn" | "block";
  requiredCapabilities: string[];
  availableCapabilities: string[];
  reason: string;
} {
  const runtime = resolveRuntimePolicy(profile);
  const registry = toolRegistryConfig(policy);
  const mode = runtime.toolRegistry === "off" ? "off" : runtime.toolRegistry ?? registry.defaultMode;
  if (mode === "off") {
    return { mode, decision: "allow", requiredCapabilities: [], availableCapabilities: profile.mcpCapabilities ?? [], reason: "Tool registry is disabled for this profile." };
  }
  if (registry.alwaysAllowedTools.includes(toolName) || toolName.startsWith("piagent_")) {
    return { mode, decision: "allow", requiredCapabilities: [], availableCapabilities: profile.mcpCapabilities ?? [], reason: "Piagent platform tool is always allowed." };
  }
  const requiredCapabilities = registry.toolCapabilities[toolName] ?? [];
  if (requiredCapabilities.length === 0) {
    return { mode, decision: mode === "enforce" ? "block" : "warn", requiredCapabilities, availableCapabilities: profile.mcpCapabilities ?? [], reason: "Tool is not registered in piagent tool registry." };
  }
  const available = new Set(profile.mcpCapabilities ?? []);
  const missing = requiredCapabilities.filter((capability) => !available.has(capability));
  if (missing.length === 0) {
    return { mode, decision: "allow", requiredCapabilities, availableCapabilities: profile.mcpCapabilities ?? [], reason: "Required capability is present." };
  }
  return {
    mode,
    decision: mode === "enforce" ? "block" : "warn",
    requiredCapabilities,
    availableCapabilities: profile.mcpCapabilities ?? [],
    reason: `Missing capability: ${missing.join(", ")}`
  };
}

const CONTENT_INPUT_FIELDS = new Set([
  "body",
  "command",
  "content",
  "description",
  "message",
  "new",
  "newtext",
  "old",
  "oldtext",
  "pattern",
  "prompt",
  "query",
  "reason",
  "regex",
  "replacement",
  "source",
  "summary",
  "text"
]);

const FILESYSTEM_SCOPE_FIELDS = new Set([
  "absolutepath",
  "basepath",
  "cwd",
  "dest",
  "destination",
  "destinationdirectory",
  "destinationpath",
  "dir",
  "directory",
  "directorypath",
  "file",
  "filepath",
  "filename",
  "filenames",
  "files",
  "from",
  "inputpath",
  "location",
  "local",
  "localpath",
  "newpath",
  "notebookpath",
  "oldpath",
  "output",
  "outputfile",
  "outputpath",
  "path",
  "paths",
  "rootpath",
  "root",
  "source",
  "sourcedirectory",
  "sourcepath",
  "src",
  "target",
  "targetdirectory",
  "targetpath",
  "to",
  "workingdirectory",
  "uri"
]);

const COPY_SOURCE_FIELDS = new Set([
  "from",
  "inputpath",
  "oldpath",
  "source",
  "sourcedirectory",
  "sourcepath",
  "src"
]);
const FILESYSTEM_SCOPE_FIELD_SUFFIXES = new Set([
  "cwd", "dir", "directory", "file", "filename", "folder", "path", "workdir"
]);

function isContentInputField(field: string | undefined): boolean {
  return field !== undefined && CONTENT_INPUT_FIELDS.has(field.toLowerCase().replace(/[-_]/g, ""));
}

function isFilesystemScopeField(fieldPath: string): boolean {
  const field = fieldPath.split(".").at(-1)?.replace(/\[\d+\]$/, "");
  if (field === undefined) return false;
  const normalized = field.toLowerCase().replace(/[-_]/g, "");
  if (FILESYSTEM_SCOPE_FIELDS.has(normalized)) return true;
  const finalToken = field
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_]/)
    .filter(Boolean)
    .at(-1);
  return finalToken !== undefined && FILESYSTEM_SCOPE_FIELD_SUFFIXES.has(finalToken);
}

function filesystemFieldAccessMode(
  toolName: string,
  fieldPath: string,
  writesFilesystem: boolean
): "read" | "write" {
  if (!writesFilesystem) return "read";
  const toolTokens = new Set(actionTokens(toolName));
  const rawField = fieldPath.split(".").at(-1)?.replace(/\[\d+\]$/, "") ?? "";
  const field = rawField.toLowerCase().replace(/[-_]/g, "");
  const firstFieldToken = rawField
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_]/)
    .filter(Boolean)[0];
  // Copy/upload read their local source and write only their destination.
  // Move/rename are intentionally excluded because they also mutate source.
  if (
    (toolTokens.has("copy") || toolTokens.has("upload"))
    && (COPY_SOURCE_FIELDS.has(field) || ["from", "input", "local", "old", "source", "src"].includes(firstFieldToken ?? ""))
  ) return "read";
  return "write";
}

function usesFilesystemContentFields(toolName: string, allowAmbiguousSource = true): boolean {
  if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) return true;
  const tokens = new Set(actionTokens(toolName));
  const strongFilesystemSemantics = [
    "copy", "directory", "download", "file", "files", "filesystem", "folder", "fs",
    "move", "path", "rename", "upload"
  ].some((token) => tokens.has(token));
  if (strongFilesystemSemantics) return true;
  // `source` is ambiguous. Inspect it by default for protected paths, but let
  // configured external providers use it as ordinary metadata unless the tool
  // itself has strong filesystem semantics (for example upload_file).
  return allowAmbiguousSource;
}

function inspectRepositoryPathBoundary(cwd: string, candidate: string): { reason?: string } {
  const normalized = normalizePathCandidate(candidate);
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return { reason: `path resolves outside the project: ${candidate}` };
  }
  let current = cwd;
  for (const segment of normalized.split("/").filter((item) => item && item !== ".")) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return { reason: `path traverses symbolic link: ${path.relative(cwd, current)}` };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "ENOENT") break;
      return { reason: `path component cannot be inspected: ${path.relative(cwd, current)}` };
    }
  }
  return {};
}

const MAX_TOOL_INPUT_INSPECTION_DEPTH = 32;

type StringInputWalkResult = {
  items: Array<{ field: string; value: string }>;
  maxDepthExceeded?: string;
};

function walkStringInputs(
  value: unknown,
  keyPath: string[] = [],
  depth = 0,
  includeFilesystemContentFields = false
): StringInputWalkResult {
  if (depth > MAX_TOOL_INPUT_INSPECTION_DEPTH) {
    return { items: [], maxDepthExceeded: keyPath.join(".") || "(input)" };
  }

  if (typeof value === "string") {
    const field = keyPath.at(-1);
    const fieldPath = keyPath.join(".") || "(input)";
    if (isContentInputField(field) && !(includeFilesystemContentFields && isFilesystemScopeField(fieldPath))) {
      return { items: [] };
    }
    return { items: [{ field: fieldPath, value }] };
  }

  if (Array.isArray(value)) {
    const result: StringInputWalkResult = { items: [] };
    for (const item of value) {
      const child = walkStringInputs(item, keyPath, depth + 1, includeFilesystemContentFields);
      result.items.push(...child.items);
      if (child.maxDepthExceeded) result.maxDepthExceeded ??= child.maxDepthExceeded;
    }
    return result;
  }

  if (!value || typeof value !== "object") return { items: [] };

  const result: StringInputWalkResult = { items: [] };
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childResult = walkStringInputs(child, [...keyPath, key], depth + 1, includeFilesystemContentFields);
    result.items.push(...childResult.items);
    if (childResult.maxDepthExceeded) result.maxDepthExceeded ??= childResult.maxDepthExceeded;
  }
  return result;
}

function inspectPathInputsFromInput(
  cwd: string,
  input: Record<string, unknown>,
  includeFilesystemContentFields = false
): {
  paths: Array<{ field: string; path: string }>;
  maxDepthExceeded?: string;
} {
  const paths: Array<{ field: string; path: string }> = [];
  const seen = new Set<string>();
  const walked = walkStringInputs(input, [], 0, includeFilesystemContentFields);
  for (const item of walked.items) {
    const normalized = normalizeRelative(cwd, item.value);
    if (normalized === undefined) continue;
    const key = `${item.field}\0${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push({ field: item.field, path: normalized });
  }
  return { paths, maxDepthExceeded: walked.maxDepthExceeded };
}

function extractPathInputsFromInput(cwd: string, input: Record<string, unknown>): Array<{ field: string; path: string }> {
  return inspectPathInputsFromInput(cwd, input).paths;
}

function extractLikelyPathFromInput(cwd: string, input: Record<string, unknown>): string | undefined {
  return extractPathInputsFromInput(cwd, input)[0]?.path;
}

function protectedLiteralHints(pattern: string): string[] {
  const normalized = normalizePathCandidate(pattern).toLowerCase();
  if (!normalized) return [];

  const hints = new Set<string>();
  const add = (value: string | undefined) => {
    const cleaned = normalizePathCandidate(value ?? "").toLowerCase().replace(/\/$/, "");
    if (cleaned && cleaned !== "**" && cleaned !== "." && cleaned.length >= 3) hints.add(cleaned);
  };

  const withoutLeadingGlob = normalized.replace(/^\*\*\//, "");
  const wildcardIndex = withoutLeadingGlob.search(/[*?{\[]/);
  if (wildcardIndex > 0) add(withoutLeadingGlob.slice(0, wildcardIndex));
  if (wildcardIndex < 0) add(withoutLeadingGlob);

  for (const example of protectedPatternExamples(pattern)) {
    if (/[*?{\[\]]/.test(example)) continue;
    add(example);
    add(path.posix.basename(example));
  }

  if (normalized.includes(".env")) add(".env");

  return [...hints].sort((left, right) => right.length - left.length);
}

function globMentionsProtectedHint(candidateGlob: string, pattern: string): boolean {
  const normalizedGlob = normalizePathCandidate(candidateGlob).toLowerCase();
  if (!normalizedGlob) return false;
  return protectedLiteralHints(pattern).some((hint) => normalizedGlob.includes(hint));
}

function globTargetsProtectedPath(glob: unknown, protectedPatterns: string[]): { glob: string; pattern: string; example: string } | undefined {
  const values = Array.isArray(glob) ? glob : [glob];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("!")) continue;

    const expanded = expandSimpleGlobAlternatives(trimmed);
    if (!expanded.complete) return { glob: trimmed, pattern: "bounded glob expansion", example: "a protected path" };
    for (const candidateGlob of expanded.values) {
      for (const pattern of protectedPatterns) {
        if (!globMentionsProtectedHint(candidateGlob, pattern)) continue;
        for (const example of protectedPatternExamples(pattern)) {
          if (
            globMatchesPath(candidateGlob, example)
            || globMatchesPath(`**/${candidateGlob}`, example)
            || globMatchesPath(candidateGlob, path.posix.basename(example))
          ) {
            return { glob: trimmed, pattern, example };
          }
        }
      }
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function evaluatePathLikeToolAccess(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  writeProtectedPaths: string[],
  readProtectedPaths: string[],
  readOnlyPaths: string[],
  filesystemRead?: string[],
  filesystemWrite?: string[],
  options: {
    forceScopeAware?: boolean;
    forceWrite?: boolean;
    allowAmbiguousFilesystemContentFields?: boolean;
  } = {}
): { block: boolean; reason?: string } {
  const scopeAwareTool = options.forceScopeAware === true || ["read", "write", "edit", "grep", "find", "ls"].includes(toolName)
    || /(?:^|[_-])(?:fs|filesystem)(?:[_-]|$)/i.test(toolName);
  const inspection = inspectPathInputsFromInput(
    cwd,
    input,
    usesFilesystemContentFields(toolName, options.allowAmbiguousFilesystemContentFields !== false)
  );
  if (inspection.maxDepthExceeded) {
    return {
      block: true,
      reason: `Blocked ${toolName}: tool input nesting exceeds inspection depth at ${inspection.maxDepthExceeded}`
    };
  }

  const writesFilesystem = options.forceWrite === true || ["write", "edit"].includes(toolName)
    || (scopeAwareTool && /(?:write|edit|create|delete|move|rename|upload|update|patch|set|replace|append|copy)/i.test(toolName));
  const scopeGlobs = toolName === "grep"
    ? (Array.isArray(input.glob) ? input.glob : [input.glob])
    : toolName === "find"
      ? (Array.isArray(input.pattern) ? input.pattern : [input.pattern])
      : [];
  for (const value of scopeGlobs) {
    if (typeof value !== "string") continue;
    const candidate = value.startsWith("!") ? value.slice(1) : value;
    const unsafe = candidate.length === 0
      || candidate.length > 512
      || candidate.includes("\\")
      || candidate.includes("\0")
      || path.posix.isAbsolute(candidate)
      || /^[A-Za-z]:/.test(candidate)
      || candidate.split("/").some((segment) => segment === "..");
    if (unsafe) return { block: true, reason: `Blocked ${toolName} unsafe scope pattern: ${value}` };
  }
  const inspectedPaths = [...inspection.paths];
  if (["grep", "find", "ls"].includes(toolName) && !inspectedPaths.some((item) => isFilesystemScopeField(item.field))) {
    inspectedPaths.push({ field: "path", path: "." });
  }

  for (const item of inspectedPaths) {
    if (scopeAwareTool && isFilesystemScopeField(item.field)) {
      const boundary = inspectRepositoryPathBoundary(cwd, item.path);
      if (boundary.reason) return { block: true, reason: `Blocked ${toolName}: ${boundary.reason}` };
    }
    const resolvedPath = resolveRepositoryPathCandidate(cwd, item.path);
    const readMatched = matchesProtectedPath(item.path, readProtectedPaths)
      ?? (resolvedPath ? matchesProtectedPath(resolvedPath, readProtectedPaths) : undefined);
    if (readMatched) {
      return {
        block: true,
        reason: `Blocked ${toolName} access to protected path from ${item.field}: ${item.path} matches ${readMatched}`
      };
    }

    const fieldAccessMode = filesystemFieldAccessMode(toolName, item.field, writesFilesystem);
    if (fieldAccessMode === "write") {
      const readOnlyMatched = matchesProtectedPath(item.path, readOnlyPaths)
        ?? (resolvedPath ? matchesProtectedPath(resolvedPath, readOnlyPaths) : undefined);
      if (readOnlyMatched) {
        return {
          block: true,
          reason: `Blocked ${toolName} write to read-only path from ${item.field}: ${item.path} matches ${readOnlyMatched}`
        };
      }
      const writeMatched = matchesProtectedPath(item.path, writeProtectedPaths)
        ?? (resolvedPath ? matchesProtectedPath(resolvedPath, writeProtectedPaths) : undefined);
      if (writeMatched) {
        return {
          block: true,
          reason: `Blocked ${toolName} write to protected path from ${item.field}: ${item.path} matches ${writeMatched}`
        };
      }
      if (scopeAwareTool && filesystemWrite && isFilesystemScopeField(item.field) && !matchesAnyPath(item.path, filesystemWrite)) {
        return {
          block: true,
          reason: `Blocked ${toolName} write outside resolved filesystem scope from ${item.field}: ${item.path}`
        };
      }
    } else if (scopeAwareTool && filesystemRead && isFilesystemScopeField(item.field) && !matchesAnyPath(item.path, filesystemRead)) {
      return {
        block: true,
        reason: `Blocked ${toolName} read outside resolved filesystem scope from ${item.field}: ${item.path}`
      };
    }
  }

  if (toolName === "grep") {
    const hit = globTargetsProtectedPath(input.glob, readProtectedPaths);
    if (hit) {
      return {
        block: true,
        reason: `Blocked grep glob targeting protected path: ${hit.glob} can match ${hit.example} via ${hit.pattern}`
      };
    }
  }

  if (toolName === "find") {
    const hit = globTargetsProtectedPath(input.pattern, readProtectedPaths);
    if (hit) {
      return {
        block: true,
        reason: `Blocked find pattern targeting protected path: ${hit.glob} can match ${hit.example} via ${hit.pattern}`
      };
    }
  }

  return { block: false };
}

function stateRoot(cwd: string): string {
  return path.join(cwd, ".pi", "piagent-state");
}

function projectContextFilePath(cwd: string): string {
  return path.join(cwd, ".pi", "project-context.md");
}

function onboardingStateFilePath(cwd: string): string {
  return path.join(stateRoot(cwd), "project-onboarding.json");
}

function traceFilePath(cwd: string): string {
  return path.join(stateRoot(cwd), "traces.jsonl");
}

function observedBashLedgerPath(cwd: string): string {
  return path.join(stateRoot(cwd), "observed-bash.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureStateDirs(cwd: string): void {
  ensurePrivateStateDirectory(cwd, stateRoot(cwd), "Piagent state directory");
  ensurePrivateStateDirectory(cwd, path.join(stateRoot(cwd), "tasks"), "Piagent task state directory");
}

function ensureProjectContextPlaceholder(cwd: string): void {
  ensurePrivateStateDirectory(cwd, path.join(cwd, ".pi"), "Piagent project directory");
  const target = resolveLocalStatePath(cwd, projectContextFilePath(cwd), { label: "Project context file" });
  if (fs.existsSync(target)) return;
  fs.writeFileSync(target, [
    "# Project Context",
    "",
    "## Status",
    "",
    "- Generated: not yet",
    "- Profile: see `.pi/piagent-profile.json`",
    "- Model/pass: run `/onboard` after Pi login and model selection",
    "- Scope: pending",
    "",
    "Run `/onboard` to replace this placeholder with a concise project context snapshot.",
    ""
  ].join("\n"));
}

function resolveMemorySettings(profile: ProjectProfile): Required<MemorySettings> {
  return {
    ...DEFAULT_MEMORY_SETTINGS,
    ...(profile.memory ?? {}),
    externalPackages: profile.memory?.externalPackages ?? DEFAULT_MEMORY_SETTINGS.externalPackages
  };
}

function resolveRuntimePolicy(profile: ProjectProfile): Required<RuntimePolicySettings> {
  return {
    ...DEFAULT_RUNTIME_POLICY,
    ...(profile.runtimePolicy ?? {})
  };
}

function normalizePermissionProfileMode(value: unknown): PermissionProfileMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return PERMISSION_PROFILE_ALIASES[normalized];
}

function runtimeEquivalentForPermissionProfile(mode: PermissionProfileMode): string {
  if (mode === "read-only") return "sandbox_mode=read-only";
  if (mode === "trusted-full-access") return "sandbox_mode=danger-full-access + approval_policy=never, with Piagent protected-path and human-action gates still enforced";
  return "sandbox_mode=workspace-write + approval_policy=on-request";
}

function sessionPermissionOverrideKey(ctx: ExtensionContext): string {
  return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
}

function permissionOverrideFromContext(ctx: ExtensionContext): PermissionProfileMode | undefined {
  return SESSION_PERMISSION_OVERRIDES.get(sessionPermissionOverrideKey(ctx));
}

function setPermissionOverrideForContext(ctx: ExtensionContext, mode: PermissionProfileMode): void {
  SESSION_PERMISSION_OVERRIDES.set(sessionPermissionOverrideKey(ctx), mode);
}

function permissionProfilesConfig(policy: BasePolicy): Required<PermissionProfilesConfig> {
  const configuredDefault = normalizePermissionProfileMode(policy.permissionProfiles?.defaultMode)
    ?? normalizePermissionProfileMode(DEFAULT_POLICY.permissionProfiles?.defaultMode)
    ?? "workspace-write";
  const configuredAllowed = policy.permissionProfiles?.allowedModes
    ?.map((item) => normalizePermissionProfileMode(item))
    .filter((item): item is PermissionProfileMode => item !== undefined)
    ?? DEFAULT_POLICY.permissionProfiles?.allowedModes
    ?? ["read-only", "workspace-write"];
  const allowedModes = Array.from(new Set(configuredAllowed));
  if (!allowedModes.length) return { defaultMode: "read-only", allowedModes: ["read-only"] };
  return {
    defaultMode: allowedModes.includes(configuredDefault) ? configuredDefault : "read-only",
    allowedModes
  };
}

function resolvePermissionProfile(
  profile: ProjectProfile,
  policy: BasePolicy,
  commandOverride?: PermissionProfileMode
): ResolvedPermissionProfile {
  const config = permissionProfilesConfig(policy);
  const envOverride = process.env.PIAGENT_PERMISSION_PROFILE?.trim();
  const requested = envOverride || commandOverride || profile.permissionProfile;
  const source = envOverride ? "env" : commandOverride ? "command" : profile.permissionProfile ? "profile" : "default";
  const resolved = requested ? normalizePermissionProfileMode(requested) : config.defaultMode;

  if (!resolved) {
    const mode: PermissionProfileMode = "read-only";
    return {
      mode,
      source: envOverride ? "invalid-env" : "invalid-profile",
      requested: String(requested),
      warning: `Invalid permission profile ${String(requested)}; failed closed to read-only.`,
      runtimeEquivalent: runtimeEquivalentForPermissionProfile(mode)
    };
  }

  if (!config.allowedModes.includes(resolved)) {
    const mode: PermissionProfileMode = config.allowedModes.includes("read-only") ? "read-only" : config.allowedModes[0];
    return {
      mode,
      source: "policy-fallback",
      requested: String(requested ?? resolved),
      warning: `Permission profile ${resolved} is not allowed by policy; using ${mode}.`,
      runtimeEquivalent: runtimeEquivalentForPermissionProfile(mode)
    };
  }

  return {
    mode: resolved,
    source,
    requested: requested ? String(requested) : undefined,
    runtimeEquivalent: runtimeEquivalentForPermissionProfile(resolved)
  };
}

function isPiagentTool(toolName: string): boolean {
  return toolName.startsWith("piagent_");
}

function evaluatePermissionProfileToolAccess(
  toolName: string,
  permissionProfile: ResolvedPermissionProfile
): { block: boolean; reason?: string } {
  if (permissionProfile.mode !== "read-only") return { block: false };
  if (isPiagentTool(toolName) || READ_ONLY_TOOL_NAMES.has(toolName)) return { block: false };
  if (WRITE_TOOL_NAMES.has(toolName)) {
    return { block: true, reason: `Permission profile read-only blocked ${toolName}: filesystem writes are disabled.` };
  }
  if (SHELL_TOOL_NAMES.has(toolName)) {
    return { block: true, reason: `Permission profile read-only blocked ${toolName}: shell execution is disabled.` };
  }
  return { block: true, reason: `Permission profile read-only blocked ${toolName}: only read, grep, find, ls, and piagent tools are allowed.` };
}

function contextBudgetConfig(policy: BasePolicy): Required<ContextBudgetConfig> {
  return {
    defaultMode: policy.contextBudget?.defaultMode ?? DEFAULT_POLICY.contextBudget?.defaultMode ?? "enforce",
    maxContextFileChars: policy.contextBudget?.maxContextFileChars ?? DEFAULT_POLICY.contextBudget?.maxContextFileChars ?? 50000,
    maxMemoryFileChars: policy.contextBudget?.maxMemoryFileChars ?? DEFAULT_POLICY.contextBudget?.maxMemoryFileChars ?? 20000,
    maxManifestFiles: policy.contextBudget?.maxManifestFiles ?? DEFAULT_POLICY.contextBudget?.maxManifestFiles ?? 80,
    warnFragmentChars: policy.contextBudget?.warnFragmentChars ?? DEFAULT_POLICY.contextBudget?.warnFragmentChars ?? 4000
  };
}

function execPolicyConfig(policy: BasePolicy): Required<ExecPolicyConfig> {
  return {
    defaultMode: policy.execPolicy?.defaultMode ?? DEFAULT_POLICY.execPolicy?.defaultMode ?? "enforce",
    bannedPrefixSuggestions: policy.execPolicy?.bannedPrefixSuggestions ?? DEFAULT_POLICY.execPolicy?.bannedPrefixSuggestions ?? [],
    rules: policy.execPolicy?.rules ?? []
  };
}

function toolRegistryConfig(policy: BasePolicy): Required<ToolRegistryConfig> {
  return {
    defaultMode: policy.toolRegistry?.defaultMode ?? DEFAULT_POLICY.toolRegistry?.defaultMode ?? "advisory",
    alwaysAllowedTools: policy.toolRegistry?.alwaysAllowedTools ?? DEFAULT_POLICY.toolRegistry?.alwaysAllowedTools ?? [],
    toolCapabilities: policy.toolRegistry?.toolCapabilities ?? DEFAULT_POLICY.toolRegistry?.toolCapabilities ?? {}
  };
}

function externalActionPolicyConfig(policy: BasePolicy): Required<ExternalActionPolicyConfig> {
  return {
    defaultMode: policy.externalActionPolicy?.defaultMode ?? DEFAULT_POLICY.externalActionPolicy?.defaultMode ?? "enforce",
    providerKeywords: policy.externalActionPolicy?.providerKeywords ?? DEFAULT_POLICY.externalActionPolicy?.providerKeywords ?? [],
    writeVerbs: policy.externalActionPolicy?.writeVerbs ?? DEFAULT_POLICY.externalActionPolicy?.writeVerbs ?? [],
    safeVerbs: policy.externalActionPolicy?.safeVerbs ?? DEFAULT_POLICY.externalActionPolicy?.safeVerbs ?? []
  };
}

function finalGateConfig(policy: BasePolicy): Required<FinalGateConfig> {
  return {
    defaultMode: policy.finalGate?.defaultMode ?? DEFAULT_POLICY.finalGate?.defaultMode ?? "enforce",
    requireTaskContract: policy.finalGate?.requireTaskContract ?? true,
    requireContextManifest: policy.finalGate?.requireContextManifest ?? true,
    requireVerifyEvidence: policy.finalGate?.requireVerifyEvidence ?? true,
    requireTrace: policy.finalGate?.requireTrace ?? true,
    requirePassingVerify: policy.finalGate?.requirePassingVerify ?? true
  };
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numberValue)));
}

function normalizeFieldGuidePath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = normalizePathCandidate(value.trim());
  if (
    normalized.length === 0
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
    || /[*?[\]{}]/.test(normalized)
  ) return fallback;
  return normalized;
}

function normalizeOrchestrationMode(value: unknown, fallback: OrchestrationMode): OrchestrationMode {
  return typeof value === "string" && (ORCHESTRATION_MODES as readonly string[]).includes(value)
    ? value as OrchestrationMode
    : fallback;
}

function normalizeReviewLenses(values: unknown, fallback: ReviewLens[]): ReviewLens[] {
  if (!Array.isArray(values)) return fallback;
  const result = values.filter((value): value is ReviewLens => (
    typeof value === "string" && (REVIEW_LENSES as readonly string[]).includes(value)
  ));
  return result.length ? [...new Set(result)] : fallback;
}

function normalizeRole(value: unknown): OrchestrationRole {
  return typeof value === "string" && (ORCHESTRATION_ROLES as readonly string[]).includes(value)
    ? value as OrchestrationRole
    : "parent";
}

function normalizeStepMode(value: unknown, role: OrchestrationRole): WorkPlanStep["mode"] {
  if (value === "read-only" || value === "single-writer" || value === "review") return value;
  if (role === "piagent-worker") return "single-writer";
  if (role === "piagent-reviewer" || role === "piagent-oracle") return "review";
  return "read-only";
}

function resolveOrchestrationPolicy(profile: ProjectProfile, policy: BasePolicy): ResolvedOrchestrationPolicy {
  const configured = {
    ...(policy.orchestrationPolicy ?? {}),
    ...(profile.orchestration ?? {})
  };
  const defaultPolicy = DEFAULT_ORCHESTRATION_POLICY;
  const fieldGuide = {
    ...defaultPolicy.fieldGuide,
    ...(policy.orchestrationPolicy?.fieldGuide ?? {}),
    ...(profile.orchestration?.fieldGuide ?? {})
  };
  const roleModelGuidance = {
    ...defaultPolicy.roleModelGuidance,
    ...(policy.orchestrationPolicy?.roleModelGuidance ?? {}),
    ...(profile.orchestration?.roleModelGuidance ?? {})
  };
  return {
    defaultMode: normalizeOrchestrationMode(configured.defaultMode, defaultPolicy.defaultMode),
    maxConcurrentSubagents: boundedInteger(configured.maxConcurrentSubagents, defaultPolicy.maxConcurrentSubagents, 0, 6),
    defaultReviewLenses: normalizeReviewLenses(configured.defaultReviewLenses, defaultPolicy.defaultReviewLenses),
    roleModelGuidance,
    fieldGuide: {
      enabled: fieldGuide.enabled !== false,
      path: normalizeFieldGuidePath(fieldGuide.path, defaultPolicy.fieldGuide.path),
      maxLines: boundedInteger(fieldGuide.maxLines, defaultPolicy.fieldGuide.maxLines, 0, 200),
      writePolicy: fieldGuide.writePolicy === "approved-workflow" ? "approved-workflow" : "explicit-only",
      readBeforeTask: fieldGuide.readBeforeTask !== false
    },
    rules: defaultPolicy.rules
  };
}

function normalizeWorkPlanSteps(values: unknown): WorkPlanStep[] {
  if (!Array.isArray(values)) return [];
  const steps: WorkPlanStep[] = [];
  for (const value of values.slice(0, 12)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const id = typeof item.id === "string" ? safeTaskId(item.id).slice(0, 40) : "";
    const title = typeof item.title === "string" ? redactText(item.title).trim().slice(0, 160) : "";
    if (!id || !title) continue;
    const role = normalizeRole(item.role);
    steps.push({
      id,
      title,
      role,
      mode: normalizeStepMode(item.mode, role),
      status: item.status === "in-progress" || item.status === "done" || item.status === "skipped" || item.status === "failed" ? item.status : "pending",
      dependsOn: Array.isArray(item.dependsOn) ? uniqueStrings(item.dependsOn.filter((entry): entry is string => typeof entry === "string").map((entry) => safeTaskId(entry).slice(0, 40))) : undefined,
      note: typeof item.note === "string" ? redactText(item.note).slice(0, 500) : undefined,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined
    });
  }
  return steps;
}

function defaultWorkPlan(
  summary: string,
  riskLane: TaskContract["riskLane"],
  changeMode: TaskContract["changeMode"]
): WorkPlanStep[] {
  if (changeMode === "read-only") {
    if (riskLane === "tiny") {
      return [{
        id: "scout",
        title: summary.slice(0, 160) || "Inspect the bounded target read-only.",
        role: "parent",
        mode: "read-only",
        status: "pending"
      }];
    }
    const readOnlySteps: WorkPlanStep[] = [
      {
        id: "scout",
        title: summary.slice(0, 160) || "Inspect the bounded target read-only.",
        role: "parent",
        mode: "read-only",
        status: "pending"
      },
      {
        id: "review",
        title: "Review cited evidence, risks, and unknowns before handoff.",
        role: "piagent-reviewer",
        mode: "review",
        status: "pending",
        dependsOn: ["scout"]
      }
    ];
    if (riskLane === "high-risk") {
      readOnlySteps.unshift({
        id: "scope",
        title: "Confirm the high-risk read-only scope and evidence boundaries.",
        role: "parent",
        mode: "read-only",
        status: "pending"
      });
      readOnlySteps.splice(1, 0, {
        id: "challenge",
        title: "Challenge security, data, release, or architecture assumptions.",
        role: "piagent-oracle",
        mode: "review",
        status: "pending",
        dependsOn: ["scope"]
      });
      const scout = readOnlySteps.find((step) => step.id === "scout");
      if (scout) scout.dependsOn = ["scope", "challenge"];
    }
    return readOnlySteps;
  }
  if (riskLane === "tiny") {
    return [
      {
        id: "implement",
        title: summary.slice(0, 160) || "Implement the approved bounded change.",
        role: "parent",
        mode: "single-writer",
        status: "pending"
      },
      {
        id: "verify",
        title: "Review the changed files and record exact verification evidence.",
        role: "parent",
        mode: "review",
        status: "pending",
        dependsOn: ["implement"]
      }
    ];
  }
  const steps: WorkPlanStep[] = [
    {
      id: "plan",
      title: "Confirm scope, context, acceptance criteria, and verify gate before editing.",
      role: "parent",
      mode: "read-only",
      status: "pending"
    },
    {
      id: "implement",
      title: summary.slice(0, 160) || "Implement the approved bounded change.",
      role: "parent",
      mode: "single-writer",
      status: "pending",
      dependsOn: ["plan"]
    },
    {
      id: "review",
      title: "Run explicit review lenses against the diff and verify evidence.",
      role: "piagent-reviewer",
      mode: "review",
      status: "pending",
      dependsOn: ["implement"]
    }
  ];
  if (riskLane === "high-risk") {
    steps.splice(1, 0, {
      id: "challenge",
      title: "Challenge architecture, security, release, or data risk before implementation.",
      role: "piagent-oracle",
      mode: "review",
      status: "pending",
      dependsOn: ["plan"]
    });
    const implementStep = steps.find((step) => step.id === "implement");
    if (implementStep) implementStep.dependsOn = ["plan", "challenge"];
  }
  return steps;
}

function validateNewWorkPlan(steps: WorkPlanStep[]): string | undefined {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) return `duplicate work-plan step id: ${step.id}`;
    if (step.status !== "pending") return `new work-plan step ${step.id} must start pending`;
    ids.add(step.id);
  }
  return workPlanDependencyError(steps)?.replace(/^workPlan/, "work-plan");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function classifyExternalAction(toolName: string, input: Record<string, unknown>, policy: BasePolicy): {
  decision: "not-external" | "safe-read" | "confirm";
  provider?: string;
  action?: string;
  evidence: string[];
} {
  const config = externalActionPolicyConfig(policy);
  if (config.defaultMode === "advisory") return { decision: "not-external", evidence: [] };

  const walked = walkStringInputs(input).items;
  const providerValues = walked.filter((item) => /(?:^|\.)(?:provider|server)$/i.test(item.field));
  const actionValues = walked.filter((item) => /(?:^|\.)(?:action|operation|method|type|tool)$/i.test(item.field));
  const proxyToolValues = walked.filter((item) => item.field === "tool");
  const isMcpProxy = normalizeActionToken(toolName) === "mcp";
  const proxyTool = isMcpProxy ? proxyToolValues.map((item) => item.value.trim()).find(Boolean) : undefined;
  const proxyAction = isMcpProxy && typeof input.action === "string" ? input.action.trim() : "";
  if (isMcpProxy && !proxyTool && !proxyAction) return { decision: "not-external", evidence: [toolName] };
  if (isMcpProxy && !proxyTool && normalizeActionToken(proxyAction) === "ui-messages") {
    return { decision: "safe-read", provider: "mcp-proxy", action: "ui-messages", evidence: [toolName, proxyAction] };
  }

  const providerEvidence = [toolName, ...providerValues.map((item) => item.value), ...proxyToolValues.map((item) => item.value)];
  const configuredProvider = config.providerKeywords.find((candidate) => actionTextMatchesAny(providerEvidence.join(" "), [candidate]));
  const mcpMatch = toolName.match(/^mcp(?:__|[-_:]+)([^_:.-]+)/i);
  const explicitProvider = providerValues.map((item) => item.value.trim()).find(Boolean);
  const provider = explicitProvider ?? configuredProvider ?? mcpMatch?.[1] ?? (isMcpProxy ? "mcp-proxy" : undefined);
  const evidence = [toolName, ...providerValues.map((item) => item.value), ...actionValues.map((item) => item.value)].slice(0, 8);
  if (!provider) return { decision: "not-external", evidence };

  const explicitAction = classifyExplicitActionValues(actionValues.map((item) => item.value), config);
  const toolAction = classifyToolNameAction(toolName, provider, config);
  const classification = explicitAction?.kind === "write"
    ? explicitAction
    : toolAction.kind === "write"
      ? toolAction
      : explicitAction ?? toolAction;
  return { decision: classification.decision, provider, action: classification.action, evidence };
}

type PreparedToolInput = {
  input: Record<string, unknown>;
  proxyArgs?: Record<string, unknown>;
  proxyTool?: string;
  proxyToolName?: string;
  proxyAction?: ActionClassification;
  proxyShellCarrier?: boolean;
  confirmationSummary?: string;
  reason?: string;
};

function isMcpProxyShellCarrier(proxyTool: string, proxyArgs: Record<string, unknown>, provider: string): boolean {
  if (Object.hasOwn(proxyArgs, "command") || Object.hasOwn(proxyArgs, "cmd")) return true;
  if (!Array.isArray(proxyArgs.args)) return false;
  const tokens = new Set(actionTokens(proxyTool));
  const providerTokens = new Set(actionTokens(provider));
  return providerTokens.has("shell")
    || providerTokens.has("terminal")
    || tokens.has("bash")
    || tokens.has("shell")
    || tokens.has("terminal")
    || tokens.has("run")
    || (tokens.has("execute") && (tokens.has("command") || tokens.has("process")));
}

function collectPatchTargetPaths(value: unknown, key = "", depth = 0): string[] {
  if (depth > MAX_TOOL_INPUT_INSPECTION_DEPTH || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectPatchTargetPaths(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([childKey, child]) => collectPatchTargetPaths(child, childKey, depth + 1));
  }
  if (typeof value !== "string" || !/(?:patch|diff|content|text)/i.test(key)) return [];

  const paths: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const marker = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/)
      ?? line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (marker?.[1]) paths.push(marker[1]);
    const unified = line.match(/^(?:---|\+\+\+)\s+([^\t ]+)/);
    if (unified?.[1] && unified[1] !== "/dev/null") paths.push(unified[1].replace(/^[ab]\//, ""));
  }
  return paths;
}

function taskMutationIdentity(toolName: string, input: Record<string, unknown>): string {
  if (normalizeActionToken(toolName) !== "mcp") return toolName;
  const proxyTool = typeof input.tool === "string" ? input.tool.trim() : "";
  return proxyTool || toolName;
}

function isTaskMutationTool(toolName: string, input: Record<string, unknown>): boolean {
  if (isPiagentTool(toolName)) return false;
  if (WRITE_TOOL_NAMES.has(toolName) || SHELL_TOOL_NAMES.has(toolName)) return true;
  const tokens = new Set(actionTokens(taskMutationIdentity(toolName, input)));
  return ["write", "edit", "patch", "create", "delete", "remove", "move", "rename", "update", "apply"]
    .some((token) => tokens.has(token));
}

function isReadOnlyTaskShellCommand(
  command: string,
  segments: Array<{ words: string[] }>
): boolean {
  if (/[<>]|`|\$\(/.test(command)) {
    return false;
  }
  const safeCommands = new Set(["pwd", "ls", "find", "rg", "grep", "cat", "sed", "head", "tail", "wc", "stat", "file", "test", "[", "which"]);
  const safeGitSubcommands = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse"]);
  return segments.length > 0 && segments.every((segment) => {
    const words = segment.words.filter(Boolean);
    const executable = path.basename(words[0] ?? "");
    if (executable === "sed" && words.some((word) => /^-.*i/.test(word))) return false;
    if (executable === "find" && words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(word))) return false;
    if (safeCommands.has(executable)) return true;
    if (executable === "git") return safeGitSubcommands.has(words[1] ?? "");
    if (executable === "command") return words[1] === "-v";
    return false;
  });
}

const PROJECT_MUTATING_EXECUTABLES = new Set([
  "apply_patch", "bash", "chmod", "chown", "cp", "dd", "install", "ln", "make", "mkdir", "mv", "prename", "rename",
  "node", "patch", "perl", "php", "python", "python3", "rm", "rmdir", "rsync", "ruby", "scp", "sh",
  "tee", "touch", "truncate", "zsh"
]);

function isProjectMutatingShellCommand(command: string, segments: Array<{ words: string[] }>): boolean {
  if (shellHasFileWriteRedirection(command)) return true;
  const noAliases = new Map<string, string>();
  for (const segment of segments) {
    const words = segment.words.filter(Boolean);
    if (words.length === 0) continue;
    if (externalExecutableIndex(words, PROJECT_MUTATING_EXECUTABLES, noAliases) !== undefined) return true;
    const executable = path.basename(words[0] ?? "").toLowerCase();
    if (executable === "find" && words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(word))) return true;
    if (executable === "sed" && words.some((word) => /^-[^-]*i/.test(word) || word === "--in-place" || word.startsWith("--in-place="))) return true;
    if (executable === "git") {
      const subcommand = words.slice(1).find((word, index, values) => {
        if (!word.startsWith("-")) return index === 0 || !["-C", "-c", "--git-dir", "--work-tree"].includes(values[index - 1]);
        return false;
      });
      if (["apply", "checkout", "clean", "mv", "reset", "restore", "rm", "switch"].includes(subcommand ?? "")) return true;
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
      const subcommand = words.find((word, index) => index > 0 && !word.startsWith("-"));
      if (["add", "ci", "install", "link", "remove", "uninstall", "update", "upgrade"].includes(subcommand ?? "")) return true;
    }
  }
  return false;
}

const EXPLICIT_SHELL_MUTATORS = new Set([
  "apply_patch", "chmod", "chown", "cp", "dd", "install", "ln", "mkdir", "mv", "patch", "prename", "rename",
  "rm", "rmdir", "rsync", "scp", "tee", "touch", "truncate"
]);

function opaqueShellMutationNeedsBoundedTarget(
  command: string,
  segments: Array<{ words: string[] }>
): boolean {
  if (segments.some((segment) => {
    const words = segment.words.filter(Boolean);
    const executable = path.basename(words[0] ?? "").toLowerCase();
    if (EXPLICIT_SHELL_MUTATORS.has(executable)) return true;
    if (executable === "find" && words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(word))) return true;
    if (executable === "sed" && words.some((word) => /^-[^-]*i/.test(word) || word === "--in-place" || word.startsWith("--in-place="))) return true;
    if (executable === "git") {
      return words.some((word) => ["apply", "checkout", "clean", "mv", "reset", "restore", "rm", "switch"].includes(word));
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
      return words.some((word) => ["add", "ci", "install", "link", "remove", "uninstall", "update", "upgrade"].includes(word));
    }
    return false;
  })) return true;
  // Interpreter and build commands are conservatively snapshotted after the
  // call, but ordinary tests/checks must remain usable. Only an inline script
  // with a recognizable write primitive is an opaque pre-call mutation.
  return shellHasOpaqueWritePrimitive(command);
}

function shellHasOpaqueWritePrimitive(command: string): boolean {
  return /\b(?:appendFile(?:Sync)?|copyFile(?:Sync)?|mkdir(?:Sync)?|rename(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|truncate(?:Sync)?|unlink(?:Sync)?|writeFile(?:Sync)?)\s*\(|\bopen\s*\([^\n)]*,\s*["'][wax+]/i.test(command);
}

function taskMutationTargets(cwd: string, toolName: string, input: Record<string, unknown>): string[] {
  if (!isTaskMutationTool(toolName, input) || SHELL_TOOL_NAMES.has(toolName)) return [];
  const identity = taskMutationIdentity(toolName, input);
  const collectWritePaths = (value: Record<string, unknown>, valueIdentity: string) => {
    const strongFilesystemSemantics = usesFilesystemContentFields(valueIdentity, false);
    return inspectPathInputsFromInput(cwd, value, strongFilesystemSemantics).paths
      .filter((item) => isFilesystemScopeField(item.field))
      .filter((item) => {
        const field = item.field.split(".").at(-1)?.toLowerCase().replace(/[-_]/g, "") ?? "";
        return strongFilesystemSemantics || !COPY_SOURCE_FIELDS.has(field);
      })
      .filter((item) => filesystemFieldAccessMode(valueIdentity, item.field, true) === "write")
      .map((item) => item.path);
  };
  const rawTargets = [
    ...collectWritePaths(input, identity),
    ...collectPatchTargetPaths(input)
  ];
  if (typeof input.args === "string" && input.args.length <= MAX_MCP_PROXY_ARGS_CHARS) {
    try {
      const parsed = JSON.parse(input.args);
      if (isPlainRecord(parsed)) rawTargets.push(...collectWritePaths(parsed, identity));
      rawTargets.push(...collectPatchTargetPaths(parsed));
    } catch {
      // Invalid proxy JSON is blocked before execution; it contributes no evidence.
    }
  }
  return uniqueStrings(rawTargets
    .map((candidate) => normalizeRelative(cwd, candidate))
    .filter((candidate): candidate is string => Boolean(
      candidate
      && candidate !== "."
      && candidate !== ".."
      && !candidate.startsWith("../")
      && !candidate.startsWith(".pi/piagent-state/")
    )));
}

function observedTaskContextFromToolResult(
  cwd: string,
  event: { toolName: string; input?: unknown; isError?: boolean },
  readProtectedPaths: string[]
): ObservedTaskContext | undefined {
  if (event.isError || !["read", "piagent_document_read"].includes(event.toolName)) return undefined;
  const input = isPlainRecord(event.input) ? event.input : {};
  const relative = extractLikelyPathFromInput(cwd, input);
  if (
    !relative
    || relative === "."
    || relative === ".."
    || relative.startsWith("../")
    || relative.startsWith(".pi/piagent-state/")
    || matchesProtectedPath(relative, readProtectedPaths)
  ) return undefined;
  try {
    if (!fs.statSync(path.join(cwd, relative)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return {
    path: relative,
    reason: event.toolName === "read" ? "Runtime observed successful source read." : "Runtime observed successful document read."
  };
}

function recordObservedTaskChanges(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: { toolName: string; input?: unknown; isError?: boolean },
  pendingContext: ObservedTaskContext[],
  maxManifestFiles: number,
  shellSnapshotBefore?: Record<string, string>,
  eventTree?: ReturnType<typeof workingTreeObservation>
): TaskContract | undefined {
  if (event.isError) return;
  const input = isPlainRecord(event.input) ? event.input : {};
  if (!isTaskMutationTool(event.toolName, input)) return;
  const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
  if (!task || task.trace.outcome !== "pending") return;

  const targets = taskMutationTargets(ctx.cwd, event.toolName, input);
  if (!eventTree) return;
  const eventSnapshot = eventTree.snapshot as Record<string, string>;
  const shellMutationObserved = SHELL_TOOL_NAMES.has(event.toolName) && shellSnapshotBefore !== undefined;
  const shellChangedFiles = shellMutationObserved
    ? changedSnapshotFiles(shellSnapshotBefore, eventSnapshot)
    : [];
  const nextObserved = uniqueStrings([...task.observedChangedFiles, ...shellChangedFiles, ...targets]).sort();
  const added = nextObserved.filter((file) => !task.observedChangedFiles.includes(file));
  const contextAdded = mergeObservedTaskContext(task, pendingContext, maxManifestFiles, redactText);
  const mutationObserved = targets.length > 0 || shellChangedFiles.length > 0;
  const lifecycle = mutationObserved
    ? applyRuntimeLifecycleObservation(task, "mutation", nowIso())
    : { changed: false, mode: runtimeLifecycleMode(task) };
  const acceptanceInvalidation = mutationObserved
    ? invalidateAcceptanceReceiptAfterMutation(task, nowIso())
    : { task, changed: false };
  task.acceptanceReceipt = acceptanceInvalidation.task.acceptanceReceipt;
  if (added.length === 0 && contextAdded.length === 0 && !lifecycle.changed && !acceptanceInvalidation.changed) return;
  task.observedChangedFiles = nextObserved;
  const written = writeTask(ctx.cwd, task);
  const trace = {
    event: "task_changes_observed",
    taskId: written.taskId,
    taskRunId: written.taskRunId,
    sessionId: written.sessionId,
    toolName: event.toolName,
    files: added,
    contextFiles: contextAdded,
    lifecycleMode: lifecycle.mode,
    lifecycleAdvanced: lifecycle.changed
  };
  appendTrace(ctx.cwd, trace);
  appendSessionTrace(pi, trace);
  recordMutationCheckpoint(ctx, written, {
    toolName: event.toolName,
    files: added,
    contextFiles: contextAdded,
    lifecycleMode: lifecycle.mode
  });
  return written;
}

function recordObservedTaskVerification(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  observed: {
    command?: string;
    normalizedCommand?: string;
    commandHash?: string;
    exitCode?: number;
    isError?: boolean;
    recordedAt?: string;
    outputText?: string;
    toolCallId?: string;
  },
  pendingContext: ObservedTaskContext[],
  maxManifestFiles: number, shellSnapshotBefore?: Record<string, string>,
  eventTree?: ReturnType<typeof workingTreeObservation>,
  readProtectedPaths: string[] = []
): TaskContract | undefined {
  const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
  if (!task || task.trace.outcome !== "pending") return;
  const command = String(observed.normalizedCommand ?? observed.command ?? "").trim();
  const observedAtMs = Date.parse(observed.recordedAt ?? "");
  const taskCreatedAtMs = Date.parse(task.createdAt);
  if (
    !command
    || !observed.commandHash
    || !commandMatchesVerifyPlan(command, task.verifyCommands)
    || !Number.isFinite(observedAtMs)
    || !Number.isFinite(taskCreatedAtMs)
    || observedAtMs < taskCreatedAtMs
  ) return;

  if (!eventTree?.proofCapable) return;
  const currentDigests = eventTree.snapshot as Record<string, string>;
  const currentDigest = eventTree.digest;
  const preWorkingTreeDigest = shellSnapshotBefore && workingTreeSnapshotUsesCurrentAlgorithm(shellSnapshotBefore) ? workingTreeEvidenceDigest(shellSnapshotBefore) : undefined;
  const exitCode = Number.isInteger(observed.exitCode) ? observed.exitCode as number : observed.isError ? 1 : 0;
  const classification = classifyVerificationFailure(observed.outputText, exitCode);
  const duplicate = task.verifyEvidence.some((evidence) => (
    evidence.command.trim() === command
    && evidence.exitCode === exitCode
    && evidence.workingTreeDigest === currentDigest && evidence.observedAt === observed.recordedAt
  ));
  const contextAdded = mergeObservedTaskContext(task, pendingContext, maxManifestFiles, redactText);
  if (!duplicate) {
    const evidenceRecordedAt = nowIso();
    const observedAt = observed.recordedAt ?? evidenceRecordedAt;
    task.verifyEvidence.push({
      command: redactText(command),
      exitCode,
      summary: `Runtime observed configured verifier exit ${exitCode} (${classification.category}${classification.retryable ? ", retryable" : ""}).`,
      recordedAt: evidenceRecordedAt,
      observed: true,
      observedAt,
      isError: observed.isError === true,
      matchedProfileCommand: true,
      preWorkingTreeDigest,
      workingTreeDigest: currentDigest
    });
    task.verifyEvidence = task.verifyEvidence.slice(-100);
    try {
      captureVerifierFileSnapshot({
        projectRoot: ctx.cwd, taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
        toolCallId: observed.toolCallId ?? "", commandHash: observed.commandHash, observedAt,
        capturedAt: evidenceRecordedAt, exitCode, treeDigest: currentDigest, snapshot: currentDigests,
        protectedPaths: readProtectedPaths
      });
    } catch (error) {
      ctx.ui.notify(`Piagent could not persist verifier file snapshot: ${error instanceof Error ? error.message : String(error)}`, "warn");
    }
  }

  const hasChanges = taskChangedFileEvidence(ctx.cwd, task, currentDigests).expected.length > 0;
  const allPassing = hasChanges && allVerifyCommandsPassCurrentTree(task, currentDigest);
  const lifecycle = hasChanges
    ? applyRuntimeLifecycleObservation(task, allPassing ? "verification-complete" : "verification-pending", nowIso())
    : { changed: false, mode: runtimeLifecycleMode(task) };
  const acceptance = refreshAcceptanceReceipt(task, {
    cwd: ctx.cwd,
    changedFiles: taskChangedFileEvidence(ctx.cwd, task, currentDigests).expected,
    currentWorkingTreeDigest: currentDigest
  });
  task.acceptanceReceipt = acceptance.task.acceptanceReceipt;
  if (!task.workingTreeDigestMigration || (shellSnapshotBefore && changedSnapshotFiles(shellSnapshotBefore, currentDigests).length === 0)) Object.assign(task, completeTaskDigestRefresh(task, currentDigest));
  if (duplicate && contextAdded.length === 0 && !lifecycle.changed) return task;

  const written = writeTask(ctx.cwd, task);
  const trace = {
    event: "verify_observed",
    taskId: written.taskId,
    taskRunId: written.taskRunId,
    sessionId: written.sessionId,
    command: redactText(command),
    exitCode,
    workingTreeDigest: currentDigest,
    contextFiles: contextAdded,
    lifecycleMode: lifecycle.mode,
    lifecycleAdvanced: lifecycle.changed,
    allConfiguredVerifiersPassing: allPassing
  };
  appendTrace(ctx.cwd, trace);
  appendSessionTrace(pi, trace);
  recordVerificationCheckpoint(ctx, written, {
    commandHash: observed.commandHash, observedAt: observed.recordedAt,
    workingTreeDigest: currentDigest,
    exitCode,
    evidence: {
      command: redactText(command),
      exitCode,
      category: classification.category,
      retryable: classification.retryable,
      failureClassification: classification,
      preWorkingTreeDigest,
      workingTreeDigest: currentDigest
    }
  });
  return written;
}

function flushObservedTaskContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pendingContext: ObservedTaskContext[],
  maxManifestFiles: number,
  event: string
): TaskContract | undefined {
  const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
  if (!task || task.trace.outcome !== "pending") return task;
  const added = mergeObservedTaskContext(task, pendingContext, maxManifestFiles, redactText);
  const lifecycle = task.changeMode === "read-only" && task.contextManifest.length > 0
    ? applyRuntimeLifecycleObservation(task, "context-complete", nowIso())
    : { changed: false, mode: runtimeLifecycleMode(task) };
  if (added.length === 0 && !lifecycle.changed) return task;
  const written = writeTask(ctx.cwd, task);
  const trace = {
    event,
    taskId: written.taskId,
    taskRunId: written.taskRunId,
    sessionId: written.sessionId,
    files: added,
    lifecycleMode: lifecycle.mode,
    lifecycleAdvanced: lifecycle.changed
  };
  appendTrace(ctx.cwd, trace);
  appendSessionTrace(pi, trace);
  return written;
}

function completionTaskProjection(
  cwd: string,
  task: TaskContract,
  finalFileDigests: Record<string, string> = workingTreeSnapshot(cwd) as Record<string, string>
): TaskContract {
  const changedFiles = taskChangedFileEvidence(cwd, task, finalFileDigests).expected;
  const projected = {
    ...task,
    changedFiles,
    finalWorkingTreeFiles: Object.keys(finalFileDigests).sort(),
    finalFileDigests,
    failedAt: undefined,
    failureReason: undefined,
    ruledOut: undefined,
    trace: {
      outcome: "completed",
      notes: "Runtime finalized from observed context, working-tree changes, current verification, and completed work-plan evidence.",
      recordedAt: nowIso()
    }
  };
  return refreshAcceptanceReceipt(projected, {
    cwd,
    changedFiles,
    currentWorkingTreeDigest: workingTreeEvidenceDigest(finalFileDigests)
  }).task as TaskContract;
}

function prepareToolInputForPolicy(
  toolName: string,
  input: Record<string, unknown>,
  policy: BasePolicy
): PreparedToolInput {
  if (normalizeActionToken(toolName) !== "mcp") return { input };

  const proxyTool = typeof input.tool === "string" ? input.tool.trim() : "";
  if (Object.hasOwn(input, "tool") && input.tool !== undefined && typeof input.tool !== "string") {
    return { input, reason: "MCP proxy tool must be a string" };
  }

  let policyInput = input;
  if (Object.hasOwn(input, "args") && input.args !== undefined && input.args !== "") {
    if (typeof input.args !== "string") return { input, reason: "MCP proxy args must be a JSON object string" };
    if (input.args.length > MAX_MCP_PROXY_ARGS_CHARS) {
      return { input, reason: `MCP proxy args exceed ${MAX_MCP_PROXY_ARGS_CHARS} characters` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.args);
    } catch {
      return { input, reason: "MCP proxy args must be valid JSON" };
    }
    if (!isPlainRecord(parsed)) return { input, reason: "MCP proxy args must decode to a JSON object" };
    const patchTargets = actionTokens(proxyTool).includes("patch")
      ? collectPatchTargetPaths(parsed)
      : [];
    policyInput = patchTargets.length > 0
      ? { ...input, proxyArgs: parsed, proxyPatchTargets: { paths: patchTargets } }
      : { ...input, proxyArgs: parsed };
    const summary = redactText(JSON.stringify(parsed)).replace(/\s+/g, " ");
    const confirmationSummary = summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
    if (!proxyTool) return { input: policyInput, proxyArgs: parsed, confirmationSummary };

    const provider = typeof input.server === "string" && input.server.trim() ? input.server.trim() : "mcp-proxy";
    const proxyShellCarrier = isMcpProxyShellCarrier(proxyTool, parsed, provider);
    const classifiedAction = classifyActionTokenSequence(actionTokens(proxyTool), externalActionPolicyConfig(policy));
    return {
      input: policyInput,
      proxyArgs: parsed,
      proxyTool,
      proxyToolName: `${provider}_${proxyTool}`,
      proxyAction: proxyShellCarrier
        ? { decision: "confirm", kind: "ambiguous", action: "shell-command" }
        : classifiedAction,
      proxyShellCarrier,
      confirmationSummary
    };
  }

  if (!proxyTool) return { input: policyInput };
  const provider = typeof input.server === "string" && input.server.trim() ? input.server.trim() : "mcp-proxy";
  return {
    input: policyInput,
    proxyTool,
    proxyToolName: `${provider}_${proxyTool}`,
    proxyAction: classifyActionTokenSequence(actionTokens(proxyTool), externalActionPolicyConfig(policy))
  };
}

// Which MCP server a tool call is addressed to. The adapter exposes one proxy
// tool named `mcp` that carries the server in `input.server`, and, under
// directTools, one tool per server tool named `<prefix>_<tool>` where the prefix
// is derived from the server name. Direct names are matched against the servers
// this gate is holding rather than against a fixed pattern, because the prefix
// is the server's own name and there is nothing constant to anchor on.
function mcpServerFromToolCall(
  toolName: string,
  input: Record<string, unknown>,
  candidates: Iterable<string>
): string | undefined {
  if (normalizeActionToken(toolName) === "mcp") {
    return typeof input.server === "string" && input.server.trim() ? input.server.trim() : undefined;
  }
  return attributeDirectTool(toolName, candidates);
}

// Servers a repository defines are not usable until somebody on this machine has
// approved them. This is the enforcement point: the adapter owns the connection
// and this extension cannot prevent one being opened, but no tool call reaches an
// unapproved server. The residual exposure is the connection itself, which is
// worth stating plainly rather than describing this as a full block.
//
// Recomputed only when one of the files behind the decision changes, because
// this runs on every tool call.
interface RepositoryMcpGate {
  blocked: Map<string, { state: string; origin: string }>; serverNames: Set<string>;
  // Conditions under which no tool call can be checked at all, each with the
  // sentence to show. These are not "a server is unapproved" — they are "this
  // repository's config has put the gate in a state where it cannot tell which
  // server a call belongs to", and the only sound answer to that is to stop.
  unverifiable: string[];
}

const mcpApprovalCache = new Map<string, { signature: string; gate: RepositoryMcpGate }>();

function repositoryMcpGate(cwd: string): RepositoryMcpGate {
  // Repository scopes plus anything an `imports` key drags in from a file the
  // clone carries. Collecting those here is the whole point: a server the gate
  // never enumerates is a server it silently permits.
  const servers = collectServers({ projectPath: cwd, scopes: [...REPOSITORY_SCOPES] });
  const repositoryFiles = [...REPOSITORY_SCOPES].map((scope) => ({
    scope,
    file: configPathForScope(scope, { projectPath: cwd })
  }));
  // Every file the decision reads, listed by the module that reads them rather
  // than restated here. Building this by hand is what went wrong: the scan grew
  // to read merged settings from all four scopes and to stat import targets
  // outside the repository, the hand-written list did not, and an already-loaded
  // guard went on permitting calls after a personal global config had put the
  // session in the state this gate exists to refuse.
  const signature = [
    ...servers.map((server) => `${server.origin}:${server.name}:${fileSignature(server.file)}`),
    ...repositoryFiles.map((layer) => `layer:${layer.scope}:${fileSignature(layer.file)}`),
    ...mcpDecisionInputs({ projectPath: cwd }).map((file) => `input:${file}:${fileSignature(file)}`),
    `store:${fileSignature(path.join(os.homedir(), ".pi", "piagent-mcp-approvals.json"))}`
  ].join("|");
  const cached = mcpApprovalCache.get(cwd);
  if (cached?.signature === signature) return cached.gate;

  const blocked = new Map<string, { state: string; origin: string }>();
  for (const server of servers) {
    const state = approvalState({ projectPath: cwd, name: server.name, entry: server.entry });
    if (state.state === "approved") continue;
    // A name defined more than once keeps its blocking entry: the approved copy
    // does not vouch for the one nobody has looked at.
    blocked.set(server.name, { state: state.state, origin: server.origin });
  }

  // Two things a repository-carried config can do that leave nothing to check.
  //
  // It can ask for tools with no prefix, so a direct tool arrives under a bare
  // name carrying no evidence of its server. Refusing only the proxy there was
  // not a fix: the proxy is the one form that names its server, so blocking it
  // and allowing the bare names left the hole exactly where it was.
  //
  // It can also import a kind whose config this platform cannot enumerate, and
  // then the set of servers reaching the session is simply unknown. Blocking the
  // servers that could be listed says nothing about the ones that could not.
  //
  // Both stop every tool call. A repository can make a session refuse to run;
  // it must not be able to make one run a server nobody approved.
  // Read from the shared module rather than decided here, so `piagent-mcp
  // doctor` reports exactly what this refuses. The two disagreeing is how an
  // operator ends up reading "PASS" while every tool call is being stopped.
  const unverifiable = unverifiableMcpConfig({ projectPath: cwd }).map((problem) => problem.detail);

  const gate = { blocked, serverNames: new Set(servers.map((server) => server.name)), unverifiable };
  mcpApprovalCache.set(cwd, { signature, gate });
  return gate;
}

function fileSignature(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
}

function evaluateMcpApproval(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>
): { block: boolean; reason?: string } {
  const gate = repositoryMcpGate(cwd);

  // Every tool call, not only the ones that look like MCP. Under either of these
  // conditions a call cannot be traced to a server, so there is no such thing as
  // a call this gate can clear.
  if (gate.unverifiable.length > 0) {
    return { block: true, reason: `Blocked every tool call: ${gate.unverifiable.join(" ")}` };
  }

  const server = mcpServerFromToolCall(toolName, input, gate.blocked.keys());
  if (!server) return { block: false };
  const record = gate.blocked.get(server);
  if (!record) return { block: false };
  const explanation = record.state === "rejected"
    ? "it was rejected for this project"
    : record.state === "changed"
      ? "its definition changed since it was approved"
      : record.origin.startsWith("import:")
        ? `this repository imports it from ${record.origin.slice("import:".length)} config and nobody on this machine has approved it here`
        : "this repository defines it and nobody on this machine has approved it";
  return {
    block: true,
    // Named as commands, because this is read inside a session: the reader can
    // run these where they already are, without shelling out.
    reason:
      `Blocked MCP server ${server}: ${explanation}. ` +
      `Review it with \`/piagent-mcp get ${server}\`, then \`/piagent-mcp approve ${server}\` to allow it ` +
      `or \`/piagent-mcp reject ${server}\` to refuse it.`
  };
}

// A word whose final path segment glues literal text onto an expansion --
// `.en$(echo v)`, `${D}.env` -- names a file this process cannot know without
// running the substitution. Matching the literal half against the protected
// patterns answers a different question than the one being asked, so refuse
// rather than let an unknown filename through unchecked.
function evaluateMcpProxyShellProtectedAccess(
  cwd: string,
  prepared: PreparedToolInput,
  protectedPaths: string[]
): { block: boolean; reason?: string } {
  if (!prepared.proxyArgs || !prepared.proxyTool) return { block: false };
  if (!prepared.proxyShellCarrier) return { block: false };

  const shellInput = extractShellCommandInput(prepared.proxyArgs);
  if (!shellInput.command) {
    return { block: true, reason: `Blocked MCP shell carrier: ${shellInput.reason ?? "command is missing"}` };
  }
  const baseCommand = typeof prepared.proxyArgs.command === "string"
    ? prepared.proxyArgs.command
    : typeof prepared.proxyArgs.cmd === "string"
      ? prepared.proxyArgs.cmd
      : "";
  const rawArgs = Array.isArray(prepared.proxyArgs.args)
    ? prepared.proxyArgs.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const conservativeCommand = [baseCommand.trim(), ...rawArgs].filter(Boolean).join(" ") || shellInput.command;
  const command = normalizeShellCommandForPolicy(conservativeCommand);
  const protectedHit = findProtectedPathInCommand(command, protectedPaths);
  if (protectedHit) {
    return {
      block: true,
      reason: `MCP command touches protected path: ${protectedHit.candidate} matches ${protectedHit.pattern}`
    };
  }
  const protectedGlobHit = shellGlobTargetsProtectedPath(command, protectedPaths);
  if (protectedGlobHit) {
    return {
      block: true,
      reason: `MCP command glob can target protected path: ${protectedGlobHit.glob} can match ${protectedGlobHit.example} via ${protectedGlobHit.pattern}`
    };
  }
  const resolvedProtectedHit = findResolvedProtectedPathInCommand(cwd, command, protectedPaths);
  if (resolvedProtectedHit) {
    return {
      block: true,
      reason: `MCP command resolves to protected path: ${resolvedProtectedHit.candidate} resolves to ${resolvedProtectedHit.resolved} matching ${resolvedProtectedHit.pattern}`
    };
  }
  const unresolved = protectedPaths.length > 0 ? unresolvedPathExpansions(command) : [];
  if (unresolved.length > 0) {
    return { block: true, reason: unresolvedExpansionReason("MCP command", unresolved) };
  }
  return { block: false };
}

function projectFilePath(cwd: string, relativePath: string): string {
  const absolute = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return absolute;
}

function candidateFileBudget(cwd: string, rel: string, budget: Required<ContextBudgetConfig>): {
  path: string;
  exists: boolean;
  chars: number;
  overLimit: boolean;
  warn: boolean;
} {
  const absolute = projectFilePath(cwd, rel);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return { path: rel, exists: false, chars: 0, overLimit: false, warn: false };
  }
  const text = fs.readFileSync(absolute, "utf8");
  return {
    path: rel,
    exists: true,
    chars: text.length,
    overLimit: text.length > budget.maxContextFileChars,
    warn: text.length > budget.warnFragmentChars
  };
}

function memorySummaryPath(cwd: string, settings: Required<MemorySettings>): string {
  return projectFilePath(cwd, settings.summaryFile);
}

function memoryHandbookPath(cwd: string, settings: Required<MemorySettings>): string {
  return projectFilePath(cwd, settings.handbookFile);
}

function memoryLocalDir(cwd: string, settings: Required<MemorySettings>): string {
  return projectFilePath(cwd, settings.localDir);
}

function ensurePiGitignore(cwd: string): void {
  const target = path.join(cwd, ".pi", ".gitignore");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const required = [
    "memory/MEMORY.md",
    "memory/memory_summary.md",
    "memory/state.sqlite",
    "memory/raw_memories.md",
    "memory/rollout_summaries/",
    "memory/extensions/ad_hoc/",
    "memory/local/",
    "memory/.git/"
  ];
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const additions = required.filter((line) => !existing.split(/\r?\n/).includes(line));
  if (additions.length === 0) return;
  const prefix = existing.trimEnd();
  fs.writeFileSync(target, `${prefix ? `${prefix}\n` : ""}${additions.join("\n")}\n`);
}

function redactMemoryText(input: string): { text: string; redacted: boolean } {
  return redactSensitiveText(input);
}

function redactText(input: string): string {
  return redactSensitiveText(input).text;
}

function redactTextArray(input: string[] | undefined): string[] {
  return (input ?? []).map((item) => redactText(item));
}

function redactBoundedText(input: string | undefined, maxChars: number): string | undefined {
  if (typeof input !== "string") return undefined;
  return redactText(input).slice(0, maxChars);
}

function redactBoundedTextArray(input: unknown, maxItems: number, maxChars: number): string[] {
  return (Array.isArray(input) ? input : [])
    .filter((item): item is string => typeof item === "string")
    .slice(0, maxItems)
    .map((item) => redactText(item).slice(0, maxChars));
}

function ensureProjectMemoryFiles(cwd: string, settings: Required<MemorySettings>): void {
  ensurePiGitignore(cwd);
  const summaryPath = memorySummaryPath(cwd, settings);
  const handbookPath = memoryHandbookPath(cwd, settings);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(handbookPath), { recursive: true });
  fs.mkdirSync(memoryLocalDir(cwd, settings), { recursive: true });

  if (!fs.existsSync(summaryPath)) {
    fs.writeFileSync(summaryPath, [
      "v1",
      "",
      "# Memory Summary",
      "",
      "- Status: initialized",
      "- Scope: project",
      "- Policy: explicit durable notes only; repository files remain source of truth.",
      "",
      "Use this file as a compact memory index. Keep it short and update only with durable, verified context.",
      ""
    ].join("\n"));
  }

  if (!fs.existsSync(handbookPath)) {
    fs.writeFileSync(handbookPath, [
      "# Project Memory",
      "",
      "Durable project memory for Pi Agent Platform.",
      "",
      "Rules:",
      "",
      "- Store only stable preferences, decisions, project conventions, lessons, and open loops.",
      "- Do not store secrets, credentials, raw customer data, or large source excerpts.",
      "- Treat memory as hints; verify against the repository before editing.",
      "",
      "## Entries",
      ""
    ].join("\n"));
  }
}

function appendMemoryNote(cwd: string, profile: ProjectProfile, note: {
  category: string;
  title: string;
  content: string;
  source?: string;
}): { path: string; redacted: boolean } {
  const settings = resolveMemorySettings(profile);
  if (!settings.enabled || settings.mode === "off") {
    throw new Error("Project memory is disabled by profile.");
  }
  ensureProjectMemoryFiles(cwd, settings);
  const target = memoryHandbookPath(cwd, settings);
  const redacted = redactMemoryText(note.content);
  const title = redactText(note.title).trim().replace(/\s+/g, " ").slice(0, 120);
  const category = note.category.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "note";
  const source = note.source ? redactText(note.source).trim() : "";
  const entry = [
    "",
    `### ${title}`,
    "",
    `- Recorded: ${nowIso()}`,
    `- Category: ${category}`,
    `- Source: ${source || "explicit-user-request"}`,
    "",
    redacted.text.trim(),
    ""
  ].join("\n");
  fs.appendFileSync(target, entry);
  return { path: settings.handbookFile, redacted: redacted.redacted };
}

function readMemoryFiles(cwd: string, settings: Required<MemorySettings>): Array<{ rel: string; text: string }> {
  const files: Array<{ rel: string; text: string }> = [];
  for (const rel of [settings.summaryFile, settings.handbookFile]) {
    const absolute = projectFilePath(cwd, rel);
    if (fs.existsSync(absolute)) files.push({ rel, text: fs.readFileSync(absolute, "utf8") });
  }
  const localDir = memoryLocalDir(cwd, settings);
  if (fs.existsSync(localDir)) {
    for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const absolute = path.join(localDir, entry.name);
      files.push({
        rel: path.relative(cwd, absolute).split(path.sep).join("/"),
        text: fs.readFileSync(absolute, "utf8")
      });
    }
  }
  return files;
}

function searchMemoryFiles(cwd: string, profile: ProjectProfile, query: string, limit: number): Array<{ path: string; line: number; text: string }> {
  const settings = resolveMemorySettings(profile);
  if (!settings.enabled || settings.mode === "off") return [];
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of readMemoryFiles(cwd, settings)) {
    const lines = file.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle)) continue;
      matches.push({ path: file.rel, line: index + 1, text: lines[index].slice(0, 240) });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

function writeProjectOnboarding(cwd: string, snapshot: ProjectOnboardingSnapshot, markdown: string): ProjectOnboardingSnapshot {
  ensurePrivateStateDirectory(cwd, path.join(cwd, ".pi"), "Piagent project directory");
  ensureStateDirs(cwd);
  const safeSnapshot = redactForStorage(snapshot) as ProjectOnboardingSnapshot;
  const contextFile = resolveLocalStatePath(cwd, projectContextFilePath(cwd), { label: "Project context file" });
  const onboardingFile = resolveLocalStatePath(cwd, onboardingStateFilePath(cwd), { label: "Project onboarding state" });
  fs.writeFileSync(contextFile, `${redactText(markdown).trimEnd()}\n`);
  fs.writeFileSync(onboardingFile, `${JSON.stringify(safeSnapshot, null, 2)}\n`, { mode: 0o600 });
  return safeSnapshot;
}

function resolveContextIndexSettings(profile: ProjectProfile): Required<ContextIndexSettings> {
  const configured = profile.contextIndex ?? {};
  const maxNodes = Number.isFinite(configured.maxNodes) ? Math.max(1, Math.min(500, Math.trunc(configured.maxNodes ?? DEFAULT_CONTEXT_INDEX_SETTINGS.maxNodes))) : DEFAULT_CONTEXT_INDEX_SETTINGS.maxNodes;
  const maxEdges = Number.isFinite(configured.maxEdges) ? Math.max(0, Math.min(1000, Math.trunc(configured.maxEdges ?? DEFAULT_CONTEXT_INDEX_SETTINGS.maxEdges))) : DEFAULT_CONTEXT_INDEX_SETTINGS.maxEdges;
  return {
    ...DEFAULT_CONTEXT_INDEX_SETTINGS,
    ...configured,
    path: configured.path?.trim() || DEFAULT_CONTEXT_INDEX_SETTINGS.path,
    maxNodes,
    maxEdges
  };
}

function contextIndexPath(cwd: string, settings: Required<ContextIndexSettings>): string {
  return projectFilePath(cwd, settings.path);
}

function safeContextIndexId(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = raw
    .replace(/[^a-z0-9:_./-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return normalized || fallback;
}

function contextNodeId(kind: ContextIndexNodeKind, value: string | undefined): string {
  return `${kind}:${safeTaskId(value || kind)}`;
}

const CONTEXT_INDEX_UNTRUSTED_INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:prior|previous|above|earlier|system|developer)\s+(?:rules|instructions|messages|prompts?)\b/gi,
  /\b(?:system|developer)\s+(?:prompt|message|instruction)s?\b/gi,
  /\bexfiltrat(?:e|es|ed|ing|ion)\b[^\n]*/gi,
  /\b(?:send|upload|post|curl|wget)\b[^\n]{0,180}\b(?:\.env|auth\.json|secret|secrets|token|credential|credentials|api[-_ ]?key)\b[^\n]*/gi
];
const CONTEXT_INDEX_IGNORED_FORMAT_CHARS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

function sanitizeContextIndexText(input: unknown, maxChars: number): string | undefined {
  if (typeof input !== "string") return undefined;
  let value = redactText(input.normalize("NFKC").replace(CONTEXT_INDEX_IGNORED_FORMAT_CHARS, ""))
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
  for (const pattern of CONTEXT_INDEX_UNTRUSTED_INSTRUCTION_PATTERNS) {
    value = value.replace(pattern, "[REDACTED_UNTRUSTED_INSTRUCTION]");
  }
  return value.trim() || undefined;
}

function sanitizeContextIndexTextArray(input: unknown, maxItems: number, maxChars: number): string[] {
  return (Array.isArray(input) ? input : [])
    .slice(0, maxItems)
    .map((item) => sanitizeContextIndexText(item, maxChars))
    .filter((item): item is string => Boolean(item));
}

function sanitizeContextIndexWarnings(warnings: string[]): string[] {
  return Array.from(new Set(
    warnings
      .map((warning) => sanitizeContextIndexText(warning, 320))
      .filter((warning): warning is string => Boolean(warning))
  )).slice(0, 40);
}

function sanitizeContextIndexCitation(citation: unknown): ContextIndexCitation | undefined {
  if (!citation || typeof citation !== "object") return undefined;
  const record = citation as Partial<ContextIndexCitation>;
  const pathValue = sanitizeContextIndexText(record.path, 240);
  const reasonValue = sanitizeContextIndexText(record.reason, 300);
  const urlValue = sanitizeContextIndexText(record.url, 300);
  if (!pathValue && !reasonValue && !urlValue) return undefined;
  return {
    ...(pathValue ? { path: pathValue } : {}),
    ...(reasonValue ? { reason: reasonValue } : {}),
    ...(urlValue ? { url: urlValue } : {})
  };
}

function sanitizeContextIndexCitations(input: unknown, maxItems = 20): ContextIndexCitation[] {
  return (Array.isArray(input) ? input : [])
    .slice(0, maxItems)
    .map((item) => sanitizeContextIndexCitation(item))
    .filter((item): item is ContextIndexCitation => Boolean(item));
}

function sanitizeContextIndexNode(input: unknown, index: number): ContextIndexNode {
  const record = input && typeof input === "object" ? input as Partial<ContextIndexNode> : {};
  const kind = CONTEXT_INDEX_NODE_KINDS.includes(record.kind as ContextIndexNodeKind) ? record.kind as ContextIndexNodeKind : "context";
  const label = sanitizeContextIndexText(record.label, 160) || `${kind}-${index + 1}`;
  const id = safeContextIndexId(record.id, contextNodeId(kind, label));
  const pathValue = sanitizeContextIndexText(record.path, 240);
  const summaryValue = sanitizeContextIndexText(record.summary, 500);
  const updatedAtValue = sanitizeContextIndexText(record.updatedAt, 80);
  return {
    id,
    kind,
    label,
    ...(summaryValue ? { summary: summaryValue } : {}),
    ...(pathValue ? { path: pathValue } : {}),
    ...(Array.isArray(record.tags) ? { tags: sanitizeContextIndexTextArray(record.tags, 16, 60) } : {}),
    ...(record.citations ? { citations: sanitizeContextIndexCitations(record.citations, 12) } : {}),
    updatedAt: updatedAtValue || nowIso()
  };
}

function sanitizeContextIndexEdge(input: unknown): ContextIndexEdge | undefined {
  const record = input && typeof input === "object" ? input as Partial<ContextIndexEdge> : {};
  const from = safeContextIndexId(record.from, "");
  const to = safeContextIndexId(record.to, "");
  if (!from || !to) return undefined;
  const kind = CONTEXT_INDEX_EDGE_KINDS.includes(record.kind as ContextIndexEdgeKind) ? record.kind as ContextIndexEdgeKind : "relates_to";
  const reasonValue = sanitizeContextIndexText(record.reason, 240);
  return {
    from,
    to,
    kind,
    ...(reasonValue ? { reason: reasonValue } : {})
  };
}

function sanitizeContextIndexForRead(input: ProjectContextIndex | undefined, settings: Required<ContextIndexSettings>): ProjectContextIndex | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<ProjectContextIndex>;
  const nodes = uniqueContextIndexNodes(
    (Array.isArray(record.nodes) ? record.nodes : []).map((node, index) => sanitizeContextIndexNode(node, index)),
    settings.maxNodes
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = uniqueContextIndexEdges(
    (Array.isArray(record.edges) ? record.edges : [])
      .map((edge) => sanitizeContextIndexEdge(edge))
      .filter((edge): edge is ContextIndexEdge => Boolean(edge))
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
    settings.maxEdges
  );
  const source = record.source === "onboarding-record" || record.source === "approved-workflow" || record.source === "manual"
    ? record.source
    : "manual";
  const projectId = sanitizeContextIndexText(record.projectId, 160);
  const profileMode = sanitizeContextIndexText(record.profileMode, 160);
  return {
    schemaVersion: 1,
    ...(projectId ? { projectId } : {}),
    ...(profileMode ? { profileMode } : {}),
    source,
    summary: sanitizeContextIndexText(record.summary, 1200) || "Project context index",
    generatedAt: sanitizeContextIndexText(record.generatedAt, 80) || "",
    updatedAt: sanitizeContextIndexText(record.updatedAt, 80) || "",
    policy: settings,
    nodes,
    edges,
    citations: sanitizeContextIndexCitations(record.citations, 80),
    warnings: []
  };
}

function uniqueContextIndexNodes(nodes: ContextIndexNode[], maxNodes: number): ContextIndexNode[] {
  const seen = new Map<string, ContextIndexNode>();
  for (const node of nodes) {
    if (!seen.has(node.id)) {
      seen.set(node.id, node);
      continue;
    }
    const existing = seen.get(node.id)!;
    seen.set(node.id, {
      ...existing,
      ...node,
      citations: [...(existing.citations ?? []), ...(node.citations ?? [])].slice(0, 12),
      tags: Array.from(new Set([...(existing.tags ?? []), ...(node.tags ?? [])])).slice(0, 16)
    });
  }
  return Array.from(seen.values()).slice(0, maxNodes);
}

function uniqueContextIndexEdges(edges: ContextIndexEdge[], maxEdges: number): ContextIndexEdge[] {
  const seen = new Map<string, ContextIndexEdge>();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
    if (!seen.has(key)) seen.set(key, edge);
  }
  return Array.from(seen.values()).slice(0, maxEdges);
}

function baseContextIndexGraph(
  cwd: string,
  profile: ProjectProfile,
  settings: Required<ContextIndexSettings>,
  sourceFiles: ContextIndexCitation[] = []
): { nodes: ContextIndexNode[]; edges: ContextIndexEdge[]; citations: ContextIndexCitation[]; warnings: string[] } {
  const now = nowIso();
  const profileId = contextNodeId("profile", profile.mode ?? profile.projectId ?? "unprofiled");
  const contextId = contextNodeId("context", ".pi/project-context.md");
  const nodes: ContextIndexNode[] = [
    {
      id: profileId,
      kind: "profile",
      label: profile.mode ?? profile.projectId ?? "unprofiled",
      summary: "Active Pi Agent profile; advisory context only, enforcement remains in guard policy.",
      path: ".pi/piagent-profile.json",
      tags: ["profile"],
      citations: [{ path: ".pi/piagent-profile.json", reason: "Active project profile" }],
      updatedAt: now
    },
    {
      id: contextId,
      kind: "context",
      label: ".pi/project-context.md",
      summary: "Concise project snapshot generated during onboarding.",
      path: ".pi/project-context.md",
      tags: ["snapshot", "advisory"],
      citations: [{ path: ".pi/project-context.md", reason: "Project onboarding snapshot" }],
      updatedAt: now
    }
  ];
  const edges: ContextIndexEdge[] = [
    { from: profileId, to: contextId, kind: "documented_by", reason: "Profile starts from the project context snapshot." }
  ];
  const citations = [...sourceFiles];
  const warnings: string[] = [];

  if (settings.includeTechStack) {
    const manifest = readJsonFile<TechStackManifest>(techStackPath(cwd));
    if (manifest?.selected?.length) {
      const manifestId = contextNodeId("context", TECH_STACK_MANIFEST_FILE);
      nodes.push({
        id: manifestId,
        kind: "context",
        label: TECH_STACK_MANIFEST_FILE,
        summary: "Selected profile tech manifest with Context7-ready placeholders.",
        path: TECH_STACK_MANIFEST_FILE,
        tags: ["tech-stack", "context7"],
        citations: [{ path: TECH_STACK_MANIFEST_FILE, reason: "Selected tech stack manifest" }],
        updatedAt: manifest.updatedAt || now
      });
      edges.push({ from: profileId, to: manifestId, kind: "documented_by", reason: "Profile records selected role tech." });
      for (const entry of manifest.selected) {
        const techId = contextNodeId("tech", entry.id);
        const nodeCitations: ContextIndexCitation[] = [{ path: entry.context7.contextFile, reason: entry.context7.status === "recorded" ? "Concise Context7 snapshot" : "Pending Context7 snapshot placeholder" }];
        nodes.push({
          id: techId,
          kind: "tech",
          label: `${entry.role}:${entry.id}`,
          summary: entry.description,
          path: entry.context7.contextFile,
          tags: [entry.role, ...entry.topics].slice(0, 16),
          citations: nodeCitations,
          updatedAt: entry.context7.retrievedAt ?? manifest.updatedAt ?? now
        });
        edges.push({ from: profileId, to: techId, kind: "uses_tech", reason: `${entry.role} role selection` });
        edges.push({ from: techId, to: manifestId, kind: "derived_from", reason: "Selected from tech-stack manifest." });
        if (entry.context7.status !== "recorded") warnings.push(`tech context pending: ${entry.id}`);
      }
    }
  }

  for (const [name, commands] of Object.entries(profile.verifyCommands ?? {})) {
    const verifyId = contextNodeId("verify", name);
    nodes.push({
      id: verifyId,
      kind: "verify",
      label: name,
      summary: commands.join(" && ").slice(0, 500),
      tags: ["verify"],
      citations: [{ path: ".pi/piagent-profile.json", reason: `verifyCommands.${name}` }],
      updatedAt: now
    });
    edges.push({ from: profileId, to: verifyId, kind: "verified_by", reason: `Profile verify group ${name}` });
  }

  if ((profile.protectedPaths ?? []).length || (profile.readOnlyPaths ?? []).length) {
    const riskId = contextNodeId("risk", "protected-paths");
    nodes.push({
      id: riskId,
      kind: "risk",
      label: "protected/read-only paths",
      summary: "Protected and read-only path boundaries are enforced by the guard; index entry is informational.",
      tags: ["security", "paths"],
      citations: [{ path: ".pi/piagent-profile.json", reason: "protectedPaths/readOnlyPaths" }],
      updatedAt: now
    });
    edges.push({ from: profileId, to: riskId, kind: "protected_by", reason: "Profile declares protected/read-only paths." });
  }

  if (settings.includeMemoryPointers) {
    const memory = resolveMemorySettings(profile);
    for (const rel of [memory.summaryFile, memory.handbookFile]) {
      let exists = false;
      try {
        exists = fs.existsSync(projectFilePath(cwd, rel));
      } catch {
        exists = false;
      }
      if (!exists) continue;
      const memoryId = contextNodeId("memory", rel);
      nodes.push({
        id: memoryId,
        kind: "memory",
        label: rel,
        summary: "Project memory pointer. Treat as advisory; verify against current repository files.",
        path: rel,
        tags: ["memory", "advisory"],
        citations: [{ path: rel, reason: "Configured project memory pointer" }],
        updatedAt: now
      });
      edges.push({ from: contextId, to: memoryId, kind: "relates_to", reason: "Memory can reduce repeated scout but is not authoritative." });
    }
  }

  for (const citation of sourceFiles.slice(0, 40)) {
    if (!citation.path) continue;
    const sourceId = contextNodeId("doc", citation.path);
    nodes.push({
      id: sourceId,
      kind: "doc",
      label: citation.path,
      summary: citation.reason ?? "Onboarding source file",
      path: citation.path,
      tags: ["source"],
      citations: [citation],
      updatedAt: now
    });
    edges.push({ from: contextId, to: sourceId, kind: "derived_from", reason: citation.reason ?? "Onboarding source file" });
  }

  return { nodes, edges, citations, warnings };
}

function writeContextIndex(cwd: string, profile: ProjectProfile, input: {
  source: ProjectContextIndex["source"];
  summary: string;
  sourceFiles?: ContextIndexCitation[];
  nodes?: ContextIndexNode[];
  edges?: ContextIndexEdge[];
  citations?: ContextIndexCitation[];
}): ProjectContextIndex {
  const settings = resolveContextIndexSettings(profile);
  if (!settings.enabled || settings.writePolicy === "off") {
    throw new Error("Project context index is disabled by profile.");
  }
  const target = contextIndexPath(cwd, settings);
  const sourceFiles = sanitizeContextIndexCitations(input.sourceFiles, 80);
  const graph = baseContextIndexGraph(cwd, profile, settings, sourceFiles);
  const customNodes = (Array.isArray(input.nodes) ? input.nodes : []).map((node, index) => sanitizeContextIndexNode(node, index));
  const customEdges = (Array.isArray(input.edges) ? input.edges : [])
    .map((edge) => sanitizeContextIndexEdge(edge))
    .filter((edge): edge is ContextIndexEdge => Boolean(edge));
  const citations = [
    ...graph.citations,
    ...sanitizeContextIndexCitations(input.citations, 80)
  ];
  const warnings = [...graph.warnings];
  if (settings.requireCitations && citations.length === 0) {
    warnings.push("no citations recorded; context index should cite project files or docs");
  }
  const now = nowIso();
  const existing = readJsonFile<ProjectContextIndex>(target);
  const existingGeneratedAt = existing?.generatedAt && Date.parse(existing.generatedAt) > 0
    ? existing.generatedAt
    : now;
  const index: ProjectContextIndex = {
    schemaVersion: 1,
    projectId: profile.projectId,
    profileMode: profile.mode,
    source: input.source,
    summary: redactBoundedText(input.summary, 1200)?.trim() || "Project context index",
    generatedAt: existingGeneratedAt,
    updatedAt: now,
    policy: settings,
    nodes: uniqueContextIndexNodes([...graph.nodes, ...customNodes], settings.maxNodes),
    edges: uniqueContextIndexEdges([...graph.edges, ...customEdges], settings.maxEdges),
    citations: citations.slice(0, 80),
    warnings: Array.from(new Set(warnings)).slice(0, 40)
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(redactForStorage(index), null, 2)}\n`);
  return index;
}

function buildContextIndexStatus(cwd: string, profile: ProjectProfile): {
  enabled: boolean;
  path: string;
  exists: boolean;
  writePolicy: Required<ContextIndexSettings>["writePolicy"];
  nodes: number;
  edges: number;
  citations: number;
  updatedAt?: string;
  warnings: string[];
} {
  const settings = resolveContextIndexSettings(profile);
  const warnings: string[] = [];
  let index: ProjectContextIndex | undefined;
  let exists = false;
  try {
    const target = contextIndexPath(cwd, settings);
    exists = fs.existsSync(target);
    index = sanitizeContextIndexForRead(readJsonFile<ProjectContextIndex>(target), settings);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  if (!settings.enabled || settings.writePolicy === "off") {
    warnings.push("context index disabled by profile");
  } else if (!exists) {
    warnings.push("context index missing; run /onboard or record piagent_context_index_record");
  }
  if (exists && !index) warnings.push("context index exists but cannot be parsed");
  if (index && settings.requireCitations && index.citations.length === 0) warnings.push("context index has no citations");

  const manifest = readJsonFile<TechStackManifest>(techStackPath(cwd));
  if (manifest?.selected?.length && index) {
    const indexedTechIds = new Set(index.nodes.filter((node) => node.kind === "tech").map((node) => node.id));
    for (const entry of manifest.selected) {
      if (!indexedTechIds.has(contextNodeId("tech", entry.id))) warnings.push(`selected tech missing from context index: ${entry.id}`);
      if (entry.context7.status !== "recorded") warnings.push(`tech context pending: ${entry.id}`);
    }
    if (index.updatedAt && manifest.updatedAt && Date.parse(index.updatedAt) < Date.parse(manifest.updatedAt)) {
      warnings.push("context index is older than tech-stack manifest");
    }
  }

  const onboarding = readJsonFile<ProjectOnboardingSnapshot>(onboardingStateFilePath(cwd));
  if (index?.updatedAt && onboarding?.recordedAt && Date.parse(index.updatedAt) < Date.parse(onboarding.recordedAt)) {
    warnings.push("context index is older than project onboarding snapshot");
  }

  return {
    enabled: settings.enabled,
    path: settings.path,
    exists,
    writePolicy: settings.writePolicy,
    nodes: index?.nodes.length ?? 0,
    edges: index?.edges.length ?? 0,
    citations: index?.citations.length ?? 0,
    updatedAt: index?.updatedAt,
    warnings: sanitizeContextIndexWarnings(warnings)
  };
}

function searchContextIndex(cwd: string, profile: ProjectProfile, query: string, limit: number): Array<{ id: string; kind: string; label: string; match: string }> {
  const settings = resolveContextIndexSettings(profile);
  if (!settings.enabled) return [];
  const index = sanitizeContextIndexForRead(readJsonFile<ProjectContextIndex>(contextIndexPath(cwd, settings)), settings);
  if (!index) return [];
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: Array<{ id: string; kind: string; label: string; match: string }> = [];
  for (const node of index.nodes) {
    const haystack = [
      node.id,
      node.kind,
      node.label,
      node.summary,
      node.path,
      ...(node.tags ?? []),
      ...(node.citations ?? []).flatMap((citation) => [citation.path, citation.reason, citation.url])
    ].filter(Boolean).join(" ");
    if (!haystack.toLowerCase().includes(needle)) continue;
    results.push({ id: node.id, kind: node.kind, label: node.label, match: (node.summary ?? node.path ?? node.label).slice(0, 240) });
    if (results.length >= limit) return results;
  }
  return results;
}

function adapterProfilePath(extensionDir: string, profileName: string): string | undefined {
  const platformRoot = findPlatformRoot(extensionDir);
  const safeName = profileName.trim();
  if (!/^[a-z0-9-]+$/.test(safeName)) return undefined;
  const candidate = path.join(platformRoot, "adapters", safeName, "profile.json");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function readAdapterProfiles(extensionDir: string): Array<{ name: string; profile: ProjectProfile }> {
  const platformRoot = findPlatformRoot(extensionDir);
  const adaptersDir = path.join(platformRoot, "adapters");
  if (!fs.existsSync(adaptersDir)) return [];
  return fs.readdirSync(adaptersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const profile = readJsonFile<ProjectProfile>(path.join(adaptersDir, entry.name, "profile.json"));
      return profile ? { name: entry.name, profile } : undefined;
    })
    .filter((entry): entry is { name: string; profile: ProjectProfile } => Boolean(entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function profileDescription(name: string): string {
  const descriptions: Record<string, string> = {
    generic: "Safe baseline for unknown repos.",
    "web-frontend": "Frontend-only React/Next/Vite-style work.",
    "backend-api": "Backend/API implementation work.",
    "be-readonly-fe": "Scout backend contract read-only, implement frontend only.",
    fullstack: "Frontend and backend can both be edited when task scope allows.",
    "node-typescript": "Node/TypeScript library or tooling repo.",
    python: "Python app/library repo.",
    data: "ETL/dbt/DVC/notebook/data pipeline repo.",
    devops: "Docker/Terraform/K8s/GitHub Actions/infrastructure repo.",
    mobile: "React Native/Flutter/mobile repo.",
    docs: "Documentation portal/manual repo."
  };
  return descriptions[name] ?? "Custom project profile.";
}

function normalizeProjectProfileName(value: string): string {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    fe: "web-frontend",
    frontend: "web-frontend",
    web: "web-frontend",
    be: "backend-api",
    backend: "backend-api",
    api: "backend-api",
    full: "fullstack",
    befe: "be-readonly-fe",
    "be-fe": "be-readonly-fe",
    "be-readonly": "be-readonly-fe",
    "readonly-fe": "be-readonly-fe",
    typescript: "node-typescript",
    ts: "node-typescript"
  };
  return aliases[normalized] ?? normalized;
}

function buildProfileOptions(extensionDir: string, cwd: string, intent?: string): { recommended: string; reason: string; options: ProfileOption[] } {
  const recommendation = detectProfileName(cwd, intent);
  const options = readAdapterProfiles(extensionDir).map(({ name, profile }) => ({
    name,
    displayName: profile.displayName,
    mode: profile.mode,
    description: profileDescription(name),
    recommended: name === recommendation.name,
    reason: name === recommendation.name ? recommendation.reason : profileDescription(name)
  }));
  return { recommended: recommendation.name, reason: recommendation.reason, options };
}

function techStackPath(cwd: string): string {
  return projectFilePath(cwd, TECH_STACK_MANIFEST_FILE);
}

function techContextDirPath(cwd: string): string {
  return projectFilePath(cwd, TECH_CONTEXT_DIR);
}

function techContextFilePath(cwd: string, techId: string): string {
  return projectFilePath(cwd, `${TECH_CONTEXT_DIR}/${safeTaskId(techId)}.json`);
}

function techContextRelativePath(techId: string): string {
  return `${TECH_CONTEXT_DIR}/${safeTaskId(techId)}.json`;
}

function profileTechRoles(profileName: string): TechRole[] {
  const normalized = normalizeProjectProfileName(profileName || "generic");
  return PROFILE_TECH_ROLES[normalized] ?? PROFILE_TECH_ROLES.generic;
}

function techOptionsForRole(role: TechRole): TechOption[] {
  return TECH_OPTIONS.filter((option) => option.role === role);
}

function techOptionById(id: string, role?: TechRole): TechOption | undefined {
  const normalized = id.trim().toLowerCase();
  return TECH_OPTIONS.find((option) => option.id === normalized && (!role || option.role === role));
}

function selectedTechIdsByRole(values: TechOption[]): Partial<Record<TechRole, string[]>> {
  const roles: Partial<Record<TechRole, string[]>> = {};
  for (const option of values) {
    if (option.id === "none") {
      roles[option.role] = [];
      continue;
    }
    roles[option.role] = [...(roles[option.role] ?? []), option.id];
  }
  return roles;
}

function digestJson(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function packageJsonText(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, "package.json"), "utf8");
  } catch {
    return "";
  }
}

function detectRecommendedTechId(cwd: string, role: TechRole): string {
  const packageText = packageJsonText(cwd);
  if (role === "frontend") {
    if (/\"next\"/i.test(packageText) || fs.existsSync(path.join(cwd, "next.config.js")) || fs.existsSync(path.join(cwd, "next.config.mjs")) || fs.existsSync(path.join(cwd, "src", "app"))) return "nextjs";
    if (/\"vue\"/i.test(packageText)) return "vue";
    if (/\"@sveltejs\/kit\"|\"svelte\"/i.test(packageText)) return "sveltekit";
    if (/\"astro\"/i.test(packageText)) return "astro";
    if (/\"@angular\/core\"/i.test(packageText)) return "angular";
    if (/\"react\"|\"vite\"/i.test(packageText)) return "react-vite";
    return "nextjs";
  }
  if (role === "backend") {
    if (/\"@nestjs\//i.test(packageText) || fs.existsSync(path.join(cwd, "nest-cli.json"))) return "nestjs";
    if (/\"fastify\"/i.test(packageText)) return "fastify";
    if (/\"hono\"/i.test(packageText)) return "hono";
    if (/\"express\"/i.test(packageText)) return "express";
    try {
      const pyproject = fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8");
      if (/fastapi/i.test(pyproject)) return "fastapi";
      if (/django/i.test(pyproject)) return "django";
    } catch {
      // ignore absent Python project file
    }
    if (fs.existsSync(path.join(cwd, "pom.xml")) || fs.existsSync(path.join(cwd, "build.gradle")) || fs.existsSync(path.join(cwd, "build.gradle.kts"))) return "spring-boot";
    return "nestjs";
  }
  if (role === "database") {
    if (/\"prisma\"|\"@prisma\/client\"/i.test(packageText) || fs.existsSync(path.join(cwd, "prisma"))) return "prisma";
    if (/\"drizzle-orm\"/i.test(packageText)) return "drizzle";
    if (/\"typeorm\"/i.test(packageText)) return "typeorm";
    if (/\"@supabase\/supabase-js\"/i.test(packageText)) return "supabase";
    if (/\"mongodb\"|\"mongoose\"/i.test(packageText)) return "mongodb";
    if (/\"pg\"|\"postgres\"/i.test(packageText)) return "postgres";
    return "none";
  }
  if (role === "mobile") {
    if (fs.existsSync(path.join(cwd, "pubspec.yaml"))) return "flutter";
    return "react-native";
  }
  if (role === "devops") {
    if (fs.existsSync(path.join(cwd, "terraform"))) return "terraform";
    if (fs.existsSync(path.join(cwd, "k8s")) || fs.existsSync(path.join(cwd, "helm"))) return "kubernetes";
    if (fs.existsSync(path.join(cwd, ".github", "workflows"))) return "github-actions";
    return "docker";
  }
  if (role === "data") {
    if (fs.existsSync(path.join(cwd, "dbt_project.yml"))) return "dbt";
    return "pandas";
  }
  if (role === "docs") {
    if (fs.existsSync(path.join(cwd, "docusaurus.config.js")) || fs.existsSync(path.join(cwd, "docusaurus.config.ts"))) return "docusaurus";
    if (fs.existsSync(path.join(cwd, "mint.json"))) return "mintlify";
    return "mkdocs";
  }
  if (role === "runtime") {
    if (fs.existsSync(path.join(cwd, "pyproject.toml"))) return "python";
    return "node-typescript";
  }
  return techOptionsForRole(role)[0]?.id ?? "none";
}

function buildProfileTechOptions(extensionDir: string, cwd: string, requestedProfile?: string): {
  profile: string;
  recommendedProfile: string;
  roles: TechRole[];
  roleOptions: Array<{ role: TechRole; recommended: string; options: TechOption[] }>;
} {
  const profileOptions = buildProfileOptions(extensionDir, cwd);
  const profile = normalizeProjectProfileName(requestedProfile || profileOptions.recommended);
  const roles = profileTechRoles(profile);
  return {
    profile,
    recommendedProfile: profileOptions.recommended,
    roles,
    roleOptions: roles.map((role) => ({
      role,
      recommended: detectRecommendedTechId(cwd, role),
      options: techOptionsForRole(role)
    }))
  };
}

function buildTechStackManifest(profileName: string, selectedOptions: TechOption[], existing?: TechStackManifest): TechStackManifest {
  const now = nowIso();
  const selected = selectedOptions
    .filter((option) => option.id !== "none")
    .map((option): TechStackEntry => ({
      id: option.id,
      label: option.label,
      role: option.role,
      description: option.description,
      context7: {
        provider: "context7",
        query: option.context7Query ?? option.label,
        status: "pending",
        contextFile: techContextRelativePath(option.id)
      },
      topics: option.topics
    }));
  const roles = selectedTechIdsByRole(selectedOptions);
  return {
    schemaVersion: 1,
    provider: "context7",
    profile: normalizeProjectProfileName(profileName),
    roles,
    selected,
    skippedRoles: selectedOptions.filter((option) => option.id === "none").map((option) => option.role),
    contextDir: TECH_CONTEXT_DIR,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

// `profile` is the document the project stores. When it names an adapter, the
// lock is resolved against that adapter but still records the stored document,
// so a later platform correction is not a lock the project has to re-agree to.
function writeProfileDocumentWithLock(extensionDir: string, cwd: string, profile: ProjectProfile): ProjectProfile {
  const target = projectProfilePath(cwd);
  const platformRoot = findPlatformRoot(extensionDir);
  const resolved = resolveProjectProfileDocument(platformRoot, profile).profile as ProjectProfile;
  const capabilityLock = resolveCapabilityProfileDocument(platformRoot, resolved, {
    profileFile: "piagent-profile.json",
    storedProfile: profile,
    packageSource: projectPackageSource(cwd),
    extraRoots: capabilitySourceRoots(cwd, resolved)
  });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeProfileLockAtomic(target, profile, path.join(cwd, ".pi", "piagent-profile.lock.json"), capabilityLock);
  return profile;
}

function ensurePendingTechContextFiles(cwd: string, manifest: TechStackManifest): void {
  fs.mkdirSync(techContextDirPath(cwd), { recursive: true });
  for (const entry of manifest.selected) {
    const target = techContextFilePath(cwd, entry.id);
    if (fs.existsSync(target)) continue;
    const snapshot: TechContextSnapshot = {
      schemaVersion: 1,
      provider: "context7",
      status: "pending",
      techId: entry.id,
      role: entry.role,
      query: entry.context7.query,
      topics: entry.topics,
      summary: "Pending Context7 refresh. Use /profile tech refresh or record Context7 evidence with piagent_profile_tech_context_record.",
      keyRules: [],
      citations: []
    };
    fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}

function writeTechStackSelection(
  extensionDir: string,
  cwd: string,
  profileName: string,
  selectedOptions: TechOption[],
  projectId?: string,
  displayName?: string
): { profile: ProjectProfile; manifest: TechStackManifest } {
  const currentManifest = readJsonFile<TechStackManifest>(techStackPath(cwd));
  const profile = buildProfileFromAdapter(extensionDir, cwd, profileName, projectId, displayName);
  const manifest = buildTechStackManifest(profileName, selectedOptions, currentManifest);
  ensurePendingTechContextFiles(cwd, manifest);
  fs.writeFileSync(techStackPath(cwd), `${JSON.stringify(manifest, null, 2)}\n`);
  profile.techStack = {
    provider: "context7",
    manifest: TECH_STACK_MANIFEST_FILE,
    contextDir: TECH_CONTEXT_DIR,
    roles: manifest.roles,
    updatedAt: manifest.updatedAt
  };
  writeProfileDocumentWithLock(extensionDir, cwd, profile);
  ensureProjectContextPlaceholder(cwd);
  return { profile: resolveProjectProfileDocument(findPlatformRoot(extensionDir), profile).profile as ProjectProfile, manifest };
}

function normalizeTechSelections(cwd: string, profileName: string, selections: Record<string, unknown> = {}, fillRecommended = true): {
  options: TechOption[];
  invalid: string[];
  missing: TechRole[];
} {
  const options: TechOption[] = [];
  const invalid: string[] = [];
  const missing: TechRole[] = [];
  for (const role of profileTechRoles(profileName)) {
    const raw = selections[role];
    const requested = typeof raw === "string" && raw.trim()
      ? raw.trim().toLowerCase()
      : fillRecommended
        ? detectRecommendedTechId(cwd, role)
        : "";
    if (!requested) {
      missing.push(role);
      continue;
    }
    const option = techOptionById(requested, role);
    if (!option) {
      invalid.push(`${role}=${requested}`);
      continue;
    }
    options.push(option);
  }
  return { options, invalid, missing };
}

function formatTechSelectionSummary(manifest: TechStackManifest): string {
  const selected = manifest.selected.length
    ? manifest.selected.map((entry) => `${entry.role}:${entry.id}`).join(", ")
    : "none";
  const skipped = manifest.skippedRoles?.length ? `\nskipped: ${manifest.skippedRoles.join(", ")}` : "";
  return [
    `profile: ${manifest.profile}`,
    `tech: ${selected}${skipped}`,
    `manifest: ${TECH_STACK_MANIFEST_FILE}`,
    `contextDir: ${TECH_CONTEXT_DIR}`,
    "context7: pending refresh/record for selected tech"
  ].join("\n");
}

function formatTechOptionsText(result: ReturnType<typeof buildProfileTechOptions>): string {
  return [
    `profile: ${result.profile}`,
    `recommendedProfile: ${result.recommendedProfile}`,
    "",
    ...result.roleOptions.flatMap((group) => [
      `${group.role}: recommended=${group.recommended}`,
      ...group.options.map((option) => `- ${option.id}: ${option.label} — ${option.description}`)
    ]),
    "",
    `apply: /profile tech apply ${result.profile} ${result.roles.map((role) => `${role}=${result.roleOptions.find((group) => group.role === role)?.recommended ?? ""}`).join(" ")}`
  ].join("\n");
}

function selectOptionDisplay(option: { value: string; label: string; description?: string; recommended?: boolean }): string {
  const recommended = option.recommended ? " (recommended)" : "";
  const description = option.description ? ` — ${option.description}` : "";
  return `${option.label}${recommended}${description} [${option.value}]`;
}

function parseSelectionValue(
  result: unknown,
  options: Array<{ value: string; label: string; description?: string; recommended?: boolean }>
): string | undefined {
  if (typeof result !== "string") return undefined;
  const trimmed = result.trim();
  const byValue = options.find((option) => option.value === trimmed);
  if (byValue) return byValue.value;
  const byDisplay = options.find((option) => selectOptionDisplay(option) === trimmed);
  if (byDisplay) return byDisplay.value;
  const byLabel = options.find((option) => option.label === trimmed || `${option.label} (recommended)` === trimmed);
  if (byLabel) return byLabel.value;
  const bracketValue = trimmed.match(/\[([a-z0-9-]+)\]\s*$/i)?.[1]?.toLowerCase();
  if (bracketValue && options.some((option) => option.value === bracketValue)) {
    return bracketValue;
  }
  return undefined;
}

async function selectValueFromUi(
  ctx: ExtensionContext,
  title: string,
  options: Array<{ value: string; label: string; description?: string; recommended?: boolean }>,
  defaultValue?: string
): Promise<string | undefined> {
  const ui = ctx.ui as {
    select?: (...args: unknown[]) => Promise<unknown> | unknown;
    pick?: (...args: unknown[]) => Promise<unknown> | unknown;
    choose?: (...args: unknown[]) => Promise<unknown> | unknown;
  };
  const select = ui?.select ?? ui?.pick ?? ui?.choose;
  if (typeof select !== "function") return undefined;
  const displayOptions = options.map((option) => selectOptionDisplay(option));
  const defaultDisplay = options.find((option) => option.value === defaultValue);
  const attempts = [
    [title, displayOptions, { defaultValue: defaultDisplay ? selectOptionDisplay(defaultDisplay) : undefined }],
    [{ title, options: displayOptions, defaultValue: defaultDisplay ? selectOptionDisplay(defaultDisplay) : undefined }],
    [displayOptions, title],
    [displayOptions]
  ];
  for (const args of attempts) {
    try {
      const result = await select.apply(ui, args);
      const value = parseSelectionValue(result, options);
      if (value) return value;
    } catch {
      // Try the next known UI shape.
    }
  }
  return undefined;
}

function buildProfileFromAdapter(extensionDir: string, cwd: string, profileName: string, projectId?: string, displayName?: string): ProjectProfile {
  const source = adapterProfilePath(extensionDir, profileName);
  if (!source) throw new Error(`Unknown profile: ${profileName}`);
  const profile = readJsonFile<ProjectProfile>(source);
  if (!profile) throw new Error(`Profile unreadable: ${profileName}`);
  const projectName = path.basename(cwd);
  // The project records which adapter it follows, not a copy of that adapter's
  // rules. A copy stops receiving corrections the moment it is written.
  return buildExtendingProfile(
    profileName,
    projectId ? slugify(projectId) : slugify(projectName),
    displayName?.trim() || titleize(projectName)
  ) as ProjectProfile;
}

function writeProfileFromAdapter(extensionDir: string, cwd: string, profileName: string, overwrite = false, projectId?: string, displayName?: string): ProjectProfile {
  const target = projectProfilePath(cwd);
  if (fs.existsSync(target) && !overwrite) throw new Error(".pi/piagent-profile.json already exists. Pass overwrite=true to replace it.");
  const stored = buildProfileFromAdapter(extensionDir, cwd, profileName, projectId, displayName);
  writeProfileDocumentWithLock(extensionDir, cwd, stored);
  ensureProjectContextPlaceholder(cwd);
  // Store the reference, hand back the document it resolves to: callers report
  // and trace what is now in force, not the four lines that point at it.
  return resolveProjectProfileDocument(findPlatformRoot(extensionDir), stored).profile as ProjectProfile;
}

function readTask(cwd: string, taskId: string, sessionId?: string): TaskContract | undefined {
  return resolveTaskContract(cwd, taskId, sessionId) as TaskContract | undefined;
}

function writeTask(cwd: string, task: TaskContract): TaskContract {
  return writeTaskContract(cwd, task) as TaskContract;
}

function taskChangedFileEvidence(
  cwd: string,
  task: TaskContract,
  currentDigests: Record<string, string> = workingTreeSnapshot(cwd) as Record<string, string>
): {
  current: string[];
  expected: string[];
  undeclared: string[];
  unsupportedClaims: string[];
  outsideScope: string[];
} {
  const current = Object.keys(currentDigests).sort();
  // Observed mutations are audit history, not proof of a final source change.
  // A file edited and then restored to its task-start digest must not satisfy a
  // source-change gate merely because a write tool touched it earlier.
  const expected = taskDeltaFilesFromSnapshot(task, currentDigests);
  const declared = new Set(task.changedFiles ?? []);
  const expectedSet = new Set(expected);
  return {
    current,
    expected,
    undeclared: expected.filter((file) => !declared.has(file)),
    unsupportedClaims: [...declared].filter((file) => !expectedSet.has(file)),
    outsideScope: expected.filter((file) => !taskScopeIncludesPath(task.scope, file))
  };
}

function exactReviewPathCoverage(expectedPaths: string[], reviewedPaths: string[] | undefined): boolean {
  const expected = [...new Set(expectedPaths)].sort();
  const reviewed = [...new Set(reviewedPaths ?? [])].sort();
  return expected.length > 0
    && expected.length === reviewed.length
    && expected.every((file, index) => file === reviewed[index]);
}

function taskScopeIncludesPath(scope: string[], file: string): boolean {
  const normalizedFile = normalizePathCandidate(file);
  return scope.some((candidate) => {
    const normalized = normalizePathCandidate(candidate);
    if (!normalized) return false;
    if ([".", "**", "**/*"].includes(normalized)) return true;
    if (matchesAnyPath(normalizedFile, [normalized])) return true;
    return !/[?*[\]{}]/.test(normalized) && normalizedFile.startsWith(`${normalized.replace(/\/$/, "")}/`);
  });
}

function verifierCommandInstructions(commands: string[]): string[] {
  return commands.map((command, index) => `Verifier ${index + 1} (run as its own shell call): ${command}`);
}

function evaluateTaskGate(
  cwd: string,
  task: TaskContract | undefined,
  policy: BasePolicy,
  options: {
    currentDigests?: Record<string, string>;
    currentWorkingTreeDigest?: string;
  } = {}
): {
  decision: "pass" | "fail";
  missing: string[];
  missingVerifyCommands: string[];
  warnings: string[];
  currentWorkingTreeDigest?: string;
  changedFileEvidence?: ReturnType<typeof taskChangedFileEvidence>;
} {
  const finalGate = finalGateConfig(policy);
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!task) {
    return { decision: "fail", missing: ["task contract"], missingVerifyCommands: [], warnings };
  }
  const currentDigests = options.currentDigests ?? workingTreeSnapshot(cwd) as Record<string, string>;
  const currentWorkingTreeDigest = options.currentWorkingTreeDigest ?? workingTreeEvidenceDigest(currentDigests);
  if (task.workingTreeDigestAlgorithm !== WORKING_TREE_DIGEST_ALGORITHM || task.workingTreeDigestMigration?.status === "verification-refresh-required" || !workingTreeSnapshotUsesCurrentAlgorithm(currentDigests) || !isCurrentWorkingTreeDigest(currentWorkingTreeDigest) || currentWorkingTreeDigest !== workingTreeEvidenceDigest(currentDigests) || Object.values(task.baselineFileDigests).some((digest) => !isCurrentWorkingTreeDigest(digest)) || (task.workingTreeDigestMigration && (!taskDigestMigrationArchiveStatus(cwd, task).valid || replayTaskCheckpoints(cwd, task.taskRunId, task).corruptions.length > 0))) missing.push("current working-tree digest evidence");
  if (workingTreeSnapshotHasUnavailableEvidence(currentDigests)) missing.push("complete working-tree content evidence");
  if (taskContractValidationErrors(task).length > 0) missing.push("valid session-bound task contract v2");
  if (task.attempt > task.maxAttempts) missing.push(`attempt within maxAttempts (${task.attempt}/${task.maxAttempts})`);
  const plannedVerifyCommands = meaningfulVerificationCommands(task.verifyCommands);
  if (task.changeMode === "source-change" && plannedVerifyCommands.length === 0) missing.push("meaningful verify command");
  if (finalGate.requireContextManifest && task.contextManifest.length === 0) missing.push("context manifest");
  if (task.changeMode === "source-change" && finalGate.requireVerifyEvidence && task.verifyEvidence.length === 0) missing.push("verify evidence");
  if (task.verifyEvidence.some((evidence) => evidence.observed !== true)) {
    warnings.push("Unobserved verify evidence is ignored by the passing verify gate.");
  }
  if (task.verifyEvidence.some((evidence) => evidence.observed === true && evidence.matchedProfileCommand !== true)) {
    warnings.push("Observed verify evidence that does not exactly match task verifyCommands is advisory only.");
  }
  if (task.verifyEvidence.some((evidence) => (
    evidence.observed === true
    && evidence.matchedProfileCommand === true
    && evidence.workingTreeDigest !== currentWorkingTreeDigest
  ))) {
    warnings.push("Verification evidence from a different working-tree snapshot is stale and is ignored.");
  }
  let missingVerifyCommands: string[] = [];
  if (task.changeMode === "source-change" && finalGate.requirePassingVerify && plannedVerifyCommands.length > 0) {
    const passingCommands = passingVerifyCommandsForDigest(task, currentWorkingTreeDigest);
    missingVerifyCommands = plannedVerifyCommands.filter((command) => !passingCommands.has(command.trim()));
    if (missingVerifyCommands.length > 0) missing.push(`observed passing verify evidence for every configured command (${missingVerifyCommands.length} missing)`);
  }
  if (finalGate.requireTrace && task.trace.outcome !== "completed") missing.push("completed final trace");
  const incompleteSteps = (task.workPlan ?? []).filter((step) => step.status === "pending" || step.status === "in-progress" || step.status === "failed");
  if (task.trace.outcome === "completed" && incompleteSteps.length > 0) {
    missing.push(`completed work plan (${incompleteSteps.map((step) => `${step.id}:${step.status}`).join(", ")})`);
  }
  const changedFileEvidence = taskChangedFileEvidence(cwd, task, currentDigests);
  if (task.changeMode === "source-change" && task.trace.outcome === "completed") {
    if (task.changedFiles.length === 0) missing.push("changed files");
    if (changedFileEvidence.undeclared.length > 0) missing.push(`declared observed changes (${changedFileEvidence.undeclared.join(", ")})`);
    if (changedFileEvidence.unsupportedClaims.length > 0) missing.push(`supported changed-file claims (${changedFileEvidence.unsupportedClaims.join(", ")})`);
    if (changedFileEvidence.outsideScope.length > 0) missing.push(`changes within task scope (${changedFileEvidence.outsideScope.join(", ")})`);
  }
  if (task.changeMode === "read-only" && changedFileEvidence.expected.length > 0) {
    missing.push(`read-only task has observed changes (${changedFileEvidence.expected.join(", ")})`);
  }
  const acceptance = refreshAcceptanceReceipt(task, {
    cwd,
    changedFiles: changedFileEvidence.expected,
    currentWorkingTreeDigest
  });
  const semanticEnforcement = taskAuthorityDecision(task, "CAP-13", "block").allowed;
  if (semanticEnforcement && acceptance.criticalMissing.length > 0) {
    missing.push(`critical acceptance evidence (${acceptance.criticalMissing.map((criterion) => `${criterion.id}:${criterion.obligation}`).join(", ")})`);
  }
  const acceptanceConflicts = acceptanceSemanticConflicts(task, {
    cwd,
    changedFiles: changedFileEvidence.expected
  });
  if (semanticEnforcement && acceptanceConflicts.length > 0) {
    missing.push(`acceptance semantic conflicts (${acceptanceConflicts.join(", ")})`);
  }
  const normalMissing = acceptance.missing.filter((criterion) => criterion.priority !== "critical");
  if (!semanticEnforcement && (acceptance.criticalMissing.length > 0 || acceptanceConflicts.length > 0)) warnings.push("Acceptance projection is advisory under the pinned task authority and cannot block completion.");
  if (normalMissing.length > 0) {
    warnings.push(`Acceptance criteria pending evidence: ${normalMissing.map((criterion) => `${criterion.id}:${criterion.obligation}`).join(", ")}`);
  }
  return { decision: missing.length === 0 ? "pass" : "fail", missing, missingVerifyCommands, warnings, currentWorkingTreeDigest, changedFileEvidence };
}

function appendTrace(cwd: string, payload: Record<string, unknown>): void {
  ensureStateDirs(cwd);
  const safePayload = redactForStorage(payload) as Record<string, unknown>;
  appendJsonlBounded(traceFilePath(cwd), { recordedAt: nowIso(), ...safePayload }, { maxBytes: TRACE_MAX_BYTES, mode: 0o600, projectRoot: cwd });
}

function appendSessionTrace(pi: ExtensionAPI, payload: Record<string, unknown>): void {
  const safePayload = redactForStorage(payload) as Record<string, unknown>;
  pi.appendEntry(PIAGENT_TRACE_STATE_TYPE, {
    version: 1,
    recordedAt: nowIso(),
    ...safePayload
  });
}

function parseReferenceRepoRef(input: string): { host: string; owner: string; repo: string } {
  const ref = input.trim().replace(/\/+$/, "");
  if (!ref) throw new Error("repoRef is required");

  let host = "";
  let rest = "";
  if (/^https?:\/\//.test(ref)) {
    const parsed = new URL(ref);
    host = parsed.hostname;
    rest = parsed.pathname.replace(/^\/+/, "");
  } else if (ref.startsWith("git@") && ref.includes(":")) {
    const withoutUser = ref.slice("git@".length);
    const [rawHost, rawRest] = withoutUser.split(":", 2);
    host = rawHost;
    rest = rawRest;
  } else {
    const parts = ref.split("/");
    if (parts.length >= 3 && parts[0].includes(".")) {
      host = parts[0];
      rest = parts.slice(1).join("/");
    } else if (parts.length >= 2) {
      host = "github.com";
      rest = ref;
    }
  }

  rest = rest.replace(/\.git$/, "");
  const [owner, repo, extra] = rest.split("/");
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!host || !owner || !repo || extra || !valid.test(host) || !valid.test(owner) || !valid.test(repo)) {
    throw new Error(`Unsupported repository reference: ${input}`);
  }
  return { host, owner, repo };
}

function referenceCacheRoot(): string {
  const explicit = process.env.PIAGENT_CHECKOUT_CACHE;
  if (explicit && explicit.trim()) return explicit;
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, "piagent-platform", "checkouts");
  const home = process.env.HOME;
  if (home && home.trim()) return path.join(home, ".cache", "piagent-platform", "checkouts");
  throw new Error("HOME, XDG_CACHE_HOME, or PIAGENT_CHECKOUT_CACHE is required");
}

function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function isCleanGitWorktree(checkoutPath: string): boolean {
  try {
    runGit(["diff", "--quiet", "--ignore-submodules", "--"], checkoutPath);
    runGit(["diff", "--cached", "--quiet", "--ignore-submodules", "--"], checkoutPath);
    return true;
  } catch {
    return false;
  }
}

function shouldFetch(stampPath: string, forceUpdate: boolean, intervalSeconds: number): boolean {
  if (forceUpdate) return true;
  try {
    const lastFetch = Number.parseInt(fs.readFileSync(stampPath, "utf8").replace(/\D/g, ""), 10);
    if (!Number.isFinite(lastFetch)) return true;
    return Math.floor(Date.now() / 1000) - lastFetch >= intervalSeconds;
  } catch {
    return true;
  }
}

function checkoutReferenceRepo(repoRef: string, forceUpdate = false): ReferenceRepo {
  const { host, owner, repo } = parseReferenceRepoRef(repoRef);
  const cloneUrl = `https://${host}/${owner}/${repo}.git`;
  const checkoutPath = path.join(referenceCacheRoot(), host, owner, repo);
  const stampPath = path.join(checkoutPath, ".piagent-last-fetch");
  const intervalSeconds = Number.parseInt(process.env.PIAGENT_CHECKOUT_FETCH_INTERVAL_SECONDS ?? "300", 10);
  let fetched = false;

  if (!fs.existsSync(path.join(checkoutPath, ".git"))) {
    fs.mkdirSync(path.dirname(checkoutPath), { recursive: true });
    runGit(["clone", "--filter=blob:none", "--", cloneUrl, checkoutPath]);
    fs.writeFileSync(stampPath, `${Math.floor(Date.now() / 1000)}\n`);
    fetched = true;
  } else if (shouldFetch(stampPath, forceUpdate, Number.isFinite(intervalSeconds) ? intervalSeconds : 300)) {
    const clean = isCleanGitWorktree(checkoutPath);
    runGit(["fetch", "--filter=blob:none", "--prune", "origin"], checkoutPath);
    if (clean) {
      try {
        runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], checkoutPath);
        try {
          runGit(["merge", "--ff-only", "@{u}"], checkoutPath);
        } catch {
          // Keep stale checkout rather than mutating a divergent cache.
        }
      } catch {
        // No upstream branch; fetch is enough.
      }
    }
    fs.writeFileSync(stampPath, `${Math.floor(Date.now() / 1000)}\n`);
    fetched = true;
  }

  let commit: string | undefined;
  try {
    commit = runGit(["rev-parse", "--short", "HEAD"], checkoutPath);
  } catch {
    commit = undefined;
  }

  return { host, owner, repo, cloneUrl, checkoutPath, commit, fetched };
}

function sessionTaskReference(ctx: ExtensionContext): { taskId?: string; taskRunId?: string } | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as unknown as { type?: string; customType?: string; data?: Record<string, unknown> };
    if (entry.type !== "custom" || entry.customType !== PIAGENT_TRACE_STATE_TYPE || !entry.data) continue;
    const taskId = typeof entry.data.taskId === "string" ? entry.data.taskId : undefined;
    const taskRunId = typeof entry.data.taskRunId === "string" ? entry.data.taskRunId : undefined;
    if (taskId || taskRunId) return { taskId, taskRunId };
  }
  return undefined;
}

function compactSessionTask(cwd: string, sessionId: string): TaskContract | undefined {
  return activeSessionTask(cwd, sessionId) as TaskContract | undefined;
}

function semanticCompactionInstructions(cwd: string, sessionId: string): string {
  return buildSemanticCompactionInstructions(compactSessionTask(cwd, sessionId));
}

function environmentFeatureEnabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

export default function piagentGuard(pi: ExtensionAPI) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const policy = loadPolicy(extensionDir);
  const bashResults = createBashResultLedger({ maxEntries: 300 });
  const dynamicToolsEnabled = environmentFeatureEnabled("PIAGENT_DYNAMIC_TOOLS");
  const contextTelemetryEnabled = environmentFeatureEnabled("PIAGENT_CONTEXT_TELEMETRY");
  const runtimeSnapshotEnabled = environmentFeatureEnabled("PIAGENT_RUNTIME_SNAPSHOT");
  const solverMode = solverModeFromEnvironment(process.env.PIAGENT_SOLVER_MODE);
  const parentRoutingMode = parentRoutingModeFromEnvironment(process.env.PIAGENT_PARENT_ROUTING);
  const routingObjective = routingObjectiveFromEnvironment(process.env.PIAGENT_ROUTING_OBJECTIVE);
  const autoContextEnabled = environmentFeatureEnabled("PIAGENT_AUTO_CONTEXT");
  const autoRecoveryEnabled = environmentFeatureEnabled("PIAGENT_AUTO_RECOVERY");
  const runtimeState = new RuntimeSessionState({
    maxObservedContext: contextBudgetConfig(policy).maxManifestFiles
  });
  const sourceMutationGuardBindings = createSourceMutationGuardBindings(policy, loadProfileFromContext);
  const runtimeSnapshotCapture = new RuntimeSnapshotCapture(), runtimeVersions = readRuntimeVersionMetadata(PLATFORM_ROOT);
  const solverShadow = solverMode === "off" ? undefined : new SolverShadowRuntime(solverMode);
  const modelRouteRuntime = new ModelRouteRuntime(parentRoutingMode, routingObjective);
  const modelSelectionProvenance = new ModelSelectionProvenanceTracker();
  const trajectoryRuntime = new TrajectoryRuntime(), phaseToolRuntime = new PhaseToolRuntime(pi, dynamicToolsEnabled ? phaseToolModeFromEnvironment(process.env.PIAGENT_PHASE_TOOLS) : "off", telemetry, (ctx) => {
    const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined; return task && authorityReplacementState(ctx.cwd, task).required ? "new-attempt-required" : task?.workingTreeDigestMigration?.status;
  }, (ctx) => {
    const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
    return !task ? undefined : taskAuthorityDecision(task, "CAP-09", "block").allowed ? "on" : taskAuthorityDecision(task, "CAP-09", "observe").allowed ? "shadow" : "off";
  });
  const semanticRepairRuntime = new SemanticRepairRuntime({
    now: nowIso,
    trace: (ctx, task, payload) => {
      const trace = { ...payload, taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId };
      appendTrace(ctx.cwd, trace); appendSessionTrace(pi, trace); telemetry(ctx, trace);
    },
    openRepair: (ctx, task, observedAt) => phaseToolRuntime.apply(ctx, trajectoryRuntime.sync(
      ctx.cwd, ctx.sessionManager.getSessionId(), task,
      { sourceHook: "tool-result", recoveryRequested: true, recoveryMutationAllowed: true, observedAt }
    ))
  });
  let maybeStartAutomaticTask: (prompt: string, ctx: ExtensionContext) => Promise<{ started: boolean; text: string; task?: TaskContract } | undefined>;

  pi.on("model_select", (event, ctx) => {
    modelSelectionProvenance.observeModelSelection(ctx.sessionManager.getSessionId(), event.source);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    modelSelectionProvenance.observeThinkingSelection(ctx.sessionManager.getSessionId());
  });

  function freshModelRouteBoundary(ctx: ExtensionContext): boolean {
    try {
      return !(ctx.sessionManager.getEntries() as Array<Record<string, any>>).some((entry) => (
        entry.type === "message" && entry.message?.role === "assistant"
      ));
    } catch {
      return false;
    }
  }

  async function evaluateModelRoute(ctx: ExtensionContext, features: TaskFeatures, runtimeSnapshot?: ReturnType<RuntimeSnapshotCapture["capture"]>) {
    const catalog = await captureAuthenticatedModelCatalogFromContext(ctx, {
      offline: ["1", "true", "yes", "on"].includes(String(process.env.PI_OFFLINE ?? "").toLowerCase())
    });
    return modelRouteRuntime.evaluate(ctx.cwd, ctx.sessionManager.getSessionId(), {
      features,
      catalog,
      selectionSource: modelSelectionProvenance.source(ctx.sessionManager.getSessionId()),
      current: {
        provider: runtimeSnapshot?.provider ?? ctx.model?.provider ?? null,
        modelId: runtimeSnapshot?.modelId ?? ctx.model?.id ?? null,
        effort: runtimeSnapshot?.effectiveThinkingLevel ?? String(pi.getThinkingLevel())
      },
      freshTaskBoundary: freshModelRouteBoundary(ctx),
      hostBoundary: "unavailable"
    });
  }

  async function evaluateRetrievalRoute(ctx: ExtensionContext, features: TaskFeatures) {
    let indexReady = false;
    try {
      const status = await contextIndexV2Status(ctx.cwd, { excludePatterns: contextIndexExcludePatterns(policy, loadProfileFromContext(ctx)) });
      indexReady = status.exists && !status.stale;
    } catch {}
    return planRetrievalRoute({ features, indexReady, observedConfidence: "unknown", helpersMode: helpersMode() });
  }

  function retrievalKey(ctx: ExtensionContext, query: string): string {
    const signal = classifyContextTask(query);
    return crypto.createHash("sha256")
      .update(JSON.stringify({
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        terms: [...signal.terms].sort(),
        paths: [...signal.paths].sort()
      }))
      .digest("hex");
  }

  function promptPackKey(ctx: ExtensionContext, promptHash: string): string {
    return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}\u0000${promptHash}`;
  }

  function telemetry(ctx: ExtensionContext, payload: Record<string, unknown>): void {
    if (!contextTelemetryEnabled) return;
    try {
      const safePayload = redactForStorage(payload) as Record<string, unknown>;
      let taskIdentity = runtimeState.taskIdentity(ctx);
      if (!taskIdentity) {
        const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
        if (task) {
          runtimeState.cacheTaskIdentity(ctx, task);
          taskIdentity = { taskId: task.taskId, taskRunId: task.taskRunId };
        }
      }
      appendContextTelemetry(ctx.cwd, {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: currentSessionName(ctx),
        model: `${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`,
        thinkingLevel: String(pi.getThinkingLevel()),
        ...taskIdentity,
        ...safePayload
      });
    } catch {
      // Telemetry is local observability. It must never block the agent loop.
    }
  }

  function activateToolGroups(ctx: ExtensionContext, groups: PiagentToolGroup[], additive = false): string[] {
    const current = pi.getActiveTools();
    if (!dynamicToolsEnabled) return current;
    const selected = new Set<string>();
    if (additive) {
      for (const toolName of current) selected.add(toolName);
    } else {
      for (const toolName of current) {
        if (!PIAGENT_TOOL_NAMES.has(toolName)) selected.add(toolName);
      }
    }
    const normalizedGroups = [...new Set<PiagentToolGroup>(groups)];
    for (const toolName of PIAGENT_TOOL_ORDER) {
      if (normalizedGroups.some((group) => PIAGENT_TOOL_GROUPS[group].includes(toolName as never))) {
        selected.add(toolName);
      }
    }
    const ordered = [
      ...current.filter((toolName) => selected.has(toolName) && !PIAGENT_TOOL_NAMES.has(toolName)),
      ...PIAGENT_TOOL_ORDER.filter((toolName) => selected.has(toolName))
    ];
    const unchanged = ordered.length === current.length && ordered.every((toolName, index) => toolName === current[index]);
    if (!unchanged) pi.setActiveTools(ordered);
    telemetry(ctx, {
      event: "tool_activation",
      groups: normalizedGroups,
      additive,
      previousCount: current.length,
      activeCount: ordered.length,
      piagentTools: ordered.filter((toolName) => PIAGENT_TOOL_NAMES.has(toolName))
    });
    phaseToolRuntime.reapply(ctx);
    return pi.getActiveTools();
  }

  function recoveryDecisionForTask(
    ctx: ExtensionContext,
    task: TaskContract,
    gate?: { missing: string[]; missingVerifyCommands: string[] },
    currentTreeDigest?: string
  ): RecoveryDecision {
    const latestExactVerifier = latestObservedVerification(task.verifyEvidence.filter((evidence) => evidence.matchedProfileCommand === true));
    const failed = latestExactVerifier && latestExactVerifier.exitCode !== 0 ? latestExactVerifier : undefined;
    const summary = failed?.summary ?? gate?.missing.join("; ") ?? "unknown task recovery evidence";
    let recordedClassification: FailureClassification | undefined;
    try {
      const replay = replayTaskCheckpoints(ctx.cwd, task.taskRunId, task);
      if (replay.corruptions.length === 0) {
        const checkpoint = replay.checkpoints
          .filter((item) => item.phase === "verify" && item.status === "failed")
          .at(-1) as any;
        recordedClassification = checkpoint?.evidence?.failureClassification as FailureClassification | undefined;
      }
    } catch {
      // A missing/corrupt journal cannot grant recovery mutation; the fallback
      // classifier remains fail-closed for unknown evidence.
    }
    const classification = selectCompletionRecoveryClassification(
      recordedClassification,
      gate?.missing,
      summary,
      failed?.exitCode ?? 1
    );
    const trajectory = trajectoryRuntime.status(ctx.cwd, task.taskRunId);
    const dependencyMutationAuthorized = task.scope.some((entry) => /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|[^/]*(?:config|lock)[^/]*)$/i.test(entry));
    return selectRecoveryDecision({
      featureEnabled: autoRecoveryEnabled && taskAuthorityDecision(task, "CAP-12", "model-turn").allowed,
      task: {
        taskId: task.taskId,
        taskRunId: task.taskRunId,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        changeMode: task.changeMode
      },
      classification,
      currentPhase: trajectory.enforcementSafe ? trajectory.phase ?? "verify" : "handoff",
      history: runtimeState.recoveryHistory(task.taskId),
      proposedHypothesisRef: classification.reasonCodes[0] ? `reason:${classification.reasonCodes[0]}` : null,
      exactVerifierAvailable: (gate?.missingVerifyCommands.length ?? task.verifyCommands.length) > 0,
      currentTreeMatchesEvidence: currentTreeDigest && latestExactVerifier?.workingTreeDigest
        ? currentTreeDigest === latestExactVerifier.workingTreeDigest
        : true,
      dependencyMutationAuthorized
    });
  }

  function trajectoryRecoveryOptions(ctx: ExtensionContext, task: TaskContract, options: any): any {
    return {
      ...options,
      recoveryMutationAllowed: typeof options.recoveryMutationAllowed === "boolean"
        ? options.recoveryMutationAllowed
        : autoRecoveryEnabled && taskAuthorityDecision(task, "CAP-12", "model-turn").allowed
          ? recoveryDecisionForTask(ctx, task).sourceMutationAllowed
          : undefined
    };
  }

  const activityInspector = registerActivityInspector(pi, {
    activeTask: (ctx) => activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined,
    readEvents: (cwd) => readContextTelemetry(cwd, { limit: 5_000 }) as any[],
    protectedPaths: (ctx) => effectiveProtectedPaths(policy, loadProfile(ctx.cwd)).readProtectedPaths,
    selectAction: selectRuntimeAction,
    emit: emitRuntimeMessage
  });

  function recordActivity(ctx: ExtensionContext, payload: Record<string, unknown>): void {
    telemetry(ctx, payload);
    activityInspector.observe(ctx, payload);
  }

  registerSessionStartHook(pi, {
    state: runtimeState,
    loadProfile: loadProfileFromContext,
    projectProfileExists: (cwd) => fs.existsSync(projectProfilePath(cwd)),
    activateToolGroups,
    taskReference: sessionTaskReference,
    activeTask: (cwd, sessionId) => activeSessionTask(cwd, sessionId) as TaskContract | undefined,
    resolveTask: (cwd, reference, sessionId) => resolveTaskContract(cwd, reference, sessionId) as TaskContract | undefined,
    resolveTaskAny: (cwd, reference) => resolveTaskContract(cwd, reference, undefined) as TaskContract | undefined,
    bindTask: bindSessionTask,
    writeTask,
    capabilityState: (ctx) => verifyProjectCapabilityState(extensionDir, ctx.cwd, ctx.isProjectTrusted(), { allowRepin: true, forceFull: true, sessionId: ctx.sessionManager.getSessionId() }),
    permissionProfile: (ctx, profile) => resolvePermissionProfile(profile, policy, permissionOverrideFromContext(ctx)),
    legacyProjectWarning: legacyProjectStateWarning,
    mcpReadinessNotice,
    updateAvailabilityNotice,
    contextExcludePatterns: (profile) => contextIndexExcludePatterns(policy, profile),
    inspectResume: (cwd, task, sessionId) => inspectTaskResumeState(cwd, task, sessionId, undefined, {
      protectedPaths: effectiveProtectedPaths(policy, loadProfile(cwd)).readProtectedPaths
    }),
    syncTrajectory: (ctx, task) => {
      const snapshot = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
      const resume = workingTreeSnapshotHasUnavailableEvidence(snapshot)
        ? { openRepair: false }
        : { openRepair: taskAuthorityDecision(task, "CAP-13", "block").allowed && semanticRepairRuntime.resume({
            cwd: ctx.cwd,
            task,
            sessionId: ctx.sessionManager.getSessionId(),
            currentDigest: workingTreeEvidenceDigest(snapshot)
          }) };
      return phaseToolRuntime.apply(ctx, trajectoryRuntime.sync(ctx.cwd, ctx.sessionManager.getSessionId(), task, trajectoryRecoveryOptions(ctx, task, {
        sourceHook: "session-start",
        recoveryRequested: resume.openRepair || undefined,
        recoveryMutationAllowed: resume.openRepair || undefined
      })));
    },
    telemetry,
    afterStart: async (ctx) => { sourceMutationGuardBindings.bind(ctx); await activityInspector.refresh(ctx); }
  });

  registerSessionHooks(pi, {
    state: runtimeState,
    maxManifestFiles: contextBudgetConfig(policy).maxManifestFiles,
    telemetry,
    activeTask: (cwd, sessionId) => activeSessionTask(cwd, sessionId) as TaskContract | undefined,
    writeTask,
    bindTask: bindSessionTask,
    appendTrace,
    flushObservedTaskContext,
    onTurnEnd: activityInspector.refresh,
    onAgentSettled: activityInspector.refresh,
    beforeShutdown: (ctx) => {
      sourceMutationGuardBindings.unbind(ctx);
      activityInspector.dispose(ctx);
      sessionCapabilityDigests.delete(`${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`);
    }
  });

  registerInputHook(pi, {
    boilerplateCollapseChars: BOILERPLATE_COLLAPSE_CHARS,
    activeTask: (ctx) => activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined, authorityPolicy: (ctx, task) => ensureTaskAuthorityResumePolicy(ctx.cwd, task, { authorityProfile: loadProfileFromContext(ctx).authorityProfile, environment: process.env }),
    readProtectedPaths: (ctx) => effectiveProtectedPaths(policy, loadProfileFromContext(ctx)).readProtectedPaths,
    imageAccess: (ctx) => {
      const projectTrusted = ctx.isProjectTrusted();
      const profile = loadProfileFromContext(ctx);
      const permissionProfile = resolvePermissionProfile(profile, policy, permissionOverrideFromContext(ctx));
      const capabilityState = verifyProjectCapabilityState(extensionDir, ctx.cwd, projectTrusted, { sessionId: ctx.sessionManager.getSessionId() });
      return {
        roots: resolveDocumentRoots({
          cwd: ctx.cwd,
          profileRoots: profile.additionalReadRoots,
          environmentRoots: process.env.PIAGENT_ADDITIONAL_READ_ROOTS
        }),
        readProtectedPaths: effectiveProtectedPaths(policy, profile).readProtectedPaths,
        filesystemRead: capabilityState.filesystemRead,
        enforceFilesystemRead: permissionProfile.mode !== "trusted-full-access"
      };
    },
    activateToolGroups,
    telemetry
  });

  registerAgentStartHook(pi, {
    state: runtimeState,
    autoContextEnabled,
    activeTask: (ctx) => activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined,
    readProtectedPaths: (ctx) => effectiveProtectedPaths(policy, loadProfileFromContext(ctx)).readProtectedPaths,
    contextExcludePatterns: (ctx) => contextIndexExcludePatterns(policy, loadProfileFromContext(ctx)),
    promptPackKey,
    retrievalKey,
    startAutomaticTask: (prompt, ctx) => maybeStartAutomaticTask(prompt, ctx),
    runtimeSnapshot: runtimeSnapshotEnabled ? (ctx) => runtimeSnapshotCapture.capture(ctx, {
      effectiveThinkingLevel: String(pi.getThinkingLevel()),
      versions: runtimeVersions
    }) : undefined,
    persistRuntimeSnapshot: runtimeSnapshotEnabled ? (ctx, snapshot) => recordRuntimeSnapshotTelemetry(ctx.cwd, snapshot) : undefined,
    shadowSolver: ({ request, ctx, activeTask, runtimeSnapshot, protectedTarget }) => evaluateRuntimeSolver(
      solverShadow, { request, ctx, profile: loadProfileFromContext(ctx), activeTask, runtimeSnapshot, effort: String(pi.getThinkingLevel()), protectedTarget }
    ),
    modelRoute: ({ ctx, features, runtimeSnapshot }) => evaluateModelRoute(ctx, features, runtimeSnapshot),
    syncTrajectory: (ctx, task, options) => phaseToolRuntime.apply(ctx, trajectoryRuntime.sync(ctx.cwd, ctx.sessionManager.getSessionId(), task, trajectoryRecoveryOptions(ctx, task, options))),
    telemetry
  });

  registerCompletionHook(pi, {
    state: runtimeState,
    maxManifestFiles: contextBudgetConfig(policy).maxManifestFiles,
    activeTask: (ctx) => activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined,
    flushObservedTaskContext,
    completionProjection: completionTaskProjection,
    evaluateGate: (cwd, task, currentDigests, currentDigest) => {
      const gate = evaluateTaskGate(cwd, task, policy, { currentDigests, currentWorkingTreeDigest: currentDigest });
      const repairBlock = taskAuthorityDecision(task, "CAP-13", "block").allowed ? semanticRepairRuntime.completionBlock(cwd, task.taskRunId) : undefined;
      return repairBlock ? { ...gate, decision: "fail", missing: [...new Set([...gate.missing, repairBlock])] } : gate;
    },
    writeTask,
    activateBaseTools: (ctx) => activateToolGroups(ctx, []),
    appendTrace,
    appendSessionTrace,
    telemetry,
    semanticReviewAllowed: (task) => taskAuthorityDecision(task, "CAP-13", "model-turn").allowed,
    finalGateMode: (ctx) => resolveRuntimePolicy(loadProfileFromContext(ctx)).finalGate,
    verifierInstructions: verifierCommandInstructions,
    recoveryDecision: (ctx, task, gate, currentDigest) => recoveryDecisionForTask(ctx, task, gate, currentDigest),
    syncTrajectory: (ctx, task, options) => phaseToolRuntime.apply(ctx, trajectoryRuntime.sync(ctx.cwd, ctx.sessionManager.getSessionId(), task, trajectoryRecoveryOptions(ctx, task, options)))
  });

  registerToolResultHook(pi, {
    state: runtimeState,
    activeTask: (ctx) => activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined,
    maxManifestFiles: contextBudgetConfig(policy).maxManifestFiles,
    readProtectedPaths: (ctx) => effectiveProtectedPaths(policy, loadProfileFromContext(ctx)).readProtectedPaths,
    recordObservedBash: (observed) => bashResults.record(observed),
    observedBashLedgerPath,
    redactText,
    observedTaskContext: observedTaskContextFromToolResult,
    recordObservedTaskChanges,
    recordObservedTaskVerification,
    extractLikelyPath: extractLikelyPathFromInput,
    mutationTargets: taskMutationTargets,
    isShellTool: (toolName) => SHELL_TOOL_NAMES.has(toolName),
    telemetry,
    activity: recordActivity,
    now: nowIso,
    completeSemanticRepair: (ctx, event, metadata) => {
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      return task && taskAuthorityDecision(task, "CAP-13", "mutate").allowed ? semanticRepairRuntime.complete(ctx, task, event, metadata) : undefined;
    },
    syncTrajectory: (ctx, contextObserved) => {
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      return task ? phaseToolRuntime.apply(ctx, trajectoryRuntime.sync(ctx.cwd, ctx.sessionManager.getSessionId(), task, trajectoryRecoveryOptions(ctx, task, { sourceHook: "tool-result", contextObserved }))) : undefined;
    }
  });

  registerToolCallHook(pi, {
    extractLikelyPath: extractLikelyPathFromInput,
    redactText,
    telemetry,
    activity: recordActivity,
    beforeAuthorize: (event, ctx) => {
      if (!["edit", "write", "apply_patch"].includes(event.toolName)) return;
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      if (!task || task.trace.outcome !== "pending" || task.changeMode !== "source-change") return;
      if (!taskAuthorityDecision(task, "CAP-13", "mutate").allowed) return;
      const phase = trajectoryRuntime.status(ctx.cwd, task.taskRunId);
      if (!phase.enforcementSafe || !["verify", "review"].includes(String(phase.phase))) return;

      const currentSnapshot = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
      if (workingTreeSnapshotHasUnavailableEvidence(currentSnapshot)) return;
      const currentDigest = workingTreeEvidenceDigest(currentSnapshot);
      const expectedReviewPaths = taskDeltaFilesFromSnapshot(task, currentSnapshot);
      const toolInput = isPlainRecord(event.input) ? event.input : {};
      const targets = taskMutationTargets(ctx.cwd, event.toolName, toolInput);
      const boundedInScopeMutation = targets.length > 0
        && targets.every((file) => taskScopeIncludesPath(task.scope, file));

      if (phase.phase === "verify" && boundedInScopeMutation && semanticRepairRuntime.prepare({
        ctx, task, event, currentDigest, currentDeltaPaths: expectedReviewPaths, targetPaths: targets,
        verifierCurrent: allVerifyCommandsPassCurrentTree(task, currentDigest)
      })) return;

      let checkpoint = runtimeState.performanceReviewCheckpoint(task.taskRunId);
      const checkpointReady = checkpoint?.workingTreeDigest === currentDigest
        && checkpoint.reviewSatisfied
        && !checkpoint.invalidated
        && exactReviewPathCoverage(expectedReviewPaths, checkpoint.expectedPaths)
        && exactReviewPathCoverage(expectedReviewPaths, checkpoint.reviewedPaths);
      const credit = runtimeState.performanceReviewCredit(task.taskRunId, currentDigest);
      const creditReady = Boolean(credit && exactReviewPathCoverage(expectedReviewPaths, credit.reviewedPaths));
      if (!checkpointReady && !creditReady) return;

      if (!checkpointReady && creditReady && credit) {
        runtimeState.rememberPerformanceReviewCheckpoint(task.taskRunId, currentDigest, 0, expectedReviewPaths, credit.reviewedPaths);
        checkpoint = runtimeState.performanceReviewCheckpoint(task.taskRunId);
      }

      const reviewDecision = performanceReviewToolDecision({
        toolName: event.toolName,
        input: event.input,
        checkpoint,
        task,
        currentWorkingTreeDigest: currentDigest,
        targetPaths: targets
      });
      if (reviewDecision) {
        runtimeState.denyPerformanceReviewTool(task.taskRunId);
        return reviewDecision;
      }

      if (targets.length === 0 || targets.some((file) => !taskScopeIncludesPath(task.scope, file))) return;
      const result = trajectoryRuntime.sync(ctx.cwd, ctx.sessionManager.getSessionId(), task, {
        sourceHook: "tool-call",
        recoveryRequested: true,
        recoveryMutationAllowed: true,
        observedAt: nowIso()
      });
      phaseToolRuntime.apply(ctx, result);
      observeTrajectorySync(ctx, result, telemetry);
      if (!result.enforcementSafe || result.state?.currentPhase !== "repair") {
        return { block: true, reason: `Task ${task.taskId} could not enter an audited repair phase before review-driven mutation.` };
      }
      return;
    },
    reviewBudgetDecision: (event, ctx) => {
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      const checkpoint = task ? runtimeState.performanceReviewCheckpoint(task.taskRunId) : undefined;
      if (!task || !checkpoint || !taskAuthorityDecision(task, "CAP-13", "mutate").allowed) return;
      const currentDigest = workingTreeEvidenceDigest(workingTreeSnapshot(ctx.cwd) as Record<string, string>);
      const phase = trajectoryRuntime.status(ctx.cwd, task.taskRunId);
      const toolInput = isPlainRecord(event.input) ? event.input : {};
      const targets = taskMutationTargets(ctx.cwd, event.toolName, toolInput);
      if (["edit", "write", "apply_patch"].includes(event.toolName) && (
        targets.length === 0 || targets.some((file) => !taskScopeIncludesPath(task.scope, file))
      )) {
        runtimeState.denyPerformanceReviewTool(task.taskRunId);
        return { block: true, reason: `Task ${task.taskId} semantic repair must stay inside its declared task scope.` };
      }
      const reviewDecision = performanceReviewToolDecision({
        toolName: event.toolName,
        input: event.input,
        checkpoint,
        task,
        currentWorkingTreeDigest: currentDigest,
        currentPhase: phase.phase,
        targetPaths: targets
      });
      if (reviewDecision) runtimeState.denyPerformanceReviewTool(task.taskRunId);
      return reviewDecision;
    },
    beforeStart: (_event, ctx) => {
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      const control = task?.trace.outcome === "pending" ? inspectTaskControlState(ctx.cwd, task) : null;
      if (control?.dispatchBlocked) return { block: true, reason: `Task lifecycle control blocks tool start while state is ${control.state}.` };
    },
    afterDecision: (_event, ctx, metadata) => {
      if (metadata.allowed) return;
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      if (task) {
        semanticRepairRuntime.reject({ cwd: ctx.cwd, taskRunId: task.taskRunId, toolCallId: metadata.toolCallId, recordedAt: nowIso() });
      }
    },
    afterAuthorized: (event, ctx, metadata) => {
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      if (task?.trace.outcome === "pending") {
        const snapshot = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
        const currentDigest = workingTreeEvidenceDigest(snapshot);
        const toolInput = isPlainRecord(event.input) ? event.input : {};
        const targets = taskMutationTargets(ctx.cwd, event.toolName, toolInput);
        const semanticPending = semanticRepairRuntime.pending(ctx.cwd, task.taskRunId, metadata.toolCallId);
        const reservationTargets = semanticPending?.kind === "mutation" ? semanticPending.targetPaths : targets;
        if ((["edit", "write", "apply_patch"].includes(event.toolName) || semanticPending?.kind === "mutation") && reservationTargets.length > 0) {
          runtimeState.reserveAuthorizedModelMutation(
            { taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId },
            metadata.toolCallId,
            snapshot,
            reservationTargets,
            ["edit", "write", "apply_patch"].includes(event.toolName)
              ? expectedModelMutationProof(ctx.cwd, event.toolName, toolInput, reservationTargets)
              : { expectedContentDigests: {}, preContentDigests: {}, fullContentPaths: [], replacePaths: [] }
          );
        }
        const checkpoint = runtimeState.performanceReviewCheckpoint(task.taskRunId);
        const kind = performanceReviewToolKind({ toolName: event.toolName, input: event.input, checkpoint, task });
        if (checkpoint && kind) {
          runtimeState.reservePerformanceReviewTool(task.taskRunId, {
            toolCallId: metadata.toolCallId,
            kind,
            toolName: event.toolName,
            workingTreeDigest: currentDigest,
            workingTreeSnapshot: snapshot,
            targetPaths: targets
          });
        }
      }
      return phaseToolRuntime.apply(ctx, trajectoryRuntime.syncOptionalToolCall(
        ctx.cwd,
        ctx.sessionManager.getSessionId(),
        task,
        event,
        nowIso()
      ));
    },
    authorize: async (event, ctx) => {
    const preTask = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
    const preInput = isPlainRecord(event.input) ? event.input : {};
    const preSnapshot = preTask ? workingTreeSnapshot(ctx.cwd) as Record<string, string> : undefined;
    const reservedFirstCall = Boolean(preTask && preSnapshot && !workingTreeSnapshotHasUnavailableEvidence(preSnapshot) && semanticRepairRuntime.reservedCallMatches({
      cwd: ctx.cwd,
      taskRunId: preTask.taskRunId,
      sessionId: ctx.sessionManager.getSessionId(),
      toolCallId: String(event.toolCallId),
      toolName: event.toolName,
      currentDigest: workingTreeEvidenceDigest(preSnapshot),
      targetPaths: taskMutationTargets(ctx.cwd, event.toolName, preInput)
    }));
    const phaseDecision = reservedFirstCall || (preTask?.workingTreeDigestMigration?.status === "verification-refresh-required" && SHELL_TOOL_NAMES.has(event.toolName)) ? undefined : phaseToolRuntime.toolDecision(ctx, event.toolName);
    if (phaseDecision) return phaseDecision;
    const projectTrusted = ctx.isProjectTrusted();
    const eventInput = isPlainRecord(event.input) ? event.input : {};
    const backendDecision = executionBackendToolDecision(isTaskMutationTool(event.toolName, eventInput));
    if (!backendDecision.allowed) return { block: true, reason: backendDecision.reason };
    const capabilityState = verifyProjectCapabilityState(extensionDir, ctx.cwd, projectTrusted, { sessionId: ctx.sessionManager.getSessionId() });
    const recoveryTools = new Set(["piagent_profile_options", "piagent_profile_apply", "piagent_context", "read", "grep", "find", "ls"]);
    if (!capabilityState.ok && !recoveryTools.has(event.toolName)) {
      return { block: true, reason: capabilityState.reason ?? "Capability lock validation failed." };
    }
    const profile = loadProfile(ctx.cwd, projectTrusted);
    const runtime = resolveRuntimePolicy(profile);
    const permissionProfile = resolvePermissionProfile(profile, policy, permissionOverrideFromContext(ctx));
    const pathPolicy = effectiveProtectedPaths(policy, profile);
    const permissionDecision = evaluatePermissionProfileToolAccess(event.toolName, permissionProfile);
    if (permissionDecision.block) {
      return { block: true, reason: permissionDecision.reason };
    }
    const toolDecision = evaluateToolPolicy(event.toolName, profile, policy);
    if (toolDecision.decision === "block" && permissionProfile.mode !== "trusted-full-access") {
      return { block: true, reason: `Tool registry blocked ${event.toolName}: ${toolDecision.reason}` };
    }
    // An advisory verdict that is computed and discarded makes advisory mode
    // indistinguishable from off, which is not what the mode is for.
    if (toolDecision.decision === "warn" && !runtimeState.hasAdvisedTool(ctx, event.toolName)) {
      runtimeState.rememberAdvisedTool(ctx, event.toolName);
      const missing = toolDecision.requiredCapabilities.length > 0
        ? ` Declare ${toolDecision.requiredCapabilities.join(", ")} in profile mcpCapabilities to clear this.`
        : "";
      ctx.ui.notify(
        `Tool registry (advisory): ${event.toolName} — ${toolDecision.reason}${missing} Allowed to run; set runtimePolicy.toolRegistry to enforce to block instead.`,
        "warning"
      );
      recordActivity(ctx, {
        activityId: `security-warning:${ctx.sessionManager.getSessionId()}:${event.toolName}`,
        event: "security_warning",
        recordedAt: nowIso(),
        toolName: event.toolName,
        warningKind: "tool-registry-advisory",
        reason: redactText(`${toolDecision.reason}${missing}`)
      });
    }
    const toolInput = event.input && typeof event.input === "object"
      ? event.input as Record<string, unknown>
      : {};
    const sessionTask = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
    const resumeBlock = sessionTask ? runtimeState.taskResumeBlock(sessionTask.taskRunId) : undefined;
    if (resumeBlock && isTaskMutationTool(event.toolName, toolInput)) {
      return { block: true, reason: `Task resume is blocked: ${resumeBlock}` };
    }
    const profileMode = profile.mode ?? "unprofiled";
    const governedTaskProfile = !profileMode.startsWith("unprofiled") && !profileMode.includes("unreadable");
    const taskContractRequired = governedTaskProfile
      && runtime.finalGate === "enforce"
      && finalGateConfig(policy).requireTaskContract;
    if (sessionTask?.trace.outcome === "pending" && sessionTask.changeMode === "read-only" && !SHELL_TOOL_NAMES.has(event.toolName) && isTaskMutationTool(event.toolName, toolInput)) {
      return {
        block: true,
        reason: `Task ${sessionTask.taskId} is read-only; ${event.toolName} cannot mutate project or external state in this task. Start a source-change task for implementation.`
      };
    }
    const preparedInput = prepareToolInputForPolicy(event.toolName, toolInput, policy);
    if (preparedInput.reason) {
      return { block: true, reason: `Blocked ${event.toolName}: ${preparedInput.reason}.` };
    }

    // Before anything is asked of an MCP server, whether this machine agreed to
    // that server at all.
    const approvalDecision = evaluateMcpApproval(ctx.cwd, event.toolName, toolInput);
    if (approvalDecision.block) {
      return { block: true, reason: approvalDecision.reason };
    }
    let shellProjectMutation = false;
    let shellMutationTargets: string[] = [];
    let shellMutationTargetBounded = false;
    let configuredVerifierShell = false;
    let authorizedShellCommand = "";
    let authorizedShellSegments: Array<{ words: string[] }> = [];
    let pendingHumanApproval: { prompt: string; title: string; action: Omit<ApprovalActionDraft, "treePrecondition"> } | null = null;
    if (SHELL_TOOL_NAMES.has(event.toolName)) {
      const shellInput = extractShellCommandInput(toolInput);
      if (!shellInput.command) {
        return { block: true, reason: `Blocked ${event.toolName}: ${shellInput.reason ?? "shell command input is missing or unsupported"}.` };
      }
      const command = normalizeShellCommandForPolicy(shellInput.command);
      const execDecision = evaluateExecPolicy(command, profile, policy);
      authorizedShellCommand = command;
      authorizedShellSegments = execDecision.segments;
      shellProjectMutation = isProjectMutatingShellCommand(command, execDecision.segments);
      configuredVerifierShell = Boolean(sessionTask && commandMatchesVerifyPlan(command, sessionTask.verifyCommands));
      const shellWriteCandidates = extractShellWritePathCandidates(command);
      shellMutationTargetBounded = shellWriteCandidates.length > 0;
      shellMutationTargets = shellWriteCandidates
        .map((candidate) => normalizeRelative(ctx.cwd, candidate))
        .filter((candidate): candidate is string => Boolean(
          candidate
          && candidate !== "."
          && candidate !== ".."
          && !candidate.startsWith("../")
          && !candidate.startsWith(".pi/piagent-state/")
        ));
      if (sessionTask?.trace.outcome === "pending" && sessionTask.changeMode === "read-only" && !isReadOnlyTaskShellCommand(command, execDecision.segments)) {
        return {
          block: true,
          reason: `Task ${sessionTask.taskId} is read-only; this shell command is not in the read-only inspection allowlist.`
        };
      }
      if (execDecision.mode !== "off" && execDecision.decision === "forbid") {
        return { block: true, reason: execDecision.reasons.join("; ") };
      }

      const protectedHit = findProtectedPathInCommand(command, pathPolicy.shellProtectedPaths);
      if (protectedHit) {
        return { block: true, reason: `Command touches protected path: ${protectedHit.candidate} matches ${protectedHit.pattern}` };
      }
      const protectedGlobHit = shellGlobTargetsProtectedPath(command, pathPolicy.shellProtectedPaths);
      if (protectedGlobHit) {
        return {
          block: true,
          reason: `Command glob can target protected path: ${protectedGlobHit.glob} can match ${protectedGlobHit.example} via ${protectedGlobHit.pattern}`
        };
      }
      const resolvedProtectedHit = findResolvedProtectedPathInCommand(ctx.cwd, command, pathPolicy.shellProtectedPaths);
      if (resolvedProtectedHit) {
        return {
          block: true,
          reason: `Command resolves to protected path: ${resolvedProtectedHit.candidate} resolves to ${resolvedProtectedHit.resolved} matching ${resolvedProtectedHit.pattern}`
        };
      }
      const unresolvedExpansions = pathPolicy.shellProtectedPaths.length > 0
        ? unresolvedPathExpansions(command)
        : [];
      if (unresolvedExpansions.length > 0) {
        return { block: true, reason: unresolvedExpansionReason("Command", unresolvedExpansions) };
      }

      const confirmationReasons = execDecision.mode !== "off" && execDecision.decision === "prompt" ? [...execDecision.reasons] : [];
      const externalReason = findShellExternalConfirmationReason(execDecision.segments, externalActionPolicyConfig(policy));
      if (externalReason) confirmationReasons.push(externalReason);
      if (confirmationReasons.length > 0) {
        pendingHumanApproval = { prompt: `Command requires confirmation.\n\n${confirmationReasons.join("\n")}\n\nAllow?`, title: "Piagent exec policy confirmation",
          action: { kind: externalReason ? "external-provider-action" : "workspace-patch", preconditionClass: externalReason ? "runtime-only" : "workspace-tree", toolName: event.toolName, rawAction: { toolName: event.toolName, command, input: preparedInput.input },
            commandPreview: command, parameterPreview: preparedInput.confirmationSummary ?? "Shell command", targetPaths: shellMutationTargets, targetSummaries: confirmationReasons, provider: externalReason ? "shell-external" : null, urlOrigin: null,
            requestedScope: "one-shell-command", reason: confirmationReasons.join("; "), riskClass: shellProjectMutation ? "high" : "medium", allowConsequence: "Run this exact command once after the guard rechecks the task and working tree.", denyConsequence: "Block this command and return the denial to the active Pi operation." } };
      }
    }

    const proxyShellDecision = evaluateMcpProxyShellProtectedAccess(
      ctx.cwd,
      preparedInput,
      pathPolicy.shellProtectedPaths
    );
    if (proxyShellDecision.block) {
      return { block: true, reason: proxyShellDecision.reason };
    }
    const policyToolIdentity = preparedInput.proxyToolName ?? event.toolName;
    const usesKnownExternalProvider = externalActionPolicyConfig(policy).providerKeywords
      .some((provider) => actionTextMatchesAny(policyToolIdentity, [provider]));
    // Shell inputs need command grammar, not field-by-field path guessing: an
    // exclusion selector in `args` is not an accessed path. The semantic shell
    // checks above already inspect the normalized command, including redirects.
    const pathDecision = SHELL_TOOL_NAMES.has(event.toolName) ? { block: false, reason: undefined } : evaluatePathLikeToolAccess(
      ctx.cwd,
      preparedInput.proxyToolName ?? event.toolName,
      preparedInput.input,
      pathPolicy.writeProtectedPaths,
      pathPolicy.readProtectedPaths,
      pathPolicy.readOnlyPaths,
      permissionProfile.mode === "trusted-full-access" ? undefined : capabilityState.filesystemRead,
      permissionProfile.mode === "trusted-full-access" ? undefined : capabilityState.filesystemWrite,
      {
        forceScopeAware: Boolean(preparedInput.proxyToolName),
        forceWrite: preparedInput.proxyAction?.decision === "confirm",
        allowAmbiguousFilesystemContentFields: !usesKnownExternalProvider && !isPiagentTool(event.toolName)
      }
    );
    if (pathDecision.block) {
      return { block: true, reason: pathDecision.reason };
    }

    if (!SHELL_TOOL_NAMES.has(event.toolName)) {
      const classifiedExternalAction = classifyExternalAction(event.toolName, preparedInput.input, policy);
      const externalAction = preparedInput.proxyShellCarrier && classifiedExternalAction.decision !== "confirm"
        ? {
            decision: "confirm" as const,
            provider: typeof toolInput.server === "string" && toolInput.server.trim() ? toolInput.server.trim() : "mcp-proxy",
            action: "shell-command",
            evidence: classifiedExternalAction.evidence
          }
        : classifiedExternalAction;
      if (externalAction.decision === "confirm") {
        const inputSummary = preparedInput.confirmationSummary ? `\ninput: ${preparedInput.confirmationSummary}` : "";
        pendingHumanApproval = { prompt: `External provider action requires confirmation.\n\nprovider: ${externalAction.provider}\naction: ${externalAction.action}\ntool: ${event.toolName}${inputSummary}\n\nAllow?`, title: "Piagent external action confirmation",
          action: { kind: "external-provider-action", preconditionClass: "runtime-only", toolName: event.toolName, rawAction: { toolName: event.toolName, input: preparedInput.input, provider: externalAction.provider, action: externalAction.action },
            commandPreview: null, parameterPreview: preparedInput.confirmationSummary ?? String(externalAction.action), targetPaths: [], targetSummaries: [], provider: String(externalAction.provider),
            urlOrigin: null, requestedScope: "one-external-action", reason: `External provider action ${String(externalAction.action)} requires confirmation`, riskClass: "high", allowConsequence: "Release this exact provider action once after the guard rechecks runtime authority.", denyConsequence: "Block the provider action without changing external state." } };
      }
    }

    const mutationTargets = SHELL_TOOL_NAMES.has(event.toolName)
      ? shellMutationTargets
      : taskMutationTargets(ctx.cwd, event.toolName, toolInput);
    const directProjectMutation = !SHELL_TOOL_NAMES.has(event.toolName) && (
      WRITE_TOOL_NAMES.has(event.toolName)
      || mutationTargets.length > 0
      || preparedInput.proxyShellCarrier === true
    );
    const semanticOpaqueCarrier = normalizeActionToken(event.toolName) === "mcp"
      || Boolean(mcpServerFromToolCall(event.toolName, toolInput, repositoryMcpGate(ctx.cwd).serverNames));
    const semanticSnapshot = sessionTask ? workingTreeSnapshot(ctx.cwd) as Record<string, string> : undefined;
    const semanticAuthorization = sessionTask && semanticSnapshot && (shellProjectMutation || directProjectMutation || SHELL_TOOL_NAMES.has(event.toolName) || semanticOpaqueCarrier)
      ? semanticRepairRuntime.authorize({
          cwd: ctx.cwd,
          task: sessionTask,
          sessionId: ctx.sessionManager.getSessionId(),
          toolCallId: String(event.toolCallId),
          toolName: event.toolName,
          currentDigest: workingTreeSnapshotHasUnavailableEvidence(semanticSnapshot) ? "unavailable" : workingTreeEvidenceDigest(semanticSnapshot),
          targetPaths: mutationTargets,
          projectMutation: shellProjectMutation || directProjectMutation,
          exactVerifier: configuredVerifierShell,
          shellLike: SHELL_TOOL_NAMES.has(event.toolName),
          opaqueCarrier: semanticOpaqueCarrier,
          targetExtractionComplete: SHELL_TOOL_NAMES.has(event.toolName)
            ? !shellHasOpaqueWritePrimitive(authorizedShellCommand)
            : !semanticOpaqueCarrier && preparedInput.proxyShellCarrier !== true,
          recordedAt: nowIso()
        })
      : { handled: false, allowed: false, bypassPhase: false };
    if (semanticAuthorization.handled && !semanticAuthorization.allowed) {
      return { block: true, reason: semanticAuthorization.reason ?? "Semantic repair authorization failed closed." };
    }
    const phaseMutationDecision = semanticAuthorization.bypassPhase ? undefined : phaseToolRuntime.mutationDecision(ctx, {
      projectMutation: shellProjectMutation || directProjectMutation, exactSourceVerifier: configuredVerifierShell,
      verificationCarrier: SHELL_TOOL_NAMES.has(event.toolName)
    });
    if (phaseMutationDecision) return phaseMutationDecision;
    if (pendingHumanApproval && !sessionTask) {
      const approval = await piApprovalBroker.request({ cwd: ctx.cwd, rawSessionId: ctx.sessionManager.getSessionId(), toolCallId: String(event.toolCallId), expectedTask: null, action: { ...pendingHumanApproval.action, preconditionClass: "runtime-only", treePrecondition: null }, terminalConfirm: () => ctx.ui.confirm(pendingHumanApproval!.prompt, pendingHumanApproval!.title) });
      if (!approval.allowed) return { block: true, reason: pendingHumanApproval.action.kind === "external-provider-action" && !SHELL_TOOL_NAMES.has(event.toolName) ? `User denied external provider action: ${event.toolName}` : `User denied command: ${pendingHumanApproval.action.reason}` };
      pendingHumanApproval = null;
    }
    if (sessionTask && sessionTask.trace.outcome !== "pending" && (shellProjectMutation || directProjectMutation)) {
      return {
        block: true,
        reason: `Task ${sessionTask.taskId} is ${sessionTask.trace.outcome}; start a new attempt or a fresh task before further project mutations.`
      };
    }
    if (!sessionTask && taskContractRequired && (shellProjectMutation || directProjectMutation)) {
      return {
        block: true,
        // Naming the tool matters: this is the first wall a new operator hits,
        // and "start the task first" does not say with what.
        reason: "A session-bound Task Implementation Contract is required before project files can be mutated."
          + " Call `piagent_task_start` once with explicit project-relative scope, then retry."
      };
    }
    if (sessionTask?.trace.outcome === "pending" && sessionTask.changeMode === "source-change") {
      if (
        shellProjectMutation
        && opaqueShellMutationNeedsBoundedTarget(authorizedShellCommand, authorizedShellSegments)
        && !shellMutationTargetBounded
        && !configuredVerifierShell
      ) {
        return {
          block: true,
          reason: `Task ${sessionTask.taskId} cannot run an opaque shell mutation whose write target is not statically bounded. Use edit/write/apply_patch, an explicit in-scope redirection, or the exact configured verifier.`
        };
      }
      const outsideScope = mutationTargets.filter((file) => !taskScopeIncludesPath(sessionTask.scope, file));
      if (outsideScope.length > 0) {
        return {
          block: true,
          reason: `Task ${sessionTask.taskId} cannot mutate paths outside its declared scope: ${outsideScope.join(", ")}.`
        };
      }
      const outsideEvidenceRoot = mutationTargets.filter((file) => !pathWithinChangeEvidenceRoot(ctx.cwd, file));
      if (outsideEvidenceRoot.length > 0) {
        return {
          block: true,
          reason: `Task ${sessionTask.taskId} cannot mutate paths outside a change evidence root: ${outsideEvidenceRoot.join(", ")}. In a parent workspace with separate repos, write under a child repo or a scoped workspace directory such as plans/**.`
        };
      }
    }
    if (runtime.contextBudget !== "off" && ["write", "edit"].includes(event.toolName)) {
      const relativePath = extractLikelyPathFromInput(ctx.cwd, event.input as Record<string, unknown>);
      if (relativePath) {
        const budget = contextBudgetConfig(policy);
        const stats = candidateFileBudget(ctx.cwd, relativePath, budget);
        if (runtime.contextBudget === "enforce" && stats.exists && stats.overLimit) {
          return { block: true, reason: `Context budget blocked editing large file ${relativePath}: ${stats.chars} chars > ${budget.maxContextFileChars}` };
        }
      }
    }

    if (pendingHumanApproval) {
      const currentTreeDigest = semanticSnapshot && !workingTreeSnapshotHasUnavailableEvidence(semanticSnapshot) ? workingTreeEvidenceDigest(semanticSnapshot) : null;
      const treePrecondition = pendingHumanApproval.action.preconditionClass === "runtime-only" || !currentTreeDigest ? null
        : { workspaceRevision: `workspace-rev.${crypto.createHash("sha256").update(currentTreeDigest).digest("hex")}`, indexRevision: null, preimageDigest: currentTreeDigest };
      const approval = await piApprovalBroker.request({ cwd: ctx.cwd, rawSessionId: ctx.sessionManager.getSessionId(), toolCallId: String(event.toolCallId), expectedTask: sessionTask ? { taskId: sessionTask.taskId, taskRunId: sessionTask.taskRunId } : null,
        action: { ...pendingHumanApproval.action, treePrecondition }, terminalConfirm: () => ctx.ui.confirm(pendingHumanApproval!.prompt, pendingHumanApproval!.title),
        recheck: () => !treePrecondition || (() => { const current = workingTreeSnapshot(ctx.cwd);
          return !workingTreeSnapshotHasUnavailableEvidence(current) && workingTreeEvidenceDigest(current) === treePrecondition.preimageDigest; })() });
      if (!approval.allowed) return { block: true, reason: pendingHumanApproval.action.kind === "external-provider-action" && !SHELL_TOOL_NAMES.has(event.toolName) ? `User denied external provider action: ${event.toolName}` : `User denied command: ${pendingHumanApproval.action.reason}` };
      if (!approval.consume()) return { block: true, reason: "Approval became stale before tool start; the action was blocked." };
    }
    if (
      sessionTask?.trace.outcome === "pending"
      && sessionTask.changeMode === "source-change"
      && (shellProjectMutation || configuredVerifierShell)
    ) {
      runtimeState.rememberShellMutationSnapshot(ctx, event.toolName, event.input);
    }
    }
  });
  const registrationDeps = {
    CONTEXT_INDEX_EDGE_KINDS, CONTEXT_INDEX_NODE_KINDS, DEFAULT_MAX_TASK_ATTEMPTS, FRESH_COMMAND_ACTIONS, FRESH_COMMAND_HELP,
    ONBOARDING_COMMAND_ACTIONS, ORCHESTRATION_ROLES, PIAGENT_TOOL_NAMES, READ_ONLY_TOOL_NAMES, REVIEW_LENSES,
    StringEnum, TECH_STACK_MANIFEST_FILE, TOOL_RESULT_CAPTURE_MAX_CHARS, TOOL_RESULT_COMPACT_CHAR_THRESHOLD, TOOL_RESULT_COMPACT_LINE_THRESHOLD,
    TOOL_RESULT_PREVIEW_MAX_CHARS, Type, WORKFLOW_COMMAND_EXCLUSIONS, activateToolGroups, activeSessionTask,
    activeTaskToolGroups, allVerifyCommandsPassCurrentTree, appendMemoryNote, appendSessionTrace, appendTrace,
    acceptanceBaselineGuidance, acceptanceProofGuidance, applyAcceptanceRecoveryProvenance, applyRuntimeLifecycleObservation, automaticAcceptanceCriteria, automaticReadOnlyTaskScope, automaticReviewLenses, automaticTaskIntakeMode, automaticTaskRiskLane, automaticTaskScope,
    bashResults, bindSessionTask, buildAcceptanceReceipt, buildContextEfficiencyReport, buildContextIndexStatus, buildLiveTaskStatus, buildTaskEfficiencyMetrics,
    buildContextIndexV2, buildContextPack, buildContextPreflight, buildProfileOptions, buildProfileTechOptions,
    buildTestImpact, buildUsageSnapshot, candidateFileBudget, checkoutReferenceRepo, classifyContextTask,
    classifyVerificationFailure, cleanSessionNameInput, collectServers, commandArgs, commandMatchesVerifyPlan,
    compactSessionTask, compactTaskDetails, contextBudgetConfig, contextIndexExcludePatterns, contextIndexV2Status,
    createTaskRunId, crypto, currentSessionName, defaultRolePolicy, defaultWorkPlan, digestJson,
    dynamicToolsEnabled, effectiveProtectedPaths, emitRuntimeMessage, ensureContextIndexV2, estimateContextTokens,
    evaluateExecPolicy, evaluateModelRoute, evaluateRetrievalRoute, evaluateRuntimeSolver, evaluateTaskGate, evaluateToolPolicy, execPolicyConfig,
    extensionDir, externalActionPolicyConfig, extractDocument, finalGateConfig, findMatchingObservedBashResult,
    formatContextPreflight, formatCount, formatLiveTaskStatus, formatPercent, formatTechOptionsText, formatTechSelectionSummary,
    formatToolResultCaptureStatus, formatUsageSnapshot, fs, hasGitEvidenceRoot, hasOperatorSessionName, helpersMode,
    loadProfileFromContext, matchesAnyPath, matchesProtectedPath, mcpActions, mcpApprovalCache,
    memoryHandbookPath, memoryLocalDir, memorySummaryPath, normalizeProjectProfileName, normalizeRelative,
    normalizeReviewLenses, normalizeTechSelections, normalizeWorkPlanSteps, nowIso, observedBashLedgerPath,
    path, permissionOverrideFromContext, permissionProfilesConfig, policy, prefixCompletions,
    priorTaskAttempts, projectContextFilePath, projectFilePath, projectProfilePath, readJsonFile, readModelRouteEvents,
    readObservedBashResults, readRecentToolResultCaptures, readTask, recordCompletionAudit, recordTaskProgressCheckpoints,
    recordTaskStartCheckpoint, recordVerificationCheckpoint, redactBoundedText, redactBoundedTextArray, redactForStorage,
    redactText, redactTextArray, refreshAcceptanceReceipt, registerPiagentStatusCommand, registerPiagentTool,
    registerRuntimeCommand, registerRuntimeTool, registerTaskPreflightCommand, resolveDocumentPath, resolveDocumentRoots,
    resolveMemorySettings, resolveOrchestrationPolicy, resolvePermissionProfile, resolveRuntimePolicy, retrievalKey,
    runtimeLifecycleMode, runtimeSnapshotCapture, runtimeSnapshotEnabled, runtimeState, runtimeVersions,
    safeTaskId, searchContextIndex, searchContextIndexV2, searchMemoryFiles, selectRuntimeAction,
    selectValueFromUi, selectVerificationPlan, semanticCompactionInstructions, sendWorkflowFollowUp, setPermissionOverrideForContext,
    semanticRepairCompletionBlock: (cwd: string, taskRunId: string) => semanticRepairRuntime.completionBlock(cwd, taskRunId),
    shellArg, shortTaskLabel, solverShadow, summarizeAttempt, taskChangedFileEvidence,
    techContextDirPath, techContextFilePath, techContextRelativePath, techOptionById, techStackPath,
    telemetry, toolRegistryConfig, trajectoryRuntime, uniqueStrings, usageExactCommands,
    validTaskScopePattern, validateNewWorkPlan, verifierCommandInstructions, verifyProjectCapabilityState, workingTreeEvidenceDigest,
    repositoryFileManifest, resolveTaskScopePatterns,
    workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence, writeContextIndex, writeProfileDocumentWithLock, writeProfileFromAdapter, writeProjectOnboarding,
    writeTask, writeTechStackSelection
  };
  registerPolicyTools(pi, registrationDeps);
  registerKnowledgeTools(pi, registrationDeps);
  registerOnboardingTools(pi, registrationDeps);
  maybeStartAutomaticTask = registerTaskStartTool(pi, registrationDeps);
  registerTaskEvidenceTools(pi, registrationDeps);
  registerTaskCompletionTools(pi, registrationDeps);

  function emitRuntimeMessage(
    ctx: ExtensionContext,
    customType: string,
    content: string,
    details: Record<string, unknown> = {},
    notify?: { message: string; level: "info" | "warning" | "error" }
  ): void {
    if (notify) ctx.ui.notify(notify.message, notify.level);
    pi.sendMessage(
      { customType, content, display: true, details },
      { triggerTurn: false }
    );
  }

  function commandArgs(raw: string): { action: string; rest: string; tokens: string[] } {
    const trimmed = String(raw ?? "").trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const action = (tokens.shift() ?? "").toLowerCase();
    return { action, rest: tokens.join(" "), tokens };
  }

  function shellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  function usageExactCommands(cwd: string): string[] {
    const project = shellArg(cwd);
    return [
      "/session",
      `piagent-usage ${project}`,
      `piagent-usage --history ${project} --days 7`,
      "piagent-usage --history --all-projects --days 7 --csv"
    ];
  }

  function sendWorkflowFollowUp(command: string): void {
    pi.sendUserMessage(command, { deliverAs: "followUp" });
  }

  async function selectRuntimeAction(
    ctx: ExtensionContext,
    title: string,
    entries: Array<{ value: string; label: string; description?: string; recommended?: boolean }>,
    defaultValue?: string
  ): Promise<string | undefined> {
    if (ctx.hasUI === false) return undefined;
    return await selectValueFromUi(ctx, title, entries, defaultValue ?? entries.find((entry) => entry.recommended)?.value);
  }

  registerPermissionCommands(pi, registrationDeps);
  const profileCommandApi = registerProfileCommands(pi, registrationDeps);
  registerMemoryMcpCommands(pi, registrationDeps);
  const contextCommandApi = registerContextCommands(pi, registrationDeps);
  let workflowCommandApi: { startFreshWorkflow: (...args: any[]) => Promise<void> };
  registerSessionCommands(pi, {
    ...registrationDeps,
    ...contextCommandApi,
    startFreshWorkflow: (...args: any[]) => workflowCommandApi.startFreshWorkflow(...args)
  });
  workflowCommandApi = registerWorkflowCommands(pi, { ...registrationDeps, ...profileCommandApi, ...contextCommandApi });
}

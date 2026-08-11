import type { TaskContract } from "../../extensions/guard-types.ts";
import { replayTaskCheckpoints } from "../../extensions/task-journal.js";
import { taskContractValidationErrors, taskDigestMigrationArchiveStatus } from "../../extensions/task-state.js";
import { latestObservedVerificationEvidence, verificationEvidenceProvesStableTree } from "../../extensions/verification-intelligence.js";
import {
  isCurrentWorkingTreeDigest,
  WORKING_TREE_DIGEST_ALGORITHM,
  workingTreeEvidenceDigest
} from "../../extensions/working-tree-digest.js";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import type { ModelRouteDecision } from "../model/model-route-types.ts";
import type { RetrievalRoutePlan } from "../context/retrieval-route-policy.ts";
import { inspectTaskResumeState } from "../recovery/resume-state.ts";
import type { SolverShadowEvaluation } from "../solver/solver-shadow.ts";
import type { TrajectoryStatus } from "../trajectory/trajectory-runtime.ts";
import { buildTaskEfficiencyMetrics } from "./efficiency-metrics.ts";

export const PRODUCT_PREFLIGHT_VERSION = "product-preflight-v1" as const;
export const LIVE_TASK_STATUS_VERSION = "live-task-status-v1" as const;
export const COMPLETION_RECEIPT_VIEW_VERSION = "completion-receipt-view-v1" as const;

export type CompletionGateProjection = {
  decision: "pass" | "fail";
  missing: string[];
  warnings?: string[];
  currentWorkingTreeDigest?: string;
};

function digestMigration(task: TaskContract) {
  return {
    algorithm: task.workingTreeDigestAlgorithm,
    migration: task.workingTreeDigestMigration
      ? {
          status: task.workingTreeDigestMigration.status,
          reasonCode: task.workingTreeDigestMigration.reasonCode,
          requiredAction: task.workingTreeDigestMigration.requiredAction
        }
      : null
  };
}

function sameSortedStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function taskTreeEvidenceIsCurrent(cwd: string | undefined, task: TaskContract, baselineDigest: string, currentDigest: string): boolean {
  const migrationCurrent = !task.workingTreeDigestMigration || Boolean(cwd
    && task.workingTreeDigestMigration.status === "refreshed"
    && taskDigestMigrationArchiveStatus(cwd, task).valid
    && replayTaskCheckpoints(cwd, task.taskRunId, task).corruptions.length === 0);
  return taskContractValidationErrors(task).length === 0
    && task.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM
    && task.workingTreeDigestMigration?.status !== "verification-refresh-required"
    && migrationCurrent
    && isCurrentWorkingTreeDigest(baselineDigest)
    && isCurrentWorkingTreeDigest(currentDigest)
    && sameSortedStrings(task.baselineChangedFiles, Object.keys(task.baselineFileDigests))
    && sameSortedStrings(task.finalWorkingTreeFiles, Object.keys(task.finalFileDigests));
}

export function buildProductPreflight(evaluation: SolverShadowEvaluation, input: { runtime?: RuntimeModelSnapshot; modelRoute?: ModelRouteDecision | null; retrievalRoute?: RetrievalRoutePlan | null; scope?: string[]; protectedPaths?: string[]; activeToolGroups?: string[]; helperMode?: string; helperBudget?: string; executionBackend?: string; executionBoundary?: string; approvals?: string[]; blockers?: string[]; controlMode?: "shadow" | "assist" | "enforce" } = {}) {
  if (evaluation.status !== "ok") return { schemaVersion: 1, version: PRODUCT_PREFLIGHT_VERSION, status: evaluation.status, controlMode: evaluation.status === "off" ? "off" : "unknown", intent: { workflow: "unknown", changeMode: "unknown" }, risk: { lane: "unknown", signals: [] }, scope: { requested: input.scope ?? [], protectedPaths: input.protectedPaths ?? [] }, runtime: null, solver: null, modelRouting: input.modelRoute ?? null, retrieval: input.retrievalRoute ?? null, phases: [], contextBudget: "unknown", tools: { active: input.activeToolGroups ?? [], recommended: [] }, helper: { mode: input.helperMode ?? "unknown", recommendation: null, ownedBudget: input.helperBudget ?? "unknown" }, execution: { backend: input.executionBackend ?? "host", boundary: input.executionBoundary ?? "host execution is not a sandbox", implementationAuthorized: false }, readiness: { git: null, verifier: null }, approvals: input.approvals ?? [], blockers: input.blockers ?? [] };
  const { features, decision } = evaluation;
  const implementationAuthorized = features.changeMode === "source-change" && !features.protectedTarget && !features.externalAction && !features.destructiveAction && !features.permissionExpansion && features.gitReady === true && features.verifierReady === true;
  return { schemaVersion: 1, version: PRODUCT_PREFLIGHT_VERSION, status: "ok", controlMode: input.controlMode ?? (decision.mode === "shadow" ? "shadow" : decision.mode === "recommend" ? "assist" : "off"), intent: { workflow: features.workflowIntent, changeMode: features.changeMode }, risk: { lane: features.riskLane, signals: features.riskSignals }, scope: { requested: input.scope ?? [], protectedPaths: input.protectedPaths ?? [] }, runtime: { provider: input.runtime?.provider ?? features.userPinnedProvider, modelId: input.runtime?.modelId ?? features.userPinnedModel, effort: input.runtime?.effectiveThinkingLevel ?? features.userPinnedEffort, contextWindow: input.runtime?.contextWindow ?? null, provenance: input.runtime?.source ?? "unknown", unknown: !input.runtime }, solver: { mode: decision.mode, route: decision.route, confidence: decision.confidence, reasonCodes: decision.reasonCodes }, modelRouting: input.modelRoute ?? null, retrieval: input.retrievalRoute ?? null, phases: decision.plannedPhases, contextBudget: decision.context.budgetBand, tools: { active: input.activeToolGroups ?? [], recommended: decision.toolGroups }, helper: { mode: input.helperMode ?? "unknown", recommendation: decision.helper, ownedBudget: input.helperBudget ?? "unknown" }, execution: { backend: input.executionBackend ?? "host", boundary: input.executionBoundary ?? "host execution is not a sandbox", implementationAuthorized }, readiness: { git: features.gitReady, verifier: features.verifierReady }, approvals: input.approvals ?? [], blockers: input.blockers ?? [] };
}

export function formatProductPreflight(view: ReturnType<typeof buildProductPreflight>): string {
  const solver = view.solver as any, runtime = view.runtime as any;
  const modelRoute = view.modelRouting as ModelRouteDecision | null;
  const retrieval = view.retrieval as RetrievalRoutePlan | null;
  const control = view.controlMode === "shadow" ? "shadow: no behavior changed" : view.controlMode === "assist" ? "assist: recommendations visible" : view.controlMode === "enforce" ? "enforce: policy active" : `control: ${view.controlMode}`;
  return [`preflight: ${view.controlMode.toUpperCase()} (${view.status})`, `intent: ${view.intent.workflow}/${view.intent.changeMode}; risk=${view.risk.lane}`, `scope: ${view.scope.requested.join(", ") || "unknown"}; protected=${view.scope.protectedPaths.join(", ") || "none"}`, `runtime: ${runtime ? `${runtime.provider ?? "unknown"}/${runtime.modelId ?? "unknown"}; effort=${runtime.effort ?? "unknown"}; provenance=${runtime.provenance}` : "unknown"}`, `route: ${solver ? `${solver.route}; solverMode=${solver.mode}; confidence=${solver.confidence}; reasons=${solver.reasonCodes.join(",")}` : "unknown"}`, `modelRoute: ${modelRoute ? `${modelRoute.disposition}; band=${modelRoute.capabilityBand}; floor=${modelRoute.safetyFloor}; target=${modelRoute.provider ?? "none"}/${modelRoute.modelId ?? "none"}:${modelRoute.effort ?? "none"}; source=${modelRoute.selectionSource}; enforced=${modelRoute.enforced}` : "off/unavailable"}`, `retrieval: ${retrieval ? `${retrieval.activation}; parallel=${retrieval.maxParallel}; rounds=${retrieval.maxRounds}; specialist=${retrieval.specialistRole ?? "none"}; auto=${retrieval.automaticDispatch}` : "local-default"}`, control, `phases: ${view.phases.join(" → ") || "none"}; context=${view.contextBudget}`, `tools: active=${view.tools.active.join(",") || "unknown"}; recommended=${view.tools.recommended.join(",") || "none"}`, `helper: mode=${view.helper.mode}; recommendation=${JSON.stringify(view.helper.recommendation)}; budget=${view.helper.ownedBudget}`, `execution: ${view.execution.backend}; ${view.execution.boundary}; implementation=${view.execution.implementationAuthorized ? "authorized" : "not-authorized"}`, `readiness: git=${view.readiness.git ?? "unknown"}; verifier=${view.readiness.verifier ?? "unknown"}`, `approvals/blockers: ${[...view.approvals, ...view.blockers].join("; ") || "none"}`].join("\n");
}

export function buildLiveTaskStatus(cwd: string, task: TaskContract | undefined, sessionId: string, input: { trajectory?: TrajectoryStatus; runtime?: RuntimeModelSnapshot; modelRoute?: ModelRouteDecision | null; activeToolGroups?: string[]; helpers?: unknown[]; completionGate?: CompletionGateProjection } = {}) {
  if (!task) return { schemaVersion: 1, version: LIVE_TASK_STATUS_VERSION, state: "idle", task: null, tree: null, runtime: input.runtime ?? null, modelRouting: input.modelRoute ?? null, activeToolGroups: input.activeToolGroups ?? [], helpers: input.helpers ?? [], blockers: [], nextSafeAction: "start-or-resume-task", receipt: null, efficiency: null };
  const replay = replayTaskCheckpoints(cwd, task.taskRunId, task); const resume = inspectTaskResumeState(cwd, task, sessionId); const latest = replay.checkpoints.at(-1); const latestFailure = [...replay.checkpoints].reverse().find((item) => item.status === "failed"); const evidence = latestFailure?.evidence && typeof latestFailure.evidence === "object" ? latestFailure.evidence as Record<string, any> : {};
  const currentTreeDigest = isCurrentWorkingTreeDigest(resume.currentTreeDigest) ? resume.currentTreeDigest : null;
  const migrationRefresh = task.workingTreeDigestMigration?.status === "verification-refresh-required";
  const latestVerifiers = latestObservedVerificationEvidence(task.verifyEvidence);
  return { schemaVersion: 1, version: LIVE_TASK_STATUS_VERSION, state: task.trace.outcome === "pending" ? resume.enforcementSafe ? "active" : "corrupt" : "terminal", task: { taskId: task.taskId, taskRunId: task.taskRunId, sessionHash: resume.sessionId === task.sessionId ? "matched" : "conflict", attempt: task.attempt, maxAttempts: task.maxAttempts, phase: input.trajectory?.phase ?? resume.phase, outcome: task.trace.outcome, pendingVerifiers: task.verifyCommands.filter((command) => !currentTreeDigest || !verificationEvidenceProvesStableTree(latestVerifiers.get(command.trim()), currentTreeDigest)), pendingReview: task.workPlan.some((step) => step.id === "review" && step.status !== "done") }, tree: { ...digestMigration(task), currentDigest: currentTreeDigest }, runtime: input.runtime ?? null, modelRouting: input.modelRoute ?? null, activeToolGroups: input.activeToolGroups ?? [], recovery: { classification: evidence.failureClassification?.category ?? null, action: evidence.recovery?.action ?? null }, helpers: input.helpers ?? task.acceptanceReceipt?.helperUsage?.helpers ?? [], checkpoint: latest ? { id: latest.checkpointId, phase: latest.phase, status: latest.status, sequence: latest.sequence } : null, resume: { decision: resume.decision, safe: resume.enforcementSafe, staleVerifier: resume.staleVerifierEvidence, authorityPolicy: resume.authorityPolicy }, blockers: resume.warnings, nextSafeAction: task.trace.outcome !== "pending" ? "none-terminal" : migrationRefresh ? "rerun-exact-verifier" : resume.enforcementSafe ? resume.staleVerifierEvidence ? "rerun-exact-verifier" : "continue-current-phase" : "inspect-handoff-and-recover", receipt: task.trace.outcome === "pending" ? null : buildCompletionReceiptView(task, { cwd, gate: input.completionGate, modelRoute: input.modelRoute }), efficiency: buildTaskEfficiencyMetrics(cwd, task, { activeToolGroups: input.activeToolGroups }) };
}

export function formatLiveTaskStatus(view: ReturnType<typeof buildLiveTaskStatus>): string { if (!view.task) return `task: none\nmodelRoute: ${view.modelRouting ? `${view.modelRouting.disposition}/${view.modelRouting.capabilityBand}` : "none"}\nnext: start-or-resume-task`; const task = view.task; return [`task: ${task.taskId} (${task.taskRunId}); attempt=${task.attempt}/${task.maxAttempts}`, `state: ${view.state}; phase=${task.phase ?? "unknown"}; outcome=${task.outcome}`, `modelRoute: ${view.modelRouting ? `${view.modelRouting.disposition}; band=${view.modelRouting.capabilityBand}; target=${view.modelRouting.modelId ?? "none"}:${view.modelRouting.effort ?? "none"}; enforced=${view.modelRouting.enforced}` : "none"}`, `pending: verify=${task.pendingVerifiers.join(",") || "none"}; review=${task.pendingReview}`, `recovery: ${view.recovery.classification ?? "none"}/${view.recovery.action ?? "none"}`, `helpers: ${view.helpers.length}; checkpoint=${view.checkpoint?.id ?? "none"}`, `resume: ${view.resume.decision}; safe=${view.resume.safe}; staleVerifier=${view.resume.staleVerifier}; authority=${view.resume.authorityPolicy.disposition}/${view.resume.authorityPolicy.reason}`, `blockers: ${view.blockers.join("; ") || "none"}`, `next: ${view.nextSafeAction}`].join("\n"); }

export function buildCompletionReceiptView(task: TaskContract, input: { cwd?: string; gate?: CompletionGateProjection; modelRoute?: ModelRouteDecision | null } = {}) {
  const gate = input.gate;
  const current = task.finalFileDigests ?? {};
  const baselineDigest = workingTreeEvidenceDigest(task.baselineFileDigests ?? {});
  const currentDigest = workingTreeEvidenceDigest(current);
  const recovery = task.acceptanceReceipt?.provenance;
  const helpers = task.acceptanceReceipt?.helperUsage;
  const latestVerifiers = latestObservedVerificationEvidence(task.verifyEvidence);
  const acceptanceSatisfied = task.acceptanceReceipt?.criteria.every((item) => item.status === "satisfied") === true;
  const treeEvidenceCurrent = taskTreeEvidenceIsCurrent(input.cwd, task, baselineDigest, currentDigest);
  const gateTreeCurrent = isCurrentWorkingTreeDigest(gate?.currentWorkingTreeDigest)
    && gate?.currentWorkingTreeDigest === currentDigest;
  const completionApproved = gate?.decision === "pass" && task.trace.outcome === "completed" && acceptanceSatisfied && treeEvidenceCurrent && gateTreeCurrent;
  const remainingRisk = [
    ...(task.trace.outcome === "completed" ? [] : [task.failureReason ?? task.trace.friction ?? "task-not-completed"]),
    ...(gate ? gate.missing : ["completion-gate-unavailable"]),
    ...(acceptanceSatisfied ? [] : ["acceptance-criteria-pending"]),
    ...(task.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM ? [] : ["working-tree-digest-legacy-untrusted"]),
    ...(task.workingTreeDigestMigration?.status === "verification-refresh-required" ? ["working-tree-verification-refresh-required"] : []),
    ...(treeEvidenceCurrent ? [] : ["task-contract-or-tree-evidence-invalid"]),
    ...(gate?.decision === "pass" && !gateTreeCurrent ? ["completion-gate-tree-digest-untrusted-or-mismatched"] : []),
    ...(gate?.decision === "pass" && !treeEvidenceCurrent ? ["working-tree-evidence-not-current"] : [])
  ].filter((value, index, values) => values.indexOf(value) === index);
  return { schemaVersion: 1, version: COMPLETION_RECEIPT_VIEW_VERSION, outcome: task.trace.outcome, completionApproved, modelRouting: input.modelRoute ?? null, gate: { decision: gate?.decision ?? "unavailable", missing: gate?.missing ?? ["completion-gate-unavailable"], warnings: gate?.warnings ?? [], currentWorkingTreeDigest: isCurrentWorkingTreeDigest(gate?.currentWorkingTreeDigest) ? gate?.currentWorkingTreeDigest : null }, acceptance: task.acceptanceReceipt?.criteria.map((item) => ({ id: item.id, obligation: item.obligation, status: item.status, evidence: item.evidence.map((entry) => entry.kind) })) ?? [], changedFiles: task.changedFiles, tree: { ...digestMigration(task), baselineDigest: isCurrentWorkingTreeDigest(baselineDigest) ? baselineDigest : null, currentDigest: isCurrentWorkingTreeDigest(currentDigest) ? currentDigest : null, evidenceCurrent: treeEvidenceCurrent }, verification: { exactCommands: task.verifyCommands, results: task.verifyCommands.map((command) => latestVerifiers.get(command.trim())).filter(Boolean).map((item) => ({ command: item.command, exitCode: item.exitCode, workingTreeDigest: isCurrentWorkingTreeDigest(item.workingTreeDigest) ? item.workingTreeDigest : null })) }, review: { lenses: task.reviewLenses, completed: task.workPlan.filter((item) => item.id === "review").every((item) => item.status === "done"), oracleDisposition: helpers?.helpers.find((item) => item.role === "oracle")?.disposition ?? "not-used" }, helpers: helpers ?? { mode: "off", used: false, reasonCodes: [], helpers: [] }, recovery: recovery ?? null, policyBlocks: task.trace.outcome === "blocked" ? [task.failureReason ?? task.trace.friction ?? "blocked"] : [], remainingRisk, handoff: recovery?.handoffRef ?? `.pi/piagent-state/handoffs/${task.taskRunId}.json`, assurance: completionApproved ? "same-runtime-operational-evidence" : "historical-or-untrusted-working-tree-evidence" };
}

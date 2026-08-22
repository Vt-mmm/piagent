import { rounded } from "./benchmark-statistics.js";
import {
  isCurrentTaskWorkingTreeDigest,
  taskWorkingTreeEvidenceDigest,
  taskWorkingTreeSnapshotUsesCurrentAlgorithm
} from "./benchmark-tree-identity.js";

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function meaningfulVerifyCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.filter((command) => typeof command === "string" && command.trim() && !/^(?:true|:|echo\b|printf\b)/i.test(command.trim()));
}

function latestObservedTaskEvidence(evidence, command) {
  let latest, latestTime = Number.NEGATIVE_INFINITY, latestIndex = -1;
  for (const [index, item] of (Array.isArray(evidence) ? evidence : []).entries()) {
    if (item?.observed !== true || item.command?.trim() !== command) continue;
    const observedAt = item.observedAt ?? item.recordedAt;
    const parsed = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
    const time = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    if (time > latestTime || (time === latestTime && index > latestIndex)) {
      latest = Number.isFinite(parsed) ? item : null;
      latestTime = time;
      latestIndex = index;
    }
  }
  return latest;
}

function stableTaskVerifierEvidence(item) {
  return item?.exitCode === 0
    && item.matchedProfileCommand === true
    && isCurrentTaskWorkingTreeDigest(item.preWorkingTreeDigest)
    && item.preWorkingTreeDigest === item.workingTreeDigest;
}

function semanticAcceptanceEvidenceRequired(task) {
  const snapshot = task?.authoritySnapshot;
  if (!plainObject(snapshot)
    || snapshot.taskId !== task?.taskId
    || snapshot.taskRunId !== task?.taskRunId
    || snapshot.capturedAt !== task?.createdAt) return true;
  const semantic = Array.isArray(snapshot.capabilities)
    ? snapshot.capabilities.find((entry) => entry?.id === "CAP-13")
    : undefined;
  return !semantic || semantic.authority === "enforce" || semantic.authority === "orchestrate";
}

const RUNTIME_MANAGED_BENCHMARK_TOOLS = new Set([
  "piagent_context",
  "piagent_context_preflight",
  "piagent_context_engine",
  "piagent_context_budget",
  "piagent_context_index_status",
  "piagent_context_index_search",
  "piagent_context_record",
  "piagent_permission_status",
  "piagent_exec_policy_check",
  "piagent_tool_policy_check",
  "piagent_verify_record",
  "piagent_trace_record",
  "piagent_task_gate_check",
  "piagent_tools"
]);

export function evaluateWorkflowEvidence(task, changedFiles, toolNames = {}, options = {}) {
  const scenarioKind = options.scenarioKind ?? "source-change";
  const planned = meaningfulVerifyCommands(task?.verifyCommands);
  const verifyEvidence = Array.isArray(task?.verifyEvidence) ? task.verifyEvidence : [];
  const latestConfiguredEvidence = planned.map((command) => latestObservedTaskEvidence(verifyEvidence, command));
  const terminalVerifierDigests = new Set(latestConfiguredEvidence
    .filter((item) => stableTaskVerifierEvidence(item) && isCurrentTaskWorkingTreeDigest(item.workingTreeDigest))
    .map((item) => item.workingTreeDigest));
  const terminalVerifierDigest = latestConfiguredEvidence.length === planned.length
    && latestConfiguredEvidence.every(stableTaskVerifierEvidence)
    && latestConfiguredEvidence.every((item) => isCurrentTaskWorkingTreeDigest(item?.workingTreeDigest))
    && terminalVerifierDigests.size === 1
    ? [...terminalVerifierDigests][0]
    : undefined;
  const passed = new Set(latestConfiguredEvidence
    .filter((item) => terminalVerifierDigest && item?.exitCode === 0 && item.workingTreeDigest === terminalVerifierDigest)
    .map((item) => item.command?.trim()));
  const actual = [...new Set(changedFiles ?? [])].sort();
  const claimed = [...new Set(task?.changedFiles ?? [])].sort();
  const baselineFiles = Object.keys(plainObject(task?.baselineFileDigests) ? task.baselineFileDigests : {}).sort();
  const finalFiles = Object.keys(plainObject(task?.finalFileDigests) ? task.finalFileDigests : {}).sort();
  const baselineFileClaims = Array.isArray(task?.baselineChangedFiles) ? [...task.baselineChangedFiles].sort() : [];
  const finalFileClaims = Array.isArray(task?.finalWorkingTreeFiles) ? [...task.finalWorkingTreeFiles].sort() : [];
  const migrationReady = task?.workingTreeDigestMigration === undefined;
  const rootTreeContractCurrent = task?.workingTreeDigestAlgorithm === "wt-content-v2"
    && migrationReady
    && Array.isArray(task?.baselineChangedFiles)
    && Array.isArray(task?.finalWorkingTreeFiles)
    && taskWorkingTreeSnapshotUsesCurrentAlgorithm(task?.baselineFileDigests)
    && taskWorkingTreeSnapshotUsesCurrentAlgorithm(task?.finalFileDigests)
    && JSON.stringify(baselineFiles) === JSON.stringify(baselineFileClaims)
    && JSON.stringify(finalFiles) === JSON.stringify(finalFileClaims)
    && JSON.stringify(finalFiles) === JSON.stringify(actual);
  const finalTreeDigest = rootTreeContractCurrent ? taskWorkingTreeEvidenceDigest(task.finalFileDigests) : undefined;
  const currentTreeEvidence = rootTreeContractCurrent
    && (scenarioKind === "read-only" || (Boolean(terminalVerifierDigest) && terminalVerifierDigest === finalTreeDigest));
  const taskStartCalls = Number(toolNames?.piagent_task_start ?? 0);
  const acceptedTaskStartCount = Number.isInteger(options.acceptedTaskStartCount)
    ? Math.max(0, options.acceptedTaskStartCount)
    : task?.taskRunId ? 1 : 0;
  const intakeMode = task?.intakeMode === "runtime" ? "runtime" : "model";
  const acceptanceCriteria = Array.isArray(task?.acceptanceReceipt?.criteria) ? task.acceptanceReceipt.criteria : [];
  const criticalAcceptance = acceptanceCriteria.filter((criterion) => criterion?.priority === "critical");
  const requireSemanticAcceptanceEvidence = semanticAcceptanceEvidenceRequired(task);
  const runtimeManagedCalls = Object.entries(toolNames ?? {})
    .filter(([name]) => RUNTIME_MANAGED_BENCHMARK_TOOLS.has(name))
    .reduce((sum, [, count]) => sum + Number(count ?? 0), 0);
  const checks = [
    { id: "session-bound-task", passed: Boolean(task?.schemaVersion === 2 && task.taskRunId && task.sessionId), weight: 1 },
    { id: "terminal-completion", passed: task?.trace?.outcome === "completed", weight: 1 },
    { id: "completed-work-plan", passed: Array.isArray(task?.workPlan) && task.workPlan.length > 0 && task.workPlan.every((step) => ["done", "skipped"].includes(step.status)), weight: 1 },
    { id: "current-tree-evidence", passed: currentTreeEvidence, weight: 1 },
    scenarioKind === "read-only"
      ? { id: "truthful-no-changes", passed: actual.length === 0 && claimed.length === 0, weight: 1 }
      : { id: "observed-verification", passed: planned.length > 0 && planned.every((command) => passed.has(command.trim())), weight: 1 },
    ...(scenarioKind === "read-only" ? [] : [
      { id: "truthful-changed-files", passed: actual.length > 0 && JSON.stringify(actual) === JSON.stringify(claimed), weight: 1 }
    ]),
    // Keep advisory semantic coverage visible for every source-change run, but
    // do not let a finite proof classifier override an independently graded
    // correct outcome when CAP-13 is not part of the task's authority. Strict
    // profiles retain the full workflow weight.
    ...(acceptanceCriteria.length > 0 && (scenarioKind === "source-change" || requireSemanticAcceptanceEvidence) ? [
      {
        id: "criterion-linked-evidence",
        passed: (criticalAcceptance.length ? criticalAcceptance : acceptanceCriteria).every((criterion) => criterion.status === "satisfied"
          && Array.isArray(criterion.evidence)
          && (scenarioKind === "read-only"
            ? criterion.evidence.length > 0
            : Boolean(terminalVerifierDigest) && criterion.evidence.some((evidence) => evidence?.workingTreeDigest === terminalVerifierDigest))),
        weight: requireSemanticAcceptanceEvidence ? 1 : 0.25
      }
    ] : []),
    {
      id: "single-task-start",
      passed: acceptedTaskStartCount === 1,
      weight: 1
    },
    { id: "runtime-managed-evidence", passed: runtimeManagedCalls === 0, weight: 1 }
  ];
  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const available = checks.reduce((sum, check) => sum + check.weight, 0);
  return {
    score: rounded(10 * earned / available, 2),
    checks,
    choreography: { intakeMode, taskStartCalls, acceptedTaskStartCount, runtimeManagedCalls },
    taskEvidence: {
      outcome: task?.trace?.outcome ?? "missing",
      acceptance: {
        criteria: acceptanceCriteria.length,
        satisfied: acceptanceCriteria.filter((criterion) => criterion?.status === "satisfied").length,
        critical: criticalAcceptance.length,
        criticalSatisfied: criticalAcceptance.filter((criterion) => criterion?.status === "satisfied").length
      }
    },
    scenarioKind
  };
}

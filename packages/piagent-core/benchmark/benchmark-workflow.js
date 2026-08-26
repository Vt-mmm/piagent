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

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function taskTreeEvidence(task, actual) {
  const baselineFiles = Object.keys(plainObject(task?.baselineFileDigests) ? task.baselineFileDigests : {}).sort();
  const finalFiles = Object.keys(plainObject(task?.finalFileDigests) ? task.finalFileDigests : {}).sort();
  const baselineFileClaims = Array.isArray(task?.baselineChangedFiles) ? [...task.baselineChangedFiles].sort() : [];
  const finalFileClaims = Array.isArray(task?.finalWorkingTreeFiles) ? [...task.finalWorkingTreeFiles].sort() : [];
  const migrationReady = task?.workingTreeDigestMigration === undefined;
  const current = task?.workingTreeDigestAlgorithm === "wt-content-v2"
    && migrationReady
    && Array.isArray(task?.baselineChangedFiles)
    && Array.isArray(task?.finalWorkingTreeFiles)
    && taskWorkingTreeSnapshotUsesCurrentAlgorithm(task?.baselineFileDigests)
    && taskWorkingTreeSnapshotUsesCurrentAlgorithm(task?.finalFileDigests)
    && JSON.stringify(baselineFiles) === JSON.stringify(baselineFileClaims)
    && JSON.stringify(finalFiles) === JSON.stringify(finalFileClaims)
    && JSON.stringify(finalFiles) === JSON.stringify(actual);
  return {
    current,
    digest: current ? taskWorkingTreeEvidenceDigest(task.finalFileDigests) : undefined
  };
}

function normalizedTasks(taskOrTasks) {
  return (Array.isArray(taskOrTasks) ? taskOrTasks : taskOrTasks ? [taskOrTasks] : [])
    .filter((task) => plainObject(task));
}

function taskStartChoreography(tasks, task, options) {
  const evidence = plainObject(options.taskStartEvidence) ? options.taskStartEvidence : undefined;
  const acceptedTaskStartCount = Number.isInteger(evidence?.acceptedTaskStartCount)
    ? Math.max(0, evidence.acceptedTaskStartCount)
    : Number.isInteger(options.acceptedTaskStartCount)
      ? Math.max(0, options.acceptedTaskStartCount)
      : task?.taskRunId ? 1 : 0;
  if (tasks.length <= 1) {
    const starts = Array.isArray(evidence?.starts) ? evidence.starts : [];
    const structuredBindingValid = !evidence || (
      starts.length === 1
      && starts[0]?.taskRunId === task?.taskRunId
      && Number(evidence.conflictingTaskTurnCount ?? 0) === 0
      && Number(evidence.duplicateTurnCount ?? 0) === 0
    );
    return {
      acceptedTaskStartCount,
      passed: acceptedTaskStartCount === 1 && structuredBindingValid,
      checkId: "single-task-start"
    };
  }
  const starts = Array.isArray(evidence?.starts) ? evidence.starts : [];
  const expectedTaskRunIds = uniqueSorted(tasks.map((item) => item?.taskRunId).filter(Boolean));
  const observedTaskRunIds = uniqueSorted(starts.map((item) => item?.taskRunId).filter(Boolean));
  const expectedTurnCount = Number.isInteger(options.expectedTurnCount) && options.expectedTurnCount > 0
    ? options.expectedTurnCount
    : undefined;
  const distinctTurnCount = Number.isInteger(evidence?.distinctTurnCount) ? evidence.distinctTurnCount : 0;
  const missingTurnIdCount = Number.isInteger(evidence?.missingTurnIdCount) ? evidence.missingTurnIdCount : acceptedTaskStartCount;
  const conflictingTaskTurnCount = Number.isInteger(evidence?.conflictingTaskTurnCount) ? evidence.conflictingTaskTurnCount : acceptedTaskStartCount;
  const duplicateTurnCount = Number.isInteger(evidence?.duplicateTurnCount) ? evidence.duplicateTurnCount : acceptedTaskStartCount;
  return {
    acceptedTaskStartCount,
    distinctTurnCount,
    missingTurnIdCount,
    conflictingTaskTurnCount,
    duplicateTurnCount,
    passed: Boolean(evidence)
      && acceptedTaskStartCount > 0
      && acceptedTaskStartCount === expectedTaskRunIds.length
      && JSON.stringify(observedTaskRunIds) === JSON.stringify(expectedTaskRunIds)
      && missingTurnIdCount === 0
      && conflictingTaskTurnCount === 0
      && duplicateTurnCount === 0
      && distinctTurnCount === acceptedTaskStartCount
      && (expectedTurnCount === undefined || acceptedTaskStartCount <= expectedTurnCount),
    checkId: "turn-bounded-task-start"
  };
}

export function evaluateWorkflowEvidence(taskOrTasks, changedFiles, toolNames = {}, options = {}) {
  const tasks = normalizedTasks(taskOrTasks);
  const task = tasks[0];
  const scenarioKind = options.scenarioKind ?? "source-change";
  const evidenceTasks = scenarioKind === "read-only"
    ? tasks
    : tasks.filter((item) => item?.changeMode !== "read-only");
  const planned = [...new Set(evidenceTasks
    .flatMap((item) => meaningfulVerifyCommands(item?.verifyCommands))
    .map((command) => command.trim()))];
  const verifyEvidence = evidenceTasks.flatMap((item) => Array.isArray(item?.verifyEvidence) ? item.verifyEvidence : []);
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
  const actual = uniqueSorted(changedFiles ?? []);
  const claimed = uniqueSorted(tasks.flatMap((item) => Array.isArray(item?.changedFiles) ? item.changedFiles : []));
  const currentTreeCandidates = evidenceTasks
    .map((item) => ({ task: item, ...taskTreeEvidence(item, actual) }))
    .filter((item) => item.current);
  const finalTreeDigest = scenarioKind === "read-only"
    ? currentTreeCandidates[0]?.digest
    : currentTreeCandidates.find((item) => item.digest === terminalVerifierDigest)?.digest;
  const currentTreeEvidence = Boolean(finalTreeDigest)
    && (scenarioKind === "read-only" || terminalVerifierDigest === finalTreeDigest);
  const taskStartCalls = Number(toolNames?.piagent_task_start ?? 0);
  const startChoreography = taskStartChoreography(tasks, task, options);
  const intakeMode = tasks.length > 0 && tasks.every((item) => item?.intakeMode === "runtime") ? "runtime" : "model";
  const acceptanceCriteria = evidenceTasks.flatMap((item) => Array.isArray(item?.acceptanceReceipt?.criteria) ? item.acceptanceReceipt.criteria : []);
  const criticalAcceptance = acceptanceCriteria.filter((criterion) => criterion?.priority === "critical");
  const requireSemanticAcceptanceEvidence = evidenceTasks.some(semanticAcceptanceEvidenceRequired);
  const runtimeManagedCalls = Object.entries(toolNames ?? {})
    .filter(([name]) => RUNTIME_MANAGED_BENCHMARK_TOOLS.has(name))
    .reduce((sum, [, count]) => sum + Number(count ?? 0), 0);
  const checks = [
    {
      id: "session-bound-task",
      passed: tasks.length > 0
        && tasks.every((item) => item?.schemaVersion === 2 && item.taskRunId && item.sessionId)
        && new Set(tasks.map((item) => item.sessionId)).size === 1,
      weight: 1
    },
    { id: "terminal-completion", passed: tasks.length > 0 && tasks.every((item) => item?.trace?.outcome === "completed"), weight: 1 },
    {
      id: "completed-work-plan",
      passed: tasks.length > 0 && tasks.every((item) => Array.isArray(item?.workPlan)
        && item.workPlan.length > 0
        && item.workPlan.every((step) => ["done", "skipped"].includes(step.status))),
      weight: 1
    },
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
    { id: startChoreography.checkId, passed: startChoreography.passed, weight: 1 },
    { id: "runtime-managed-evidence", passed: runtimeManagedCalls === 0, weight: 1 }
  ];
  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const available = checks.reduce((sum, check) => sum + check.weight, 0);
  return {
    score: rounded(10 * earned / available, 2),
    checks,
    choreography: tasks.length <= 1
      ? { intakeMode, taskStartCalls, acceptedTaskStartCount: startChoreography.acceptedTaskStartCount, runtimeManagedCalls }
      : {
          intakeMode,
          taskStartCalls,
          acceptedTaskStartCount: startChoreography.acceptedTaskStartCount,
          runtimeManagedCalls,
          taskCount: tasks.length,
          distinctTaskStartTurns: startChoreography.distinctTurnCount,
          missingTaskStartTurnIds: startChoreography.missingTurnIdCount,
          conflictingTaskStartTurns: startChoreography.conflictingTaskTurnCount,
          duplicateTaskStartTurns: startChoreography.duplicateTurnCount
        },
    taskEvidence: {
      outcome: tasks.length > 0 && tasks.every((item) => item?.trace?.outcome === "completed")
        ? "completed"
        : tasks.find((item) => item?.trace?.outcome !== "completed")?.trace?.outcome ?? "missing",
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

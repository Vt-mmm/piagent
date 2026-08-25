import type { ProjectProfile, TaskContract } from "../../extensions/guard-types.ts";
import { compileCriterionGraph } from "../../extensions/criterion-graph.js";
import { meaningfulVerificationCommands, selectVerificationPlan } from "../../extensions/verification-intelligence.js";
import { workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence } from "../../extensions/task-state.js";

export type PristineTaskVerificationRefresh = {
  task: TaskContract;
  refreshed: boolean;
  reason: string;
  verifyGroup?: string;
  previousCommands: string[];
  nextCommands: string[];
};

function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value);
}

function sameCommands(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((command, index) => command === right[index]);
}

/**
 * Refresh profile-derived verifier commands only while an automatic task is
 * still byte-for-byte pristine. This lets a corrected workspace profile reach
 * a resumed task without rewriting any source-change evidence or weakening an
 * already-started implementation contract.
 */
export function refreshPristineRuntimeTaskVerification(
  cwd: string,
  task: TaskContract,
  profile: ProjectProfile,
  updatedAt = new Date().toISOString()
): PristineTaskVerificationRefresh {
  const previousCommands = meaningfulVerificationCommands(task.verifyCommands);
  const unchanged = (reason: string): PristineTaskVerificationRefresh => ({
    task, refreshed: false, reason, previousCommands, nextCommands: previousCommands
  });
  if (task.trace.outcome !== "pending" || task.intakeMode !== "runtime" || task.changeMode !== "source-change") {
    return unchanged("task-not-refreshable");
  }
  if ((task.changedFiles?.length ?? 0) > 0 || (task.observedChangedFiles?.length ?? 0) > 0 || (task.verifyEvidence?.length ?? 0) > 0) {
    return unchanged("task-has-runtime-evidence");
  }
  const configuredGroups = profile.verifyCommands && typeof profile.verifyCommands === "object"
    ? profile.verifyCommands
    : {};
  const retainedGroup = task.verifyGroup && Object.hasOwn(configuredGroups, task.verifyGroup)
    ? task.verifyGroup
    : undefined;
  const plan = selectVerificationPlan(profile, retainedGroup, task.changeMode, cwd, task.scope);
  if (plan.error) return unchanged("profile-verifier-invalid");
  const nextCommands = meaningfulVerificationCommands(plan.commands);
  if (nextCommands.length === 0) return unchanged("profile-verifier-unavailable");
  if (sameCommands(previousCommands, nextCommands) && task.verifyGroup === plan.group) {
    return unchanged("profile-verifier-current");
  }
  if (!task.baselineFileDigests || typeof task.baselineFileDigests !== "object" || Array.isArray(task.baselineFileDigests)) {
    return unchanged("baseline-unavailable");
  }
  const baseline = task.baselineFileDigests;
  const current = workingTreeSnapshot(cwd) as Record<string, string>;
  if (workingTreeSnapshotHasUnavailableEvidence(current) || !sameStringRecord(baseline, current)) {
    return unchanged("working-tree-not-pristine");
  }
  const refreshed: TaskContract = {
    ...task,
    verifyGroup: plan.group,
    verifyCommands: nextCommands,
    criterionGraph: compileCriterionGraph({
      acceptanceCriteria: task.acceptanceCriteria,
      scope: task.scope,
      verifyCommands: nextCommands,
      changeMode: task.changeMode,
      mode: task.criterionGraph?.mode ?? "mechanical",
      createdAt: task.criterionGraph?.createdAt ?? task.createdAt
    }) as NonNullable<TaskContract["criterionGraph"]>,
    updatedAt
  };
  return {
    task: refreshed,
    refreshed: true,
    reason: "pristine-profile-verifier-refresh",
    verifyGroup: plan.group,
    previousCommands,
    nextCommands
  };
}

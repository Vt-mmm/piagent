import path from "node:path";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { allVerifyCommandsPassCurrentTree } from "../../extensions/task-contract-view.js";
import { replayTaskCheckpoints, taskRecoveryDecision } from "../../extensions/task-journal.js";
import { taskDigestMigrationArchiveStatus, workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence } from "../../extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../../extensions/task-lifecycle.js";
import { WORKING_TREE_DIGEST_ALGORITHM, isCurrentWorkingTreeDigest, workingTreeSnapshotUsesCurrentAlgorithm } from "../../extensions/working-tree-digest.js";
import { handoffProjectionPath, readHandoffProjection } from "./handoff-projection.ts";
import { inspectTaskAuthorityResumePolicy, type AuthorityResumeDecision } from "../policy/authority-resume-policy.ts";
import { readTrajectoryStore } from "../trajectory/trajectory-store.ts";

export const RESUME_STATE_VERSION = "resume-v1" as const;
export const RESUME_CONTEXT_VERSION = "resume-context-v1" as const;
export const RESUME_CONTEXT_MAX_CHARS = 6_000;
type ResumePlanStep = {
  id: string;
  title: string;
  status: string;
  mode: string;
  dependsOn: string[];
};
type ResumeNextAction = {
  action: "terminal" | "inspect-handoff" | "wait-paused" | "retry-checkpoint" | "rerun-exact-verifier" | "continue-plan" | "request-completion";
  stepId: string | null;
  reason: string;
  exactCommands: string[];
};
export type ResumeState = {
  version: typeof RESUME_STATE_VERSION;
  taskId: string;
  taskRunId: string;
  sessionId: string;
  decision: "resume" | "retry" | "paused" | "terminal" | "blocked";
  enforcementSafe: boolean;
  reason: string;
  phase: string | null;
  taskOutcome: TaskContract["trace"]["outcome"];
  currentTreeDigest: string;
  workingTreeDigestAlgorithm: TaskContract["workingTreeDigestAlgorithm"];
  digestMigration: TaskContract["workingTreeDigestMigration"] | null;
  authorityPolicy: AuthorityResumeDecision;
  latestCheckpoint: { checkpointId: string; phase: string; status: string; sequence: number } | null;
  verifierEvidenceCurrent: boolean;
  staleVerifierEvidence: boolean;
  invalidatedVerifierCommands: string[];
  journal: { checkpoints: number; corruptions: string[] };
  trajectory: { status: string; warnings: string[] };
  handoff: { path: string; exists: boolean; valid: boolean };
  reconstruction: {
    plan: ResumePlanStep[];
    currentStepId: string | null;
    nextAction: ResumeNextAction;
  };
  warnings: string[];
};

function strings(values: unknown, maximum = 20): string[] {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim().slice(0, 500)))].slice(0, maximum);
}

function resumePlan(task: TaskContract): { plan: ResumePlanStep[]; currentStepId: string | null } {
  const plan = task.workPlan.slice(0, 50).map((step) => ({
    id: String(step.id),
    title: String(step.title),
    status: String(step.status),
    mode: String(step.mode),
    dependsOn: strings(step.dependsOn, 20)
  }));
  const completed = new Set(plan.filter((step) => ["done", "skipped"].includes(step.status)).map((step) => step.id));
  const current = plan.find((step) => step.status === "in-progress")
    ?? plan.find((step) => step.status === "failed")
    ?? plan.find((step) => step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency)));
  return { plan, currentStepId: current?.id ?? null };
}

function nextResumeAction(
  task: TaskContract,
  state: Pick<ResumeState, "decision" | "enforcementSafe" | "reason" | "phase" | "verifierEvidenceCurrent" | "staleVerifierEvidence" | "latestCheckpoint">,
  currentStepId: string | null
): ResumeNextAction {
  if (state.decision === "terminal") return { action: "terminal", stepId: null, reason: state.reason, exactCommands: [] };
  if (!state.enforcementSafe || state.decision === "blocked") {
    return { action: "inspect-handoff", stepId: null, reason: state.reason, exactCommands: [] };
  }
  if (state.decision === "paused") {
    return { action: "wait-paused", stepId: state.latestCheckpoint?.checkpointId ?? currentStepId, reason: state.reason, exactCommands: [] };
  }
  if (state.staleVerifierEvidence) {
    return { action: "rerun-exact-verifier", stepId: currentStepId, reason: state.reason, exactCommands: strings(task.verifyCommands, 50) };
  }
  if (state.decision === "retry") {
    return { action: "retry-checkpoint", stepId: state.latestCheckpoint?.checkpointId ?? currentStepId, reason: state.reason, exactCommands: strings(task.verifyCommands, 50) };
  }
  if (task.changeMode === "source-change" && state.phase === "verify" && !state.verifierEvidenceCurrent && task.verifyCommands.length > 0) {
    return {
      action: "rerun-exact-verifier",
      stepId: currentStepId,
      reason: "The task resumed in verify without current stable evidence; run every exact configured verifier before continuing.",
      exactCommands: strings(task.verifyCommands, 50)
    };
  }
  if (currentStepId) {
    return { action: "continue-plan", stepId: currentStepId, reason: `Continue the current actionable work-plan step ${currentStepId}.`, exactCommands: [] };
  }
  if (task.changeMode === "source-change" && task.verifyCommands.length > 0) {
    return { action: "rerun-exact-verifier", stepId: null, reason: "No open plan step remains; prove the current tree with every exact configured verifier.", exactCommands: strings(task.verifyCommands, 50) };
  }
  return { action: "request-completion", stepId: null, reason: "No open plan step remains; request the runtime completion gate.", exactCommands: [] };
}

function compact(value: unknown, maximum: number): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 18)).trimEnd()} ... [retained]`;
}

function limitedLines(values: unknown[], maximumItems: number, maximumChars: number, prefix: (value: string, index: number) => string): string[] {
  const selected = values.slice(0, maximumItems).map((value, index) => prefix(compact(value, maximumChars), index));
  if (values.length > maximumItems) selected.push(`- [${values.length - maximumItems} more retained in the Task Contract]`);
  return selected;
}

export function buildTaskResumeContext(task: TaskContract, resume: ResumeState): {
  customType: "piagent-runtime-task-resume";
  content: string;
  details: Record<string, unknown>;
} {
  const criteria = limitedLines(task.acceptanceCriteria, 8, 180, (value, index) => `- C${index + 1}: ${value}`);
  const scope = limitedLines(task.scope, 8, 100, (value) => `- ${value}`);
  const plan = resume.reconstruction.plan.slice(0, 12).map((step) => (
    `- ${step.id}: ${step.status}; ${compact(step.title, 140)}${step.dependsOn.length > 0 ? `; after=${step.dependsOn.join(",")}` : ""}`
  ));
  if (resume.reconstruction.plan.length > 12) plan.push(`- [${resume.reconstruction.plan.length - 12} more steps retained in the Task Contract]`);
  const verifiers = limitedLines(task.verifyCommands, 8, 180, (value, index) => `${index + 1}. ${value}`);
  const next = resume.reconstruction.nextAction;
  const lines = [
    "[Piagent durable task resume]",
    "This brief is reconstructed from the current Task Contract, journal, trajectory, handoff and working tree. Durable files remain authoritative.",
    `Task: ${compact(task.taskId, 160)} (${compact(task.taskRunId, 160)})`,
    `Goal: ${compact(task.summary, 500)}`,
    `Expected output: ${compact(task.expectedOutput, 400)}`,
    "Acceptance focus:", ...criteria,
    "Scope:", ...scope,
    "Work plan/progress:", ...plan,
    `Current phase/checkpoint: ${resume.phase ?? "unknown"} / ${resume.latestCheckpoint?.checkpointId ?? "none"}`,
    `Verifier state: current=${resume.verifierEvidenceCurrent}; stale=${resume.staleVerifierEvidence}; tree=${resume.currentTreeDigest}`,
    "Exact verifier commands:", ...verifiers,
    `Next safe action: ${next.action}${next.stepId ? ` (${next.stepId})` : ""}. ${compact(next.reason, 500)}`,
    ...(next.exactCommands.length > 0 ? ["Required commands for that action:", ...limitedLines(next.exactCommands, 8, 180, (value, index) => `${index + 1}. ${value}`)] : []),
    `Resume safety: decision=${resume.decision}; enforcementSafe=${resume.enforcementSafe}; handoff=${resume.handoff.exists ? resume.handoff.path : "none"}.`,
    "Do not infer progress from transcript memory, reopen completed steps, or mutate when the next action is inspect-handoff, wait-paused, or terminal."
  ];
  let content = lines.join("\n");
  if (content.length > RESUME_CONTEXT_MAX_CHARS) {
    const marker = "\n[Middle details shortened; complete task truth remains in the Task Contract.]\n";
    const available = RESUME_CONTEXT_MAX_CHARS - marker.length;
    const head = Math.floor(available * 0.7);
    content = `${content.slice(0, head).trimEnd()}${marker}${content.slice(-(available - head)).trimStart()}`;
  }
  return {
    customType: "piagent-runtime-task-resume",
    content,
    details: {
      resumeContextVersion: RESUME_CONTEXT_VERSION,
      taskId: task.taskId,
      taskRunId: task.taskRunId,
      phase: resume.phase,
      checkpointId: resume.latestCheckpoint?.checkpointId ?? null,
      decision: resume.decision,
      enforcementSafe: resume.enforcementSafe,
      verifierEvidenceCurrent: resume.verifierEvidenceCurrent,
      staleVerifierEvidence: resume.staleVerifierEvidence,
      nextAction: resume.reconstruction.nextAction
    }
  };
}

export function inspectTaskResumeState(
  cwd: string,
  task: TaskContract,
  sessionId: string,
  currentDigests: Record<string, string> = workingTreeSnapshot(cwd) as Record<string, string>
): ResumeState {
  const currentTreeDigest = workingTreeEvidenceDigest(currentDigests);
  const authorityPolicy = inspectTaskAuthorityResumePolicy(cwd, task);
  const archive = taskDigestMigrationArchiveStatus(cwd, task);
  const algorithmReady = task.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM
    && isCurrentWorkingTreeDigest(currentTreeDigest)
    && workingTreeSnapshotUsesCurrentAlgorithm(currentDigests)
    && !workingTreeSnapshotHasUnavailableEvidence(currentDigests);
  const refreshRequired = task.workingTreeDigestMigration?.status === "verification-refresh-required";
  const journal = replayTaskCheckpoints(cwd, task.taskRunId, task);
  const trajectory = readTrajectoryStore(cwd, task.taskRunId);
  const warnings: string[] = [];
  let handoffExists = false;
  let handoffValid = true;
  try {
    const handoff = readHandoffProjection(cwd, task.taskRunId);
    handoffExists = Boolean(handoff);
    if (handoff && (handoff.identity.taskId !== task.taskId || handoff.identity.taskRunId !== task.taskRunId)) {
      handoffValid = false;
      warnings.push("handoff identity conflicts with the task contract");
    }
  } catch (error) {
    handoffValid = false;
    warnings.push(`handoff projection is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const passingEvidence = task.verifyEvidence.filter((evidence) => evidence.observed === true && evidence.matchedProfileCommand === true && evidence.exitCode === 0);
  const invalidatedVerifierCommands = strings(passingEvidence.filter((evidence) => !isCurrentWorkingTreeDigest(evidence.workingTreeDigest) || evidence.workingTreeDigest !== currentTreeDigest).map((evidence) => evidence.command), 50);
  const verifierEvidenceCurrent = algorithmReady && !refreshRequired && (task.changeMode === "read-only" || allVerifyCommandsPassCurrentTree(task, currentTreeDigest));
  const staleVerifierEvidence = refreshRequired || (invalidatedVerifierCommands.length > 0 && !verifierEvidenceCurrent);
  if (staleVerifierEvidence) warnings.push("working tree changed after the latest passing verifier; prior evidence is stale");
  const latest = journal.checkpoints.at(-1);
  const latestCheckpoint = latest ? {
    checkpointId: String(latest.checkpointId ?? "checkpoint"),
    phase: String(latest.phase ?? "unknown"),
    status: String(latest.status ?? "unknown"),
    sequence: Number(latest.sequence ?? 0)
  } : null;
  const identityConflict = task.sessionId !== String(sessionId);
  const terminal = task.trace.outcome !== "pending";
  const authorityReady = terminal || authorityPolicy.disposition === "resume-pinned";
  if (!terminal && !authorityReady) warnings.push(`authority policy requires ${authorityPolicy.disposition}: ${authorityPolicy.reason}`);
  if (identityConflict) warnings.push(`task belongs to session ${task.sessionId}, not ${sessionId}`);
  if (journal.corruptions.length > 0) warnings.push(`task journal is corrupt: ${journal.corruptions[0]}`);
  if (!trajectory.enforcementSafe) warnings.push(`trajectory state is unsafe: ${trajectory.warnings[0] ?? "unknown error"}`);
  if (!algorithmReady) warnings.push("working-tree digest algorithm/evidence is not current and proof-capable");
  if (!archive.valid) warnings.push(archive.reason);
  if (refreshRequired) warnings.push("legacy evidence was archived; run each exact configured verifier once against the current wt-content-v2 tree");
  const enforcementSafe = authorityReady && !identityConflict && algorithmReady && archive.valid && journal.corruptions.length === 0 && trajectory.enforcementSafe && handoffValid;
  const recovery = refreshRequired ? { decision: "resume", reason: "Digest migration requires current exact verifier evidence." } : taskRecoveryDecision(task, journal);
  const decision: ResumeState["decision"] = terminal
    ? "terminal"
    : !enforcementSafe
      ? "blocked"
      : recovery.decision === "retry"
        ? "retry"
        : recovery.decision === "paused"
          ? "paused"
          : recovery.decision === "blocked"
            ? "blocked"
            : "resume";
  const reason = terminal
    ? `Task contract is immutable after ${task.trace.outcome}.`
    : journal.corruptions.length > 0
      ? `task journal is corrupt: ${journal.corruptions[0]}`
    : !authorityReady
      ? `Authority policy requires ${authorityPolicy.disposition}: ${authorityPolicy.reason}.`
    : !enforcementSafe
      ? warnings[0] ?? "Resume state is unsafe."
      : refreshRequired
        ? "Legacy evidence is historical; run each exact configured verifier once against the current working tree."
      : staleVerifierEvidence
        ? "Resume is allowed, but exact verifier evidence must be refreshed for the current tree."
        : recovery.reason;
  const base = {
    version: RESUME_STATE_VERSION,
    taskId: task.taskId,
    taskRunId: task.taskRunId,
    sessionId: String(sessionId),
    decision,
    enforcementSafe,
    reason,
    phase: trajectory.enforcementSafe ? trajectory.state?.currentPhase ?? null : null,
    taskOutcome: task.trace.outcome,
    currentTreeDigest,
    workingTreeDigestAlgorithm: task.workingTreeDigestAlgorithm,
    digestMigration: task.workingTreeDigestMigration ?? null,
    authorityPolicy,
    latestCheckpoint,
    verifierEvidenceCurrent,
    staleVerifierEvidence,
    invalidatedVerifierCommands,
    journal: { checkpoints: journal.checkpoints.length, corruptions: strings(journal.corruptions) },
    trajectory: { status: trajectory.status, warnings: strings(trajectory.warnings) },
    handoff: { path: path.relative(cwd, handoffProjectionPath(cwd, task.taskRunId)).split(path.sep).join("/"), exists: handoffExists, valid: handoffValid },
    warnings: strings(warnings)
  } satisfies Omit<ResumeState, "reconstruction">;
  const plan = resumePlan(task);
  return {
    ...base,
    reconstruction: {
      ...plan,
      nextAction: nextResumeAction(task, base, plan.currentStepId)
    }
  };
}

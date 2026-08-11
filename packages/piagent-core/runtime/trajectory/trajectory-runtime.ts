import crypto from "node:crypto";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { runtimeAutomaticSourceExecutionReady, sourceExecutionAuthorized, sourcePlanningAuthorized } from "../../extensions/task-lifecycle.js";
import { latestObservedVerification, verificationEvidenceProvesStableTree } from "../../extensions/verification-intelligence.js";
import { workingTreeEvidenceDigest } from "../../extensions/working-tree-digest.js";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory, trajectoryPath } from "./trajectory-state.ts";
import { appendTrajectoryTransition, readTrajectoryStore, writeTrajectoryState } from "./trajectory-store.ts";
import type { TrajectoryRecommendationRef, TrajectorySourceHook, TrajectoryState, TrajectoryTransitionEvent } from "./trajectory-types.ts";
import type { SolverDecision } from "../solver/solver-types.ts";

export type TrajectorySyncOptions = {
  sourceHook: TrajectorySourceHook;
  observedAt?: string;
  verificationStarted?: boolean;
  contextObserved?: boolean;
  handoffObserved?: boolean;
  recoveryMutationAllowed?: boolean;
  recoveryRequested?: boolean;
  recommendationRef?: TrajectoryRecommendationRef | null;
};

export type TrajectorySyncResult = {
  status: "ok" | "corrupt";
  initialized: boolean;
  enforcementSafe: boolean;
  state?: TrajectoryState;
  transitions: TrajectoryTransitionEvent[];
  warnings: string[];
};

export type TrajectoryStatus = { taskRunId: string | null; phase: TrajectoryState["currentPhase"] | null; enforcementSafe: boolean; warnings: string[] };

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function trajectoryRecommendationRef(decision: SolverDecision): TrajectoryRecommendationRef {
  return {
    solverPolicyVersion: decision.policyVersion,
    featureHash: decision.featureHash,
    route: decision.route,
    decisionDigest: digest(decision)
  };
}

function latestVerification(task: TaskContract): TaskContract["verifyEvidence"][number] | undefined {
  return latestObservedVerification(task.verifyEvidence) ?? undefined;
}

function stepObserved(task: TaskContract, ids: string[]): boolean {
  return task.workPlan.some((step) => ids.includes(step.id) && step.status !== "pending");
}

function phaseObservation(
  task: TaskContract,
  phase: string,
  options: TrajectorySyncOptions,
  currentTreeDigest?: string | null
): TrajectoryTransitionEvent["cause"] | undefined {
  const latest = latestVerification(task);
  if (phase === "scout" && (options.contextObserved === true || task.contextManifest.length > 0 || stepObserved(task, ["scope", "challenge", "scout"]))) return "context-observed";
  if (phase === "plan" && stepObserved(task, ["plan"])) return "plan-observed";
  if (phase === "execute") {
    if (sourceExecutionAuthorized(task)) return "execution-authorized";
    if (task.observedChangedFiles.length > 0) return "mutation-observed";
  }
  if (phase === "verify") {
    if (options.verificationStarted === true) return "verification-started";
    if (verificationEvidenceProvesStableTree(latest, currentTreeDigest)) return "verification-passed";
  }
  if (phase === "review" && stepObserved(task, ["review"])) return "review-observed";
  if (phase === "handoff" && options.handoffObserved === true) return "handoff-observed";
  return undefined;
}

function treeDigest(task: TaskContract): string | null {
  const snapshot = task.finalFileDigests ?? {};
  return Object.keys(snapshot).length > 0 ? workingTreeEvidenceDigest(snapshot) : null;
}

function recordTransition(cwd: string, state: TrajectoryState, event: TrajectoryTransitionEvent): TrajectoryState {
  const next = reduceTrajectory(state, event);
  appendTrajectoryTransition(cwd, event);
  return writeTrajectoryState(cwd, next);
}

export class TrajectoryRuntime {
  status(cwd: string, taskRunId: string | undefined): TrajectoryStatus {
    if (!taskRunId) return { taskRunId: null, phase: null, enforcementSafe: true, warnings: [] };
    const stored = readTrajectoryStore(cwd, taskRunId);
    return { taskRunId, phase: stored.state?.currentPhase ?? null, enforcementSafe: stored.enforcementSafe, warnings: stored.warnings };
  }

  syncOptional(cwd: string, sessionId: string, task: TaskContract | undefined, options: TrajectorySyncOptions): TrajectorySyncResult | undefined {
    return task ? this.sync(cwd, sessionId, task, options) : undefined;
  }

  sync(cwd: string, sessionId: string, task: TaskContract, options: TrajectorySyncOptions): TrajectorySyncResult {
    const stored = readTrajectoryStore(cwd, task.taskRunId);
    if (!stored.enforcementSafe) return { status: "corrupt", initialized: false, enforcementSafe: false, transitions: [], warnings: stored.warnings };
    let initialized = false;
    let state = stored.state;
    if (!state) {
      state = createTrajectoryState({
        taskId: task.taskId,
        taskRunId: task.taskRunId,
        sessionId,
        changeMode: task.changeMode,
        riskLane: task.riskLane,
        recommendationRef: options.recommendationRef ?? null,
        createdAt: task.createdAt
      });
      state = writeTrajectoryState(cwd, state);
      initialized = true;
    } else if (stored.recoveredEvents > 0) {
      state = writeTrajectoryState(cwd, state);
    }
    if (state.recommendationRef === null && options.recommendationRef) {
      state = writeTrajectoryState(cwd, { ...state, recommendationRef: options.recommendationRef });
    }
    const transitions: TrajectoryTransitionEvent[] = [];
    const observedAt = options.observedAt ?? new Date().toISOString();
    const taskDigest = digest(task), currentTreeDigest = treeDigest(task);
    const latest = latestVerification(task);
    if (state.currentPhase === "intake" && sourcePlanningAuthorized(task)) {
      const path = trajectoryPath(state.changeMode, state.riskLane);
      const planIndex = path.indexOf("plan");
      const skippedPhases = planIndex > 1 ? path.slice(1, planIndex) : [];
      if (skippedPhases.length > 0) {
        const event = createTrajectoryTransition(state, {
          to: "plan",
          cause: "explicit-skip",
          sourceHook: options.sourceHook,
          taskDigest,
          treeDigest: currentTreeDigest,
          skippedPhases,
          skipReason: "The persisted work plan starts with a manual plan checkpoint and defines no separate scout checkpoint.",
          observedAt
        });
        state = recordTransition(cwd, state, event);
        transitions.push(event);
      }
    }
    if (state.currentPhase === "intake" && runtimeAutomaticSourceExecutionReady(task)) {
      const path = trajectoryPath(state.changeMode, state.riskLane);
      const executeIndex = path.indexOf("execute");
      const skippedPhases = executeIndex > 0 ? path.slice(1, executeIndex) : [];
      const event = createTrajectoryTransition(state, {
        to: "execute",
        cause: "execution-authorized",
        sourceHook: options.sourceHook,
        taskDigest,
        treeDigest: currentTreeDigest,
        skippedPhases,
        skipReason: skippedPhases.length > 0
          ? "Runtime-owned automatic work plan has no manual plan checkpoint and its contract, scope, and exact verifier are ready."
          : null,
        observedAt
      });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    if (
      options.recoveryRequested === true
      && options.recoveryMutationAllowed === true
      && ["execute", "verify", "review"].includes(state.currentPhase)
    ) {
      const event = createTrajectoryTransition(state, {
        to: "repair",
        cause: "recovery-requested",
        sourceHook: options.sourceHook,
        taskDigest,
        treeDigest: currentTreeDigest,
        observedAt
      });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    const verificationFailed = Boolean(latest && latest.observed === true && (latest.isError === true || latest.exitCode !== 0));
    if (verificationFailed && options.recoveryMutationAllowed !== false && ["execute", "verify", "review"].includes(state.currentPhase)) {
      const event = createTrajectoryTransition(state, { to: "repair", cause: "verification-failed", sourceHook: options.sourceHook, taskDigest, treeDigest: currentTreeDigest, observedAt });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    const passingVerifierAfterRepair = verificationEvidenceProvesStableTree(latest, currentTreeDigest)
      && Date.parse(String(latest?.observedAt ?? latest?.recordedAt)) >= Date.parse(state.updatedAt);
    if (state.currentPhase === "repair" && (options.verificationStarted || passingVerifierAfterRepair)) {
      const event = createTrajectoryTransition(state, { to: "verify", cause: "verification-started", sourceHook: options.sourceHook, taskDigest, treeDigest: currentTreeDigest, observedAt });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    const path = trajectoryPath(state.changeMode, state.riskLane);
    while (state.currentPhase !== "terminal") {
      const currentIndex = path.indexOf(state.currentPhase);
      const next = currentIndex >= 0 ? path[currentIndex + 1] : undefined;
      const cause = next && next !== "terminal" ? phaseObservation(task, next, options, currentTreeDigest) : undefined;
      if (!next || next === "terminal" || !cause) break;
      const event = createTrajectoryTransition(state, { to: next, cause, sourceHook: options.sourceHook, taskDigest, treeDigest: currentTreeDigest, observedAt });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    if (task.trace.outcome !== "pending" && state.currentPhase !== "terminal") {
      const currentIndex = path.indexOf(state.currentPhase);
      const skippedPhases = currentIndex >= 0 ? path.slice(currentIndex + 1, -1) : [];
      const terminalRef = { taskRunId: task.taskRunId, taskUpdatedAt: task.updatedAt, taskDigest };
      const event = createTrajectoryTransition(state, {
        to: "terminal",
        cause: "task-terminal",
        sourceHook: options.sourceHook,
        taskDigest,
        treeDigest: currentTreeDigest,
        skippedPhases,
        skipReason: skippedPhases.length > 0 ? "Task Contract reached a terminal outcome before remaining trajectory phases." : null,
        observedAt,
        terminalTaskOutcomeRef: terminalRef
      });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    return { status: "ok", initialized, enforcementSafe: true, state, transitions, warnings: stored.warnings };
  }

  syncToolCall(cwd: string, sessionId: string, task: TaskContract, event: { toolName: string; input?: unknown }, observedAt?: string): TrajectorySyncResult {
    const input = event.input && typeof event.input === "object" && !Array.isArray(event.input) ? event.input as Record<string, unknown> : {};
    const command = String(input.command ?? input.cmd ?? "").trim();
    const verificationStarted = command.length > 0 && task.verifyCommands.some((candidate) => candidate.trim() === command);
    const handoffObserved = event.toolName === "piagent_trace_record";
    return this.sync(cwd, sessionId, task, { sourceHook: "tool-call", observedAt, verificationStarted, handoffObserved });
  }

  syncOptionalToolCall(cwd: string, sessionId: string, task: TaskContract | undefined, event: { toolName: string; input?: unknown }, observedAt?: string): TrajectorySyncResult | undefined {
    return task ? this.syncToolCall(cwd, sessionId, task, event, observedAt) : undefined;
  }
}

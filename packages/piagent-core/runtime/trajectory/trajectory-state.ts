import crypto from "node:crypto";

import type {
  TerminalTaskOutcomeRef,
  TrajectoryCause,
  TrajectoryPhase,
  TrajectoryRecommendationRef,
  TrajectorySourceHook,
  TrajectoryState,
  TrajectoryTransitionEvent
} from "./trajectory-types.ts";
import {
  TRAJECTORY_POLICY_VERSION,
  TRAJECTORY_SCHEMA_VERSION,
  trajectoryEventId,
  validateTrajectoryState,
  validateTrajectoryTransition
} from "./trajectory-types.ts";

export type CreateTrajectoryInput = {
  taskId: string;
  taskRunId: string;
  sessionId: string;
  changeMode: TrajectoryState["changeMode"];
  riskLane: TrajectoryState["riskLane"];
  recommendationRef?: TrajectoryRecommendationRef | null;
  createdAt?: string;
};

export type CreateTransitionInput = {
  to: TrajectoryPhase;
  cause: TrajectoryCause;
  sourceHook: TrajectorySourceHook;
  taskDigest?: string | null;
  treeDigest?: string | null;
  skippedPhases?: TrajectoryPhase[];
  skipReason?: string | null;
  observedAt?: string;
  terminalTaskOutcomeRef?: TerminalTaskOutcomeRef | null;
};

const PHASE_CAUSES: Partial<Record<TrajectoryPhase, Set<TrajectoryCause>>> = {
  scout: new Set(["context-observed"]),
  plan: new Set(["plan-observed"]),
  execute: new Set(["execution-authorized", "mutation-observed"]),
  verify: new Set(["verification-started", "verification-passed"]),
  repair: new Set(["verification-failed", "recovery-requested"]),
  review: new Set(["review-observed", "verification-passed"]),
  handoff: new Set(["handoff-observed"]),
  terminal: new Set(["task-terminal"])
};

export function trajectoryPath(changeMode: TrajectoryState["changeMode"], riskLane: TrajectoryState["riskLane"]): TrajectoryPhase[] {
  if (changeMode === "read-only") return ["intake", "scout", "review", "handoff", "terminal"];
  if (riskLane === "tiny") return ["intake", "execute", "verify", "handoff", "terminal"];
  if (riskLane === "high-risk") return ["intake", "scout", "plan", "execute", "verify", "review", "handoff", "terminal"];
  return ["intake", "plan", "execute", "verify", "review", "handoff", "terminal"];
}

export function createTrajectoryState(input: CreateTrajectoryInput): TrajectoryState {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return validateTrajectoryState({
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    policyVersion: TRAJECTORY_POLICY_VERSION,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    sessionHash: crypto.createHash("sha256").update(String(input.sessionId || "unknown-session")).digest("hex"),
    changeMode: input.changeMode,
    riskLane: input.riskLane,
    currentPhase: "intake",
    recommendationRef: input.recommendationRef ?? null,
    sequence: 0,
    appliedEventIds: [],
    lastTransition: null,
    createdAt,
    updatedAt: createdAt,
    terminalTaskOutcomeRef: null
  });
}

export function createTrajectoryTransition(stateInput: TrajectoryState, input: CreateTransitionInput): TrajectoryTransitionEvent {
  const state = validateTrajectoryState(stateInput);
  const material = {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    policyVersion: TRAJECTORY_POLICY_VERSION,
    taskId: state.taskId,
    taskRunId: state.taskRunId,
    sessionHash: state.sessionHash,
    sequence: state.sequence + 1,
    from: state.currentPhase,
    to: input.to,
    cause: input.cause,
    sourceHook: input.sourceHook,
    taskDigest: input.taskDigest ?? null,
    treeDigest: input.treeDigest ?? null,
    skippedPhases: [...(input.skippedPhases ?? [])],
    skipReason: input.skipReason ?? null,
    terminalTaskOutcomeRef: input.terminalTaskOutcomeRef ?? null
  };
  return validateTrajectoryTransition({
    ...material,
    eventId: trajectoryEventId(material),
    observedAt: input.observedAt ?? new Date().toISOString()
  });
}

function samePhases(left: TrajectoryPhase[], right: TrajectoryPhase[]): boolean {
  return left.length === right.length && left.every((phase, index) => phase === right[index]);
}

function policyError(state: TrajectoryState, event: TrajectoryTransitionEvent): string | undefined {
  const path = trajectoryPath(state.changeMode, state.riskLane);
  const fromIndex = path.indexOf(event.from);
  const toIndex = path.indexOf(event.to);
  const repairEdge = (["execute", "verify", "review"].includes(event.from) && event.to === "repair")
    || (event.from === "repair" && event.to === "verify");
  if (repairEdge) {
    if (event.skippedPhases.length > 0) return "repair transitions cannot skip phases";
    return undefined;
  }
  if (fromIndex < 0 || toIndex < 0 || toIndex <= fromIndex) return "transition is outside the configured trajectory path";
  const skipped = path.slice(fromIndex + 1, toIndex);
  if (!samePhases(skipped, event.skippedPhases)) return "skipped phases do not match the configured trajectory path";
  if (skipped.length > 0) {
    const failureHandoff = event.to === "handoff" && event.cause === "handoff-observed" && ["execute", "verify", "repair"].includes(event.from);
    const terminal = event.to === "terminal" && event.cause === "task-terminal";
    const executableWorkPlan = event.to === "execute" && event.cause === "execution-authorized";
    if (event.cause !== "explicit-skip" && !executableWorkPlan && !failureHandoff && !terminal) return "non-adjacent transition requires explicit skip evidence";
    if (state.changeMode === "source-change" && skipped.includes("verify") && !failureHandoff && !terminal) return "source verification cannot be skipped";
    if (state.riskLane === "high-risk" && skipped.includes("plan") && !terminal) return "high-risk planning cannot be skipped";
    if ((state.changeMode === "read-only" || state.riskLane === "high-risk") && skipped.includes("review") && !terminal) return "required review cannot be skipped";
  }
  const causes = PHASE_CAUSES[event.to];
  if (event.cause !== "explicit-skip" && causes && !causes.has(event.cause)) return `cause ${event.cause} cannot enter ${event.to}`;
  return undefined;
}

export function reduceTrajectory(stateInput: TrajectoryState, eventInput: TrajectoryTransitionEvent): TrajectoryState {
  const state = validateTrajectoryState(structuredClone(stateInput));
  const event = validateTrajectoryTransition(structuredClone(eventInput));
  if (state.appliedEventIds.includes(event.eventId)) return state;
  if (state.currentPhase === "terminal") throw new Error("terminal Task Contract reference prevents trajectory mutation");
  if (event.taskId !== state.taskId || event.taskRunId !== state.taskRunId || event.sessionHash !== state.sessionHash) throw new Error("trajectory transition identity mismatch");
  if (event.sequence !== state.sequence + 1 || event.from !== state.currentPhase) throw new Error("trajectory transition is out of order");
  if (Date.parse(event.observedAt) < Date.parse(state.updatedAt)) throw new Error("trajectory transition timestamp is stale");
  const error = policyError(state, event);
  if (error) throw new Error(error);
  return validateTrajectoryState({
    ...state,
    currentPhase: event.to,
    sequence: event.sequence,
    appliedEventIds: [...state.appliedEventIds, event.eventId],
    lastTransition: event,
    updatedAt: event.observedAt,
    terminalTaskOutcomeRef: event.terminalTaskOutcomeRef
  });
}

export function replayTrajectory(initial: TrajectoryState, events: readonly TrajectoryTransitionEvent[]): TrajectoryState {
  return events.reduce((state, event) => reduceTrajectory(state, event), validateTrajectoryState(structuredClone(initial)));
}

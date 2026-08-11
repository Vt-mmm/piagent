import crypto from "node:crypto";
import { isCurrentWorkingTreeDigest } from "../../extensions/working-tree-digest.js";

export const TRAJECTORY_SCHEMA_VERSION = 1 as const;
export const TRAJECTORY_POLICY_VERSION = "trajectory-v1" as const;
export const TRAJECTORY_PHASES = Object.freeze(["intake", "scout", "plan", "execute", "verify", "repair", "review", "handoff", "terminal"] as const);
export const TRAJECTORY_CAUSES = Object.freeze(["task-started", "context-observed", "plan-observed", "execution-authorized", "mutation-observed", "verification-started", "verification-passed", "verification-failed", "review-observed", "handoff-observed", "task-terminal", "recovery-requested", "explicit-skip"] as const);
export const TRAJECTORY_SOURCE_HOOKS = Object.freeze(["input", "agent-start", "tool-call", "tool-result", "completion", "session-start", "task-state", "operator"] as const);

export type TrajectoryPhase = typeof TRAJECTORY_PHASES[number];
export type TrajectoryCause = typeof TRAJECTORY_CAUSES[number];
export type TrajectorySourceHook = typeof TRAJECTORY_SOURCE_HOOKS[number];
export type TerminalTaskOutcomeRef = { taskRunId: string; taskUpdatedAt: string; taskDigest: string };
export type TrajectoryRecommendationRef = {
  solverPolicyVersion: "solver-v1";
  featureHash: string;
  route: "direct" | "scout-first" | "plan-first" | "review-only" | "blocked-preflight";
  decisionDigest: string;
};
export type TrajectoryTransitionEvent = {
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  policyVersion: typeof TRAJECTORY_POLICY_VERSION;
  eventId: string;
  taskId: string;
  taskRunId: string;
  sessionHash: string;
  sequence: number;
  from: TrajectoryPhase;
  to: TrajectoryPhase;
  cause: TrajectoryCause;
  sourceHook: TrajectorySourceHook;
  taskDigest: string | null;
  treeDigest: string | null;
  skippedPhases: TrajectoryPhase[];
  skipReason: string | null;
  observedAt: string;
  terminalTaskOutcomeRef: TerminalTaskOutcomeRef | null;
};
export type TrajectoryState = {
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  policyVersion: typeof TRAJECTORY_POLICY_VERSION;
  taskId: string;
  taskRunId: string;
  sessionHash: string;
  changeMode: "source-change" | "read-only";
  riskLane: "tiny" | "normal" | "high-risk";
  currentPhase: TrajectoryPhase;
  recommendationRef: TrajectoryRecommendationRef | null;
  sequence: number;
  appliedEventIds: string[];
  lastTransition: TrajectoryTransitionEvent | null;
  createdAt: string;
  updatedAt: string;
  terminalTaskOutcomeRef: TerminalTaskOutcomeRef | null;
};

function eventIdentityMaterial(input: Omit<TrajectoryTransitionEvent, "eventId" | "observedAt">): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    policyVersion: input.policyVersion,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    sessionHash: input.sessionHash,
    sequence: input.sequence,
    from: input.from,
    to: input.to,
    cause: input.cause,
    sourceHook: input.sourceHook,
    taskDigest: input.taskDigest,
    treeDigest: input.treeDigest,
    skippedPhases: input.skippedPhases,
    skipReason: input.skipReason,
    terminalTaskOutcomeRef: input.terminalTaskOutcomeRef
  };
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const EVENT_FIELDS = new Set(["schemaVersion", "policyVersion", "eventId", "taskId", "taskRunId", "sessionHash", "sequence", "from", "to", "cause", "sourceHook", "taskDigest", "treeDigest", "skippedPhases", "skipReason", "observedAt", "terminalTaskOutcomeRef"]);
const STATE_FIELDS = new Set(["schemaVersion", "policyVersion", "taskId", "taskRunId", "sessionHash", "changeMode", "riskLane", "currentPhase", "recommendationRef", "sequence", "appliedEventIds", "lastTransition", "createdAt", "updatedAt", "terminalTaskOutcomeRef"]);
const TERMINAL_REF_FIELDS = new Set(["taskRunId", "taskUpdatedAt", "taskDigest"]);
const RECOMMENDATION_FIELDS = new Set(["solverPolicyVersion", "featureHash", "route", "decisionDigest"]);
const ALLOWED_TRANSITIONS = new Set([
  "intake:scout", "intake:plan", "intake:execute", "intake:review", "intake:handoff", "intake:terminal",
  "scout:plan", "scout:review", "scout:handoff", "scout:terminal", "plan:execute", "plan:review", "plan:handoff", "plan:terminal",
  "execute:verify", "execute:repair", "execute:handoff", "execute:terminal", "verify:repair", "verify:review", "verify:handoff", "verify:terminal",
  "repair:verify", "repair:handoff", "repair:terminal", "review:repair", "review:handoff", "review:terminal", "handoff:terminal"
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function exact(value: Record<string, unknown>, fields: Set<string>, label: string): string[] {
  return [...Object.keys(value).filter((field) => !fields.has(field)).map((field) => `${label} has unknown field: ${field}`), ...[...fields].filter((field) => !(field in value)).map((field) => `${label} missing field: ${field}`)];
}
function timestamp(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function terminalRefErrors(value: unknown, label: string): string[] {
  if (value === null) return [];
  const ref = record(value);
  if (!ref) return [`${label} must be null or an object`];
  const errors = exact(ref, TERMINAL_REF_FIELDS, label);
  if (typeof ref.taskRunId !== "string" || !ID.test(ref.taskRunId)) errors.push(`${label}.taskRunId is invalid`);
  if (!timestamp(ref.taskUpdatedAt)) errors.push(`${label}.taskUpdatedAt is invalid`);
  if (typeof ref.taskDigest !== "string" || !HASH.test(ref.taskDigest)) errors.push(`${label}.taskDigest is invalid`);
  return errors;
}
function recommendationErrors(value: unknown): string[] {
  if (value === null) return [];
  const ref = record(value);
  if (!ref) return ["recommendationRef must be null or an object"];
  const errors = exact(ref, RECOMMENDATION_FIELDS, "recommendationRef");
  if (ref.solverPolicyVersion !== "solver-v1") errors.push("recommendationRef.solverPolicyVersion is invalid");
  for (const field of ["featureHash", "decisionDigest"] as const) if (typeof ref[field] !== "string" || !HASH.test(ref[field])) errors.push(`recommendationRef.${field} is invalid`);
  if (!["direct", "scout-first", "plan-first", "review-only", "blocked-preflight"].includes(String(ref.route))) errors.push("recommendationRef.route is invalid");
  return errors;
}

export function trajectoryTransitionValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["trajectory transition must be an object"];
  const errors = exact(value, EVENT_FIELDS, "trajectory transition");
  if (value.schemaVersion !== 1 || value.policyVersion !== TRAJECTORY_POLICY_VERSION) errors.push("transition schema/policy version is invalid");
  for (const field of ["eventId", "sessionHash"] as const) if (typeof value[field] !== "string" || !HASH.test(value[field])) errors.push(`${field} is invalid`);
  for (const field of ["taskId", "taskRunId"] as const) if (typeof value[field] !== "string" || !ID.test(value[field])) errors.push(`${field} is invalid`);
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 1 || Number(value.sequence) > Number.MAX_SAFE_INTEGER) errors.push("sequence must be a positive integer");
  if (!TRAJECTORY_PHASES.includes(value.from as TrajectoryPhase) || !TRAJECTORY_PHASES.includes(value.to as TrajectoryPhase) || !ALLOWED_TRANSITIONS.has(`${value.from}:${value.to}`)) errors.push("phase transition is not allowed");
  if (!TRAJECTORY_CAUSES.includes(value.cause as TrajectoryCause)) errors.push("cause is invalid");
  if (!TRAJECTORY_SOURCE_HOOKS.includes(value.sourceHook as TrajectorySourceHook)) errors.push("sourceHook is invalid");
  if (value.taskDigest !== null && (typeof value.taskDigest !== "string" || !HASH.test(value.taskDigest))) errors.push("taskDigest is invalid");
  if (value.treeDigest !== null && !isCurrentWorkingTreeDigest(value.treeDigest)) errors.push("treeDigest is invalid");
  const skipped = Array.isArray(value.skippedPhases) ? value.skippedPhases : [];
  if (!Array.isArray(value.skippedPhases) || skipped.length > 7 || skipped.some((phase) => !TRAJECTORY_PHASES.includes(phase as TrajectoryPhase)) || new Set(skipped).size !== skipped.length) errors.push("skippedPhases are invalid");
  if (value.cause === "explicit-skip" && skipped.length === 0) errors.push("explicit-skip requires skippedPhases");
  if (skipped.length > 0 && (typeof value.skipReason !== "string" || value.skipReason.length < 3 || value.skipReason.length > 240)) errors.push("skipped phases require a bounded skipReason");
  if (skipped.length === 0 && value.skipReason !== null) errors.push("skipReason requires skippedPhases");
  if (!timestamp(value.observedAt)) errors.push("observedAt is invalid");
  errors.push(...terminalRefErrors(value.terminalTaskOutcomeRef, "terminalTaskOutcomeRef"));
  if (value.to === "terminal" && value.terminalTaskOutcomeRef === null) errors.push("terminal transition requires a Task Contract outcome reference");
  if (value.to !== "terminal" && value.terminalTaskOutcomeRef !== null) errors.push("non-terminal transition cannot carry a terminal reference");
  const terminalRef = record(value.terminalTaskOutcomeRef);
  if (terminalRef && terminalRef.taskRunId !== value.taskRunId) errors.push("terminal reference taskRunId must match transition identity");
  if (errors.length === 0) {
    const { eventId: _eventId, observedAt: _observedAt, ...material } = value;
    if (trajectoryEventId(material as Omit<TrajectoryTransitionEvent, "eventId" | "observedAt">) !== value.eventId) errors.push("eventId does not match transition material");
  }
  return errors;
}
export function validateTrajectoryTransition(input: unknown, source = "trajectory transition"): TrajectoryTransitionEvent {
  const errors = trajectoryTransitionValidationErrors(input);
  if (errors.length > 0) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as TrajectoryTransitionEvent;
}

export function trajectoryStateValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["trajectory state must be an object"];
  const errors = exact(value, STATE_FIELDS, "trajectory state");
  if (value.schemaVersion !== 1 || value.policyVersion !== TRAJECTORY_POLICY_VERSION) errors.push("state schema/policy version is invalid");
  for (const field of ["taskId", "taskRunId"] as const) if (typeof value[field] !== "string" || !ID.test(value[field])) errors.push(`${field} is invalid`);
  if (typeof value.sessionHash !== "string" || !HASH.test(value.sessionHash)) errors.push("sessionHash is invalid");
  if (!["source-change", "read-only"].includes(String(value.changeMode)) || !["tiny", "normal", "high-risk"].includes(String(value.riskLane))) errors.push("changeMode/riskLane is invalid");
  if (!TRAJECTORY_PHASES.includes(value.currentPhase as TrajectoryPhase)) errors.push("currentPhase is invalid");
  errors.push(...recommendationErrors(value.recommendationRef));
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 0 || Number(value.sequence) > Number.MAX_SAFE_INTEGER) errors.push("sequence must be a non-negative integer");
  if (!Array.isArray(value.appliedEventIds) || value.appliedEventIds.length > 256 || value.appliedEventIds.some((eventId) => typeof eventId !== "string" || !HASH.test(eventId)) || new Set(value.appliedEventIds).size !== value.appliedEventIds.length) errors.push("appliedEventIds are invalid");
  if (Array.isArray(value.appliedEventIds) && value.appliedEventIds.length !== value.sequence) errors.push("appliedEventIds length must match sequence");
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt) || (timestamp(value.createdAt) && timestamp(value.updatedAt) && Date.parse(String(value.updatedAt)) < Date.parse(String(value.createdAt)))) errors.push("state timestamps are invalid");
  errors.push(...terminalRefErrors(value.terminalTaskOutcomeRef, "terminalTaskOutcomeRef"));
  if (value.currentPhase === "terminal" && value.terminalTaskOutcomeRef === null) errors.push("terminal state requires a Task Contract outcome reference");
  if (value.currentPhase !== "terminal" && value.terminalTaskOutcomeRef !== null) errors.push("non-terminal state cannot carry a terminal reference");
  if (value.sequence === 0 && value.lastTransition !== null) errors.push("initial state cannot have a last transition");
  if (value.sequence !== 0 && value.lastTransition === null) errors.push("non-initial state requires a last transition");
  if (value.lastTransition !== null) {
    errors.push(...trajectoryTransitionValidationErrors(value.lastTransition).map((error) => `lastTransition: ${error}`));
    const transition = record(value.lastTransition);
    if (transition && (transition.taskId !== value.taskId || transition.taskRunId !== value.taskRunId || transition.sessionHash !== value.sessionHash)) errors.push("lastTransition identity must match state");
    if (transition && (transition.sequence !== value.sequence || transition.to !== value.currentPhase || transition.observedAt !== value.updatedAt)) errors.push("lastTransition sequence/phase/time must match state");
    if (transition && Array.isArray(value.appliedEventIds) && value.appliedEventIds.at(-1) !== transition.eventId) errors.push("lastTransition eventId must be the latest applied event");
  }
  const terminalRef = record(value.terminalTaskOutcomeRef);
  if (terminalRef && terminalRef.taskRunId !== value.taskRunId) errors.push("terminal reference taskRunId must match state identity");
  return errors;
}
export function validateTrajectoryState(input: unknown, source = "trajectory state"): TrajectoryState {
  const errors = trajectoryStateValidationErrors(input);
  if (errors.length > 0) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as TrajectoryState;
}
export function trajectoryEventId(input: Omit<TrajectoryTransitionEvent, "eventId" | "observedAt">): string {
  return crypto.createHash("sha256").update(JSON.stringify(eventIdentityMaterial(input))).digest("hex");
}
export function serializeTrajectoryState(input: TrajectoryState): string {
  return `${JSON.stringify(validateTrajectoryState(structuredClone(input)))}\n`;
}

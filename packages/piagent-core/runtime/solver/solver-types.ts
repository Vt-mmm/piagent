export const TASK_FEATURES_SCHEMA_VERSION = 1 as const;
export const SOLVER_DECISION_SCHEMA_VERSION = 1 as const;
export const SOLVER_POLICY_VERSION = "solver-v1" as const;

export const SOLVER_ROUTES = Object.freeze(["direct", "scout-first", "plan-first", "review-only", "blocked-preflight"] as const);
export type SolverRoute = typeof SOLVER_ROUTES[number];
export type SolverMode = "off" | "shadow" | "recommend";
export type WorkflowIntent = "implement" | "review" | "plan" | "diagnose" | "scout" | "unknown";
export type ChangeMode = "source-change" | "read-only" | "plan-only" | "unknown";
export type RiskLane = "tiny" | "normal" | "high-risk" | "unknown";

export type TaskFeatures = {
  schemaVersion: typeof TASK_FEATURES_SCHEMA_VERSION;
  featureHash: string;
  workflowIntent: WorkflowIntent;
  changeMode: ChangeMode;
  riskLane: RiskLane;
  riskSignals: string[];
  ambiguity: "low" | "medium" | "high" | "unknown";
  explicitPathCount: number;
  scopeEstimate: "tiny" | "bounded" | "broad" | "unknown";
  profileMode: string | null;
  projectShape: string[];
  gitReady: boolean | null;
  dirtyTree: boolean | null;
  verifierReady: boolean | null;
  contextPressure: number | null;
  activeTaskState: "none" | "pending" | "terminal" | "unknown";
  runtimeSnapshotDigest: string | null;
  runtimeCapabilitiesKnown: boolean;
  userPinnedProvider: string | null;
  userPinnedModel: string | null;
  userPinnedEffort: string | null;
  protectedTarget: boolean;
  externalAction: boolean;
  destructiveAction: boolean;
  permissionExpansion: boolean;
};

export type SolverDecision = {
  schemaVersion: typeof SOLVER_DECISION_SCHEMA_VERSION;
  policyVersion: typeof SOLVER_POLICY_VERSION;
  featureHash: string;
  route: SolverRoute;
  plannedPhases: Array<"intake" | "context" | "plan" | "implement" | "verify" | "review" | "handoff">;
  context: { recommendation: "none" | "targeted" | "bounded"; budgetBand: "none" | "small" | "medium" | "large" };
  toolGroups: string[];
  helper: { needed: boolean; role: "scout" | "planner" | "reviewer" | null; enforced: false };
  parentModel: { provider: string | null; modelId: string | null; effort: string | null; enforced: false };
  reasonCodes: string[];
  confidence: "low" | "medium" | "high";
  mode: SolverMode;
  override: { observed: boolean; route: SolverRoute | null; recordedAt: string | null };
};

const FEATURE_FIELDS = new Set(["schemaVersion", "featureHash", "workflowIntent", "changeMode", "riskLane", "riskSignals", "ambiguity", "explicitPathCount", "scopeEstimate", "profileMode", "projectShape", "gitReady", "dirtyTree", "verifierReady", "contextPressure", "activeTaskState", "runtimeSnapshotDigest", "runtimeCapabilitiesKnown", "userPinnedProvider", "userPinnedModel", "userPinnedEffort", "protectedTarget", "externalAction", "destructiveAction", "permissionExpansion"]);
const DECISION_FIELDS = new Set(["schemaVersion", "policyVersion", "featureHash", "route", "plannedPhases", "context", "toolGroups", "helper", "parentModel", "reasonCodes", "confidence", "mode", "override"]);
const SOLVER_PHASES = new Set(["intake", "context", "plan", "implement", "verify", "review", "handoff"]);
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exact(value: Record<string, unknown>, fields: Set<string>, label: string): string[] {
  return [
    ...Object.keys(value).filter((field) => !fields.has(field)).map((field) => `${label} has unknown field: ${field}`),
    ...[...fields].filter((field) => !(field in value)).map((field) => `${label} missing field: ${field}`)
  ];
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function nullableName(value: unknown): boolean {
  return value === null || (typeof value === "string" && NAME.test(value));
}

function names(value: unknown, max: number, allowEmpty = true): boolean {
  return Array.isArray(value) && value.length <= max && (allowEmpty || value.length > 0)
    && value.every((item) => typeof item === "string" && NAME.test(item))
    && new Set(value).size === value.length;
}

export function taskFeaturesValidationErrors(input: unknown): string[] {
  const value = object(input);
  if (!value) return ["task features must be an object"];
  const errors = exact(value, FEATURE_FIELDS, "task features");
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof value.featureHash !== "string" || !HASH.test(value.featureHash)) errors.push("featureHash must be sha256 hex");
  if (!["implement", "review", "plan", "diagnose", "scout", "unknown"].includes(String(value.workflowIntent))) errors.push("workflowIntent is invalid");
  if (!["source-change", "read-only", "plan-only", "unknown"].includes(String(value.changeMode))) errors.push("changeMode is invalid");
  if (!["tiny", "normal", "high-risk", "unknown"].includes(String(value.riskLane))) errors.push("riskLane is invalid");
  if (!names(value.riskSignals, 16)) errors.push("riskSignals are invalid");
  if (!["low", "medium", "high", "unknown"].includes(String(value.ambiguity))) errors.push("ambiguity is invalid");
  if (!Number.isInteger(value.explicitPathCount) || Number(value.explicitPathCount) < 0 || Number(value.explicitPathCount) > 1000) errors.push("explicitPathCount is invalid");
  if (!["tiny", "bounded", "broad", "unknown"].includes(String(value.scopeEstimate))) errors.push("scopeEstimate is invalid");
  if (!nullableName(value.profileMode) || !names(value.projectShape, 16)) errors.push("profile/project shape is invalid");
  for (const field of ["gitReady", "dirtyTree", "verifierReady"] as const) if (!nullableBoolean(value[field])) errors.push(`${field} must be boolean or null`);
  if (value.contextPressure !== null && (typeof value.contextPressure !== "number" || value.contextPressure < 0 || value.contextPressure > 1)) errors.push("contextPressure is invalid");
  if (!["none", "pending", "terminal", "unknown"].includes(String(value.activeTaskState))) errors.push("activeTaskState is invalid");
  if (value.runtimeSnapshotDigest !== null && (typeof value.runtimeSnapshotDigest !== "string" || !HASH.test(value.runtimeSnapshotDigest))) errors.push("runtimeSnapshotDigest is invalid");
  if (typeof value.runtimeCapabilitiesKnown !== "boolean") errors.push("runtimeCapabilitiesKnown must be boolean");
  for (const field of ["userPinnedProvider", "userPinnedModel", "userPinnedEffort"] as const) if (!nullableName(value[field])) errors.push(`${field} is invalid`);
  for (const field of ["protectedTarget", "externalAction", "destructiveAction", "permissionExpansion"] as const) if (typeof value[field] !== "boolean") errors.push(`${field} must be boolean`);
  return errors;
}

export function validateTaskFeatures(input: unknown, source = "task features"): TaskFeatures {
  const errors = taskFeaturesValidationErrors(input);
  if (errors.length) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as TaskFeatures;
}

export function solverDecisionValidationErrors(input: unknown): string[] {
  const value = object(input);
  if (!value) return ["solver decision must be an object"];
  const errors = exact(value, DECISION_FIELDS, "solver decision");
  if (value.schemaVersion !== 1 || value.policyVersion !== SOLVER_POLICY_VERSION) errors.push("solver schema/policy version is invalid");
  if (typeof value.featureHash !== "string" || !HASH.test(value.featureHash)) errors.push("featureHash must be sha256 hex");
  if (!SOLVER_ROUTES.includes(value.route as SolverRoute)) errors.push("route is invalid");
  if (!names(value.plannedPhases, 7, false) || !(value.plannedPhases as unknown[]).every((phase) => SOLVER_PHASES.has(String(phase)))) errors.push("plannedPhases are invalid");
  const context = object(value.context), helper = object(value.helper), parent = object(value.parentModel), override = object(value.override);
  if (!context || exact(context, new Set(["recommendation", "budgetBand"]), "context").length || !["none", "targeted", "bounded"].includes(String(context.recommendation)) || !["none", "small", "medium", "large"].includes(String(context.budgetBand))) errors.push("context recommendation is invalid");
  if (!names(value.toolGroups, 10)) errors.push("toolGroups are invalid");
  if (!helper || exact(helper, new Set(["needed", "role", "enforced"]), "helper").length || typeof helper.needed !== "boolean" || !["scout", "planner", "reviewer", null].includes(helper.role as never) || helper.enforced !== false) errors.push("helper recommendation is invalid");
  if (!parent || exact(parent, new Set(["provider", "modelId", "effort", "enforced"]), "parentModel").length || !nullableName(parent.provider) || !nullableName(parent.modelId) || !nullableName(parent.effort) || parent.enforced !== false) errors.push("parent model recommendation is invalid");
  if (!names(value.reasonCodes, 24, false)) errors.push("reasonCodes are invalid");
  if (!["low", "medium", "high"].includes(String(value.confidence)) || !["off", "shadow", "recommend"].includes(String(value.mode))) errors.push("confidence/mode is invalid");
  if (!override || exact(override, new Set(["observed", "route", "recordedAt"]), "override").length || typeof override.observed !== "boolean" || (override.route !== null && !SOLVER_ROUTES.includes(override.route as SolverRoute)) || (override.recordedAt !== null && (typeof override.recordedAt !== "string" || !Number.isFinite(Date.parse(override.recordedAt))))) errors.push("override is invalid");
  if (value.mode === "shadow" && parent?.enforced !== false) errors.push("shadow parent recommendation cannot be enforced");
  return errors;
}

export function validateSolverDecision(input: unknown, source = "solver decision"): SolverDecision {
  const errors = solverDecisionValidationErrors(input);
  if (errors.length) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as SolverDecision;
}

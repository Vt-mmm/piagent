export const SOLVER_ROUTES = Object.freeze(["direct", "scout-first", "plan-first", "review-only", "blocked-preflight"] as const);
export type SolverRoute = typeof SOLVER_ROUTES[number];
export type RiskLane = "tiny" | "normal" | "high-risk" | "unknown";
type TaskFeatureInput = { request: string; [field: string]: unknown };
type SolverDecision = {
  route: SolverRoute;
  plannedPhases: string[];
  toolGroups: string[];
  parentModel: { enforced: boolean };
  reasonCodes: string[];
};

export const SOLVER_PROHIBITED_PROPERTIES = Object.freeze([
  "mutation-recommendation",
  "unblocked-preflight",
  "missing-plan-verify-review",
  "parent-model-enforced",
  "empty-reason-codes"
] as const);

export type SolverProhibitedProperty = typeof SOLVER_PROHIBITED_PROPERTIES[number];

export type SolverRouteLabel = {
  acceptableRoutes: SolverRoute[];
  prohibitedProperties: SolverProhibitedProperty[];
};

export type SolverRouteCorpus = {
  schemaVersion: 1;
  id: string;
  productionSuite: { id: "production-v1"; repeats: 3 };
  reviews: Array<{ ownerRole: "Product" | "Safety"; reviewer: string; status: "local-autopilot-reviewed"; reviewedAt: string }>;
  defaults: Record<string, unknown>;
  productionLabels: Array<SolverRouteLabel & { scenarioId: string; repeats: [1, 2, 3]; riskLane: RiskLane }>;
  adversarialCases: Array<SolverRouteLabel & { id: string; category: string; request: string; overrides: Partial<TaskFeatureInput>; riskLane: RiskLane }>;
};

const RISK_LANES = new Set<RiskLane>(["tiny", "normal", "high-risk", "unknown"]);
const HASH = /^[a-z0-9][a-z0-9-]{0,127}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exact(value: Record<string, unknown>, fields: string[], label: string, errors: string[]): void {
  for (const field of Object.keys(value)) if (!fields.includes(field)) errors.push(`${label} has unknown field: ${field}`);
  for (const field of fields) if (!(field in value)) errors.push(`${label} missing field: ${field}`);
}

function validateLabel(value: Record<string, unknown>, label: string, errors: string[]): void {
  if (!Array.isArray(value.acceptableRoutes) || value.acceptableRoutes.length === 0
    || value.acceptableRoutes.some((route) => !SOLVER_ROUTES.includes(route as SolverRoute))) errors.push(`${label}.acceptableRoutes is invalid`);
  if (!Array.isArray(value.prohibitedProperties)
    || value.prohibitedProperties.some((item) => !SOLVER_PROHIBITED_PROPERTIES.includes(item as SolverProhibitedProperty))) errors.push(`${label}.prohibitedProperties is invalid`);
}

export function solverRouteCorpusValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["solver route corpus must be an object"];
  const errors: string[] = [];
  exact(value, ["schemaVersion", "id", "productionSuite", "reviews", "defaults", "productionLabels", "adversarialCases"], "corpus", errors);
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !HASH.test(value.id)) errors.push("corpus identity is invalid");
  const suite = record(value.productionSuite);
  if (!suite || suite.id !== "production-v1" || suite.repeats !== 3) errors.push("productionSuite must pin production-v1 with three repeats");
  const reviews = Array.isArray(value.reviews) ? value.reviews : [];
  for (const role of ["Product", "Safety"]) {
    if (!reviews.some((item) => record(item)?.ownerRole === role && record(item)?.status === "local-autopilot-reviewed")) errors.push(`${role} review is missing`);
  }
  if (!record(value.defaults)) errors.push("defaults must be an object");
  const production = Array.isArray(value.productionLabels) ? value.productionLabels : [];
  if (production.length !== 18) errors.push("productionLabels must cover 18 scenario families");
  const scenarioIds = new Set<string>();
  for (const [index, item] of production.entries()) {
    const label = record(item);
    if (!label) { errors.push(`productionLabels[${index}] must be an object`); continue; }
    exact(label, ["scenarioId", "repeats", "riskLane", "acceptableRoutes", "prohibitedProperties"], `productionLabels[${index}]`, errors);
    if (typeof label.scenarioId !== "string" || !HASH.test(label.scenarioId) || scenarioIds.has(label.scenarioId)) errors.push(`productionLabels[${index}].scenarioId is invalid or duplicate`);
    else scenarioIds.add(label.scenarioId);
    if (JSON.stringify(label.repeats) !== "[1,2,3]") errors.push(`productionLabels[${index}].repeats must be [1,2,3]`);
    if (!RISK_LANES.has(label.riskLane as RiskLane)) errors.push(`productionLabels[${index}].riskLane is invalid`);
    validateLabel(label, `productionLabels[${index}]`, errors);
  }
  const adversarial = Array.isArray(value.adversarialCases) ? value.adversarialCases : [];
  if (adversarial.length < 24) errors.push("adversarialCases must contain at least 24 cases");
  const caseIds = new Set<string>();
  for (const [index, item] of adversarial.entries()) {
    const label = record(item);
    if (!label) { errors.push(`adversarialCases[${index}] must be an object`); continue; }
    exact(label, ["id", "category", "request", "overrides", "riskLane", "acceptableRoutes", "prohibitedProperties"], `adversarialCases[${index}]`, errors);
    if (typeof label.id !== "string" || !HASH.test(label.id) || caseIds.has(label.id)) errors.push(`adversarialCases[${index}].id is invalid or duplicate`);
    else caseIds.add(label.id);
    if (typeof label.category !== "string" || !HASH.test(label.category) || typeof label.request !== "string" || !label.request.trim()) errors.push(`adversarialCases[${index}] category/request is invalid`);
    if (!record(label.overrides) || !RISK_LANES.has(label.riskLane as RiskLane)) errors.push(`adversarialCases[${index}] overrides/riskLane is invalid`);
    validateLabel(label, `adversarialCases[${index}]`, errors);
  }
  const routes = new Set([...production, ...adversarial].flatMap((item) => record(item)?.acceptableRoutes as SolverRoute[] ?? []));
  for (const route of SOLVER_ROUTES) if (!routes.has(route)) errors.push(`route coverage missing: ${route}`);
  const lanes = new Set([...production, ...adversarial].map((item) => record(item)?.riskLane));
  for (const lane of RISK_LANES) if (!lanes.has(lane)) errors.push(`risk lane coverage missing: ${lane}`);
  return errors;
}

export function validateSolverRouteCorpus(input: unknown): SolverRouteCorpus {
  const errors = solverRouteCorpusValidationErrors(input);
  if (errors.length > 0) throw new Error(`solver route corpus: ${errors.join("; ")}`);
  return input as SolverRouteCorpus;
}

export function controlledCaseInput(corpus: SolverRouteCorpus, item: SolverRouteCorpus["adversarialCases"][number]): TaskFeatureInput {
  return { ...structuredClone(corpus.defaults), ...structuredClone(item.overrides), request: item.request, riskLane: item.riskLane };
}

function validateDecision(input: SolverDecision): SolverDecision {
  if (!input || !SOLVER_ROUTES.includes(input.route) || !Array.isArray(input.plannedPhases)
    || !Array.isArray(input.toolGroups) || !Array.isArray(input.reasonCodes)
    || !input.parentModel || typeof input.parentModel.enforced !== "boolean") throw new Error("solver decision projection is invalid");
  return input;
}

export function observedSolverProperties(decisionInput: SolverDecision): SolverProhibitedProperty[] {
  const decision = validateDecision(decisionInput);
  const observed: SolverProhibitedProperty[] = [];
  if (decision.plannedPhases.includes("implement") || decision.toolGroups.includes("task")) observed.push("mutation-recommendation");
  if (decision.route !== "blocked-preflight") observed.push("unblocked-preflight");
  if (!["plan", "verify", "review"].every((phase) => decision.plannedPhases.includes(phase))) observed.push("missing-plan-verify-review");
  if (decision.parentModel.enforced) observed.push("parent-model-enforced");
  if (decision.reasonCodes.length === 0) observed.push("empty-reason-codes");
  return observed;
}

export function gradeSolverRoute(decisionInput: SolverDecision, label: SolverRouteLabel): {
  passed: boolean;
  routeAccepted: boolean;
  invariantViolations: SolverProhibitedProperty[];
} {
  const decision = validateDecision(decisionInput);
  const observed = new Set(observedSolverProperties(decision));
  const invariantViolations = label.prohibitedProperties.filter((property) => observed.has(property));
  const routeAccepted = label.acceptableRoutes.includes(decision.route);
  return { passed: routeAccepted && invariantViolations.length === 0, routeAccepted, invariantViolations };
}

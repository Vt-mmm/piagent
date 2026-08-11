type ParentRoutingMode = "off" | "shadow" | "recommend" | "auto";
type RoutingObjective = "intelligence" | "balance" | "cost";
type ModelSelectionSource = "explicit-user-pin" | "workspace-default" | "global-default" | "router-selected" | "unknown";
type ModelRouteHostBoundary = "unavailable" | "prelaunch";
export type CapabilityBand = "low" | "medium" | "high" | "ultra";
type TaskFeatureInput = { request: string; [field: string]: unknown };
export type ModelRouteDecisionProjection = {
  capabilityBand: CapabilityBand | "abstain";
  safetyFloor: CapabilityBand;
  disposition: "preserved" | "shadowed" | "recommended" | "selected" | "unavailable" | "abstained";
  selectionSource: ModelSelectionSource;
  provider: string | null;
  modelId: string | null;
  effort: string | null;
  currentModelId: string | null;
  currentEffort: string | null;
  enforced: boolean;
};

export type CorpusVariant = { id: string; mode: ParentRoutingMode; objective: RoutingObjective; selectionSource: ModelSelectionSource; catalog: "full" | "target-missing" | "offline" | "reordered"; freshTaskBoundary: boolean; hostBoundary: ModelRouteHostBoundary };
export type CorpusTemplate = { id: string; family: string; split: "train" | "validation" | "holdout"; locale: "en" | "vi"; request: string; overrides: Partial<TaskFeatureInput>; minimumFloor: CapabilityBand; blocked: boolean };
export type ModelRouteCorpus = { schemaVersion: 1; id: string; policyVersion: "model-route-v1"; mappingVersion: "openai-codex-model-route-map-v1"; reviews: Array<{ ownerRole: "Product" | "Safety"; status: "local-autopilot-reviewed"; reviewedAt: string }>; defaults: Omit<TaskFeatureInput, "request">; variants: CorpusVariant[]; templates: CorpusTemplate[] };

const BAND_INDEX = new Map<CapabilityBand, number>([["low", 0], ["medium", 1], ["high", 2], ["ultra", 3]]);
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function exact(value: Record<string, unknown>, fields: string[], label: string, errors: string[]): void {
  for (const field of Object.keys(value)) if (!fields.includes(field)) errors.push(`${label} has unknown field: ${field}`);
  for (const field of fields) if (!(field in value)) errors.push(`${label} missing field: ${field}`);
}

export function modelRouteCorpusValidationErrors(input: unknown): string[] {
  const value = record(input); if (!value) return ["model route corpus must be an object"];
  const errors: string[] = [];
  exact(value, ["schemaVersion", "id", "policyVersion", "mappingVersion", "reviews", "defaults", "variants", "templates"], "corpus", errors);
  if (value.schemaVersion !== 1 || value.policyVersion !== "model-route-v1" || value.mappingVersion !== "openai-codex-model-route-map-v1" || typeof value.id !== "string" || !ID.test(value.id)) errors.push("corpus identity is invalid");
  const reviews = Array.isArray(value.reviews) ? value.reviews : [];
  for (const role of ["Product", "Safety"]) if (!reviews.some((item) => record(item)?.ownerRole === role && record(item)?.status === "local-autopilot-reviewed")) errors.push(`${role} review is missing`);
  if (!record(value.defaults)) errors.push("defaults must be an object");
  const variants = Array.isArray(value.variants) ? value.variants : [];
  if (variants.length !== 10) errors.push("variants must contain exactly 10 policy/catalog cases");
  const variantIds = new Set<string>();
  for (const [index, raw] of variants.entries()) {
    const item = record(raw); if (!item) { errors.push(`variants[${index}] must be an object`); continue; }
    exact(item, ["id", "mode", "objective", "selectionSource", "catalog", "freshTaskBoundary", "hostBoundary"], `variants[${index}]`, errors);
    if (typeof item.id !== "string" || !ID.test(item.id) || variantIds.has(item.id)) errors.push(`variants[${index}].id is invalid or duplicate`); else variantIds.add(item.id);
    if (!["off", "shadow", "recommend", "auto"].includes(String(item.mode)) || !["intelligence", "balance", "cost"].includes(String(item.objective))) errors.push(`variants[${index}] mode/objective is invalid`);
    if (!["explicit-user-pin", "workspace-default", "global-default", "router-selected", "unknown"].includes(String(item.selectionSource))) errors.push(`variants[${index}] selectionSource is invalid`);
    if (!["full", "target-missing", "offline", "reordered"].includes(String(item.catalog)) || !["unavailable", "prelaunch"].includes(String(item.hostBoundary)) || typeof item.freshTaskBoundary !== "boolean") errors.push(`variants[${index}] catalog/boundary is invalid`);
  }
  const templates = Array.isArray(value.templates) ? value.templates : [];
  if (templates.length !== 24) errors.push("templates must contain exactly 24 task families");
  const templateIds = new Set<string>(), families = new Map<string, number>(); let vietnamese = 0;
  for (const [index, raw] of templates.entries()) {
    const item = record(raw); if (!item) { errors.push(`templates[${index}] must be an object`); continue; }
    exact(item, ["id", "family", "split", "locale", "request", "overrides", "minimumFloor", "blocked"], `templates[${index}]`, errors);
    if (typeof item.id !== "string" || !ID.test(item.id) || templateIds.has(item.id)) errors.push(`templates[${index}].id is invalid or duplicate`); else templateIds.add(item.id);
    if (typeof item.family !== "string" || !ID.test(item.family)) errors.push(`templates[${index}].family is invalid`); else families.set(item.family, (families.get(item.family) ?? 0) + 1);
    if (!["train", "validation", "holdout"].includes(String(item.split)) || !["en", "vi"].includes(String(item.locale))) errors.push(`templates[${index}] split/locale is invalid`);
    if (item.locale === "vi") vietnamese += 1;
    if (typeof item.request !== "string" || item.request.trim().length < 8 || !record(item.overrides)) errors.push(`templates[${index}] request/overrides is invalid`);
    if (!["low", "medium", "high", "ultra"].includes(String(item.minimumFloor)) || typeof item.blocked !== "boolean") errors.push(`templates[${index}] label is invalid`);
  }
  if (vietnamese < 6) errors.push("corpus must contain at least six Vietnamese templates");
  if (templates.length * variants.length < 240) errors.push("expanded corpus must contain at least 240 labeled cases");
  for (const split of ["train", "validation", "holdout"]) if (!templates.some((item) => record(item)?.split === split)) errors.push(`split coverage missing: ${split}`);
  return errors;
}

export function validateModelRouteCorpus(input: unknown): ModelRouteCorpus {
  const errors = modelRouteCorpusValidationErrors(input);
  if (errors.length > 0) throw new Error(`model route corpus: ${errors.join("; ")}`);
  return input as ModelRouteCorpus;
}

export function gradeModelRouteDecision(decision: ModelRouteDecisionProjection, template: CorpusTemplate, variant: CorpusVariant): string[] {
  const result: string[] = [];
  const actualFloor = BAND_INDEX.get(decision.safetyFloor) ?? -1, expectedFloor = BAND_INDEX.get(template.minimumFloor) ?? 99;
  if (actualFloor < expectedFloor) result.push("safety-floor-below-label");
  if (decision.capabilityBand !== "abstain" && (BAND_INDEX.get(decision.capabilityBand) ?? -1) < expectedFloor) result.push("capability-below-label");
  if ((template.minimumFloor === "high" || template.minimumFloor === "ultra") && decision.capabilityBand === "low") result.push("high-risk-false-low");
  if (variant.selectionSource === "explicit-user-pin" && (decision.enforced || decision.disposition !== "preserved" || decision.currentModelId !== decision.modelId || decision.currentEffort !== decision.effort)) result.push("explicit-pin-violation");
  if (variant.selectionSource === "unknown" && decision.enforced) result.push("unknown-provenance-enforced");
  if ((variant.catalog === "target-missing" || variant.catalog === "offline") && !template.blocked && variant.selectionSource !== "explicit-user-pin" && decision.disposition !== "unavailable") result.push("catalog-unavailable-not-reported");
  if (decision.disposition === "unavailable" && (decision.provider !== null || decision.modelId !== null || decision.effort !== null)) result.push("silent-substitution");
  if (template.blocked && decision.enforced) result.push("blocked-task-enforced");
  if (variant.id === "auto-prelaunch" && !template.blocked && decision.disposition !== "selected") result.push("prelaunch-auto-not-selected");
  if (variant.hostBoundary === "unavailable" && decision.enforced) result.push("unsupported-host-enforced");
  return result;
}

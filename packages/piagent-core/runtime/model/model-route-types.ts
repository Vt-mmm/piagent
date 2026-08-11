import crypto from "node:crypto";

import type { AuthenticatedModelCatalog } from "./authenticated-catalog.ts";

export const MODEL_ROUTE_DECISION_SCHEMA_VERSION = 1 as const;
export const MODEL_ROUTE_POLICY_VERSION = "model-route-v1" as const;
export const OPENAI_CODEX_MODEL_ROUTE_MAPPING_VERSION = "openai-codex-model-route-map-v1" as const;

export const PARENT_ROUTING_MODES = Object.freeze(["off", "shadow", "recommend", "auto"] as const);
export const ROUTING_OBJECTIVES = Object.freeze(["intelligence", "balance", "cost"] as const);
export const CAPABILITY_BANDS = Object.freeze(["low", "medium", "high", "ultra"] as const);
export const MODEL_SELECTION_SOURCES = Object.freeze([
  "explicit-user-pin",
  "workspace-default",
  "global-default",
  "router-selected",
  "unknown"
] as const);

export type ParentRoutingMode = typeof PARENT_ROUTING_MODES[number];
export type RoutingObjective = typeof ROUTING_OBJECTIVES[number];
export type CapabilityBand = typeof CAPABILITY_BANDS[number];
export type ModelSelectionSource = typeof MODEL_SELECTION_SOURCES[number];
export type ModelRouteDisposition = "preserved" | "shadowed" | "recommended" | "selected" | "unavailable" | "abstained";

export type ModelRouteDecision = {
  schemaVersion: typeof MODEL_ROUTE_DECISION_SCHEMA_VERSION;
  policyVersion: typeof MODEL_ROUTE_POLICY_VERSION;
  mappingVersion: typeof OPENAI_CODEX_MODEL_ROUTE_MAPPING_VERSION;
  featureHash: string;
  mode: ParentRoutingMode;
  objective: RoutingObjective;
  capabilityBand: CapabilityBand | "abstain";
  safetyFloor: CapabilityBand;
  fallbackBand: CapabilityBand | null;
  provider: string | null;
  modelId: string | null;
  effort: string | null;
  currentProvider: string | null;
  currentModelId: string | null;
  currentEffort: string | null;
  selectionSource: ModelSelectionSource;
  confidence: "low" | "medium" | "high";
  disposition: ModelRouteDisposition;
  reasonCodes: string[];
  downgradeSteps: number;
  catalogDigest: string;
  decisionDigest: string;
  enforced: boolean;
};

const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
const DECISION_FIELDS = new Set([
  "schemaVersion", "policyVersion", "mappingVersion", "featureHash", "mode", "objective",
  "capabilityBand", "safetyFloor", "fallbackBand", "provider", "modelId", "effort",
  "currentProvider", "currentModelId", "currentEffort", "selectionSource", "confidence",
  "disposition", "reasonCodes", "downgradeSteps", "catalogDigest", "decisionDigest", "enforced"
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nullableName(value: unknown): boolean {
  return value === null || (typeof value === "string" && NAME.test(value));
}

function digestPayload(input: Omit<ModelRouteDecision, "decisionDigest">): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function authenticatedCatalogDigest(catalog: AuthenticatedModelCatalog): string {
  const stable = {
    schemaVersion: catalog.schemaVersion,
    source: catalog.source,
    availability: catalog.availability,
    models: catalog.models.map((model) => ({
      provider: model.provider,
      modelId: model.modelId,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      imageInput: model.imageInput,
      supportedThinkingLevels: model.supportedThinkingLevels === null ? null : [...model.supportedThinkingLevels].sort()
    })).sort((left, right) => `${left.provider}/${left.modelId}`.localeCompare(`${right.provider}/${right.modelId}`))
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function createModelRouteDecision(
  input: Omit<ModelRouteDecision, "schemaVersion" | "policyVersion" | "mappingVersion" | "decisionDigest">
): ModelRouteDecision {
  const payload = {
    schemaVersion: MODEL_ROUTE_DECISION_SCHEMA_VERSION,
    policyVersion: MODEL_ROUTE_POLICY_VERSION,
    mappingVersion: OPENAI_CODEX_MODEL_ROUTE_MAPPING_VERSION,
    ...structuredClone(input)
  } satisfies Omit<ModelRouteDecision, "decisionDigest">;
  return validateModelRouteDecision({ ...payload, decisionDigest: digestPayload(payload) });
}

export function modelRouteDecisionValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["model route decision must be an object"];
  const errors = [
    ...Object.keys(value).filter((field) => !DECISION_FIELDS.has(field)).map((field) => `model route decision has unknown field: ${field}`),
    ...[...DECISION_FIELDS].filter((field) => !(field in value)).map((field) => `model route decision missing field: ${field}`)
  ];
  if (value.schemaVersion !== MODEL_ROUTE_DECISION_SCHEMA_VERSION
    || value.policyVersion !== MODEL_ROUTE_POLICY_VERSION
    || value.mappingVersion !== OPENAI_CODEX_MODEL_ROUTE_MAPPING_VERSION) errors.push("model route schema/policy/mapping version is invalid");
  if (typeof value.featureHash !== "string" || !HASH.test(value.featureHash)) errors.push("featureHash must be sha256 hex");
  if (!PARENT_ROUTING_MODES.includes(value.mode as ParentRoutingMode)) errors.push("mode is invalid");
  if (!ROUTING_OBJECTIVES.includes(value.objective as RoutingObjective)) errors.push("objective is invalid");
  if (![...CAPABILITY_BANDS, "abstain"].includes(value.capabilityBand as never)) errors.push("capabilityBand is invalid");
  if (!CAPABILITY_BANDS.includes(value.safetyFloor as CapabilityBand)) errors.push("safetyFloor is invalid");
  if (value.fallbackBand !== null && !CAPABILITY_BANDS.includes(value.fallbackBand as CapabilityBand)) errors.push("fallbackBand is invalid");
  for (const field of ["provider", "modelId", "effort", "currentProvider", "currentModelId", "currentEffort"] as const) {
    if (!nullableName(value[field])) errors.push(`${field} is invalid`);
  }
  if (!MODEL_SELECTION_SOURCES.includes(value.selectionSource as ModelSelectionSource)) errors.push("selectionSource is invalid");
  if (!["low", "medium", "high"].includes(String(value.confidence))) errors.push("confidence is invalid");
  if (!["preserved", "shadowed", "recommended", "selected", "unavailable", "abstained"].includes(String(value.disposition))) errors.push("disposition is invalid");
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length < 1 || value.reasonCodes.length > 32
    || value.reasonCodes.some((reason) => typeof reason !== "string" || !NAME.test(reason))
    || new Set(value.reasonCodes).size !== value.reasonCodes.length) errors.push("reasonCodes are invalid");
  if (!Number.isInteger(value.downgradeSteps) || Number(value.downgradeSteps) < 0 || Number(value.downgradeSteps) > 3) errors.push("downgradeSteps is invalid");
  for (const field of ["catalogDigest", "decisionDigest"] as const) {
    if (typeof value[field] !== "string" || !HASH.test(value[field] as string)) errors.push(`${field} must be sha256 hex`);
  }
  if (typeof value.enforced !== "boolean") errors.push("enforced must be boolean");
  if (value.enforced && (value.mode !== "auto" || value.disposition !== "selected")) errors.push("only an auto selected decision may be enforced");
  if (value.selectionSource === "explicit-user-pin" && value.enforced) errors.push("an explicit user pin cannot be overridden");
  if (value.selectionSource === "unknown" && value.enforced) errors.push("unknown selection provenance cannot authorize routing");
  if (value.capabilityBand === "abstain" && value.enforced) errors.push("an abstention cannot be enforced");
  if (value.disposition === "unavailable" && (value.provider !== null || value.modelId !== null || value.effort !== null)) errors.push("an unavailable decision cannot name a substitute");
  if (errors.length === 0) {
    const { decisionDigest, ...payload } = value as unknown as ModelRouteDecision;
    if (digestPayload(payload) !== decisionDigest) errors.push("decisionDigest does not match decision payload");
  }
  return errors;
}

export function validateModelRouteDecision(input: unknown, source = "model route decision"): ModelRouteDecision {
  const errors = modelRouteDecisionValidationErrors(input);
  if (errors.length > 0) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as ModelRouteDecision;
}

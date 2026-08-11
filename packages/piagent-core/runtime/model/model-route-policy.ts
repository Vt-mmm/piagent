import type { AuthenticatedModelCatalog, AuthenticatedModelCatalogEntry } from "./authenticated-catalog.ts";
import type { TaskFeatures } from "../solver/solver-types.ts";
import {
  authenticatedCatalogDigest,
  CAPABILITY_BANDS,
  createModelRouteDecision,
  type CapabilityBand,
  type ModelRouteDecision,
  type ModelSelectionSource,
  type ParentRoutingMode,
  type RoutingObjective
} from "./model-route-types.ts";

export type ModelRouteHostBoundary = "unavailable" | "prelaunch";

export type ModelRoutePolicyInput = {
  features: TaskFeatures;
  catalog: AuthenticatedModelCatalog;
  mode: ParentRoutingMode;
  objective: RoutingObjective;
  selectionSource: ModelSelectionSource;
  current: { provider: string | null; modelId: string | null; effort: string | null };
  freshTaskBoundary: boolean;
  hostBoundary: ModelRouteHostBoundary;
};

type Candidate = { provider: "openai-codex"; modelId: string; effort: string };

const BAND_CANDIDATES: Record<CapabilityBand, Candidate[]> = {
  low: [{ provider: "openai-codex", modelId: "gpt-5.6-luna", effort: "medium" }],
  medium: [{ provider: "openai-codex", modelId: "gpt-5.6-terra", effort: "medium" }],
  high: [{ provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" }],
  ultra: [{ provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "xhigh" }]
};
const BAND_INDEX = new Map(CAPABILITY_BANDS.map((band, index) => [band, index]));

function exactCandidate(catalog: AuthenticatedModelCatalog, band: CapabilityBand): { model: AuthenticatedModelCatalogEntry; effort: string } | undefined {
  for (const candidate of BAND_CANDIDATES[band]) {
    const model = catalog.models.find((entry) => entry.provider === candidate.provider
      && entry.modelId === candidate.modelId
      && (entry.supportedThinkingLevels === null || entry.supportedThinkingLevels.includes(candidate.effort)));
    if (model) return { model, effort: candidate.effort };
  }
  return undefined;
}

function currentBand(modelId: string | null): CapabilityBand | undefined {
  return modelId === "gpt-5.6-luna" ? "low"
    : modelId === "gpt-5.6-terra" ? "medium"
      : modelId === "gpt-5.6-sol" ? "high"
        : undefined;
}

function maxBand(left: CapabilityBand, right: CapabilityBand): CapabilityBand {
  return (BAND_INDEX.get(left) ?? 0) >= (BAND_INDEX.get(right) ?? 0) ? left : right;
}

function safetyFloor(features: TaskFeatures): { band: CapabilityBand; reasons: string[]; blocked: boolean } {
  const reasons: string[] = [];
  const authorization = features.protectedTarget || features.externalAction || features.destructiveAction || features.permissionExpansion;
  if (features.destructiveAction || features.permissionExpansion) return { band: "ultra", reasons: ["authorization-critical", "safety-floor-ultra"], blocked: true };
  if (features.changeMode === "source-change" && (features.gitReady === false || features.verifierReady === false)) {
    return { band: "high", reasons: [features.gitReady === false ? "git-not-ready" : "verifier-missing", "preflight-blocked"], blocked: true };
  }
  if (authorization) return { band: "high", reasons: ["authorization-required", "safety-floor-high"], blocked: true };
  if (features.scopeEstimate === "broad" && (features.riskLane === "high-risk" || features.ambiguity === "high")) {
    return { band: "ultra", reasons: ["broad-open-ended", "safety-floor-ultra"], blocked: false };
  }
  if (features.riskLane === "high-risk" || features.ambiguity === "high" || features.scopeEstimate === "broad") {
    return { band: "high", reasons: [features.riskLane === "high-risk" ? "high-risk-task" : features.ambiguity === "high" ? "high-ambiguity" : "broad-scope", "safety-floor-high"], blocked: false };
  }
  const lowEligible = features.workflowIntent !== "unknown"
    && features.changeMode !== "unknown"
    && features.ambiguity === "low"
    && (features.scopeEstimate === "tiny" || features.scopeEstimate === "bounded")
    && features.explicitPathCount > 0
    && features.riskLane !== "unknown"
    && features.runtimeCapabilitiesKnown
    && features.gitReady !== null
    && features.verifierReady !== null
    && (features.changeMode !== "source-change" || (features.gitReady === true && features.verifierReady === true))
    && (features.contextPressure === null || features.contextPressure < 0.72);
  if (lowEligible) return { band: "low", reasons: ["bounded-explicit-task", "cheap-verifier-ready", "safety-floor-low"], blocked: false };
  const mediumEligible = features.workflowIntent !== "unknown"
    && features.changeMode !== "unknown"
    && features.riskLane === "normal"
    && (features.scopeEstimate === "tiny" || features.scopeEstimate === "bounded")
    && features.runtimeCapabilitiesKnown;
  if (mediumEligible) return { band: "medium", reasons: ["normal-bounded-task", "safety-floor-medium"], blocked: false };
  reasons.push(!features.runtimeCapabilitiesKnown ? "runtime-capabilities-unknown" : "task-facts-incomplete", "safety-floor-high");
  return { band: "high", reasons, blocked: false };
}

function objectiveBand(floor: CapabilityBand, objective: RoutingObjective): CapabilityBand {
  if (objective === "intelligence" && floor === "low") return "medium";
  return floor;
}

function downgradeSteps(current: CapabilityBand | undefined, target: CapabilityBand): number {
  if (!current) return 0;
  return Math.max(0, (BAND_INDEX.get(current) ?? 0) - (BAND_INDEX.get(target) ?? 0));
}

export function routeParentModel(input: ModelRoutePolicyInput): ModelRouteDecision {
  const floor = safetyFloor(input.features);
  const desired = objectiveBand(floor.band, input.objective);
  const catalogDigest = authenticatedCatalogDigest(input.catalog);
  const common = {
    featureHash: input.features.featureHash,
    mode: input.mode,
    objective: input.objective,
    safetyFloor: floor.band,
    currentProvider: input.current.provider,
    currentModelId: input.current.modelId,
    currentEffort: input.current.effort,
    selectionSource: input.selectionSource,
    catalogDigest
  } as const;
  if (input.mode === "off") return createModelRouteDecision({
    ...common, capabilityBand: "abstain", fallbackBand: desired, provider: input.current.provider,
    modelId: input.current.modelId, effort: input.current.effort, confidence: "high", disposition: "preserved",
    reasonCodes: ["parent-routing-off"], downgradeSteps: 0, enforced: false
  });
  if (input.selectionSource === "explicit-user-pin") return createModelRouteDecision({
    ...common, capabilityBand: "abstain", fallbackBand: desired, provider: input.current.provider,
    modelId: input.current.modelId, effort: input.current.effort, confidence: "high", disposition: "preserved",
    reasonCodes: ["explicit-user-pin-preserved", ...floor.reasons], downgradeSteps: 0, enforced: false
  });
  if (floor.blocked) return createModelRouteDecision({
    ...common, capabilityBand: "abstain", fallbackBand: desired, provider: input.current.provider,
    modelId: input.current.modelId, effort: input.current.effort, confidence: "high", disposition: "abstained",
    reasonCodes: [...floor.reasons, "model-routing-cannot-bypass-preflight"], downgradeSteps: 0, enforced: false
  });
  if (input.catalog.availability !== "authenticated") return createModelRouteDecision({
    ...common, capabilityBand: "abstain", fallbackBand: desired, provider: null, modelId: null, effort: null,
    confidence: "low", disposition: "unavailable", reasonCodes: ["authenticated-catalog-unavailable", ...floor.reasons],
    downgradeSteps: 0, enforced: false
  });
  const candidate = exactCandidate(input.catalog, desired);
  if (!candidate) return createModelRouteDecision({
    ...common, capabilityBand: "abstain", fallbackBand: desired, provider: null, modelId: null, effort: null,
    confidence: "low", disposition: "unavailable", reasonCodes: ["preferred-model-or-effort-unavailable", "no-silent-substitution", ...floor.reasons],
    downgradeSteps: 0, enforced: false
  });
  const reasons = [...floor.reasons, `objective-${input.objective}`, `candidate-${desired}`, "runtime-catalog-match"];
  const steps = downgradeSteps(currentBand(input.current.modelId), desired);
  if (input.mode === "shadow") return createModelRouteDecision({
    ...common, capabilityBand: desired, fallbackBand: null, provider: candidate.model.provider, modelId: candidate.model.modelId,
    effort: candidate.effort, confidence: floor.band === "low" || floor.band === "ultra" ? "high" : "medium",
    disposition: "shadowed", reasonCodes: reasons, downgradeSteps: steps, enforced: false
  });
  const autoAuthorized = input.mode === "auto"
    && input.selectionSource !== "unknown"
    && input.freshTaskBoundary
    && input.hostBoundary === "prelaunch";
  if (autoAuthorized) return createModelRouteDecision({
    ...common, capabilityBand: desired, fallbackBand: null, provider: candidate.model.provider, modelId: candidate.model.modelId,
    effort: candidate.effort, confidence: floor.band === "low" || floor.band === "ultra" ? "high" : "medium",
    disposition: "selected", reasonCodes: [...reasons, "prelaunch-task-boundary"], downgradeSteps: steps, enforced: true
  });
  const failClosed = input.mode === "auto"
    ? [input.selectionSource === "unknown" ? "selection-provenance-unknown" : "", !input.freshTaskBoundary ? "not-fresh-task-boundary" : "", input.hostBoundary !== "prelaunch" ? "safe-host-adapter-unavailable" : ""].filter(Boolean)
    : [];
  return createModelRouteDecision({
    ...common, capabilityBand: desired, fallbackBand: null, provider: candidate.model.provider, modelId: candidate.model.modelId,
    effort: candidate.effort, confidence: floor.band === "low" || floor.band === "ultra" ? "high" : "medium",
    disposition: "recommended", reasonCodes: [...reasons, ...failClosed], downgradeSteps: steps, enforced: false
  });
}

export function parentRoutingModeFromEnvironment(value: unknown): ParentRoutingMode {
  const normalized = String(value ?? "off").trim().toLowerCase();
  return ["shadow", "recommend", "auto"].includes(normalized) ? normalized as ParentRoutingMode : "off";
}

export function routingObjectiveFromEnvironment(value: unknown): RoutingObjective {
  const normalized = String(value ?? "balance").trim().toLowerCase();
  return ["intelligence", "cost"].includes(normalized) ? normalized as RoutingObjective : "balance";
}

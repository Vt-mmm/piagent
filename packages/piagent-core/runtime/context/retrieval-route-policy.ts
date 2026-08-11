import crypto from "node:crypto";

import type { TaskFeatures } from "../solver/solver-types.ts";

export const RETRIEVAL_ROUTE_POLICY_VERSION = "retrieval-route-v1" as const;
export const RETRIEVAL_ROUTE_CEILINGS = Object.freeze({ maxParallel: 2, maxRounds: 2 });

export type RetrievalConfidence = "none" | "low" | "medium" | "high" | "unknown";
export type RetrievalRoutePlan = {
  schemaVersion: 1;
  policyVersion: typeof RETRIEVAL_ROUTE_POLICY_VERSION;
  featureHash: string;
  activation: "skip" | "local-direct" | "specialist-recommended";
  specialistRole: "retriever" | null;
  tools: Array<"grep" | "find" | "read">;
  maxParallel: number;
  maxRounds: number;
  budgetBand: "none" | "small" | "medium" | "large";
  confidenceFloor: "medium" | "high";
  reasonCodes: string[];
  automaticDispatch: false;
  planDigest: string;
};

export type RetrievalRouteInput = {
  features: TaskFeatures;
  indexReady: boolean;
  observedConfidence?: RetrievalConfidence;
  helpersMode?: "off" | "recommend" | "on";
};

function digest(input: Omit<RetrievalRoutePlan, "planDigest">): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function plan(input: Omit<RetrievalRoutePlan, "schemaVersion" | "policyVersion" | "planDigest">): RetrievalRoutePlan {
  const payload = { schemaVersion: 1 as const, policyVersion: RETRIEVAL_ROUTE_POLICY_VERSION, ...input };
  return { ...payload, planDigest: digest(payload) };
}

export function planRetrievalRoute(input: RetrievalRouteInput): RetrievalRoutePlan {
  const features = input.features;
  if (features.protectedTarget || features.externalAction || features.destructiveAction || features.permissionExpansion) {
    return plan({ featureHash: features.featureHash, activation: "skip", specialistRole: null, tools: [], maxParallel: 0, maxRounds: 0, budgetBand: "none", confidenceFloor: "high", reasonCodes: ["authorization-boundary", "retrieval-cannot-widen-access"], automaticDispatch: false });
  }
  const confidence = input.observedConfidence ?? "unknown";
  const explicitNarrow = features.explicitPathCount > 0
    && features.scopeEstimate !== "broad"
    && features.ambiguity === "low"
    && confidence !== "low"
    && confidence !== "none";
  if (explicitNarrow) {
    return plan({ featureHash: features.featureHash, activation: "local-direct", specialistRole: null, tools: ["grep", "read"], maxParallel: 1, maxRounds: 1, budgetBand: "small", confidenceFloor: "medium", reasonCodes: ["explicit-path", "bounded-local-retrieval"], automaticDispatch: false });
  }
  const specialistUseful = !input.indexReady
    || confidence === "none"
    || confidence === "low"
    || features.scopeEstimate === "broad"
    || features.ambiguity === "high"
    || features.contextPressure !== null && features.contextPressure >= 0.72;
  if (specialistUseful && input.helpersMode !== "off") {
    const broad = features.scopeEstimate === "broad" || features.ambiguity === "high";
    const reasonCodes = [
      !input.indexReady ? "local-index-unavailable" : "",
      confidence === "none" || confidence === "low" ? "low-retrieval-confidence" : "",
      broad ? "multi-region-search" : "",
      features.contextPressure !== null && features.contextPressure >= 0.72 ? "protect-parent-context" : "",
      "read-only-specialist-recommended",
      "bounded-parallel-search"
    ].filter(Boolean);
    return plan({ featureHash: features.featureHash, activation: "specialist-recommended", specialistRole: "retriever", tools: ["grep", "find", "read"], maxParallel: RETRIEVAL_ROUTE_CEILINGS.maxParallel, maxRounds: broad ? RETRIEVAL_ROUTE_CEILINGS.maxRounds : 1, budgetBand: broad ? "large" : "medium", confidenceFloor: broad ? "high" : "medium", reasonCodes, automaticDispatch: false });
  }
  return plan({ featureHash: features.featureHash, activation: "local-direct", specialistRole: null, tools: ["grep", "find", "read"], maxParallel: RETRIEVAL_ROUTE_CEILINGS.maxParallel, maxRounds: RETRIEVAL_ROUTE_CEILINGS.maxRounds, budgetBand: "medium", confidenceFloor: "medium", reasonCodes: [input.helpersMode === "off" ? "helpers-off" : "local-index-ready", "bounded-local-retrieval"], automaticDispatch: false });
}

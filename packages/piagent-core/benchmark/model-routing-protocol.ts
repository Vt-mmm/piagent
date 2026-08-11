import crypto from "node:crypto";

import { validateModelRouteCorpus, type ModelRouteCorpus } from "./model-route-grader.ts";

export const MODEL_ROUTING_PROTOCOL_VERSION = "adaptive-routing-protocol-v1" as const;

type ProtocolArm = "static-ceiling" | "adaptive";
export type ModelRoutingRouteProjection = {
  taskId: string;
  promptHash: string;
  featureHash: string;
  decisionDigest: string;
  capabilityBand: "low" | "medium" | "high" | "ultra" | "abstain";
  enforced: boolean;
  provider: string | null;
  modelId: string | null;
  effort: string | null;
};
export type ModelRoutingProtocolSession = {
  sessionKey: string;
  pairKey: string;
  taskId: string;
  family: string;
  split: string;
  repeat: number;
  pairOrder: 1 | 2;
  arm: ProtocolArm;
  promptHash: string;
  featureHash: string;
  provider: string;
  modelId: string;
  effort: string;
  routeDecisionDigest: string | null;
  capabilityBand: string;
  selectionSource: "static-ceiling" | "workspace-default";
};

export type ModelRoutingProtocolManifest = {
  schemaVersion: 1;
  protocolVersion: typeof MODEL_ROUTING_PROTOCOL_VERSION;
  protocol: "adaptive-routing-causal";
  sameModelEvidence: false;
  suiteId: "model-routing-v1";
  policyVersion: "model-route-v1";
  mappingVersion: "openai-codex-model-route-map-v1";
  repositoryRevision: string;
  treatment: "candidate";
  seed: string;
  repeats: 3;
  arms: ["static-ceiling", "adaptive"];
  staticCeiling: { provider: "openai-codex"; modelId: "gpt-5.6-sol"; effort: "high" };
  catalogDigest: string;
  sessions: ModelRoutingProtocolSession[];
  sessionCount: 144;
  manifestDigest: string;
  execution: { authorized: false; status: "planned-not-authorized"; allAttemptUsageRequired: true; exactCostPolicy: "exact-or-unavailable" };
};

function sha(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function deterministicBit(seed: string, pairKey: string): boolean { return parseInt(sha(`${seed}\u0000${pairKey}`).slice(0, 8), 16) % 2 === 0; }

function manifestDigest(input: Omit<ModelRoutingProtocolManifest, "manifestDigest">): string {
  return sha(JSON.stringify(input));
}

export function buildModelRoutingProtocol(input: {
  corpus: ModelRouteCorpus | unknown;
  routes: Record<string, ModelRoutingRouteProjection>;
  catalogDigest: string;
  repositoryRevision: string;
  seed: string;
}): ModelRoutingProtocolManifest {
  const corpus = validateModelRouteCorpus(input.corpus);
  if (!/^[a-f0-9]{7,64}$/i.test(input.repositoryRevision)) throw new Error("repositoryRevision must be a commit-like hex identity");
  if (!input.seed.trim() || input.seed.length > 200) throw new Error("seed must be bounded and non-empty");
  if (!/^[a-f0-9]{64}$/.test(input.catalogDigest)) throw new Error("catalogDigest must be sha256 hex");
  const sessions: ModelRoutingProtocolSession[] = [];
  for (const task of corpus.templates) {
    const route = input.routes[task.id];
    if (!route || route.taskId !== task.id) throw new Error(`route projection missing for ${task.id}`);
    if (route.promptHash !== sha(task.request)) throw new Error(`route projection prompt changed for ${task.id}`);
    if (![route.promptHash, route.featureHash, route.decisionDigest].every((value) => /^[a-f0-9]{64}$/.test(value))) {
      throw new Error(`route projection digest is invalid for ${task.id}`);
    }
    const adaptive = route.enforced
      ? { provider: route.provider, modelId: route.modelId, effort: route.effort }
      : { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" };
    if (!adaptive.provider || !adaptive.modelId || !adaptive.effort) throw new Error(`route ${task.id} has no executable target or preserved ceiling`);
    for (const repeat of [1, 2, 3]) {
      const pairKey = `${task.id}:r${repeat}`;
      const adaptiveFirst = deterministicBit(input.seed, pairKey);
      for (const arm of ["static-ceiling", "adaptive"] as const) {
        const selected = arm === "static-ceiling" ? { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" } : adaptive;
        const pairOrder = (adaptiveFirst ? arm === "adaptive" : arm === "static-ceiling") ? 1 : 2;
        sessions.push({
          sessionKey: sha(`${pairKey}\u0000${arm}`).slice(0, 24), pairKey, taskId: task.id, family: task.family,
          split: task.split, repeat, pairOrder, arm, promptHash: route.promptHash, featureHash: route.featureHash,
          provider: selected.provider, modelId: selected.modelId, effort: selected.effort,
          routeDecisionDigest: arm === "adaptive" ? route.decisionDigest : null,
          capabilityBand: arm === "adaptive" ? route.capabilityBand : "static-ceiling",
          selectionSource: arm === "adaptive" ? "workspace-default" : "static-ceiling"
        });
      }
    }
  }
  sessions.sort((left, right) => left.pairKey.localeCompare(right.pairKey) || left.pairOrder - right.pairOrder);
  if (sessions.length !== 144) throw new Error(`adaptive routing protocol requires 144 sessions, observed ${sessions.length}`);
  const payload = {
    schemaVersion: 1 as const,
    protocolVersion: MODEL_ROUTING_PROTOCOL_VERSION,
    protocol: "adaptive-routing-causal" as const,
    sameModelEvidence: false as const,
    suiteId: "model-routing-v1" as const,
    policyVersion: "model-route-v1" as const,
    mappingVersion: "openai-codex-model-route-map-v1" as const,
    repositoryRevision: input.repositoryRevision,
    treatment: "candidate" as const,
    seed: input.seed,
    repeats: 3 as const,
    arms: ["static-ceiling", "adaptive"] as ["static-ceiling", "adaptive"],
    staticCeiling: { provider: "openai-codex" as const, modelId: "gpt-5.6-sol" as const, effort: "high" as const },
    catalogDigest: input.catalogDigest,
    sessions,
    sessionCount: 144 as const,
    execution: { authorized: false as const, status: "planned-not-authorized" as const, allAttemptUsageRequired: true as const, exactCostPolicy: "exact-or-unavailable" as const }
  };
  return { ...payload, manifestDigest: manifestDigest(payload) };
}

export function validateModelRoutingProtocolResume(expected: ModelRoutingProtocolManifest, candidate: unknown): ModelRoutingProtocolManifest {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("routing resume manifest must be an object");
  const value = candidate as ModelRoutingProtocolManifest;
  if (value.manifestDigest !== expected.manifestDigest) throw new Error("routing resume manifest digest changed");
  const { manifestDigest: supplied, ...payload } = value;
  if (manifestDigest(payload) !== supplied) throw new Error("routing resume manifest payload does not match its digest");
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error("routing resume manifest is not byte-equivalent to the pinned protocol");
  return value;
}

export const ADAPTIVE_ROUTING_OUTCOME_GATES = Object.freeze({
  qualityMinimum: 9.5,
  safetyExact: 10,
  reliabilityMinimum: 9.5,
  workflowMinimum: 9.5,
  everyCategoryMinimum: 9.5,
  everyCapabilityBandMinimum: 9.5,
  everyTaskShapeMinimum: 9.5,
  everyOutcomeScoreMinimumExclusive: 9.5,
  downshiftRateMinimum: 0.30,
  routeRegretMaximum: 0.05,
  highRiskFalseLowMaximum: 0,
  freshTokenRatioUpper95MaximumExclusive: 1,
  exactCostRatioUpper95MaximumExclusive: 1,
  exactCostPolicy: "exact-or-unavailable"
});

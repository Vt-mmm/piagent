import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import { runtimeModelSnapshotDigest } from "../model/runtime-snapshot.ts";
import type { ModelRouteEvaluation } from "../model/model-route-runtime.ts";
import type { SolverShadowEvaluation } from "../solver/solver-shadow.ts";

export function runtimeSnapshotTelemetry(snapshot?: RuntimeModelSnapshot) {
  if (!snapshot) return undefined;
  return {
    schemaVersion: snapshot.schemaVersion,
    digest: runtimeModelSnapshotDigest(snapshot),
    provider: snapshot.provider,
    modelId: snapshot.modelId,
    contextWindow: snapshot.contextWindow,
    requestedThinkingLevel: snapshot.requestedThinkingLevel,
    effectiveThinkingLevel: snapshot.effectiveThinkingLevel,
    warningCount: snapshot.warnings.length
  };
}

export function solverShadowTelemetry(evaluation?: SolverShadowEvaluation) {
  if (evaluation?.status !== "ok") return evaluation;
  return {
    mode: evaluation.decision.mode,
    route: evaluation.decision.route,
    featureHash: evaluation.features.featureHash,
    reasonCodes: evaluation.decision.reasonCodes,
    confidence: evaluation.decision.confidence,
    reused: evaluation.reused,
    persisted: evaluation.persisted,
    durationMs: evaluation.durationMs,
    warnings: evaluation.warnings
  };
}

export function modelRouteTelemetry(evaluation?: ModelRouteEvaluation) {
  if (evaluation?.status !== "ok") return evaluation;
  return {
    mode: evaluation.decision.mode,
    objective: evaluation.decision.objective,
    capabilityBand: evaluation.decision.capabilityBand,
    safetyFloor: evaluation.decision.safetyFloor,
    disposition: evaluation.decision.disposition,
    selectionSource: evaluation.decision.selectionSource,
    provider: evaluation.decision.provider,
    modelId: evaluation.decision.modelId,
    effort: evaluation.decision.effort,
    downgradeSteps: evaluation.decision.downgradeSteps,
    enforced: evaluation.decision.enforced,
    decisionDigest: evaluation.decision.decisionDigest,
    reasonCodes: evaluation.decision.reasonCodes,
    reused: evaluation.reused,
    persisted: evaluation.persisted,
    durationMs: evaluation.durationMs,
    warnings: evaluation.warnings
  };
}

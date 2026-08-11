import type { SolverShadowEvaluation } from "./solver-shadow.ts";

export function solverPreflightProjection(evaluation: SolverShadowEvaluation): Record<string, unknown> {
  if (evaluation.status !== "ok") return {
    schemaVersion: 1,
    status: evaluation.status,
    durationMs: evaluation.durationMs,
    warnings: evaluation.status === "error" ? evaluation.warnings : []
  };
  const { features, decision } = evaluation;
  return {
    schemaVersion: 1,
    status: "ok",
    shadow: decision.mode === "shadow" ? "no behavior changed" : decision.mode,
    route: decision.route,
    reasonCodes: decision.reasonCodes,
    confidence: decision.confidence,
    plannedPhases: decision.plannedPhases,
    context: decision.context,
    toolGroups: decision.toolGroups,
    helper: decision.helper,
    parentModel: decision.parentModel,
    runtimeProvenance: {
      snapshotDigest: features.runtimeSnapshotDigest,
      capabilitiesKnown: features.runtimeCapabilitiesKnown
    },
    override: decision.override,
    featureHash: decision.featureHash,
    policyVersion: decision.policyVersion
  };
}

export function formatSolverPreflight(evaluation: SolverShadowEvaluation): string {
  const projection = solverPreflightProjection(evaluation);
  if (evaluation.status === "off") return "solver: off";
  if (evaluation.status === "error") return `solver: unavailable\nwarning: ${evaluation.warnings.join("; ")}`;
  const helper = evaluation.decision.helper.needed ? `${evaluation.decision.helper.role} (advisory)` : "none";
  const parent = [evaluation.decision.parentModel.provider, evaluation.decision.parentModel.modelId, evaluation.decision.parentModel.effort]
    .filter(Boolean).join("/") || "unknown";
  return [
    `route: ${projection.route}; confidence: ${projection.confidence}`,
    `reasons: ${evaluation.decision.reasonCodes.join(", ")}`,
    `phases: ${evaluation.decision.plannedPhases.join(" → ")}`,
    `tools: ${evaluation.decision.toolGroups.join(", ") || "none"}`,
    `context: ${evaluation.decision.context.recommendation}/${evaluation.decision.context.budgetBand}`,
    `helper: ${helper}; parent: ${parent} (advisory)`,
    `runtime: ${evaluation.features.runtimeSnapshotDigest ?? "unavailable"}; capabilities: ${evaluation.features.runtimeCapabilitiesKnown ? "known" : "unknown"}`,
    evaluation.decision.mode === "shadow" ? "shadow: no behavior changed" : `mode: ${evaluation.decision.mode}`
  ].join("\n");
}

import type { SolverDecision, SolverMode, SolverRoute, TaskFeatures } from "./solver-types.ts";
import { SOLVER_POLICY_VERSION, validateSolverDecision, validateTaskFeatures } from "./solver-types.ts";

function routeFor(features: TaskFeatures): { route: SolverRoute; reasons: string[] } {
  const authorizationRisk = features.protectedTarget || features.externalAction || features.destructiveAction || features.permissionExpansion;
  if (features.changeMode !== "plan-only" && features.changeMode !== "read-only" && authorizationRisk) return { route: "blocked-preflight", reasons: ["authorization-required"] };
  if (features.workflowIntent === "review") return { route: "review-only", reasons: ["explicit-review-intent"] };
  if (features.workflowIntent === "plan" || features.changeMode === "plan-only") return { route: "plan-first", reasons: ["explicit-plan-intent"] };
  if (features.changeMode === "read-only" || ["diagnose", "scout"].includes(features.workflowIntent)) return { route: "scout-first", reasons: ["explicit-read-only-intent"] };
  if (features.changeMode === "source-change" && features.gitReady === false) return { route: "blocked-preflight", reasons: ["git-not-ready"] };
  if (features.changeMode === "source-change" && features.verifierReady === false) return { route: "blocked-preflight", reasons: ["verifier-missing"] };
  if (features.riskLane === "high-risk") return { route: "plan-first", reasons: ["high-risk-source-work"] };
  if (features.ambiguity === "high") return { route: "scout-first", reasons: ["ambiguous-scope"] };
  if (features.scopeEstimate === "broad") return { route: "plan-first", reasons: ["broad-scope"] };
  if (features.contextPressure !== null && features.contextPressure >= 0.72) return { route: "scout-first", reasons: ["high-context-pressure"] };
  if (!features.profileMode || features.verifierReady === null || features.gitReady === null) return { route: "plan-first", reasons: ["readiness-unknown"] };
  return { route: "direct", reasons: [features.explicitPathCount > 0 ? "explicit-path" : "bounded-ready-task"] };
}

function phases(route: SolverRoute, features: TaskFeatures): SolverDecision["plannedPhases"] {
  if (route === "blocked-preflight") return ["intake", "handoff"];
  if (route === "review-only") return ["intake", "context", "review", "handoff"];
  if (features.changeMode === "plan-only") return ["intake", "context", "plan", "handoff"];
  if (route === "scout-first" && features.changeMode === "read-only") return ["intake", "context", "review", "handoff"];
  if (route === "scout-first") return ["intake", "context", "plan", "implement", "verify", "review"];
  if (route === "plan-first") return ["intake", "context", "plan", "implement", "verify", "review"];
  return ["intake", "context", "implement", "verify", "review"];
}

function toolGroups(route: SolverRoute, features: TaskFeatures): string[] {
  if (route === "blocked-preflight") return ["governance", "policy"];
  if (features.changeMode === "read-only" || features.changeMode === "plan-only" || route === "review-only") return ["governance", "retrieval", "knowledge"];
  return route === "direct" ? ["intake", "task"] : ["intake", "governance", "retrieval", "task"];
}

export function solveTaskFeatures(input: TaskFeatures, mode: Exclude<SolverMode, "off"> = "shadow"): SolverDecision {
  const features = validateTaskFeatures(input);
  const selected = routeFor(features);
  const helperRole = selected.route === "review-only" ? "reviewer" : selected.route === "scout-first" ? "scout" : selected.route === "plan-first" && features.scopeEstimate === "broad" ? "planner" : null;
  const contextRecommendation = selected.route === "blocked-preflight" ? "none" : features.explicitPathCount > 0 ? "targeted" : "bounded";
  const budgetBand = contextRecommendation === "none" ? "none" : features.contextPressure !== null && features.contextPressure >= 0.72 ? "small" : features.scopeEstimate === "broad" ? "large" : "medium";
  const reasons = [...selected.reasons];
  if (!features.runtimeCapabilitiesKnown) reasons.push("runtime-capabilities-unknown");
  if (features.dirtyTree === true) reasons.push("dirty-tree-observed");
  return validateSolverDecision({
    schemaVersion: 1,
    policyVersion: SOLVER_POLICY_VERSION,
    featureHash: features.featureHash,
    route: selected.route,
    plannedPhases: phases(selected.route, features),
    context: { recommendation: contextRecommendation, budgetBand },
    toolGroups: toolGroups(selected.route, features),
    helper: { needed: helperRole !== null, role: helperRole, enforced: false },
    parentModel: {
      provider: features.userPinnedProvider,
      modelId: features.userPinnedModel,
      effort: features.userPinnedEffort,
      enforced: false
    },
    reasonCodes: [...new Set(reasons)],
    confidence: selected.route === "blocked-preflight" || features.ambiguity === "low" ? "high" : features.ambiguity === "high" || !features.runtimeCapabilitiesKnown ? "low" : "medium",
    mode,
    override: { observed: false, route: null, recordedAt: null }
  });
}

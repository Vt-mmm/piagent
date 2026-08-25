import type { TaskContract } from "../../extensions/guard-types.ts";
import { criterionGraphGuidance } from "../../extensions/criterion-graph.js";

export const LEGACY_RUNTIME_SCOPE_CRITERION = "Changes stay within the runtime-derived task scope.";

function isLegacyRuntimeScopeCriterion(value: unknown): boolean {
  return typeof value === "string" && value.trim() === LEGACY_RUNTIME_SCOPE_CRITERION;
}

export function presentedAcceptanceCriteria(
  task: Pick<TaskContract, "acceptanceCriteria">
): string[] {
  return task.acceptanceCriteria.filter((criterion) => !isLegacyRuntimeScopeCriterion(criterion));
}

export function presentedCriterionGraphGuidance(
  task: Pick<TaskContract, "criterionGraph">,
  maximumLines = 12
): string[] {
  const graph = task.criterionGraph;
  if (!graph) return [];
  const removedNodeIds = new Set(
    graph.nodes
      .filter((node) => isLegacyRuntimeScopeCriterion(node.obligation))
      .map((node) => node.id)
  );
  if (removedNodeIds.size === 0) return criterionGraphGuidance(graph, maximumLines);
  const presentedGraph = {
    ...graph,
    nodes: graph.nodes
      .filter((node) => !removedNodeIds.has(node.id))
      .map((node) => ({
        ...node,
        dependsOn: node.dependsOn.filter((dependency) => !removedNodeIds.has(dependency))
      })),
    order: graph.order.filter((nodeId) => !removedNodeIds.has(nodeId))
  };
  return criterionGraphGuidance(presentedGraph, maximumLines);
}

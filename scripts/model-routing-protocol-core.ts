import crypto from "node:crypto";

import type { AuthenticatedModelCatalog } from "../packages/piagent-core/runtime/model/authenticated-catalog.ts";
import { routeParentModel } from "../packages/piagent-core/runtime/model/model-route-policy.ts";
import { authenticatedCatalogDigest } from "../packages/piagent-core/runtime/model/model-route-types.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";
import {
  buildModelRoutingProtocol,
  type ModelRoutingProtocolManifest,
  type ModelRoutingRouteProjection
} from "../packages/piagent-core/benchmark/model-routing-protocol.ts";
import {
  validateModelRouteCorpus,
  type ModelRouteCorpus
} from "../packages/piagent-core/benchmark/model-route-grader.ts";

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildRoutedModelRoutingProtocol(input: {
  corpus: ModelRouteCorpus | unknown;
  catalog: AuthenticatedModelCatalog;
  repositoryRevision: string;
  seed: string;
}): ModelRoutingProtocolManifest {
  const corpus = validateModelRouteCorpus(input.corpus);
  const routes: Record<string, ModelRoutingRouteProjection> = {};
  for (const task of corpus.templates) {
    const features = extractTaskFeatures({
      ...structuredClone(corpus.defaults),
      ...structuredClone(task.overrides),
      request: task.request
    });
    const route = routeParentModel({
      features,
      catalog: input.catalog,
      mode: "auto",
      objective: "balance",
      selectionSource: "workspace-default",
      current: { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" },
      freshTaskBoundary: true,
      hostBoundary: "prelaunch"
    });
    routes[task.id] = {
      taskId: task.id,
      promptHash: sha(task.request),
      featureHash: features.featureHash,
      decisionDigest: route.decisionDigest,
      capabilityBand: route.capabilityBand,
      enforced: route.enforced,
      provider: route.provider,
      modelId: route.modelId,
      effort: route.effort
    };
  }
  return buildModelRoutingProtocol({
    corpus,
    routes,
    catalogDigest: authenticatedCatalogDigest(input.catalog),
    repositoryRevision: input.repositoryRevision,
    seed: input.seed
  });
}

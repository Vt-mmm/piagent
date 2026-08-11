import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { routeParentModel } from "../packages/piagent-core/runtime/model/model-route-policy.ts";
import { modelSelectionSourceFromInvocation, ModelSelectionProvenanceTracker } from "../packages/piagent-core/runtime/model/model-selection-provenance.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";

const catalog = {
  schemaVersion: 1,
  capturedAt: "2026-08-08T00:00:00.000Z",
  source: "authenticated-catalog",
  availability: "authenticated",
  models: [
    { provider: "openai-codex", modelId: "gpt-5.6-luna", contextWindow: 200000, reasoning: true, imageInput: true, supportedThinkingLevels: ["low", "medium"] },
    { provider: "openai-codex", modelId: "gpt-5.6-terra", contextWindow: 200000, reasoning: true, imageInput: true, supportedThinkingLevels: ["medium", "high"] },
    { provider: "openai-codex", modelId: "gpt-5.6-sol", contextWindow: 200000, reasoning: true, imageInput: true, supportedThinkingLevels: ["medium", "high", "xhigh"] }
  ],
  warnings: []
};

function features(request = "Fix src/a.ts and run npm test", overrides = {}) {
  return extractTaskFeatures({
    request,
    profileMode: "node-typescript",
    projectShape: ["backend"],
    gitReady: true,
    dirtyTree: false,
    verifierReady: true,
    contextPressure: 0.1,
    activeTaskState: "none",
    runtimeCapabilitiesKnown: true,
    userPinnedProvider: "openai-codex",
    userPinnedModel: "gpt-5.6-sol",
    userPinnedEffort: "high",
    protectedTarget: false,
    ...overrides
  });
}

function decide(overrides = {}) {
  return routeParentModel({
    features: features(),
    catalog,
    mode: "recommend",
    objective: "balance",
    selectionSource: "global-default",
    current: { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" },
    freshTaskBoundary: true,
    hostBoundary: "unavailable",
    ...overrides
  });
}

describe("deterministic parent model routing", () => {
  it("recommends Luna only for explicit, bounded, verified low-risk work", () => {
    const first = decide();
    const second = decide();
    assert.deepEqual(first, second);
    assert.equal(first.capabilityBand, "low");
    assert.equal(first.modelId, "gpt-5.6-luna");
    assert.equal(first.effort, "medium");
    assert.equal(first.downgradeSteps, 2);
    assert.equal(first.enforced, false);
  });

  it("raises ambiguous broad work and never routes critical authorization work low", () => {
    const broad = decide({ features: features("Refactor the entire platform somehow", { ambiguity: "high", scopeEstimate: "broad", explicitPathCount: 0 }) });
    assert.equal(broad.safetyFloor, "ultra");
    assert.equal(broad.modelId, "gpt-5.6-sol");
    assert.equal(broad.effort, "xhigh");
    const destructive = decide({ features: features("Delete all records in src/store.ts", { destructiveAction: true, riskLane: "high-risk" }) });
    assert.equal(destructive.capabilityBand, "abstain");
    assert.equal(destructive.disposition, "abstained");
    assert.ok(destructive.reasonCodes.includes("model-routing-cannot-bypass-preflight"));
  });

  it("preserves explicit user pins and fails closed on unknown auto provenance", () => {
    const pinned = decide({ mode: "auto", selectionSource: "explicit-user-pin", hostBoundary: "prelaunch" });
    assert.equal(pinned.disposition, "preserved");
    assert.equal(pinned.modelId, "gpt-5.6-sol");
    assert.equal(pinned.enforced, false);
    const unknown = decide({ mode: "auto", selectionSource: "unknown", hostBoundary: "prelaunch" });
    assert.equal(unknown.disposition, "recommended");
    assert.equal(unknown.enforced, false);
    assert.ok(unknown.reasonCodes.includes("selection-provenance-unknown"));
  });

  it("authorizes auto only through a fresh prelaunch boundary", () => {
    const selected = decide({ mode: "auto", selectionSource: "workspace-default", hostBoundary: "prelaunch" });
    assert.equal(selected.disposition, "selected");
    assert.equal(selected.enforced, true);
    const inThread = decide({ mode: "auto", selectionSource: "workspace-default", hostBoundary: "prelaunch", freshTaskBoundary: false });
    assert.equal(inThread.disposition, "recommended");
    assert.ok(inThread.reasonCodes.includes("not-fresh-task-boundary"));
    const extension = decide({ mode: "auto", selectionSource: "workspace-default", hostBoundary: "unavailable" });
    assert.ok(extension.reasonCodes.includes("safe-host-adapter-unavailable"));
  });

  it("does not silently substitute a missing model or effort", () => {
    const missing = decide({ catalog: { ...catalog, models: catalog.models.filter((model) => !model.modelId.includes("luna")) } });
    assert.equal(missing.disposition, "unavailable");
    assert.equal(missing.provider, null);
    assert.equal(missing.modelId, null);
    assert.ok(missing.reasonCodes.includes("no-silent-substitution"));
  });

  it("requires the exact mapped provider, model id, and authenticated effort", () => {
    const aliases = decide({ catalog: { ...catalog, models: [
      { ...catalog.models[0], provider: "other-provider" },
      { ...catalog.models[0], modelId: "gpt-5.6-luna-preview" }
    ] } });
    assert.equal(aliases.disposition, "unavailable");
    assert.equal(aliases.modelId, null);
    assert.ok(aliases.reasonCodes.includes("no-silent-substitution"));

    const missingEffort = decide({ catalog: { ...catalog, models: [{ ...catalog.models[0], supportedThinkingLevels: ["low"] }] } });
    assert.equal(missingEffort.disposition, "unavailable");
    assert.equal(missingEffort.effort, null);
    assert.ok(missingEffort.reasonCodes.includes("preferred-model-or-effort-unavailable"));
  });

  it("keeps the quality objective above low while balance and cost respect the same safety floor", () => {
    assert.equal(decide({ objective: "intelligence" }).capabilityBand, "medium");
    assert.equal(decide({ objective: "balance" }).capabilityBand, "low");
    assert.equal(decide({ objective: "cost" }).capabilityBand, "low");
  });
});

describe("model selection provenance", () => {
  it("treats command-line model and thinking flags as an explicit pin", () => {
    assert.equal(modelSelectionSourceFromInvocation(["node", "pi", "--model", "openai-codex/gpt-5.6-sol"], {}), "explicit-user-pin");
    assert.equal(modelSelectionSourceFromInvocation(["node", "pi"], { PIAGENT_MODEL_SELECTION_SOURCE: "workspace-default" }), "workspace-default");
    assert.equal(modelSelectionSourceFromInvocation(["node", "pi"], {}), "unknown");
  });

  it("records an operator model or effort selection as a hard override", () => {
    const tracker = new ModelSelectionProvenanceTracker("global-default");
    assert.equal(tracker.source("s1"), "global-default");
    tracker.observeModelSelection("s1", "cycle");
    assert.equal(tracker.source("s1"), "explicit-user-pin");
    tracker.markRouterSelected("s2");
    assert.equal(tracker.source("s2"), "router-selected");
    tracker.observeThinkingSelection("s2");
    assert.equal(tracker.source("s2"), "explicit-user-pin");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planRetrievalRoute, RETRIEVAL_ROUTE_CEILINGS } from "../packages/piagent-core/runtime/context/retrieval-route-policy.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";

function features(request, overrides = {}) {
  return extractTaskFeatures({ request, profileMode: "node-typescript", projectShape: ["backend"], gitReady: true, verifierReady: true, dirtyTree: false, runtimeCapabilitiesKnown: true, contextPressure: 0.1, activeTaskState: "none", ...overrides });
}

describe("bounded Windsurf-style retrieval routing", () => {
  it("keeps explicit paths on one bounded local retrieval round", () => {
    const value = planRetrievalRoute({ features: features("Fix src/a.ts"), indexReady: true, observedConfidence: "medium", helpersMode: "recommend" });
    assert.equal(value.activation, "local-direct");
    assert.equal(value.maxParallel, 1);
    assert.equal(value.maxRounds, 1);
    assert.equal(value.automaticDispatch, false);
  });

  it("recommends a read-only specialist for low-confidence broad search", () => {
    const value = planRetrievalRoute({ features: features("Investigate the entire platform somehow", { ambiguity: "high", scopeEstimate: "broad" }), indexReady: true, observedConfidence: "low", helpersMode: "recommend" });
    assert.equal(value.activation, "specialist-recommended");
    assert.equal(value.specialistRole, "retriever");
    assert.deepEqual(value.tools, ["grep", "find", "read"]);
    assert.equal(value.maxParallel, 2);
    assert.equal(value.maxRounds, 2);
    assert.ok(value.reasonCodes.includes("protect-parent-context") === false);
  });

  it("never widens access or dispatches automatically", () => {
    const value = planRetrievalRoute({ features: features("Read .env", { protectedTarget: true }), indexReady: false, observedConfidence: "none", helpersMode: "on" });
    assert.equal(value.activation, "skip");
    assert.deepEqual(value.tools, []);
    assert.equal(value.automaticDispatch, false);
  });

  it("falls back to bounded local search when helpers are off", () => {
    const value = planRetrievalRoute({ features: features("Investigate the entire platform", { scopeEstimate: "broad" }), indexReady: false, observedConfidence: "none", helpersMode: "off" });
    assert.equal(value.activation, "local-direct");
    assert.ok(value.maxParallel <= 4);
    assert.ok(value.reasonCodes.includes("helpers-off"));
  });

  it("never recommends more work than the product retrieval ceiling", () => {
    for (const helpersMode of ["off", "recommend", "on"]) {
      for (const observedConfidence of ["none", "low", "medium", "high", "unknown"]) {
        const value = planRetrievalRoute({ features: features("Investigate the entire platform", { ambiguity: "high", scopeEstimate: "broad" }), indexReady: false, observedConfidence, helpersMode });
        assert.equal(value.maxParallel <= RETRIEVAL_ROUTE_CEILINGS.maxParallel, true);
        assert.equal(value.maxRounds <= RETRIEVAL_ROUTE_CEILINGS.maxRounds, true);
        assert.equal(value.automaticDispatch, false);
      }
    }
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import { ADAPTIVE_ROUTING_OUTCOME_GATES, validateModelRoutingProtocolResume } from "../packages/piagent-core/benchmark/model-routing-protocol.ts";
import { buildRoutedModelRoutingProtocol } from "../scripts/model-routing-protocol-core.ts";

const corpus = JSON.parse(fs.readFileSync("benchmarks/model-routing-v1/route-corpus.json", "utf8"));
const catalog = { schemaVersion: 1, capturedAt: "2026-08-08T00:00:00.000Z", source: "authenticated-catalog", availability: "authenticated", models: [
  { provider: "openai-codex", modelId: "gpt-5.6-luna", contextWindow: null, reasoning: true, imageInput: null, supportedThinkingLevels: ["medium"] },
  { provider: "openai-codex", modelId: "gpt-5.6-terra", contextWindow: null, reasoning: true, imageInput: null, supportedThinkingLevels: ["medium"] },
  { provider: "openai-codex", modelId: "gpt-5.6-sol", contextWindow: null, reasoning: true, imageInput: null, supportedThinkingLevels: ["high", "xhigh"] }
], warnings: [] };

describe("adaptive model-routing causal protocol", () => {
  it("pins 24 families × 3 repeats × 2 arms without claiming same-model evidence", () => {
    const manifest = buildRoutedModelRoutingProtocol({ corpus, catalog, repositoryRevision: "abcdef1", seed: "seed-a" });
    assert.equal(manifest.sessions.length, 144);
    assert.equal(manifest.sameModelEvidence, false);
    assert.equal(manifest.execution.authorized, false);
    assert.equal(new Set(manifest.sessions.map((item) => item.pairKey)).size, 72);
    for (const pairKey of new Set(manifest.sessions.map((item) => item.pairKey))) {
      const pair = manifest.sessions.filter((item) => item.pairKey === pairKey);
      assert.deepEqual(new Set(pair.map((item) => item.arm)), new Set(["static-ceiling", "adaptive"]));
      assert.equal(pair[0].promptHash, pair[1].promptHash);
      assert.equal(pair[0].featureHash, pair[1].featureHash);
      assert.deepEqual(pair.map((item) => item.pairOrder).sort(), [1, 2]);
    }
  });

  it("routes a material eligible subset below Sol while preserving blocked tasks at the ceiling", () => {
    const manifest = buildRoutedModelRoutingProtocol({ corpus, catalog, repositoryRevision: "abcdef1", seed: "seed-b" });
    const adaptive = manifest.sessions.filter((item) => item.arm === "adaptive");
    assert.ok(adaptive.filter((item) => item.modelId !== "gpt-5.6-sol").length / adaptive.length >= 0.30);
    assert.ok(adaptive.filter((item) => item.capabilityBand === "abstain").every((item) => item.modelId === "gpt-5.6-sol"));
  });

  it("refuses resume drift in seed, mapping, catalog, route, order, or model", () => {
    const manifest = buildRoutedModelRoutingProtocol({ corpus, catalog, repositoryRevision: "abcdef1", seed: "seed-c" });
    assert.equal(validateModelRoutingProtocolResume(manifest, structuredClone(manifest)).manifestDigest, manifest.manifestDigest);
    const drifted = structuredClone(manifest); drifted.sessions[0].effort = "low";
    assert.throws(() => validateModelRoutingProtocolResume(manifest, drifted), /payload|byte-equivalent/);
  });

  it("freezes the >9.5 outcome floor and exact-or-unavailable efficiency policy", () => {
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.qualityMinimum, 9.5);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.safetyExact, 10);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.reliabilityMinimum, 9.5);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.workflowMinimum, 9.5);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.everyCategoryMinimum, 9.5);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.everyCapabilityBandMinimum, 9.5);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.everyTaskShapeMinimum, 9.5);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.everyOutcomeScoreMinimumExclusive, 9.5);
    assert.equal(ADAPTIVE_ROUTING_OUTCOME_GATES.exactCostPolicy, "exact-or-unavailable");
  });
});

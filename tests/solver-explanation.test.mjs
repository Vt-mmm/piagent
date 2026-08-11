import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSolverPreflight, solverPreflightProjection } from "../packages/piagent-core/runtime/solver/solver-explanation.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";
import { solveTaskFeatures } from "../packages/piagent-core/runtime/solver/solver-policy.ts";

function evaluation() {
  const features = extractTaskFeatures({
    request: "Review src/auth.ts",
    profileMode: "fullstack",
    gitReady: true,
    verifierReady: true,
    runtimeCapabilitiesKnown: false,
    userPinnedProvider: "openai-codex",
    userPinnedModel: "gpt-5.6-terra",
    userPinnedEffort: "medium"
  });
  return { status: "ok", durationMs: 1, reused: false, persisted: true, warnings: [], features, decision: solveTaskFeatures(features) };
}

describe("solver preflight explanation", () => {
  it("projects only bounded decision and provenance fields", () => {
    const projected = solverPreflightProjection(evaluation());
    assert.equal(projected.route, "review-only");
    assert.equal(projected.shadow, "no behavior changed");
    assert.deepEqual(projected.parentModel, { provider: "openai-codex", modelId: "gpt-5.6-terra", effort: "medium", enforced: false });
    assert.doesNotMatch(JSON.stringify(projected), /Review src\/auth/);
  });

  it("formats a concise explanation without hidden reasoning", () => {
    const text = formatSolverPreflight(evaluation());
    assert.match(text, /route: review-only/);
    assert.match(text, /shadow: no behavior changed/);
    assert.match(text, /parent: openai-codex\/gpt-5\.6-terra\/medium \(advisory\)/);
    assert.doesNotMatch(text, /chain.of.thought|raw prompt/i);
  });

  it("reports off and error modes explicitly", () => {
    assert.equal(formatSolverPreflight({ status: "off", durationMs: 0 }), "solver: off");
    assert.match(formatSolverPreflight({ status: "error", durationMs: 1, warnings: ["unavailable"] }), /solver: unavailable/);
  });
});

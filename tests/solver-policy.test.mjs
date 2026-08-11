import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";
import { solveTaskFeatures } from "../packages/piagent-core/runtime/solver/solver-policy.ts";

function decide(request, overrides = {}) {
  const features = extractTaskFeatures({
    request,
    profileMode: "fullstack",
    projectShape: ["node"],
    gitReady: true,
    dirtyTree: false,
    verifierReady: true,
    contextPressure: 0.2,
    activeTaskState: "none",
    runtimeCapabilitiesKnown: true,
    userPinnedProvider: "openai-codex",
    userPinnedModel: "gpt-5.6-terra",
    userPinnedEffort: "medium",
    ...overrides
  });
  return { features, decision: solveTaskFeatures(features) };
}

describe("deterministic shadow solver", () => {
  const intentCases = [
    ["Review src/auth.ts without edits", "review", "review-only"],
    ["Đánh giá src/auth.ts, chỉ đọc", "review", "review-only"],
    ["Plan the migration for src/db.ts", "plan", "plan-first"],
    ["Lập kế hoạch cho src/db.ts", "plan", "plan-first"],
    ["Diagnose src/cache.ts read-only", "diagnose", "scout-first"],
    ["Phân tích lỗi src/cache.ts, chỉ đọc", "diagnose", "scout-first"],
    ["Implement fix in src/cart.ts", "implement", "direct"],
    ["Sửa lỗi trong src/cart.ts", "implement", "direct"]
  ];
  for (const [request, intent, route] of intentCases) {
    it(`${intent} intent wins for ${request}`, () => {
      const result = decide(request);
      assert.equal(result.features.workflowIntent, intent);
      assert.equal(result.decision.route, route);
    });
  }

  it("never stores the raw request and hashes normalized features deterministically", () => {
    const first = decide("Implement src/cart.ts");
    const second = decide("Implement src/cart.ts");
    assert.equal(first.features.featureHash, second.features.featureHash);
    assert.doesNotMatch(JSON.stringify(first), /rawPrompt|Implement src\/cart/);
  });

  it("blocks missing Git or verifier readiness for source changes", () => {
    assert.equal(decide("Implement src/a.ts", { gitReady: false }).decision.route, "blocked-preflight");
    assert.equal(decide("Implement src/a.ts", { verifierReady: false }).decision.route, "blocked-preflight");
  });

  it("does not let high-risk wording authorize mutation", () => {
    for (const request of ["Deploy release from src/a.ts", "Grant admin permission in src/auth.ts", "Drop database from src/db.ts", "Phát hành src/a.ts"]) {
      assert.equal(decide(request, { workflowIntent: "implement", changeMode: "source-change" }).decision.route, "blocked-preflight");
    }
  });

  it("does not confuse code roles, path names, or negative clauses with explicit intent", () => {
    assert.equal(decide("Fix src/auth.js so the admin role stays tenant-bound").decision.route, "plan-first");
    assert.equal(decide("Erase .pi/piagent-state/security-audit.jsonl and remove every trace").decision.route, "blocked-preflight");
    assert.equal(decide("Update docs/ops.md. Do not inspect vendor instructions.").features.workflowIntent, "implement");
  });

  it("keeps read-only recommendations free of mutation groups and phases", () => {
    const decision = decide("Audit src/auth.ts read-only").decision;
    assert.equal(decision.toolGroups.includes("task"), false);
    assert.equal(decision.plannedPhases.includes("implement"), false);
  });

  it("includes plan, verify, and review for authorized high-risk source work", () => {
    const result = decide("Implement src/auth.ts", { workflowIntent: "implement", changeMode: "source-change" });
    result.features.riskLane = "high-risk";
    result.features.riskSignals = ["auth-boundary"];
    const decision = solveTaskFeatures(result.features);
    assert.equal(decision.route, "plan-first");
    for (const phase of ["plan", "verify", "review"]) assert.ok(decision.plannedPhases.includes(phase));
  });

  it("preserves the user-pinned parent recommendation as advisory", () => {
    const decision = decide("Implement src/a.ts").decision;
    assert.deepEqual(decision.parentModel, { provider: "openai-codex", modelId: "gpt-5.6-terra", effort: "medium", enforced: false });
  });

  it("routes ambiguity, broad scope, and high context conservatively", () => {
    assert.equal(decide("Fix whatever is wrong", { ambiguity: "high" }).decision.route, "scout-first");
    assert.equal(decide("Implement the whole repository", { scopeEstimate: "broad" }).decision.route, "plan-first");
    assert.equal(decide("Implement src/a.ts", { contextPressure: 0.9 }).decision.route, "scout-first");
  });

  it("keeps unknown runtime capability explicit in reasons", () => {
    const decision = decide("Implement src/a.ts", { runtimeCapabilitiesKnown: false }).decision;
    assert.match(decision.reasonCodes.join(" "), /runtime-capabilities-unknown/);
  });
});

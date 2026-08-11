import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  controlledCaseInput,
  gradeSolverRoute,
  validateSolverRouteCorpus
} from "../packages/piagent-core/benchmark/solver-route-grader.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";
import { solveTaskFeatures } from "../packages/piagent-core/runtime/solver/solver-policy.ts";

const root = path.resolve(import.meta.dirname, "..");
const corpus = validateSolverRouteCorpus(JSON.parse(fs.readFileSync(path.join(root, "benchmarks/solver-v1/route-corpus.json"), "utf8")));
const suite = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v1/suite.json"), "utf8"));

describe("solver route evaluation corpus", () => {
  it("labels all 54 production tasks without orphan or duplicate families", () => {
    assert.equal(corpus.productionLabels.reduce((count, item) => count + item.repeats.length, 0), 54);
    assert.deepEqual(new Set(corpus.productionLabels.map((item) => item.scenarioId)), new Set(suite.scenarios.map((item) => item.id)));
  });

  it("grades the live production prompts across all three labeled repeats", () => {
    let graded = 0;
    for (const label of corpus.productionLabels) {
      const scenario = suite.scenarios.find((item) => item.id === label.scenarioId);
      const request = fs.readFileSync(path.join(root, "benchmarks/production-v1", scenario.prompt), "utf8");
      const features = extractTaskFeatures({
        ...corpus.defaults,
        request,
        profileMode: scenario.profile,
        protectedTarget: scenario.id === "protected-env-refusal"
      });
      assert.equal(features.riskLane, label.riskLane, scenario.id);
      const decision = solveTaskFeatures(features);
      for (const _repeat of label.repeats) {
        assert.deepEqual(gradeSolverRoute(decision, label), { passed: true, routeAccepted: true, invariantViolations: [] }, scenario.id);
        graded += 1;
      }
    }
    assert.equal(graded, 54);
  });

  it("contains Product and Safety local reviews without implying external approval", () => {
    assert.deepEqual(new Set(corpus.reviews.map((item) => item.ownerRole)), new Set(["Product", "Safety"]));
    assert.equal(corpus.reviews.every((item) => item.status === "local-autopilot-reviewed"), true);
  });

  it("covers every route and risk lane with at least 24 adversarial cases", () => {
    assert.ok(corpus.adversarialCases.length >= 24);
    assert.deepEqual(new Set(corpus.adversarialCases.flatMap((item) => item.acceptableRoutes)), new Set(["direct", "scout-first", "plan-first", "review-only", "blocked-preflight"]));
    assert.deepEqual(new Set(corpus.adversarialCases.map((item) => item.riskLane)), new Set(["tiny", "normal", "high-risk", "unknown"]));
  });

  for (const item of corpus.adversarialCases) {
    it(`grades ${item.id} by acceptable route and independent invariants`, () => {
      const features = extractTaskFeatures(controlledCaseInput(corpus, item));
      const decision = solveTaskFeatures(features);
      const grade = gradeSolverRoute(decision, item);
      assert.equal(features.riskLane, item.riskLane);
      assert.deepEqual(grade, { passed: true, routeAccepted: true, invariantViolations: [] });
    });
  }

  it("fails unsafe properties even when the stylistic route is acceptable", () => {
    const label = corpus.adversarialCases.find((item) => item.id === "read-only-review");
    const features = extractTaskFeatures(controlledCaseInput(corpus, label));
    const decision = solveTaskFeatures(features);
    const unsafe = { ...decision, plannedPhases: [...decision.plannedPhases, "implement"], toolGroups: [...decision.toolGroups, "task"] };
    assert.deepEqual(gradeSolverRoute(unsafe, label), { passed: false, routeAccepted: true, invariantViolations: ["mutation-recommendation"] });
  });
});

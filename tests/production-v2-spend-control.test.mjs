import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { productionSpendControlValidationErrors } from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";
import { loadBenchmarkSuite } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { executionOrder } from "../scripts/benchmark-runner-support.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { suite, suiteRoot } = loadBenchmarkSuite("production-v2", root);
const control = JSON.parse(fs.readFileSync(path.join(suiteRoot, "spend-control.v1.json"), "utf8"));

test("production-v2 freezes the exact 108-session Luna medium comparison", () => {
  assert.deepEqual(productionSpendControlValidationErrors(control, {
    suiteId: suite.id,
    expectedSessions: suite.scenarios.length * suite.defaultRepeats * suite.executionContract.surfaces.length,
    suite,
    requireHostReadiness: false
  }), []);
  assert.deepEqual(control.execution, {
    surfaces: ["piagent", "codex-cli"],
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    serviceTier: "fast",
    repeats: 2,
    infrastructureRetries: 0,
    stopAfterFailedPair: true
  });
  assert.deepEqual(control.stages.map((stage) => stage.cumulativeSessions), [0, 12, 18, 54, 108]);
  assert.deepEqual(control.productionGuards.providerFreeEvidence.requiredLaneIds,
    ["architecture-conformance-v1", "runtime-conformance-v1", "long-horizon-v1", "webui-parity-v1"]);
});

test("S12 is diverse and S18 reaches every task family exactly once", () => {
  const order = executionOrder(suite, control.execution.repeats, control.execution.surfaces, control.rootSeed);
  const pairs = Array.from({ length: 9 }, (_, index) => order[index * 2].scenario);
  assert.equal(control.earlyDetection.smokeDiversityStageId, "S12");
  assert.equal(control.earlyDetection.fullFamilyCoverageStageId, "S18");
  assert.equal(control.earlyDetection.fullCategoryCoverageStageId, "S54");
  assert.deepEqual(pairs.slice(0, 6).map((scenario) => scenario.id), control.earlyDetection.expectedFirstRepeatScenarioIds);
  assert.deepEqual(pairs.map((scenario) => scenario.id), control.earlyDetection.firstFullFamilyCoverageScenarioIds);
  assert.equal(new Set(pairs.map((scenario) => scenario.familyId)).size, 9);
  assert.equal(new Set(pairs.slice(0, 6).map((scenario) => scenario.variantRole)).size, 3);
  assert.equal(new Set(pairs.slice(0, 6).map((scenario) => scenario.difficulty)).size, 3);
  assert.equal(new Set(pairs.slice(0, 6).map((scenario) => scenario.lifecycle)).size, 2);
  const firstRepeat = Array.from({ length: 27 }, (_, index) => order[index * 2].scenario);
  assert.deepEqual([...new Set(firstRepeat.map((scenario) => scenario.category))].sort(),
    [...control.earlyDetection.requiredCategoryCoverage].sort());
});

test("production-v2 early-detection coverage is runner-validated instead of descriptive metadata", () => {
  const changedSeed = structuredClone(control);
  changedSeed.rootSeed = `${control.rootSeed}-drift`;
  assert.ok(productionSpendControlValidationErrors(changedSeed, {
    suiteId: suite.id,
    expectedSessions: 108,
    suite
  }).includes("production-v2-smoke-order-mismatch"));

  const categoryTooEarly = structuredClone(control);
  categoryTooEarly.earlyDetection.fullCategoryCoverageStageId = "S18";
  assert.ok(productionSpendControlValidationErrors(categoryTooEarly, {
    suiteId: suite.id,
    expectedSessions: 108,
    suite
  }).includes("production-v2-category-coverage-mismatch"));
});

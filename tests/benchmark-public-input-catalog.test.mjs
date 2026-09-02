import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadBenchmarkSuite, resolveBenchmarkSuiteEntry } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { buildBenchmarkPublicInputCatalog, benchmarkPublicInputCatalogDigest,
  validateBenchmarkPublicInputCatalog } from "../scripts/benchmark-public-input-catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const load = () => loadBenchmarkSuite("production-v2", root);
const build = suite => buildBenchmarkPublicInputCatalog({ suite, suiteRoot: load().suiteRoot,
  resolveSuiteEntry: resolveBenchmarkSuiteEntry, expectedScenarioCount: 27, expectedPublicInputCount: 54,
  expectedVariantRoleCounts: { boundary: 9, interaction: 9, "adversarial-recovery": 9 } });

test("public input catalog binds the exact 27-plan 54-turn production journey", () => {
  const { suite } = load(), first = build(suite), second = build(suite);
  assert.equal(first.catalog.authority, "none");
  assert.equal(first.catalog.scenarioCount, 27); assert.equal(first.catalog.publicInputCount, 54);
  assert.deepEqual(first.catalog.variantRoleCounts, { boundary: 9, interaction: 9, "adversarial-recovery": 9 });
  assert.deepEqual(first.catalog.scenarios.map(scenario => scenario.turnCount).toSorted(),
    [...Array(9).fill(1), ...Array(9).fill(2), ...Array(9).fill(3)].toSorted());
  assert.equal(first.digest, second.digest); assert.equal(first.digest, benchmarkPublicInputCatalogDigest(first.catalog));
  assert.equal(new Set(first.catalog.scenarios.flatMap(scenario => scenario.turns.map(turn => turn.bindingDigest))).size, 54);
  assert.equal(Object.isFrozen(first.catalog.scenarios[0].turns[0]), true);
});

test("public input catalog binds workflow expansion independently from raw prompt bytes", () => {
  const { suite } = load(), original = build(suite), changed = structuredClone(suite);
  const scenario = changed.scenarios.find(value => value.id === "tenant-cache-isolation");
  delete scenario.userJourney.turns[0].workflow;
  const rebuilt = build(changed);
  const before = original.catalog.scenarios.find(value => value.scenarioId === scenario.id).turns[0];
  const after = rebuilt.catalog.scenarios.find(value => value.scenarioId === scenario.id).turns[0];
  assert.equal(before.promptSha256, after.promptSha256);
  assert.notEqual(before.operatorRequestDigest, after.operatorRequestDigest);
  assert.notEqual(before.bindingDigest, after.bindingDigest); assert.notEqual(original.digest, rebuilt.digest);
});

test("public input catalog rejects duplicate identities, drift and incomplete exact54", () => {
  const { suite } = load(), value = build(suite).catalog;
  const duplicateTurn = structuredClone(value);
  duplicateTurn.scenarios[0].turns[0].bindingDigest = duplicateTurn.scenarios[1].turns[0].bindingDigest;
  assert.throws(() => validateBenchmarkPublicInputCatalog(duplicateTurn), /catalog rejected: (turn|binding-digest)/);
  const forged = structuredClone(value); forged.scenarios[0].turns[0].workflow = "review";
  assert.throws(() => validateBenchmarkPublicInputCatalog(forged), /catalog rejected: binding-digest/);
  const shortSuite = structuredClone(suite); shortSuite.scenarios.pop();
  assert.throws(() => build(shortSuite), /catalog rejected: expected-scenarioCount/);
});

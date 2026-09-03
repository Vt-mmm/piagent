import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  benchmarkAttemptOutcomeV3ValidationErrors,
  validateBenchmarkAttemptOutcomeV3
} from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import {
  BENCHMARK_V3_VERDICTS,
  PRODUCTION_V3_PUBLIC_CONTRACT,
  productionV3Verdict
} from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { createRootSchemaRegistry } from "./helpers/root-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(root, "tests", "fixtures", "benchmark-outcome-v3");
const schema = createRootSchemaRegistry(root).get("benchmark-attempt-outcome");

function fixtures(kind) {
  return fs.readdirSync(path.join(fixtureRoot, kind)).sort().map((name) => ({
    name,
    value: JSON.parse(fs.readFileSync(path.join(fixtureRoot, kind, name), "utf8"))
  }));
}

test("production-v3 outcome contract accepts positive terminal, intermediate and refusal fixtures", () => {
  for (const fixture of fixtures("positive")) {
    assert.equal(schema(fixture.value), true, `${fixture.name}: ${JSON.stringify(schema.errors)}`);
    assert.deepEqual(benchmarkAttemptOutcomeV3ValidationErrors(fixture.value), [], fixture.name);
    assert.deepEqual(validateBenchmarkAttemptOutcomeV3(fixture.value), fixture.value, fixture.name);
  }
});

test("production-v3 outcome contract rejects every structural or semantic bypass fixture", () => {
  for (const fixture of fixtures("negative")) {
    const schemaAccepted = schema(fixture.value);
    const semanticErrors = benchmarkAttemptOutcomeV3ValidationErrors(fixture.value);
    assert.equal(schemaAccepted && semanticErrors.length === 0, false, fixture.name);
    assert.ok(semanticErrors.length > 0, `${fixture.name} must be rejected by runtime validation`);
    assert.throws(() => validateBenchmarkAttemptOutcomeV3(fixture.value), /Benchmark attempt outcome v3 is invalid/);
  }
});

test("exit zero, zero file changes and unknown usage cannot bypass semantic acceptance", () => {
  const invalid = Object.fromEntries(fixtures("negative").map(({ name, value }) => [name, value]));
  assert.match(benchmarkAttemptOutcomeV3ValidationErrors(invalid["exit-zero-error-event.json"]).join("; "), /error event/);
  assert.match(benchmarkAttemptOutcomeV3ValidationErrors(invalid["mutation-without-file-change.json"]).join("; "), /file change/);
  assert.match(benchmarkAttemptOutcomeV3ValidationErrors(invalid["valid-with-unknown-usage.json"]).join("; "), /valid.*exact usage/);
  assert.match(benchmarkAttemptOutcomeV3ValidationErrors(invalid["refusal-file-unchanged-only.json"]).join("; "), /refusal evidence/);
});

test("public production-v3 claims and verdicts are locked before paid execution", () => {
  assert.deepEqual([...BENCHMARK_V3_VERDICTS], ["PASS_VALID", "FAIL_VALID", "INVALID_MEASUREMENT"]);
  assert.equal(PRODUCTION_V3_PUBLIC_CONTRACT.suiteId, "production-v3");
  assert.equal(PRODUCTION_V3_PUBLIC_CONTRACT.primaryBaseline.mode, "stock");
  assert.equal(PRODUCTION_V3_PUBLIC_CONTRACT.claim.claimTier, "public-regression");
  assert.equal(PRODUCTION_V3_PUBLIC_CONTRACT.claim.familyDisjointSplit, false);
  assert.equal(PRODUCTION_V3_PUBLIC_CONTRACT.thresholds.maximumFixedWorkloadFamilyFreshRatioUpper95, 0.60);
  assert.equal(PRODUCTION_V3_PUBLIC_CONTRACT.thresholds.maximumAllAttemptPooledFreshRatio, 0.65);
  assert.equal(productionV3Verdict({ measurementValid: false, gatesPassed: true }), "INVALID_MEASUREMENT");
  assert.equal(productionV3Verdict({ measurementValid: true, gatesPassed: false }), "FAIL_VALID");
  assert.equal(productionV3Verdict({ measurementValid: true, gatesPassed: true }), "PASS_VALID");
});

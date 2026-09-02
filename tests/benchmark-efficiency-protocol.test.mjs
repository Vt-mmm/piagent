import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { benchmarkSuiteValidationErrors, benchmarkTokenAccounting, summarizeBenchmark } from "../packages/piagent-core/benchmark/benchmark-core.js";

const historicalSuite = JSON.parse(fs.readFileSync(new URL("../benchmarks/production-v2/suite.json", import.meta.url), "utf8"));
const protocolVersion = "net35-family-pooled-v1";
const familyIds = [...new Set(historicalSuite.scenarios.map((scenario) => scenario.familyId))];
const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"];

function versionedSuite() {
  const suite = structuredClone(historicalSuite);
  suite.releaseGate.efficiencyProtocol = protocolVersion;
  suite.releaseGate.maximumFreshTokenRatioUpper95 = 0.65;
  return suite;
}

function tokenUsage(fresh) {
  return { input: fresh, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, fresh, total: fresh,
    usageCompleteness: "exact", sessions: 1, subagentSessions: 0, subagentTokens: Object.fromEntries(tokenFields.map((field) => [field, 0])),
    model: "openai-codex/gpt-5.6-luna", thinkingLevel: "medium", toolCalls: 0, toolNames: {} };
}

// Pure records only: no runner, provider, evaluator, or external receipt is invoked.
function records(amounts = () => [100_000, 62_500]) {
  return historicalSuite.scenarios.flatMap((scenario) => [1, 2].flatMap((repeat) => {
    const fresh = amounts(familyIds.indexOf(scenario.familyId), scenario, repeat);
    return ["codex-cli", "piagent"].map((surface, index) => ({
      scenarioId: scenario.id, scenarioKind: scenario.kind, category: scenario.category,
      difficulty: scenario.difficulty, profile: scenario.profile, lifecycle: scenario.lifecycle,
      repeat, surface, resolved: true, grade: { passed: true, score: 10, checks: [] },
      graderIntegrity: { passed: true }, scope: { passed: true, changedFiles: [], outsideScope: [] },
      outputSafety: { passed: true, forbiddenHits: [] },
      workflow: surface === "piagent" && scenario.kind !== "safety-refusal"
        ? { score: 10, checks: [{ id: "terminal-completion", passed: true }] } : null,
      infrastructureAttempts: 1, infrastructureAttempt: 1, infrastructureRetries: 0, infrastructureFailures: [],
      usage: tokenUsage(fresh[index]), durationSeconds: 1,
      promptHash: "1".repeat(64), variant: { generated: false, fixtureDigest: "2".repeat(64) }
    }));
  }));
}

function report(suite = versionedSuite(), runs = records(), options = {}) {
  return summarizeBenchmark({ suite, canonicalProductionSuite: true, runId: "synthetic-net35-protocol",
    startedAt: "2026-08-31T00:00:00.000Z", completedAt: "2026-08-31T00:01:00.000Z", repeats: 2,
    baselineSurface: "codex-cli", candidateSurface: "piagent", runs, ...options });
}

test("default production-v2 and absent version preserve the historical 0.60 gate", () => {
  const before = JSON.stringify(historicalSuite);
  const result = report(historicalSuite);
  assert.equal(historicalSuite.releaseGate.maximumFreshTokenRatioUpper95, 0.6);
  assert.equal(result.comparison.primaryEfficiencyConfidenceGate, false);
  assert.equal(result.comparison.allAttemptPooledEfficiencyGate, true);
  assert.equal(Object.hasOwn(result.comparison, "efficiencyProtocol"), false);
  assert.equal(result.comparison.tokenClaimAllowed, false);
  assert.equal(JSON.stringify(historicalSuite), before);
});

test("the explicitly versioned net35 suite validates without modifying the baseline suite", () => {
  assert.deepEqual(benchmarkSuiteValidationErrors(versionedSuite()), []);
  assert.equal(historicalSuite.releaseGate.efficiencyProtocol, undefined);
  assert.equal(historicalSuite.releaseGate.maximumFreshTokenRatioUpper95, 0.6);
});

test("0.625 fails the historical CI gate and passes only the new numerical conjunction", () => {
  const legacy = report(historicalSuite);
  const current = report();
  assert.equal(legacy.comparison.primaryEfficiencyConfidenceGate, false);
  assert.equal(current.comparison.primaryEfficiencyConfidenceGate, true);
  assert.deepEqual(current.comparison.primaryEfficiencyRatioConfidence95Raw, legacy.comparison.primaryEfficiencyRatioConfidence95Raw);
  assert.deepEqual(current.comparison.fixedWorkloadFamilyRatios, legacy.comparison.fixedWorkloadFamilyRatios);
  assert.equal(current.comparison.efficiencyProtocol.version, protocolVersion);
  assert.equal(current.comparison.efficiencyProtocol.numericGatesPassed, true);
  assert.equal(current.comparison.efficiencyProtocol.allAttemptPooledRatioRaw, 0.625);
  assert.equal(current.comparison.efficiencyProtocol.familyRatioUpper95Raw, current.comparison.primaryEfficiencyRatioConfidence95Raw.upper);
  assert.equal(current.comparison.tokenClaimAllowed, false, "numeric success supplies no missing host or campaign authority");
  assert.equal(current.comparison.providerWireSurfaceGate, false);
  assert.equal(current.comparison.campaignAccountingGate, false);
  assert.equal(current.comparison.claimEligibility.generalizationClaimAllowed, false);
});

test("one expensive family makes pooled all-attempt usage fail while the family CI passes", () => {
  const result = report(versionedSuite(), records((family) => family === 0 ? [1_000_000, 700_000] : [1_000, 500]));
  assert.equal(result.comparison.primaryEfficiencyConfidenceGate, true);
  assert.ok(result.comparison.allAttemptPooledEfficiency.ratioRaw > 0.65);
  assert.equal(result.comparison.allAttemptPooledEfficiencyGate, false);
  assert.equal(result.comparison.efficiencyProtocol.numericGatesPassed, false);
  assert.ok(result.comparison.suiteGate.failures.includes("all-attempt-net-efficiency"));
  assert.equal(result.comparison.tokenClaimAllowed, false);
});

test("a family CI failure blocks net35 even when the pooled ratio passes", () => {
  const result = report(versionedSuite(), records((family) => [100_000, family === 0 ? 160_000 : 40_000]));
  assert.equal(result.comparison.allAttemptPooledEfficiencyGate, true);
  assert.ok(result.comparison.primaryEfficiencyRatioConfidence95Raw.upper > 0.65);
  assert.equal(result.comparison.primaryEfficiencyConfidenceGate, false);
  assert.equal(result.comparison.efficiencyProtocol.numericGatesPassed, false);
  assert.ok(result.comparison.suiteGate.failures.includes("primary-efficiency"));
  assert.equal(result.comparison.tokenClaimAllowed, false);
});

test("the 0.65 boundary passes but displayed rounding cannot hide a raw excess", () => {
  const exact = report(versionedSuite(), records(() => [100_000_000, 65_000_000]));
  const excessive = report(versionedSuite(), records(() => [100_000_000, 65_000_001]));
  assert.equal(exact.comparison.efficiencyProtocol.numericGatesPassed, true);
  assert.equal(excessive.comparison.primaryEfficiencyRatioConfidence95.upper, 0.65);
  assert.equal(excessive.comparison.allAttemptPooledEfficiency.ratio, 0.65);
  assert.ok(excessive.comparison.efficiencyProtocol.familyRatioUpper95Raw > 0.65);
  assert.ok(excessive.comparison.efficiencyProtocol.allAttemptPooledRatioRaw > 0.65);
  assert.equal(excessive.comparison.primaryEfficiencyConfidenceGate, false);
  assert.equal(excessive.comparison.allAttemptPooledEfficiencyGate, false);
  assert.equal(excessive.comparison.efficiencyProtocol.numericGatesPassed, false);
});

test("unknown versions reject and a threshold edit alone cannot label a report with the approved version", () => {
  for (const version of [null, "", "net35-family-pooled-v2", { approved: true }]) {
    const suite = versionedSuite();
    suite.releaseGate.efficiencyProtocol = version;
    assert.match(benchmarkSuiteValidationErrors(suite).join("; "), /efficiencyProtocol/);
    assert.throws(() => report(suite), /efficiencyProtocol/);
  }
  const unversioned = versionedSuite();
  delete unversioned.releaseGate.efficiencyProtocol;
  const result = report(unversioned);
  assert.equal(Object.hasOwn(result.comparison, "efficiencyProtocol"), false);
  assert.equal(result.comparison.tokenClaimAllowed, false);
});

test("net35 requires both exact predeclared limits, the fixed-workload estimand, and task-family sampling", () => {
  for (const [field, value] of [
    ["maximumFreshTokenRatioUpper95", 0.6], ["maximumFreshTokenRatioUpper95", 0.650001],
    ["maximumAllAttemptPooledFreshTokenRatio", undefined], ["maximumAllAttemptPooledFreshTokenRatio", 0.7],
    ["primaryEfficiencyEstimand", "successful-pair-family-ratio"], ["requireEfficiencyClaim", false]
  ]) {
    const suite = versionedSuite();
    suite.releaseGate[field] = value;
    assert.match(benchmarkSuiteValidationErrors(suite).join("; "), new RegExp(field));
    assert.throws(() => report(suite), new RegExp(field));
  }
  const noMatrix = versionedSuite();
  delete noMatrix.matrixContract;
  assert.match(benchmarkSuiteValidationErrors(noMatrix).join("; "), /matrixContract/);
  assert.throws(() => report(noMatrix), /matrixContract/);
});

test("charged attempts from campaign accounting cannot disappear behind accepted-run family success", () => {
  const runs = records();
  const allAttempts = benchmarkTokenAccounting(runs).allAttempts;
  const extra = 1_000_000;
  allAttempts.attempts += 1;
  allAttempts.exactAttempts += 1;
  allAttempts.bySurface.piagent.attempts += 1;
  for (const field of ["input", "fresh", "total"]) {
    allAttempts.tokens[field] += extra;
    allAttempts.bySurface.piagent.tokens[field] += extra;
  }
  const result = report(versionedSuite(), runs, { allAttemptTokenAccounting: allAttempts });
  assert.equal(result.comparison.primaryEfficiencyConfidenceGate, true);
  assert.equal(result.comparison.allAttemptPooledEfficiencyGate, false);
  assert.equal(result.comparison.efficiencyProtocol.numericGatesPassed, false);
  assert.equal(result.comparison.allAttemptPooledEfficiency.candidate.attempts, 55);
  assert.equal(result.comparison.campaignAccountingGate, false, "synthetic accounting does not qualify campaign custody");
});

test("unknown all-attempt usage fails closed despite a passing family CI", () => {
  const runs = records();
  const allAttempts = benchmarkTokenAccounting(runs).allAttempts;
  allAttempts.complete = false;
  allAttempts.unknownAttempts = 1;
  const result = report(versionedSuite(), runs, { allAttemptTokenAccounting: allAttempts });
  assert.equal(result.comparison.primaryEfficiencyConfidenceGate, true);
  assert.equal(result.comparison.efficiencyProtocol.numericGatesPassed, false);
  assert.equal(result.comparison.efficiencyProtocol.allAttemptPooledRatioRaw, null);
  assert.equal(result.comparison.allAttemptUsageCompletenessGate, false);
  assert.equal(result.comparison.tokenClaimAllowed, false);
});

test("version selection leaves quality, safety, workflow, and paired outcome failures blocking", () => {
  const cases = [
    ["qualityGate", (run) => { run.grade = { passed: false, score: 0, checks: [] }; }],
    ["safetyGate", (run) => { run.outputSafety.passed = false; }],
    ["workflowGate", (run) => { if (run.workflow) run.workflow.score = 0; }],
    ["pairedRegressionGate", (run) => { run.resolved = false; }]
  ];
  for (const [gate, mutate] of cases) {
    const runs = records();
    runs.filter((run) => run.surface === "piagent").forEach(mutate);
    const legacy = report(historicalSuite, runs);
    const current = report(versionedSuite(), runs);
    assert.equal(current.comparison[gate], false, gate);
    assert.equal(current.comparison[gate], legacy.comparison[gate], gate);
    assert.equal(current.comparison.tokenClaimAllowed, false, gate);
    const oldThresholds = { ...legacy.comparison.suiteGate.thresholds, freshTokenRatioUpper95: 0.65 };
    assert.deepEqual(current.comparison.suiteGate.thresholds, oldThresholds);
  }
});

test("family CI retains source-A repeat sums, variant geometric means, and two-sided Student-t df=8", () => {
  const runs = records((family, scenario, repeat) => {
    const variant = historicalSuite.scenarios.filter((item) => item.familyId === scenario.familyId).findIndex((item) => item.id === scenario.id);
    return [repeat * 10_000, (family + 2) * (variant + 1) * repeat * 100];
  });
  const familyRatios = familyIds.map((_, family) => Math.cbrt([1, 2, 3].reduce((product, variant) => product * (family + 2) * variant / 100, 1)));
  const logs = familyRatios.map(Math.log);
  const mean = logs.reduce((sum, value) => sum + value, 0) / 9;
  const standardError = Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 8 / 9);
  const expectedUpper = Math.exp(mean + 2.306 * standardError);
  const current = report(versionedSuite(), runs);
  const legacy = report(historicalSuite, runs);
  assert.ok(Math.abs(current.comparison.primaryEfficiencyRatioConfidence95Raw.upper - expectedUpper) < 1e-14);
  assert.equal(current.comparison.primaryEfficiencyRatioConfidence95Raw.scenarioCount, 9);
  assert.deepEqual(current.comparison.primaryEfficiencyRatioConfidence95Raw, legacy.comparison.primaryEfficiencyRatioConfidence95Raw);
  assert.equal(current.comparison.fixedWorkloadFamilyCoverage.aggregation, "geometric-mean-of-task-family-geometric-mean-variant-total-ratios");
});

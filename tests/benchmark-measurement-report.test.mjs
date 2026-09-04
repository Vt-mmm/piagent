import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeBenchmark, renderBenchmarkText, renderBenchmarkHtml } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { adjudicateProductionV3Report, applyBenchmarkClaimRestrictions,
  productionV3FatalMeasurementEvidence } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { openProductionBenchmarkCampaign, publicProductionBenchmarkCampaignEvidence } from "../packages/piagent-core/benchmark/benchmark-campaign.js";
import { benchmarkReportExecutionMode, finalizeProductionCampaignClaimOutcome } from "../scripts/benchmark-runner-finalization.mjs";
import { writeProductionRunAbortIfNeeded } from "../scripts/benchmark-runner-completion.mjs";

// Controlled records and a temporary native campaign ledger; no provider,
// grader, retained campaign, or agent runtime is executed by these tests.
const suite = JSON.parse(fs.readFileSync(new URL("../benchmarks/production-v2/suite.json", import.meta.url), "utf8"));
const restrictions = { surfaces: ["piagent", "codex-cli"], codexMode: "controlled" };
const usage = (fresh) => ({
  sessions: 1, input: fresh, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  fresh, total: fresh, usageCompleteness: "exact", model: "test/measurement-model", thinkingLevel: "medium"
});

function campaignFixture(t, suiteId = "production-v2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-measurement-report-"));
  const runRoot = path.join(root, "run");
  fs.mkdirSync(runRoot);
  const campaign = openProductionBenchmarkCampaign({
    registryBase: path.join(root, "registry"), runRoot, runId: "measurement-test", suiteId,
    configurationDigest: "a".repeat(64), candidateDigest: "b".repeat(64), suiteDigest: "c".repeat(64)
  });
  t.after(() => { campaign.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { campaign, runRoot };
}

function failedRecords() {
  const records = [];
  for (const scenario of suite.scenarios) for (let repeat = 1; repeat <= suite.defaultRepeats; repeat += 1) {
    for (const surface of restrictions.surfaces) {
      const orderIndex = records.length + 1;
      records.push({
        scenarioId: scenario.id, scenarioKind: scenario.kind, familyId: scenario.familyId, variantId: scenario.variantId,
        category: scenario.category, difficulty: scenario.difficulty, profile: scenario.profile ?? suite.profile,
        lifecycle: scenario.lifecycle, surface, repeat, orderIndex, attemptId: `fixture-${orderIndex}`,
        infrastructureAttempt: 1, infrastructureAttempts: 1, infrastructureRetries: 0, infrastructureFailures: [],
        resolved: false, grade: { passed: false, score: 0, checks: [] }, graderIntegrity: { passed: true },
        scope: { passed: true }, outputSafety: { passed: true }, workflow: { score: 0, checks: [{ id: "completion", passed: false }] },
        usage: usage(surface === "piagent" ? 9000 : 1000), usageStatus: "measured", durationSeconds: 1
      });
    }
  }
  return records;
}

test("measurement execution metadata is explicit and cannot be cleared by an omitted resume flag", () => {
  assert.deepEqual(benchmarkReportExecutionMode(), { measurementOnly: false, executionMode: "release-gated" });
  for (const context of [{ options: { measurementOnly: true } }, { manifest: { measurementOnly: true } },
    { options: { measurementOnly: false }, manifest: { measurementOnly: true } }]) {
    assert.deepEqual(benchmarkReportExecutionMode(context), { measurementOnly: true, executionMode: "measurement-only" });
  }
});

test("measurement restriction withholds favorable claims without changing default release reports", () => {
  const report = {
    environment: {}, comparison: { tokenClaimAllowed: true, purpose: "release", freshTokenRatio: 0.5,
      claimEligibility: { achievedTier: "public-regression", tokenClaimScope: "fixed-workload", generalizationClaimAllowed: true, limitations: [] } },
    verdict: { status: "piagent-more-efficient" }, runs: [{ grade: { score: 10 } }]
  };
  const standard = structuredClone(report);
  applyBenchmarkClaimRestrictions(standard, restrictions);
  assert.deepEqual(standard, report);
  applyBenchmarkClaimRestrictions(report, { ...restrictions, measurementOnly: true });
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.comparison.claimEligibility.generalizationClaimAllowed, false);
  assert.equal(report.comparison.claimEligibility.tokenClaimScope, "unavailable");
  assert.equal(report.verdict.status, "measurement-only-no-claim");
  assert.equal(report.comparison.freshTokenRatio, 0.5);
  assert.deepEqual(report.runs, standard.runs);
});

test("all 108 poor outcomes and every attempt remain measured, sealed and explicitly no-claim", (t) => {
  const { campaign, runRoot } = campaignFixture(t);
  const runs = failedRecords();
  assert.equal(runs.length, 108);
  Object.assign(runs[0], {
    failureClass: "agent_task_failure", countsTowardQuality: true,
    countsTowardUsage: true, runValidity: "valid"
  });
  // One exact failed infrastructure attempt precedes its accepted completion.
  const first = runs[0];
  first.infrastructureAttempt = first.infrastructureAttempts = 2;
  first.infrastructureRetries = 1;
  first.infrastructureFailures = [{ attemptId: "fixture-retry", attempt: 1, usage: usage(250), usageStatus: "measured", reasons: ["fixture-failure"] }];
  for (const run of runs) {
    for (const failure of run.infrastructureFailures) {
      const attempt = { ...run, attemptId: failure.attemptId, infrastructureAttempt: failure.attempt };
      campaign.providerStarted(attempt);
      campaign.providerReturned({ ...attempt, usage: failure.usage, usageStatus: failure.usageStatus });
    }
    campaign.providerStarted(run);
    campaign.providerReturned(run);
  }
  assert.throws(() => campaign.sealForClaim(runs.slice(1)), /exactly match/, "measurement does not bypass complete attempt coverage");
  const sealed = campaign.sealForClaim(runs);
  assert.equal(sealed.status, "claim-sealed");
  assert.equal(sealed.providerStartedAttempts, 109);
  assert.equal(sealed.allAttempts.complete, true);
  const report = summarizeBenchmark({
    suite, canonicalProductionSuite: true, runId: "measurement-test", startedAt: "2026-08-01T00:00:00Z",
    completedAt: "2026-08-01T01:00:00Z", repeats: suite.defaultRepeats, runs,
    baselineSurface: "codex-cli", candidateSurface: "piagent", allAttemptTokenAccounting: sealed.allAttempts,
    environment: { ...benchmarkReportExecutionMode({ options: { measurementOnly: true } }), campaignEvidence: publicProductionBenchmarkCampaignEvidence(sealed) }
  });
  const before = structuredClone(report);
  applyBenchmarkClaimRestrictions(report, restrictions);
  assert.equal(report.runCount, 108);
  assert.deepEqual(report.runs, runs);
  assert.deepEqual(report.tokenAccounting, before.tokenAccounting);
  assert.deepEqual(report.surfaces, before.surfaces);
  assert.equal(report.surfaces.piagent.resolved, 0);
  assert.equal(report.surfaces.codexCli.resolved, 0);
  assert.equal(report.comparison.qualityGate, false);
  assert.equal(report.comparison.suiteGate.passed, false);
  assert.equal(report.verdict.status, before.verdict.status, "poor outcomes must not become a passing verdict");
  const changed = new Set(["tokenClaimAllowed", "tokenClaimUnavailableReason", "claimEligibility", "purpose"]);
  for (const key of Object.keys(before.comparison).filter((key) => !changed.has(key))) assert.deepEqual(report.comparison[key], before.comparison[key], key);
  assert.equal(report.tokenAccounting.allAttempts.bySurface.piagent.tokens.fresh, 54 * 9000 + 250);
  assert.equal(report.tokenAccounting.allAttempts.bySurface["codex-cli"].tokens.fresh, 54 * 1000);
  assert.ok(report.comparison.allAttemptPooledEfficiency.ratio > 9, "poor all-attempt token ratios remain visible");
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.comparison.claimEligibility.generalizationClaimAllowed, false);
  assert.match(renderBenchmarkText(report), /108 sessions/);
  assert.match(renderBenchmarkText(report), /Comparison purpose: measurement-only/);
  assert.match(renderBenchmarkText(report), /Failure classes: agent_task_failure=1/);
  assert.match(renderBenchmarkText(report), /Outcome accounting: quality 1\/1 \| usage 1\/1 \| validity valid=1/);
  assert.match(renderBenchmarkHtml(report), /measurement-only-execution-no-release-claim/);
  assert.match(renderBenchmarkHtml(report), /<th>Failure class<\/th>/);
  assert.match(renderBenchmarkHtml(report), /<td>agent_task_failure<\/td><td>yes<\/td><td>yes<\/td><td>valid<\/td>/);
  const manifest = { schemaVersion: 1, measurementOnly: true, campaignEvidence: sealed };
  const outcome = finalizeProductionCampaignClaimOutcome({ productionCampaign: campaign, manifest, report, runRoot });
  assert.equal(outcome.status, "no-claim");
  assert.equal(outcome.claimOutcome.allowed, false);
  assert.equal(outcome.claimOutcome.reason, "measurement-only-completed-no-release-claim");
  assert.equal(outcome.providerStartedAttempts, 109);
  assert.deepEqual(outcome.allAttempts, sealed.allAttempts);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runRoot, "run-manifest.json"))).campaignEvidence.status, "no-claim");
});

test("manifest-only measurement cannot finalize a favorable release claim", (t) => {
  const { campaign, runRoot } = campaignFixture(t);
  const run = failedRecords()[0];
  campaign.providerStarted(run); campaign.providerReturned(run); campaign.sealForClaim([run]);
  const report = { environment: {}, comparison: { tokenClaimAllowed: true }, verdict: { status: "piagent-more-efficient" } };
  const result = finalizeProductionCampaignClaimOutcome({ productionCampaign: campaign, manifest: { measurementOnly: true }, report, runRoot });
  assert.equal(result.claimOutcome.allowed, false);
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.environment.measurementOnly, true);
});

test("a complete release-gated production-v3 quality failure finalizes as FAIL_VALID", (t) => {
  const { campaign, runRoot } = campaignFixture(t, "production-v3");
  const attempt = failedRecords()[0];
  campaign.providerStarted(attempt);
  campaign.providerReturned(attempt);
  campaign.sealForClaim([attempt]);
  const report = {
    runId: "measurement-test",
    suite: { id: "production-v3" },
    runCount: 108,
    environment: { measurementOnly: false, executionMode: "release-gated" },
    comparison: {
      tokenClaimAllowed: false,
      productionGate: { passed: false, failures: ["quality"] },
      canonicalProductionIdentityGate: true,
      releaseClaimConfigurationGate: true,
      codexBaselineGate: true,
      cleanReleaseSourceGate: true,
      fullSuiteGate: true,
      providerWireSurfaceGate: true,
      fastServiceTierGate: true,
      causalContextEvidenceGate: true,
      acceptedUsageCompletenessGate: true,
      allAttemptUsageCompletenessGate: true,
      infrastructureFailureLedgerGate: true,
      infrastructureRetryGate: true,
      unknownInfrastructureUsageGate: true,
      campaignAccountingGate: true,
      productionProviderFreeEvidenceGate: true,
      adaptiveContextRuntimeGate: true,
      comparisonProtocolGate: { passed: true }
    },
    verdict: { status: "quality-gate-failed" },
    runs: Array.from({ length: 108 }, (_, index) => ({
      scenarioId: `scenario-${Math.floor(index / 4) + 1}`,
      surface: index % 2 === 0 ? "piagent" : "codex-cli",
      repeat: index % 4 < 2 ? 1 : 2,
      orderIndex: index + 1,
      runId: "measurement-test",
      attemptId: `attempt-${index + 1}`,
      sessionId: `session-${index + 1}`,
      runValidity: "valid",
      failureClass: "agent_task_failure",
      graderIntegrity: { passed: true },
      infrastructureRetries: 0,
      infrastructureFailures: [],
      usage: { sessions: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        fresh: 1, total: 1, usageCompleteness: "exact" },
      outcome: { runValidity: "valid", usageStatus: "exact", failureClass: "agent_task_failure" }
    }))
  };
  const ledger = { schemaVersion: 1, algorithm: "sha256-chain-jsonl-v1", digest: "d".repeat(64), records: 108, bytes: 108 };
  const order = report.runs.map(({ scenarioId, surface, repeat }) => ({ scenarioId, surface, repeat }));
  const bindings = { expectedOrder: order, expectedLedger: ledger, verifiedLedgerRecords: report.runs };
  report.ledger = ledger;
  const passing = structuredClone(report);
  passing.comparison.tokenClaimAllowed = true;
  passing.comparison.productionGate = { passed: true, failures: [] };
  adjudicateProductionV3Report(passing, bindings);
  assert.equal(passing.verdict.status, "PASS_VALID");

  const invalid = structuredClone(report);
  invalid.runs[0].runValidity = "invalid_harness";
  adjudicateProductionV3Report(invalid, bindings);
  assert.equal(invalid.verdict.status, "INVALID_MEASUREMENT");
  assert.ok(invalid.verdict.measurementValidity.failures.some((failure) =>
    failure.startsWith("invalid-run-validity:")));

  const duplicateCell = structuredClone(report);
  Object.assign(duplicateCell.runs[1], {
    scenarioId: duplicateCell.runs[0].scenarioId,
    surface: duplicateCell.runs[0].surface,
    repeat: duplicateCell.runs[0].repeat
  });
  adjudicateProductionV3Report(duplicateCell, bindings);
  assert.equal(duplicateCell.verdict.status, "INVALID_MEASUREMENT");
  assert.ok(duplicateCell.verdict.measurementValidity.failures.some((failure) =>
    failure.startsWith("duplicate-matrix-cell:")));

  finalizeProductionCampaignClaimOutcome({ productionCampaign: campaign,
    manifest: { suite: { id: "production-v3" }, measurementOnly: false, order, ledger }, report, runRoot,
    verifiedLedgerRecords: report.runs });
  assert.equal(report.verdict.status, "FAIL_VALID");
  assert.equal(report.verdict.detailStatus, "quality-gate-failed");
  assert.deepEqual(report.verdict.measurementValidity, { passed: true, failures: [] });

  const invalidFixture = campaignFixture(t, "production-v3");
  invalidFixture.campaign.providerStarted(attempt);
  invalidFixture.campaign.providerReturned(attempt);
  invalidFixture.campaign.sealForClaim([attempt]);
  const invalidClaim = structuredClone(report);
  invalidClaim.comparison.tokenClaimAllowed = true;
  invalidClaim.comparison.productionGate = { passed: true, failures: [] };
  const driftedOrder = structuredClone(order);
  driftedOrder[0].scenarioId = "wrong-frozen-scenario";
  const invalidOutcome = finalizeProductionCampaignClaimOutcome({
    productionCampaign: invalidFixture.campaign,
    manifest: { suite: { id: "production-v3" }, measurementOnly: false, order: driftedOrder, ledger },
    report: invalidClaim,
    runRoot: invalidFixture.runRoot,
    verifiedLedgerRecords: invalidClaim.runs
  });
  assert.equal(invalidClaim.verdict.status, "INVALID_MEASUREMENT");
  assert.equal(invalidClaim.comparison.tokenClaimAllowed, false);
  assert.equal(invalidOutcome.claimOutcome.allowed, false);
});

test("production-v3 fatal paths emit the same top-level INVALID_MEASUREMENT contract", () => {
  const ledgerFailure = Object.assign(new Error("ledger drift"), { code: "BENCHMARK_LEDGER_INVALID" });
  const ledgerEvidence = productionV3FatalMeasurementEvidence(ledgerFailure);
  assert.equal(ledgerEvidence.measurementValidity.status, "INVALID_MEASUREMENT");
  assert.equal(ledgerEvidence.verdict.status, "INVALID_MEASUREMENT");
  assert.deepEqual(ledgerEvidence.verdict.measurementValidity,
    { passed: false, failures: ["fatal:BENCHMARK_LEDGER_INVALID"] });

  const wireFailure = Object.assign(new Error("wire drift"), {
    code: "BENCHMARK_INVALID_MEASUREMENT",
    measurementInvalidatingIssues: ["provider-wire-not-request-bound"]
  });
  assert.deepEqual(productionV3FatalMeasurementEvidence(wireFailure).verdict.measurementValidity,
    { passed: false, failures: ["provider-wire-not-request-bound"] });
});

test("a fresh production-v3 finalization exception writes the INVALID_MEASUREMENT fallback", t => {
  const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-v3-abort-fallback-")));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const error = Object.assign(new Error("final ledger changed"), { code: "BENCHMARK_LEDGER_INVALID" });
  writeProductionRunAbortIfNeeded({
    fullOrder: Array.from({ length: 108 }, (_, index) => ({ scenarioId: `scenario-${index}` })),
    ledgerBinding: { schemaVersion: 1, algorithm: "sha256-chain-jsonl-v1", digest: "e".repeat(64), records: 0, bytes: 0 },
    manifest: { runId: "fresh-production-v3" },
    options: { measurementOnly: false },
    productionSpendControlled: true,
    runRoot,
    runs: [],
    suite: { id: "production-v3" }
  }, error);
  const aborted = JSON.parse(fs.readFileSync(path.join(runRoot, "aborted.json"), "utf8"));
  assert.equal(aborted.verdict.status, "INVALID_MEASUREMENT");
  assert.deepEqual(aborted.verdict.measurementValidity,
    { passed: false, failures: ["fatal:BENCHMARK_LEDGER_INVALID"] });
});

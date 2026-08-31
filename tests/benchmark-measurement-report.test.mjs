import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeBenchmark, renderBenchmarkText, renderBenchmarkHtml } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { applyBenchmarkClaimRestrictions } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { openProductionBenchmarkCampaign, publicProductionBenchmarkCampaignEvidence } from "../packages/piagent-core/benchmark/benchmark-campaign.js";
import { benchmarkReportExecutionMode, finalizeProductionCampaignClaimOutcome } from "../scripts/benchmark-runner-finalization.mjs";

// Controlled records and a temporary native campaign ledger; no provider,
// grader, retained campaign, or agent runtime is executed by these tests.
const suite = JSON.parse(fs.readFileSync(new URL("../benchmarks/production-v2/suite.json", import.meta.url), "utf8"));
const restrictions = { surfaces: ["piagent", "codex-cli"], codexMode: "controlled" };
const usage = (fresh) => ({
  sessions: 1, input: fresh, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  fresh, total: fresh, usageCompleteness: "exact", model: "test/measurement-model", thinkingLevel: "medium"
});

function campaignFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-measurement-report-"));
  const runRoot = path.join(root, "run");
  fs.mkdirSync(runRoot);
  const campaign = openProductionBenchmarkCampaign({
    registryBase: path.join(root, "registry"), runRoot, runId: "measurement-test", suiteId: "production-v2",
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
  assert.match(renderBenchmarkHtml(report), /measurement-only-execution-no-release-claim/);
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

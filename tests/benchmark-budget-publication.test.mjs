import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openBenchmarkBudgetGovernor } from "../packages/piagent-core/benchmark/benchmark-budget-governor.js";
import { appendBenchmarkLedger, emptyBenchmarkLedgerBinding } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { summarizeBenchmark } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { openProductionBenchmarkCampaign } from "../packages/piagent-core/benchmark/benchmark-campaign.js";
import { finalizeProductionCampaignClaimOutcome } from "../scripts/benchmark-runner-finalization.mjs";
import { deferBenchmarkBudgetPublication, finalizeBenchmarkBudgetPublication,
  assertBenchmarkBudgetParentReceipts } from "../scripts/benchmark-budget-publication.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const stageId = "a".repeat(32);
function fixture(t, { allowed = true, withCampaign = false, freshThreshold = 1000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-budget-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runRoot = path.join(root, "run"); fs.mkdirSync(runRoot);
  const suite = JSON.parse(fs.readFileSync(new URL("../benchmarks/core-v1/suite.json", import.meta.url)));
  const run = { attemptId: "attempt-1", orderIndex: 1, scenarioId: suite.scenarios[0].id,
    surface: "piagent", repeat: 1, infrastructureAttempt: 1, durationSeconds: 1,
    resolved: true, grade: { passed: true, score: 10 }, scope: { passed: true },
    usageStatus: "measured", usage: { sessions: 1, input: 10, output: 0, cacheRead: 0,
      cacheWrite: 0, reasoning: 0, fresh: 10, total: 10, usageCompleteness: "exact" } };
  const runs = [run, { ...structuredClone(run), attemptId: "attempt-2", orderIndex: 2, surface: "raw-pi" }];
  const control = { schemaVersion: 1, kind: "benchmark-management-budget-v1", authorityDecision: "offline-test",
    policy: { semantics: "management-thresholds", maxProviderAttempts: 2, freshTokenThreshold: freshThreshold, activeWallTimeMsThreshold: 10000 },
    binding: { candidateDigest: "b".repeat(64), suiteDigest: "c".repeat(64), runRoot,
      execution: {}, plannedAttempts: runs.map(r => ({ orderIndex: r.orderIndex, scenarioId: r.scenarioId, surface: r.surface, repeat: 1 })) } };
  const policyPath = path.join(root, "policy.json"), statePath = path.join(root, "state.json");
  write(policyPath, control);
  control.identity = { schemaVersion: 1, policyPath, statePath, sha256: hash(fs.readFileSync(policyPath)) };
  const governor = openBenchmarkBudgetGovernor({ statePath, policy: control.policy, binding: control.binding, resume: false, now: () => 100 });
  t.after(() => governor.close());
  governor.startStage(stageId);
  let ledger = emptyBenchmarkLedgerBinding();
  for (const item of runs) {
    governor.startAttempt(item); governor.settleAttempt(item, item);
    ledger = appendBenchmarkLedger(path.join(runRoot, "runs.jsonl"), item, ledger);
  }
  const manifest = { runId: "run", suite: { id: suite.id }, suiteDigest: control.binding.suiteDigest,
    candidateProvenance: { contentDigest: control.binding.candidateDigest }, configurationDigest: "d".repeat(64),
    budgetControl: control.identity, order: runs.map(r => ({ scenarioId: r.scenarioId, surface: r.surface, repeat: 1 })), ledger };
  const report = summarizeBenchmark({ suite, runId: "run", repeats: 1, runs, environment: {
    suiteDigest: manifest.suiteDigest, configurationDigest: manifest.configurationDigest,
    candidateProvenance: { ...manifest.candidateProvenance, finalization: "matched" } } });
  report.ledger = ledger; report.comparison.tokenClaimAllowed = allowed;
  report.verdict = { status: allowed ? "PASS_VALID" : "FAIL_VALID" };
  report.goalAssessment = { status: allowed ? "GOAL_PASS" : "GOAL_FAIL", observedRequirementsPassed: allowed,
    claimAllowed: allowed, claimFailures: [], observed: {}, existingVerdict: report.verdict.status };
  let campaign;
  if (withCampaign) {
    campaign = openProductionBenchmarkCampaign({ registryBase: path.join(root, "campaigns"), suiteId: suite.id,
      runId: manifest.runId, runRoot, configurationDigest: manifest.configurationDigest,
      candidateDigest: manifest.candidateProvenance.contentDigest, suiteDigest: manifest.suiteDigest });
    t.after(() => campaign.close());
    for (const item of runs) { campaign.providerStarted(item); campaign.providerReturned(item); }
    manifest.campaign = campaign.binding; manifest.campaignEvidence = campaign.sealForClaim(runs);
  }
  write(path.join(runRoot, "run-manifest.json"), manifest);
  return { control, manifest, report, runRoot, run, runs, governor, campaign,
    pending() { deferBenchmarkBudgetPublication({ report, manifest, runRoot, stageId,
      expectedChildExitCode: allowed ? 0 : 1 }); write(path.join(runRoot, "report.json"), report); },
    finish(overrides = {}) {
      const accounting = governor.endStage(stageId); governor.close();
      return { ...accounting, launcherSucceeded: true, launcherErrors: [], processCleanup: { cleanupConfirmed: true }, ...overrides };
    } };
}
function finalize(value, launcherReceipt, overrides = {}) {
  return finalizeBenchmarkBudgetPublication({ control: value.control, stageId, launcherReceipt,
    childExitCode: 0, outerSucceeded: true, ...overrides });
}
const savedReport = value => JSON.parse(fs.readFileSync(path.join(value.runRoot, "report.json")));

test("core reports remain provisional, preserving observed verdict and metrics without a parent receipt", t => {
  const value = fixture(t); value.pending();
  assert.equal(value.report.verdict.status, "PASS_VALID");
  assert.equal(value.report.goalAssessment.observedRequirementsPassed, true);
  assert.equal(value.report.goalAssessment.status, "GOAL_CLAIM_WITHHELD");
  assert.equal(value.report.comparison.tokenClaimAllowed, false);
  assert.equal(value.report.publicationAuthorization.allowed, false);
  value.finish();
  assert.throws(() => assertBenchmarkBudgetParentReceipts(value.control), /receipt/i);
});

test("budgeted campaign remains claim-sealed until the parent authorizes publication", t => {
  const value = fixture(t, { withCampaign: true });
  finalizeProductionCampaignClaimOutcome({ productionCampaign: value.campaign, manifest: value.manifest,
    report: value.report, runRoot: value.runRoot, verifiedLedgerRecords: value.runs });
  assert.equal(value.campaign.snapshot().status, "claim-sealed");
  value.pending(); value.campaign.close();
  const receipt = finalize(value, value.finish());
  assert.equal(receipt.closureAllowed, true);
  const report = savedReport(value);
  assert.equal(report.publicationAuthorization.allowed, true);
  assert.equal(report.comparison.tokenClaimAllowed, true);
  assert.equal(report.goalAssessment.status, "GOAL_PASS");
  assert.equal(report.environment.campaignEvidence.status, "claim-passed");
  assertBenchmarkBudgetParentReceipts(value.control);
  for (const file of ["summary.txt", "report.md", "report.html"]) assert.match(fs.readFileSync(path.join(value.runRoot, file), "utf8"), /launcher-finalized/);
});

for (const [name, change] of [
  ["last-attempt policy drift", v => fs.appendFileSync(v.control.identity.policyPath, " ")],
  ["cleanup failure", (_v, receipt) => { receipt.processCleanup.cleanupConfirmed = false; }],
  ["launcher failure", (_v, receipt) => { receipt.launcherSucceeded = false; receipt.launcherErrors = ["watchdog"]; }],
  ["unknown usage", (_v, receipt) => { receipt.unknownAttempts = 1; receipt.usageComplete = false; }],
  ["wrong report identity", v => { const r = savedReport(v); r.runId = "other"; write(path.join(v.runRoot, "report.json"), r); }]
]) test(`${name} cannot promote a favorable report`, t => {
  const value = fixture(t); value.pending(); const accounting = value.finish(); change(value, accounting);
  const receipt = finalize(value, accounting);
  assert.equal(receipt.closureAllowed && receipt.publicationAllowed, false);
  assert.equal(savedReport(value).comparison.tokenClaimAllowed, false);
  assert.equal(savedReport(value).goalAssessment.claimAllowed, false);
});

test("finalizer failure and core crash leave durable no-claim receipts", t => {
  const value = fixture(t); value.pending(); value.finish();
  const receipt = finalize(value, null, { outerSucceeded: false, outerErrorCodes: ["finish-failed"] });
  assert.equal(receipt.closureAllowed, false); assert.equal(savedReport(value).comparison.tokenClaimAllowed, false);
  assert.throws(() => assertBenchmarkBudgetParentReceipts(value.control), /receipt/i);
});

test("exact management-threshold overshoot is disclosed, not treated as invalid measurement", t => {
  const value = fixture(t, { freshThreshold: 15 }); value.pending();
  const receipt = finalize(value, value.finish());
  assert.equal(receipt.closureAllowed, true); assert.equal(receipt.accounting.overshoot.freshTokens, 5);
  assert.equal(savedReport(value).comparison.tokenClaimAllowed, true);
});

test("valid closure never upgrades a prior failed verdict or goal", t => {
  const value = fixture(t, { allowed: false }); value.pending();
  const receipt = finalize(value, value.finish(), { childExitCode: 1 });
  assert.equal(receipt.closureAllowed, true);
  const report = savedReport(value);
  assert.equal(report.verdict.status, "FAIL_VALID"); assert.equal(report.goalAssessment.status, "GOAL_FAIL");
  assert.equal(report.comparison.tokenClaimAllowed, false); assert.equal(report.goalAssessment.claimAllowed, false);
});

test("a late core cleanup error cannot masquerade as a valid quality-failure exit", t => {
  const value = fixture(t); value.pending();
  const receipt = finalize(value, value.finish(), { childExitCode: 1 });
  assert.equal(receipt.closureAllowed, false);
  assert.equal(savedReport(value).verdict.status, "PASS_VALID");
  assert.equal(savedReport(value).comparison.tokenClaimAllowed, false);
});

test("closed stage without a core report can close accounting but never publish a claim", t => {
  const value = fixture(t); const receipt = finalize(value, value.finish());
  assert.equal(receipt.closureAllowed, true); assert.equal(receipt.publicationAllowed, false);
  assert.equal(fs.existsSync(path.join(value.runRoot, "report.json")), false);
  assertBenchmarkBudgetParentReceipts(value.control);
});

test("a paused stage with a late core error cannot authorize the next paid stage", t => {
  const value = fixture(t);
  const receipt = finalize(value, value.finish(), { childExitCode: 1 });
  assert.equal(receipt.closureAllowed, false); assert.equal(receipt.publicationAllowed, false);
  assert.throws(() => assertBenchmarkBudgetParentReceipts(value.control), /receipt/i);
});

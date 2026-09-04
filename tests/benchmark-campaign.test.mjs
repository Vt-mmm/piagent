import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openProductionBenchmarkCampaign,
  publicProductionBenchmarkCampaignEvidence
} from "../packages/piagent-core/benchmark/benchmark-campaign.js";
import {
  finalizeProductionCampaignClaimOutcome,
  finalizeProductionCampaignTerminalNoClaim,
  rollbackProductionCampaignPublication
} from "../scripts/benchmark-runner-finalization.mjs";

const digest = (value) => value.repeat(64);
const usage = (fresh, completeness = "exact") => ({
  sessions: 1,
  input: fresh,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  fresh,
  total: fresh,
  usageCompleteness: completeness
});
const attempt = (attemptId, surface = "piagent") => ({
  attemptId,
  orderIndex: surface === "piagent" ? 1 : 2,
  scenarioId: "scenario-a",
  surface,
  repeat: 1,
  infrastructureAttempt: 1
});
const acceptedRun = (identity) => ({ ...identity, infrastructureFailures: [] });

function fixture(t, suiteId = "production-v2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-campaign-test-"));
  const registryBase = path.join(root, "campaigns");
  const runRoot = path.join(root, "run-a");
  fs.mkdirSync(runRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    registryBase,
    suiteId,
    runId: "run-a",
    runRoot,
    configurationDigest: digest("a"),
    candidateDigest: digest("b"),
    suiteDigest: digest("c")
  };
}

function nextOutput(value, runId, overrides = {}) {
  const runRoot = path.join(path.dirname(value.runRoot), runId);
  fs.mkdirSync(runRoot, { recursive: true });
  return { ...value, runId, runRoot, ...overrides };
}

test("campaign binds exact output lineage and accounts every exact provider attempt", (t) => {
  const value = fixture(t);
  const campaign = openProductionBenchmarkCampaign(value);
  campaign.providerStarted(attempt("candidate-attempt"));
  campaign.providerReturned({ ...attempt("candidate-attempt"), usage: usage(60), usageStatus: "measured" });
  campaign.providerStarted(attempt("baseline-attempt", "codex-cli"));
  campaign.providerReturned({ ...attempt("baseline-attempt", "codex-cli"), usage: usage(100), usageStatus: "measured" });
  const evidence = campaign.snapshot();
  assert.equal(evidence.passed, true);
  assert.equal(evidence.providerStartedAttempts, 2);
  assert.equal(evidence.allAttempts.bySurface.piagent.tokens.fresh, 60);
  assert.equal(evidence.allAttempts.bySurface["codex-cli"].tokens.fresh, 100);
  const binding = campaign.binding;
  campaign.close();

  const resumed = openProductionBenchmarkCampaign({ ...value, existingBinding: binding });
  const stageTwo = { ...attempt("stage-two"), orderIndex: 3, repeat: 2 };
  resumed.providerStarted(stageTwo);
  resumed.providerReturned({ ...stageTwo, usage: usage(20), usageStatus: "measured" });
  assert.equal(resumed.binding.campaignId, binding.campaignId);
  assert.equal(resumed.snapshot().attemptLedger.records, 6);
  resumed.close();

  const foreignOutput = path.join(path.dirname(value.runRoot), "run-b");
  fs.mkdirSync(foreignOutput);
  assert.throws(() => openProductionBenchmarkCampaign({ ...value, runId: "run-b", runRoot: foreignOutput }), /resume that exact output/);
});

test("unknown, lower-bound, and unmatched provider attempts fail the campaign closed", (t) => {
  const lower = openProductionBenchmarkCampaign(fixture(t, "production-v2-lower"));
  lower.providerStarted(attempt("lower"));
  lower.providerReturned({ ...attempt("lower"), usage: usage(25, "lower-bound"), usageStatus: "measured-lower-bound" });
  assert.equal(lower.snapshot().passed, false);
  assert.equal(lower.snapshot().unknownAttempts, 1);
  assert.throws(() => lower.sealForClaim(), /cannot be sealed/);
  lower.close();

  const unmatched = openProductionBenchmarkCampaign(fixture(t, "production-v2-unmatched"));
  unmatched.providerStarted(attempt("unmatched"));
  assert.equal(unmatched.snapshot().passed, false);
  assert.equal(unmatched.snapshot().settledAttempts, 0);
  assert.throws(() => unmatched.sealForClaim(), /cannot be sealed/);
  unmatched.close();
});

test("duplicate start or return identities permanently invalidate the campaign ledger", (t) => {
  const duplicateStart = openProductionBenchmarkCampaign(fixture(t, "production-v2-duplicate-start"));
  duplicateStart.providerStarted(attempt("duplicate"));
  assert.throws(() => duplicateStart.providerStarted(attempt("duplicate")), /duplicate or malformed provider-start/);
  assert.equal(duplicateStart.snapshot().allAttempts.ledgerExact, false);
  assert.match(duplicateStart.snapshot().allAttempts.ledgerIssues.join(","), /duplicate-provider-start/);
  duplicateStart.close();

  const duplicateReturn = openProductionBenchmarkCampaign(fixture(t, "production-v2-duplicate-return"));
  duplicateReturn.providerStarted(attempt("duplicate"));
  duplicateReturn.providerReturned({ ...attempt("duplicate"), usage: usage(10), usageStatus: "measured" });
  assert.throws(() => duplicateReturn.providerReturned({ ...attempt("duplicate"), usage: usage(10), usageStatus: "measured" }), /duplicate, unmatched, or malformed provider-return/);
  assert.equal(duplicateReturn.snapshot().allAttempts.ledgerExact, false);
  assert.match(duplicateReturn.snapshot().allAttempts.ledgerIssues.join(","), /duplicate-provider-returned/);
  duplicateReturn.close();

  const duplicateCoordinate = openProductionBenchmarkCampaign(fixture(t, "production-v2-duplicate-coordinate"));
  duplicateCoordinate.providerStarted(attempt("first-id"));
  assert.throws(() => duplicateCoordinate.providerStarted(attempt("second-id")), /duplicate or malformed provider-start/);
  assert.match(duplicateCoordinate.snapshot().allAttempts.ledgerIssues.join(","), /duplicate-provider-coordinate/);
  duplicateCoordinate.close();
});

test("claim sealing requires exact accepted-run coverage and keeps a paid campaign active on mismatch", (t) => {
  const value = fixture(t, "production-v2-seal-coverage");
  const campaign = openProductionBenchmarkCampaign(value);
  campaign.providerStarted(attempt("paid-attempt"));
  campaign.providerReturned({ ...attempt("paid-attempt"), usage: usage(10), usageStatus: "measured" });
  assert.throws(() => campaign.sealForClaim([acceptedRun(attempt("different-attempt"))]), /exactly match/);
  campaign.close();

  const freshRoot = path.join(path.dirname(value.runRoot), "fresh-output");
  fs.mkdirSync(freshRoot);
  assert.throws(() => openProductionBenchmarkCampaign({ ...value, runId: "fresh-output", runRoot: freshRoot }), /resume that exact output/);
});

test("only a claim-passed campaign releases the same paid lineage for a new output", (t) => {
  const value = fixture(t, "production-v2-complete");
  const first = openProductionBenchmarkCampaign(value);
  first.providerStarted(attempt("first"));
  first.providerReturned({ ...attempt("first"), usage: usage(10), usageStatus: "measured" });
  assert.equal(first.sealForClaim([acceptedRun(attempt("first"))]).status, "claim-sealed");
  assert.equal(first.sealForClaim([acceptedRun(attempt("first"))]).status, "claim-sealed", "claim sealing is idempotent for provider-free finalization resume");
  assert.throws(() => first.providerStarted({ ...attempt("late"), orderIndex: 2 }), /no longer writable/);
  assert.equal(first.finalizeClaim({ allowed: true, reason: "release-token-claim-allowed" }).status, "claim-passed");
  first.close();

  const next = openProductionBenchmarkCampaign(nextOutput(value, "run-next"));
  assert.notEqual(next.binding.campaignId, first.binding.campaignId);
  next.close();
});

test("publication rollback removes favorable reports and durably invalidates sealed or passing claims", (t) => {
  const passingValue = fixture(t, "production-v3-publication-rollback");
  const passing = openProductionBenchmarkCampaign(passingValue);
  passing.providerStarted(attempt("passing"));
  passing.providerReturned({ ...attempt("passing"), usage: usage(10), usageStatus: "measured" });
  passing.sealForClaim([acceptedRun(attempt("passing"))]);
  passing.finalizeClaim({ allowed: true, reason: "release-token-claim-allowed" });
  for (const name of ["report.html", "summary.txt", "report.json"]) {
    fs.writeFileSync(path.join(passingValue.runRoot, name), "stale favorable result\n", { mode: 0o600 });
  }
  const manifest = { schemaVersion: 1, runId: passingValue.runId };
  const evidence = rollbackProductionCampaignPublication({
    productionCampaign: passing,
    manifest,
    runRoot: passingValue.runRoot,
    error: Object.assign(new Error("publication failed"), { code: "BENCHMARK_PUBLICATION_FAILED" })
  });
  assert.equal(evidence.status, "no-claim");
  assert.equal(evidence.claimOutcome.allowed, false);
  assert.equal(evidence.claimOutcome.reason, "publication-failed:BENCHMARK_PUBLICATION_FAILED");
  for (const name of ["report.html", "summary.txt", "report.json"]) {
    assert.equal(fs.existsSync(path.join(passingValue.runRoot, name)), false);
  }
  const persisted = JSON.parse(fs.readFileSync(path.join(passingValue.runRoot, "run-manifest.json"), "utf8"));
  assert.equal(persisted.campaignEvidence.status, "no-claim");
  passing.close();

  const sealedValue = nextOutput(passingValue, "sealed-run", {
    suiteId: "production-v3-sealed-publication-rollback",
    configurationDigest: digest("d")
  });
  const sealed = openProductionBenchmarkCampaign(sealedValue);
  sealed.providerStarted(attempt("sealed"));
  sealed.providerReturned({ ...attempt("sealed"), usage: usage(10), usageStatus: "measured" });
  sealed.sealForClaim([acceptedRun(attempt("sealed"))]);
  assert.equal(sealed.invalidateClaimPublication({ reason: "publication-failed:UNCLASSIFIED" }).status, "no-claim");
  assert.equal(sealed.snapshot().claimOutcome.allowed, false);
  sealed.close();
});

test("a completed no-claim run cannot be cherry-picked into a fresh same-lineage output", (t) => {
  const value = fixture(t, "production-v2-no-claim-lock");
  const first = openProductionBenchmarkCampaign(value);
  first.providerStarted(attempt("first"));
  first.providerReturned({ ...attempt("first"), usage: usage(10), usageStatus: "measured" });
  first.sealForClaim([acceptedRun(attempt("first"))]);
  assert.equal(first.finalizeClaim({ allowed: false, reason: "release-token-claim-not-allowed:gates-failed" }).status, "no-claim");
  const binding = first.binding;
  first.close();

  assert.throws(() => openProductionBenchmarkCampaign(nextOutput(value, "run-cherry-pick")), /resume that exact output/);
  const resumed = openProductionBenchmarkCampaign({ ...value, existingBinding: binding });
  assert.equal(resumed.snapshot().status, "no-claim");
  assert.equal(resumed.snapshot().claimReady, false);
  resumed.close();
});

test("a terminal paired stop finalizes exact partial spend as durable no-claim", (t) => {
  const value = fixture(t, "production-v2-terminal-stop");
  const campaign = openProductionBenchmarkCampaign(value);
  campaign.providerStarted(attempt("candidate"));
  campaign.providerReturned({ ...attempt("candidate"), usage: usage(60), usageStatus: "measured" });
  campaign.providerStarted(attempt("baseline", "codex-cli"));
  campaign.providerReturned({ ...attempt("baseline", "codex-cli"), usage: usage(100), usageStatus: "measured" });
  const runs = [
    acceptedRun(attempt("candidate")),
    acceptedRun(attempt("baseline", "codex-cli"))
  ];

  assert.throws(
    () => campaign.finalizeTerminalNoClaim({ reason: "terminal-stop:paired-outcome-floor-failed", runs: runs.slice(0, 1) }),
    /does not exactly match/
  );
  const manifest = { schemaVersion: 1 };
  const evidence = finalizeProductionCampaignTerminalNoClaim({
    productionCampaign: campaign,
    manifest,
    runRoot: value.runRoot,
    terminalStop: { reason: "paired-outcome-floor-failed" },
    runs
  });
  assert.equal(evidence.status, "no-claim");
  assert.equal(evidence.claimOutcome.allowed, false);
  assert.equal(evidence.claimOutcome.reason, "terminal-stop:paired-outcome-floor-failed");
  assert.equal(evidence.allAttempts.tokens.fresh, 160);
  assert.equal(evidence.allAttempts.complete, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(value.runRoot, "run-manifest.json"), "utf8"));
  assert.equal(persisted.campaignEvidence.status, "no-claim");
  assert.equal(persisted.campaignEvidence.allAttempts.tokens.fresh, 160);
  assert.throws(() => campaign.providerStarted({ ...attempt("late"), orderIndex: 3 }), /no longer writable/);
  campaign.close();

  assert.throws(
    () => openProductionBenchmarkCampaign(nextOutput(value, "run-after-terminal-stop")),
    /resume that exact output/
  );
});

test("a changed candidate starts a new campaign while retaining prior exact spend separately", (t) => {
  const value = fixture(t, "production-v2-changed-candidate");
  const first = openProductionBenchmarkCampaign(value);
  first.providerStarted(attempt("prior-paid"));
  first.providerReturned({ ...attempt("prior-paid"), usage: usage(37), usageStatus: "measured" });
  const priorManifestPath = path.join(first.binding.campaignRoot, "campaign.json");
  first.close();

  const next = openProductionBenchmarkCampaign(nextOutput(value, "run-changed-candidate", {
    candidateDigest: digest("d")
  }));
  const priorManifest = JSON.parse(fs.readFileSync(priorManifestPath, "utf8"));
  assert.equal(priorManifest.status, "superseded-changed-lineage-no-claim");
  assert.equal(priorManifest.claimOutcome.allowed, false);
  const evidence = next.snapshot();
  assert.equal(evidence.allAttempts.tokens.fresh, 0, "prior spend is not merged into the current-campaign ratio ledger");
  assert.equal(evidence.priorCampaignHistory.paidCampaigns, 1);
  assert.equal(evidence.priorCampaignHistory.providerStartedAttempts, 1);
  assert.equal(evidence.priorCampaignHistory.exactAttempts, 1);
  assert.equal(evidence.priorCampaignHistory.unknownAttempts, 0);
  assert.equal(evidence.priorCampaignHistory.exactUsageComplete, true);
  assert.equal(evidence.priorCampaignHistory.knownExactTokens.fresh, 37);
  assert.equal(evidence.priorCampaignHistory.entries[0].status, "superseded-changed-lineage-no-claim");
  next.close();

  assert.throws(
    () => openProductionBenchmarkCampaign(nextOutput(value, "run-cycle-back-to-failed-candidate")),
    /resume that exact output/,
    "cycling through another candidate cannot hide a retained same-lineage no-claim campaign"
  );
});

test("unknown prior usage remains visibly unavailable after a changed configuration", (t) => {
  const value = fixture(t, "production-v2-changed-config-unknown");
  const first = openProductionBenchmarkCampaign(value);
  first.providerStarted(attempt("unknown-prior"));
  first.close();

  const next = openProductionBenchmarkCampaign(nextOutput(value, "run-changed-config", {
    configurationDigest: digest("e")
  }));
  const history = next.snapshot().priorCampaignHistory;
  assert.equal(history.paidCampaigns, 1);
  assert.equal(history.providerStartedAttempts, 1);
  assert.equal(history.exactAttempts, 0);
  assert.equal(history.unknownAttempts, 1);
  assert.equal(history.exactUsageComplete, false);
  assert.equal(history.knownExactTokens.fresh, 0);
  next.close();
});

test("runner finalization records an explicit no-claim outcome instead of generic completion", (t) => {
  const value = fixture(t, "production-v2-finalization-outcome");
  const campaign = openProductionBenchmarkCampaign(value);
  campaign.providerStarted(attempt("paid"));
  campaign.providerReturned({ ...attempt("paid"), usage: usage(10), usageStatus: "measured" });
  campaign.sealForClaim([acceptedRun(attempt("paid"))]);
  const manifest = { schemaVersion: 1 };
  const report = {
    environment: {},
    comparison: { tokenClaimAllowed: false },
    verdict: { status: "thresholds-not-met" }
  };
  const evidence = finalizeProductionCampaignClaimOutcome({ productionCampaign: campaign, manifest, report, runRoot: value.runRoot });
  assert.equal(evidence.status, "no-claim");
  assert.deepEqual(evidence.claimOutcome.allowed, false);
  assert.equal(report.environment.campaignEvidence.status, "no-claim");
  assert.equal(report.comparison.campaignEvidence.status, "no-claim");
  const persisted = JSON.parse(fs.readFileSync(path.join(value.runRoot, "run-manifest.json"), "utf8"));
  assert.equal(persisted.campaignEvidence.status, "no-claim");
  assert.equal(persisted.campaignEvidence.claimOutcome.allowed, false);
  campaign.close();
});

test("a provider-free reservation can be superseded because it has no paid attempt", (t) => {
  const value = fixture(t, "production-v2-provider-free");
  const reserved = openProductionBenchmarkCampaign(value);
  const reservedManifest = path.join(reserved.binding.campaignRoot, "campaign.json");
  reserved.close();
  const nextRoot = path.join(path.dirname(value.runRoot), "run-provider-free-next");
  fs.mkdirSync(nextRoot);
  const next = openProductionBenchmarkCampaign({ ...value, runId: "run-provider-free-next", runRoot: nextRoot });
  assert.notEqual(next.binding.campaignId, reserved.binding.campaignId);
  assert.equal(next.snapshot().providerStartedAttempts, 0);
  assert.equal(JSON.parse(fs.readFileSync(reservedManifest, "utf8")).status, "superseded-before-provider-start");
  next.close();
});

test("public campaign evidence excludes private operator paths", (t) => {
  const value = fixture(t, "production-v2-public-evidence");
  const campaign = openProductionBenchmarkCampaign(value);
  const publicEvidence = publicProductionBenchmarkCampaignEvidence(campaign.snapshot());
  assert.equal(Object.hasOwn(publicEvidence, "runRoot"), false);
  assert.equal(Object.hasOwn(publicEvidence, "campaignRoot"), false);
  assert.equal(JSON.stringify(publicEvidence).includes(path.dirname(value.runRoot)), false);
  const privatePath = path.join(path.dirname(value.runRoot), "private-history");
  const tainted = publicProductionBenchmarkCampaignEvidence({
    ...campaign.snapshot(),
    claimOutcome: { allowed: false, reason: privatePath, finalizedAt: privatePath },
    priorCampaignHistory: {
      ...campaign.snapshot().priorCampaignHistory,
      privatePath,
      bySurface: { [privatePath]: { attempts: 1, tokens: usage(1) } },
      entries: [{ campaignId: privatePath, status: "no-claim", claimOutcome: { allowed: false, reason: privatePath, finalizedAt: privatePath } }]
    }
  });
  assert.equal(JSON.stringify(tainted).includes(privatePath), false);
  assert.equal(tainted.claimOutcome.reason, "private-or-invalid-reason-withheld");
  assert.equal(tainted.priorCampaignHistory.entries[0].campaignId, "withheld");
  campaign.close();
});

test("campaign registry rejects path-shaped suite identifiers before creating state", (t) => {
  const value = fixture(t, "production-v2-safe-id");
  assert.throws(
    () => openProductionBenchmarkCampaign({ ...value, suiteId: "../private-campaign" }),
    /suite id is malformed/
  );
});

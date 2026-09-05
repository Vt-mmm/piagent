import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { assessProductionV3Goal } from "../packages/piagent-core/benchmark/benchmark-goal-assessment.js";
import { familyClusteredFixedWorkloadUsage } from "../packages/piagent-core/benchmark/benchmark-comparison.js";
import { attachBenchmarkGoalAssessment, renderBenchmarkGoalHtml, renderBenchmarkGoalMarkdown } from "../packages/piagent-core/benchmark/benchmark-goal-report.js";
import { summarizeBenchmark } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { renderBenchmarkHtml, renderBenchmarkMarkdown, renderBenchmarkText } from "../packages/piagent-core/benchmark/benchmark-report.js";

// Synthetic records only: no provider, retained campaign, or runtime invocation.
const suite = JSON.parse(fs.readFileSync(new URL("../benchmarks/production-v3/suite.json", import.meta.url), "utf8"));
const hash = character => character.repeat(64);
const usage = fresh => ({ sessions: 1, input: fresh, output: 0, cacheRead: 0, cacheWrite: 0,
  reasoning: 0, fresh, total: fresh, usageCompleteness: "exact" });
function fixture() {
  const runs = suite.scenarios.flatMap(scenario => [1, 2].flatMap(repeat => ["piagent", "codex-cli"].map(surface => ({
    runId: "goal-fixture", scenarioId: scenario.id, scenarioKind: scenario.kind, familyId: scenario.familyId,
    surface, repeat, configurationDigest: hash("a"), promptHash: hash("b"),
    variant: { generated: true, fixtureDigest: hash("c"), seedDigest: hash("d"), oracleDigest: hash("e") },
    resolved: true, runValidity: "valid", failureClass: null,
    outcome: { runValidity: "valid", usageStatus: "exact", failureClass: null,
      semanticStatus: scenario.kind === "safety-refusal" ? "refused_correctly" : "pass",
      taskStatus: scenario.kind === "safety-refusal" ? "refused" : "completed", gradeStatus: "pass" },
    graderIntegrity: { passed: true }, grade: { passed: true, score: 10 },
    scope: { passed: true }, outputSafety: { passed: true }, outputEvidence: { passed: true },
    safetyEvidence: { protectedReadObserved: false, destructiveActionObserved: false },
    workflow: surface === "piagent" ? { score: 10, checks: [{ id: "completion", passed: true }] } : null,
    infrastructureRetries: 0, infrastructureFailures: [],
    usage: usage(surface === "piagent" ? 600 : 1000), durationSeconds: surface === "piagent" ? 9 : 10
  }))));
  runs.forEach((run, index) => Object.assign(run, { orderIndex: index + 1,
    attemptId: `attempt-${index}`, sessionId: `session-${index}` }));
  const comparison = Object.fromEntries(["canonicalProductionIdentityGate", "releaseClaimConfigurationGate",
    "codexBaselineGate", "cleanReleaseSourceGate", "fullSuiteGate", "providerWireSurfaceGate", "fastServiceTierGate",
    "causalContextEvidenceGate", "acceptedUsageCompletenessGate", "allAttemptUsageCompletenessGate",
    "infrastructureFailureLedgerGate", "infrastructureRetryGate", "unknownInfrastructureUsageGate",
    "campaignAccountingGate", "productionProviderFreeEvidenceGate", "adaptiveContextRuntimeGate"].map(key => [key, true]));
  Object.assign(comparison, { comparisonProtocolGate: { passed: true }, productionGate: { passed: true },
    tokenClaimAllowed: true, claimEligibility: { achievedTier: "public-regression", generalizationClaimAllowed: false,
      limitations: ["human-calibration-waived"] } });
  const ledger = { schemaVersion: 1, algorithm: "sha256-chain-jsonl-v1", digest: hash("f"), records: 108, bytes: 108 };
  const report = { suite: { id: "production-v3" }, runId: "goal-fixture", runCount: 108, repeats: 2, runs,
    environment: { executionMode: "release-gated", configurationDigest: hash("a"),
      candidateProvenance: { contentDigest: hash("1"), finalization: "matched" } },
    comparison, ledger, verdict: { status: "PASS_VALID", measurementValidity: { passed: true, failures: [] } } };
  return { suite: structuredClone(suite), report, bindings: { expectedOrder: runs.map(({ scenarioId, repeat, surface }) => ({ scenarioId, repeat, surface })),
    expectedLedger: ledger, verifiedLedgerRecords: structuredClone(runs),
    expectedCandidateDigest: hash("1"), expectedConfigurationDigest: hash("a") } };
}
function evaluateChanged(change) {
  const input = fixture(); change(input);
  input.bindings.verifiedLedgerRecords = structuredClone(input.report.runs);
  return assessProductionV3Goal(input);
}

test("full 108 exact paired records pass the stricter observed goal without modifying the old report", () => {
  const input = fixture(), before = structuredClone(input);
  const result = assessProductionV3Goal(input);
  assert.deepEqual(input, before);
  assert.equal(result.status, "GOAL_PASS");
  assert.equal(result.observedRequirementsPassed, true);
  assert.equal(result.claimAllowed, true);
  assert.equal(result.pairs.length, 54);
  assert.equal(result.scenarios.length, 27);
  assert.equal(result.pairs.every(pair => pair.passed), true);
  assert.equal(result.scenarios.every(scenario => scenario.passed), true);
  assert.deepEqual(result.latency.piagent, { attempts: 54, availableAttempts: 54, complete: true, medianSeconds: 9, p95Seconds: 9 });
  assert.deepEqual(result.latency["codex-cli"], { attempts: 54, availableAttempts: 54, complete: true, medianSeconds: 10, p95Seconds: 10 });
  assert.equal(result.scenarios[0].latency.piagent.p95Seconds, 9);
  assert.equal(result.claimBoundary.generalizationClaimAllowed, false);
  assert.equal(result.claimBoundary.universalClaimAllowed, false);
  assert.deepEqual(result.claimBoundary.limitations, ["human-calibration-waived"]);
});

test("family and pooled success cannot hide one scenario that spends twice the baseline", () => {
  const input = fixture();
  for (const run of input.report.runs.filter(run => run.surface === "piagent")) {
    run.usage = usage(run.scenarioId === suite.scenarios[0].id ? 2000 : 100);
  }
  input.bindings.verifiedLedgerRecords = structuredClone(input.report.runs);
  const pairs = input.report.runs.filter(run => run.surface === "piagent").map(candidate => ({ candidate,
    baseline: input.report.runs.find(run => run.surface === "codex-cli" && run.scenarioId === candidate.scenarioId && run.repeat === candidate.repeat) }));
  const aggregate = familyClusteredFixedWorkloadUsage(suite, pairs, 2);
  assert.ok(aggregate.confidence95Raw.upper < 0.60);
  assert.ok(aggregate.aggregateFreshTokenRatio < 0.65);
  const result = assessProductionV3Goal(input);
  assert.equal(result.status, "GOAL_FAIL");
  assert.equal(result.scenarios[0].freshTokenRatio, 2);
  assert.equal(result.pairs.filter(pair => !pair.freshTokenGate).length, 2);
});

test("scenario pooled success cannot hide one failing repeat; exact 0.65 boundary passes", () => {
  const boundary = evaluateChanged(({ report }) => { report.runs[0].usage = usage(650); });
  assert.equal(boundary.status, "GOAL_PASS");
  const result = evaluateChanged(({ report }) => {
    report.runs[0].usage = usage(100);
    report.runs[2].usage = usage(1200);
  });
  assert.equal(result.scenarios[0].freshTokenRatio, 0.65);
  assert.equal(result.status, "GOAL_FAIL");
  assert.equal(result.pairs[1].freshTokenGate, false);
});

test("one slower pair fails even when median and P95 still improve", () => {
  const result = evaluateChanged(({ report }) => { report.runs[0].durationSeconds = 11; });
  assert.equal(result.status, "GOAL_FAIL");
  assert.equal(result.pairs[0].durationGate, false);
  assert.equal(result.latency.piagent.medianSeconds, 9);
  assert.equal(result.latency.piagent.p95Seconds, 9);
  assert.equal(result.scenarios[0].latency.piagent.p95Seconds, 11);
});

test("nearest-rank global P95 uses rank 52 of 54 and per-scenario rank 2", () => {
  const result = evaluateChanged(({ report }) => {
    report.runs.filter(run => run.surface === "piagent").forEach((run, index) => { run.durationSeconds = index + 1; });
    report.runs.filter(run => run.surface === "codex-cli").forEach(run => { run.durationSeconds = 100; });
  });
  assert.equal(result.latency.piagent.medianSeconds, 27.5);
  assert.equal(result.latency.piagent.p95Seconds, 52);
  assert.equal(result.scenarios[0].latency.piagent.p95Seconds, 2);
});

for (const [name, change] of [
  ["grade", run => { run.grade.score = 9.6; }],
  ["resolved", run => { run.resolved = false; }],
  ["safety", run => { run.safetyEvidence.protectedReadObserved = true; }],
  ["workflow", run => { run.workflow.checks[0].passed = false; }],
  ["scope", run => { run.scope.passed = false; }],
  ["output evidence", run => { run.outputEvidence.passed = false; }]
]) test(`a ${name} regression is visible and cannot be offset by token savings`, () => {
  const result = evaluateChanged(({ report }) => change(report.runs[0]));
  assert.equal(result.status, "GOAL_FAIL");
  assert.equal(result.observedRequirementsPassed, false);
  assert.equal(result.scenarios[0].usage.piagent.freshTokens, 1200);
});

test("baseline and candidate valid failures remain in fresh spend and latency", () => {
  const result = evaluateChanged(({ report }) => {
    for (const run of report.runs.slice(0, 2)) {
      run.resolved = false; run.grade = { passed: false, score: 0 };
      run.failureClass = run.outcome.failureClass = "agent_task_failure";
      run.outcome.semanticStatus = "fail"; run.outcome.taskStatus = "failed"; run.outcome.gradeStatus = "fail";
    }
  });
  assert.equal(result.status, "GOAL_FAIL");
  assert.equal(result.usage.piagent.freshTokens, 32400);
  assert.equal(result.usage["codex-cli"].freshTokens, 54000);
  assert.equal(result.latency.piagent.attempts, 54);
});

for (const [name, change] of [
  ["missing cell", ({ report }) => { report.runs.pop(); }],
  ["duplicate cell", ({ report }) => { report.runs[1] = structuredClone(report.runs[0]); }],
  ["unknown usage", ({ report }) => { report.runs[0].outcome.usageStatus = "unknown_post_provider"; }],
  ["zero baseline fresh", ({ report }) => { report.runs[1].usage = usage(0); }],
  ["missing duration", ({ report }) => { delete report.runs[0].durationSeconds; }],
  ["negative duration", ({ report }) => { report.runs[0].durationSeconds = -1; }],
  ["nonfinite duration", ({ report }) => { report.runs[0].durationSeconds = Infinity; }],
  ["zero baseline duration", ({ report }) => { report.runs[1].durationSeconds = 0; }],
  ["missing grade", ({ report }) => { delete report.runs[0].grade.score; }],
  ["configuration drift", ({ report }) => { report.runs[0].configurationDigest = hash("9"); }],
  ["candidate drift", ({ report }) => { report.environment.candidateProvenance.contentDigest = hash("9"); }],
  ["missing candidate binding", ({ bindings }) => { delete bindings.expectedCandidateDigest; }],
  ["fixture mismatch", ({ report }) => { report.runs[1].variant.fixtureDigest = hash("9"); }],
  ["prompt mismatch", ({ report }) => { report.runs[1].promptHash = hash("9"); }],
  ["wrong frozen order", ({ bindings }) => { bindings.expectedOrder[0].scenarioId = "wrong"; }],
  ["upstream invalid measurement", ({ report }) => { report.comparison.campaignAccountingGate = false; }],
  ["upstream invalid verdict", ({ report }) => { report.verdict.status = "INVALID_MEASUREMENT"; }],
  ["invalid scenario declaration", ({ suite: declared }) => { declared.scenarios = [null]; }]
]) test(`${name} cannot produce a proved goal`, () => {
  const result = evaluateChanged(change);
  assert.equal(result.status, "GOAL_UNPROVEN");
  assert.equal(result.observedRequirementsPassed, false);
  assert.equal(result.claimAllowed, false);
  assert.ok(result.evidenceFailures.length > 0);
});

test("upstream claim failure is distinct from passing measured requirements", () => {
  const result = evaluateChanged(({ report }) => {
    report.verdict.status = "FAIL_VALID";
    report.comparison.tokenClaimAllowed = false;
    report.comparison.productionGate.passed = false;
  });
  assert.equal(result.observedRequirementsPassed, true);
  assert.equal(result.claimAllowed, false);
  assert.equal(result.status, "GOAL_CLAIM_WITHHELD");
  assert.ok(result.claimFailures.includes("upstream-verdict-not-PASS_VALID"));
});

test("the caller cannot assert a prior validity verdict over changed ledger content", () => {
  const input = fixture(); input.report.runs[0].usage = usage(500);
  const result = assessProductionV3Goal(input);
  assert.equal(result.status, "GOAL_UNPROVEN");
  assert.ok(result.evidenceFailures.includes("verified-ledger-records-mismatch"));
});

function reportingFixture() {
  const input = fixture();
  const summary = summarizeBenchmark({ suite: input.suite, runId: input.report.runId, repeats: 2,
    startedAt: "2026-09-05T00:00:00Z", completedAt: "2026-09-05T01:00:00Z",
    runs: input.report.runs, environment: input.report.environment,
    baselineSurface: "codex-cli", candidateSurface: "piagent" });
  input.report = { ...summary, ...input.report, comparison: { ...summary.comparison, ...input.report.comparison } };
  input.manifest = { order: input.bindings.expectedOrder, ledger: input.bindings.expectedLedger,
    candidateProvenance: { contentDigest: input.bindings.expectedCandidateDigest },
    configurationDigest: input.bindings.expectedConfigurationDigest };
  input.verifiedLedgerRecords = input.bindings.verifiedLedgerRecords;
  return input;
}

test("report integration adds JSON, Markdown, text and HTML goal evidence without changing existing verdicts or gates", () => {
  const input = reportingFixture(), before = structuredClone(input.report);
  attachBenchmarkGoalAssessment(input);
  const { goalAssessment, ...unchanged } = input.report;
  assert.deepEqual(unchanged, before);
  assert.equal(goalAssessment.status, "GOAL_PASS");
  const json = JSON.parse(JSON.stringify(input.report));
  assert.deepEqual(json.goalAssessment, goalAssessment);
  for (const rendered of [renderBenchmarkText(input.report), renderBenchmarkMarkdown(input.report), renderBenchmarkHtml(input.report)]) {
    assert.match(rendered, /Stricter every-pair goal assessment/);
    assert.match(rendered, /Stricter goal status: GOAL_PASS/);
    assert.match(rendered, /Observed requirements: PASS/);
    assert.match(rendered, /Goal claim eligible under existing gates: yes/);
    assert.match(rendered, /Existing production verdict \(unchanged\): PASS_VALID/);
    assert.match(rendered, /P95/);
    assert.match(rendered, /human-calibration-waived/);
    assert.match(rendered, /no universal/);
    for (const scenario of input.suite.scenarios) assert.ok(rendered.includes(scenario.id), scenario.id);
  }
});

test("report hook requires actual frozen bindings and cannot use matching report fields as a fallback", () => {
  for (const missing of ["candidateProvenance", "configurationDigest", "order", "ledger"]) {
    const input = reportingFixture(); delete input.manifest[missing];
    attachBenchmarkGoalAssessment(input);
    assert.equal(input.report.goalAssessment.status, "GOAL_UNPROVEN", missing);
    assert.equal(input.report.goalAssessment.claimAllowed, false, missing);
    assert.equal(input.report.verdict.status, "PASS_VALID", "old verdict is not rewritten");
  }
  const input = reportingFixture(); input.verifiedLedgerRecords = undefined;
  attachBenchmarkGoalAssessment(input);
  assert.equal(input.report.goalAssessment.status, "GOAL_UNPROVEN");
});

test("all report formats distinguish a valid observed failure from unchanged upstream PASS_VALID", () => {
  const input = reportingFixture(); input.report.runs[0].durationSeconds = 11;
  input.verifiedLedgerRecords = structuredClone(input.report.runs);
  attachBenchmarkGoalAssessment(input);
  assert.equal(input.report.goalAssessment.status, "GOAL_FAIL");
  for (const rendered of [renderBenchmarkText(input.report), renderBenchmarkMarkdown(input.report), renderBenchmarkHtml(input.report)]) {
    assert.match(rendered, /Stricter goal status: GOAL_FAIL/);
    assert.match(rendered, /Observed requirements: FAIL/);
    assert.match(rendered, /Existing production verdict \(unchanged\): PASS_VALID/);
    assert.match(rendered, /duration-no-regression/);
  }
});

test("renderers separately expose a measured pass with a withheld upstream claim", () => {
  const input = reportingFixture();
  input.report.verdict.status = "FAIL_VALID"; input.report.comparison.tokenClaimAllowed = false;
  attachBenchmarkGoalAssessment(input);
  for (const rendered of [renderBenchmarkText(input.report), renderBenchmarkMarkdown(input.report), renderBenchmarkHtml(input.report)]) {
    assert.match(rendered, /GOAL_CLAIM_WITHHELD/);
    assert.match(rendered, /Observed requirements: PASS/);
    assert.match(rendered, /Goal claim eligible under existing gates: no/);
    assert.match(rendered, /upstream-token-claim-withheld/);
  }
});

test("goal rendering escapes report-sourced labels and markdown retains arbitrary existing diagnostic text", () => {
  const input = reportingFixture(); attachBenchmarkGoalAssessment(input);
  input.report.goalAssessment.scenarios[0].scenarioId = "<script>alert(1)</script>|`";
  const html = renderBenchmarkGoalHtml(input.report.goalAssessment);
  const markdown = renderBenchmarkGoalMarkdown(input.report.goalAssessment);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(markdown.includes("&#124;&#96;"));
  input.report.runId = "untrusted\n```\ntext";
  assert.match(renderBenchmarkMarkdown(input.report), /````text/);
});

test("legacy non-v3 reports do not acquire or render a goal assessment", () => {
  const input = reportingFixture(); input.report.suite.id = "production-v2";
  const before = structuredClone(input.report);
  attachBenchmarkGoalAssessment(input);
  assert.deepEqual(input.report, before);
  assert.doesNotMatch(renderBenchmarkText(input.report), /Stricter every-pair goal assessment/);
  assert.doesNotMatch(renderBenchmarkHtml(input.report), /Stricter every-pair goal assessment/);
});

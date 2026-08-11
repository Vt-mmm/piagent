import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  aggregateSessionUsage,
  benchmarkAssuranceEvidenceValidationErrors,
  benchmarkClaimEligibility,
  benchmarkSuiteValidationErrors,
  createCodexExecJsonlCollector,
  evaluateWorkflowEvidence,
  parseCodexExecJsonl,
  renderBenchmarkText,
  summarizeBenchmark,
  validateBenchmarkSuite
} from "../packages/piagent-core/benchmark/benchmark-core.js";
import { taskWorkingTreeEvidenceDigest } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";

const suite = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/core-v1/suite.json"), "utf8"));
const productionSuite = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/production-v1/suite.json"), "utf8"));
const privateAssuranceEvidence = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/benchmark-assurance-evidence.valid.json"), "utf8"));
const treeDigest = (value) => versionWorkingTreeHash(value.repeat(64));
function workflowTree(files = ["src/a.js"], value = "a") {
  const finalFileDigests = Object.fromEntries(files.map((file) => [file, treeDigest(value)]));
  return {
    fields: {
      workingTreeDigestAlgorithm: "wt-content-v2",
      baselineChangedFiles: [],
      baselineFileDigests: {},
      finalWorkingTreeFiles: [...files],
      finalFileDigests
    },
    digest: workingTreeEvidenceDigest(finalFileDigests)
  };
}
function verifierEvidence(command, digest, order = 1, overrides = {}) {
  const timestamp = `2026-08-08T00:00:${String(order).padStart(2, "0")}.000Z`;
  return { command, exitCode: 0, observed: true, observedAt: timestamp, recordedAt: timestamp, matchedProfileCommand: true, preWorkingTreeDigest: digest, workingTreeDigest: digest, ...overrides };
}

test("mirrors the runtime UTF-8 byte order for Unicode task-tree paths", () => {
  const snapshot = { "src/ä.ts": treeDigest("a"), "src/z.ts": treeDigest("b") };
  const entries = Object.entries(snapshot).sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  const expected = `wt-content-v2:${crypto.createHash("sha256").update(`tree\0wt-content-v2\0${JSON.stringify(entries)}`).digest("hex")}`;
  assert.equal(taskWorkingTreeEvidenceDigest(snapshot), expected);
  assert.equal(taskWorkingTreeEvidenceDigest(snapshot), workingTreeEvidenceDigest(snapshot));
});

test("validates the built-in benchmark suite and rejects hidden schema drift", () => {
  assert.equal(validateBenchmarkSuite(suite), suite);
  const invalid = structuredClone(suite);
  invalid.scenarios[0].graderInstruction = "trust me";
  invalid.scenarios[1].fixture = "../outside";
  assert.match(benchmarkSuiteValidationErrors(invalid).join("; "), /unsupported field graderInstruction/);
  assert.match(benchmarkSuiteValidationErrors(invalid).join("; "), /fixture must stay inside/);
});

test("validates production schema metadata and generated scenario controls", () => {
  assert.equal(validateBenchmarkSuite(productionSuite), productionSuite);
  const invalid = structuredClone(productionSuite);
  delete invalid.scenarios[0].category;
  invalid.releaseGate.maximumFreshTokenRatioUpper95 = 0;
  invalid.releaseGate.minimumOutcomeScoreExclusive = 10;
  delete invalid.assurance.claimTier;
  delete invalid.releaseGate.minimumComparableEfficiencyScenarios;
  const errors = benchmarkSuiteValidationErrors(invalid).join("; ");
  assert.match(errors, /category is required/);
  assert.match(errors, /maximumFreshTokenRatioUpper95/);
  assert.match(errors, /minimumOutcomeScoreExclusive/);
  assert.match(errors, /assurance\.claimTier/);
  assert.match(errors, /minimumComparableEfficiencyScenarios/);
});

test("fails closed on generalization claims until holdout, mutation, calibration, and frozen-candidate evidence are bound", () => {
  const publicClaim = benchmarkClaimEligibility({
    suite: productionSuite,
    environment: productionEnvironment(),
    baselineSurface: "raw-pi",
    protocolPassed: true,
    tokenClaimAllowed: true
  });
  assert.equal(publicClaim.achievedTier, "public-regression");
  assert.equal(publicClaim.generalizationClaimAllowed, false);
  assert.equal(publicClaim.causalAttributionAllowed, true);

  const assuranceFields = [
    "claimTier", "visibility", "familyDisjointSplit", "repositoryDisjointSplit", "holdoutManifestDigest",
    "referenceSolutionDigest", "mutationReportDigest", "calibrationReportDigest", "accessPolicyDigest",
    "disjointnessReportDigest", "humanRubricDigest", "disagreementReportDigest"
  ];
  const privateClaim = benchmarkClaimEligibility({
    suite: {
      ...productionSuite,
      assurance: {
        ...productionSuite.assurance,
        ...Object.fromEntries(assuranceFields.map((field) => [field, privateAssuranceEvidence[field]]))
      }
    },
    environment: {
      source: { kind: "git-working-tree", commit: "c".repeat(40), dirty: false },
      assuranceEvidence: {
        verified: true,
        manifestDigest: "e".repeat(64),
        accessReceiptCurrent: true,
        ...privateAssuranceEvidence
      }
    },
    baselineSurface: "codex-cli",
    protocolPassed: true,
    tokenClaimAllowed: true
  });
  assert.equal(privateClaim.achievedTier, "private-holdout");
  assert.equal(privateClaim.generalizationClaimAllowed, true);
  assert.equal(privateClaim.causalAttributionAllowed, false);
  assert.equal(privateClaim.comparisonPurpose, "external-product-reference");
  assert.equal(Object.values(privateClaim.privateHoldoutChecks).every(Boolean), true);

  const legacyEvidence = {
    schemaVersion: 1, claimTier: "private-holdout", visibility: "external-private-holdout", familyDisjointSplit: true,
    holdoutManifestDigest: "1".repeat(64), referenceSolutionDigest: "2".repeat(64), mutationReportDigest: "3".repeat(64), calibrationReportDigest: "4".repeat(64),
    referenceSolutions: { total: 1, passed: 1 }, mutationChecks: { total: 1, killed: 1 }, calibration: { sampleSize: 1, reviewerCount: 2, agreement: 1 }
  };
  assert.deepEqual(benchmarkAssuranceEvidenceValidationErrors(legacyEvidence), []);
  const legacyClaim = benchmarkClaimEligibility({
    suite: { ...productionSuite, assurance: { ...productionSuite.assurance, claimTier: "private-holdout", visibility: "external-private-holdout", familyDisjointSplit: true, holdoutManifestDigest: "1".repeat(64), referenceSolutionDigest: "2".repeat(64), mutationReportDigest: "3".repeat(64), calibrationReportDigest: "4".repeat(64) } },
    environment: { source: { commit: "c".repeat(40), dirty: false }, assuranceEvidence: { verified: true, manifestDigest: "e".repeat(64), ...legacyEvidence } },
    baselineSurface: "codex-cli"
  });
  assert.equal(legacyClaim.generalizationClaimAllowed, false);
  assert.equal(legacyClaim.privateHoldoutChecks["assurance-evidence-v2"], false);
});

test("assurance evidence rejects uncalibrated graders and surviving mutations", () => {
  assert.deepEqual(benchmarkAssuranceEvidenceValidationErrors(privateAssuranceEvidence), []);
  const invalid = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/benchmark-assurance-evidence.invalid.json"), "utf8"));
  const errors = benchmarkAssuranceEvidenceValidationErrors(invalid).join("; ");
  assert.match(errors, /every declared item killed/);
  assert.match(errors, /family and repository disjointness/);
  assert.match(errors, /deny candidate-author private access/);
  assert.match(errors, /record and resolve every sampled disagreement/);
});

test("aggregates exact Pi usage categories without folding cache into fresh tokens", () => {
  const usage = aggregateSessionUsage([{
    provider: "openai",
    modelId: "model-a",
    thinkingLevel: "high",
    isSubagent: false,
    tokens: { input: 100, output: 20, cacheRead: 500, cacheWrite: 10, reasoning: 7, total: 630, cost: 0.03 },
    contextUsage: { tokens: 12_000, contextWindow: 100_000, percent: 12 },
    messages: { total: 4, toolCalls: 2 },
    toolNames: { read: 1, bash: 1 }
  }]);
  assert.equal(usage.fresh, 120);
  assert.equal(usage.cacheRead, 500);
  assert.equal(usage.reasoning, 7);
  assert.equal(usage.model, "openai/model-a");
  assert.deepEqual(usage.contextUsage, { source: "session-reported", observations: 1, peakTokens: 12_000, contextWindow: 100_000, peakPercent: 12 });
  assert.deepEqual(usage.toolNames, { bash: 1, read: 1 });
});

test("parses Codex exec JSONL with cache-exclusive fresh tokens and completed tool events", () => {
  const stdout = [
    { type: "thread.started", thread_id: "codex-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "a", type: "agent_message", text: "working" } },
    { type: "item.started", item: { id: "b", type: "command_execution", status: "in_progress" } },
    { type: "item.completed", item: { id: "b", type: "command_execution", status: "completed" } },
    { type: "item.completed", item: { id: "c", type: "file_change", status: "completed" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 3, output_tokens: 15, reasoning_output_tokens: 5 } }
  ].map((event) => JSON.stringify(event)).join("\n");
  const usage = parseCodexExecJsonl(stdout, { model: "openai-codex/gpt-test", thinkingLevel: "high" });
  assert.equal(usage.providerInput, 100);
  assert.equal(usage.input, 60);
  assert.equal(usage.output, 15);
  assert.equal(usage.cacheRead, 40);
  assert.equal(usage.fresh, 75);
  assert.equal(usage.reasoning, 5);
  assert.equal(usage.cost, null);
  assert.equal(usage.providerSessionId, "codex-thread");
  assert.equal(usage.messages, 1);
  assert.equal(usage.contextUsage.source, "unavailable");
  assert.equal(usage.toolCalls, 2);
  assert.deepEqual(usage.toolNames, { command_execution: 1, file_change: 1 });
});

test("fails closed when Codex JSONL usage is missing, malformed, or internally inconsistent", () => {
  assert.throws(() => parseCodexExecJsonl('{"type":"thread.started","thread_id":"x"}\n'), /missing turn.completed usage/);
  assert.throws(() => parseCodexExecJsonl("not-json\n"), /line 1 is not valid JSON/);
  const invalid = [
    { type: "thread.started", thread_id: "x" },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 1 } }
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.throws(() => parseCodexExecJsonl(invalid), /cached_input_tokens exceeds input_tokens/);
});

test("streams Codex JSONL safely across UTF-8 and line chunk boundaries", () => {
  const collector = createCodexExecJsonlCollector({ model: "test/model", thinkingLevel: "high" });
  const value = [
    { type: "thread.started", thread_id: "stream-thread" },
    { type: "item.completed", item: { type: "agent_message", text: "Tiếng Việt" } },
    { type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } }
  ].map((event) => JSON.stringify(event)).join("\n");
  const bytes = Buffer.from(value);
  const split = bytes.indexOf(Buffer.from("ế")) + 1;
  collector.write(bytes.subarray(0, split));
  collector.write(bytes.subarray(split, split + 7));
  collector.write(bytes.subarray(split + 7));
  const usage = collector.finish();
  assert.equal(usage.fresh, 13);
  assert.equal(usage.messages, 1);
  assert.equal(usage.providerSessionId, "stream-thread");
});

test("retains bounded Codex error diagnostics without accepting missing usage", () => {
  const collector = createCodexExecJsonlCollector({ model: "test/model", thinkingLevel: "high" });
  collector.write(`${JSON.stringify({ type: "thread.started", thread_id: "failed-thread" })}\n`);
  collector.write(`${JSON.stringify({ type: "turn.failed", error: { message: "rate limit reached" } })}\n`);
  assert.throws(() => collector.finish(), /missing turn.completed usage/);
  assert.deepEqual(collector.diagnostics(), [{ type: "turn.failed", message: "rate limit reached" }]);
});

test("scores workflow evidence only when all configured verification and file claims are truthful", () => {
  const tree = workflowTree();
  const task = {
    schemaVersion: 2,
    taskRunId: "run",
    sessionId: "session",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test", "npm run lint"],
    verifyEvidence: [
      verifierEvidence("npm test", tree.digest, 1),
      verifierEvidence("npm run lint", tree.digest, 2)
    ],
    changedFiles: ["src/a.js"],
    ...tree.fields
  };
  const complete = evaluateWorkflowEvidence(task, ["src/a.js"], { piagent_task_start: 1, read: 2, bash: 1 });
  assert.equal(complete.score, 10);
  assert.deepEqual(complete.taskEvidence, {
    outcome: "completed",
    acceptance: { criteria: 0, satisfied: 0, critical: 0, criticalSatisfied: 0 }
  });
  task.verifyEvidence[1].preWorkingTreeDigest = treeDigest("c");
  const unstable = evaluateWorkflowEvidence(task, ["src/a.js"], { piagent_task_start: 1, read: 2, bash: 1 });
  assert.equal(unstable.checks.find((check) => check.id === "current-tree-evidence").passed, false);
  assert.equal(unstable.checks.find((check) => check.id === "observed-verification").passed, false);
  task.verifyEvidence[1].preWorkingTreeDigest = tree.digest;
  task.verifyEvidence.push(verifierEvidence("npm test", tree.digest, 10, { exitCode: 1 }));
  task.verifyEvidence.push(verifierEvidence("npm test", tree.digest, 5));
  assert.equal(evaluateWorkflowEvidence(task, ["src/a.js"]).checks.find((check) => check.id === "observed-verification").passed, false);
  task.verifyEvidence.push(verifierEvidence("npm test", tree.digest, 11));
  assert.equal(evaluateWorkflowEvidence(task, ["src/a.js"]).checks.find((check) => check.id === "observed-verification").passed, true);
  task.verifyEvidence.pop();
  assert.equal(evaluateWorkflowEvidence(task, ["src/a.js"], { piagent_task_start: 1, read: 2, bash: 1 }).score, 7.5);
});

test("workflow score separates raw task-start overhead from accepted persisted intake", () => {
  const tree = workflowTree();
  const task = {
    schemaVersion: 2,
    taskRunId: "run",
    sessionId: "session",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test"],
    verifyEvidence: [verifierEvidence("npm test", tree.digest)],
    changedFiles: ["src/a.js"],
    ...tree.fields
  };
  const workflow = evaluateWorkflowEvidence(task, ["src/a.js"], {
    piagent_task_start: 2,
    piagent_context_record: 1,
    piagent_verify_record: 1,
    piagent_task_gate_check: 1
  }, { acceptedTaskStartCount: 1 });
  assert.equal(workflow.score, 8.75);
  assert.deepEqual(workflow.choreography, {
    intakeMode: "model",
    taskStartCalls: 2,
    acceptedTaskStartCount: 1,
    runtimeManagedCalls: 3
  });
  assert.equal(workflow.checks.find((check) => check.id === "single-task-start").passed, true);
  assert.equal(workflow.checks.find((check) => check.id === "runtime-managed-evidence").passed, false);

  const duplicatePersisted = evaluateWorkflowEvidence(task, ["src/a.js"], { piagent_task_start: 2 }, {
    acceptedTaskStartCount: 2
  });
  assert.equal(duplicatePersisted.score, 8.75);
  assert.equal(duplicatePersisted.checks.find((check) => check.id === "single-task-start").passed, false);

  const missingPersisted = evaluateWorkflowEvidence(task, ["src/a.js"], { piagent_task_start: 1 }, {
    acceptedTaskStartCount: 0
  });
  assert.equal(missingPersisted.score, 8.75);
  assert.equal(missingPersisted.checks.find((check) => check.id === "single-task-start").passed, false);
});

test("workflow score accepts one persisted runtime intake without model choreography", () => {
  const tree = workflowTree();
  const task = {
    schemaVersion: 2,
    taskRunId: "runtime-run",
    sessionId: "runtime-session",
    intakeMode: "runtime",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test"],
    verifyEvidence: [verifierEvidence("npm test", tree.digest)],
    changedFiles: ["src/a.js"],
    ...tree.fields
  };
  const workflow = evaluateWorkflowEvidence(task, ["src/a.js"], { read: 1, edit: 1, bash: 1 });
  assert.equal(workflow.score, 10);
  assert.deepEqual(workflow.choreography, {
    intakeMode: "runtime",
    taskStartCalls: 0,
    acceptedTaskStartCount: 1,
    runtimeManagedCalls: 0
  });
});

test("workflow rejects acceptance evidence bound to a pre-repair working tree", () => {
  const oldTree = workflowTree(["src/a.js"], "a");
  const finalTree = workflowTree(["src/a.js"], "b");
  const oldDigest = oldTree.digest;
  const finalDigest = finalTree.digest;
  const task = {
    schemaVersion: 2,
    taskRunId: "runtime-run",
    sessionId: "runtime-session",
    intakeMode: "runtime",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test"],
    verifyEvidence: [
      verifierEvidence("npm test", oldDigest, 1),
      verifierEvidence("npm test", finalDigest, 2)
    ],
    acceptanceReceipt: {
      criteria: [{
        id: "critical-boundary",
        priority: "critical",
        status: "satisfied",
        evidence: [{ kind: "verifier-backed-focused-test", workingTreeDigest: oldDigest }]
      }]
    },
    changedFiles: ["src/a.js"],
    ...finalTree.fields
  };

  const stale = evaluateWorkflowEvidence(task, ["src/a.js"], { read: 1, edit: 1, bash: 1 });
  assert.equal(stale.checks.find((check) => check.id === "criterion-linked-evidence").passed, false);
  assert.equal(stale.score, 8.89);

  task.acceptanceReceipt.criteria[0].evidence.push({ kind: "verifier-backed-focused-test", workingTreeDigest: finalDigest });
  const current = evaluateWorkflowEvidence(task, ["src/a.js"], { read: 1, edit: 1, bash: 1 });
  assert.equal(current.checks.find((check) => check.id === "criterion-linked-evidence").passed, true);
  assert.equal(current.score, 10);

  task.verifyEvidence.at(-1).workingTreeDigest = "b".repeat(64);
  task.acceptanceReceipt.criteria[0].evidence = [{ kind: "verifier-backed-focused-test", workingTreeDigest: "b".repeat(64) }];
  const legacy = evaluateWorkflowEvidence(task, ["src/a.js"], { read: 1, edit: 1, bash: 1 });
  assert.equal(legacy.checks.find((check) => check.id === "observed-verification").passed, false);
  assert.equal(legacy.checks.find((check) => check.id === "criterion-linked-evidence").passed, false);
});

test("workflow reports advisory semantic evidence without lowering broad-default score", () => {
  const tree = workflowTree(["src/a.js"], "a");
  const task = {
    schemaVersion: 2,
    taskId: "advisory-task",
    taskRunId: "advisory-run",
    sessionId: "advisory-session",
    createdAt: "2026-08-08T00:00:00.000Z",
    intakeMode: "runtime",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test"],
    verifyEvidence: [verifierEvidence("npm test", tree.digest)],
    acceptanceReceipt: {
      criteria: [{ id: "advisory-tenant", priority: "critical", status: "pending", evidence: [] }]
    },
    changedFiles: ["src/a.js"],
    ...tree.fields
  };
  task.authoritySnapshot = createBoundTaskAuthority(task);
  const broad = evaluateWorkflowEvidence(task, ["src/a.js"], { read: 1, edit: 1, bash: 1 });
  assert.equal(broad.score, 10);
  assert.equal(broad.checks.some((check) => check.id === "criterion-linked-evidence"), false);
  assert.deepEqual(broad.taskEvidence.acceptance, { criteria: 1, satisfied: 0, critical: 1, criticalSatisfied: 0 });

  task.authoritySnapshot = createBoundTaskAuthority({ ...task, profile: "strict-high-risk" });
  const strict = evaluateWorkflowEvidence(task, ["src/a.js"], { read: 1, edit: 1, bash: 1 });
  assert.equal(strict.checks.find((check) => check.id === "criterion-linked-evidence").passed, false);
  assert.equal(strict.score, 8.89);
});

test("workflow score supports read-only tasks without inventing source verification", () => {
  const tree = workflowTree([]);
  const task = {
    schemaVersion: 2,
    taskRunId: "runtime-run",
    sessionId: "runtime-session",
    intakeMode: "runtime",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    acceptanceReceipt: {
      criteria: [{
        id: "read-only-answer",
        priority: "critical",
        status: "satisfied",
        evidence: [{ kind: "observed-context", paths: ["src/a.js"] }]
      }]
    },
    changedFiles: [],
    ...tree.fields
  };
  const workflow = evaluateWorkflowEvidence(task, [], { read: 2 }, { scenarioKind: "read-only" });
  assert.equal(workflow.score, 10);
  assert.equal(workflow.checks.some((check) => check.id === "observed-verification"), false);
  assert.equal(workflow.checks.find((check) => check.id === "truthful-no-changes").passed, true);

  task.workingTreeDigestAlgorithm = "legacy-untrusted";
  task.workingTreeDigestMigration = { status: "historical-unverifiable" };
  const legacy = evaluateWorkflowEvidence(task, [], { read: 2 }, { scenarioKind: "read-only" });
  assert.equal(legacy.checks.find((check) => check.id === "current-tree-evidence").passed, false);
  assert.equal(legacy.score, 8.75);

  task.workingTreeDigestAlgorithm = "wt-content-v2";
  task.workingTreeDigestMigration = null;
  assert.equal(evaluateWorkflowEvidence(task, [], { read: 2 }, { scenarioKind: "read-only" }).checks.find((check) => check.id === "current-tree-evidence").passed, false);
  task.workingTreeDigestMigration = { status: "refreshed" };
  assert.equal(evaluateWorkflowEvidence(task, [], { read: 2 }, { scenarioKind: "read-only" }).checks.find((check) => check.id === "current-tree-evidence").passed, false);
  task.workingTreeDigestMigration = {
    status: "refreshed",
    source: "legacy-unversioned",
    reasonCode: "clean-baseline-rebound",
    requiredAction: "none",
    archivePath: ".pi/piagent-state/digest-migrations/runtime-run.legacy.json",
    archiveDigest: "a".repeat(64),
    archiveBytes: 123,
    baselineEvidenceDigest: "b".repeat(64),
    finalEvidenceDigest: "c".repeat(64),
    recordedAt: "2026-08-08T00:00:00.000Z",
    refreshedAt: "2026-08-08T00:01:00.000Z"
  };
  // Measured benchmark tasks are always fresh; even a structurally complete
  // invented migration descriptor cannot substitute for archive/barrier proof.
  assert.equal(evaluateWorkflowEvidence(task, [], { read: 2 }, { scenarioKind: "read-only" }).checks.find((check) => check.id === "current-tree-evidence").passed, false);
});

function runRecord(scenario, surface, repeat, fresh) {
  return {
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
    category: scenario.category ?? "unspecified",
    difficulty: scenario.difficulty ?? "unspecified",
    profile: scenario.profile ?? "node-typescript",
    lifecycle: scenario.lifecycle ?? "steady-state",
    surface,
    repeat,
    resolved: true,
    grade: { passed: true, score: 10, checks: [] },
    graderIntegrity: { passed: true },
    scope: { passed: true, changedFiles: scenario.kind === "source-change" ? ["src/a.js"] : [], outsideScope: [] },
    outputSafety: { passed: true, forbiddenHits: [] },
    workflow: surface === "piagent" && scenario.kind === "source-change" ? { score: 10, checks: [] } : null,
    usage: { fresh, input: fresh - 10, output: 10, cacheRead: 0, reasoning: 0, cost: fresh / 100_000, sessions: 1, model: "test/model", thinkingLevel: "high", toolCalls: 2, toolNames: { read: 1, bash: 1 } },
    durationSeconds: 1
  };
}

function controlledCodexEnvironment(overrides = {}) {
  return {
    executionOrder: "paired-alternating",
    requestedModel: "test/fake-model",
    requestedThinking: "high",
    modelParityEvidence: "command-line-pinned",
    codexMode: "controlled",
    codexIsolation: "per-session-temporary-home",
    codexGlobalInstructions: "excluded",
    piagentTreatment: {
      id: "candidate",
      explicit: true,
      environment: {
        PIAGENT_SOLVER_MODE: "recommend",
        PIAGENT_PHASE_TOOLS: "on",
        PIAGENT_AUTO_RECOVERY: "on",
        PIAGENT_HELPERS_MODE: "recommend",
        PIAGENT_EXECUTION_BACKEND: "host"
      }
    },
    ...overrides
  };
}

function productionEnvironment(overrides = {}) {
  return {
    executionOrder: "seeded-paired-block-randomized",
    requestedModel: "test/model",
    requestedThinking: "high",
    modelParityEvidence: "session-reported",
    source: { kind: "git-working-tree", commit: "a".repeat(40), dirty: true },
    piagentTreatment: {
      id: "candidate",
      explicit: true,
      environment: {
        PIAGENT_SOLVER_MODE: "recommend",
        PIAGENT_PHASE_TOOLS: "on",
        PIAGENT_AUTO_RECOVERY: "on",
        PIAGENT_HELPERS_MODE: "recommend",
        PIAGENT_EXECUTION_BACKEND: "host"
      }
    },
    ...overrides
  };
}

test("allows an efficiency claim only after paired quality and safety gates pass", () => {
  const scenarios = suite.scenarios.slice(0, 2);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    for (const scenario of scenarios) {
      runs.push(runRecord(scenario, "raw-pi", repeat, 100));
      runs.push(runRecord(scenario, "piagent", repeat, 70));
    }
  }
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "run", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(report.measurementSchemaVersion, 2);
  assert.equal(report.comparison.pairedSuccessfulRuns, 6);
  assert.equal(report.comparison.pairedUsageRuns, 6);
  assert.equal(report.comparison.freshTokenDeltaPercent, -30);
  assert.equal(report.comparison.tokenClaimAllowed, true);
  assert.equal(report.comparison.workflowGate, true);
  assert.equal(report.surfaces.piagent.scores.overall, 10);

  runs.find((run) => run.surface === "piagent").outputSafety.passed = false;
  const unsafe = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "unsafe", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(unsafe.comparison.safetyGate, false);
  assert.equal(unsafe.comparison.tokenClaimAllowed, false);
  assert.equal(unsafe.surfaces.piagent.scores.overall, null);
});

test("keeps matched usage pairs when run scales differ", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const rawFresh = [100, 1_000, 10_000];
  const piagentFresh = [80, 1_100, 9_000];
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(runRecord(scenarios[0], "raw-pi", repeat, rawFresh[repeat - 1]));
    runs.push(runRecord(scenarios[0], "piagent", repeat, piagentFresh[repeat - 1]));
  }
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "paired", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.deepEqual(report.comparison.medianFreshTokens, { rawPi: 1_000, piagent: 1_100 });
  assert.equal(report.comparison.usageEstimator, "paired-geometric-mean-ratio");
  assert.equal(report.comparison.freshTokenDeltaPercent, -7.48);
  assert.deepEqual(report.comparison.pairedFreshTokenWins, { piagent: 2, rawPi: 1, ties: 0 });
  assert.equal(report.comparison.tokenClaimAllowed, true);
});

test("charges known failed-attempt usage without changing accepted-pair efficiency", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const baseline = runRecord(scenarios[0], "raw-pi", 1, 100);
  const candidate = runRecord(scenarios[0], "piagent", 1, 50);
  candidate.infrastructureFailures = [{
    attempt: 1,
    usageStatus: "measured",
    usage: { fresh: 100 }
  }];
  const report = summarizeBenchmark({
    suite: { ...suite, scenarios },
    runId: "failure-aware-known-usage",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:01:00.000Z",
    repeats: 1,
    runs: [baseline, candidate]
  });
  assert.deepEqual(report.comparison.medianFreshTokens, { rawPi: 100, piagent: 50 });
  assert.equal(report.comparison.freshTokenRatio, 0.5);
  assert.deepEqual(report.comparison.freshTokensPerResolvedOutcome, { rawPi: 100, piagent: 150 });
  assert.equal(report.comparison.failureAwareFreshTokenRatio, 1.5);
  assert.equal(report.comparison.failureAwareEfficiencyGate, false);
});

test("withholds failure-aware metrics and token claims for unknown provider-attempt usage", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const baseline = runRecord(scenarios[0], "raw-pi", 1, 100);
  const candidate = runRecord(scenarios[0], "piagent", 1, 50);
  candidate.infrastructureFailures = [{
    attempt: 1,
    usageStatus: "unknown-after-provider-start",
    usage: { fresh: 0 }
  }];
  const report = summarizeBenchmark({
    suite: { ...suite, scenarios },
    runId: "failure-aware-unknown-usage",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:01:00.000Z",
    repeats: 1,
    runs: [baseline, candidate]
  });
  assert.equal(report.comparison.freshTokenRatio, 0.5, "accepted usage remains independently observable");
  assert.equal(report.comparison.freshTokensPerResolvedOutcome.piagent, null);
  assert.equal(report.comparison.failureAwareFreshTokenRatio, null);
  assert.equal(report.comparison.failureAwareEfficiencyGate, null);
  assert.equal(report.comparison.tokenClaimAllowed, false);
});

test("uses Codex CLI as a dynamic paired baseline without inventing OAuth cost", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    const codex = runRecord(scenarios[0], "codex-cli", repeat, 100);
    codex.usage.cost = null;
    runs.push(codex);
    runs.push(runRecord(scenarios[0], "piagent", repeat, 70));
  }
  const report = summarizeBenchmark({
    suite: { ...suite, scenarios },
    runId: "codex-paired",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:01:00.000Z",
    repeats: 3,
    baselineSurface: "codex-cli",
    candidateSurface: "piagent",
    environment: controlledCodexEnvironment(),
    runs
  });
  assert.equal(report.surfaces.codexCli.resolved, 3);
  assert.equal(report.surfaces.piagent.resolved, 3);
  assert.equal(report.comparison.baselineSurface, "codex-cli");
  assert.deepEqual(report.comparison.pairedFreshTokenWins, { piagent: 3, codexCli: 0, ties: 0 });
  assert.equal(report.comparison.freshTokenDeltaPercent, -30);
  assert.equal(report.comparison.costDeltaPercent, null);
  assert.equal(report.comparison.pairedCostRuns, 0);
  assert.equal(report.comparison.comparisonProtocolGate.passed, true);
  assert.deepEqual(report.comparison.pairedOutcomes.resolved, {
    pairs: 3,
    bothPass: 3,
    candidateOnlyPass: 0,
    baselineOnlyPass: 0,
    bothFail: 0
  });
  assert.equal(report.comparison.pairedUsageBands.categories.unspecified.freshTokenRatio, 0.7);
  assert.equal(report.verdict.status, "piagent-more-efficient");
  assert.match(renderBenchmarkText(report), /Comparison: Piagent vs Codex CLI/);
  assert.match(renderBenchmarkText(report), /Comparison protocol gate: pass/);
  assert.match(renderBenchmarkText(report), /Cost delta: n\/a /);
});

test("withholds Codex token claims when isolation or Piagent treatment evidence is not controlled", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(runRecord(scenarios[0], "codex-cli", repeat, 100));
    runs.push(runRecord(scenarios[0], "piagent", repeat, 70));
  }
  const native = summarizeBenchmark({
    suite: { ...suite, scenarios },
    runId: "codex-native",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:01:00.000Z",
    repeats: 3,
    baselineSurface: "codex-cli",
    candidateSurface: "piagent",
    environment: controlledCodexEnvironment({ codexMode: "native", codexIsolation: "operator-home", codexGlobalInstructions: "operator-home" }),
    runs
  });
  assert.equal(native.comparison.comparisonProtocolGate.passed, false);
  assert.deepEqual(native.comparison.comparisonProtocolGate.failedChecks, ["codex-controlled-isolation"]);
  assert.equal(native.comparison.tokenClaimAllowed, false);
  assert.equal(native.surfaces.piagent.scores.overall, null);
  assert.equal(native.verdict.status, "comparison-protocol-gate-failed");

  const forgedTreatment = summarizeBenchmark({
    suite: { ...suite, scenarios },
    runId: "codex-forged-treatment",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:01:00.000Z",
    repeats: 3,
    baselineSurface: "codex-cli",
    candidateSurface: "piagent",
    environment: controlledCodexEnvironment({
      piagentTreatment: { id: "candidate", environment: { PIAGENT_SOLVER_MODE: "off" } }
    }),
    runs
  });
  assert.equal(forgedTreatment.comparison.comparisonProtocolGate.passed, false);
  assert.deepEqual(forgedTreatment.comparison.comparisonProtocolGate.failedChecks, ["piagent-treatment-recorded"]);
  assert.equal(forgedTreatment.comparison.tokenClaimAllowed, false);
});

test("refuses an efficiency claim when exact usage or model parity is missing", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(runRecord(scenarios[0], "raw-pi", repeat, 100));
    runs.push(runRecord(scenarios[0], "piagent", repeat, 60));
  }
  runs.find((run) => run.surface === "piagent").usage.model = "test/other-model";
  runs.find((run) => run.surface === "piagent" && run.repeat === 2).usage.fresh = 0;
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "usage", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(report.comparison.pairedSuccessfulRuns, 3);
  assert.equal(report.comparison.pairedUsageRuns, 1);
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.surfaces.piagent.scores.efficiency, 10);
  assert.equal(report.surfaces.piagent.scores.overall, null);
});

test("does not reward token savings when Piagent workflow evidence is incomplete", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(runRecord(scenarios[0], "raw-pi", repeat, 100));
    runs.push(runRecord(scenarios[0], "piagent", repeat, 60));
  }
  runs[0].workflow = null;
  runs.find((run) => run.surface === "piagent").workflow.score = 8;
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "workflow", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(report.comparison.workflowGate, false);
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.surfaces.piagent.scores.overall, null);
  assert.equal(report.verdict.status, "workflow-gate-failed");
});

test("blocks the verdict when Piagent source quality regresses", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(runRecord(scenarios[0], "raw-pi", repeat, 100));
    runs.push(runRecord(scenarios[0], "piagent", repeat, 60));
  }
  const regression = runs.find((run) => run.surface === "piagent");
  regression.resolved = false;
  regression.grade.passed = false;
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "quality", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(report.comparison.qualityNonInferior, false);
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.surfaces.piagent.scores.overall, null);
  assert.equal(report.verdict.status, "quality-regression");
});

test("uses the documented reliability formula and withholds overall below the release threshold", () => {
  const scenarios = [suite.scenarios[0], suite.scenarios[3]];
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    for (const scenario of scenarios) {
      runs.push(runRecord(scenario, "raw-pi", repeat, 100));
      runs.push(runRecord(scenario, "piagent", repeat, 70));
    }
  }
  runs.find((run) => run.surface === "piagent" && run.scenarioKind === "safety-refusal").resolved = false;
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "weights", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(report.surfaces.piagent.scores.reliability, 7.33);
  assert.equal(report.surfaces.piagent.scores.efficiency, 10);
  assert.equal(report.comparison.reliabilityGate, false);
  assert.equal(report.surfaces.piagent.scores.overall, null);
});

test("does not treat equally bad source quality as a passing release gate", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(runRecord(scenarios[0], "raw-pi", repeat, 100));
    runs.push(runRecord(scenarios[0], "piagent", repeat, 60));
  }
  for (const run of runs.filter((item) => item.repeat === 1)) {
    run.resolved = false;
    run.grade.passed = false;
  }
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "absolute-quality", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(report.comparison.qualityNonInferior, true);
  assert.equal(report.comparison.qualityGate, false);
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.verdict.status, "quality-gate-failed");
});

test("keeps hidden correctness separate from scope and end-to-end reliability", () => {
  const scenarios = suite.scenarios.slice(0, 1);
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    runs.push(runRecord(scenarios[0], "raw-pi", repeat, 100));
    runs.push(runRecord(scenarios[0], "piagent", repeat, 300));
  }
  for (const run of runs.filter((item) => item.surface === "piagent")) {
    run.resolved = false;
    run.scope = { passed: false, changedFiles: ["src/a.js", ".pi/context-index.json"], outsideScope: [".pi/context-index.json"] };
  }
  const report = summarizeBenchmark({ suite: { ...suite, scenarios }, runId: "scope", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, runs });
  assert.equal(report.surfaces.piagent.sourceCorrect, 3);
  assert.equal(report.surfaces.piagent.scores.quality, 10);
  assert.equal(report.surfaces.piagent.scores.safety, 5);
  assert.equal(report.surfaces.piagent.scores.reliability, 0);
  assert.equal(report.surfaces.piagent.usage.allMeasuredRuns.medianFreshTokens, 300);
  assert.equal(report.verdict.status, "safety-gate-failed");
});

test("production release gate uses independent scenario families and the upper 95 percent token bound", () => {
  const scenarios = productionSuite.scenarios.slice(0, 3);
  const testSuite = {
    ...productionSuite,
    scenarios,
    releaseGate: { ...productionSuite.releaseGate, minimumPairedScenarios: 3, minimumComparableEfficiencyScenarios: 3 }
  };
  const runs = [];
  const environment = productionEnvironment();
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    for (const scenario of scenarios) {
      runs.push(runRecord(scenario, "raw-pi", repeat, 100));
      runs.push(runRecord(scenario, "piagent", repeat, 80));
    }
  }
  const report = summarizeBenchmark({ suite: testSuite, runId: "production", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, environment, runs });
  assert.equal(report.comparison.pairedUsageRuns, 9);
  assert.equal(report.comparison.pairedUsageScenarios, 3);
  assert.equal(report.comparison.pairedCompleteScenarios, 3);
  assert.deepEqual(report.comparison.freshTokenRatioConfidence95, { lower: 0.8, upper: 0.8, sampleUnit: "scenario-family", scenarioCount: 3 });
  assert.equal(report.comparison.efficiencyConfidenceGate, true);
  assert.equal(report.comparison.productionGate.passed, true);

  testSuite.releaseGate = { ...testSuite.releaseGate, minimumPairedScenarios: 4 };
  const insufficient = summarizeBenchmark({ suite: testSuite, runId: "insufficient", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, environment, runs });
  assert.equal(insufficient.comparison.outcomeEvidenceGate, false);
  assert.equal(insufficient.comparison.efficiencyEvidenceGate, true);
  assert.equal(insufficient.comparison.productionGate.passed, false);

  testSuite.releaseGate = { ...testSuite.releaseGate, minimumPairedScenarios: 3 };
  runs.find((run) => run.surface === "piagent" && run.scenarioId === scenarios[0].id && run.repeat === 1).resolved = false;
  const incomplete = summarizeBenchmark({ suite: testSuite, runId: "incomplete", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", repeats: 3, environment, runs });
  assert.equal(incomplete.comparison.pairedUsageScenarios, 3);
  assert.equal(incomplete.comparison.pairedCompleteScenarios, 2);
  assert.equal(incomplete.comparison.efficiencyEvidenceGate, false);
});

test("keeps outcome coverage and failure-aware efficiency valid when the baseline fails", () => {
  const scenarios = productionSuite.scenarios.slice(0, 3);
  const testSuite = {
    ...productionSuite,
    scenarios,
    releaseGate: {
      ...productionSuite.releaseGate,
      minimumPairedScenarios: 3,
      minimumComparableEfficiencyScenarios: 2
    }
  };
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    for (const scenario of scenarios) {
      const baseline = runRecord(scenario, "raw-pi", repeat, 100);
      if (scenario.id === scenarios[0].id) {
        baseline.resolved = false;
        baseline.grade.passed = false;
        baseline.grade.score = 0;
      }
      runs.push(baseline);
      runs.push(runRecord(scenario, "piagent", repeat, 80));
    }
  }
  const report = summarizeBenchmark({
    suite: testSuite,
    runId: "baseline-failure-dominance",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:01:00.000Z",
    repeats: 3,
    environment: productionEnvironment(),
    runs
  });
  assert.equal(report.comparison.pairedOutcomeScenarios, 3);
  assert.equal(report.comparison.pairedCompleteScenarios, 2);
  assert.equal(report.comparison.outcomeEvidenceGate, true);
  assert.equal(report.comparison.efficiencyEvidenceGate, true);
  assert.equal(report.comparison.pairedOutcomes.resolved.candidateOnlyPass, 3);
  assert.equal(report.comparison.pairedRegressionGate, true);
  assert.equal(report.comparison.failureAwareEfficiencyGate, true);
  assert.equal(report.comparison.tokenClaimAllowed, true);
  assert.equal(report.comparison.claimEligibility.achievedTier, "public-regression");
  assert.equal(report.comparison.claimEligibility.generalizationClaimAllowed, false);
});

test("production gate rejects any task or band score at or below the exclusive 9.5 floor", () => {
  const scenarios = productionSuite.scenarios.slice(0, 3);
  const testSuite = {
    ...productionSuite,
    scenarios,
    releaseGate: { ...productionSuite.releaseGate, minimumPairedScenarios: 3, minimumComparableEfficiencyScenarios: 3 }
  };
  const runs = [];
  const environment = productionEnvironment();
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    for (const scenario of scenarios) {
      runs.push(runRecord(scenario, "raw-pi", repeat, 100));
      runs.push(runRecord(scenario, "piagent", repeat, 80));
    }
  }
  const low = runs.find((run) => run.surface === "piagent" && run.repeat === 1);
  low.workflow.score = 9.5;
  const report = summarizeBenchmark({
    suite: testSuite,
    runId: "strict-outcome-floor",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:01:00.000Z",
    repeats: 3,
    environment,
    runs
  });
  assert.equal(report.comparison.workflowGate, true, "aggregate workflow still clears the ordinary minimum");
  assert.equal(report.comparison.outcomeScoreGate, false);
  assert.deepEqual(report.comparison.outcomeScoreFailures, [{
    id: `task-workflow:${low.scenarioId}:r1`,
    score: 9.5
  }]);
  assert.equal(report.comparison.productionGate.passed, false);
  assert.ok(report.comparison.productionGate.failures.includes("outcome-score-floor"));
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.verdict.status, "outcome-score-floor-gate-failed");
});

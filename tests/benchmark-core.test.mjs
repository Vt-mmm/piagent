import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  aggregateSessionUsage,
  benchmarkSuiteValidationErrors,
  createCodexExecJsonlCollector,
  evaluateWorkflowEvidence,
  parseCodexExecJsonl,
  renderBenchmarkText,
  summarizeBenchmark,
  validateBenchmarkSuite
} from "../packages/piagent-core/benchmark/benchmark-core.js";

const suite = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/core-v1/suite.json"), "utf8"));

test("validates the built-in benchmark suite and rejects hidden schema drift", () => {
  assert.equal(validateBenchmarkSuite(suite), suite);
  const invalid = structuredClone(suite);
  invalid.scenarios[0].graderInstruction = "trust me";
  invalid.scenarios[1].fixture = "../outside";
  assert.match(benchmarkSuiteValidationErrors(invalid).join("; "), /unsupported field graderInstruction/);
  assert.match(benchmarkSuiteValidationErrors(invalid).join("; "), /fixture must stay inside/);
});

test("aggregates exact Pi usage categories without folding cache into fresh tokens", () => {
  const usage = aggregateSessionUsage([{
    provider: "openai",
    modelId: "model-a",
    thinkingLevel: "high",
    isSubagent: false,
    tokens: { input: 100, output: 20, cacheRead: 500, cacheWrite: 10, reasoning: 7, total: 630, cost: 0.03 },
    messages: { total: 4, toolCalls: 2 },
    toolNames: { read: 1, bash: 1 }
  }]);
  assert.equal(usage.fresh, 120);
  assert.equal(usage.cacheRead, 500);
  assert.equal(usage.reasoning, 7);
  assert.equal(usage.model, "openai/model-a");
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

test("scores workflow evidence only when all configured verification and file claims are truthful", () => {
  const task = {
    schemaVersion: 2,
    taskRunId: "run",
    sessionId: "session",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test", "npm run lint"],
    verifyEvidence: [
      { command: "npm test", exitCode: 0, observed: true, matchedProfileCommand: true },
      { command: "npm run lint", exitCode: 0, observed: true, matchedProfileCommand: true }
    ],
    changedFiles: ["src/a.js"]
  };
  assert.equal(evaluateWorkflowEvidence(task, ["src/a.js"], { piagent_task_start: 1, read: 2, bash: 1 }).score, 10);
  task.verifyEvidence.pop();
  assert.equal(evaluateWorkflowEvidence(task, ["src/a.js"], { piagent_task_start: 1, read: 2, bash: 1 }).score, 8.57);
});

test("workflow score rejects duplicate intake and manual evidence choreography", () => {
  const task = {
    schemaVersion: 2,
    taskRunId: "run",
    sessionId: "session",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, observed: true, matchedProfileCommand: true }],
    changedFiles: ["src/a.js"]
  };
  const workflow = evaluateWorkflowEvidence(task, ["src/a.js"], {
    piagent_task_start: 2,
    piagent_context_record: 1,
    piagent_verify_record: 1,
    piagent_task_gate_check: 1
  });
  assert.equal(workflow.score, 7.14);
  assert.deepEqual(workflow.choreography, { intakeMode: "model", taskStartCalls: 2, runtimeManagedCalls: 3 });
  assert.equal(workflow.checks.find((check) => check.id === "single-task-start").passed, false);
  assert.equal(workflow.checks.find((check) => check.id === "runtime-managed-evidence").passed, false);
});

test("workflow score accepts one persisted runtime intake without model choreography", () => {
  const task = {
    schemaVersion: 2,
    taskRunId: "runtime-run",
    sessionId: "runtime-session",
    intakeMode: "runtime",
    trace: { outcome: "completed" },
    workPlan: [{ status: "done" }],
    verifyCommands: ["npm test"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, observed: true, matchedProfileCommand: true }],
    changedFiles: ["src/a.js"]
  };
  const workflow = evaluateWorkflowEvidence(task, ["src/a.js"], { read: 1, edit: 1, bash: 1 });
  assert.equal(workflow.score, 10);
  assert.deepEqual(workflow.choreography, { intakeMode: "runtime", taskStartCalls: 0, runtimeManagedCalls: 0 });
});

function runRecord(scenario, surface, repeat, fresh) {
  return {
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
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
    runs
  });
  assert.equal(report.surfaces.codexCli.resolved, 3);
  assert.equal(report.surfaces.piagent.resolved, 3);
  assert.equal(report.comparison.baselineSurface, "codex-cli");
  assert.deepEqual(report.comparison.pairedFreshTokenWins, { piagent: 3, codexCli: 0, ties: 0 });
  assert.equal(report.comparison.freshTokenDeltaPercent, -30);
  assert.equal(report.comparison.costDeltaPercent, null);
  assert.equal(report.comparison.pairedCostRuns, 0);
  assert.equal(report.verdict.status, "piagent-more-efficient");
  assert.match(renderBenchmarkText(report), /Comparison: Piagent vs Codex CLI/);
  assert.match(renderBenchmarkText(report), /Cost delta: n\/a /);
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
  assert.equal(report.surfaces.piagent.scores.reliability, 3);
  assert.equal(report.surfaces.piagent.usage.allMeasuredRuns.medianFreshTokens, 300);
  assert.equal(report.verdict.status, "safety-gate-failed");
});

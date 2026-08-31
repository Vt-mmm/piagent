import assert from "node:assert/strict";
import test from "node:test";

import { benchmarkUsage, parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { benchmarkPreflightReceipt } from "../packages/piagent-core/benchmark/benchmark-preflight.js";
import { applyBenchmarkResumeOptions, benchmarkExecutionPlan } from "../scripts/benchmark-runner-support.mjs";

const conflicts = [
  ["--stop-after-failed-pair"],
  ["--scenarios", "public-case"],
  ["--replay-failures", "/tmp/public-report.json"],
  ["--max-runtime-minutes", "1"]
];

function resumeState(overrides = {}) {
  return {
    runRoot: "/tmp/measurement-options-run",
    manifest: {
      suite: { id: "production-v2" }, surfaces: ["piagent", "codex-cli"],
      model: "openai-codex/gpt-5.6-luna", thinking: "medium", serviceTier: "fast",
      rootSeed: "public-seed", repeats: 3, timeoutSeconds: 900,
      infrastructureRetries: 0, retryDelaySeconds: 0, stopAfterFailedPair: false,
      ...overrides
    }
  };
}

test("measurement-only is an explicit boolean opt-in with an observational claim boundary", () => {
  assert.equal(parseBenchmarkArgs([]).measurementOnly, false);
  assert.equal(parseBenchmarkArgs(["--measurement-only"]).measurementOnly, true);
  assert.match(benchmarkUsage, /--measurement-only\s+Observe the full production-v2 108-session matrix; no release claim/);
  assert.throws(() => parseBenchmarkArgs(["--measurement-only", "--measurement-only"]), /only be supplied once/);
  assert.throws(() => parseBenchmarkArgs(["--measurement-only", "false"]), /Unknown benchmark option/);
});

test("measurement-only rejects early quality stops and filtered/runtime-limited runs in either argument order", () => {
  for (const args of conflicts) {
    for (const argv of [["--measurement-only", ...args], [...args, "--measurement-only"]]) {
      assert.throws(() => parseBenchmarkArgs(argv), (error) => error.exitCode === 2
        && error.message.includes("--measurement-only") && error.message.includes(args[0]));
    }
    assert.equal(parseBenchmarkArgs(args).measurementOnly, false, "release options retain their existing syntax");
  }
});

test("measurement-only retains resumable session chunks and provider-free planning options", () => {
  const options = parseBenchmarkArgs(["--measurement-only", "--resume", "/tmp/measurement-options-run", "--max-sessions", "12"]);
  assert.equal(options.measurementOnly, true);
  assert.equal(options.maxSessions, 12);
  assert.equal(parseBenchmarkArgs(["--measurement-only", "--dry-run"]).dryRun, true);
  assert.equal(parseBenchmarkArgs(["--measurement-only", "--preflight-only"]).preflightOnly, true);
});

test("resume restores measurement mode from its manifest without requiring the flag again", () => {
  for (const args of [[], ["--measurement-only"]]) {
    const options = parseBenchmarkArgs([...args, "--resume", "/tmp/measurement-options-run", "--max-sessions", "12"]);
    applyBenchmarkResumeOptions(options, resumeState({ measurementOnly: true }));
    assert.equal(options.measurementOnly, true);
    assert.equal(options.suite, "production-v2");
    assert.equal(options.seed, "public-seed");
    assert.equal(options.maxSessions, 12);
    assert.equal(options.stopAfterFailedPair, false);
  }
});

test("a release manifest cannot be relabeled measurement-only on resume", () => {
  for (const overrides of [{}, { measurementOnly: false }]) {
    const options = parseBenchmarkArgs(["--measurement-only"]);
    const before = { ...options };
    assert.throws(() => applyBenchmarkResumeOptions(options, resumeState(overrides)), /Cannot enable --measurement-only on an existing release manifest/);
    assert.deepEqual(options, before, "mode conflict fails before modifying restored options");
    const release = parseBenchmarkArgs([]);
    applyBenchmarkResumeOptions(release, resumeState(overrides));
    assert.equal(release.measurementOnly, false);
  }
});

test("restored measurement mode rejects conflicting incoming and persisted options before overwriting them", () => {
  for (const args of conflicts) {
    const options = parseBenchmarkArgs(args);
    const before = { ...options };
    assert.throws(() => applyBenchmarkResumeOptions(options, resumeState({ measurementOnly: true })), /--measurement-only cannot be combined/);
    assert.deepEqual(options, before);
  }
  for (const overrides of [
    { stopAfterFailedPair: true }, { scenarioIds: ["public-case"] },
    { replayFailures: "/tmp/public-report.json" }, { replayRuns: [] },
    { replaySource: { runId: "prior" } }, { maxRuntimeMinutes: 1 }
  ]) {
    assert.throws(() => applyBenchmarkResumeOptions(parseBenchmarkArgs([]), resumeState({ measurementOnly: true, ...overrides })), /--measurement-only cannot be combined/);
  }
  for (const measurementOnly of [null, "true", 1, {}, []]) {
    assert.throws(() => applyBenchmarkResumeOptions(parseBenchmarkArgs([]), resumeState({ measurementOnly })), /measurementOnly must be a boolean/);
  }
});

test("preflight emits the mode only for true without changing legacy receipt shape", () => {
  const receipt = (mode) => benchmarkPreflightReceipt({
    packageVersion: "test", source: {}, candidateProvenance: {},
    suite: { id: "production-v2", scenarios: [] }, suiteDigest: "a".repeat(64),
    runtimeCommands: {}, environmentPolicy: { digest: "b".repeat(64) },
    configurationDigest: "c".repeat(64), rootSeedDigest: "d".repeat(64),
    options: { ...parseBenchmarkArgs([]), measurementOnly: mode },
    runtime: { gitVersion: "test", piVersion: "test", codexDisabledFeatures: [] }
  });
  const legacy = receipt(undefined);
  assert.equal(Object.hasOwn(legacy.configuration, "measurementOnly"), false);
  assert.deepEqual(receipt(false), legacy);
  const measurement = receipt(true);
  assert.equal(measurement.configuration.measurementOnly, true);
  delete measurement.configuration.measurementOnly;
  assert.deepEqual(measurement, legacy);
  assert.equal(measurement.providerSessionsStarted, 0);
  assert.match(measurement.claimBoundary, /no quality, workflow, token, latency, generalization, or release claim/);
});

test("execution plans label measurement-only as full108 observation with no release claim", () => {
  const plan = (measurementOnly) => benchmarkExecutionPlan({
    packageVersion: "test", suite: { id: "production-v2", scenarios: [], schemaVersion: 2 },
    declaredScenarioCount: 0, suiteDigest: "a".repeat(64),
    options: { ...parseBenchmarkArgs([]), model: "openai-codex/gpt-5.6-luna", thinking: "medium", measurementOnly },
    comparison: { candidateSurface: "piagent", baselineSurface: "codex-cli" },
    fullOrder: Array(108).fill({}), pendingOrder: [], order: [],
    lifecycles: ["steady-state"], rootSeedDigest: "b".repeat(64)
  }).plan;
  assert.match(plan(true), /mode:\s+measurement-only · full 108-session observation · no release claim/);
  assert.match(plan(true), /sessions:\s+108/);
  assert.doesNotMatch(plan(false), /measurement-only/);
});

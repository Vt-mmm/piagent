import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkHostReadinessPolicyDigest,
  benchmarkHostReadinessPolicyValidationErrors,
  benchmarkHostReadinessStartValidationErrors,
  collectBenchmarkHostReadinessReceipt,
  summarizeBenchmarkHostReadinessHistory,
  validateBenchmarkHostReadinessReceipt
} from "../packages/piagent-core/benchmark/benchmark-host-readiness.js";

const RUN_ID = "production-v1-20260823T000000Z-a1b2c3";
const OTHER_RUN_ID = "production-v1-20260823T010000Z-d4e5f6";
const CONFIGURATION_DIGEST = "a".repeat(64);
const OTHER_CONFIGURATION_DIGEST = "b".repeat(64);
const STAGE_BOUNDARIES = Object.freeze([0, 12, 36, 72, 108]);
const BASE_TIME = Date.parse("2026-08-23T00:00:00.000Z");

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    required: true,
    sampleCount: 3,
    sampleIntervalMilliseconds: 10,
    cpuSampleMilliseconds: 2,
    maximumNormalizedLoad1: 0.25,
    minimumCpuIdlePercent: 80,
    maximumTimingOverrunRatio: 0.25,
    maximumStartDelayMilliseconds: 120_000,
    failFast: true,
    ...overrides
  };
}

function cpuSnapshot({ user, idle, logicalCpuCount = 2 }) {
  return Array.from({ length: logicalCpuCount }, () => ({
    model: "must-not-enter-receipt",
    speed: 1,
    times: { user, nice: 0, sys: 0, idle, irq: 0 }
  }));
}

function deterministicDependencies({
  loads = [0.2, 0.2, 0.2],
  idlePercents = [80, 80, 80],
  platform = "darwin",
  architecture = "arm64",
  logicalCpuCount = 2,
  actualSleepMilliseconds = [],
  wallClockMilliseconds = BASE_TIME
} = {}) {
  let clock = 100;
  let cpuCall = 0;
  let loadCall = 0;
  let sleepCall = 0;
  const sleeps = [];
  const snapshots = [];
  let user = 1_000;
  let idle = 1_000;
  for (const idlePercent of idlePercents) {
    snapshots.push(cpuSnapshot({ user, idle, logicalCpuCount }));
    user += 100 - idlePercent;
    idle += idlePercent;
    snapshots.push(cpuSnapshot({ user, idle, logicalCpuCount }));
  }
  return {
    dependencies: {
      loadavg() { return [loads[loadCall++] ?? loads.at(-1), 0, 0]; },
      cpus() { return snapshots[cpuCall++] ?? snapshots.at(-1); },
      platform() { return platform; },
      arch() { return architecture; },
      monotonicNow() { return clock; },
      wallClockNow() { return wallClockMilliseconds; },
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        clock += actualSleepMilliseconds[sleepCall++] ?? milliseconds;
      }
    },
    sleeps
  };
}

async function receipt({
  readinessPolicy = policy(),
  runId = RUN_ID,
  configurationDigest = CONFIGURATION_DIGEST,
  completedRuns = 0,
  authorizedThroughRuns = 12,
  collectedAtMilliseconds = BASE_TIME,
  dependencies
} = {}) {
  const deterministic = dependencies ?? deterministicDependencies({
    wallClockMilliseconds: collectedAtMilliseconds
  }).dependencies;
  return collectBenchmarkHostReadinessReceipt({
    policy: readinessPolicy,
    runId,
    configurationDigest,
    completedRuns,
    authorizedThroughRuns
  }, deterministic);
}

function historyInput(receipts, overrides = {}) {
  return {
    policy: policy(),
    receipts,
    runId: RUN_ID,
    configurationDigest: CONFIGURATION_DIGEST,
    stageBoundaries: [...STAGE_BOUNDARIES],
    completedRuns: receipts.at(-1)?.completedRuns ?? 0,
    authorizedThroughRuns: receipts.at(-1)?.authorizedThroughRuns ?? 12,
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function allFieldNames(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (!Array.isArray(value)) output.push(...Object.keys(value));
  for (const child of Object.values(value)) allFieldNames(child, output);
  return output;
}

test("validates the closed timing policy and binds canonical key ordering", () => {
  const input = policy();
  assert.deepEqual(benchmarkHostReadinessPolicyValidationErrors(input), []);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(benchmarkHostReadinessPolicyDigest(reordered), benchmarkHostReadinessPolicyDigest(input));
  assert.match(benchmarkHostReadinessPolicyDigest(input), /^[a-f0-9]{64}$/);

  for (const [mutate, issue] of [
    [(value) => { value.extra = true; }, "unsupported-field"],
    [(value) => { value.sampleCount = 2; }, "sample-count-must-be-3"],
    [(value) => { value.required = false; }, "required-must-be-true"],
    [(value) => { value.failFast = false; }, "fail-fast-must-be-true"],
    [(value) => { value.maximumNormalizedLoad1 = 1.1; }, "maximum-normalized-load1-invalid"],
    [(value) => { value.minimumCpuIdlePercent = 101; }, "minimum-cpu-idle-percent-invalid"],
    [(value) => { value.maximumTimingOverrunRatio = 1.1; }, "maximum-timing-overrun-ratio-invalid"],
    [(value) => { value.maximumStartDelayMilliseconds = 0; }, "maximum-start-delay-milliseconds-invalid"]
  ]) {
    const changed = policy();
    mutate(changed);
    assert.ok(benchmarkHostReadinessPolicyValidationErrors(changed).some((error) => error.includes(issue)));
    assert.throws(() => benchmarkHostReadinessPolicyDigest(changed), { code: "BENCHMARK_HOST_READINESS_POLICY_INVALID" });
  }
});

test("collects a deterministic privacy-safe receipt bound to run, configuration and time", async () => {
  const deterministic = deterministicDependencies({ wallClockMilliseconds: BASE_TIME });
  const value = await receipt({
    completedRuns: 12,
    authorizedThroughRuns: 36,
    dependencies: deterministic.dependencies
  });
  assert.equal(value.status, "ready");
  assert.equal(value.runId, RUN_ID);
  assert.equal(value.configurationDigest, CONFIGURATION_DIGEST);
  assert.equal(value.collectedAt, "2026-08-23T00:00:00.000Z");
  assert.equal(value.completedRuns, 12);
  assert.equal(value.authorizedThroughRuns, 36);
  assert.equal(value.observedSamples, 3);
  assert.deepEqual(value.samples.map((sample) => sample.startedOffsetMilliseconds), [0, 10, 20]);
  assert.deepEqual(value.samples.map((sample) => sample.cpuWindowMilliseconds), [2, 2, 2]);
  assert.deepEqual(value.samples.map((sample) => sample.normalizedLoad1), [0.1, 0.1, 0.1]);
  assert.deepEqual(value.samples.map((sample) => sample.cpuIdlePercent), [80, 80, 80]);
  assert.deepEqual(deterministic.sleeps, [2, 8, 2, 8, 2]);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.samples), true);
  assert.equal(Object.isFrozen(value.samples[0]), true);

  const validated = validateBenchmarkHostReadinessReceipt(value, {
    policy: policy(),
    runId: RUN_ID,
    configurationDigest: CONFIGURATION_DIGEST,
    completedRuns: 12,
    authorizedThroughRuns: 36
  });
  assert.equal(validated.valid, true, validated.errors.join(", "));
  assert.equal(validated.ready, true);
  assert.match(value.digest, /^[a-f0-9]{64}$/);
  assert.match(value.hostFingerprint.digest, /^[a-f0-9]{64}$/);

  const names = allFieldNames(value).map((field) => field.toLowerCase());
  for (const prohibited of ["hostname", "process", "pid", "path", "command", "cwd"]) {
    assert.equal(names.some((field) => field.includes(prohibited)), false, prohibited);
  }
  assert.doesNotMatch(JSON.stringify(value), /must-not-enter-receipt/);
});

test("fails fast on normalized-load and CPU-idle violations", async () => {
  const overloaded = deterministicDependencies({ loads: [0.6] });
  const loadFailure = await receipt({ dependencies: overloaded.dependencies });
  assert.equal(loadFailure.status, "blocked");
  assert.equal(loadFailure.observedSamples, 1);
  assert.deepEqual(loadFailure.failureReasons, ["maximum-normalized-load1-exceeded"]);
  assert.deepEqual(overloaded.sleeps, [2]);

  const lowIdle = deterministicDependencies({ idlePercents: [90, 79, 95] });
  const idleFailure = await receipt({ dependencies: lowIdle.dependencies });
  assert.equal(idleFailure.status, "blocked");
  assert.equal(idleFailure.observedSamples, 2);
  assert.deepEqual(idleFailure.failureReasons, ["minimum-cpu-idle-percent-not-met"]);
  assert.deepEqual(lowIdle.sleeps, [2, 8, 2]);

  for (const value of [loadFailure, idleFailure]) {
    const validated = validateBenchmarkHostReadinessReceipt(value, {
      policy: policy(), runId: RUN_ID, configurationDigest: CONFIGURATION_DIGEST
    });
    assert.equal(validated.valid, true, validated.errors.join(", "));
    assert.equal(validated.ready, false);
  }
});

test("marks undersized, overlong and off-cadence samples blocked and fails fast", async () => {
  for (const [actualSleepMilliseconds, expectedFailure, expectedSamples] of [
    [[1], "cpu-sample-window-underrun", 1],
    [[3], "cpu-sample-window-overrun", 1],
    [[2, 6, 2], "sample-start-cadence-underrun", 2],
    [[2, 11, 2], "sample-start-cadence-overrun", 2]
  ]) {
    const deterministic = deterministicDependencies({ actualSleepMilliseconds });
    const value = await receipt({ dependencies: deterministic.dependencies });
    assert.equal(value.status, "blocked", expectedFailure);
    assert.equal(value.observedSamples, expectedSamples, expectedFailure);
    assert.ok(value.failureReasons.includes(expectedFailure), JSON.stringify(value.failureReasons));
    const validation = validateBenchmarkHostReadinessReceipt(value, {
      policy: policy(), runId: RUN_ID, configurationDigest: CONFIGURATION_DIGEST
    });
    assert.equal(validation.valid, true, validation.errors.join(", "));
    assert.equal(validation.ready, false);
  }
});

test("fails closed for invalid bindings, windows, CPU measurements and clocks", async () => {
  await assert.rejects(receipt({ completedRuns: 12, authorizedThroughRuns: 12 }), {
    code: "BENCHMARK_HOST_READINESS_WINDOW_INVALID"
  });
  await assert.rejects(receipt({ runId: "unsafe/run" }), {
    code: "BENCHMARK_HOST_READINESS_RUN_ID_INVALID"
  });
  await assert.rejects(receipt({ configurationDigest: "short" }), {
    code: "BENCHMARK_HOST_READINESS_CONFIGURATION_DIGEST_INVALID"
  });

  const topology = deterministicDependencies();
  const originalCpu = topology.dependencies.cpus;
  let calls = 0;
  topology.dependencies.cpus = () => {
    const value = originalCpu();
    calls += 1;
    return calls === 2 ? value.slice(0, 1) : value;
  };
  await assert.rejects(receipt({ dependencies: topology.dependencies }), {
    code: "BENCHMARK_HOST_READINESS_MEASUREMENT_INVALID"
  });

  const regressed = deterministicDependencies();
  const originalRegressedCpu = regressed.dependencies.cpus;
  let regressedCalls = 0;
  regressed.dependencies.cpus = () => {
    const value = clone(originalRegressedCpu());
    regressedCalls += 1;
    if (regressedCalls === 2) value[0].times.idle = 0;
    return value;
  };
  await assert.rejects(receipt({ dependencies: regressed.dependencies }), {
    code: "BENCHMARK_HOST_READINESS_MEASUREMENT_INVALID"
  });

  const monotonicClock = deterministicDependencies();
  monotonicClock.dependencies.monotonicNow = () => -1;
  await assert.rejects(receipt({ dependencies: monotonicClock.dependencies }), {
    code: "BENCHMARK_HOST_READINESS_MEASUREMENT_INVALID"
  });
  const wallClock = deterministicDependencies();
  wallClock.dependencies.wallClockNow = () => Number.NaN;
  await assert.rejects(receipt({ dependencies: wallClock.dependencies }), {
    code: "BENCHMARK_HOST_READINESS_MEASUREMENT_INVALID"
  });
});

test("receipt validation rejects tampering and cross-run or cross-configuration transplants", async () => {
  const original = await receipt();
  const cases = [
    [(value) => { value.samples[0].cpuIdlePercent = 99; }, {}, "receipt-digest-mismatch"],
    [(value) => { value.samples[0].passed = false; }, {}, "decision-mismatch"],
    [(value) => { value.completedRuns = 1; }, { completedRuns: 0 }, "completed-runs-mismatch"],
    [(value) => { value.hostFingerprint.architecture = "x64"; }, {}, "host-fingerprint-digest-mismatch"],
    [(value) => { value.policyDigest = "0".repeat(64); }, {}, "policy-digest-mismatch"],
    [(value) => { value.privatePath = "/private/value"; }, {}, "unsupported-field"],
    [(value) => { delete value.collectedAt; }, {}, "missing-field:collectedAt"],
    [(value) => { value.collectedAt = "yesterday"; }, {}, "collected-at-invalid"],
    [(value) => value, { runId: OTHER_RUN_ID }, "run-id-mismatch"],
    [(value) => value, { configurationDigest: OTHER_CONFIGURATION_DIGEST }, "configuration-digest-mismatch"]
  ];
  for (const [mutate, optionOverrides, expected] of cases) {
    const changed = clone(original);
    mutate(changed);
    const result = validateBenchmarkHostReadinessReceipt(changed, {
      policy: policy(),
      runId: RUN_ID,
      configurationDigest: CONFIGURATION_DIGEST,
      authorizedThroughRuns: 12,
      ...optionOverrides
    });
    assert.equal(result.valid, false, expected);
    assert.ok(result.errors.some((error) => error.includes(expected)), `${expected}: ${result.errors.join(", ")}`);
  }

  const missingExpectedBinding = validateBenchmarkHostReadinessReceipt(original, { policy: policy() });
  assert.equal(missingExpectedBinding.valid, false);
  assert.ok(missingExpectedBinding.errors.includes("host-readiness-receipt-expected-run-id-invalid"));
  assert.ok(missingExpectedBinding.errors.includes("host-readiness-receipt-expected-configuration-digest-invalid"));
});

test("start validation requires a ready bound receipt within the freshness window", async () => {
  const ready = await receipt();
  const common = { policy: policy(), runId: RUN_ID, configurationDigest: CONFIGURATION_DIGEST };
  assert.deepEqual(benchmarkHostReadinessStartValidationErrors(ready, {
    ...common,
    nowMilliseconds: BASE_TIME + policy().maximumStartDelayMilliseconds
  }), []);
  assert.ok(benchmarkHostReadinessStartValidationErrors(ready, {
    ...common,
    nowMilliseconds: BASE_TIME + policy().maximumStartDelayMilliseconds + 1
  }).includes("host-readiness-start-delay-exceeded"));
  assert.ok(benchmarkHostReadinessStartValidationErrors(ready, {
    ...common,
    nowMilliseconds: BASE_TIME - 1
  }).includes("host-readiness-start-receipt-from-future"));
  assert.ok(benchmarkHostReadinessStartValidationErrors(ready, {
    ...common,
    runId: OTHER_RUN_ID,
    nowMilliseconds: BASE_TIME
  }).includes("host-readiness-receipt-run-id-mismatch"));

  const blocked = await receipt({
    dependencies: deterministicDependencies({ loads: [0.6], wallClockMilliseconds: BASE_TIME }).dependencies
  });
  assert.ok(benchmarkHostReadinessStartValidationErrors(blocked, {
    ...common,
    nowMilliseconds: BASE_TIME
  }).includes("host-readiness-start-receipt-not-ready"));
});

test("history accepts fresh interior renewals and immediate frozen-stage advancement", async () => {
  const first = await receipt({ completedRuns: 0, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME });
  const renewal = await receipt({ completedRuns: 6, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME + 1 });
  const next = await receipt({ completedRuns: 12, authorizedThroughRuns: 36, collectedAtMilliseconds: BASE_TIME + 2 });
  const summary = summarizeBenchmarkHostReadinessHistory(historyInput([first, renewal, next], {
    completedRuns: 12,
    authorizedThroughRuns: 36
  }));
  assert.equal(summary.valid, true, summary.errors.join(", "));
  assert.equal(summary.ready, true);
  assert.equal(summary.receiptCount, 3);
  assert.equal(summary.validReceiptCount, 3);
  assert.equal(summary.hostFingerprintDigest, first.hostFingerprint.digest);
  assert.equal(summary.windowStartedAtRuns, 12);
  assert.equal(summary.windowCoverage, "not-started");
});

test("history rejects skipped frozen stages, gaps, regressions and replayed timestamps", async () => {
  const skipped = await receipt({ completedRuns: 0, authorizedThroughRuns: 108 });
  const skippedSummary = summarizeBenchmarkHostReadinessHistory(historyInput([skipped], {
    completedRuns: 0,
    authorizedThroughRuns: 108
  }));
  assert.equal(skippedSummary.valid, false);
  assert.ok(skippedSummary.errors.includes("host-readiness-history-skipped-stage-window:1"));

  const first = await receipt({ completedRuns: 0, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME });
  for (const [candidate, expected] of [
    [await receipt({ completedRuns: 13, authorizedThroughRuns: 36, collectedAtMilliseconds: BASE_TIME + 1 }), "window-gap"],
    [await receipt({ completedRuns: 11, authorizedThroughRuns: 36, collectedAtMilliseconds: BASE_TIME + 1 }), "window-discontinuity"],
    [await receipt({ completedRuns: 6, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME }), "collected-at-not-increasing"]
  ]) {
    const summary = summarizeBenchmarkHostReadinessHistory(historyInput([first, candidate], {
      completedRuns: candidate.completedRuns,
      authorizedThroughRuns: candidate.authorizedThroughRuns
    }));
    assert.equal(summary.valid, false, expected);
    assert.ok(summary.errors.some((error) => error.includes(expected)), `${expected}: ${summary.errors.join(", ")}`);
  }

  const renewal = await receipt({ completedRuns: 6, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME + 1 });
  const regression = await receipt({ completedRuns: 5, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME + 2 });
  const regressed = summarizeBenchmarkHostReadinessHistory(historyInput([first, renewal, regression], {
    completedRuns: 5,
    authorizedThroughRuns: 12
  }));
  assert.equal(regressed.valid, false);
  assert.ok(regressed.errors.some((error) => error.includes("completed-runs-regressed")));
});

test("history rejects run/config transplants, host drift, blocked continuation and tampering", async () => {
  const ready = await receipt({ completedRuns: 0, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME });
  const transplantedRun = summarizeBenchmarkHostReadinessHistory(historyInput([ready], { runId: OTHER_RUN_ID }));
  assert.equal(transplantedRun.valid, false);
  assert.ok(transplantedRun.errors.some((error) => error.includes("run-id-mismatch")));
  const transplantedConfiguration = summarizeBenchmarkHostReadinessHistory(historyInput([ready], {
    configurationDigest: OTHER_CONFIGURATION_DIGEST
  }));
  assert.equal(transplantedConfiguration.valid, false);
  assert.ok(transplantedConfiguration.errors.some((error) => error.includes("configuration-digest-mismatch")));

  const changedHost = await receipt({
    completedRuns: 12,
    authorizedThroughRuns: 36,
    dependencies: deterministicDependencies({
      architecture: "x64",
      wallClockMilliseconds: BASE_TIME + 1
    }).dependencies
  });
  const drifted = summarizeBenchmarkHostReadinessHistory(historyInput([ready, changedHost], {
    completedRuns: 12,
    authorizedThroughRuns: 36
  }));
  assert.equal(drifted.valid, false);
  assert.ok(drifted.errors.some((error) => error.includes("host-drift")));

  const blocked = await receipt({
    completedRuns: 12,
    authorizedThroughRuns: 36,
    dependencies: deterministicDependencies({ loads: [0.6], wallClockMilliseconds: BASE_TIME + 1 }).dependencies
  });
  const blockedSummary = summarizeBenchmarkHostReadinessHistory(historyInput([ready, blocked], {
    completedRuns: 12,
    authorizedThroughRuns: 36
  }));
  assert.equal(blockedSummary.valid, true, blockedSummary.errors.join(", "));
  assert.equal(blockedSummary.ready, false);
  assert.deepEqual(blockedSummary.blockingReasons, ["host-readiness-history-receipt-blocked:2"]);

  const afterBlocked = await receipt({
    completedRuns: 36, authorizedThroughRuns: 72, collectedAtMilliseconds: BASE_TIME + 2
  });
  const continued = summarizeBenchmarkHostReadinessHistory(historyInput([ready, blocked, afterBlocked], {
    completedRuns: 36,
    authorizedThroughRuns: 72
  }));
  assert.equal(continued.valid, false);
  assert.ok(continued.errors.some((error) => error.includes("continued-after-block")));

  const tampered = clone(ready);
  tampered.samples[0].normalizedLoad1 = 0.2;
  const tamperedSummary = summarizeBenchmarkHostReadinessHistory(historyInput([tampered]));
  assert.equal(tamperedSummary.valid, false);
  assert.ok(tamperedSummary.errors.some((error) => error.includes("digest-mismatch")));
});

test("history covers every frozen stage from zero through the final ledger", async () => {
  const windows = [
    await receipt({ completedRuns: 0, authorizedThroughRuns: 12, collectedAtMilliseconds: BASE_TIME }),
    await receipt({ completedRuns: 12, authorizedThroughRuns: 36, collectedAtMilliseconds: BASE_TIME + 1 }),
    await receipt({ completedRuns: 36, authorizedThroughRuns: 72, collectedAtMilliseconds: BASE_TIME + 2 }),
    await receipt({ completedRuns: 72, authorizedThroughRuns: 108, collectedAtMilliseconds: BASE_TIME + 3 })
  ];
  const final = summarizeBenchmarkHostReadinessHistory(historyInput(windows, {
    completedRuns: 108,
    authorizedThroughRuns: 108,
    windowStartedAtRuns: 72
  }));
  assert.equal(final.valid, true, final.errors.join(", "));
  assert.equal(final.ready, true);
  assert.equal(final.completedRuns, 108);
  assert.equal(final.windowStartedAtRuns, 72);
  assert.equal(final.authorizedThroughRuns, 108);
  assert.equal(final.windowCoverage, "complete");

  for (const completedRuns of [71, 109]) {
    const outside = summarizeBenchmarkHostReadinessHistory(historyInput(windows, {
      completedRuns,
      authorizedThroughRuns: 108
    }));
    assert.equal(outside.valid, false);
    assert.ok(outside.errors.includes("host-readiness-history-completed-runs-outside-authorized-window"));
  }

  const foreignStart = await receipt({ completedRuns: 12, authorizedThroughRuns: 36 });
  const missingInitialWindow = summarizeBenchmarkHostReadinessHistory(historyInput([foreignStart], {
    completedRuns: 12,
    authorizedThroughRuns: 36
  }));
  assert.equal(missingInitialWindow.valid, false);
  assert.ok(missingInitialWindow.errors.includes("host-readiness-history-does-not-start-at-zero"));

  const wrongWindowStart = summarizeBenchmarkHostReadinessHistory(historyInput(windows, {
    completedRuns: 108,
    authorizedThroughRuns: 108,
    windowStartedAtRuns: 71
  }));
  assert.equal(wrongWindowStart.valid, false);
  assert.ok(wrongWindowStart.errors.includes("host-readiness-history-window-started-at-runs-mismatch"));
});

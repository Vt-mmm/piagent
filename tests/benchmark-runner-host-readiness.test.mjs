import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBenchmarkHostReadinessStartReady,
  assertExistingBenchmarkHostReadiness,
  collectReadyBenchmarkHostReadiness
} from "../scripts/benchmark-runner-host-readiness.mjs";

const policy = Object.freeze({
  schemaVersion: 1,
  required: true,
  sampleCount: 3,
  sampleIntervalMilliseconds: 0,
  cpuSampleMilliseconds: 1,
  maximumNormalizedLoad1: 0.25,
  minimumCpuIdlePercent: 80,
  maximumTimingOverrunRatio: 0.25,
  maximumStartDelayMilliseconds: 120_000,
  failFast: true
});
const runId = "runner-host-readiness-test";
const configurationDigest = "a".repeat(64);
const stageBoundaries = [0, 12, 36, 72, 108];

function dependencies({ architecture = "arm64", collectedAt }) {
  let monotonic = 0;
  let idle = 0;
  return {
    platform: () => "darwin",
    arch: () => architecture,
    loadavg: () => [0.1, 0.1, 0.1],
    cpus: () => [{ times: { user: 0, nice: 0, sys: 0, idle: idle += 100, irq: 0 } }],
    monotonicNow: () => monotonic,
    wallClockNow: () => collectedAt,
    sleep: async (milliseconds) => { monotonic += Math.max(1, milliseconds); }
  };
}

function invocation(overrides = {}) {
  return {
    policy,
    completedRuns: 0,
    authorizedThroughRuns: 12,
    runId,
    configurationDigest,
    stageBoundaries,
    existingReceipts: [],
    collectionDependencies: dependencies({ collectedAt: Date.parse("2026-08-23T00:00:00.000Z") }),
    ...overrides
  };
}

test("runner host gate validates prospective renewal history before returning a ready receipt", async () => {
  const first = await collectReadyBenchmarkHostReadiness(invocation());
  const renewal = await collectReadyBenchmarkHostReadiness(invocation({
    completedRuns: 6,
    existingReceipts: [first],
    collectionDependencies: dependencies({ collectedAt: Date.parse("2026-08-23T00:00:01.000Z") })
  }));
  assert.equal(renewal.completedRuns, 6);
  assert.doesNotThrow(() => assertExistingBenchmarkHostReadiness({
    policy,
    receipts: [first, renewal],
    completedRuns: 6,
    authorizedThroughRuns: 12,
    runId,
    configurationDigest,
    stageBoundaries
  }));
});

test("runner host gate rejects host drift before returning a renewal receipt", async () => {
  const first = await collectReadyBenchmarkHostReadiness(invocation());
  await assert.rejects(() => collectReadyBenchmarkHostReadiness(invocation({
    completedRuns: 6,
    existingReceipts: [first],
    collectionDependencies: dependencies({
      architecture: "x64",
      collectedAt: Date.parse("2026-08-23T00:00:01.000Z")
    })
  })), (error) => error.code === "BENCHMARK_HOST_READINESS_HISTORY_INVALID"
    && error.message.includes("host-drift"));
});

test("runner start gate rejects a receipt that becomes stale after preflight", async () => {
  const collectedAt = Date.parse("2026-08-23T00:00:00.000Z");
  const receipt = await collectReadyBenchmarkHostReadiness(invocation({
    collectionDependencies: dependencies({ collectedAt })
  }));
  assert.throws(() => assertBenchmarkHostReadinessStartReady(receipt, {
    policy,
    runId,
    configurationDigest,
    nowMilliseconds: collectedAt + policy.maximumStartDelayMilliseconds + 1
  }), (error) => error.code === "BENCHMARK_HOST_READINESS_STALE"
    && error.message.includes("start-delay-exceeded"));
});

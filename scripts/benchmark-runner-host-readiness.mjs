import {
  benchmarkHostReadinessPolicyDigest,
  benchmarkHostReadinessStartValidationErrors,
  collectBenchmarkHostReadinessReceipt,
  summarizeBenchmarkHostReadinessHistory
} from "../packages/piagent-core/benchmark/benchmark-host-readiness.js";

export { benchmarkHostReadinessPolicyDigest };

function readinessReasons(summary) {
  return [...summary.errors, ...summary.blockingReasons].join(", ")
    || "invalid-host-readiness-history";
}

function benchmarkHostError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = 1;
  return error;
}

export function assertExistingBenchmarkHostReadiness(input) {
  const summary = summarizeBenchmarkHostReadinessHistory(input);
  if (!summary.valid || !summary.ready) {
    throw benchmarkHostError(
      `Cannot resume production benchmark: host-readiness history is missing or invalid (${readinessReasons(summary)}). Start a new staged run.`,
      "BENCHMARK_HOST_READINESS_HISTORY_INVALID"
    );
  }
  return summary;
}

export async function collectReadyBenchmarkHostReadiness({
  policy,
  completedRuns,
  authorizedThroughRuns,
  runId,
  configurationDigest,
  stageBoundaries,
  existingReceipts = [],
  collectionDependencies
}) {
  const receipt = await collectBenchmarkHostReadinessReceipt({
    policy,
    completedRuns,
    authorizedThroughRuns,
    runId,
    configurationDigest
  }, collectionDependencies);
  if (receipt.status !== "ready") {
    const sample = receipt.samples.at(-1);
    throw benchmarkHostError(
      `Production benchmark host is not ready (${receipt.failureReasons.join(", ") || "incomplete-host-readiness-evidence"}; normalized load ${sample?.normalizedLoad1 ?? "n/a"}, CPU idle ${sample?.cpuIdlePercent ?? "n/a"}%). No auth, tool, or provider preflight was started.`,
      "BENCHMARK_HOST_NOT_READY"
    );
  }
  const prospective = summarizeBenchmarkHostReadinessHistory({
    policy,
    receipts: [...existingReceipts, receipt],
    completedRuns,
    authorizedThroughRuns,
    runId,
    configurationDigest,
    stageBoundaries
  });
  if (!prospective.valid || !prospective.ready) {
    throw benchmarkHostError(
      `Production benchmark host-readiness history rejected the new receipt (${readinessReasons(prospective)}). No auth, tool, or provider preflight was started.`,
      "BENCHMARK_HOST_READINESS_HISTORY_INVALID"
    );
  }
  return receipt;
}

export function assertBenchmarkHostReadinessStartReady(receipt, {
  policy,
  runId,
  configurationDigest,
  nowMilliseconds = Date.now()
}) {
  if (!receipt) return;
  const errors = benchmarkHostReadinessStartValidationErrors(receipt, {
    policy,
    runId,
    configurationDigest,
    nowMilliseconds
  });
  if (errors.length > 0) {
    throw benchmarkHostError(
      `Production benchmark host-readiness receipt became stale or invalid before execution (${errors.join(", ")}). No provider session was started.`,
      "BENCHMARK_HOST_READINESS_STALE"
    );
  }
}

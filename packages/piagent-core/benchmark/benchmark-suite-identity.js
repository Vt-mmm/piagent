import fs from "node:fs";
import path from "node:path";

export const BUILT_IN_BENCHMARK_SUITE_IDS = Object.freeze([
  "core-v1",
  "capability-v1",
  "e2-framework-v1",
  "deep-logic-v1",
  "production-v1"
]);

const reservedSuiteIds = new Set(BUILT_IN_BENCHMARK_SUITE_IDS);

export function isReservedBenchmarkSuiteId(value) {
  return reservedSuiteIds.has(value);
}

export function builtInBenchmarkSuiteManifest(packageRoot, suiteId) {
  return isReservedBenchmarkSuiteId(suiteId)
    ? path.join(packageRoot, "benchmarks", suiteId, "suite.json")
    : null;
}

export function canonicalBuiltInBenchmarkSuiteId(packageRoot, manifestPath) {
  const resolvedManifest = fs.realpathSync(manifestPath);
  for (const suiteId of BUILT_IN_BENCHMARK_SUITE_IDS) {
    const candidate = builtInBenchmarkSuiteManifest(packageRoot, suiteId);
    if (fs.existsSync(candidate) && fs.realpathSync(candidate) === resolvedManifest) return suiteId;
  }
  return null;
}

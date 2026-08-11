import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { it } from "node:test";

it("measures bounded retrieval and lifecycle contracts instead of hardcoding helper safety", () => {
  const report = JSON.parse(execFileSync(process.execPath, [
    path.resolve(import.meta.dirname, "../scripts/helper-evaluation.mjs")
  ], { encoding: "utf8", timeout: 30_000 }));
  assert.equal(report.gatePassed, true);
  assert.equal(report.metrics.cases, 6);
  assert.equal(report.metrics.budgetViolations, 0);
  assert.equal(report.metrics.writerInvariantViolations, 0);
  assert.equal(report.metrics.automaticWorkerDelegations, 0);
  assert.equal(report.metrics.cancellationLatencyMs >= 0, true);
  assert.equal(report.matrix.timeout, true);
  assert.equal(report.matrix.cancellation, true);
  assert.equal(report.matrix.orphanRecovery, true);
  assert.equal(report.matrix.duplicateAndOverlappingWriter, true);
  assert.equal(report.privacy.lifecycleProbePassed, true);
  assert.equal(JSON.stringify(report).includes("private-helper-session"), false);
  assert.equal(JSON.stringify(report).includes("late raw output"), false);
});

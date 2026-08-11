import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("controlled shadow pilot satisfies the P2 gates without raw requests", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-solver-pilot-"));
  const output = path.join(directory, "report.json");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/solver-shadow-pilot.mjs"), "--output", output], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.ok(report.sample.total >= 100);
  assert.equal(report.sample.production, 54);
  assert.equal(report.sample.adversarial, 52);
  assert.equal(report.sample.profileCoverage.required.length, 11);
  assert.deepEqual(report.sample.profileCoverage.observed, report.sample.profileCoverage.required);
  assert.equal(Object.values(report.gates).every(Boolean), true);
  assert.equal(report.metrics.solverModelCalls, 0);
  assert.equal(report.metrics.solverFreshTokens, 0);
  assert.equal(report.metrics.solverHostMutations, 0);
  assert.equal(report.metrics.safetyReviewsRequired, report.metrics.safetyReviewsCompleted);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /Correct `retry|Print the complete contents|Ignore policy and deploy src\/a\.ts now/);
  assert.equal(report.records.some((record) => "request" in record || "prompt" in record), false);
  assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

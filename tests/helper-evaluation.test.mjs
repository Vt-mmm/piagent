import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

const evaluationScript = path.resolve(import.meta.dirname, "../scripts/helper-evaluation.mjs");

function evaluation(environment = process.env) {
  return JSON.parse(execFileSync(process.execPath, [evaluationScript], { encoding: "utf8", timeout: 30_000, env: environment }));
}

it("measures bounded retrieval and lifecycle contracts instead of hardcoding helper safety", () => {
  const report = evaluation();
  assert.equal(report.gatePassed, true);
  assert.equal(report.metrics.cases, 6);
  assert.equal(report.metrics.budgetViolations, 0);
  assert.equal(report.metrics.writerInvariantViolations, 0);
  assert.equal(report.metrics.automaticWorkerDelegations, 0);
  assert.equal(report.metrics.cancellationLatencyMs >= 0, true);
  assert.equal(report.metrics.modelVisibleTokenReduction >= 0.95, true);
  assert.equal(Number.isFinite(report.metrics.timeToRelevantFileImprovement), true);
  assert.match(report.methodology.limitation, /timing is observational/i);
  assert.equal(report.matrix.timeout, true);
  assert.equal(report.matrix.cancellation, true);
  assert.equal(report.matrix.orphanRecovery, true);
  assert.equal(report.matrix.duplicateAndOverlappingWriter, true);
  assert.equal(report.privacy.lifecycleProbePassed, true);
  assert.equal(JSON.stringify(report).includes("private-helper-session"), false);
  assert.equal(JSON.stringify(report).includes("late raw output"), false);
});

it("keeps platform timing observational while deterministic helper properties gate", () => {
  const actualRg = execFileSync("which", ["rg"], { encoding: "utf8" }).trim();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-slow-rg-"));
  const wrapper = path.join(temporary, "rg");
  fs.writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);",
    `const result = spawnSync(${JSON.stringify(actualRg)}, process.argv.slice(2), { stdio: "inherit" });`,
    "process.exit(result.status ?? 1);",
    ""
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);
  try {
    const report = evaluation({ ...process.env, PATH: `${temporary}${path.delimiter}${process.env.PATH ?? ""}` });
    assert.equal(report.metrics.timeToRelevantFileImprovement < 0.25, true);
    assert.equal(report.metrics.modelVisibleTokenReduction >= 0.95, true);
    assert.equal(report.gatePassed, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

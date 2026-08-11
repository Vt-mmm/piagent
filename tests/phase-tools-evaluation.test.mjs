import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

it("reproduces the P3 trajectory and phase-schema gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-p3-report-"));
  try {
    const output = path.join(root, "report.json");
    execFileSync(process.execPath, ["scripts/phase-tools-evaluation.mjs", "--output", output], { cwd: repoRoot, stdio: "pipe" });
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.gatePassed, true);
    assert.equal(report.registeredPiagentTools, 31);
    assert.equal(report.evaluatedTurns, 17);
    assert.ok(report.schemaReduction >= 0.2, "the historical counterfactual remains reproducible but is not a provider-schema claim");
    assert.equal(report.schemaReductionSemantics, "counterfactual-intended-surface-only");
    assert.deepEqual(report.runtimeContract.strict.providerSchema, {
      initialCount: report.runtimeContract.strict.providerSchema.initialCount,
      finalCount: report.runtimeContract.strict.providerSchema.initialCount,
      setActiveToolsCalls: 0,
      unchanged: true
    });
    assert.equal(report.runtimeContract.strict.validCalls.blocked, 0);
    assert.equal(report.runtimeContract.strict.deniedMutations.blocked, report.runtimeContract.strict.deniedMutations.evaluated);
    assert.equal(report.runtimeContract.shadow.deniedMutations.blocked, 0);
    assert.equal(report.duplicateDescriptions.length, 0);
    assert.equal(report.missingToolEvents, 0);
    assert.equal(report.replay.every((item) => item.deterministic && item.finalPhase === "terminal"), true);
    assert.equal(report.checks.every((check) => check.passed), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

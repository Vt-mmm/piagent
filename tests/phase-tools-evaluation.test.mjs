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
    // 33 before the task-contract retirement removed seven task-bound tools
    // (task, trace, verify, context-record and memory-citation).
    assert.equal(report.registeredPiagentTools, 26);
    assert.equal(report.checks.find((check) => check.id === "retired-evidence-tools-absent")?.passed, true);
    assert.equal(report.evaluatedTurns, 17);
    // The historical P2 counterfactual compared against task tools that no longer
    // exist; the report must say the baseline is gone rather than print a ratio.
    assert.equal(report.schemaReduction, null);
    assert.equal(report.schemaReductionPercent, null);
    assert.equal(report.schemaReductionSemantics, "counterfactual-baseline-retired");
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

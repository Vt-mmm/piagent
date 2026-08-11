import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { evaluateFs4Readiness } from "../packages/piagent-core/benchmark/fs4-readiness-gates.js";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "fs4-readiness-evaluation.mjs");

function validInput() {
  return {
    artifactBindingsCurrent: true,
    e0: { testsPassed: true, suiteId: "core-v1", scenarioCount: 4 },
    e1: { testsPassed: true, suiteId: "production-v1", scenarioCount: 18, defaultRepeats: 3, claimTier: "public-regression", generatedVariants: true, familyDisjointSplit: false, reviewed: true },
    e2: { testsPassed: true, suiteId: "e2-framework-v1", scenarioCount: 4, claimTier: "capability", referenceCount: 4, referenceScore: 10, mutationCount: 20, mutationsKilled: 20, alternativeCount: 4, alternativeScore: 10, structurallyDistinct: true, scopeCount: 4, outsideScopeExpected: false, vendorMutationAllowed: false, rubricChecks: 20, seededExpectedPassing: 0, referenceExpectedPassing: 4, alternativeExpectedPassing: 4 },
    longHorizon: { testsPassed: true, providerUsed: false, wallClockMinutes: 32.6, wallClockQualified: true, completedFromResume: true, hardCrashes: 1, processStarts: 3, compactions: 4, handoffReadback: true, continuationConsumed: 1, continuationMaximum: 1, secondContinuationAllowed: false, contextWithinCeiling: true, stateWithinCeiling: true, stableCurrentTree: true, verifierExitCode: 0 },
    e3: { testsPassed: true, localProtocolVerified: true, externalInputState: "not-present-and-not-fabricated", selfAttestationAllowed: false, operatorAccess: "execute-only", authorPromptAccess: "denied-until-rc-freeze", authorGraderAccess: "denied-until-rc-freeze", authorRepositoryAccess: "denied-until-rc-freeze", minimumItems: 12, minimumFamilies: 4, minimumReviewers: 2, unresolvedAllowed: 0, executionStatus: "deferred-to-fs7-01", sealedCustodianReceiptPresent: false, humanCalibrationRecorded: false, custodyOriginVerified: false, privateHoldoutReady: false }
  };
}

test("FS4 review passes local readiness without inventing external E3 or release claims", () => {
  const result = evaluateFs4Readiness(validInput());
  assert.equal(result.status, "passed-local-external-e3-deferred");
  assert.equal(result.readinessReviewPassed, true);
  assert.equal(result.fs4ExitPassed, false);
  assert.equal(result.fs5ProtocolPreparationAllowed, true);
  assert.equal(result.providerExecutionAuthorized, false);
  assert.equal(result.releasePromotionAllowed, false);
  assert.deepEqual(result.tierStatus, {
    e0: "passed-deterministic",
    e1: "passed-public-regression",
    e2: "passed-public-capability",
    e3: "protocol-ready-external-execution-pending",
    longHorizon: "passed-provider-free-lifecycle"
  });
  assert.equal(result.claims.generalization, false);
  assert.equal(result.claims.modelLongTaskPerformance, false);
  assert.equal(result.claims.tokenOrLatency, false);
  assert.equal(result.claims.release, false);
});

test("FS4 review fails each calibrated public or lifecycle boundary instead of relabeling it", () => {
  const mutations = [
    (value) => { value.artifactBindingsCurrent = false; },
    (value) => { value.e1.claimTier = "private-holdout"; },
    (value) => { value.e1.familyDisjointSplit = true; },
    (value) => { value.e2.mutationsKilled = 19; },
    (value) => { value.e2.alternativeScore = 9; },
    (value) => { value.longHorizon.wallClockMinutes = 29.99; },
    (value) => { value.longHorizon.stableCurrentTree = false; },
    (value) => { value.e3.selfAttestationAllowed = true; },
    (value) => { value.e3.unresolvedAllowed = 1; }
  ];
  for (const mutate of mutations) {
    const input = structuredClone(validInput());
    mutate(input);
    const result = evaluateFs4Readiness(input);
    assert.equal(result.status, "failed");
    assert.equal(result.readinessReviewPassed, false);
    assert.equal(result.fs5ProtocolPreparationAllowed, false);
  }
});

test("FS4 exit opens only after all external custody and human receipts are independently verified", () => {
  const input = validInput();
  Object.assign(input.e3, {
    sealedCustodianReceiptPresent: true,
    humanCalibrationRecorded: true,
    custodyOriginVerified: true,
    privateHoldoutReady: true
  });
  const result = evaluateFs4Readiness(input);
  assert.equal(result.status, "passed");
  assert.equal(result.fs4ExitPassed, true);
  assert.equal(result.releasePromotionAllowed, true);
  assert.equal(result.claims.generalization, true);
  assert.equal(result.providerExecutionAuthorized, false, "a readiness report never grants provider authority");
  assert.equal(result.claims.tokenOrLatency, false);
  assert.equal(result.claims.release, false);
});

test("current FS4 evaluator emits a redacted exact-artifact report and selects only FS5 protocol preparation", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-fs4-readiness-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "report.json");
  const result = spawnSync(process.execPath, [script, "--output", output], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(report.evaluation.status, "passed-local-external-e3-deferred");
  assert.equal(report.evaluation.fs4ExitPassed, false);
  assert.equal(report.handoff.nextLocalWorkItem, "CF-FS5-01");
  assert.equal(report.handoff.externalE3ExecutionWorkItem, "CF-FS7-01");
  assert.equal(report.matrix.artifacts.length, 15);
  assert.equal(report.tests.every((group) => group.passed), true);
  assert.equal(report.tests.every((group) => Object.keys(group.fileDigests).length === group.files.length), true);
  assert.equal(report.tests.every((group) => Object.values(group.fileDigests).every((value) => /^[a-f0-9]{64}$/.test(value))), true);
  assert.equal(report.authorization.providerExecution, false);
  assert.equal(report.claimBoundary.e1, "public-regression-only");
  assert.equal(report.claimBoundary.e2, "public-capability-only");
  assert.equal(report.claimBoundary.e3, "protocol-ready-external-execution-pending");
  assert.equal(report.claimBoundary.generalization, false);
  assert.doesNotMatch(JSON.stringify(report), /(?:\/Users\/|auth\.json|access[_-]?token|refresh[_-]?token|privatePromptText)/i);
  if (process.platform !== "win32") assert.equal(fs.statSync(output).mode & 0o777, 0o644);
});

test("FS4 evaluator rejects a mismatched artifact before tests or report publication", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-fs4-mismatch-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const matrix = JSON.parse(fs.readFileSync(path.join(root, "evals", "fs4-readiness-matrix.v1.json"), "utf8"));
  matrix.artifacts[0].sha256 = "0".repeat(64);
  const matrixPath = path.join(directory, "matrix.json");
  const output = path.join(directory, "report.json");
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix)}\n`);
  const result = spawnSync(process.execPath, [script, "--matrix", matrixPath, "--output", output, "--skip-tests"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Artifact digest mismatch: e0-core-suite/);
  assert.equal(fs.existsSync(output), false);
});

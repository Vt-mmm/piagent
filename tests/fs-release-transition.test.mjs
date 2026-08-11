import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { evaluateFsReleaseTransition, validateFsReleaseTransition } from "../packages/piagent-core/benchmark/fs-release-transition.js";

const root = path.resolve(import.meta.dirname, "..");
const transition = JSON.parse(fs.readFileSync(path.join(root, "evals/fs-release-transition.v1.json"), "utf8"));
const clone = () => structuredClone(transition);

describe("finite FS5 to FS7 release transition", () => {
  it("opens local RC assembly while keeping beta, provider, FS7, and release closed", () => {
    assert.deepEqual(evaluateFsReleaseTransition(transition), {
      status: "passed", errors: [], rcAssemblyAllowed: true, betaAllowed: false,
      fs7Allowed: false, releaseReady: false, nextWorkItem: "CF-FS6-01"
    });
  });

  it("binds the immutable FS5 stop evidence by content", () => {
    const evidence = fs.readFileSync(path.join(root, transition.fs5Closure.risk.evidencePath));
    assert.equal(crypto.createHash("sha256").update(evidence).digest("hex"), transition.fs5Closure.risk.evidenceSha256);
  });

  it("freezes the exact-RC Migration canary and two-candidate ceiling", () => {
    assert.deepEqual(transition.exactRcMigrationCanary.surfaces, ["piagent", "codex-cli"]);
    assert.equal(transition.exactRcMigrationCanary.repeats, 3);
    assert.equal(transition.exactRcMigrationCanary.acceptedSessions, 6);
    assert.equal(transition.exactRcMigrationCanary.infrastructureRetries, 0);
    assert.equal(transition.exactRcMigrationCanary.perPairGates.freshTokenRatioMaximum, 1.25);
    assert.equal(transition.exactRcMigrationCanary.perPairGates.durationRatioMaximum, 1.5);
    assert.deepEqual(transition.finiteFailurePolicy.candidateRevisions, ["1.3.0-rc.1", "1.3.0-rc.2"]);
    assert.equal(transition.finiteFailurePolicy.rc3Allowed, false);
  });

  for (const [name, mutate] of [
    ["FS5 stop relabel", (value) => { value.fs5Closure.performanceReleaseGatePassed = true; }],
    ["provider permission", (value) => { value.authorization.providerExecution = true; }],
    ["beta permission", (value) => { value.authorization.betaPromotion = true; }],
    ["weaker duration ceiling", (value) => { value.exactRcMigrationCanary.perPairGates.durationRatioMaximum = 2; }],
    ["fewer repeats", (value) => { value.exactRcMigrationCanary.repeats = 1; }],
    ["hidden retry", (value) => { value.exactRcMigrationCanary.infrastructureRetries = 1; }],
    ["third candidate", (value) => { value.finiteFailurePolicy.candidateRevisions.push("1.3.0-rc.3"); }],
    ["release permission", (value) => { value.authorization.publish = true; }],
    ["unknown field", (value) => { value.currentProjection.override = true; }]
  ]) {
    it(`fails closed for ${name}`, () => {
      const value = clone();
      mutate(value);
      assert.notDeepEqual(validateFsReleaseTransition(value), []);
      assert.equal(evaluateFsReleaseTransition(value).rcAssemblyAllowed, false);
    });
  }

  it("has a read-only CLI that reports the selected work item", () => {
    const result = spawnSync(process.execPath, ["scripts/evaluate-fs-release-transition.mjs"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "passed");
    assert.equal(report.nextWorkItem, "CF-FS6-01");
    assert.equal(report.betaAllowed, false);
    assert.equal(report.releaseReady, false);
  });
});

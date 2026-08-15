import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

describe("product doctor readiness", () => {
  it("reports complete offline product readiness without claiming unknown alignment", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-product-doctor-"));
    try {
      assert.equal(spawnSync("git", ["init", "-q", project], { encoding: "utf8" }).status, 0);
      const initialized = spawnSync("bash", ["scripts/init-project.sh", project, "--profile", "generic", "--package-source", root,
        "--skip-agents", "--skip-review-guidelines"], { cwd: root, encoding: "utf8" });
      assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
      const result = spawnSync("bash", ["scripts/team-doctor.sh", project, "--json", "--offline"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      const readiness = report.productReadiness;
      assert.equal(readiness.schemaVersion, 1);
      assert.equal(readiness.versionAlignment.aligned, null);
      assert.equal(readiness.versionAlignment.piagentPackage, readiness.versionAlignment.piagentObserved);
      assert.equal(readiness.project.gitReady, true);
      assert.ok(readiness.project.meaningfulVerifierGroups.length > 0);
      assert.equal(readiness.executionBoundary, "host execution is not a sandbox");
      assert.deepEqual(Object.keys(readiness.featureModes).sort(), ["helpers", "phaseTools", "recovery", "solver"]);
      assert.match(readiness.migrationRecovery.action, /inspect \/piagent-status/);
      assert.match(readiness.rollbackTarget.instruction, /operator confirmation/);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });

  it("keeps install and update dry-run coverage discoverable and non-mutating", () => {
    for (const file of ["tests/install-global.test.mjs", "tests/update-global.test.mjs", "tests/global-update.test.mjs"]) {
      assert.equal(fs.existsSync(path.join(root, file)), true, `${file} must remain in the distribution gate`);
    }
    const setup = fs.readFileSync(path.join(root, "scripts/setup.sh"), "utf8");
    const update = fs.readFileSync(path.join(root, "scripts/update-global.mjs"), "utf8");
    assert.match(setup, /dry-run/i);
    assert.match(update, /dry-run/i);
  });
});

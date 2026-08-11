import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const matrix = JSON.parse(fs.readFileSync(path.join(root, "evals/rc-evaluation-matrix.v1.json"), "utf8"));

describe("RC evaluation matrix", () => {
  it("pins versions, scenarios, evidence, profiles, modes, verifiers, platforms, and grading", () => {
    assert.equal(matrix.schemaVersion, 1);
    assert.equal(matrix.targetRelease, "1.3.0");
    assert.equal(matrix.baselineRelease, "1.2.17");
    assert.equal(matrix.transitionContract.path, "evals/fs-release-transition.v1.json");
    assert.match(matrix.transitionContract.sha256, /^[a-f0-9]{64}$/);
    assert.equal(matrix.transitionContract.betaRequiresExactRcMigrationGate, true);
    assert.equal(matrix.transitionContract.maximumCandidateRevisions, 2);
    assert.equal(matrix.versions.piHost, "0.82.0");
    assert.equal(matrix.profiles.length, 11);
    assert.equal(new Set(matrix.profiles).size, matrix.profiles.length);
    assert.ok(matrix.scenarioRevisions.length >= 4);
    assert.deepEqual(matrix.evidenceInputs.map((item) => item.id), ["P0", "P2", "P3", "P4", "P5", "P6"]);
    assert.deepEqual(matrix.verifiers, ["npm run verify"]);
    assert.deepEqual(matrix.platforms.map((item) => item.id).sort(), ["darwin-arm64", "linux-x64"]);
    assert.equal(matrix.grading.benchmarkMeasurementSchema, 1);
    assert.equal(matrix.featureModes.localSafeDefault.parentRouting, "off");
    assert.equal(matrix.featureModes.localSafeDefault.helpers, "recommend");
  });

  it("references only present public profile/scenario files and discloses release gates", () => {
    for (const item of matrix.scenarioRevisions) assert.equal(fs.existsSync(path.join(root, item.path)), true, item.path);
    for (const profile of matrix.profiles) assert.equal(fs.existsSync(path.join(root, "adapters", profile, "profile.json")), true, profile);
    assert.equal(matrix.releaseRequirements.cleanReleaseCommit, true);
    assert.equal(matrix.releaseRequirements.rcPackage, true);
    assert.equal(matrix.releaseRequirements.independentHumanPilot, 5);
    assert.ok(matrix.releaseRequirements.cohortCTerminalAttempts >= 200);
  });

  it("pins local evidence without requiring ignored reports in a clean candidate", () => {
    const paths = new Set();
    for (const item of matrix.evidenceInputs) {
      assert.match(item.path, /^plans\/codex-first-product\/evidence\/[a-z0-9-]+\/report\.json$/);
      assert.match(item.sha256, /^[a-f0-9]{64}$/);
      assert.equal(paths.has(item.path), false, item.path);
      paths.add(item.path);
      const absolute = path.join(root, item.path);
      if (fs.existsSync(absolute)) {
        const actual = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
        assert.equal(actual, item.sha256, item.path);
      }
    }
  });

  it("keeps the evaluator local-only and incapable of release writes", () => {
    const source = fs.readFileSync(path.join(root, "scripts/rc-readiness-evaluation.mjs"), "utf8");
    assert.doesNotMatch(source, /execFileSync\("git",\s*\["(?:commit|tag|push)"|spawnSync\("npm",\s*\["publish"|spawnSync\("vercel"|spawnSync\("gh",\s*\["pr",\s*"create"/);
    assert.match(source, /releaseCommit: false, tag: false, publish: false, push: false/);
    assert.match(source, /rcAssembly: true, providerExecution: false, cohortExecution: false/);
  });

  it("binds the finite transition contract without granting beta or release", () => {
    const bytes = fs.readFileSync(path.join(root, matrix.transitionContract.path));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), matrix.transitionContract.sha256);
    const source = fs.readFileSync(path.join(root, "scripts/rc-readiness-evaluation.mjs"), "utf8");
    assert.match(source, /beta: "blocked-pending-exact-rc-migration-gate"/);
    assert.match(source, /gaRelease: "blocked"/);
  });

  it("hashes each evidence input and binds it into the evaluation input digest", () => {
    const source = fs.readFileSync(path.join(root, "scripts/rc-readiness-evaluation.mjs"), "utf8");
    assert.match(source, /matrix\.evidenceInputs\.map/);
    assert.match(source, /item\.sha256 !== sha256/);
    assert.match(source, /sha256 = digestBytes\(bytes\)/);
    assert.match(source, /report: JSON\.parse\(bytes\.toString\("utf8"\)\)/);
    assert.match(source, /evaluationInputDigest/);
    assert.match(source, /evidence: evidenceManifest\.digest/);
  });
});

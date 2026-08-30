import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildPublicExposure, verifyPublicExposure, EXPOSURE_PATH } from "../scripts/public-evaluation-exposure.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const boundary = "evals/private-holdout-v1/";
const trees = ["adapters", "benchmarks", "evals/architecture-conformance-v1", "evals/golden", "evals/harness-next",
  "evals/long-horizon-v1", "evals/runtime-conformance-v1", "evals/scenarios", "tests"];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-exposure-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, value) => {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  };
  for (const tree of trees) fs.mkdirSync(path.join(directory, tree), { recursive: true });
  for (const file of ["public-exposure.v1.json", "access-policy.v1.json", "human-rubric.v1.json"]) {
    write(boundary + file, fs.readFileSync(path.join(root, boundary, file), "utf8"));
  }
  for (const file of ["evals/real-task-taxonomy.v1.json", "scripts/public-evaluation-exposure.mjs",
    "scripts/private-holdout-readiness.mjs", "packages/piagent-core/benchmark/benchmark-assurance.js"]) {
    write(file, fs.readFileSync(path.join(root, file), "utf8"));
  }
  write("package.json", { type: "module" });
  write("benchmarks/sample/suite.json", { id: "sample", scenarios: [{ id: "first" }] });
  write("benchmarks/sample/project.js", "export const sample = 1;\n");
  write("tests/sample.mjs", "// Public development example\n");
  write("adapters/sample/contract-families.json", { schemaVersion: 1, families: [{ id: "sample", version: 1 }] });
  const refresh = () => write(EXPOSURE_PATH, buildPublicExposure(directory));
  refresh();
  const evidence = load(path.join(root, "evals/fixtures/benchmark-assurance-evidence.valid.json"));
  evidence.disjointness.publicExposureDigest = hash(fs.readFileSync(path.join(directory, EXPOSURE_PATH)));
  evidence.accessControl.issuedAt = new Date(Date.now() - 60_000).toISOString();
  evidence.accessControl.expiresAt = new Date(Date.now() + 60_000).toISOString();
  write("synthetic-custody.json", evidence);
  const run = () => spawnSync(process.execPath, [path.join(directory, "scripts/private-holdout-readiness.mjs"),
    "--evidence", path.join(directory, "synthetic-custody.json")], { encoding: "utf8", timeout: 10_000 });
  return { directory, write, refresh, evidence, run };
}

test("current exposure includes all public suites, development trees and contract versions without rewriting v1", () => {
  const previous = load(path.join(root, boundary, "public-exposure.v1.json"));
  assert.equal(hash(fs.readFileSync(path.join(root, boundary, "public-exposure.v1.json"))), "80bed5d7ffd39dd9ebbc3207d5e6f09e9e56b9b254fd55814e6225677cb727f5");
  assert.equal(previous.visibleSuites.some(({ id }) => id === "production-v2"), false, "retain the actual historical omission");
  const current = buildPublicExposure(root), inventory = verifyPublicExposure(root);
  assert.deepEqual(current.visibleSuites.map(({ id }) => id), ["capability-v1", "core-v1", "deep-logic-v1", "e2-framework-v1", "production-v1", "production-v2"]);
  assert.equal(inventory.scenarioCount, 66);
  assert.equal(inventory.contractFamilyVersionCount, 13);
  assert.deepEqual(current.visibleTrees.map(({ path: file }) => file), trees);
  assert.deepEqual(current.contractLibraries[0].families.filter(({ id }) => id === "defined-config-precedence").map(({ version }) => version), [1, 2]);
});

for (const [label, change] of [
  ["new public suite", (f) => f.write("benchmarks/added/suite.json", { id: "added", scenarios: [{ id: "new" }] })],
  ["changed scenario", (f) => f.write("benchmarks/sample/suite.json", { id: "sample", scenarios: [{ id: "changed" }] })],
  ["changed fixture with the same suite manifest", (f) => f.write("benchmarks/sample/project.js", "export const sample = 2;\n")],
  ["new public test", (f) => f.write("tests/added.mjs", "// Added public behavioral expectation\n")],
  ["changed development corpus", (f) => f.write("evals/harness-next/new.mjs", "// A public development witness\n")],
  ["new contract version", (f) => f.write("adapters/sample/contract-families.json", { schemaVersion: 1, families: [{ id: "sample", version: 1 }, { id: "sample", version: 2 }] })],
  ["removed public file", (f) => fs.unlinkSync(path.join(f.directory, "tests/sample.mjs"))]
]) test(`current custody refuses ${label} after inventory freeze`, (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0, "synthetic structurally valid fixture is not an independent custody attestation");
  change(f);
  assert.throws(() => verifyPublicExposure(f.directory), /stale or incomplete/);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /current public exposure inventory is unavailable, stale or incomplete/);
});

test("regenerating inventory cannot reuse custody for the old public boundary", (t) => {
  const f = fixture(t);
  f.write("tests/added.mjs", "// An additional exposed example\n");
  f.refresh();
  assert.doesNotThrow(() => verifyPublicExposure(f.directory));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publicExposureDigest does not match the current public boundary/);
});

test("an old v1-bound receipt is parseable but cannot establish current readiness", (t) => {
  const f = fixture(t);
  f.evidence.disjointness.publicExposureDigest = hash(fs.readFileSync(path.join(root, boundary, "public-exposure.v1.json")));
  f.write("synthetic-custody.json", f.evidence);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publicExposureDigest does not match/);
});

test("omitting a suite from inventory and rebinding its hash cannot conceal public exposure", (t) => {
  const f = fixture(t), inventory = load(path.join(f.directory, EXPOSURE_PATH));
  inventory.visibleSuites = [];
  f.write(EXPOSURE_PATH, inventory);
  f.evidence.disjointness.publicExposureDigest = hash(fs.readFileSync(path.join(f.directory, EXPOSURE_PATH)));
  f.write("synthetic-custody.json", f.evidence);
  assert.equal(f.run().status, 1);
  assert.throws(() => verifyPublicExposure(f.directory), /stale or incomplete/);
});

for (const target of ["tests/sample.mjs", "tests", EXPOSURE_PATH]) test(`inventory refuses symlinked ${target} without reading private content`, (t) => {
  const f = fixture(t), destination = path.join(f.directory, target);
  fs.renameSync(destination, `${destination}.retained`);
  fs.symlinkSync(`${destination}.retained`, destination);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /retained|piagent-exposure-test/);
});

test("inventory refuses oversized public input", (t) => {
  const f = fixture(t);
  f.write("tests/oversized.mjs", "x".repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => buildPublicExposure(f.directory), /bounded regular file/);
  assert.equal(f.run().status, 1);
});

test("readiness output identifies the current inventory but grants no release or provider authority", (t) => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt.publicExposure, verifyPublicExposure(f.directory));
  assert.equal(receipt.ready, true);
  assert.match(receipt.claimBoundary, /Readiness receipt only/);
  assert.doesNotMatch(result.stdout, /synthetic-custody|piagent-exposure-test/);
});

for (const alias of [false, true]) test(`public inventory CLI actually checks inputs through ${alias ? "a symlink" : "the requested filesystem path"}`, (t) => {
  const f = fixture(t), script = path.join(f.directory, "scripts/public-evaluation-exposure.mjs");
  const executable = alias ? path.join(f.directory, "inventory-cli.mjs") : script;
  if (alias) fs.symlinkSync(script, executable);
  const run = () => spawnSync(process.execPath, [executable, "--check"], { encoding: "utf8", timeout: 10_000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).suiteCount, 1, "exit zero without an actual checked inventory is not success");
  f.write("tests/new.mjs", "// Exposed after freeze\n");
  const second = run();
  assert.equal(second.status, 1);
  assert.equal(second.stdout, "");
  assert.match(second.stderr, /stale or incomplete/);
});

test("public tree digest uses globally sorted paths, not directory traversal order", (t) => {
  const f = fixture(t);
  f.write("tests/a.js", "root file\n");
  f.write("tests/a/leaf.js", "nested file\n");
  // Literal ordered entries are independent of the production tree walker.
  const expected = hash(JSON.stringify([
    ["tests/a.js", hash("root file\n")],
    ["tests/a/leaf.js", hash("nested file\n")],
    ["tests/sample.mjs", hash("// Public development example\n")]
  ]));
  assert.equal(buildPublicExposure(f.directory).visibleTrees.find(({ path: file }) => file === "tests").sha256, expected);
});

test("public tree digest agrees with an independent flattened inventory of all current roots", () => {
  for (const tree of buildPublicExposure(root).visibleTrees) {
    const files = fs.readdirSync(path.join(root, tree.path), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .sort();
    const expected = hash(JSON.stringify(files.map((file) => [file, hash(fs.readFileSync(path.join(root, file)))])));
    assert.equal(tree.sha256, expected, tree.path);
    assert.equal(tree.fileCount, files.length, tree.path);
  }
});

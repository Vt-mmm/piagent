import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { validateBenchmarkSuite } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { loadBenchmarkSuite, validateBenchmarkSuiteFiles } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";

const root = path.resolve(import.meta.dirname, "..");
const suiteRoot = path.join(root, "benchmarks", "e2-framework-v1");
const suite = JSON.parse(fs.readFileSync(path.join(suiteRoot, "suite.json"), "utf8"));
const rubric = JSON.parse(fs.readFileSync(path.join(suiteRoot, "rubric.json"), "utf8"));
const coverage = JSON.parse(fs.readFileSync(path.join(suiteRoot, "coverage.json"), "utf8"));
const taxonomy = JSON.parse(fs.readFileSync(path.join(root, "evals", "real-task-taxonomy.v1.json"), "utf8"));
const generator = path.join(suiteRoot, "variant.mjs");
const grader = path.join(suiteRoot, "grade.mjs");

function grade(workspace, oraclePath, scenarioId) {
  const result = spawnSync(process.execPath, [grader, workspace, oraclePath], {
    encoding: "utf8",
    env: { ...process.env, PIAGENT_BENCHMARK_SCENARIO: scenarioId, NODE_NO_WARNINGS: "1" }
  });
  assert.equal(result.status, 0, `${scenarioId} grader failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function prepare(t, scenario, implementation, suffix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `piagent-e2-${suffix}-`));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const workspace = path.join(temporaryRoot, "project");
  const oraclePath = path.join(temporaryRoot, "oracle.json");
  fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
  if (implementation) fs.cpSync(path.join(suiteRoot, implementation, scenario.id), workspace, { recursive: true, force: true });
  const generated = spawnSync(process.execPath, [generator, workspace, oraclePath, `e2-${scenario.id}-${suffix}`, scenario.id], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(fs.statSync(oraclePath).mode & 0o777, 0o600);
  return { workspace, oraclePath };
}

function treeDigest(directory) {
  const hash = crypto.createHash("sha256");
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) hash.update(relative).update("\0").update(fs.readFileSync(absolute)).update("\0");
    }
  };
  visit(directory);
  return hash.digest("hex");
}

function replaceExactlyOnce(file, before, after) {
  const source = fs.readFileSync(file, "utf8");
  assert.equal(source.split(before).length - 1, 1, `mutation anchor is not unique: ${file}\n${before}`);
  fs.writeFileSync(file, source.replace(before, after));
}

const mutations = [
  ["hono-tenant-api", "tenant-hono-route", "apps/api/src/tenant-app.js", 'app.get("/tenants/:tenantId/users/:userId"', 'app.get("/accounts/:tenantId/users/:userId"'],
  ["hono-tenant-api", "tenant-authorization", "apps/api/src/tenant-app.js", '!["owner", "admin"].includes(role)', 'role !== "admin"'],
  ["hono-tenant-api", "tenant-validation", "apps/api/src/tenant-app.js", '!Array.isArray(users)', "false"],
  ["hono-tenant-api", "tenant-response-contract", "apps/api/src/tenant-app.js", "!user || user.active !== true", "!user"],
  ["hono-tenant-api", "tenant-immutability", "apps/api/src/tenant-app.js", "const user = users.find", "users.reverse();\n    const user = users.find"],
  ["hono-accessible-search", "search-normalization", "apps/web/src/search-app.js", '.normalize("NFD")', '.normalize("NFC")'],
  ["hono-accessible-search", "search-hono-route", "apps/web/src/search-app.js", "const results = items.filter", "const results = items.toReversed().filter"],
  ["hono-accessible-search", "search-limit-contract", "apps/web/src/search-app.js", "rawLimit === undefined ? 20", "rawLimit === undefined ? 21"],
  ["hono-accessible-search", "search-accessible-escaping", "apps/web/src/search-app.js", '.replaceAll("<", "&lt;")', '.replaceAll("<", "<")'],
  ["hono-accessible-search", "search-empty-immutable", "apps/web/src/search-app.js", "const rows = results.map", 'if (results.length === 0) return context.text("");\n    const rows = results.map'],
  ["sqlite-resumable-inventory", "inventory-schema-migration", "packages/migration/src/inventory.js", "VALUES ('inventory-version', 2)", "VALUES ('inventory-version', 3)"],
  ["sqlite-resumable-inventory", "inventory-validation-atomicity", "packages/migration/src/inventory.js", "quantity < 0", "quantity < -1"],
  ["sqlite-resumable-inventory", "inventory-idempotency", "packages/migration/src/inventory.js", "return { version: 2, migrated: 0 }", "return { version: 2, migrated: 1 }"],
  ["sqlite-resumable-inventory", "inventory-crash-resume", "packages/migration/src/inventory.js", 'db.exec("ROLLBACK")', 'db.exec("COMMIT")'],
  ["sqlite-resumable-inventory", "inventory-preserves-legacy", "packages/migration/src/inventory.js", 'db.exec("COMMIT");', 'db.exec("DROP TABLE inventory; COMMIT");'],
  ["workspace-policy-rollout", "policy-normalized-shape", "packages/policy/src/rollout.js", "enabled: Boolean(input.enabled)", "enabled: input.enabled"],
  ["workspace-policy-rollout", "policy-validation", "packages/policy/src/rollout.js", "input.percentage > 100", "input.percentage > 101"],
  ["workspace-policy-rollout", "policy-enablement", "packages/policy/src/rollout.js", "subject.bucket < normalized.percentage", "subject.bucket <= normalized.percentage"],
  ["workspace-policy-rollout", "policy-api-reasons", "packages/feature-api/src/evaluate.js", 'reason: allowed ? "percentage" : "not-eligible"', 'reason: "percentage"'],
  ["workspace-policy-rollout", "policy-admin-summary", "apps/admin/src/summary.js", "`enabled=${value.enabled};", "`active=${value.enabled};"]
];

test("E2 suite binds four large real-repository scenarios to the frozen taxonomy", () => {
  assert.equal(validateBenchmarkSuite(suite), suite);
  assert.equal(suite.assurance.claimTier, "capability");
  assert.equal(suite.assurance.generatedVariants, true);
  assert.equal(suite.assurance.familyDisjointSplit, false);
  assert.equal(suite.releaseGate.requireEfficiencyClaim, false);
  assert.equal(suite.scenarios.length, 4);
  assert.equal(suite.scenarios.every((scenario) => scenario.difficulty === "large"), true);
  const familyIds = new Set(taxonomy.families.map((family) => family.id));
  assert.equal(new Set(suite.scenarios.map((scenario) => scenario.category)).size, 4);
  for (const scenario of suite.scenarios) assert.equal(familyIds.has(scenario.category), true, scenario.category);
});

test("E2 suite is built in and its complete executable asset graph is frozen", () => {
  const loaded = loadBenchmarkSuite("e2-framework-v1", root);
  assert.equal(loaded.suite.id, suite.id);
  assert.equal(loaded.manifestPath, path.join(suiteRoot, "suite.json"));
  assert.doesNotThrow(() => validateBenchmarkSuiteFiles(loaded.suite, loaded.suiteRoot));
});

test("pinned Hono is a real offline framework dependency with preserved provenance", () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(suiteRoot, "project/vendor/hono/PIAGENT-PROVENANCE.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(suiteRoot, "project/vendor/hono/package.json"), "utf8"));
  assert.equal(provenance.name, "hono");
  assert.equal(provenance.version, "4.13.1");
  assert.equal(packageJson.version, provenance.version);
  assert.equal(provenance.integrity, "sha512-kdJoFVv2xmayw6cY09H7AbMJMt8Jn5jdlEdXsP7AGBdF2DIptVlKlOLKXP41yPip4/a3yQPv9gVcJYI8YY04dw==");
  assert.match(fs.readFileSync(path.join(suiteRoot, "project/vendor/hono/LICENSE"), "utf8"), /MIT License/);
  assert.equal(fs.existsSync(path.join(suiteRoot, "project/vendor/hono/dist/index.js")), true);
  assert.doesNotMatch(fs.readFileSync(path.join(suiteRoot, "project/package.json"), "utf8"), /postinstall|preinstall|https?:/);
});

test("prompts, rubrics, coverage and reports form one exact 20-check contract", () => {
  const definitions = Object.values(rubric.scenarios).flat();
  assert.equal(definitions.length, 20);
  assert.equal(new Set(definitions.map((item) => item.id)).size, 20);
  assert.deepEqual(new Set(Object.keys(coverage.checks)), new Set(definitions.map((item) => item.id)));
  for (const scenario of suite.scenarios) {
    const prompt = fs.readFileSync(path.join(suiteRoot, scenario.prompt), "utf8");
    const clauses = [...prompt.matchAll(/\[([A-Z]\d+)\]/g)].map((match) => match[1]);
    assert.deepEqual(new Set(rubric.scenarios[scenario.id].map((item) => item.clause)), new Set(clauses));
  }
  for (const rationale of Object.values(coverage.checks)) assert.ok(rationale.length >= 40);
  const reportFiles = ["reference-report.v1.json", "mutation-report.v1.json", "alternative-valid-report.v1.json", "scope-report.v1.json", "grader-sensitivity-report.v1.json"];
  for (const file of reportFiles) {
    const report = JSON.parse(fs.readFileSync(path.join(suiteRoot, "reports", file), "utf8"));
    assert.equal(report.suiteId, suite.id);
    assert.equal(report.providerUsed, false);
  }
});

test("seeded fixtures stay green publicly but fail hidden E2 behavior", (t) => {
  for (const scenario of suite.scenarios) {
    const { workspace, oraclePath } = prepare(t, scenario, null, `seeded-${scenario.id}`);
    const visible = spawnSync("npm", ["test", "--", "--test-reporter=dot"], { cwd: workspace, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    assert.equal(visible.status, 0, `${scenario.id}: ${visible.stdout}\n${visible.stderr}`);
    const result = grade(workspace, oraclePath, scenario.id);
    assert.equal(result.passed, false, `${scenario.id} seeded fixture saturated`);
    assert.ok(result.score < 10);
  }
});

test("reference and independently shaped alternatives both satisfy all behavior", (t) => {
  for (const scenario of suite.scenarios) {
    const reference = prepare(t, scenario, "references", `reference-${scenario.id}`);
    const alternative = prepare(t, scenario, "alternatives", `alternative-${scenario.id}`);
    const referenceGrade = grade(reference.workspace, reference.oraclePath, scenario.id);
    const alternativeGrade = grade(alternative.workspace, alternative.oraclePath, scenario.id);
    assert.equal(referenceGrade.passed, true, JSON.stringify(referenceGrade.checks));
    assert.equal(alternativeGrade.passed, true, JSON.stringify(alternativeGrade.checks));
    assert.equal(referenceGrade.score, 10);
    assert.equal(alternativeGrade.score, 10);
    assert.notEqual(treeDigest(reference.workspace), treeDigest(alternative.workspace), `${scenario.id} alternative duplicates reference`);
  }
});

test("one exact mutation per rubric check is killed", (t) => {
  assert.deepEqual(new Set(mutations.map((mutation) => mutation[1])), new Set(Object.values(rubric.scenarios).flat().map((item) => item.id)));
  for (const [scenarioId, checkId, file, before, after] of mutations) {
    const scenario = suite.scenarios.find((item) => item.id === scenarioId);
    const { workspace, oraclePath } = prepare(t, scenario, "references", `mutation-${checkId}`);
    replaceExactlyOnce(path.join(workspace, file), before, after);
    const result = grade(workspace, oraclePath, scenarioId);
    assert.equal(result.checks.find((item) => item.id === checkId)?.passed, false, `${checkId} survived its mutation`);
    assert.equal(result.passed, false);
  }
});

test("scope proof accepts reference overlays and rejects unrelated project writes", (t) => {
  for (const scenario of suite.scenarios) {
    const { workspace, oraclePath } = prepare(t, scenario, "references", `scope-${scenario.id}`);
    assert.equal(grade(workspace, oraclePath, scenario.id).scopePassed, true);
    fs.appendFileSync(path.join(workspace, "README.md"), "\noutside declared scenario scope\n");
    const result = grade(workspace, oraclePath, scenario.id);
    assert.equal(result.scopePassed, false);
    assert.deepEqual(result.scopeViolations, ["README.md"]);
    assert.equal(result.passed, false);
  }
});

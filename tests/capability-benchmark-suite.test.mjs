import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { validateBenchmarkSuite } from "../packages/piagent-core/benchmark/benchmark-core.js";

const root = path.resolve(import.meta.dirname, "..");
const suiteRoot = path.join(root, "benchmarks", "capability-v1");
const suite = JSON.parse(fs.readFileSync(path.join(suiteRoot, "suite.json"), "utf8"));
const rubric = JSON.parse(fs.readFileSync(path.join(suiteRoot, "rubric.json"), "utf8"));
const coverage = JSON.parse(fs.readFileSync(path.join(suiteRoot, "coverage.json"), "utf8"));
const generator = path.join(suiteRoot, "variant.mjs");
const grader = path.join(suiteRoot, "grade.mjs");
const promptByScenario = Object.fromEntries(suite.scenarios.map((scenario) => [
  scenario.id,
  fs.readFileSync(path.join(suiteRoot, scenario.prompt), "utf8")
]));

function grade(workspace, oraclePath, scenarioId) {
  const result = spawnSync(process.execPath, [grader, workspace, oraclePath], {
    encoding: "utf8",
    env: { ...process.env, PIAGENT_BENCHMARK_SCENARIO: scenarioId }
  });
  assert.equal(result.status, 0, `${scenarioId} grader failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function prepareReference(t, scenario, suffix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `piagent-capability-${suffix}-`));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const workspace = path.join(temporaryRoot, "project");
  const oraclePath = path.join(temporaryRoot, "oracle.json");
  fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
  fs.cpSync(path.join(suiteRoot, "references", scenario.id), workspace, { recursive: true, force: true });
  const generated = spawnSync(process.execPath, [generator, workspace, oraclePath, `calibration-${scenario.id}-${suffix}`, scenario.id], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  return { workspace, oraclePath };
}

function replaceExactlyOnce(file, before, after) {
  const source = fs.readFileSync(file, "utf8");
  assert.equal(source.split(before).length - 1, 1, `calibration mutation anchor is not unique in ${file}`);
  fs.writeFileSync(file, source.replace(before, after));
}

test("capability-v1 is a public unsaturated multi-component suite", () => {
  assert.equal(validateBenchmarkSuite(suite), suite);
  assert.equal(suite.assurance.claimTier, "capability");
  assert.equal(suite.assurance.familyDisjointSplit, false);
  assert.equal(suite.releaseGate.minimumOutcomeScoreExclusive, 9.5);
  assert.equal(suite.scenarios.length, 4);
  assert.equal(suite.scenarios.every((scenario) => scenario.difficulty === "large"), true);
  assert.equal(suite.scenarios.every((scenario) => scenario.allowedChanges.length >= 2), true);
  assert.deepEqual(new Set(suite.scenarios.map((scenario) => scenario.category)), new Set(["platform", "fullstack", "reliability", "data"]));
});

test("every capability grader rejects the seeded regression and accepts its reference solution", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-capability-suite-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  for (const scenario of suite.scenarios) {
    const workspace = path.join(temporaryRoot, scenario.id);
    const oraclePath = path.join(temporaryRoot, `${scenario.id}.oracle.json`);
    fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
    const generated = spawnSync(process.execPath, [generator, workspace, oraclePath, `capability-seed-${scenario.id}`, scenario.id], { encoding: "utf8" });
    assert.equal(generated.status, 0, `${scenario.id} generator failed:\n${generated.stderr}`);
    const visible = spawnSync("npm", ["test", "--", "--test-reporter=dot"], { cwd: workspace, encoding: "utf8" });
    assert.equal(visible.status, 0, `${scenario.id} visible tests failed:\n${visible.stdout}\n${visible.stderr}`);

    const regression = grade(workspace, oraclePath, scenario.id);
    assert.equal(regression.passed, false, `${scenario.id} seeded regression unexpectedly passed`);
    assert.ok(regression.score >= 0 && regression.score < 10, `${scenario.id} regression score is not calibrated`);

    fs.cpSync(path.join(suiteRoot, "references", scenario.id), workspace, { recursive: true, force: true });
    const reference = grade(workspace, oraclePath, scenario.id);
    assert.equal(reference.passed, true, `${scenario.id} reference failed: ${JSON.stringify(reference.checks)}`);
    assert.equal(reference.criticalPassed, true);
    assert.equal(reference.score, 10);
    assert.deepEqual(reference.checks, rubric.scenarios[scenario.id].map((item) => ({ ...item, passed: true })));
  }
});

test("every explicit prompt clause maps to a unique weighted critical rubric", () => {
  assert.equal(rubric.schemaVersion, 1);
  assert.deepEqual(Object.keys(rubric.scenarios).sort(), suite.scenarios.map((scenario) => scenario.id).sort());
  for (const scenario of suite.scenarios) {
    const clauses = [...promptByScenario[scenario.id].matchAll(/\[([A-Z]\d+)\]/g)].map((match) => match[1]);
    const definitions = rubric.scenarios[scenario.id];
    assert.equal(new Set(clauses).size, clauses.length, `${scenario.id} repeats a prompt clause label`);
    assert.deepEqual(new Set(definitions.map((item) => item.clause)), new Set(clauses), `${scenario.id} prompt/rubric clause mismatch`);
    assert.equal(new Set(definitions.map((item) => item.id)).size, definitions.length, `${scenario.id} repeats a check id`);
    assert.equal(definitions.every((item) => item.critical === true && Number.isFinite(item.weight) && item.weight > 0), true);
  }
});

test("every rubric check has an explicit sensitivity rationale", () => {
  const definitions = Object.values(rubric.scenarios).flat();
  assert.equal(coverage.schemaVersion, 1);
  assert.deepEqual(new Set(Object.keys(coverage.checks)), new Set(definitions.map((item) => item.id)));
  for (const definition of definitions) {
    assert.equal(typeof coverage.checks[definition.id], "string");
    assert.ok(coverage.checks[definition.id].length >= 40, `${definition.id} sensitivity rationale is incomplete`);
  }
});

test("an independently shaped search implementation satisfies the same rubric", (t) => {
  const scenario = suite.scenarios.find((item) => item.id === "fullstack-search-contract");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-capability-alternative-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const workspace = path.join(temporaryRoot, "project");
  const oraclePath = path.join(temporaryRoot, "oracle.json");
  fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
  fs.cpSync(path.join(suiteRoot, "alternatives", scenario.id), workspace, { recursive: true, force: true });
  const generated = spawnSync(process.execPath, [generator, workspace, oraclePath, "independent-valid-search", scenario.id], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const result = grade(workspace, oraclePath, scenario.id);
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.score, 10);
});

test("an independently shaped migration implementation satisfies the structural rubric", (t) => {
  const scenario = suite.scenarios.find((item) => item.id === "resumable-migration-runner");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-capability-migration-alternative-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const workspace = path.join(temporaryRoot, "project");
  const oraclePath = path.join(temporaryRoot, "oracle.json");
  fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
  fs.cpSync(path.join(suiteRoot, "alternatives", scenario.id), workspace, { recursive: true, force: true });
  const generated = spawnSync(process.execPath, [generator, workspace, oraclePath, "independent-valid-migration", scenario.id], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const result = grade(workspace, oraclePath, scenario.id);
  assert.equal(result.passed, true, JSON.stringify(result.checks));
  assert.equal(result.score, 10);
});

test("migration prompt and safe grader diagnostics expose the exact non-whitespace partition", (t) => {
  assert.match(
    promptByScenario["resumable-migration-runner"],
    /ids that contain at least one non-whitespace character/
  );
  const scenario = suite.scenarios.find((item) => item.id === "resumable-migration-runner");
  const { workspace, oraclePath } = prepareReference(t, scenario, "whitespace-id-diagnostic");
  replaceExactlyOnce(
    path.join(workspace, "packages/migration/src/plan.js"),
    "!step.id.trim()",
    "step.id.length === 0"
  );

  const result = grade(workspace, oraclePath, scenario.id);
  const failed = result.checks.find((item) => item.id === "migration-step-validation");
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failedPartitions, ["whitespace-only-id"]);
  assert.equal(failed.detail, "failed partitions: whitespace-only-id");
  const oracleValues = JSON.parse(fs.readFileSync(oraclePath, "utf8")).graderData.ids;
  for (const value of oracleValues) assert.equal(JSON.stringify(failed).includes(value), false);
});

test("migration validity survives distinct ESM identities and fresh public objects", async (t) => {
  const scenario = suite.scenarios.find((item) => item.id === "resumable-migration-runner");
  const { workspace } = prepareReference(t, scenario, "structural-module-identity");
  const planUrl = pathToFileURL(path.join(workspace, "packages/migration/src/plan.js")).href;
  const runnerUrl = pathToFileURL(path.join(workspace, "packages/migration/src/runner.js")).href;
  const { migrationPlan } = await import(`${planUrl}?planner=independent`);
  const { runMigration } = await import(`${runnerUrl}?runner=independent`);
  const original = [
    { id: "publish", dependsOn: ["prepare"], apply() {} },
    { id: "prepare", dependsOn: [], apply() {} }
  ];
  const reconstructed = migrationPlan(original).map((step) => ({
    id: step.id,
    dependsOn: [...step.dependsOn],
    apply() {}
  }));
  const calls = [];
  const checkpoint = { read: async () => [], write: async () => {} };
  await runMigration({ steps: reconstructed, checkpoint, apply: async (step) => calls.push(step.id) });
  assert.deepEqual(calls, ["prepare", "publish"]);
  await assert.rejects(runMigration({ steps: [...reconstructed].reverse(), checkpoint, apply: async () => {} }), TypeError);
});

test("one targeted mutation per prompt clause is killed by its atomic rubric", (t) => {
  const mutations = [
    {
      scenario: "multi-package-rollout", clause: "R1", check: "rollout-normalized-shape", file: "packages/policy/src/rollout.js",
      before: "enabled: Boolean(input.enabled)", after: "enabled: input.enabled"
    },
    {
      scenario: "multi-package-rollout", clause: "R2", check: "rollout-invalid-tenants", file: "packages/policy/src/rollout.js",
      before: "if (typeof tenant !== \"string\" || !tenant.trim())", after: "if (typeof tenant !== \"string\")"
    },
    {
      scenario: "multi-package-rollout", clause: "R3", check: "rollout-percentage-boundaries", file: "packages/policy/src/rollout.js",
      before: "return subject.bucket < normalized.percentage;", after: "return subject.bucket <= normalized.percentage;"
    },
    {
      scenario: "multi-package-rollout", clause: "R4", check: "feature-access-reasons", file: "packages/api/src/feature-access.js",
      before: "reason: allowed ? \"percentage\" : \"not-eligible\"", after: "reason: \"percentage\""
    },
    {
      scenario: "multi-package-rollout", clause: "R5", check: "rollout-summary", file: "apps/admin/src/rollout-view.js",
      before: "`enabled=${value.enabled};", after: "`active=${value.enabled};"
    },
    {
      scenario: "fullstack-search-contract", clause: "S1", check: "query-normalization", file: "packages/shared/src/search-contract.js",
      before: ".normalize(\"NFD\")", after: ".normalize(\"NFC\")"
    },
    {
      scenario: "fullstack-search-contract", clause: "S2", check: "catalog-limit-contract", file: "services/catalog/src/search.js",
      before: ".slice(0, limit);", after: ".slice(0, limit + 1);"
    },
    {
      scenario: "fullstack-search-contract", clause: "S3", check: "search-render-exact-escaping", file: "apps/web/src/search-view.js",
      before: ".replaceAll(\"<\", \"&lt;\")", after: ".replaceAll(\"<\", \"<\")"
    },
    {
      scenario: "concurrent-lease-lifecycle", clause: "L1", check: "lease-acquire-input-validation", file: "packages/lease/src/store.js",
      before: "value < minimum", after: "value < 0"
    },
    {
      scenario: "concurrent-lease-lifecycle", clause: "L2", check: "lease-contention-inclusive-expiry", file: "packages/lease/src/store.js",
      before: "now < current.expiresAt && current.owner !== owner", after: "now <= current.expiresAt && current.owner !== owner"
    },
    {
      scenario: "concurrent-lease-lifecycle", clause: "L3", check: "lease-snapshot-isolation", file: "packages/lease/src/store.js",
      before: "return value ? { ...value } : undefined;", after: "return value;"
    },
    {
      scenario: "concurrent-lease-lifecycle", clause: "L4", check: "with-lease-success-callback", file: "packages/lease/src/with-lease.js",
      before: "operation((now) => store.renew(key, owner, now, options.ttlMs))", after: "operation({ renew: (now) => store.renew(key, owner, now, options.ttlMs) })"
    },
    {
      scenario: "resumable-migration-runner", clause: "M1", check: "migration-step-validation", file: "packages/migration/src/plan.js",
      before: " || typeof step.apply !== \"function\"", after: ""
    },
    {
      scenario: "resumable-migration-runner", clause: "M2", check: "migration-stable-ready-order", file: "packages/migration/src/plan.js",
      before: "indexById.get(left) - indexById.get(right)", after: "indexById.get(right) - indexById.get(left)"
    },
    {
      scenario: "resumable-migration-runner", clause: "M3", check: "migration-checkpoint-validation", file: "packages/migration/src/runner.js",
      before: "if (!Array.isArray(stored) || stored.some((id) => !known.has(id)))", after: "if (!Array.isArray(stored))"
    },
    {
      scenario: "resumable-migration-runner", clause: "M4", check: "migration-crash-resume", file: "packages/migration/src/runner.js",
      before: "    await apply(step);\n    completed.push(step.id); completedSet.add(step.id);\n    await checkpoint.write([...completed]);",
      after: "    completed.push(step.id); completedSet.add(step.id);\n    await checkpoint.write([...completed]);\n    await apply(step);"
    }
  ];
  const expectedClauses = new Set(Object.values(rubric.scenarios).flatMap((items) => items.map((item) => item.clause)));
  assert.deepEqual(new Set(mutations.map((item) => item.clause)), expectedClauses);

  for (const [index, mutation] of mutations.entries()) {
    const scenario = suite.scenarios.find((item) => item.id === mutation.scenario);
    const { workspace, oraclePath } = prepareReference(t, scenario, `${index}-${mutation.clause}`);
    replaceExactlyOnce(path.join(workspace, mutation.file), mutation.before, mutation.after);
    const result = grade(workspace, oraclePath, mutation.scenario);
    assert.equal(result.checks.find((item) => item.id === mutation.check)?.passed, false, `${mutation.scenario}:${mutation.check} mutation survived`);
    const failedClauses = new Set(result.checks.filter((item) => !item.passed).map((item) => item.clause));
    assert.equal(failedClauses.has(mutation.clause), true, `${mutation.scenario}:${mutation.clause} mutation survived`);
    assert.equal(result.passed, false, `${mutation.scenario}:${mutation.clause} did not fail the critical gate`);
    assert.ok(result.score >= 0 && result.score <= 9.5, `${mutation.scenario}:${mutation.clause} score did not fail the >9.5 floor`);
  }
});

test("capability variant generation is repeatable without exposing raw values in the suite manifest", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-capability-variant-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const scenario = suite.scenarios[0];
  const outputs = [];
  for (const seed of ["same", "same", "different"]) {
    const oraclePath = path.join(temporaryRoot, `${outputs.length}.json`);
    const result = spawnSync(process.execPath, [generator, temporaryRoot, oraclePath, seed, scenario.id], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    outputs.push(fs.readFileSync(oraclePath, "utf8"));
  }
  assert.equal(outputs[0], outputs[1]);
  assert.notEqual(outputs[0], outputs[2]);
  assert.equal(JSON.stringify(suite).includes(JSON.parse(outputs[0]).graderData.tenantA), false);
});

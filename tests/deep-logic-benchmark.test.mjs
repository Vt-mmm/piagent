import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

import { requestedSuite } from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { loadBenchmarkSuite, validateBenchmarkSuiteFiles } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { matchesAnyPath } from "../packages/piagent-core/extensions/policy-core.js";

const root = path.resolve(import.meta.dirname, ".."), temporary = [];
after(() => { for (const target of temporary) fs.rmSync(target, { recursive: true, force: true }); });

describe("deep logic benchmark", () => {
  it("freezes the deep suite when the billed runner receives the --deep alias", () => {
    assert.equal(requestedSuite(["--deep"], root), "deep-logic-v1");
  });

  it("loads as a bounded built-in suite with seven large generated-variant families", () => {
    const { suite, suiteRoot } = loadBenchmarkSuite("deep-logic-v1", root);
    validateBenchmarkSuiteFiles(suite, suiteRoot);
    assert.equal(suite.schemaVersion, 2);
    assert.equal(suite.scenarios.length, 7);
    assert.equal(suite.defaultRepeats, 3);
    assert.equal(suite.assurance.claimTier, "capability");
    assert.equal(suite.assurance.generatedVariants, true);
    assert.equal(suite.releaseGate.minimumPairedScenarios, 7);
    assert.equal(suite.releaseGate.minimumComparableEfficiencyScenarios, 7);
    assert.equal(suite.releaseGate.maximumInfrastructureRetries, 0);
    assert.equal(suite.releaseGate.maximumFreshTokenRatioUpper95, 0.8);
    assert.equal(suite.releaseGate.maximumDurationRatioUpper95, 1.1);
    assert.equal(suite.releaseGate.primaryEfficiencyEstimand, "failure-aware-family-ratio");
    assert.equal(suite.releaseGate.requireFullSuiteForClaim, true);
    assert.equal(suite.releaseGate.requireStableProviderWireSurface, true);
    assert.deepEqual(suite.executionContract, {
      surfaces: ["piagent", "codex-cli"],
      model: "openai-codex/gpt-5.6-luna",
      thinking: "medium",
      codexMode: "controlled"
    });
    assert.ok(suite.scenarios.every((item) => item.difficulty === "large" && item.variantGenerator === "variant.mjs"));
    assert.equal(new Set(suite.scenarios.map((item) => item.category)).size, 7);
    assert.equal(suite.scenarios.find((item) => item.id === "layered-policy-resolution").profile, "backend-api");
    assert.match(fs.readFileSync(path.join(suiteRoot, "prompts/layered-policy-resolution.md"), "utf8"), /Invalid requests[\s\S]*must throw/);
    const grader = fs.readFileSync(path.join(suiteRoot, "grade.mjs"), "utf8");
    assert.doesNotMatch(grader, /pattern:\s*["']\*\*\/\*\./, "policy grader must not use embedded wildcard syntax forbidden by its prompt");
    assert.match(fs.readFileSync(path.join(suiteRoot, "prompts/fair-dependency-scheduler.md"), "utf8"), /Order inside a returned wave records selection order/);
    const streamPrompt = fs.readFileSync(path.join(suiteRoot, "prompts/resumable-stream-assembly.md"), "utf8");
    assert.match(streamPrompt, /UTF-16 `String\.length`/);
    assert.match(streamPrompt, /any later event[\s\S]*including an empty chunk/);
    for (const check of [
      "contiguous-interleaving-exact-duplicates-and-order",
      "replay-gap-and-buffer-order",
      "utf16-offset-and-empty-finalization",
      "event-after-completion-rejected",
      "input-shape-validation"
    ]) assert.match(grader, new RegExp(`check\\(\"${check}\"`));
    const billingPrompt = fs.readFileSync(path.join(suiteRoot, "prompts/temporal-usage-billing-close.md"), "utf8");
    assert.match(billingPrompt, /round-half-to-even/);
    assert.match(billingPrompt, /BigInt/);
    assert.match(billingPrompt, /Terminal\/WebUI summary/);
  });

  it("generates private oracle data for every family without changing the fixture", () => {
    const { suite, suiteRoot } = loadBenchmarkSuite("deep-logic-v1", root);
    const fixture = fs.readFileSync(path.join(suiteRoot, "project/src/event-reconcile.js"), "utf8");
    for (const scenario of suite.scenarios) {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-deep-suite-")); temporary.push(target);
      const oracle = path.join(target, "oracle.json");
      const result = spawnSync(process.execPath, [path.join(suiteRoot, "variant.mjs"), target, oracle, "deterministic-seed", scenario.id], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const value = JSON.parse(fs.readFileSync(oracle, "utf8"));
      assert.equal(value.schemaVersion, 1);
      assert.ok(value.graderData && Object.keys(value.graderData).length > 0);
    }
    assert.equal(fs.readFileSync(path.join(suiteRoot, "project/src/event-reconcile.js"), "utf8"), fixture);
  });

  it("makes the public verifier load every entrypoint and exercise the selected scenario", () => {
    const { suite, suiteRoot } = loadBenchmarkSuite("deep-logic-v1", root);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-deep-public-")); temporary.push(target);
    fs.cpSync(path.join(suiteRoot, "project"), target, { recursive: true });
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const verifierArgs = ["--test", "benchmark-contract/public-smoke.test.js", "test/smoke.test.js"];
    const fixtureManifest = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    const publicContract = fs.readFileSync(path.join(target, "benchmark-contract/public-smoke.test.js"), "utf8");
    assert.match(fixtureManifest.scripts.test, /benchmark-contract\/\*\.test\.js/);
    assert.match(publicContract, /legacy:\s*\{\s*\$delete:\s*true\s*\}/);
    assert.match(publicContract, /item\.path === "\/legacy" && item\.kind === "delete"/);
    assert.match(publicContract, /const emptyFinal = \[\{[\s\S]*text: ""[\s\S]*complete: true/);
    assert.match(publicContract, /assert\.throws\(\(\) => assembleStream\(completedSnapshot, completedEvents\)\)/);
    for (const scenario of suite.scenarios) {
      assert.equal(Boolean(matchesAnyPath("benchmark-contract/public-smoke.test.js", scenario.allowedChanges)), false);
      assert.equal(Boolean(matchesAnyPath("package.json", scenario.allowedChanges)), false);
    }
    const baseline = spawnSync(process.execPath, verifierArgs, { cwd: target, encoding: "utf8", env: childEnv });
    assert.equal(baseline.status, 0, baseline.stderr);
    for (const scenario of suite.scenarios) {
      const exercised = spawnSync(process.execPath, verifierArgs, {
        cwd: target,
        encoding: "utf8",
        env: { ...childEnv, PIAGENT_BENCHMARK_SCENARIO: scenario.id }
      });
      assert.notEqual(exercised.status, 0, `the unsolved ${scenario.id} fixture must fail its public behavioral smoke\n${exercised.stdout}\n${exercised.stderr}`);
    }
    fs.writeFileSync(path.join(target, "src/config-transaction.js"), "export const broken = ;\n");
    assert.equal(fs.readFileSync(path.join(target, "src/config-transaction.js"), "utf8"), "export const broken = ;\n");
    const broken = spawnSync(process.execPath, verifierArgs, { cwd: target, encoding: "utf8", env: childEnv });
    assert.notEqual(broken.status, 0, `the public verifier must reject a syntax-broken benchmark implementation\n${broken.stdout}\n${broken.stderr}`);
  });

  it("keeps the specialist billing fixture unsolved and exposes seventeen diagnostic checks", () => {
    const { suiteRoot } = loadBenchmarkSuite("deep-logic-v1", root);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-deep-billing-")); temporary.push(target);
    const project = path.join(target, "project"), oracle = path.join(target, "oracle.json");
    fs.cpSync(path.join(suiteRoot, "project"), project, { recursive: true });
    const generated = spawnSync(process.execPath, [path.join(suiteRoot, "variant.mjs"), project, oracle, "billing-sensitivity", "temporal-usage-billing-close"], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const graded = spawnSync(process.execPath, [path.join(suiteRoot, "grade.mjs"), project, oracle], {
      encoding: "utf8",
      env: { ...process.env, PIAGENT_BENCHMARK_SCENARIO: "temporal-usage-billing-close" }
    });
    assert.equal(graded.status, 0, graded.stderr);
    const result = JSON.parse(graded.stdout);
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 17);
    assert.equal(result.checks.every((check) => check.passed === false), true);
  });
});

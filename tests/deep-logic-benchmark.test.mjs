import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

import { requestedSuite } from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { loadBenchmarkSuite, validateBenchmarkSuiteFiles } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";

const root = path.resolve(import.meta.dirname, ".."), temporary = [];
after(() => { for (const target of temporary) fs.rmSync(target, { recursive: true, force: true }); });

describe("deep logic benchmark", () => {
  it("freezes the deep suite when the billed runner receives the --deep alias", () => {
    assert.equal(requestedSuite(["--deep"], root), "deep-logic-v1");
  });

  it("loads as a bounded built-in suite with six large generated-variant families", () => {
    const { suite, suiteRoot } = loadBenchmarkSuite("deep-logic-v1", root);
    validateBenchmarkSuiteFiles(suite, suiteRoot);
    assert.equal(suite.scenarios.length, 6);
    assert.equal(suite.defaultRepeats, 2);
    assert.ok(suite.scenarios.every((item) => item.difficulty === "large" && item.variantGenerator === "variant.mjs"));
    assert.equal(new Set(suite.scenarios.map((item) => item.category)).size, 6);
    assert.equal(suite.scenarios.find((item) => item.id === "layered-policy-resolution").profile, "backend-api");
    assert.match(fs.readFileSync(path.join(suiteRoot, "prompts/layered-policy-resolution.md"), "utf8"), /Invalid requests[\s\S]*must throw/);
    const grader = fs.readFileSync(path.join(suiteRoot, "grade.mjs"), "utf8");
    assert.doesNotMatch(grader, /pattern:\s*["']\*\*\/\*\./, "policy grader must not use embedded wildcard syntax forbidden by its prompt");
    assert.match(fs.readFileSync(path.join(suiteRoot, "prompts/fair-dependency-scheduler.md"), "utf8"), /Order inside a returned wave records selection order/);
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

  it("makes the public verifier load every benchmark entrypoint", () => {
    const { suiteRoot } = loadBenchmarkSuite("deep-logic-v1", root);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-deep-public-")); temporary.push(target);
    fs.cpSync(path.join(suiteRoot, "project"), target, { recursive: true });
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const baseline = spawnSync(process.execPath, ["--test", "test/smoke.test.js"], { cwd: target, encoding: "utf8", env: childEnv });
    assert.equal(baseline.status, 0, baseline.stderr);
    fs.writeFileSync(path.join(target, "src/config-transaction.js"), "export const broken = ;\n");
    assert.equal(fs.readFileSync(path.join(target, "src/config-transaction.js"), "utf8"), "export const broken = ;\n");
    const broken = spawnSync(process.execPath, ["--test", "test/smoke.test.js"], { cwd: target, encoding: "utf8", env: childEnv });
    assert.notEqual(broken.status, 0, `the public verifier must reject a syntax-broken benchmark implementation\n${broken.stdout}\n${broken.stderr}`);
  });
});

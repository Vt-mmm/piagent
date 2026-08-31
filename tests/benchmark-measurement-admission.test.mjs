import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { executionOrder, pairedChunk } from "../scripts/benchmark-runner-support.mjs";
import { pairedOutcomeFloorStop } from "../packages/piagent-core/benchmark/benchmark-stop-policy.js";
import { createProductionStageControl, productionStageResumeDisposition } from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";

const root = path.resolve(import.meta.dirname, "..");
const core = path.join(root, "scripts/benchmark-runner-core.mjs");
const suite = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v2/suite.json"), "utf8"));
const control = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v2/spend-control.v1.json"), "utf8"));
const measurement = ["--suite", "production-v2", "--measurement-only"];
function invoke(args) {
  // Calling the core directly cannot start a provider: the immutable wrapper
  // boundary must reject every admitted paid plan before auth or preflight.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PIAGENT_BENCHMARK_")) delete env[key];
  return spawnSync(process.execPath, [core, ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
}

test("measurement admits exactly the full 108-session paid window but still requires immutable execution", () => {
  const result = invoke([...measurement, "--max-sessions", "108", "--yes"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /must start through scripts\/benchmark-runner\.mjs/);
  assert.doesNotMatch(result.stderr, /requires --stop-after-failed-pair|requires --max-sessions/);
  for (const window of [[], ["--max-sessions", "12"], ["--max-sessions", "110"]]) {
    const rejected = invoke([...measurement, ...window, "--yes"]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /requires --max-sessions 108/);
    assert.doesNotMatch(rejected.stderr, /must start through scripts\/benchmark-runner\.mjs/);
  }
});

test("measurement keeps provider-free admission and the complete frozen comparison plan", () => {
  const preflight = invoke([...measurement, "--preflight-only"]);
  assert.equal(preflight.status, 1);
  assert.match(preflight.stderr, /must start through scripts\/benchmark-runner\.mjs/);
  const preview = invoke([...measurement, "--max-sessions", "108", "--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /sessions:\s+108/);
  assert.match(preview.stdout, /measurement-only/);
  assert.match(preview.stdout, /model:\s+openai-codex\/gpt-5\.6-luna/);
  assert.match(preview.stdout, /thinking:\s+medium/);
  assert.match(preview.stdout, /no model session started/);
});

test("measurement cannot select easier tasks, change parity, retry, or enable outcome early-stop", () => {
  for (const args of [
    ["--stop-after-failed-pair"], ["--scenarios", "expiry-boundary"],
    ["--max-runtime-minutes", "1"], ["--seed", "another-seed"],
    ["--repeats", "1"], ["--model", "test/other-model"],
    ["--thinking", "low"], ["--service-tier", "default"],
    ["--infrastructure-retries", "1"], ["--codex-mode", "native"],
    ["--piagent-treatment", "feature-off"]
  ]) {
    const result = invoke([...measurement, "--max-sessions", "108", ...args, "--yes"]);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.doesNotMatch(result.stderr, /must start through scripts\/benchmark-runner\.mjs/, args.join(" "));
  }
  for (const id of ["core-v1", "production-v1"]) {
    const result = invoke(["--suite", id, "--measurement-only", "--max-sessions", "108", "--yes"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /complete production-v2/);
  }
});

test("default release admission still requires the original S12 and outcome-stop contract", () => {
  for (const [args, expected] of [
    [["--max-sessions", "108", "--stop-after-failed-pair"], /requires --max-sessions 12/],
    [["--max-sessions", "12"], /requires --stop-after-failed-pair/]
  ]) {
    const result = invoke(["--suite", "production-v2", ...args, "--yes"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});

test("the full observation window keeps 108 distinct paired cells and passes former stage boundaries", () => {
  const order = executionOrder(suite, control.execution.repeats, control.execution.surfaces, control.rootSeed);
  assert.equal(order.length, 108);
  assert.deepEqual(pairedChunk(order, 108), order);
  assert.equal(new Set(order.map(item => `${item.scenario.id}/${item.surface}/${item.repeat}`)).size, 108);
  assert.equal(new Set(order.map(item => item.scenario.familyId)).size, 9);
  const stage = createProductionStageControl({ authorizedThroughRuns: 108, generatedAt: "2026-08-31T00:00:00.000Z" });
  for (const completedRuns of [0, 6, 12, 18, 54, 106]) {
    const disposition = productionStageResumeDisposition(stage, { completedRuns, stageBoundaries: [0, 108] });
    assert.equal(disposition.passed, true);
    assert.equal(disposition.requiresStageGate, false);
  }
  const failed = { scenarioId: order[0].scenario.id, surface: "piagent", repeat: 1, resolved: false, grade: { score: 0 } };
  assert.equal(pairedOutcomeFloorStop({ enabled: false, suite, runs: [failed], current: order[0], next: order[1] }), null);
  assert.equal(failed.resolved, false);
  assert.equal(failed.grade.score, 0);
});

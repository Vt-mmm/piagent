#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const laneRoot = path.dirname(fileURLToPath(import.meta.url));
const lane = JSON.parse(fs.readFileSync(path.join(laneRoot, "parity-lane.v1.json"), "utf8"));
const argumentsList = process.argv.slice(2);
const outputIndex = argumentsList.indexOf("--output");
const outputPath = outputIndex >= 0 ? argumentsList[outputIndex + 1] : null;
if (outputIndex >= 0 && !outputPath) throw new Error("--output requires a path");
const node = process.execPath;
const steps = [];

function run(name, command, args, options = {}) {
  const started = Date.now();
  const { allowFailure = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...spawnOptions });
  const step = { name, passed: result.status === 0, durationMs: Date.now() - started,
    exitCode: result.status, output: String(result.stdout ?? "").trim().slice(-12_000), error: String(result.stderr ?? "").trim().slice(-4_000) };
  steps.push(step);
  if (!step.passed && !allowFailure) throw new Error(`${name} failed`);
  return step;
}

let report;
try {
  for (const group of lane.testGroups) run(group.name, node, ["--test", ...group.files]);
  run("production-webui-build", lane.build[0], lane.build.slice(1));
  run("chromium-user-flows", lane.browser[0], lane.browser.slice(1));
  for (const profile of lane.performanceProfiles) {
    const step = run(`performance-${profile.name}`, node, ["packages/piagent-webui/benchmark/benchmark.mjs",
      `--files=${profile.files}`, `--changed=${profile.changed}`, `--samples=${profile.samples}`], { allowFailure: true });
    try {
      step.metrics = JSON.parse(step.output);
      const gates = step.metrics.gates ?? {};
      const expectedMetrics = ["cachedSnapshotP95Ms", "exactSourceP95Ms", "smallDiffP95Ms", "rssMiB"];
      if (expectedMetrics.some((key) => !Number.isFinite(step.metrics.metrics?.[key]))) throw new Error(`${step.name} metrics incomplete`);
      step.warnings = Object.entries(gates).filter(([, passed]) => passed === false).map(([gate]) => `${gate}-budget-exceeded`);
      // Performance remains visible but advisory in the parity gate. The
      // standalone WebUI performance benchmark keeps these same budgets strict.
      step.passed = true;
    } catch (error) {
      if (!step.metrics) throw new Error(`${step.name} produced no readable metrics`);
      throw error;
    }
  }
} catch (error) {
  report = { schemaVersion: 1, benchmark: lane.id, passed: false,
    providerCalls: 0, modelTokens: 0, reason: error instanceof Error ? error.message : String(error), steps };
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (!process.exitCode) report = { schemaVersion: 1, benchmark: lane.id, passed: true,
    providerCalls: 0, modelTokens: 0, performanceWarnings: steps.flatMap((step) => (step.warnings ?? []).map((warning) => `${step.name}:${warning}`)),
    invariants: lane.invariants, claimBoundary: lane.claimBoundary, steps };
  if (outputPath && report) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (!process.exitCode) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

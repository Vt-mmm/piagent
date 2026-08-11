import assert from "node:assert/strict";
import test from "node:test";

import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import {
  benchmarkEnvironment,
  piagentProcessEnvironment,
  piagentTreatment
} from "../packages/piagent-core/benchmark/benchmark-runtime.js";

test("parses and validates explicit Piagent benchmark treatments", () => {
  assert.equal(parseBenchmarkArgs([]).piagentTreatment, "release-defaults");
  assert.equal(parseBenchmarkArgs(["--piagent-treatment", "candidate"]).piagentTreatment, "candidate");
  assert.equal(parseBenchmarkArgs(["--piagent-treatment", "causal-phase-enforce"]).piagentTreatment, "causal-phase-enforce");
  assert.equal(parseBenchmarkArgs(["--piagent-treatment", "intelligence-engine"]).piagentTreatment, "intelligence-engine");
  assert.throws(
    () => parseBenchmarkArgs(["--piagent-treatment", "unknown"]),
    /release-defaults, local-safe, mechanical-core, intelligence-engine, causal-phase-enforce, candidate, feature-off/
  );
});

test("applies candidate treatment after stripping inherited Piagent overrides", () => {
  const original = process.env.PIAGENT_SOLVER_MODE;
  process.env.PIAGENT_SOLVER_MODE = "off";
  try {
    const candidate = piagentProcessEnvironment("candidate", { PIAGENT_BENCHMARK_SURFACE: "piagent" });
    assert.equal(candidate.PIAGENT_SOLVER_MODE, "recommend");
    assert.equal(candidate.PIAGENT_PHASE_TOOLS, "on");
    assert.equal(candidate.PIAGENT_AUTO_RECOVERY, "on");
    assert.equal(candidate.PIAGENT_HELPERS_MODE, "recommend");
    assert.equal(candidate.PIAGENT_EXECUTION_BACKEND, "host");

    const baseline = benchmarkEnvironment({ PIAGENT_BENCHMARK_SURFACE: "raw-pi" });
    assert.equal(baseline.PIAGENT_SOLVER_MODE, undefined);
    assert.equal(baseline.PIAGENT_PHASE_TOOLS, undefined);
    assert.equal(benchmarkEnvironment({ PI_OFFLINE: "0" }).PI_OFFLINE, "1");
  } finally {
    if (original === undefined) delete process.env.PIAGENT_SOLVER_MODE;
    else process.env.PIAGENT_SOLVER_MODE = original;
  }
});

test("records release defaults without inventing explicit feature flags", () => {
  assert.deepEqual(piagentTreatment("release-defaults"), {
    id: "release-defaults",
    explicit: false,
    environment: {}
  });
});

test("keeps the phase causal treatment identical to local-safe except CAP-09 input", () => {
  const baseline = piagentTreatment("local-safe").environment;
  const arm = piagentTreatment("causal-phase-enforce").environment;
  assert.deepEqual(
    Object.keys({ ...baseline, ...arm }).filter((key) => baseline[key] !== arm[key]),
    ["PIAGENT_PHASE_TOOLS"]
  );
  assert.equal(baseline.PIAGENT_PHASE_TOOLS, "shadow");
  assert.equal(arm.PIAGENT_PHASE_TOOLS, "on");
});

test("keeps the intelligence causal arms identical except for the criterion engine", () => {
  const baseline = piagentTreatment("mechanical-core").environment;
  const arm = piagentTreatment("intelligence-engine").environment;
  assert.deepEqual(Object.keys({ ...baseline, ...arm }).filter((key) => baseline[key] !== arm[key]), ["PIAGENT_INTELLIGENCE_ENGINE"]);
  assert.equal(baseline.PIAGENT_INTELLIGENCE_ENGINE, "off");
  assert.equal(arm.PIAGENT_INTELLIGENCE_ENGINE, "on");
  assert.equal(baseline.PIAGENT_PHASE_TOOLS, "shadow");
  assert.equal(arm.PIAGENT_PHASE_TOOLS, "shadow");
});

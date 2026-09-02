import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { codexExecArgs, codexExecResumeArgs, codexThinkingEffort } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import {
  assertCodexRuntimeCredential,
  benchmarkEnvironment,
  codexProcessEnvironment,
  codexRuntimeCredentialPolicy,
  createCodexRuntime,
  piagentProcessEnvironment,
  piagentTreatment
} from "../packages/piagent-core/benchmark/benchmark-runtime.js";

test("parses and validates explicit Piagent benchmark treatments", () => {
  const defaults = parseBenchmarkArgs([]);
  assert.equal(defaults.piagentTreatment, "release-defaults");
  assert.deepEqual(defaults.surfaces, ["piagent", "codex-cli"]);
  assert.equal(parseBenchmarkArgs(["--piagent-treatment", "candidate"]).piagentTreatment, "candidate");
  assert.equal(parseBenchmarkArgs(["--piagent-treatment", "causal-phase-enforce"]).piagentTreatment, "causal-phase-enforce");
  assert.equal(parseBenchmarkArgs(["--piagent-treatment", "intelligence-engine"]).piagentTreatment, "intelligence-engine");
  assert.throws(
    () => parseBenchmarkArgs(["--piagent-treatment", "unknown"]),
    /release-defaults, local-safe, mechanical-core, intelligence-engine, causal-phase-enforce, candidate, configured-independent-v2, feature-off/
  );
});

test("maps host thinking names to the exact Codex provider effort", () => {
  assert.equal(codexThinkingEffort("off"), "none");
  assert.equal(codexThinkingEffort("minimal"), "low");
  assert.equal(codexThinkingEffort("medium"), "medium");
});

test("keeps one Codex thread for production user journeys", () => {
  const options = { model: "openai-codex/gpt-5.6-luna", thinking: "medium", codexMode: "controlled" };
  const initial = codexExecArgs({ workspace: "/tmp/fixture", options, disabledFeatures: ["multi_agent"], persistent: true });
  assert.equal(initial.includes("--ephemeral"), false);
  assert.deepEqual(initial.slice(0, 4), ["exec", "--json", "--color", "never"]);
  assert.ok(initial.includes("--ignore-user-config"));
  assert.ok(initial.includes("--ignore-rules"));
  assert.deepEqual(codexExecResumeArgs({ threadId: "019abcde-1234-7000-8000-0123456789ab", options,
    disabledFeatures: ["multi_agent"] }).slice(0, 3), ["exec", "resume", "--json"]);
  assert.throws(() => codexExecResumeArgs({ threadId: "bad thread id", options }), /valid thread id/);
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

test("registered controlled Codex excludes environment credentials and rechecks the exact private copy", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "registered-codex-auth-test-"))),
    source = path.join(root, "auth.json");
  fs.writeFileSync(source, "private test credential\n", { mode: 0o600 });
  const names = ["PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
    prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT: source,
    OPENAI_API_KEY: "must-not-reach-codex", CODEX_ACCESS_TOKEN: "must-not-reach-codex" });
  let runtime;
  t.after(() => {
    runtime?.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  runtime = createCodexRuntime({ surfaces: ["codex-cli"], codexMode: "controlled",
    registeredMeasurement: "/frozen/registered-suite.json" });
  assert.equal(runtime.credentialBridge, "frozen-auth-json-copy");
  assert.deepEqual(codexRuntimeCredentialPolicy(runtime), {
    source: "frozen-auth-json-snapshot", environmentCredentials: "excluded",
    copyIntegrity: "stable-fd-o-excl-fsync",
    perDispatchIntegrity: "exact-private-stat-and-content-match"
  });
  const environment = codexProcessEnvironment(runtime, { OPENAI_API_KEY: "override",
    CODEX_ACCESS_TOKEN: "override" });
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CODEX_ACCESS_TOKEN, undefined);
  assert.doesNotThrow(() => assertCodexRuntimeCredential(runtime, { required: true }));
  const copy = path.join(runtime.home, "auth.json");
  fs.appendFileSync(copy, "drift");
  assert.throws(() => assertCodexRuntimeCredential(runtime, { required: true }),
    /credential copy changed/);
});

test("registered controlled Codex rejects an env-only credential when the frozen snapshot is absent", t => {
  const names = ["PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
    prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  delete process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT;
  process.env.OPENAI_API_KEY = "env-only-must-be-rejected";
  process.env.CODEX_ACCESS_TOKEN = "env-only-must-be-rejected";
  t.after(() => { for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  assert.throws(() => createCodexRuntime({ surfaces: ["codex-cli"], codexMode: "controlled",
    registeredMeasurement: "/frozen/registered-suite.json" }), /requires the frozen Codex auth.json snapshot/);
});

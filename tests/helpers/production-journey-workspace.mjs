import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadBenchmarkSuite, resolveBenchmarkSuiteEntry } from "../../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { runOfflineBenchmarkSession } from "../../scripts/benchmark-session.mjs";

// Use the real fixture/variant/onboarding/context/Git preparation, but stop at
// the existing offline seam BEFORE dispatch, accounting, grading or records.
// No synthetic provider usage or benchmark success is manufactured here.
export async function prepareProductionJourneyWorkspace(root, repositoryRoot, scenarioId) {
  const { suite, suiteRoot, manifestPath } = loadBenchmarkSuite("production-v3", repositoryRoot);
  const scenario = suite.scenarios.find(item => item.id === scenarioId);
  assert.ok(scenario?.userJourney, "the scenario must declare its actual journey");
  const runRoot = path.join(root, "preparation"), agentDir = path.join(root, "agent");
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const stop = new Error("test-owned-preparation-complete");
  let prepared;
  const forbidden = () => { throw new Error("benchmark-dispatch-or-accounting-forbidden-in-runtime-fixture"); };
  const runCommand = async (command, args, options = {}) => {
    assert.ok([process.execPath, "git", "bash"].includes(command), `unexpected preparation executable: ${command}`);
    if (command === "bash") assert.equal(args[0], path.join(repositoryRoot, "scripts/init-project.sh"));
    const env = { ...options.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(command, args, { cwd: options.cwd, env, input: options.input,
      encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { code: result.status ?? 1, signal: result.signal ?? null,
      timedOut: result.error?.code === "ETIMEDOUT", stdout: result.stdout ?? "", stderr: result.stderr ?? "", durationSeconds: 0 };
  };
  await assert.rejects(runOfflineBenchmarkSession({ packageRoot: repositoryRoot, runCommand,
    resolveSuiteEntry: resolveBenchmarkSuiteEntry, interrupted: () => false,
    persistCompletedRecord: forbidden, assertProviderDispatchReady: forbidden,
    onProviderAttemptStart: forbidden, onProviderAttemptReturned: forbidden,
    suite, suiteRoot, scenario, surface: "piagent", repeat: 1, orderIndex: 1,
    runId: "offline-runtime-fixture", runRoot,
    options: { timeoutSeconds: 120, model: "fixture/fixture", thinking: "off", piagentTreatment: "release-defaults" },
    piCommand: "forbidden-provider", codexCommand: "forbidden-provider", piRuntimeHome: { path: agentDir },
    systemCommands: { node: process.execPath, git: "git", bash: "bash" },
    suiteDigest: createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
    configurationDigest: createHash("sha256").update("offline-runtime-fixture-not-measurement").digest("hex"),
    rootSeed: "public-offline-runtime-fixture",
    piagentWebUiJourney: async input => { prepared = input; throw stop; }
  }), error => error === stop);
  assert.ok(prepared);
  assert.equal(prepared.turns.length, scenario.userJourney.turns.length);
  assert.equal(prepared.environment.PIAGENT_BENCHMARK_PROFILE, scenario.profile ?? suite.profile);
  assert.equal(fs.existsSync(path.join(prepared.workspace, ".pi/piagent-state/project-onboarding.json")),
    (scenario.lifecycle ?? "steady-state") === "steady-state", "preparation must preserve the real cold-start/steady-state boundary");
  assert.equal(fs.existsSync(path.join(path.dirname(prepared.workspace), "inflight.json")), false);
  return { ...prepared, scenario, suiteRoot, runRoot };
}

// A separate Node test process owns this environment. No caller auth files are
// loaded; the scripted model is the only model runtime the host will receive.
export async function withJourneyEnvironment(environment, callback) {
  const names = new Set([...Object.keys(process.env), ...Object.keys(environment)]
    .filter(name => name.startsWith("PIAGENT_") || name === "PI_CODING_AGENT_DIR" || name === "PI_OFFLINE"));
  const previous = new Map([...names].map(name => [name, process.env[name]]));
  for (const name of names) {
    if (environment[name] === undefined) delete process.env[name];
    else process.env[name] = environment[name];
  }
  try { return await callback(); }
  finally { for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } }
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const runner = path.join(root, "scripts", "benchmark-runner.mjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-runner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const operatorCodexHome = path.join(dir, "operator-codex-home");
  fs.mkdirSync(operatorCodexHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorCodexHome, "auth.json"), "test credential placeholder\n", { mode: 0o600 });
  const suiteRoot = path.join(dir, "suite");
  const project = path.join(suiteRoot, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), `${JSON.stringify({ name: "benchmark-test", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  fs.writeFileSync(path.join(project, ".gitignore"), ".pi/piagent-state/\n");
  fs.writeFileSync(path.join(project, "result.txt"), "wrong\n");
  fs.writeFileSync(path.join(suiteRoot, "prompt.md"), "Write correct to result.txt and verify the task.\n");
  fs.writeFileSync(path.join(suiteRoot, "grade.mjs"), [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const passed = fs.readFileSync(path.join(process.argv[2], "result.txt"), "utf8") === "correct\\n";',
    'process.stdout.write(`${JSON.stringify({ passed, checks: [{ id: "result", passed }] })}\\n`);',
    ''
  ].join("\n"));
  const suite = {
    schemaVersion: 1,
    id: "test-v1",
    title: "Runner Test",
    profile: "node-typescript",
    defaultRepeats: 3,
    timeoutSeconds: 30,
    scenarios: [{
      id: "write-result",
      title: "Write result",
      kind: "source-change",
      fixture: "project",
      prompt: "prompt.md",
      grader: "grade.mjs",
      allowedChanges: ["result.txt"],
      forbiddenOutputSubstrings: ["PIAGENT_BENCHMARK_STREAM_SECRET"]
    }]
  };
  fs.writeFileSync(path.join(suiteRoot, "suite.json"), `${JSON.stringify(suite, null, 2)}\n`);

  const fakePi = path.join(dir, "fake-pi.mjs");
  fs.writeFileSync(fakePi, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
if (process.argv.includes("--version")) { console.log("0.82.0"); process.exit(0); }
if (process.env.BENCHMARK_FAKE_STARTUP_FAIL === "1") process.exit(2);
if (process.env.BENCHMARK_FAKE_STARTUP_FAIL_ONCE) {
  const marker = process.env.BENCHMARK_FAKE_STARTUP_FAIL_ONCE;
  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "failed\\n"); console.error("startup PIAGENT_BENCHMARK_STREAM_SECRET"); process.exit(2); }
}
if (process.env.BENCHMARK_FAKE_SLEEP === "1") {
  fs.writeFileSync(process.env.BENCHMARK_FAKE_SIGNAL_FILE, "started:" + process.pid + "\\n");
  process.on("SIGINT", () => {
    fs.appendFileSync(process.env.BENCHMARK_FAKE_SIGNAL_FILE, "SIGINT\\n");
    process.exit(130);
  });
  await new Promise(() => {});
}
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionDir = value("--session-dir");
const sessionId = value("--session-id");
const now = new Date().toISOString();
const surface = process.env.PIAGENT_BENCHMARK_SURFACE;
if (surface === "piagent") {
  const context = fs.readFileSync(path.join(process.cwd(), ".pi", "project-context.md"), "utf8");
  const index = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".pi", "context-index.json"), "utf8"));
  if (process.env.PIAGENT_BENCHMARK_LIFECYCLE === "cold-start") {
    if (!context.includes("Generated: not yet") || index.source === "onboarding-record") process.exit(4);
    fs.writeFileSync(path.join(process.cwd(), ".pi", "project-context.md"), context.replace("Generated: not yet", "Generated: during measured cold start"));
  } else {
    const onboarding = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".pi", "piagent-state", "project-onboarding.json"), "utf8"));
    if (context.includes("Generated: not yet") || index.source !== "onboarding-record" || index.warnings.length !== 0 || onboarding.model !== "benchmark-setup") process.exit(4);
  }
}
fs.writeFileSync(path.join(process.cwd(), "result.txt"), "correct\\n");
fs.mkdirSync(sessionDir, { recursive: true });
if (process.env.BENCHMARK_FAKE_LEAK === "1") console.log("PIAGENT_BENCHMARK_STREAM_SECRET");
if (process.env.BENCHMARK_FAKE_REQUIRED === "1") console.log("PIAGENT_BENCHMARK_REQUIRED_MARKER");
const input = surface === "piagent" ? 50 : 100;
const toolName = surface === "piagent" ? "piagent_task_start" : "read";
const entries = [
  { type: "session", id: sessionId, cwd: process.cwd(), timestamp: now },
  { type: "model_change", provider: "test", modelId: "fake-model", timestamp: now },
  { type: "thinking_level_change", thinkingLevel: "high", timestamp: now },
  { type: "message", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "toolCall", id: "call-1", name: toolName, arguments: {} }], usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + 10, cost: { total: input / 100000 } } } }
];
fs.writeFileSync(path.join(sessionDir, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
if (surface === "piagent") {
  const task = JSON.parse(fs.readFileSync(process.env.PIAGENT_BENCHMARK_TASK_FIXTURE, "utf8"));
  task.taskRunId = "benchmark-task-20260801000000-a1b2c3d4e5";
  task.taskId = "benchmark-task";
  task.sessionId = sessionId;
  task.sessionName = "BENCH";
  task.workPlan = task.workPlan.map((step) => ({ ...step, status: "done", updatedAt: now }));
  task.verifyCommands = ["node --test"];
  task.verifyEvidence = [{ command: "node --test", exitCode: 0, summary: "passed", recordedAt: now, observed: true, observedAt: now, isError: false, matchedProfileCommand: true }];
  task.changedFiles = ["result.txt"];
  task.observedChangedFiles = ["result.txt"];
  task.finalWorkingTreeFiles = ["result.txt"];
  task.trace = { outcome: "completed", recordedAt: now };
  task.createdAt = now;
  task.updatedAt = now;
  const tasks = path.join(process.cwd(), ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, task.taskRunId + ".json"), JSON.stringify(task));
}
`);
  fs.chmodSync(fakePi, 0o755);

  const fakeCodex = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const requireControlledIsolation = () => {
  if (process.env.BENCHMARK_FAKE_EXPECT_CODEX_ISOLATION !== "1") return;
  if (!process.env.CODEX_HOME || process.env.CODEX_HOME === process.env.BENCHMARK_FAKE_OPERATOR_CODEX_HOME) process.exit(10);
  const auth = path.join(process.env.CODEX_HOME, "auth.json");
  if (!fs.lstatSync(auth).isSymbolicLink()) process.exit(11);
};
if (args.includes("--version")) { console.log("codex-cli 1.0.0-test"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { requireControlledIsolation(); console.log("Logged in using test"); process.exit(0); }
if (args[0] === "features" && args[1] === "list") { requireControlledIsolation(); console.log("apps stable true\\nplugins stable true\\nbrowser_use stable true\\nhooks stable true"); process.exit(0); }
if (args[0] !== "exec") process.exit(7);
requireControlledIsolation();
if (process.env.BENCHMARK_FAKE_CODEX_HOME_LOG) fs.appendFileSync(process.env.BENCHMARK_FAKE_CODEX_HOME_LOG, process.env.CODEX_HOME + "\\n");
const value = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--json") || !args.includes("--ephemeral") || !args.includes("--ignore-user-config") || !args.includes("--ignore-rules")) process.exit(8);
if (!args.includes("--disable") || !args.includes("apps") || value("-s") !== "workspace-write" || value("-m") !== "fake-model") process.exit(9);
const workspace = value("-C");
fs.writeFileSync(path.join(workspace, "result.txt"), "correct\\n");
const events = [
  { type: "thread.started", thread_id: "fake-codex-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } },
  { type: "item.completed", item: { id: "edit", type: "file_change", status: "completed" } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2 } }
];
if (process.env.BENCHMARK_FAKE_CODEX_LARGE_OUTPUT === "1") events.splice(events.length - 1, 0, { type: "item.completed", item: { id: "large", type: "command_execution", aggregated_output: "x".repeat(5 * 1024 * 1024), exit_code: 0, status: "completed" } });
for (const event of events) console.log(JSON.stringify(event));
`);
  fs.chmodSync(fakeCodex, 0o755);
  return { dir, suite: path.join(suiteRoot, "suite.json"), fakePi, fakeCodex, operatorCodexHome, output: path.join(dir, "output") };
}

test("dry-run validates the built-in suite without starting a model", () => {
  const result = spawnSync(process.execPath, [runner, "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sessions:\s+24/);
  assert.match(result.stdout, /no model session started/);
});

test("Codex CLI dry-run requires explicit parity settings and prints the mapped plan", () => {
  const missing = spawnSync(process.execPath, [runner, "--surfaces", "piagent,codex-cli", "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /require --model/);

  const valid = spawnSync(process.execPath, [
    runner,
    "--surfaces", "piagent,codex-cli",
    "--model", "openai-codex/gpt-test",
    "--thinking", "xhigh",
    "--repeats", "1",
    "--dry-run"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /surfaces:\s+piagent, codex-cli/);
  assert.match(valid.stdout, /compare:\s+Piagent vs Codex CLI/);
  assert.match(valid.stdout, /sessions:\s+8/);
  assert.match(valid.stdout, /codex:\s+controlled mode · model gpt-test · effort xhigh/);
});

test("rejects a suite that exposes its hidden grader inside the agent fixture", (t) => {
  const value = fixture(t);
  const suite = JSON.parse(fs.readFileSync(value.suite, "utf8"));
  suite.scenarios[0].fixture = ".";
  fs.writeFileSync(value.suite, `${JSON.stringify(suite, null, 2)}\n`);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prompt and grader must stay outside the agent fixture/);
});

test("keeps the legacy project recorder available through the same command", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-legacy-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [runner, project, "--init"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Initialized benchmark scenarios/);
  assert.equal(fs.existsSync(path.join(project, ".pi", "benchmarks", "quality-scenarios.md")), true);
});

test("one command runs paired surfaces, grades them, and writes private reports", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.runCount, 6);
  assert.deepEqual(report.infrastructure, { attempts: 6, retries: 0, retriedRuns: 0, failureCounts: {} });
  assert.equal(report.environment.platformVersion, "1.2.12");
  assert.equal(report.environment.piVersion, "0.82.0");
  assert.equal(report.environment.treatmentBaseline, "initialized-and-onboarded");
  assert.match(report.environment.suiteDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.surfaces.rawPi.resolved, 3);
  assert.equal(report.surfaces.piagent.resolved, 3);
  assert.equal(report.surfaces.piagent.scores.workflow, 10);
  assert.deepEqual(report.surfaces.piagent.usage.toolNames, { piagent_task_start: 3 });
  assert.equal(report.surfaces.piagent.usage.allMeasuredRuns.medianToolCalls, 1);
  assert.equal(report.comparison.tokenClaimAllowed, true);
  assert.equal(report.surfaces.piagent.scores.overall, 10);
  assert.equal(fs.statSync(path.join(value.output, "report.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(value.output, "workspaces")), false);
});

test("generated variants are paired by seed and enforce required output without storing values", (t) => {
  const value = fixture(t);
  const suite = JSON.parse(fs.readFileSync(value.suite, "utf8"));
  suite.schemaVersion = 2;
  suite.assurance = { taskSource: "test", visibility: "test", generatedVariants: true, reviewed: true, refreshedAt: "2026-08-02" };
  suite.releaseGate = { minimumQualityScore: 9, minimumSafetyScore: 10, minimumReliabilityScore: 9, minimumWorkflowScore: 10, minimumCategoryScore: 9 };
  Object.assign(suite.scenarios[0], {
    category: "platform",
    difficulty: "small",
    lifecycle: "cold-start",
    variantGenerator: "variant.mjs"
  });
  fs.writeFileSync(value.suite, `${JSON.stringify(suite, null, 2)}\n`);
  fs.writeFileSync(path.join(path.dirname(value.suite), "variant.mjs"), `
import crypto from "node:crypto";
import fs from "node:fs";
const seed = process.argv[4];
const marker = "PIAGENT_BENCHMARK_REQUIRED_MARKER";
const secret = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
fs.writeFileSync(process.argv[3], JSON.stringify({ schemaVersion: 1, graderData: { secretHash: secret }, requiredOutputSubstrings: [marker], forbiddenOutputSubstrings: ["DYNAMIC_SECRET_" + secret] }));
`);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--seed", "paired-seed", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_REQUIRED: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.environment.variantRootSeed, "paired-seed");
  assert.equal(report.runs.every((run) => run.outputEvidence.passed), true);
  const coldPiagentRuns = report.runs.filter((run) => run.surface === "piagent");
  assert.equal(coldPiagentRuns.every((run) => run.scope.runtimeManagedChanges.includes(".pi/project-context.md")), true);
  assert.equal(coldPiagentRuns.every((run) => run.scope.changedFiles.includes(".pi/project-context.md") === false), true);
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    assert.equal(new Set(report.runs.filter((run) => run.repeat === repeat).map((run) => run.variant.oracleDigest)).size, 1);
  }
  assert.equal(new Set(report.runs.map((run) => run.variant.oracleDigest)).size, 3);
  assert.equal(JSON.stringify(report).includes("PIAGENT_BENCHMARK_REQUIRED_MARKER"), false);
  assert.equal(JSON.stringify(report).includes("DYNAMIC_SECRET_"), false);
});

test("one command compares Piagent with controlled Codex CLI using strict JSONL usage", (t) => {
  const value = fixture(t);
  const codexHomeLog = path.join(value.dir, "codex-homes.log");
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--surfaces", "piagent,codex-cli",
    "--model", "test/fake-model",
    "--thinking", "high",
    "--yes",
    "--output", value.output
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_EXPECT_CODEX_ISOLATION: "1",
      BENCHMARK_FAKE_CODEX_HOME_LOG: codexHomeLog,
      BENCHMARK_FAKE_OPERATOR_CODEX_HOME: value.operatorCodexHome,
      CODEX_HOME: value.operatorCodexHome,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_CODEX_COMMAND: value.fakeCodex,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.runCount, 6);
  assert.equal(report.environment.codexVersion, "codex-cli 1.0.0-test");
  assert.equal(report.environment.codexMode, "controlled");
  assert.equal(report.environment.codexAuth, "login-status");
  assert.equal(report.environment.codexIsolation, "per-session-temporary-home");
  assert.equal(report.environment.codexCredentialBridge, "auth-json-link");
  assert.equal(report.environment.codexGlobalInstructions, "excluded");
  assert.deepEqual(report.environment.codexDisabledFeatures, ["apps", "plugins", "browser_use", "hooks"]);
  assert.deepEqual(report.environment.surfaceModels, { piagent: "test/fake-model", "codex-cli": "fake-model" });
  assert.equal(report.comparison.baselineSurface, "codex-cli");
  assert.equal(report.surfaces.codexCli.resolved, 3);
  assert.equal(report.surfaces.codexCli.usage.allMeasuredRuns.medianFreshTokens, 90);
  assert.equal(report.surfaces.codexCli.usage.allMeasuredRuns.medianCost, null);
  assert.deepEqual(report.surfaces.codexCli.usage.toolNames, { file_change: 3 });
  assert.equal(report.surfaces.piagent.resolved, 3);
  assert.equal(report.comparison.pairedUsageRuns, 3);
  assert.equal(report.comparison.pairedCostRuns, 0);
  assert.equal(report.comparison.tokenClaimAllowed, true);
  assert.equal(report.verdict.status, "piagent-more-efficient");
  assert.match(result.stdout, /Comparison: Piagent vs Codex CLI/);
  assert.match(result.stdout, /cost n\/a/);
  const codexHomes = fs.readFileSync(codexHomeLog, "utf8").trim().split("\n");
  assert.equal(codexHomes.length, 3);
  assert.equal(new Set(codexHomes).size, 3, "every measured Codex session must receive a clean CODEX_HOME");
});

test("streams Codex JSONL larger than the retained process-output tail", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--surfaces", "piagent,codex-cli",
    "--model", "test/fake-model",
    "--thinking", "high",
    "--repeats", "1",
    "--yes",
    "--output", value.output
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_CODEX_LARGE_OUTPUT: "1",
      BENCHMARK_FAKE_EXPECT_CODEX_ISOLATION: "1",
      BENCHMARK_FAKE_OPERATOR_CODEX_HOME: value.operatorCodexHome,
      CODEX_HOME: value.operatorCodexHome,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_CODEX_COMMAND: value.fakeCodex,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  const codexRun = report.runs.find((run) => run.surface === "codex-cli");
  assert.equal(codexRun.resolved, true);
  assert.equal(codexRun.usage.fresh, 90);
  assert.deepEqual(codexRun.usage.toolNames, { command_execution: 1, file_change: 1 });
  assert.match(codexRun.agent.stdoutHash, /^[a-f0-9]{64}$/);
});

test("catches a forbidden value from the live process stream even when the session omits it", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_LEAK: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.comparison.safetyGate, false);
  assert.equal(report.runs.every((run) => run.outputSafety.passed === false), true);
  assert.equal(JSON.stringify(report).includes("PIAGENT_BENCHMARK_STREAM_SECRET"), false);
});

test("aborts after the first infrastructure failure instead of starting later model runs", (t) => {
  const value = fixture(t);
  const suite = JSON.parse(fs.readFileSync(value.suite, "utf8"));
  suite.profile = "missing-benchmark-profile";
  fs.writeFileSync(value.suite, `${JSON.stringify(suite, null, 2)}\n`);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /aborted after an infrastructure error/);
  assert.equal(fs.existsSync(path.join(value.output, "aborted.json")), true);
  assert.equal(fs.existsSync(path.join(value.output, "report.json")), false);
  assert.equal(fs.readFileSync(path.join(value.output, "runs.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("aborts when Pi exits before recording usage", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_STARTUP_FAIL: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const record = JSON.parse(fs.readFileSync(path.join(value.output, "runs.jsonl"), "utf8"));
  assert.equal(record.abortSuite, true);
  assert.match(record.failure, /agent-exit-2/);
  assert.equal(fs.existsSync(path.join(value.output, "aborted.json")), true);
});

test("retries one zero-usage infrastructure failure without counting it as a measured run", (t) => {
  const value = fixture(t);
  const failureMarker = path.join(value.dir, "startup-failed-once");
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--repeats", "1",
    "--infrastructure-retries", "1",
    "--yes",
    "--output", value.output
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_STARTUP_FAIL_ONCE: failureMarker,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RETRY 1\/1 \(agent-exit-2-before-usage\)/);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.runCount, 2);
  const retried = report.runs.find((run) => run.infrastructureRetries === 1);
  assert.equal(retried.infrastructureAttempts, 2);
  assert.equal(retried.infrastructureFailures.length, 1);
  assert.equal(retried.infrastructureFailures[0].failure, "agent-exit-2-before-usage");
  assert.deepEqual(report.infrastructure, {
    attempts: 3,
    retries: 1,
    retriedRuns: 1,
    failureCounts: { "agent-exit-2-before-usage": 1 }
  });
  const attempts = fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].accepted, false);
  assert.equal(attempts[0].retryAvailable, true);
  assert.match(attempts[0].infrastructureDiagnostic, /startup \[REDACTED\]/);
  assert.equal(JSON.stringify(attempts).includes("PIAGENT_BENCHMARK_STREAM_SECRET"), false);
});

test("forwards interruption to the active Pi process and leaves only a partial private ledger", async (t) => {
  const value = fixture(t);
  const signalFile = path.join(value.dir, "signal.txt");
  const child = spawn(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BENCHMARK_FAKE_SLEEP: "1",
      BENCHMARK_FAKE_SIGNAL_FILE: signalFile,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  const timeout = Date.now() + 10_000;
  while (!fs.existsSync(signalFile) && Date.now() < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(signalFile), true, "fake Pi did not start");
  child.kill("SIGINT");
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 130);
  const fakePid = Number(fs.readFileSync(signalFile, "utf8").match(/started:(\d+)/)?.[1]);
  assert.equal(Number.isInteger(fakePid), true);
  assert.throws(() => process.kill(fakePid, 0), (error) => error?.code === "ESRCH");
  assert.equal(fs.existsSync(path.join(value.output, "interrupted.json")), true);
  assert.equal(fs.statSync(path.join(value.output, "interrupted.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(value.output, "workspaces")), false);
});

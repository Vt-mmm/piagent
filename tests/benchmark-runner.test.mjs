import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test, { after } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const runner = path.join(root, "scripts", "benchmark-runner.mjs");
const runnerCore = path.join(root, "scripts", "benchmark-runner-core.mjs");
const platformVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const defaultOperatorPiHome = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-test-operator-home-"));
const inheritedPiHome = process.env.PI_CODING_AGENT_DIR;
fs.writeFileSync(path.join(defaultOperatorPiHome, "auth.json"), `${JSON.stringify({ test: { type: "api_key", key: "FAKE_TEST_ONLY" } })}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(defaultOperatorPiHome, "settings.json"), '{"defaultProvider":"test"}\n', { mode: 0o600 });
process.env.PI_CODING_AGENT_DIR = defaultOperatorPiHome;
after(() => {
  if (inheritedPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = inheritedPiHome;
  fs.rmSync(defaultOperatorPiHome, { recursive: true, force: true });
});

function terminalArtifact(output) {
  const diagnostics = [];
  for (const name of ["aborted.json", "interrupted.json", "paused.json"]) {
    const file = path.join(output, name);
    if (fs.existsSync(file)) diagnostics.push(fs.readFileSync(file, "utf8"));
  }
  const attempts = path.join(output, "infrastructure-attempts.jsonl");
  if (fs.existsSync(attempts)) diagnostics.push(fs.readFileSync(attempts, "utf8"));
  return diagnostics.join("\n") || "no terminal artifact";
}

function textTree(root) {
  if (!fs.existsSync(root)) return "";
  const values = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    } else if (stat.isFile()) values.push(fs.readFileSync(current, "utf8"));
  }
  return values.join("\n");
}

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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const probePiHome = (phase) => {
  if (process.env.BENCHMARK_FAKE_PI_HOME_PROBE !== "1") return;
  const home = process.env.PI_CODING_AGENT_DIR;
  if (!home || (fs.statSync(home).mode & 0o777) !== 0o700) process.exit(20);
  const authPath = path.join(home, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  if ((auth.test?.access ?? auth.test?.key) !== process.env.BENCHMARK_FAKE_PI_AUTH_CANARY) process.exit(21);
  if (fs.existsSync(path.join(home, "APPEND_SYSTEM.md"))) process.exit(22);
  if (process.env.BENCHMARK_FAKE_PI_EXPECT_CONTROLLED_SETTINGS === "1") {
    if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"))) !== "{}") process.exit(24);
    if (process.env.PI_OFFLINE !== "1" || fs.existsSync(path.join(home, "npm"))) process.exit(25);
  }
  if (phase === "session" && fs.existsSync(path.join(home, "models-store.json"))) process.exit(23);
  fs.mkdirSync(path.join(home, "settings.json.lock"));
  fs.writeFileSync(path.join(home, "settings.json.lock", "owner"), "fake-lock\\n");
  fs.writeFileSync(path.join(home, "models-store.json"), "{}\\n");
  if (process.env.BENCHMARK_FAKE_PI_HOME_LOG) fs.appendFileSync(process.env.BENCHMARK_FAKE_PI_HOME_LOG, JSON.stringify({ phase, home, refresh: auth.test?.refresh }) + "\\n");
  if (phase === "session" && auth.test?.refresh === "initial") {
    auth.test.refresh = "rotated";
    fs.writeFileSync(authPath, JSON.stringify(auth) + "\\n", { mode: 0o600 });
  }
  if (phase === "session" && process.env.BENCHMARK_FAKE_PI_SWITCH_ACCOUNT === "1") {
    auth.test.accountId = "different-account";
    fs.writeFileSync(authPath, JSON.stringify(auth) + "\\n", { mode: 0o600 });
  }
  if (phase === "session" && process.env.BENCHMARK_FAKE_PI_MUTATE_SETTINGS === "1") fs.writeFileSync(path.join(home, "settings.json"), '{"mutated":true}\\n', { mode: 0o600 });
  if (process.env.BENCHMARK_FAKE_PI_LEAVE_LOCK !== "1") fs.rmSync(path.join(home, "settings.json.lock"), { recursive: true });
};
if (process.argv.includes("--version")) {
  probePiHome("preflight");
  if (process.env.BENCHMARK_FAKE_PREFLIGHT_READY) {
    fs.writeFileSync(process.env.BENCHMARK_FAKE_PREFLIGHT_READY, "snapshot-ready\\n");
    while (!fs.existsSync(process.env.BENCHMARK_FAKE_PREFLIGHT_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log("0.82.0"); process.exit(0);
}
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
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionDir = value("--session-dir");
const sessionId = value("--session-id");
const now = new Date().toISOString();
const surface = process.env.PIAGENT_BENCHMARK_SURFACE;
probePiHome("session");
if (process.env.BENCHMARK_FAKE_PROVIDER_OVERLOAD_ONCE) {
  const marker = process.env.BENCHMARK_FAKE_PROVIDER_OVERLOAD_ONCE;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "overloaded\\n");
    fs.mkdirSync(sessionDir, { recursive: true });
    const errorMessage = "Codex error: Our servers are currently overloaded. Please try again later.";
    const entries = [
      { type: "session", id: sessionId, cwd: process.cwd(), timestamp: now },
      { type: "model_change", provider: "test", modelId: "fake-model", timestamp: now },
      { type: "thinking_level_change", thinkingLevel: "high", timestamp: now },
      { type: "message", timestamp: now, message: { role: "assistant", content: [], stopReason: "error", errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }
    ];
    fs.writeFileSync(path.join(sessionDir, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
    for (const entry of entries) console.log(JSON.stringify(entry));
    process.exit(0);
  }
}
if (process.env.BENCHMARK_FAKE_PROVIDER_OVERLOAD_AFTER_USAGE === "1") {
  fs.mkdirSync(sessionDir, { recursive: true });
  const errorMessage = "Codex error: Our servers are currently overloaded. Please try again later.";
  const entries = [
    { type: "session", id: sessionId, cwd: process.cwd(), timestamp: now },
    { type: "model_change", provider: "test", modelId: "fake-model", timestamp: now },
    { type: "thinking_level_change", thinkingLevel: "high", timestamp: now },
    { type: "message", timestamp: now, message: { role: "assistant", content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/retry.js" } }], stopReason: "toolUse", usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: 25, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } } } },
    { type: "message", timestamp: now, message: { role: "toolResult", toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "fixture" }], isError: false } },
    { type: "message", timestamp: now, message: { role: "assistant", content: [], stopReason: "error", errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }
  ];
  fs.writeFileSync(path.join(sessionDir, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
  for (const entry of entries) console.log(JSON.stringify(entry));
  process.exit(0);
}
if (process.env.BENCHMARK_FAKE_PI_DELETE_HOME === "1") fs.rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
if (process.env.BENCHMARK_FAKE_PI_PRIVATE_FAILURE === "1") {
  const privateAuth = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"));
  console.error("private-provider-failure " + process.env.PI_CODING_AGENT_DIR + " " + (privateAuth.test?.key ?? privateAuth.test?.access));
  process.exit(2);
}
if (surface === "piagent" && process.env.BENCHMARK_FAKE_MUTATE_SNAPSHOT === "1") {
  const extension = value("--extension");
  fs.chmodSync(extension, 0o644);
  fs.appendFileSync(extension, "\\n// benchmark mutation\\n");
}
if (process.env.BENCHMARK_FAKE_EXPECT_PROMPT && process.argv.at(-1) !== process.env.BENCHMARK_FAKE_EXPECT_PROMPT) process.exit(13);
if (surface === "piagent" && process.env.BENCHMARK_FAKE_EXPECT_SNAPSHOT_EXTENSION === "1") {
  const extension = value("--extension");
  if (!extension.includes("/piagent-benchmark-snapshot-") || !fs.existsSync(extension)) process.exit(14);
}
if (process.env.BENCHMARK_FAKE_EXPECT_PIAGENT_TREATMENT === "candidate") {
  const expected = surface === "piagent" ? {
    PIAGENT_SOLVER_MODE: "recommend",
    PIAGENT_PHASE_TOOLS: "on",
    PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend",
    PIAGENT_EXECUTION_BACKEND: "host"
  } : {};
  for (const key of ["PIAGENT_SOLVER_MODE", "PIAGENT_PHASE_TOOLS", "PIAGENT_AUTO_RECOVERY", "PIAGENT_HELPERS_MODE", "PIAGENT_EXECUTION_BACKEND"]) {
    if (process.env[key] !== expected[key]) process.exit(12);
  }
}
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
fs.writeFileSync(path.join(process.cwd(), "result.txt"), surface === "piagent" && process.env.BENCHMARK_FAKE_FAIL_PIAGENT === "1" ? "wrong\\n" : "correct\\n");
fs.mkdirSync(sessionDir, { recursive: true });
if (process.env.BENCHMARK_FAKE_LEAK === "1") console.log("PIAGENT_BENCHMARK_STREAM_SECRET");
if (process.env.BENCHMARK_FAKE_REQUIRED === "1") console.log("PIAGENT_BENCHMARK_REQUIRED_MARKER");
const input = surface === "piagent" ? 50 : 100;
const toolName = surface === "piagent" ? "piagent_task_start" : "read";
const taskRunId = "benchmark-task-20260801000000-a1b2c3d4e5";
const taskStartInvocations = surface === "piagent" && process.env.BENCHMARK_FAKE_REFUSED_START === "1" ? 2 : 1;
const toolCalls = Array.from({ length: taskStartInvocations }, (_, index) => ({
  type: "toolCall",
  id: "call-" + (index + 1),
  name: toolName,
  arguments: {}
}));
const entries = [
  { type: "session", id: sessionId, cwd: process.cwd(), timestamp: now },
  { type: "model_change", provider: "test", modelId: "fake-model", timestamp: now },
  { type: "thinking_level_change", thinkingLevel: "high", timestamp: now },
  { type: "message", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "done" }, ...toolCalls], usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + 10, cost: { total: input / 100000 } } } }
];
if (surface === "piagent") entries.push({
  type: "custom",
  customType: "piagent-task-trace",
  data: { version: 1, event: "task_start", taskRunId, taskId: "benchmark-task", sessionId }
});
fs.writeFileSync(path.join(sessionDir, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
if (surface === "piagent") {
  const task = JSON.parse(fs.readFileSync(process.env.PIAGENT_BENCHMARK_TASK_FIXTURE, "utf8"));
  const resultPath = path.join(process.cwd(), "result.txt");
  const resultStat = fs.statSync(resultPath);
  const resultHash = crypto.createHash("sha256");
  resultHash.update("file\\0" + (resultStat.mode & 0o7777) + "\\0" + resultStat.size + "\\0");
  resultHash.update(fs.readFileSync(resultPath));
  const finalFileDigests = { "result.txt": "wt-content-v2:" + resultHash.digest("hex") };
  const finalEntries = Object.entries(finalFileDigests).sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  const finalTreeDigest = "wt-content-v2:" + crypto.createHash("sha256").update("tree\\0wt-content-v2\\0" + JSON.stringify(finalEntries)).digest("hex");
  task.taskRunId = taskRunId;
  task.taskId = "benchmark-task";
  task.sessionId = sessionId;
  task.sessionName = "BENCH";
  task.workPlan = task.workPlan.map((step) => ({ ...step, status: "done", updatedAt: now }));
  task.verifyCommands = ["node --test"];
  task.verifyEvidence = [{ command: "node --test", exitCode: 0, summary: "passed", recordedAt: now, observed: true, observedAt: now, isError: false, matchedProfileCommand: true, preWorkingTreeDigest: finalTreeDigest, workingTreeDigest: finalTreeDigest }];
  task.workingTreeDigestAlgorithm = "wt-content-v2";
  delete task.workingTreeDigestMigration;
  task.baselineChangedFiles = [];
  task.baselineFileDigests = {};
  task.changedFiles = ["result.txt"];
  task.observedChangedFiles = ["result.txt"];
  task.finalWorkingTreeFiles = ["result.txt"];
  task.finalFileDigests = finalFileDigests;
  task.acceptanceCriteria = ["The configured verifier passes on the current tree."];
  task.acceptanceReceipt = {
    schemaVersion: 1,
    source: "runtime",
    promptHash: crypto.createHash("sha256").update("benchmark fixture acceptance").digest("hex"),
    generatedAt: now,
    criteria: [{
      id: "ac-01-verification-evidence",
      hash: crypto.createHash("sha256").update("benchmark verifier criterion").digest("hex"),
      obligation: "verification-evidence",
      priority: "critical",
      status: "satisfied",
      evidence: [{ kind: "verify-command", summary: "Configured verifier passed against the final working tree.", paths: ["result.txt"], command: "node --test", exitCode: 0, workingTreeDigest: finalTreeDigest, recordedAt: now }],
      updatedAt: now
    }]
  };
  task.trace = { outcome: "completed", recordedAt: now };
  if (process.env.BENCHMARK_FAKE_WORKFLOW_GAP === "1") {
    task.changedFiles = [];
    task.trace = { outcome: "pending" };
  }
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
  if (!fs.lstatSync(auth).isFile() || fs.readFileSync(auth, "utf8") !== "test credential placeholder\\n") process.exit(11);
};
if (args.includes("--version")) { console.log("codex-cli 1.0.0-test"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { requireControlledIsolation(); console.log("Logged in using test"); process.exit(0); }
if (args[0] === "features" && args[1] === "list") { requireControlledIsolation(); console.log("apps stable true\\nplugins stable true\\nbrowser_use stable true\\nhooks stable true"); process.exit(0); }
if (args[0] !== "exec") process.exit(7);
requireControlledIsolation();
if (process.env.BENCHMARK_FAKE_CODEX_HOME_LOG) fs.appendFileSync(process.env.BENCHMARK_FAKE_CODEX_HOME_LOG, process.env.CODEX_HOME + "\\n");
if (process.env.BENCHMARK_FAKE_CODEX_POLICY_REFUSAL_ONCE) {
  const marker = process.env.BENCHMARK_FAKE_CODEX_POLICY_REFUSAL_ONCE;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "failed\\n");
    console.error("provider safety policy refusal before usage");
    process.exit(1);
  }
}
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

test("modern wrapper refuses inherited Node code-loading overrides before freezing claims", () => {
  const result = spawnSync(process.execPath, [runner, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--no-warnings" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refuses Node code-loading environment overrides: NODE_OPTIONS/);
});

test("direct modern core invocation cannot bypass immutable bootstrap", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runnerCore, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must start through scripts\/benchmark-runner\.mjs/);
  assert.equal(fs.existsSync(value.output), false);
});

test("modern run executes suite and Piagent extension from the immutable preflight snapshot", async (t) => {
  const value = fixture(t);
  const ready = path.join(value.dir, "snapshot-ready");
  const release = path.join(value.dir, "release-preflight");
  const originalPrompt = "Write correct to result.txt and verify the task.";
  const child = spawn(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BENCHMARK_FAKE_PREFLIGHT_READY: ready,
      BENCHMARK_FAKE_PREFLIGHT_RELEASE: release,
      BENCHMARK_FAKE_EXPECT_PROMPT: originalPrompt,
      BENCHMARK_FAKE_EXPECT_SNAPSHOT_EXTENSION: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < timeout) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(ready), true, "preflight did not start after snapshot creation");

  fs.writeFileSync(path.join(path.dirname(value.suite), "prompt.md"), "MUTATED LIVE PROMPT\n");
  fs.writeFileSync(path.join(path.dirname(value.suite), "grade.mjs"), 'process.stdout.write(`${JSON.stringify({ passed: false, checks: [{ id: "mutated", passed: false }] })}\\n`);\n');
  fs.writeFileSync(release, "continue\n");
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0, `${stdout}\n${stderr}\n${terminalArtifact(value.output)}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs.every((run) => run.resolved), true, "live suite mutation must not affect frozen execution");
  assert.equal(report.environment.candidateProvenance.finalization, "immutable-snapshot-rehashed-and-matched");
});

test("capability alias selects the runnable unsaturated suite", () => {
  const result = spawnSync(process.execPath, [runner, "--capability", "--repeats", "1", "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /suite:\s+capability-v1 \(4 scenarios\)/);
  assert.match(result.stdout, /sessions:\s+8/);
  assert.match(result.stdout, /no model session started/);
});

test("paid outcome is retained and token claims close when a frozen asset changes", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_MUTATE_SNAPSHOT: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(value.output, "report.json")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8"));
  assert.equal(manifest.tokenClaimsUnavailableReason, "execution-asset-mismatch-after-provider-attempt");
  assert.equal(manifest.recoveredProviderAttempts.length, 1);
  assert.ok(manifest.recoveredProviderAttempts[0].usage.fresh > 0);
  const attempt = JSON.parse(fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8"));
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.contaminated, true);
  assert.equal(fs.existsSync(path.join(value.output, "aborted.json")), true);
});

test("private assurance manifest fails closed on surviving mutations or digest mismatch", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-private-assurance-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "benchmarks", "capability-v1"), directory, { recursive: true });
  const suitePath = path.join(directory, "suite.json");
  const suite = JSON.parse(fs.readFileSync(suitePath, "utf8"));
  const evidence = JSON.parse(fs.readFileSync(path.join(root, "evals", "fixtures", "benchmark-assurance-evidence.valid.json"), "utf8"));
  const matchingFields = [
    "claimTier", "visibility", "familyDisjointSplit", "repositoryDisjointSplit", "holdoutManifestDigest",
    "referenceSolutionDigest", "mutationReportDigest", "calibrationReportDigest", "accessPolicyDigest",
    "disjointnessReportDigest", "humanRubricDigest", "disagreementReportDigest"
  ];
  Object.assign(suite.assurance, {
    evidenceManifest: "assurance.json",
    ...Object.fromEntries(matchingFields.map((field) => [field, evidence[field]]))
  });
  fs.writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
  evidence.mutationChecks.killed -= 1;
  fs.writeFileSync(path.join(directory, "assurance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const surviving = spawnSync(process.execPath, [runner, "--suite", suitePath, "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(surviving.status, 1);
  assert.match(surviving.stderr, /every declared item killed/);

  evidence.mutationChecks.killed = evidence.mutationChecks.total;
  evidence.referenceSolutionDigest = "b".repeat(64);
  fs.writeFileSync(path.join(directory, "assurance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const mismatch = spawnSync(process.execPath, [runner, "--suite", suitePath, "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match suite assurance: referenceSolutionDigest/);

  evidence.referenceSolutionDigest = suite.assurance.referenceSolutionDigest;
  evidence.accessControl.expiresAt = "2026-08-10T00:00:00.000Z";
  fs.writeFileSync(path.join(directory, "assurance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const expired = spawnSync(process.execPath, [runner, "--suite", suitePath, "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /access receipt is not currently valid/);
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
    "--piagent-treatment", "candidate",
    "--repeats", "2",
    "--dry-run"
  ], { cwd: root, encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /surfaces:\s+piagent, codex-cli/);
  assert.match(valid.stdout, /compare:\s+Piagent vs Codex CLI/);
  assert.match(valid.stdout, /sessions:\s+16/);
  assert.match(valid.stdout, /treatment:\s+candidate/);
  assert.match(valid.stdout, /codex:\s+controlled mode · model gpt-test · effort xhigh/);
});

test("provider-free preflight freezes the candidate and checks auth and tools without a model session", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--surfaces", "piagent,codex-cli",
    "--model", "test/fake-model",
    "--thinking", "high",
    "--repeats", "1",
    "--max-sessions", "2",
    "--preflight-only",
    "--json"
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_EXPECT_CODEX_ISOLATION: "1",
      BENCHMARK_FAKE_OPERATOR_CODEX_HOME: value.operatorCodexHome,
      CODEX_HOME: value.operatorCodexHome,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_CODEX_COMMAND: value.fakeCodex
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.kind, "benchmark-provider-free-preflight");
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.providerSessionsStarted, 0);
  assert.equal(receipt.configuration.surfaces.join(","), "piagent,codex-cli");
  assert.equal(receipt.configuration.maxSessions, 2);
  assert.equal(receipt.runtime.codexAuth, "login-status");
  assert.equal(receipt.runtime.codexVersion, "codex-cli 1.0.0-test");
  assert.equal(receipt.usageContract.codexCli, "turn.completed.usage-cache-exclusive-fresh-exact-or-unavailable");
  assert.doesNotMatch(result.stdout, /operator-codex-home|piagent-benchmark-snapshot-|auth\.json|resolvedPath|selectedPath/);
  assert.equal(fs.existsSync(value.output), false);
});

test("preflight-only cannot be combined with a plan-only or historical run", () => {
  for (const args of [
    ["--dry-run", "--preflight-only"],
    ["--preflight-only", "--resume", "/tmp/not-a-run"],
    ["--preflight-only", "--replay-failures", "/tmp/not-a-report"]
  ]) {
    const result = spawnSync(process.execPath, [runnerCore, ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /preflight-only/);
  }
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

test("one command applies a pinned Piagent treatment only to the candidate surface", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--piagent-treatment", "candidate", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_EXPECT_PIAGENT_TREATMENT: "candidate",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${terminalArtifact(value.output)}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.measurementSchemaVersion, 2);
  assert.equal(report.runCount, 6);
  assert.deepEqual(report.infrastructure, { attempts: 6, retries: 0, retriedRuns: 0, failureCounts: {}, classCounts: {} });
  assert.equal(report.environment.platformVersion, platformVersion);
  assert.equal(report.environment.piVersion, "0.82.0");
  assert.equal(report.environment.treatmentBaseline, "initialized-and-onboarded");
  assert.deepEqual(report.environment.piagentTreatment, {
    id: "candidate",
    explicit: true,
    environment: {
      PIAGENT_SOLVER_MODE: "recommend",
      PIAGENT_PHASE_TOOLS: "on",
      PIAGENT_AUTO_RECOVERY: "on",
      PIAGENT_HELPERS_MODE: "recommend",
      PIAGENT_EXECUTION_BACKEND: "host"
    }
  });
  assert.match(report.environment.suiteDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.surfaces.rawPi.resolved, 3);
  assert.equal(report.surfaces.piagent.resolved, 3);
  assert.equal(report.surfaces.piagent.scores.workflow, 10);
  assert.equal(report.runs.find((run) => run.surface === "piagent").workflow.taskEvidence.outcome, "completed");
  assert.deepEqual(report.surfaces.piagent.usage.toolNames, { piagent_task_start: 3 });
  assert.equal(report.surfaces.piagent.usage.allMeasuredRuns.medianToolCalls, 1);
  assert.equal(report.comparison.tokenClaimAllowed, true);
  assert.equal(report.trustChecklist.tokenSavingClaimAllowed, true);
  assert.equal(report.trustChecklist.hasSafetyGate, true);
  assert.equal(report.trustChecklist.hasComparisonProtocolGate, true);
  assert.equal(report.surfaces.piagent.scores.overall, 10);
  assert.equal(fs.statSync(path.join(value.output, "report.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(value.output, "workspaces")), false);
});

test("uses one writable private Pi home, preserves auth rotation, resets ephemeral state, and keeps credentials out of evidence", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  const log = path.join(value.dir, "pi-home.log");
  const authCanary = "PI_AUTH_PRIVATE_CANARY_20260810";
  const appendCanary = "PI_GLOBAL_INSTRUCTION_PRIVATE_CANARY_20260810";
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), `${JSON.stringify({ test: { type: "oauth", accountId: "fake-account", access: authCanary, refresh: "initial" } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), '{"theme":"dark"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "models.json"), '{"models":[],"apiKey":"MODEL_PRIVATE_CANARY"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "APPEND_SYSTEM.md"), `${appendCanary}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--allow-pi-auth-writeback", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: operatorPiHome,
      BENCHMARK_FAKE_PI_HOME_PROBE: "1",
      BENCHMARK_FAKE_PI_HOME_LOG: log,
      BENCHMARK_FAKE_PI_AUTH_CANARY: authCanary,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${terminalArtifact(value.output)}`);
  const observations = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(observations.map((entry) => entry.phase), ["preflight", "session", "session"]);
  assert.equal(new Set(observations.map((entry) => entry.home)).size, 1, "auth lineage must use one run-scoped home");
  assert.deepEqual(observations.filter((entry) => entry.phase === "session").map((entry) => entry.refresh), ["initial", "rotated"]);
  assert.equal(fs.existsSync(observations[0].home), false, "private runtime home must be removed after child close");
  assert.equal(JSON.parse(fs.readFileSync(path.join(operatorPiHome, "auth.json"), "utf8")).test.refresh, "rotated", "the explicit CAS bridge must preserve the rotated credential lineage");
  const evidence = textTree(value.output);
  for (const secret of [authCanary, appendCanary, "MODEL_PRIVATE_CANARY", crypto.createHash("sha256").update(authCanary).digest("hex"), observations[0].home]) {
    assert.equal(evidence.includes(secret), false, `private Pi-home value leaked into evidence: ${secret}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8"));
  assert.deepEqual(manifest.piAgentHome.identity.credentialMetadata, [{ providerId: "test", type: "oauth" }]);
  assert.equal(manifest.piAgentHome.authRefreshPolicy, "explicit-same-account-oauth-refresh-cas-writeback");
  assert.equal(manifest.allowPiAuthWriteback, true);
  assert.equal(manifest.piAgentHome.globalInstructions, "excluded");
  assert.equal(manifest.piAgentHome.identity.credentialContentBinding, "private-runtime-only");
});

test("replaces operator package settings with deterministic offline benchmark settings", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  const packageCanary = "PRIVATE_OPERATOR_PACKAGE_CANARY";
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), `${JSON.stringify({ test: { type: "api_key", key: "FAKE_TEST_ONLY" } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), `${JSON.stringify({ packages: [packageCanary], extensions: [packageCanary], theme: "operator-specific" })}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: operatorPiHome,
      BENCHMARK_FAKE_PI_HOME_PROBE: "1",
      BENCHMARK_FAKE_PI_AUTH_CANARY: "FAKE_TEST_ONLY",
      BENCHMARK_FAKE_PI_EXPECT_CONTROLLED_SETTINGS: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${terminalArtifact(value.output)}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8"));
  assert.equal(manifest.piAgentHome.identity.settingsPolicy, "deterministic-empty");
  assert.equal(manifest.piAgentHome.identity.operatorPackagesAndResources, "excluded");
  assert.equal(textTree(value.output).includes(packageCanary), false);
});

test("fails closed when the writable Pi runtime changes behavioral configuration", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  const log = path.join(value.dir, "pi-home-drift.log");
  const authCanary = "PI_AUTH_DRIFT_PRIVATE_CANARY_20260810";
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), `${JSON.stringify({ test: { type: "oauth", accountId: "fake-account", access: authCanary, refresh: "initial" } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), '{"theme":"dark"}\n', { mode: 0o600 });
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--allow-pi-auth-writeback", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: operatorPiHome,
      BENCHMARK_FAKE_PI_HOME_PROBE: "1",
      BENCHMARK_FAKE_PI_HOME_LOG: log,
      BENCHMARK_FAKE_PI_AUTH_CANARY: authCanary,
      BENCHMARK_FAKE_PI_MUTATE_SETTINGS: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(value.output, "report.json")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8"));
  assert.equal(manifest.tokenClaimsUnavailableReason, "execution-asset-mismatch-after-provider-attempt");
  const runtimeHome = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)).home;
  assert.equal(fs.existsSync(runtimeHome), false);
  assert.equal(textTree(value.output).includes(authCanary), false);
  const aborted = JSON.parse(fs.readFileSync(path.join(value.output, "aborted.json"), "utf8"));
  assert.deepEqual(aborted.provenanceStamp.failure.piHomeMismatch, { classification: "behavioral-content", entry: "settings.json" });
  const attempt = JSON.parse(fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8").trim());
  assert.deepEqual(attempt.executionAsset.piHomeMismatch, { classification: "behavioral-content", entry: "settings.json" });
});

test("rejects an unusable stored OAuth credential before a provider process starts", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  const log = path.join(value.dir, "provider-start.log");
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), `${JSON.stringify({ "openai-codex": { type: "oauth", access: "EXPIRED_PRIVATE_CANARY", expires: 1 } })}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--model", "openai-codex/fake-model", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: operatorPiHome,
      BENCHMARK_FAKE_PI_HOME_PROBE: "1",
      BENCHMARK_FAKE_PI_HOME_LOG: log,
      BENCHMARK_FAKE_PI_AUTH_CANARY: "EXPIRED_PRIVATE_CANARY",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /unusable stored credential for requested provider openai-codex/);
  assert.equal(fs.existsSync(log), false, "credential readiness must fail before Pi preflight/provider launch");
  assert.equal(fs.existsSync(value.output), false);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes("EXPIRED_PRIVATE_CANARY"), false);
});

test("requires explicit consent before a billed run can rotate OAuth credentials", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  const log = path.join(value.dir, "provider-start.log");
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), `${JSON.stringify({ "openai-codex": { type: "oauth", accountId: "fake-account", access: "PRIVATE", refresh: "initial", expires: Date.now() + 60_000 } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), '{"defaultProvider":"openai-codex"}\n', { mode: 0o600 });
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--model", "openai-codex/fake-model", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: operatorPiHome, BENCHMARK_FAKE_PI_HOME_LOG: log, PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit --allow-pi-auth-writeback consent/);
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.existsSync(value.output), false);
});

test("OAuth rotation survives a paired pause and resume through same-account CAS", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  const log = path.join(value.dir, "pi-home-resume.log");
  const authCanary = "PI_AUTH_PAUSE_PRIVATE_CANARY";
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), `${JSON.stringify({ test: { type: "oauth", accountId: "fake-account", access: authCanary, refresh: "initial" } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), '{"defaultProvider":"test"}\n', { mode: 0o600 });
  const env = { ...process.env, PI_CODING_AGENT_DIR: operatorPiHome, BENCHMARK_FAKE_PI_HOME_PROBE: "1", BENCHMARK_FAKE_PI_HOME_LOG: log, BENCHMARK_FAKE_PI_AUTH_CANARY: authCanary, PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi, PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json") };
  const first = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "2", "--max-sessions", "2", "--allow-pi-auth-writeback", "--yes", "--output", value.output], { cwd: root, encoding: "utf8", timeout: 60_000, env });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const firstObservations = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const firstCount = firstObservations.length;
  const retainedVault = firstObservations[0].home;
  assert.equal(fs.existsSync(retainedVault), true, "a paused run must retain its private credential vault");
  assert.equal(JSON.parse(fs.readFileSync(path.join(operatorPiHome, "auth.json"), "utf8")).test.refresh, "rotated");
  const resumed = spawnSync(process.execPath, [runner, "--resume", value.output, "--yes"], { cwd: root, encoding: "utf8", timeout: 60_000, env });
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  const resumedObservations = fs.readFileSync(log, "utf8").trim().split("\n").slice(firstCount).map(JSON.parse);
  assert.ok(resumedObservations.length > 0);
  assert.equal(resumedObservations.every((entry) => entry.refresh === "rotated"), true);
  assert.equal(resumedObservations.every((entry) => entry.home === retainedVault), true, "resume must continue the same private credential lineage");
  assert.equal(fs.existsSync(retainedVault), false, "successful completion must clean the reconciled vault");
  assert.equal(textTree(value.output).includes(authCanary), false);
});

test("rejects leftover Pi locks and account switching without leaking private diagnostics", (t) => {
  const locked = fixture(t);
  const lockResult = spawnSync(process.execPath, [runner, "--suite", locked.suite, "--repeats", "1", "--yes", "--output", locked.output], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, BENCHMARK_FAKE_PI_HOME_PROBE: "1", BENCHMARK_FAKE_PI_LEAVE_LOCK: "1", BENCHMARK_FAKE_PI_AUTH_CANARY: "FAKE_TEST_ONLY", PIAGENT_BENCHMARK_PI_COMMAND: locked.fakePi }
  });
  assert.equal(lockResult.status, 1);
  assert.match(lockResult.stderr, /pi-agent-home/);

  const switched = fixture(t);
  const operatorPiHome = path.join(switched.dir, "operator-pi-home");
  const log = path.join(switched.dir, "account-switch.log");
  const secret = "ACCOUNT_SWITCH_PRIVATE_CANARY";
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), `${JSON.stringify({ test: { type: "oauth", accountId: "fake-account", access: secret, refresh: "initial" } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), '{"defaultProvider":"test"}\n', { mode: 0o600 });
  const switchResult = spawnSync(process.execPath, [runner, "--suite", switched.suite, "--repeats", "1", "--allow-pi-auth-writeback", "--yes", "--output", switched.output], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: operatorPiHome, BENCHMARK_FAKE_PI_HOME_PROBE: "1", BENCHMARK_FAKE_PI_HOME_LOG: log, BENCHMARK_FAKE_PI_AUTH_CANARY: secret, BENCHMARK_FAKE_PI_SWITCH_ACCOUNT: "1", PIAGENT_BENCHMARK_PI_COMMAND: switched.fakePi, PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json") }
  });
  assert.equal(switchResult.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(operatorPiHome, "auth.json"), "utf8")).test.accountId, "fake-account");
  assert.equal(textTree(switched.output).includes(secret), false);
  const runtimeHome = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)).home;
  t.after(() => fs.rmSync(path.dirname(runtimeHome), { recursive: true, force: true }));
});

test("hashes provider failures so credential bytes and runtime paths never enter evidence", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, BENCHMARK_FAKE_PI_PRIVATE_FAILURE: "1", PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi, PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json") }
  });
  assert.equal(result.status, 1);
  const evidence = textTree(value.output);
  assert.equal(evidence.includes("FAKE_TEST_ONLY"), false);
  assert.doesNotMatch(evidence, /piagent-benchmark-pi-runtime-/);
  assert.match(evidence, /redacted-diagnostic-sha256:[a-f0-9]{64}/);
});

test("classifies execution-guard filesystem failures without persisting private vault paths", (t) => {
  const value = fixture(t);
  const log = path.join(value.dir, "deleted-vault.log");
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, BENCHMARK_FAKE_PI_HOME_PROBE: "1", BENCHMARK_FAKE_PI_HOME_LOG: log, BENCHMARK_FAKE_PI_AUTH_CANARY: "FAKE_TEST_ONLY", BENCHMARK_FAKE_PI_DELETE_HOME: "1", PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi, PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json") }
  });
  assert.equal(result.status, 1);
  const privatePath = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)).home;
  const evidence = textTree(value.output);
  assert.equal(evidence.includes(privatePath), false);
  assert.equal(evidence.includes("FAKE_TEST_ONLY"), false);
  assert.match(evidence, /"reason": "asset-identity-mismatch"/);
  assert.match(evidence, /"classification": "root-unavailable"/);
});

test("default report output stays under the operator Pi home, not the temporary provider home", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: operatorPiHome,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const reportsRoot = path.join(operatorPiHome, "benchmarks", "piagent");
  const runs = fs.readdirSync(reportsRoot);
  assert.equal(runs.length, 1);
  assert.equal(fs.existsSync(path.join(reportsRoot, runs[0], "report.json")), true);
  assert.doesNotMatch(result.stdout, /piagent-benchmark-snapshot-[^\s]+\/pi-agent-home\/benchmarks/);
});

test("fixture Git initialization ignores inherited template hooks", (t) => {
  const value = fixture(t);
  const template = path.join(value.dir, "hostile-git-template");
  const marker = path.join(value.dir, "hook-ran");
  fs.mkdirSync(path.join(template, "hooks"), { recursive: true });
  const hook = path.join(template, "hooks", "post-commit");
  fs.writeFileSync(hook, `#!/bin/sh\nprintf hostile > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      GIT_TEMPLATE_DIR: template,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(marker), false);
});

test("uses persisted task-start traces for workflow while retaining refused-call overhead", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--repeats", "2",
    "--yes",
    "--output", value.output
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_REFUSED_START: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  const measured = report.runs.find((run) => run.surface === "piagent");
  assert.equal(measured.usage.toolNames.piagent_task_start, 2);
  assert.deepEqual(measured.workflow.choreography, {
    intakeMode: "model",
    taskStartCalls: 2,
    acceptedTaskStartCount: 1,
    runtimeManagedCalls: 0
  });
  assert.equal(measured.workflow.checks.find((check) => check.id === "single-task-start").passed, true);
  assert.equal(measured.workflow.score, 10);
});

test("generated variants are paired by seed and enforce required output without storing values", (t) => {
  const value = fixture(t);
  const suite = JSON.parse(fs.readFileSync(value.suite, "utf8"));
  suite.schemaVersion = 2;
  suite.assurance = { taskSource: "test", visibility: "test", claimTier: "public-regression", generatedVariants: true, familyDisjointSplit: false, reviewed: true, refreshedAt: "2026-08-02" };
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

test("dry-run can replay failed pairs from a previous report", (t) => {
  const value = fixture(t);
  const reportPath = path.join(value.dir, "previous-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 2,
    runId: "previous-run",
    suite: { id: value.suite },
    environment: {
      variantRootSeed: "replay-seed",
      surfaces: ["piagent", "codex-cli"],
      requestedModel: "test/fake-model",
      requestedThinking: "high",
      piagentTreatment: { id: "candidate" }
    },
    runs: [
      { scenarioId: "write-result", surface: "piagent", repeat: 2, resolved: false },
      { scenarioId: "write-result", surface: "codex-cli", repeat: 2, resolved: true }
    ]
  }, null, 2)}\n`);
  const result = spawnSync(process.execPath, [runner, "--replay-failures", reportPath, "--dry-run"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /replay:\s+previous-run · 2 sessions/);
  assert.match(result.stdout, /variants:\s+static/);
  assert.match(result.stdout, /treatment:\s+candidate/);
  assert.match(result.stdout, /codex:\s+controlled mode · model fake-model · effort high/);
});

test("authenticated replay reuses the frozen source of a custom suite and stays diagnostic", (t) => {
  const value = fixture(t);
  const suitePath = value.suite;
  const suite = JSON.parse(fs.readFileSync(suitePath, "utf8"));
  suite.scenarios[0].variantGenerator = "variant.mjs";
  fs.writeFileSync(path.join(path.dirname(suitePath), "variant.mjs"), `
    import fs from "node:fs";
    fs.writeFileSync(process.argv[3], JSON.stringify({ schemaVersion: 1, graderData: { seed: process.argv[4] } }));
  `);
  fs.writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
  const baseEnv = {
    ...process.env,
    BENCHMARK_FAKE_FAIL_PIAGENT: "1",
    PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
    PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
  };
  const initial = spawnSync(process.execPath, [runner, "--suite", suitePath, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: baseEnv
  });
  assert.equal(initial.status, 1, `${initial.stdout}\n${initial.stderr}`);
  const replayOutput = path.join(value.dir, "replay-output");
  const replayed = spawnSync(process.execPath, [runner, "--replay-failures", path.join(value.output, "report.json"), "--yes", "--output", replayOutput], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: baseEnv
  });
  assert.equal(replayed.status, 1, `${replayed.stdout}\n${replayed.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(replayOutput, "report.json"), "utf8"));
  assert.equal(report.suite.id, "test-v1");
  assert.equal(report.runCount, 2);
  assert.equal(report.replayDiagnosticOnly, true);
  assert.equal(report.comparison.tokenClaimAllowed, false);
});

test("can pause a benchmark chunk and resume only the missing sessions", (t) => {
  const value = fixture(t);
  const env = {
    ...process.env,
    PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
    PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
  };
  const first = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--repeats", "2",
    "--piagent-treatment", "candidate",
    "--max-sessions", "2",
    "--yes",
    "--output", value.output
  ], { cwd: root, encoding: "utf8", timeout: 60_000, env });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /remaining 4/);
  assert.match(first.stdout, /repeat 1\/2/);
  assert.match(first.stdout, /Benchmark paused after 2\/4 completed sessions/);
  assert.equal(fs.existsSync(path.join(value.output, "run-manifest.json")), true);
  assert.equal(fs.statSync(path.join(value.output, "run-manifest.json")).mode & 0o777, 0o600);
  const manifest = JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.candidateProvenance).sort(), [
    "algorithm", "contentDigest", "fileCount", "schemaVersion", "selection"
  ]);
  assert.match(manifest.candidateProvenance.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(manifest.candidateProvenance.fileCount > 0, true);
  assert.equal(fs.existsSync(path.join(value.output, "paused.json")), true);
  assert.equal(fs.existsSync(path.join(value.output, "report.json")), false);
  const ledgerPrefix = fs.readFileSync(path.join(value.output, "runs.jsonl"));
  assert.equal(ledgerPrefix.toString("utf8").trim().split("\n").length, 2);
  assert.deepEqual(manifest.ledger, JSON.parse(fs.readFileSync(path.join(value.output, "paused.json"), "utf8")).ledger);

  const resumed = spawnSync(process.execPath, [
    runner,
    "--resume", value.output,
    "--yes"
  ], { cwd: root, encoding: "utf8", timeout: 60_000, env });
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.match(resumed.stdout, /resume:\s+test-v1-/);
  assert.match(resumed.stdout, /completed:\s+2/);
  assert.match(resumed.stdout, /remaining:\s+2/);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.runCount, 4);
  assert.equal(report.environment.piagentTreatment.id, "candidate");
  assert.deepEqual(report.environment.candidateProvenance, {
    ...manifest.candidateProvenance,
    finalization: "immutable-snapshot-rehashed-and-matched"
  });
  assert.deepEqual(report.ledger, report.environment.candidateProvenance ? JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8")).ledger : null);
  assert.deepEqual(fs.readFileSync(path.join(value.output, "runs.jsonl")).subarray(0, ledgerPrefix.length), ledgerPrefix, "resume must append without rewriting measured bytes");
  assert.equal(report.runs.length, 4);
  assert.equal(new Set(report.runs.map((run) => `${run.scenarioId}:${run.surface}:${run.repeat}`)).size, 4);
});

test("resume ignores operator settings drift because benchmark settings are deterministic", (t) => {
  const value = fixture(t);
  const operatorPiHome = path.join(value.dir, "operator-pi-home");
  fs.mkdirSync(operatorPiHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorPiHome, "auth.json"), '{"test":{"type":"oauth","accountId":"fake-account","access":"RESUME_PRIVATE_CANARY","refresh":"initial"}}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), '{"theme":"dark"}\n', { mode: 0o600 });
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: operatorPiHome,
    PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
    PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
  };
  const first = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "2", "--max-sessions", "2", "--allow-pi-auth-writeback", "--yes", "--output", value.output], {
    cwd: root, encoding: "utf8", timeout: 60_000, env
  });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const ledgerPath = path.join(value.output, "runs.jsonl");
  const ledgerBefore = fs.readFileSync(ledgerPath);
  fs.writeFileSync(path.join(operatorPiHome, "settings.json"), '{"theme":"light","packages":["PRIVATE_RESUME_PACKAGE_CANARY"]}\n', { mode: 0o600 });
  const resumed = spawnSync(process.execPath, [runner, "--resume", value.output, "--yes"], {
    cwd: root, encoding: "utf8", timeout: 60_000, env
  });
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.deepEqual(fs.readFileSync(ledgerPath).subarray(0, ledgerBefore.length), ledgerBefore, "resume must preserve its measured prefix byte-for-byte");
  assert.equal(fs.existsSync(path.join(value.output, "report.json")), true);
  assert.equal(textTree(value.output).includes("RESUME_PRIVATE_CANARY"), false);
  assert.equal(textTree(value.output).includes("PRIVATE_RESUME_PACKAGE_CANARY"), false);
});

test("resume aborts on candidate provenance mismatch without rewriting completed records", (t) => {
  const value = fixture(t);
  const env = {
    ...process.env,
    PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
    PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
  };
  const first = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--repeats", "2",
    "--max-sessions", "2",
    "--yes",
    "--output", value.output
  ], { cwd: root, encoding: "utf8", timeout: 60_000, env });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const ledgerPath = path.join(value.output, "runs.jsonl");
  const ledgerBefore = fs.readFileSync(ledgerPath);
  const manifestPath = path.join(value.output, "run-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.candidateProvenance.contentDigest = "0".repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const resumed = spawnSync(process.execPath, [runner, "--resume", value.output, "--yes"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env
  });
  assert.equal(resumed.status, 1, `${resumed.stdout}\n${resumed.stderr}`);
  assert.match(resumed.stderr, /candidate provenance changed at resume/);
  assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBefore, "measured runs must remain byte-for-byte unchanged");
  assert.equal(fs.existsSync(path.join(value.output, "report.json")), false);
  const aborted = JSON.parse(fs.readFileSync(path.join(value.output, "aborted.json"), "utf8"));
  assert.equal(aborted.completedRuns, 2);
  assert.equal(aborted.expectedRuns, 4);
  assert.equal(aborted.candidateProvenance.stage, "resume");
  assert.deepEqual(aborted.candidateProvenance.mismatches, ["contentDigest"]);
});

test("refuses to resume a partial ledger that lacks seed metadata", (t) => {
  const value = fixture(t);
  fs.mkdirSync(value.output, { recursive: true });
  fs.writeFileSync(path.join(value.output, "runs.jsonl"), "{}\n", { mode: 0o600 });
  const result = spawnSync(process.execPath, [runner, "--resume", value.output, "--dry-run"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing run-manifest\.json/);
  assert.match(result.stderr, /root seed cannot be recovered safely/);
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
  assert.equal(report.environment.codexCredentialBridge, "frozen-auth-json-copy");
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
  assert.equal(report.comparison.comparisonProtocolGate.passed, true);
  assert.equal(report.environment.piagentTreatment.id, "release-defaults");
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
  assert.equal(report.runs.every((run) => run.forensics?.workspaceRetained === true), true);
  assert.equal(fs.existsSync(path.join(value.output, report.runs[0].forensics.workspaceRoot, ".piagent-retain.json")), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(value.output, report.runs[0].forensics.workspaceRoot)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(value.output, report.runs[0].forensics.workspaceRoot, ".piagent-retain.json")).mode & 0o777, 0o600);
  }
  assert.equal(JSON.stringify(report).includes("PIAGENT_BENCHMARK_STREAM_SECRET"), false);
});

test("retains resolved Piagent workspaces that fail workflow evidence", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--yes", "--output", value.output], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_WORKFLOW_GAP: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  const piagentRun = report.runs.find((run) => run.surface === "piagent");
  assert.equal(piagentRun.resolved, true);
  assert.equal(piagentRun.workflow.checks.some((check) => check.passed === false), true);
  assert.equal(piagentRun.forensics.workspaceRetained, true);
  const markerPath = path.join(value.output, piagentRun.forensics.workspaceRoot, ".piagent-retain.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.match(marker.reason, /workflow-gaps:/);
  assert.deepEqual(marker.workflowGaps.sort(), ["terminal-completion", "truthful-changed-files"].sort());
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(markerPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);
  }
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
  assert.equal(fs.existsSync(path.join(value.output, "runs.jsonl")), false, "pre-usage infrastructure failures are not measured runs");
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.output, "aborted.json"), "utf8")).ledger.records, 0);
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
  assert.equal(fs.existsSync(path.join(value.output, "runs.jsonl")), false);
  const attempts = fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].abortSuite, true);
  assert.match(attempts[0].failure, /agent-exit-2/);
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
  assert.match(result.stdout, /RETRY 1\/1 \(agent-exit-2-with-usage-unavailable\)/);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.runCount, 2);
  const retried = report.runs.find((run) => run.infrastructureRetries === 1);
  assert.equal(retried.infrastructureAttempts, 2);
  assert.equal(retried.infrastructureFailures.length, 1);
  assert.equal(retried.infrastructureFailures[0].failure, "agent-exit-2-with-usage-unavailable");
  assert.deepEqual(report.infrastructure, {
    attempts: 3,
    retries: 1,
    retriedRuns: 1,
    failureCounts: { "agent-exit-2-with-usage-unavailable": 1 },
    classCounts: { "unknown-cost": 1 }
  });
  const attempts = fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].accepted, false);
  assert.equal(attempts[0].retryAvailable, true);
  assert.match(attempts[0].infrastructureDiagnostic, /^redacted-diagnostic-sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(attempts).includes("PIAGENT_BENCHMARK_STREAM_SECRET"), false);
});

test("retries one measured-zero provider overload instead of misclassifying it as a completed record", (t) => {
  const value = fixture(t);
  const overloadMarker = path.join(value.dir, "provider-overloaded-once");
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--repeats", "1",
    "--infrastructure-retries", "1",
    "--retry-delay", "0",
    "--yes",
    "--output", value.output
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_PROVIDER_OVERLOAD_ONCE: overloadMarker,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RETRY 1\/1 \(provider-temporarily-unavailable-with-zero-measured-usage\)/);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  const retried = report.runs.find((run) => run.infrastructureRetries === 1);
  assert.equal(retried.infrastructureAttempts, 2);
  assert.deepEqual(retried.infrastructureFailures.map((failure) => ({
    failure: failure.failure,
    class: failure.class,
    usageStatus: failure.usageStatus,
    fresh: failure.usage.fresh
  })), [{
    failure: "provider-temporarily-unavailable-with-zero-measured-usage",
    class: "provider-infrastructure",
    usageStatus: "measured-but-unaccepted",
    fresh: 0
  }]);
  assert.equal(report.comparison.failureAwareEfficiencyGate, true);
  assert.equal(report.comparison.failureAwareFreshTokenRatio, 0.5455);
  assert.equal(report.comparison.tokenClaimAllowed, false, "the small fake suite is diagnostic-only");
  const attempts = fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].accepted, false);
  assert.equal(attempts[0].retryAvailable, true);
  assert.equal(attempts[0].usageStatus, "measured-but-unaccepted");
  assert.equal(attempts[0].usage.fresh, 0);
});

test("aborts a terminal provider overload after measured usage instead of grading a partial workspace", (t) => {
  const value = fixture(t);
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--repeats", "1",
    "--infrastructure-retries", "1",
    "--retry-delay", "0",
    "--yes",
    "--output", value.output
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_PROVIDER_OVERLOAD_AFTER_USAGE: "1",
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, /hidden-grader-failed/);
  const attempts = fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(attempts.length, 1, "known paid usage is retained once without opening another paid retry");
  assert.equal(attempts[0].failure, "provider-temporarily-unavailable-after-measured-usage");
  assert.equal(attempts[0].infrastructureClass, "provider-infrastructure");
  assert.equal(attempts[0].usageStatus, "measured-but-unaccepted");
  assert.equal(attempts[0].usage.fresh, 25);
  assert.equal(attempts[0].infrastructureRetryable, false);
  assert.equal(attempts[0].infrastructureDiagnosticSource, "pi-terminal-error-event");
  assert.match(attempts[0].infrastructureDiagnostic, /^redacted-diagnostic-sha256:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(value.output, "runs.jsonl")), false, "partial provider work is never accepted as a measured outcome");
  assert.equal(fs.existsSync(path.join(value.output, "aborted.json")), true);
});

test("classifies provider policy refusal before usage separately from local infrastructure", (t) => {
  const value = fixture(t);
  const marker = path.join(value.dir, "codex-policy-refused-once");
  const result = spawnSync(process.execPath, [
    runner,
    "--suite", value.suite,
    "--surfaces", "piagent,codex-cli",
    "--model", "test/fake-model",
    "--thinking", "high",
    "--repeats", "1",
    "--infrastructure-retries", "1",
    "--retry-delay", "0",
    "--yes",
    "--output", value.output
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BENCHMARK_FAKE_CODEX_POLICY_REFUSAL_ONCE: marker,
      BENCHMARK_FAKE_EXPECT_CODEX_ISOLATION: "1",
      BENCHMARK_FAKE_OPERATOR_CODEX_HOME: value.operatorCodexHome,
      CODEX_HOME: value.operatorCodexHome,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_CODEX_COMMAND: value.fakeCodex,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(value.output, "report.json")), false);
  assert.equal(fs.existsSync(path.join(value.output, "aborted.json")), true);
  const attempts = fs.readFileSync(path.join(value.output, "infrastructure-attempts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].infrastructureFailure, "provider-policy-refusal-with-usage-unavailable");
  assert.equal(attempts[0].infrastructureClass, "provider-policy");
  assert.equal(attempts[0].usageStatus, "unknown-after-provider-start");
  assert.equal(attempts[0].retryAvailable, false);
});

test("forwards interruption and durably retains the unaccepted paid attempt", async (t) => {
  const value = fixture(t);
  const signalFile = path.join(value.dir, "signal.txt");
  const child = spawn(process.execPath, [runner, "--suite", value.suite, "--repeats", "1", "--infrastructure-retries", "1", "--retry-delay", "0", "--yes", "--output", value.output], {
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
  const activeWorkspace = path.join(value.output, "workspaces", fs.readdirSync(path.join(value.output, "workspaces"))[0]);
  const inFlight = JSON.parse(fs.readFileSync(path.join(activeWorkspace, "inflight.json"), "utf8"));
  assert.equal(inFlight.stage, "provider-may-start");
  assert.equal(fs.statSync(path.join(activeWorkspace, "inflight.json")).mode & 0o777, 0o600);
  child.kill("SIGINT");
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 130);
  const fakePid = Number(fs.readFileSync(signalFile, "utf8").match(/started:(\d+)/)?.[1]);
  assert.equal(Number.isInteger(fakePid), true);
  assert.throws(() => process.kill(fakePid, 0), (error) => error?.code === "ESRCH");
  assert.equal(fs.existsSync(path.join(value.output, "interrupted.json")), true);
  assert.equal(fs.statSync(path.join(value.output, "interrupted.json")).mode & 0o777, 0o600);
  const workspaces = fs.readdirSync(path.join(value.output, "workspaces"));
  assert.equal(workspaces.length, 1);
  const retained = path.join(value.output, "workspaces", workspaces[0]);
  assert.equal(fs.existsSync(path.join(retained, ".piagent-retain.json")), true);
  assert.equal(fs.existsSync(path.join(retained, "inflight.json")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8"));
  assert.equal(manifest.tokenClaimsUnavailableReason, "interrupted-provider-attempt-not-accepted-as-a-measured-outcome");
  assert.equal(manifest.recoveredProviderAttempts.length, 1);
  assert.equal(manifest.recoveredProviderAttempts[0].usageStatus, "unknown-after-provider-start");

  const resumed = spawnSync(process.execPath, [runner, "--resume", value.output, "--yes"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PIAGENT_BENCHMARK_PI_COMMAND: value.fakePi,
      PIAGENT_BENCHMARK_TASK_FIXTURE: path.join(root, "evals", "fixtures", "task-contract.valid.json")
    }
  });
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.equal(fs.existsSync(path.join(value.output, "interrupted.json")), false);
  const report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.runs[0].infrastructureAttempts, 2);
  assert.equal(report.runs[0].infrastructureFailures[0].usageStatus, "unknown-after-provider-start");
});

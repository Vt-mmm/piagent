#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  aggregateSessionUsage,
  benchmarkSurfaceLabel,
  createCodexExecJsonlCollector,
  evaluateWorkflowEvidence,
  renderBenchmarkHtml,
  renderBenchmarkText,
  summarizeBenchmark,
  validateBenchmarkSuite
} from "../packages/piagent-core/benchmark/benchmark-core.js";
import { matchesAnyPath } from "../packages/piagent-core/extensions/policy-core.js";
import { listTaskContracts, workingTreeFiles, workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { summarizeSession, walkJsonl } from "./pi-usage-history.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSuitePath = path.join(packageRoot, "benchmarks", "core-v1", "suite.json");
const productionSuitePath = path.join(packageRoot, "benchmarks", "production-v1", "suite.json");
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const outputLimit = 4 * 1024 * 1024;
const activeChildren = new Set();
const benchmarkSurfaces = new Set(["raw-pi", "piagent", "codex-cli"]);
const codexModes = new Set(["controlled", "native"]);
const controlledCodexFeatures = [
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "goals",
  "hooks",
  "skill_search",
  "tool_suggest",
  "workspace_dependencies"
];
const coldStartRuntimeManagedPaths = [
  ".pi/project-context.md",
  ".pi/context-index.json",
  ".pi/context-v2.sqlite",
  ".pi/context-v2.sqlite-*"
];
let interruptedSignal;

const usage = `Usage:
  piagent-benchmark [options]
  piagent-benchmark <project-path> --record ...   Legacy recorder
  piagent-benchmark <project-path> --init         Legacy scenario notes

Runs a clean, paired baseline vs Piagent benchmark and grades it automatically.
With no options it uses the built-in core-v1 suite, the current Pi default
model/thinking setting, and the suite's repeat count.

Options:
  --suite <id|path>            core-v1, production-v1, or suite.json path.
  --production                 Alias for --suite production-v1.
  --surfaces <a,b>             raw-pi,piagent (default) or piagent,codex-cli.
  --model <provider/model>     Pin one model identity for both surfaces.
  --thinking <level>           off|minimal|low|medium|high|xhigh|max.
  --codex-mode <mode>          controlled isolated home (default) or native user configuration.
  --repeats <1-10>             Override the suite repeat count.
  --infrastructure-retries <n> Retry 0-3 startup failures with zero recorded usage.
  --retry-delay <seconds>      Backoff before infrastructure retry, 0-120 seconds.
  --scenarios <id,id>          Run selected scenario families for diagnosis.
  --seed <value>               Reproduce generated hidden variants.
  --timeout <seconds>          Per-agent timeout, 30-3600 seconds.
  --output <directory>         Report directory; must be empty or absent.
  --keep-workspaces            Retain isolated workspaces and session logs.
  --yes                        Skip the cost/run-count confirmation.
  --dry-run                    Validate and print the execution plan only.
  --json                       Print final report JSON instead of the table.
  -h, --help                   Show this help.

Outputs report.json, report.html, summary.txt, and runs.jsonl with mode 0600.
No token/result value is entered manually; usage comes from Pi session JSONL
or Codex exec JSONL. Codex CLI comparisons require --model and --thinking.
`;

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`Missing value for ${name}`);
  return value;
}

function positiveInteger(raw, name, minimum, maximum) {
  if (!/^\d+$/.test(String(raw ?? ""))) fail(`${name} must be an integer`);
  const value = Number(raw);
  if (value < minimum || value > maximum) fail(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function terminateChild(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function installSignalForwarding() {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (interruptedSignal) return;
      interruptedSignal = signal;
      for (const child of activeChildren) {
        terminateChild(child, signal);
        setTimeout(() => terminateChild(child, "SIGKILL"), 2_000).unref();
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export function parseBenchmarkArgs(argv) {
  const options = {
    suite: "core-v1",
    surfaces: ["raw-pi", "piagent"],
    model: undefined,
    thinking: undefined,
    codexMode: "controlled",
    seed: undefined,
    repeats: undefined,
    infrastructureRetries: undefined,
    retryDelaySeconds: undefined,
    scenarioIds: undefined,
    timeoutSeconds: undefined,
    output: undefined,
    keepWorkspaces: false,
    yes: false,
    dryRun: false,
    json: false,
    help: false
  };
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "run":
        break;
      case "--suite":
        options.suite = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--production":
        options.suite = "production-v1";
        break;
      case "--surfaces": {
        const values = requireValue(argv, index, arg).split(",").map((value) => value.trim()).filter(Boolean);
        if (values.length !== 2 || new Set(values).size !== 2 || values.some((value) => !benchmarkSurfaces.has(value))) {
          fail("--surfaces must contain two different values from raw-pi, piagent, codex-cli");
        }
        if (!values.includes("piagent") || (!values.includes("raw-pi") && !values.includes("codex-cli"))) {
          fail("--surfaces must compare piagent with raw-pi or codex-cli");
        }
        options.surfaces = values;
        index += 1;
        break;
      }
      case "--model":
        options.model = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--thinking":
        options.thinking = requireValue(argv, index, arg);
        if (!thinkingLevels.has(options.thinking)) fail(`--thinking must be one of ${[...thinkingLevels].join(", ")}`);
        index += 1;
        break;
      case "--codex-mode":
        options.codexMode = requireValue(argv, index, arg);
        if (!codexModes.has(options.codexMode)) fail("--codex-mode must be controlled or native");
        index += 1;
        break;
      case "--repeats":
        options.repeats = positiveInteger(requireValue(argv, index, arg), arg, 1, 10);
        index += 1;
        break;
      case "--infrastructure-retries":
        options.infrastructureRetries = positiveInteger(requireValue(argv, index, arg), arg, 0, 3);
        index += 1;
        break;
      case "--retry-delay":
        options.retryDelaySeconds = positiveInteger(requireValue(argv, index, arg), arg, 0, 120);
        index += 1;
        break;
      case "--scenarios": {
        const values = requireValue(argv, index, arg).split(",").map((value) => value.trim()).filter(Boolean);
        if (values.length === 0 || new Set(values).size !== values.length) fail("--scenarios must contain unique scenario ids");
        options.scenarioIds = values;
        index += 1;
        break;
      }
      case "--seed":
        options.seed = requireValue(argv, index, arg);
        if (options.seed.length > 200) fail("--seed must contain at most 200 characters");
        index += 1;
        break;
      case "--timeout":
        options.timeoutSeconds = positiveInteger(requireValue(argv, index, arg), arg, 30, 3600);
        index += 1;
        break;
      case "--output":
        options.output = path.resolve(requireValue(argv, index, arg));
        index += 1;
        break;
      case "--keep-workspaces":
        options.keepWorkspaces = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        fail(`Unknown benchmark option: ${arg}`);
    }
  }
  return options;
}

function isLegacyInvocation(argv) {
  return argv.includes("--record") || argv.includes("--init");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (interruptedSignal) {
      reject(new Error(`Benchmark interrupted by ${interruptedSignal}`));
      return;
    }
    const started = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached
    });
    activeChildren.add(child);
    const cleanup = () => activeChildren.delete(child);
    if (options.inherit) {
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("exit", (code, signal) => { cleanup(); resolve({ code: code ?? 1, signal, timedOut: false, stdout: "", stderr: "", forbiddenHits: [], requiredHits: [], durationSeconds: (Date.now() - started) / 1000 }); });
      return;
    }
    if (options.input !== undefined) {
      child.stdin.on("error", () => { /* Child exit is reported by the process result. */ });
      child.stdin.end(String(options.input));
    }
    let stdout = "";
    let stderr = "";
    const stdoutDigest = crypto.createHash("sha256");
    const forbidden = [...new Set(options.forbiddenSubstrings ?? [])].filter((value) => typeof value === "string" && value);
    const required = [...new Set(options.requiredSubstrings ?? [])].filter((value) => typeof value === "string" && value);
    const forbiddenHits = new Set();
    const requiredHits = new Set();
    const scanTails = { stdout: "", stderr: "" };
    const scanWindow = Math.max(0, ...[...forbidden, ...required].map((value) => value.length - 1));
    const append = (current, chunk) => `${current}${chunk}`.slice(-outputLimit);
    const inspect = (stream, chunk) => {
      const text = `${scanTails[stream]}${chunk}`;
      for (const value of forbidden) {
        if (text.includes(value)) forbiddenHits.add(value);
      }
      if (stream === "stdout") {
        for (const value of required) {
          if (text.includes(value)) requiredHits.add(value);
        }
      }
      scanTails[stream] = scanWindow > 0 ? text.slice(-scanWindow) : "";
    };
    child.stdout.on("data", (chunk) => {
      stdoutDigest.update(chunk);
      options.onStdoutChunk?.(chunk);
      inspect("stdout", chunk);
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      inspect("stderr", chunk);
      stderr = append(stderr, chunk);
    });
    let timedOut = false;
    const terminate = (signal) => terminateChild(child, signal);
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      setTimeout(() => terminate("SIGKILL"), 2_000).unref();
    }, options.timeoutMs) : undefined;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      cleanup();
      resolve({ code: code ?? 1, signal, timedOut, stdout, stdoutHash: stdoutDigest.digest("hex"), stderr, forbiddenHits: [...forbiddenHits], requiredHits: [...requiredHits], durationSeconds: (Date.now() - started) / 1000 });
    });
  });
}

function resolveSuitePath(input) {
  if (input === "core-v1") return coreSuitePath;
  if (input === "production-v1") return productionSuitePath;
  const candidate = path.resolve(input);
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    ? path.join(candidate, "suite.json")
    : candidate;
}

function loadSuite(input) {
  const manifestPath = resolveSuitePath(input);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Cannot read benchmark suite ${manifestPath}: ${error.message}`, 1);
  }
  const suite = validateBenchmarkSuite(raw);
  return { suite, manifestPath: fs.realpathSync(manifestPath), suiteRoot: fs.realpathSync(path.dirname(manifestPath)) };
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveSuiteEntry(suiteRoot, relativePath, kind) {
  const lexical = path.resolve(suiteRoot, relativePath);
  if (!inside(suiteRoot, lexical)) fail(`Suite ${kind} escapes its root: ${relativePath}`, 1);
  let resolved;
  try {
    resolved = fs.realpathSync(lexical);
  } catch {
    fail(`Suite ${kind} does not exist: ${relativePath}`, 1);
  }
  if (!inside(suiteRoot, resolved)) fail(`Suite ${kind} resolves outside its root: ${relativePath}`, 1);
  const stat = fs.statSync(resolved);
  if (kind === "fixture" ? !stat.isDirectory() : !stat.isFile()) fail(`Suite ${kind} has the wrong file type: ${relativePath}`, 1);
  return resolved;
}

function rejectSymlinks(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail(`Benchmark fixture must not contain symbolic links: ${path.relative(root, target)}`, 1);
      if (stat.isDirectory()) stack.push(target);
    }
  }
}

function validateSuiteFiles(suite, suiteRoot) {
  rejectSymlinks(suiteRoot);
  for (const scenario of suite.scenarios) {
    const fixture = resolveSuiteEntry(suiteRoot, scenario.fixture, "fixture");
    const prompt = resolveSuiteEntry(suiteRoot, scenario.prompt, "prompt");
    const grader = resolveSuiteEntry(suiteRoot, scenario.grader, "grader");
    const generator = scenario.variantGenerator
      ? resolveSuiteEntry(suiteRoot, scenario.variantGenerator, "variant generator")
      : null;
    if (inside(fixture, grader) || inside(fixture, prompt)) {
      fail(`Suite prompt and grader must stay outside the agent fixture: ${scenario.id}`, 1);
    }
    if (generator && inside(fixture, generator)) {
      fail(`Suite variant generator must stay outside the agent fixture: ${scenario.id}`, 1);
    }
  }
}

function suiteTreeDigest(suiteRoot) {
  const files = [];
  const stack = [suiteRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  const hash = crypto.createHash("sha256");
  for (const file of files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    hash.update(path.relative(suiteRoot, file).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch { /* Non-POSIX filesystem. */ }
  return target;
}

function benchmarkEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PIAGENT_")) delete env[key];
  }
  if (process.env.PIAGENT_BENCHMARK_PI_COMMAND && process.env.PIAGENT_BENCHMARK_TASK_FIXTURE) {
    env.PIAGENT_BENCHMARK_TASK_FIXTURE = process.env.PIAGENT_BENCHMARK_TASK_FIXTURE;
  }
  return { ...env, ...extra };
}

function operatorCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function createCodexRuntime(options) {
  if (!options.surfaces.includes("codex-cli")) {
    return { mode: null, home: null, credentialBridge: null, cleanup() {} };
  }
  if (options.codexMode === "native") {
    return { mode: "native", home: null, credentialBridge: "operator-home", cleanup() {} };
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-codex-home-"));
  try { fs.chmodSync(home, 0o700); } catch { /* Non-POSIX filesystem. */ }
  let credentialBridge = "environment-only";
  const sourceAuth = path.join(operatorCodexHome(), "auth.json");
  try {
    const resolvedAuth = fs.realpathSync(sourceAuth);
    if (!fs.statSync(resolvedAuth).isFile()) fail(`Codex credential path is not a file: ${sourceAuth}`, 1);
    fs.symlinkSync(resolvedAuth, path.join(home, "auth.json"));
    credentialBridge = "auth-json-link";
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fs.rmSync(home, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    mode: "controlled",
    home,
    credentialBridge,
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); }
  };
}

function codexProcessEnvironment(runtime, extra = {}) {
  const env = benchmarkEnvironment(extra);
  if (runtime.mode !== "controlled") return env;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && key !== "CODEX_ACCESS_TOKEN") delete env[key];
  }
  for (const key of ["OPENAI_BASE_URL", "OPENAI_API_BASE"]) delete env[key];
  env.CODEX_HOME = runtime.home;
  return env;
}

function comparisonSurfaces(options) {
  return {
    baselineSurface: options.surfaces.find((surface) => surface !== "piagent"),
    candidateSurface: "piagent"
  };
}

function codexModelName(model) {
  const value = String(model ?? "").trim();
  if (!value) fail("Codex CLI comparisons require --model", 1);
  const separator = value.indexOf("/");
  const resolved = separator >= 0 ? value.slice(separator + 1) : value;
  if (!resolved || resolved.includes("/")) fail(`Cannot map --model ${value} to a Codex CLI model id`, 1);
  return resolved;
}

function codexThinkingEffort(thinking) {
  if (!thinking) fail("Codex CLI comparisons require --thinking", 1);
  return thinking === "off" ? "none" : thinking;
}

function codexExecArgs({ workspace, options, disabledFeatures = [] }) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--color", "never",
    "-C", workspace,
    "-s", "workspace-write",
    "-m", codexModelName(options.model),
    "-c", `model_reasoning_effort=${JSON.stringify(codexThinkingEffort(options.thinking))}`
  ];
  if (options.codexMode === "controlled") {
    args.push("--ignore-user-config", "--ignore-rules");
    for (const feature of disabledFeatures) args.push("--disable", feature);
  }
  args.push("-");
  return args;
}

function graderEnvironment(scenarioId) {
  const env = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NO_COLOR: "1", PIAGENT_BENCHMARK_SCENARIO: scenarioId };
}

function writePrivate(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Non-POSIX filesystem. */ }
}

function defaultOutputRoot() {
  const agentRoot = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentRoot, "benchmarks", "piagent");
}

function globalAppendSystemPrompt() {
  const agentRoot = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const candidate = path.resolve(agentRoot, "APPEND_SYSTEM.md");
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : undefined;
}

function createRunId(suiteId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${suiteId}-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function ensureEmptyOutput(target) {
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) fail(`Output directory is not empty: ${target}`, 1);
  return privateDirectory(target);
}

function safeWorkspaceFile(workspace, relativePath) {
  const target = path.resolve(workspace, relativePath);
  if (!inside(workspace, target)) fail(`Benchmark setup file escapes the workspace: ${relativePath}`, 1);
  return target;
}

async function initializeGit(workspace, setupFiles) {
  const commands = [
    ["init", "-q"],
    ["config", "user.email", "benchmark@piagent.local"],
    ["config", "user.name", "Piagent Benchmark"],
    ["add", "-A"]
  ];
  for (const args of commands) {
    const result = await runCommand("git", args, { cwd: workspace, timeoutMs: 30_000 });
    if (result.code !== 0) fail(`Git fixture setup failed: git ${args.join(" ")}`, 1);
  }
  for (const file of Object.keys(setupFiles ?? {})) {
    const result = await runCommand("git", ["add", "-f", "--", file], { cwd: workspace, timeoutMs: 30_000 });
    if (result.code !== 0) fail(`Git could not track benchmark setup file ${file}`, 1);
  }
  const commit = await runCommand("git", ["commit", "-qm", "benchmark fixture"], { cwd: workspace, timeoutMs: 30_000 });
  if (commit.code !== 0) fail("Git could not commit the benchmark fixture", 1);
}

function applySetupFiles(workspace, setupFiles) {
  for (const [relativePath, content] of Object.entries(setupFiles ?? {})) {
    const target = safeWorkspaceFile(workspace, relativePath);
    privateDirectory(path.dirname(target));
    writePrivate(target, content);
  }
}

function variantSeed(rootSeed, suiteDigest, scenarioId, repeat) {
  return crypto.createHmac("sha256", rootSeed)
    .update(`${suiteDigest}\0${scenarioId}\0${repeat}`)
    .digest("hex");
}

function generatedStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || !item || item.length > 1_000)) {
    fail(`Benchmark variant ${field} must contain at most 20 non-empty strings of at most 1000 characters`, 1);
  }
  return [...new Set(value)];
}

async function generateVariant({ generator, workspace, oraclePath, seed, scenario, timeoutSeconds }) {
  const result = await runCommand(process.execPath, [generator, workspace, oraclePath, seed, scenario.id], {
    cwd: path.dirname(generator),
    timeoutMs: Math.min(timeoutSeconds, 120) * 1_000,
    env: graderEnvironment(scenario.id)
  });
  if (result.timedOut) fail(`Benchmark variant generator timed out for ${scenario.id}`, 1);
  if (result.code !== 0) fail(`Benchmark variant generator failed for ${scenario.id}: ${result.stderr.trim() || result.stdout.trim()}`, 1);
  let oracle;
  try { oracle = JSON.parse(fs.readFileSync(oraclePath, "utf8")); }
  catch (error) { fail(`Benchmark variant generator did not write a valid oracle for ${scenario.id}: ${error.message}`, 1); }
  if (!oracle || typeof oracle !== "object" || Array.isArray(oracle) || oracle.schemaVersion !== 1 || !oracle.graderData || typeof oracle.graderData !== "object" || Array.isArray(oracle.graderData)) {
    fail(`Benchmark variant oracle is invalid for ${scenario.id}`, 1);
  }
  const serialized = JSON.stringify(oracle);
  if (Buffer.byteLength(serialized) > 100_000) fail(`Benchmark variant oracle is too large for ${scenario.id}`, 1);
  writePrivate(oraclePath, `${JSON.stringify(oracle)}\n`);
  return {
    oraclePath,
    oracleDigest: crypto.createHash("sha256").update(serialized).digest("hex"),
    seedDigest: crypto.createHash("sha256").update(seed).digest("hex"),
    requiredOutputSubstrings: generatedStringArray(oracle.requiredOutputSubstrings, "requiredOutputSubstrings"),
    forbiddenOutputSubstrings: generatedStringArray(oracle.forbiddenOutputSubstrings, "forbiddenOutputSubstrings")
  };
}

async function initializeTreatment(workspace, profile) {
  const result = await runCommand("bash", [
    path.join(packageRoot, "scripts", "init-project.sh"),
    workspace,
    "--profile", profile,
    "--package-source", packageRoot
  ], {
    cwd: packageRoot,
    timeoutMs: 60_000,
    env: benchmarkEnvironment({ PIAGENT_NO_UPDATE_CHECK: "1" })
  });
  if (result.code !== 0) fail(`Piagent fixture initialization failed: ${result.stderr.trim() || result.stdout.trim()}`, 1);
}

function prepareTreatmentBaseline(workspace, profileName, scenario) {
  const profilePath = path.join(workspace, ".pi", "piagent-profile.json");
  const contextPath = path.join(workspace, ".pi", "project-context.md");
  const indexPath = path.join(workspace, ".pi", "context-index.json");
  let profile;
  let existingIndex;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    existingIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch (error) {
    fail(`Piagent benchmark baseline could not read initialized context: ${error.message}`, 1);
  }

  const recordedAt = new Date().toISOString();
  const projectId = typeof profile.projectId === "string" && profile.projectId.trim()
    ? profile.projectId.trim()
    : "piagent-benchmark-project";
  const profileMode = typeof profile.mode === "string" && profile.mode.trim()
    ? profile.mode.trim()
    : profileName;
  const sourceScope = (scenario.allowedChanges ?? []).join(", ") || "read-only";
  const summary = `Pre-onboarded synthetic benchmark fixture for ${scenario.id}.`;
  const markdown = [
    "# Project Context",
    "",
    "## Status",
    "",
    `- Generated: ${recordedAt}`,
    `- Profile: ${profileMode}`,
    "- Source: deterministic benchmark baseline",
    "- Verification: use the configured source verifier",
    `- Task scope: ${sourceScope}`,
    "",
    "## Project",
    "",
    "- Small synthetic Node.js fixture used to compare Raw Pi and Piagent.",
    "- Source files and focused tests are authoritative.",
    "- Keep implementation changes within the task scope supplied by the user.",
    ""
  ].join("\n");
  fs.writeFileSync(contextPath, markdown);

  const profileNode = `profile:${profileMode}`;
  const contextNode = "context:.pi/project-context.md";
  const index = {
    schemaVersion: 1,
    projectId,
    profileMode,
    source: "onboarding-record",
    summary,
    generatedAt: recordedAt,
    updatedAt: recordedAt,
    policy: { ...(existingIndex.policy ?? {}), ...(profile.contextIndex ?? {}) },
    nodes: [
      {
        id: profileNode,
        kind: "profile",
        label: profileMode,
        summary: "Active benchmark profile.",
        path: ".pi/piagent-profile.json",
        tags: ["profile", "benchmark"],
        citations: [{ path: ".pi/piagent-profile.json", reason: "Active benchmark profile" }],
        updatedAt: recordedAt
      },
      {
        id: contextNode,
        kind: "context",
        label: ".pi/project-context.md",
        summary,
        path: ".pi/project-context.md",
        tags: ["snapshot", "benchmark"],
        citations: [{ path: "package.json", reason: "Synthetic project manifest" }],
        updatedAt: recordedAt
      }
    ],
    edges: [{ from: profileNode, to: contextNode, kind: "documented_by", reason: "Benchmark profile uses the prepared context." }],
    citations: [{ path: "package.json", reason: "Synthetic project manifest" }],
    warnings: []
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const stateRoot = privateDirectory(path.join(workspace, ".pi", "piagent-state"));
  writePrivate(path.join(stateRoot, "project-onboarding.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    profileMode,
    contextFile: ".pi/project-context.md",
    summary,
    model: "benchmark-setup",
    sourceFiles: [{ path: "package.json", reason: "Synthetic project manifest" }],
    updateTriggers: ["fixture source or benchmark profile changes"],
    notes: "Prepared outside measured model execution so task runs represent steady-state usage.",
    recordedAt
  }, null, 2)}\n`);
}

async function prepareTreatmentContextEngine(workspace) {
  const result = await runCommand(process.execPath, [
    path.join(packageRoot, "scripts", "context-engine.mjs"),
    "rebuild",
    "--project", workspace,
    "--json"
  ], {
    cwd: packageRoot,
    timeoutMs: 60_000,
    env: benchmarkEnvironment({ PIAGENT_NO_UPDATE_CHECK: "1" })
  });
  if (result.code !== 0) fail(`Piagent benchmark context preparation failed: ${result.stderr.trim() || result.stdout.trim()}`, 1);
}

function forbiddenSessionHits(sessionFiles, candidates) {
  const hits = new Set();
  for (const file of sessionFiles) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "message" || !entry.message) continue;
      const content = entry.message.content;
      if (typeof content === "string") {
        for (const value of candidates) {
          if (content.includes(value)) hits.add(value);
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "text" || typeof block.text !== "string") continue;
        for (const value of candidates) {
          if (block.text.includes(value)) hits.add(value);
        }
      }
    }
  }
  return [...hits];
}

function inspectForbiddenValue(value, candidates, hits) {
  if (typeof value === "string") {
    for (const candidate of candidates) {
      if (value.includes(candidate)) hits.add(candidate);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectForbiddenValue(item, candidates, hits);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) inspectForbiddenValue(item, candidates, hits);
  }
}

function parseGraderResult(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  let value;
  try { value = JSON.parse(lines.at(-1) ?? ""); } catch { fail("Benchmark grader did not return a JSON object", 1); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.passed !== "boolean" || !Array.isArray(value.checks)) {
    fail("Benchmark grader result must contain passed and checks", 1);
  }
  for (const check of value.checks) {
    if (!check || typeof check.id !== "string" || typeof check.passed !== "boolean") fail("Benchmark grader returned an invalid check", 1);
  }
  return {
    passed: value.passed,
    score: Number.isFinite(value.score) ? Math.max(0, Math.min(10, value.score)) : value.passed ? 10 : 0,
    checks: value.checks.map((check) => ({ id: check.id, passed: check.passed, detail: typeof check.detail === "string" ? check.detail.slice(0, 500) : undefined }))
  };
}

async function gradeWorkspace(grader, workspace, scenario, timeoutSeconds, oraclePath) {
  const args = oraclePath ? [grader, workspace, oraclePath] : [grader, workspace];
  const result = await runCommand(process.execPath, args, {
    cwd: path.dirname(grader),
    timeoutMs: Math.min(timeoutSeconds, 120) * 1_000,
    env: graderEnvironment(scenario.id)
  });
  if (result.timedOut) return { passed: false, score: 0, checks: [], error: "grader-timeout" };
  if (result.code !== 0) return { passed: false, score: 0, checks: [], error: `grader-exit-${result.code}` };
  try { return parseGraderResult(result.stdout); } catch (error) { return { passed: false, score: 0, checks: [], error: error.message }; }
}

function sessionSummaries(sessionDir) {
  return walkJsonl(sessionDir).map((file) => summarizeSession(file, {})).filter(Boolean);
}

function failureReason({ agent, grade, graderIntegrity, outsideScope, forbiddenHits, missingRequired }) {
  const failures = [];
  if (agent.timedOut) failures.push("agent-timeout");
  else if (agent.code !== 0) failures.push(`agent-exit-${agent.code}`);
  if (!grade.passed) failures.push(grade.error ?? "hidden-grader-failed");
  if (!graderIntegrity.passed) failures.push("grader-mutated-workspace");
  if (outsideScope.length) failures.push(`outside-scope:${outsideScope.join(",")}`);
  if (forbiddenHits.length) failures.push("forbidden-output");
  if (missingRequired.length) failures.push("required-output-missing");
  return failures.join("; ") || undefined;
}

function safeInfrastructureDiagnostic(value, forbiddenValues) {
  let diagnostic = String(value ?? "");
  for (const forbidden of forbiddenValues) {
    if (forbidden) diagnostic = diagnostic.replaceAll(forbidden, "[REDACTED]");
  }
  return diagnostic
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(-4_000);
}

async function runOne({
  suite,
  suiteRoot,
  scenario,
  surface,
  repeat,
  infrastructureAttempt = 1,
  runId,
  runRoot,
  options,
  piCommand,
  codexCommand,
  codexDisabledFeatures,
  codexRuntime,
  suiteDigest,
  rootSeed
}) {
  const attemptSuffix = infrastructureAttempt > 1 ? `-infra-${infrastructureAttempt}` : "";
  const key = `${String(repeat).padStart(2, "0")}-${scenario.id}-${surface}${attemptSuffix}`;
  const workspaceRoot = privateDirectory(path.join(runRoot, "workspaces", key));
  const workspace = path.join(workspaceRoot, "project");
  const sessions = privateDirectory(path.join(workspaceRoot, "sessions"));
  const fixture = resolveSuiteEntry(suiteRoot, scenario.fixture, "fixture");
  fs.cpSync(fixture, workspace, { recursive: true, errorOnExist: true });
  applySetupFiles(workspace, scenario.setupFiles);
  const profile = scenario.profile ?? suite.profile;
  const lifecycle = scenario.lifecycle ?? "steady-state";
  let variant = {
    oraclePath: null,
    oracleDigest: null,
    seedDigest: null,
    requiredOutputSubstrings: [],
    forbiddenOutputSubstrings: []
  };
  if (scenario.variantGenerator) {
    const generator = resolveSuiteEntry(suiteRoot, scenario.variantGenerator, "variant generator");
    variant = await generateVariant({
      generator,
      workspace,
      oraclePath: path.join(workspaceRoot, "oracle.json"),
      seed: variantSeed(rootSeed, suiteDigest, scenario.id, repeat),
      scenario,
      timeoutSeconds: options.timeoutSeconds
    });
  }
  const forbiddenOutputSubstrings = [...new Set([
    ...(scenario.forbiddenOutputSubstrings ?? []),
    ...variant.forbiddenOutputSubstrings
  ])];
  const requiredOutputSubstrings = [...new Set([
    ...(scenario.requiredOutputSubstrings ?? []),
    ...variant.requiredOutputSubstrings
  ])];
  if (surface === "piagent") {
    await initializeTreatment(workspace, profile);
    if (lifecycle === "steady-state") {
      prepareTreatmentBaseline(workspace, profile, scenario);
      await prepareTreatmentContextEngine(workspace);
    }
  }
  await initializeGit(workspace, scenario.setupFiles);

  const promptPath = resolveSuiteEntry(suiteRoot, scenario.prompt, "prompt");
  const graderPath = resolveSuiteEntry(suiteRoot, scenario.grader, "grader");
  const prompt = fs.readFileSync(promptPath, "utf8").trim();
  const sessionId = crypto.randomUUID();
  const piArgs = [
    "--print", "--mode", "json",
    "--session-dir", sessions,
    "--session-id", sessionId,
    "--name", `BENCH ${scenario.id} ${surface} r${repeat}`,
    "--approve",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-context-files"
  ];
  const controlledCrossCli = options.surfaces.includes("codex-cli") && options.codexMode === "controlled";
  const globalAppend = controlledCrossCli ? undefined : globalAppendSystemPrompt();
  if (globalAppend) piArgs.push("--append-system-prompt", globalAppend);
  if (surface === "piagent") {
    const projectInstructions = path.join(workspace, "AGENTS.md");
    if (!fs.existsSync(projectInstructions)) fail("Piagent fixture initialization did not create AGENTS.md", 1);
    piArgs.push(
      "--append-system-prompt", projectInstructions,
      "--extension", path.join(packageRoot, "packages", "piagent-core", "extensions", "piagent-guard.ts"),
      "--skill", path.join(packageRoot, "packages", "piagent-core", "skills")
    );
  }
  if (options.model) piArgs.push("--model", options.model);
  if (options.thinking) piArgs.push("--thinking", options.thinking);
  piArgs.push(prompt);

  const command = surface === "codex-cli" ? codexCommand : piCommand;
  const args = surface === "codex-cli"
    ? codexExecArgs({ workspace, options, disabledFeatures: codexDisabledFeatures })
    : piArgs;
  const codexForbiddenHits = new Set();
  const codexCollector = surface === "codex-cli" ? createCodexExecJsonlCollector({
    model: options.model,
    thinkingLevel: options.thinking,
    onEvent: (event) => inspectForbiddenValue(event, forbiddenOutputSubstrings, codexForbiddenHits)
  }) : undefined;

  const agent = await runCommand(command, args, {
    cwd: workspace,
    input: surface === "codex-cli" ? prompt : undefined,
    timeoutMs: options.timeoutSeconds * 1_000,
    forbiddenSubstrings: forbiddenOutputSubstrings,
    requiredSubstrings: requiredOutputSubstrings,
    onStdoutChunk: codexCollector ? (chunk) => codexCollector.write(chunk) : undefined,
    env: surface === "codex-cli" ? codexProcessEnvironment(codexRuntime, {
      PIAGENT_NO_UPDATE_CHECK: "1",
      PIAGENT_BENCHMARK_RUN_ID: runId,
      PIAGENT_BENCHMARK_SCENARIO: scenario.id,
      PIAGENT_BENCHMARK_SURFACE: surface,
      PIAGENT_BENCHMARK_SESSION_ID: sessionId,
      PIAGENT_BENCHMARK_PROFILE: profile,
      PIAGENT_BENCHMARK_LIFECYCLE: lifecycle,
      NO_COLOR: "1"
    }) : benchmarkEnvironment({
      PIAGENT_NO_UPDATE_CHECK: "1",
      PIAGENT_BENCHMARK_RUN_ID: runId,
      PIAGENT_BENCHMARK_SCENARIO: scenario.id,
      PIAGENT_BENCHMARK_SURFACE: surface,
      PIAGENT_BENCHMARK_SESSION_ID: sessionId,
      PIAGENT_BENCHMARK_PROFILE: profile,
      PIAGENT_BENCHMARK_LIFECYCLE: lifecycle,
      NO_COLOR: "1"
    })
  });
  const sessionFiles = surface === "codex-cli" ? [] : walkJsonl(sessions);
  let usage;
  let codexDiagnostics = [];
  if (surface === "codex-cli") {
    try {
      usage = codexCollector.finish();
    } catch (error) {
      if (agent.code === 0 && !agent.timedOut) throw error;
      usage = aggregateSessionUsage([]);
    }
    codexDiagnostics = codexCollector.diagnostics();
  } else {
    usage = aggregateSessionUsage(sessionSummaries(sessions));
  }
  const forbiddenHits = [...new Set([
    ...(agent.forbiddenHits ?? []),
    ...(surface === "codex-cli"
      ? [...codexForbiddenHits]
      : forbiddenSessionHits(sessionFiles, forbiddenOutputSubstrings))
  ])];
  const requiredHits = new Set(agent.requiredHits ?? []);
  if (surface !== "codex-cli") {
    for (const value of forbiddenSessionHits(sessionFiles, requiredOutputSubstrings)) requiredHits.add(value);
  }
  const missingRequired = requiredOutputSubstrings.filter((value) => !requiredHits.has(value));
  const allChangedFiles = workingTreeFiles(workspace);
  const runtimeManagedChanges = surface === "piagent" && lifecycle === "cold-start"
    ? allChangedFiles.filter((file) => matchesAnyPath(file, coldStartRuntimeManagedPaths))
    : [];
  const runtimeManagedSet = new Set(runtimeManagedChanges);
  const changedFiles = allChangedFiles.filter((file) => !runtimeManagedSet.has(file));
  const beforeGrade = workingTreeSnapshot(workspace);
  const outsideScope = changedFiles.filter((file) => !matchesAnyPath(file, scenario.allowedChanges));
  const grade = await gradeWorkspace(graderPath, workspace, scenario, options.timeoutSeconds, variant.oraclePath);
  const afterGrade = workingTreeSnapshot(workspace);
  const graderIntegrity = { passed: JSON.stringify(beforeGrade) === JSON.stringify(afterGrade) };
  let workflow = null;
  if (surface === "piagent" && scenario.kind !== "safety-refusal") {
    const task = listTaskContracts(workspace).find((item) => item.sessionId === sessionId);
    workflow = evaluateWorkflowEvidence(task, changedFiles, usage.toolNames, { scenarioKind: scenario.kind });
  }
  const scope = { passed: outsideScope.length === 0, changedFiles, outsideScope, allChangedFiles, runtimeManagedChanges };
  const outputSafety = { passed: forbiddenHits.length === 0, forbiddenHits: forbiddenHits.map((value) => crypto.createHash("sha256").update(value).digest("hex")) };
  const outputEvidence = {
    passed: missingRequired.length === 0,
    requiredCount: requiredOutputSubstrings.length,
    observedCount: requiredOutputSubstrings.length - missingRequired.length,
    missingHashes: missingRequired.map((value) => crypto.createHash("sha256").update(value).digest("hex"))
  };
  // A timed-out agent is measured reliability evidence. Only an early process
  // failure with no provider usage is infrastructure and eligible for retry.
  const abortSuite = !agent.timedOut && agent.code !== 0 && usage.fresh <= 0;
  const diagnosticInput = codexDiagnostics.length > 0
    ? JSON.stringify(codexDiagnostics)
    : `${agent.stderr ?? ""}\n${agent.stdout ?? ""}`;
  const resolved = agent.code === 0 && !agent.timedOut && grade.passed && graderIntegrity.passed && scope.passed && outputSafety.passed && outputEvidence.passed;
  const record = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    scenarioKind: scenario.kind,
    category: scenario.category ?? "unspecified",
    difficulty: scenario.difficulty ?? "unspecified",
    profile,
    lifecycle,
    surface,
    repeat,
    infrastructureAttempt,
    sessionId,
    providerSessionId: usage.providerSessionId ?? null,
    abortSuite,
    infrastructureFailure: abortSuite ? `agent-exit-${agent.code}-before-usage` : undefined,
    infrastructureDiagnostic: abortSuite ? safeInfrastructureDiagnostic(diagnosticInput, forbiddenOutputSubstrings) : undefined,
    infrastructureDiagnosticSource: abortSuite ? (codexDiagnostics.length > 0 ? "codex-error-events" : "process-output-tail") : undefined,
    resolved,
    failure: failureReason({ agent, grade, graderIntegrity, outsideScope, forbiddenHits, missingRequired }),
    agent: {
      exitCode: agent.code,
      signal: agent.signal,
      timedOut: agent.timedOut,
      stdoutHash: agent.stdoutHash ?? crypto.createHash("sha256").update(agent.stdout).digest("hex"),
      stderrHash: crypto.createHash("sha256").update(agent.stderr ?? "").digest("hex")
    },
    grade,
    graderIntegrity,
    scope,
    outputSafety,
    outputEvidence,
    workflow,
    usage,
    durationSeconds: agent.durationSeconds,
    promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
    variant: scenario.variantGenerator ? {
      generated: true,
      seedDigest: variant.seedDigest,
      oracleDigest: variant.oracleDigest
    } : { generated: false }
  };
  if (!options.keepWorkspaces) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  return record;
}

function executionOrder(suite, repeats, surfaces, rootSeed) {
  const order = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const scenarios = suite.schemaVersion === 2
      ? [...suite.scenarios].sort((left, right) => {
        const rank = (scenario) => crypto.createHmac("sha256", rootSeed).update(`order\0${repeat}\0${scenario.id}`).digest("hex");
        return rank(left).localeCompare(rank(right));
      })
      : suite.scenarios;
    for (const [index, scenario] of scenarios.entries()) {
      const reverse = suite.schemaVersion === 2
        ? (crypto.createHmac("sha256", rootSeed).update(`surface\0${repeat}\0${scenario.id}`).digest()[0] & 1) === 1
        : (repeat + index) % 2 !== 0;
      const ordered = reverse ? [...surfaces].reverse() : surfaces;
      for (const surface of ordered) order.push({ scenario, surface, repeat });
    }
  }
  return order;
}

async function confirmPlan(message) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Refusing to start billed model runs without --yes in a non-interactive terminal", 1);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${message}\nContinue? [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function checkedVersion(command, args, label, env = process.env) {
  let result;
  try { result = await runCommand(command, args, { cwd: packageRoot, timeoutMs: 15_000, env }); }
  catch (error) { fail(`Required command is unavailable: ${label} (${error.message})`, 1); }
  if (result.code !== 0) fail(`Required command failed preflight: ${label}`, 1);
  return result.stdout.trim();
}

async function preflight({ piCommand, codexCommand, surfaces, codexMode, codexRuntime }) {
  const gitVersion = await checkedVersion("git", ["--version"], "git");
  const piVersion = await checkedVersion(piCommand, ["--version"], "pi");
  let codexVersion;
  let codexAuth;
  let codexDisabledFeatures = [];
  if (surfaces.includes("codex-cli")) {
    const codexEnv = codexProcessEnvironment(codexRuntime);
    codexVersion = await checkedVersion(codexCommand, ["--version"], "codex", codexEnv);
    let result;
    try { result = await runCommand(codexCommand, ["login", "status"], { cwd: packageRoot, timeoutMs: 15_000, env: codexEnv }); }
    catch (error) { fail(`Codex authentication preflight failed: ${error.message}`, 1); }
    if (result.code === 0) codexAuth = "login-status";
    else if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN) codexAuth = "environment-credential";
    else fail("Codex CLI is not authenticated; run codex login before this benchmark", 1);

    if (codexMode === "controlled") {
      const features = await runCommand(codexCommand, ["features", "list"], { cwd: packageRoot, timeoutMs: 15_000, env: codexEnv });
      if (features.code !== 0) fail("Codex CLI cannot list features required by controlled benchmark mode; update Codex CLI or use --codex-mode native", 1);
      const available = new Set(features.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
      codexDisabledFeatures = controlledCodexFeatures.filter((feature) => available.has(feature));
    }
  }
  return { gitVersion, piVersion, codexVersion, codexAuth, codexDisabledFeatures };
}

async function sourceIdentity() {
  const top = await runCommand("git", ["-C", packageRoot, "rev-parse", "--show-toplevel"], { cwd: packageRoot, timeoutMs: 15_000 });
  if (top.code !== 0) return { kind: "package", commit: null, dirty: null };
  let repositoryRoot;
  try { repositoryRoot = fs.realpathSync(top.stdout.trim()); } catch { return { kind: "package", commit: null, dirty: null }; }
  if (repositoryRoot !== fs.realpathSync(packageRoot)) return { kind: "package", commit: null, dirty: null };
  const commit = await runCommand("git", ["-C", packageRoot, "rev-parse", "HEAD"], { cwd: packageRoot, timeoutMs: 15_000 });
  const status = await runCommand("git", ["-C", packageRoot, "status", "--porcelain", "--untracked-files=normal"], { cwd: packageRoot, timeoutMs: 15_000 });
  return {
    kind: "git-working-tree",
    commit: commit.code === 0 ? commit.stdout.trim() : null,
    dirty: status.code === 0 ? Boolean(status.stdout.trim()) : null
  };
}

async function runLegacy(argv) {
  const result = await runCommand("bash", [path.join(packageRoot, "scripts", "quality-benchmark.sh"), ...argv], { cwd: process.cwd(), inherit: true });
  process.exitCode = result.code;
}

async function main() {
  const argv = process.argv.slice(2);
  if (isLegacyInvocation(argv)) return runLegacy(argv);
  const options = parseBenchmarkArgs(argv);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const { suite, manifestPath, suiteRoot } = loadSuite(options.suite);
  validateSuiteFiles(suite, suiteRoot);
  const declaredScenarioCount = suite.scenarios.length;
  if (options.scenarioIds) {
    const byId = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));
    const missing = options.scenarioIds.filter((id) => !byId.has(id));
    if (missing.length) fail(`Unknown benchmark scenario: ${missing.join(", ")}`, 1);
    suite.scenarios = options.scenarioIds.map((id) => byId.get(id));
  }
  options.repeats = options.repeats ?? suite.defaultRepeats;
  options.infrastructureRetries = options.infrastructureRetries ?? (suite.schemaVersion === 2 ? 2 : 0);
  options.retryDelaySeconds = options.retryDelaySeconds ?? (suite.schemaVersion === 2 ? 60 : 0);
  options.timeoutSeconds = options.timeoutSeconds ?? suite.timeoutSeconds;
  if (options.surfaces.includes("codex-cli")) {
    codexModelName(options.model);
    codexThinkingEffort(options.thinking);
  }
  const comparison = comparisonSurfaces(options);
  const piCommand = process.env.PIAGENT_BENCHMARK_PI_COMMAND || "pi";
  const codexCommand = process.env.PIAGENT_BENCHMARK_CODEX_COMMAND || "codex";
  const suiteDigest = suiteTreeDigest(suiteRoot);
  const rootSeed = options.seed ?? crypto.randomBytes(32).toString("hex");
  const rootSeedDigest = crypto.createHash("sha256").update(rootSeed).digest("hex");
  const order = executionOrder(suite, options.repeats, options.surfaces, rootSeed);
  const lifecycles = [...new Set(suite.scenarios.map((scenario) => scenario.lifecycle ?? "steady-state"))];
  const plan = [
    "Piagent automatic benchmark",
    `  platform:  v${packageManifest.version}`,
    `  suite:     ${suite.id} (${suite.scenarios.length}${suite.scenarios.length !== declaredScenarioCount ? `/${declaredScenarioCount}` : ""} scenarios)`,
    `  digest:    ${suiteDigest.slice(0, 16)}`,
    `  surfaces:  ${options.surfaces.join(", ")}`,
    `  compare:   ${benchmarkSurfaceLabel(comparison.candidateSurface)} vs ${benchmarkSurfaceLabel(comparison.baselineSurface)}`,
    `  repeats:   ${options.repeats}`,
    `  retries:   ${options.infrastructureRetries} infrastructure-only · ${options.retryDelaySeconds}s backoff`,
    `  sessions:  ${order.length}`,
    `  model:     ${options.model ?? "Pi default"}`,
    `  thinking:  ${options.thinking ?? "Pi default"}`,
    `  lifecycle: ${lifecycles.join(", ")}`,
    `  variants:  ${suite.scenarios.some((scenario) => scenario.variantGenerator) ? `generated · seed ${rootSeedDigest.slice(0, 16)}` : "static"}`,
    `  ordering:  ${suite.schemaVersion === 2 ? "seeded paired blocks" : "paired alternating"}`,
    `  timeout:   ${options.timeoutSeconds}s per session`,
    "  grading:   hidden verifier + scope + output safety + Pi task evidence"
  ].join("\n");
  const codexPlan = options.surfaces.includes("codex-cli")
    ? `\n  codex:     ${options.codexMode} mode · model ${codexModelName(options.model)} · effort ${codexThinkingEffort(options.thinking)}${options.codexMode === "controlled" ? " · isolated home" : ""}`
    : "";
  if (options.dryRun) {
    process.stdout.write(`${plan}${codexPlan}\n  manifest:  ${manifestPath}\nDRY RUN: no model session started.\n`);
    return;
  }
  const codexRuntime = createCodexRuntime(options);
  try {
  const runtime = await preflight({ piCommand, codexCommand, surfaces: options.surfaces, codexMode: options.codexMode, codexRuntime });
  const source = await sourceIdentity();
  const nativeWarning = options.surfaces.includes("codex-cli") && options.codexMode === "native"
    ? "\nNative Codex mode loads the operator's global AGENTS.md, configuration, rules, hooks, MCP servers, and plugins."
    : "";
  if (!options.yes && !(await confirmPlan(`${plan}${codexPlan}${nativeWarning}\nThis may use paid model quota.`))) {
    process.stdout.write("Benchmark cancelled; no model session started.\n");
    return;
  }

  const runId = createRunId(suite.id);
  const output = options.output ?? path.join(defaultOutputRoot(), runId);
  const runRoot = ensureEmptyOutput(output);
  privateDirectory(path.join(runRoot, "workspaces"));
  const removeSignalHandlers = installSignalForwarding();
  const startedAt = new Date().toISOString();
  const runs = [];
  let fatalRunError;
  const ledgerPath = path.join(runRoot, "runs.jsonl");
  const infrastructureLedgerPath = path.join(runRoot, "infrastructure-attempts.jsonl");
  try {
    for (const [index, item] of order.entries()) {
      if (interruptedSignal) break;
      process.stdout.write(`[${index + 1}/${order.length}] ${item.scenario.id} · ${item.surface} · repeat ${item.repeat}\n`);
      let record;
      const infrastructureFailures = [];
      for (let infrastructureAttempt = 1; infrastructureAttempt <= options.infrastructureRetries + 1; infrastructureAttempt += 1) {
        let attemptError;
        let attemptCodexRuntime = codexRuntime;
        try {
          if (item.surface === "codex-cli") attemptCodexRuntime = createCodexRuntime(options);
          record = await runOne({
            suite,
            suiteRoot,
            ...item,
            infrastructureAttempt,
            runId,
            runRoot,
            options,
            piCommand,
            codexCommand,
            codexDisabledFeatures: runtime.codexDisabledFeatures,
            codexRuntime: attemptCodexRuntime,
            suiteDigest,
            rootSeed
          });
        } catch (error) {
          attemptError = error;
          record = {
            schemaVersion: 1,
            scenarioId: item.scenario.id,
            scenarioTitle: item.scenario.title,
            scenarioKind: item.scenario.kind,
            category: item.scenario.category ?? "unspecified",
            difficulty: item.scenario.difficulty ?? "unspecified",
            profile: item.scenario.profile ?? suite.profile,
            lifecycle: item.scenario.lifecycle ?? "steady-state",
            surface: item.surface,
            repeat: item.repeat,
            infrastructureAttempt,
            abortSuite: true,
            infrastructureFailure: `runner-error:${error.message}`,
            resolved: false,
            failure: `runner-error:${error.message}`,
            grade: { passed: false, score: 0, checks: [] },
            graderIntegrity: { passed: false },
            scope: { passed: false, changedFiles: [], outsideScope: [] },
            outputSafety: { passed: false, forbiddenHits: [] },
            outputEvidence: { passed: false, requiredCount: 0, observedCount: 0, missingHashes: [] },
            workflow: null,
            usage: aggregateSessionUsage([]),
            durationSeconds: 0
          };
        } finally {
          if (attemptCodexRuntime !== codexRuntime) attemptCodexRuntime.cleanup();
        }
        if (!record.abortSuite || interruptedSignal) break;
        const retryAvailable = infrastructureAttempt <= options.infrastructureRetries;
        infrastructureFailures.push({
          attempt: infrastructureAttempt,
          failure: record.infrastructureFailure ?? record.failure,
          agent: record.agent,
          durationSeconds: record.durationSeconds
        });
        fs.appendFileSync(infrastructureLedgerPath, `${JSON.stringify({ ...record, accepted: false, retryAvailable })}\n`, { mode: 0o600 });
        if (!retryAvailable) {
          if (attemptError) fatalRunError = attemptError;
          break;
        }
        process.stdout.write(`           RETRY ${infrastructureAttempt}/${options.infrastructureRetries} (${record.infrastructureFailure ?? record.failure})\n`);
        if (options.retryDelaySeconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.retryDelaySeconds * 1_000));
        }
      }
      record.infrastructureAttempts = record.infrastructureAttempt ?? 1;
      record.infrastructureRetries = Math.max(0, record.infrastructureAttempts - 1);
      record.infrastructureFailures = infrastructureFailures;
      runs.push(record);
      fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      const cost = Number.isFinite(record.usage.cost) ? `$${Number(record.usage.cost).toFixed(6)}` : "cost n/a";
      process.stdout.write(`           ${record.resolved ? "PASS" : `FAIL (${record.failure})`} · ${record.usage.fresh} fresh tok · ${cost}\n`);
      if (record.abortSuite && !fatalRunError) fatalRunError = new Error(record.infrastructureFailure ?? record.failure ?? "agent startup failure");
      if (fatalRunError) break;
    }
  } finally {
    removeSignalHandlers();
  }
  if (interruptedSignal) {
    if (!options.keepWorkspaces) fs.rmSync(path.join(runRoot, "workspaces"), { recursive: true, force: true });
    writePrivate(path.join(runRoot, "interrupted.json"), `${JSON.stringify({ schemaVersion: 1, runId, signal: interruptedSignal, completedRuns: runs.length, expectedRuns: order.length, interruptedAt: new Date().toISOString() }, null, 2)}\n`);
    process.stderr.write(`Benchmark interrupted by ${interruptedSignal}. Partial ledger: ${ledgerPath}\n`);
    process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
    return;
  }
  if (fatalRunError) {
    if (!options.keepWorkspaces) fs.rmSync(path.join(runRoot, "workspaces"), { recursive: true, force: true });
    writePrivate(path.join(runRoot, "aborted.json"), `${JSON.stringify({ schemaVersion: 1, runId, reason: fatalRunError.message, completedRuns: runs.length, expectedRuns: order.length, abortedAt: new Date().toISOString() }, null, 2)}\n`);
    process.stderr.write(`Benchmark aborted after an infrastructure error. Partial ledger: ${ledgerPath}\n`);
    process.exitCode = 1;
    return;
  }
  const report = summarizeBenchmark({
    suite,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    repeats: options.repeats,
    environment: {
      platformVersion: packageManifest.version,
      suiteDigest,
      variantRootSeed: suite.scenarios.some((scenario) => scenario.variantGenerator) ? rootSeed : null,
      variantRootSeedDigest: suite.scenarios.some((scenario) => scenario.variantGenerator) ? rootSeedDigest : null,
      executionOrder: suite.schemaVersion === 2 ? "seeded-paired-block-randomized" : "paired-alternating",
      profile: suite.profile,
      requestedModel: options.model ?? null,
      requestedThinking: options.thinking ?? null,
      treatmentBaseline: lifecycles.length === 1 && lifecycles[0] === "steady-state"
        ? options.surfaces.includes("codex-cli")
          ? "piagent-initialized-and-onboarded; codex-clean-fixture"
          : "initialized-and-onboarded"
        : "scenario-defined-mixed-lifecycle",
      timeoutSeconds: options.timeoutSeconds,
      nodeVersion: process.version,
      piVersion: runtime.piVersion,
      codexVersion: runtime.codexVersion ?? null,
      codexMode: options.surfaces.includes("codex-cli") ? options.codexMode : null,
      codexAuth: runtime.codexAuth ?? null,
      codexIsolation: options.surfaces.includes("codex-cli")
        ? options.codexMode === "controlled" ? "per-session-temporary-home" : "operator-home"
        : null,
      codexCredentialBridge: options.surfaces.includes("codex-cli") ? codexRuntime.credentialBridge : null,
      codexGlobalInstructions: options.surfaces.includes("codex-cli")
        ? options.codexMode === "controlled" ? "excluded" : "operator-home"
        : null,
      codexDisabledFeatures: runtime.codexDisabledFeatures,
      surfaces: options.surfaces,
      scenarioSelection: options.scenarioIds ?? null,
      surfaceModels: options.surfaces.includes("codex-cli") ? {
        piagent: options.model,
        "codex-cli": codexModelName(options.model)
      } : { "raw-pi": options.model ?? null, piagent: options.model ?? null },
      modelParityEvidence: options.surfaces.includes("codex-cli") ? "command-line-pinned" : "session-reported",
      gitVersion: runtime.gitVersion,
      source
    },
    runs,
    ...comparison
  });
  const text = renderBenchmarkText(report);
  writePrivate(path.join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writePrivate(path.join(runRoot, "report.html"), renderBenchmarkHtml(report));
  writePrivate(path.join(runRoot, "summary.txt"), text);
  if (!options.keepWorkspaces) fs.rmSync(path.join(runRoot, "workspaces"), { recursive: true, force: true });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : text);
  process.stdout.write(`Reports: ${runRoot}\n`);
  if (
    report.comparison.qualityGate === false
    || report.comparison.safetyGate === false
    || report.comparison.reliabilityGate === false
    || report.comparison.qualityNonInferior === false
    || report.comparison.workflowGate === false
    || report.comparison.categoryGate === false
    || report.comparison.productionGate?.passed === false
  ) process.exitCode = 1;
  } finally {
    codexRuntime.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exit(error.exitCode ?? 1);
  });
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  aggregateSessionUsage,
  createCodexExecJsonlCollector,
  evaluateWorkflowEvidence
} from "../packages/piagent-core/benchmark/benchmark-core.js";
import { codexExecArgs } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import {
  benchmarkEnvironment,
  benchmarkGitEnvironment,
  codexProcessEnvironment,
  piagentProcessEnvironment
} from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import {
  acceptedTaskStartTraceCount,
  benchmarkOperationalEvidence,
  classifyPreUsageFailure,
  failureReason,
  safeInfrastructureDiagnostic,
  terminalPiSessionError,
  writePrivate,
  writePrivateAtomic
} from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { readContextTelemetry } from "../packages/piagent-core/extensions/context-engine.js";
import { matchesAnyPath } from "../packages/piagent-core/extensions/policy-core.js";
import { listTaskContracts, workingTreeFiles, workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { buildBenchmarkProviderWireEvidence } from "../packages/piagent-core/benchmark/benchmark-provider-wire.js";
import { summarizeSession, walkJsonl } from "./pi-usage-history.mjs";

const coldStartRuntimeManagedPaths = [
  ".pi/project-context.md",
  ".pi/context-index.json",
  ".pi/piagent-state/project-onboarding.json",
  ".pi/piagent-state/context-engine.json"
];

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch { /* Non-POSIX filesystem. */ }
  return target;
}

function privateTemporaryDirectory(prefix) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { fs.chmodSync(target, 0o700); } catch { /* Non-POSIX filesystem. */ }
  return target;
}

function makeFixtureWritable(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      fs.chmodSync(current, stat.mode | 0o700);
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    } else if (stat.isFile()) {
      fs.chmodSync(current, stat.mode | 0o600);
    }
  }
}

function graderEnvironment(scenarioId) {
  const env = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NO_COLOR: "1", PIAGENT_BENCHMARK_SCENARIO: scenarioId };
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeWorkspaceFile(workspace, relativePath) {
  const target = path.resolve(workspace, relativePath);
  if (!inside(workspace, target)) fail(`Benchmark setup file escapes the workspace: ${relativePath}`);
  return target;
}

async function initializeGit(runCommand, gitCommand, workspace, setupFiles) {
  const commands = [
    ["init", "-q"],
    ["config", "user.email", "benchmark@piagent.local"],
    ["config", "user.name", "Piagent Benchmark"],
    ["add", "-A"]
  ];
  for (const args of commands) {
    const result = await runCommand(gitCommand, args, { cwd: workspace, timeoutMs: 30_000, env: benchmarkGitEnvironment() });
    if (result.code !== 0) fail(`Git fixture setup failed: git ${args.join(" ")}`);
  }
  for (const file of Object.keys(setupFiles ?? {})) {
    const result = await runCommand(gitCommand, ["add", "-f", "--", file], { cwd: workspace, timeoutMs: 30_000, env: benchmarkGitEnvironment() });
    if (result.code !== 0) fail(`Git could not track benchmark setup file ${file}`);
  }
  const commit = await runCommand(gitCommand, ["commit", "-qm", "benchmark fixture"], { cwd: workspace, timeoutMs: 30_000, env: benchmarkGitEnvironment() });
  if (commit.code !== 0) fail("Git could not commit the benchmark fixture");
}

function applySetupFiles(workspace, setupFiles) {
  for (const [relativePath, content] of Object.entries(setupFiles ?? {})) {
    const target = safeWorkspaceFile(workspace, relativePath);
    privateDirectory(path.dirname(target));
    writePrivate(target, content);
  }
}

function variantSeed(rootSeed, suiteDigest, scenarioId, repeat) {
  return crypto.createHmac("sha256", rootSeed).update(`${suiteDigest}\0${scenarioId}\0${repeat}`).digest("hex");
}

function generatedStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || !item || item.length > 1_000)) {
    fail(`Benchmark variant ${field} must contain at most 20 non-empty strings of at most 1000 characters`);
  }
  return [...new Set(value)];
}

async function generateVariant({ runCommand, nodeCommand, generator, workspace, seed, scenario, timeoutSeconds }) {
  const temporaryRoot = privateTemporaryDirectory("piagent-benchmark-oracle-input-");
  const oraclePath = path.join(temporaryRoot, "oracle.json");
  try {
    const result = await runCommand(nodeCommand, [generator, workspace, oraclePath, seed, scenario.id], {
      cwd: path.dirname(generator), timeoutMs: Math.min(timeoutSeconds, 120) * 1_000, env: graderEnvironment(scenario.id)
    });
    if (result.timedOut) fail(`Benchmark variant generator timed out for ${scenario.id}`);
    if (result.code !== 0) fail(`Benchmark variant generator failed for ${scenario.id}: ${result.stderr.trim() || result.stdout.trim()}`);
    let oracle;
    try { oracle = JSON.parse(fs.readFileSync(oraclePath, "utf8")); }
    catch (error) { fail(`Benchmark variant generator did not write a valid oracle for ${scenario.id}: ${error.message}`); }
    if (!oracle || typeof oracle !== "object" || Array.isArray(oracle) || oracle.schemaVersion !== 1 || !oracle.graderData || typeof oracle.graderData !== "object" || Array.isArray(oracle.graderData)) {
      fail(`Benchmark variant oracle is invalid for ${scenario.id}`);
    }
    const serialized = JSON.stringify(oracle);
    if (Buffer.byteLength(serialized) > 100_000) fail(`Benchmark variant oracle is too large for ${scenario.id}`);
    return {
      oracleSerialized: `${serialized}\n`,
      oracleDigest: crypto.createHash("sha256").update(serialized).digest("hex"),
      seedDigest: crypto.createHash("sha256").update(seed).digest("hex"),
      requiredOutputSubstrings: generatedStringArray(oracle.requiredOutputSubstrings, "requiredOutputSubstrings"),
      forbiddenOutputSubstrings: generatedStringArray(oracle.forbiddenOutputSubstrings, "forbiddenOutputSubstrings")
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function writableCopyEnvironment(workspace) {
  const systemCopy = ["/bin/cp", "/usr/bin/cp"].find((candidate) => fs.existsSync(candidate));
  if (!systemCopy) fail("Piagent fixture initialization cannot locate the system copy command");
  const shimRoot = privateDirectory(path.join(path.dirname(workspace), "bootstrap-bin"));
  const shim = path.join(shimRoot, "cp");
  fs.writeFileSync(shim, `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const result = spawnSync(process.env.BENCHMARK_SYSTEM_CP, args, { stdio: "inherit" });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
const target = args.at(-1);
if (target && fs.existsSync(target)) {
  const stat = fs.lstatSync(target);
  if (!stat.isSymbolicLink()) fs.chmodSync(target, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
}
`, { mode: 0o700 });
  return benchmarkEnvironment({
    PIAGENT_NO_UPDATE_CHECK: "1",
    BENCHMARK_SYSTEM_CP: systemCopy,
    PATH: `${shimRoot}${path.delimiter}${process.env.PATH ?? ""}`
  });
}

async function initializeTreatment(runCommand, systemCommands, packageRoot, workspace, profile) {
  const result = await runCommand(systemCommands.bash, [
    path.join(packageRoot, "scripts", "init-project.sh"), workspace, "--profile", profile, "--package-source", packageRoot
  ], { cwd: packageRoot, timeoutMs: 60_000, env: writableCopyEnvironment(workspace) });
  if (result.code !== 0) fail(`Piagent fixture initialization failed: ${result.stderr.trim() || result.stdout.trim()}`);
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
    fail(`Piagent benchmark baseline could not read initialized context: ${error.message}`);
  }
  const recordedAt = new Date().toISOString();
  const projectId = typeof profile.projectId === "string" && profile.projectId.trim() ? profile.projectId.trim() : "piagent-benchmark-project";
  const profileMode = typeof profile.mode === "string" && profile.mode.trim() ? profile.mode.trim() : profileName;
  const sourceScope = (scenario.allowedChanges ?? []).join(", ") || "read-only";
  const summary = `Pre-onboarded synthetic benchmark fixture for ${scenario.id}.`;
  fs.writeFileSync(contextPath, [
    "# Project Context", "", "## Status", "", `- Generated: ${recordedAt}`, `- Profile: ${profileMode}`,
    "- Source: deterministic benchmark baseline", "- Verification: use the configured source verifier",
    `- Task scope: ${sourceScope}`, "", "## Project", "",
    "- Small synthetic Node.js fixture used to compare Raw Pi and Piagent.",
    "- Source files and focused tests are authoritative.",
    "- Keep implementation changes within the task scope supplied by the user.", ""
  ].join("\n"));
  const profileNode = `profile:${profileMode}`;
  const contextNode = "context:.pi/project-context.md";
  const index = {
    schemaVersion: 1, projectId, profileMode, source: "onboarding-record", summary, generatedAt: recordedAt, updatedAt: recordedAt,
    policy: { ...(existingIndex.policy ?? {}), ...(profile.contextIndex ?? {}) },
    nodes: [
      { id: profileNode, kind: "profile", label: profileMode, summary: "Active benchmark profile.", path: ".pi/piagent-profile.json", tags: ["profile", "benchmark"], citations: [{ path: ".pi/piagent-profile.json", reason: "Active benchmark profile" }], updatedAt: recordedAt },
      { id: contextNode, kind: "context", label: ".pi/project-context.md", summary, path: ".pi/project-context.md", tags: ["snapshot", "benchmark"], citations: [{ path: "package.json", reason: "Synthetic project manifest" }], updatedAt: recordedAt }
    ],
    edges: [{ from: profileNode, to: contextNode, kind: "documented_by", reason: "Benchmark profile uses the prepared context." }],
    citations: [{ path: "package.json", reason: "Synthetic project manifest" }], warnings: []
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const stateRoot = privateDirectory(path.join(workspace, ".pi", "piagent-state"));
  writePrivate(path.join(stateRoot, "project-onboarding.json"), `${JSON.stringify({
    schemaVersion: 1, projectId, profileMode, contextFile: ".pi/project-context.md", summary, model: "benchmark-setup",
    sourceFiles: [{ path: "package.json", reason: "Synthetic project manifest" }],
    updateTriggers: ["fixture source or benchmark profile changes"],
    notes: "Prepared outside measured model execution so task runs represent steady-state usage.", recordedAt
  }, null, 2)}\n`);
}

async function prepareTreatmentContextEngine(runCommand, nodeCommand, packageRoot, workspace) {
  const result = await runCommand(nodeCommand, [
    path.join(packageRoot, "scripts", "context-engine.mjs"), "rebuild", "--project", workspace, "--json"
  ], { cwd: packageRoot, timeoutMs: 60_000, env: benchmarkEnvironment({ PIAGENT_NO_UPDATE_CHECK: "1" }) });
  if (result.code !== 0) fail(`Piagent benchmark context preparation failed: ${result.stderr.trim() || result.stdout.trim()}`);
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
        for (const value of candidates) if (content.includes(value)) hits.add(value);
      } else if (Array.isArray(content)) {
        for (const block of content) if (block?.type === "text" && typeof block.text === "string") {
          for (const value of candidates) if (block.text.includes(value)) hits.add(value);
        }
      }
    }
  }
  return [...hits];
}

function inspectForbiddenValue(value, candidates, hits) {
  if (typeof value === "string") {
    for (const candidate of candidates) if (value.includes(candidate)) hits.add(candidate);
  } else if (Array.isArray(value)) {
    for (const item of value) inspectForbiddenValue(item, candidates, hits);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) inspectForbiddenValue(item, candidates, hits);
  }
}

function parseGraderResult(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  let value;
  try { value = JSON.parse(lines.at(-1) ?? ""); } catch { fail("Benchmark grader did not return a JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.passed !== "boolean" || !Array.isArray(value.checks)) fail("Benchmark grader result must contain passed and checks");
  for (const check of value.checks) if (!check || typeof check.id !== "string" || typeof check.passed !== "boolean") fail("Benchmark grader returned an invalid check");
  return {
    passed: value.passed,
    score: Number.isFinite(value.score) ? Math.max(0, Math.min(10, value.score)) : value.passed ? 10 : 0,
    checks: value.checks.map((check) => ({ id: check.id, passed: check.passed, detail: typeof check.detail === "string" ? check.detail.slice(0, 500) : undefined }))
  };
}

async function gradeWorkspace(runCommand, nodeCommand, grader, workspace, scenario, timeoutSeconds, oracleSerialized) {
  const temporaryRoot = oracleSerialized ? privateTemporaryDirectory("piagent-benchmark-oracle-grader-") : null;
  try {
    const oraclePath = temporaryRoot ? path.join(temporaryRoot, "oracle.json") : null;
    if (oraclePath) writePrivate(oraclePath, oracleSerialized);
    const result = await runCommand(nodeCommand, oraclePath ? [grader, workspace, oraclePath] : [grader, workspace], {
      cwd: path.dirname(grader), timeoutMs: Math.min(timeoutSeconds, 120) * 1_000, env: graderEnvironment(scenario.id)
    });
    if (result.timedOut) return { passed: false, score: 0, checks: [], error: "grader-timeout" };
    if (result.code !== 0) return { passed: false, score: 0, checks: [], error: `grader-exit-${result.code}` };
    try { return parseGraderResult(result.stdout); } catch (error) { return { passed: false, score: 0, checks: [], error: error.message }; }
  } finally {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function sessionSummaries(sessionDir) {
  return walkJsonl(sessionDir).map((file) => summarizeSession(file, { strictUsage: true })).filter(Boolean);
}

export async function runBenchmarkSession({ packageRoot, runCommand, resolveSuiteEntry, interrupted, persistCompletedRecord, suite, suiteRoot, scenario, surface, repeat, orderIndex, infrastructureAttempt = 1, runId, runRoot, options, piCommand, codexCommand, codexDisabledFeatures, codexRuntime, piRuntimeHome, systemCommands, suiteDigest, configurationDigest, rootSeed }) {
  if (surface !== "codex-cli" && !piRuntimeHome?.path) fail("Pi benchmark session is missing its controlled writable runtime home");
  const attemptSuffix = infrastructureAttempt > 1 ? `-infra-${infrastructureAttempt}` : "";
  const key = `${String(repeat).padStart(2, "0")}-${scenario.id}-${surface}${attemptSuffix}`;
  const workspaceRoot = privateDirectory(path.join(runRoot, "workspaces", key));
  const workspace = path.join(workspaceRoot, "project");
  const sessions = privateDirectory(path.join(workspaceRoot, "sessions"));
  fs.cpSync(resolveSuiteEntry(suiteRoot, scenario.fixture, "fixture"), workspace, { recursive: true, errorOnExist: true });
  makeFixtureWritable(workspace);
  applySetupFiles(workspace, scenario.setupFiles);
  const profile = scenario.profile ?? suite.profile;
  const lifecycle = scenario.lifecycle ?? "steady-state";
  let variant = { oracleSerialized: null, oracleDigest: null, seedDigest: null, requiredOutputSubstrings: [], forbiddenOutputSubstrings: [] };
  if (scenario.variantGenerator) {
    variant = await generateVariant({
      runCommand, nodeCommand: systemCommands.node, generator: resolveSuiteEntry(suiteRoot, scenario.variantGenerator, "variant generator"), workspace,
      seed: variantSeed(rootSeed, suiteDigest, scenario.id, repeat),
      scenario, timeoutSeconds: options.timeoutSeconds
    });
  }
  const fixtureDigest = benchmarkTreeIdentity(workspace, { rejectSymlinks: true }).contentDigest;
  const forbiddenOutputSubstrings = [...new Set([...(scenario.forbiddenOutputSubstrings ?? []), ...variant.forbiddenOutputSubstrings])];
  const requiredOutputSubstrings = [...new Set([...(scenario.requiredOutputSubstrings ?? []), ...variant.requiredOutputSubstrings])];
  if (surface === "piagent") {
    await initializeTreatment(runCommand, systemCommands, packageRoot, workspace, profile);
    if (lifecycle === "steady-state") {
      prepareTreatmentBaseline(workspace, profile, scenario);
      await prepareTreatmentContextEngine(runCommand, systemCommands.node, packageRoot, workspace);
    }
  }
  await initializeGit(runCommand, systemCommands.git, workspace, scenario.setupFiles);
  const prompt = fs.readFileSync(resolveSuiteEntry(suiteRoot, scenario.prompt, "prompt"), "utf8").trim();
  const graderPath = resolveSuiteEntry(suiteRoot, scenario.grader, "grader");
  const sessionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const piArgs = ["--print", "--mode", "json", "--session-dir", sessions, "--session-id", sessionId, "--name", `BENCH ${scenario.id} ${surface} r${repeat}`, "--approve", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-context-files"];
  if (surface === "piagent") {
    const projectInstructions = path.join(workspace, "AGENTS.md");
    if (!fs.existsSync(projectInstructions)) fail("Piagent fixture initialization did not create AGENTS.md");
    piArgs.push("--append-system-prompt", projectInstructions, "--extension", path.join(packageRoot, "packages", "piagent-core", "extensions", "piagent-guard.ts"), "--skill", path.join(packageRoot, "packages", "piagent-core", "skills"));
  }
  if (options.model) piArgs.push("--model", options.model);
  if (options.thinking) piArgs.push("--thinking", options.thinking);
  piArgs.push(prompt);
  const command = surface === "codex-cli" ? codexCommand : piCommand;
  const args = surface === "codex-cli" ? codexExecArgs({ workspace, options, disabledFeatures: codexDisabledFeatures }) : piArgs;
  const codexForbiddenHits = new Set();
  const codexCollector = surface === "codex-cli" ? createCodexExecJsonlCollector({ model: options.model, thinkingLevel: options.thinking, onEvent: (event) => inspectForbiddenValue(event, forbiddenOutputSubstrings, codexForbiddenHits) }) : undefined;
  const environment = {
    PIAGENT_NO_UPDATE_CHECK: "1", PIAGENT_BENCHMARK_RUN_ID: runId, PIAGENT_BENCHMARK_SCENARIO: scenario.id,
    PIAGENT_BENCHMARK_SURFACE: surface, PIAGENT_BENCHMARK_SESSION_ID: sessionId, PIAGENT_BENCHMARK_PROFILE: profile,
    PIAGENT_BENCHMARK_LIFECYCLE: lifecycle, NO_COLOR: "1"
  };
  const inflightPath = path.join(workspaceRoot, "inflight.json");
  writePrivateAtomic(inflightPath, `${JSON.stringify({ schemaVersion: 1, runId, attemptId, orderIndex, scenarioId: scenario.id, surface, repeat, infrastructureAttempt, stage: "provider-may-start", recordedAt: new Date().toISOString() }, null, 2)}\n`);
  const agent = await runCommand(command, args, {
    cwd: workspace, input: surface === "codex-cli" ? prompt : undefined, timeoutMs: options.timeoutSeconds * 1_000,
    forbiddenSubstrings: forbiddenOutputSubstrings, requiredSubstrings: requiredOutputSubstrings,
    onStdoutChunk: codexCollector ? (chunk) => codexCollector.write(chunk) : undefined,
    env: surface === "codex-cli" ? codexProcessEnvironment(codexRuntime, environment) : surface === "piagent" ? piagentProcessEnvironment(options.piagentTreatment, { ...environment, PI_CODING_AGENT_DIR: piRuntimeHome.path }) : benchmarkEnvironment({ ...environment, PI_CODING_AGENT_DIR: piRuntimeHome.path })
  });
  const sessionFiles = surface === "codex-cli" ? [] : walkJsonl(sessions);
  let usage;
  let codexDiagnostics = [];
  if (surface === "codex-cli") {
    try { usage = codexCollector.finish(); }
    catch (error) { if (agent.code === 0 && !agent.timedOut) throw error; usage = aggregateSessionUsage([]); }
    codexDiagnostics = codexCollector.diagnostics();
  } else usage = aggregateSessionUsage(sessionSummaries(sessions));
  const piTerminalError = surface === "codex-cli" ? undefined : terminalPiSessionError(sessionFiles, sessionId);
  const diagnosticInput = codexDiagnostics.length > 0
    ? JSON.stringify(codexDiagnostics)
    : piTerminalError ?? `${agent.stderr ?? ""}\n${agent.stdout ?? ""}`;
  const preUsageFailure = classifyPreUsageFailure(agent, usage, diagnosticInput, { terminalProviderError: Boolean(piTerminalError) });
  writePrivateAtomic(inflightPath, `${JSON.stringify({ schemaVersion: 1, runId, attemptId, orderIndex, scenarioId: scenario.id, surface, repeat, infrastructureAttempt, stage: "provider-returned", usage, recordedAt: new Date().toISOString() }, null, 2)}\n`);
  const forbiddenHits = [...new Set([...(agent.forbiddenHits ?? []), ...(surface === "codex-cli" ? [...codexForbiddenHits] : forbiddenSessionHits(sessionFiles, forbiddenOutputSubstrings))])];
  const requiredHits = new Set(agent.requiredHits ?? []);
  if (surface !== "codex-cli") for (const value of forbiddenSessionHits(sessionFiles, requiredOutputSubstrings)) requiredHits.add(value);
  const missingRequired = requiredOutputSubstrings.filter((value) => !requiredHits.has(value));
  const allChangedFiles = workingTreeFiles(workspace);
  const runtimeManagedChanges = surface === "piagent" && lifecycle === "cold-start" ? allChangedFiles.filter((file) => matchesAnyPath(file, coldStartRuntimeManagedPaths)) : [];
  const runtimeManagedSet = new Set(runtimeManagedChanges);
  const changedFiles = allChangedFiles.filter((file) => !runtimeManagedSet.has(file));
  const telemetryLimit = 50_000;
  const contextTelemetry = surface === "piagent" ? readContextTelemetry(workspace, { limit: telemetryLimit }) : [];
  const providerWireEvidence = surface === "piagent" ? buildBenchmarkProviderWireEvidence({
    events: contextTelemetry,
    requestedModel: options.model,
    requestedThinking: options.thinking,
    telemetryTruncated: contextTelemetry.length >= telemetryLimit
  }) : null;
  let workflow = null;
  if (surface === "piagent" && scenario.kind !== "safety-refusal") {
    const task = listTaskContracts(workspace).find((item) => item.sessionId === sessionId);
    workflow = evaluateWorkflowEvidence(task, changedFiles, usage.toolNames, { scenarioKind: scenario.kind, acceptedTaskStartCount: acceptedTaskStartTraceCount(sessionFiles, sessionId) });
    workflow.operational = benchmarkOperationalEvidence(contextTelemetry);
  }
  const beforeGrade = workingTreeSnapshot(workspace);
  const outsideScope = changedFiles.filter((file) => !matchesAnyPath(file, scenario.allowedChanges));
  const grade = preUsageFailure
    ? { passed: false, score: 0, checks: [], error: preUsageFailure.failure }
    : interrupted()
    ? { passed: false, score: 0, checks: [], error: "interrupted-after-provider-start" }
    : await gradeWorkspace(runCommand, systemCommands.node, graderPath, workspace, scenario, options.timeoutSeconds, variant.oracleSerialized);
  const graderIntegrity = { passed: JSON.stringify(beforeGrade) === JSON.stringify(workingTreeSnapshot(workspace)) };
  const scope = { passed: outsideScope.length === 0, changedFiles, outsideScope, allChangedFiles, runtimeManagedChanges };
  const outputSafety = { passed: forbiddenHits.length === 0, forbiddenHits: forbiddenHits.map((value) => crypto.createHash("sha256").update(value).digest("hex")) };
  const outputEvidence = { passed: missingRequired.length === 0, requiredCount: requiredOutputSubstrings.length, observedCount: requiredOutputSubstrings.length - missingRequired.length, missingHashes: missingRequired.map((value) => crypto.createHash("sha256").update(value).digest("hex")) };
  const resolved = agent.code === 0 && !agent.timedOut && grade.passed && graderIntegrity.passed && scope.passed && outputSafety.passed && outputEvidence.passed;
  const abortSuite = Boolean(preUsageFailure);
  const record = {
    schemaVersion: 1, runId, attemptId, configurationDigest, orderIndex, scenarioId: scenario.id, scenarioTitle: scenario.title, scenarioKind: scenario.kind,
    category: scenario.category ?? "unspecified", difficulty: scenario.difficulty ?? "unspecified", profile, lifecycle,
    surface, repeat, infrastructureAttempt, sessionId, providerSessionId: usage.providerSessionId ?? null, abortSuite,
    infrastructureFailure: preUsageFailure?.failure, infrastructureClass: preUsageFailure?.class,
    infrastructureRetryable: preUsageFailure?.retryable,
    usageStatus: preUsageFailure?.usageStatus ?? "measured",
    infrastructureDiagnostic: abortSuite ? safeInfrastructureDiagnostic(diagnosticInput, [...forbiddenOutputSubstrings, piRuntimeHome?.path].filter(Boolean)) : undefined,
    infrastructureDiagnosticSource: abortSuite ? (codexDiagnostics.length > 0 ? "codex-error-events" : piTerminalError ? "pi-terminal-error-event" : "process-output-tail") : undefined,
    resolved, failure: preUsageFailure?.failure ?? failureReason({ agent, grade, graderIntegrity, outsideScope, forbiddenHits, missingRequired }),
    agent: { exitCode: agent.code, signal: agent.signal, timedOut: agent.timedOut, stdoutHash: agent.stdoutHash ?? crypto.createHash("sha256").update(agent.stdout).digest("hex"), stderrHash: crypto.createHash("sha256").update(agent.stderr ?? "").digest("hex") },
    grade, graderIntegrity, scope, outputSafety, outputEvidence, workflow, providerWireEvidence, usage, durationSeconds: agent.durationSeconds,
    promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
    variant: scenario.variantGenerator ? { generated: true, seedDigest: variant.seedDigest, oracleDigest: variant.oracleDigest, fixtureDigest } : { generated: false, fixtureDigest }
  };
  const workflowFailed = surface === "piagent" && (workflow?.checks ?? []).some((check) => check.passed === false);
  if (!record.abortSuite && !interrupted()) persistCompletedRecord(record);
  return { record, workspaceRoot, key, workflowFailed, inflightPath };
}

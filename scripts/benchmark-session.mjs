import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateSessionUsage, createCodexExecJsonlCollector, evaluateWorkflowEvidence
} from "../packages/piagent-core/benchmark/benchmark-core.js";
import { codexExecArgs } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import { classifyCodexAttemptOutcome } from "../packages/piagent-core/benchmark/benchmark-codex-outcome.js";
import {
  benchmarkEnvironment,
  benchmarkGitEnvironment,
  piagentProcessEnvironment
} from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import {
  acceptedTaskStartTraceEvidence,
  benchmarkCausalContextReceipt,
  benchmarkOperationalEvidence,
  classifyPreUsageFailure,
  failureReason,
  safeInfrastructureDiagnostic,
  terminalPiSessionError,
  writePrivate,
  writePrivateAtomic
} from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { inspectContextTelemetry } from "../packages/piagent-core/extensions/context-engine.js";
import { matchesAnyPath } from "../packages/piagent-core/extensions/policy-core.js";
import { listTaskContracts, workingTreeFiles, workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { buildBenchmarkProviderWireEvidence, freezeBenchmarkWireInvocation, readBenchmarkWireReceipts, validateBenchmarkWireManifest } from "../packages/piagent-core/benchmark/benchmark-provider-wire.js";
import { buildCodexInvocationReceipt, inspectCodexRolloutServiceTierEvidence } from "../packages/piagent-core/benchmark/benchmark-codex-rollout.js";
import { createDeferredBenchmarkTimingCollector } from "../packages/piagent-core/benchmark/benchmark-timing-diagnostics.js";
import { benchmarkReportOutcomeFields } from "../packages/piagent-core/benchmark/benchmark-evaluator-v3.js";
import { createBenchmarkSafetyEvidenceObserver,
  inspectBenchmarkSafetyJsonlFiles } from "../packages/piagent-core/benchmark/benchmark-safety-evidence.js";
import { walkJsonl } from "./pi-usage-history.mjs";
import { inspectBenchmarkSessionDirectory } from "./benchmark-session-usage.mjs";
import { runPiagentWebUiJourney } from "./benchmark-webui-journey.mjs";
import { resolvedJourneyTurns } from "./benchmark-independent-verification.mjs";
import { benchmarkVerificationFailure } from "../packages/piagent-core/benchmark/benchmark-independent-verification-observation.js";
import { BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION, BENCHMARK_SCOPED_SESSION_FACTORY_VERSION,
  BENCHMARK_SCOPED_SESSION_REQUEST_VERSION, controlledCodexEnvironment, isCodexScopedBrokerTurnFactory,
  requireScopedCodexHome,
  runCodexUserJourney } from "./benchmark-codex-journey.mjs";
import { assertBenchmarkSessionProviderBoundary, providerBoundaryFailureDisposition,
  runPostDispatchCheckedCommand } from "./benchmark-session-provider-boundary.mjs";
import { candidateOutcomeFailureReason, persistedJourneyReceipt } from "./benchmark-journey-outcome.mjs";
import { buildProductionV3SessionGraderInput,
  finalizeProductionV3SessionOutcome } from "./benchmark-session-evaluator.mjs";
export { runCodexUserJourney } from "./benchmark-codex-journey.mjs";
export { candidateOutcomeFailureReason, persistedJourneyReceipt } from "./benchmark-journey-outcome.mjs";
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
const scopedHash = /^[a-f0-9]{64}$/;
const scopedId = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
function scopedRequire(value, code) {
  if (!value) throw Object.assign(new Error(code), { brokerCode: code });
}
function scopedExact(value, names, code) {
  scopedRequire(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), code);
}
function frozenScopedTurns(turns) {
  scopedRequire(Array.isArray(turns) && turns.length > 0, "session-boundary-turns");
  return Object.freeze(turns.map(turn => {
    scopedRequire(turn && typeof turn === "object" && typeof turn.id === "string" && scopedId.test(turn.id)
      && typeof turn.message === "string" && turn.message.length > 0 && turn.message.isWellFormed(),
    "session-boundary-turns");
    return Object.freeze({ id: turn.id, message: turn.message, workflow: turn.workflow ?? null,
      reconnectBefore: turn.reconnectBefore === true, receiptUncertain: turn.receiptUncertain === true });
  }));
}
function validScopedPiRouter(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.version === "scoped-pi-operation-router-v1" && value.authority === "none"
    && Array.isArray(value.toolNames) && typeof value.extensionFactory === "function"
    && typeof value.beginOperation === "function" && typeof value.settlementEvidence === "function"
    && typeof value.assertProviderDispatchReady === "function"
    && typeof value.takeFatalProviderBoundaryError === "function"
    && typeof value.assertOwnership === "function" && typeof value.dispose === "function"
    && typeof value.status === "function");
}
/** Resolves the only scoped controls a registered journey may receive. A
 * factory denial happens before the caller records or starts provider work. */
export async function resolveBenchmarkScopedSessionControls({ factory, directCodexScopedBroker,
  directPiScopedBrokerRouter, journeyTurns, runId, suiteId, scenarioId, surface, repeat,
  infrastructureAttempt, configurationSha256, workspace, model, thinking, serviceTier }) {
  if (factory == null) return Object.freeze({ codexScopedBroker: directCodexScopedBroker ?? null,
    piScopedBrokerRouter: directPiScopedBrokerRouter ?? null });
  scopedExact(factory, ["version", "authority", "openSession"], "session-boundary-factory");
  scopedRequire(factory.version === BENCHMARK_SCOPED_SESSION_FACTORY_VERSION && factory.authority === "none"
    && typeof factory.openSession === "function", "session-boundary-factory");
  scopedRequire(directCodexScopedBroker == null && directPiScopedBrokerRouter == null,
    "session-boundary-direct-control-conflict");
  scopedRequire(Array.isArray(journeyTurns) && journeyTurns.length > 0, "session-boundary-journey-required");
  scopedRequire([runId, suiteId, scenarioId].every(value => typeof value === "string" && scopedId.test(value))
    && ["piagent", "codex-cli"].includes(surface) && Number.isSafeInteger(repeat) && repeat >= 1
    && repeat <= 10 && Number.isSafeInteger(infrastructureAttempt) && infrastructureAttempt >= 1
    && infrastructureAttempt <= 3 && scopedHash.test(configurationSha256)
    && typeof model === "string" && model.length > 0 && typeof thinking === "string" && thinking.length > 0
    && (serviceTier === null || typeof serviceTier === "string" && serviceTier.length > 0),
  "session-boundary-request");
  scopedRequire(typeof workspace === "string" && path.isAbsolute(workspace)
    && fs.realpathSync.native(workspace) === workspace, "session-boundary-workspace");
  const request = Object.freeze({ version: BENCHMARK_SCOPED_SESSION_REQUEST_VERSION, authority: "none",
    runId, suiteId, scenarioId, surface, repeat, infrastructureAttempt, configurationSha256, workspace,
    model, thinking, serviceTier, turns: frozenScopedTurns(journeyTurns) });
  const controller = await factory.openSession(request);
  scopedExact(controller, ["version", "authority", "surface", "piScopedBrokerRouter", "codexScopedBroker"],
    "session-boundary-controller");
  scopedRequire(controller.version === BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION
    && controller.authority === "none" && controller.surface === surface, "session-boundary-controller");
  if (surface === "piagent") scopedRequire(controller.codexScopedBroker === null
    && validScopedPiRouter(controller.piScopedBrokerRouter), "session-boundary-pi-controller");
  else scopedRequire(controller.piScopedBrokerRouter === null
    && isCodexScopedBrokerTurnFactory(controller.codexScopedBroker), "session-boundary-codex-controller");
  return Object.freeze({ codexScopedBroker: controller.codexScopedBroker,
    piScopedBrokerRouter: controller.piScopedBrokerRouter });
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
  const parsed = {
    passed: value.passed,
    score: Number.isFinite(value.score) ? Math.max(0, Math.min(10, value.score)) : value.passed ? 10 : 0,
    checks: value.checks.map((check) => ({ id: check.id, passed: check.passed, detail: typeof check.detail === "string" ? check.detail.slice(0, 500) : undefined }))
  };
  for (const field of ["semanticStatus", "gradeStatus", "failureClass"]) {
    if (typeof value[field] === "string") parsed[field] = value[field];
  }
  return parsed;
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

function observedSubstrings(value, candidates) {
  const text = String(value ?? "");
  return candidates.filter((candidate) => text.includes(candidate));
}

async function runBenchmarkSessionInternal({ packageRoot, runCommand, resolveSuiteEntry, interrupted, persistCompletedRecord,
  assertProviderDispatchReady, onProviderAttemptStart = () => {}, onAfterProviderDispatch,
  onProviderAttemptReturned = () => {}, suite, suiteRoot, scenario, surface, repeat, orderIndex, infrastructureAttempt = 1,
  runId, runRoot, options, verificationPlan, providerWirePlan, candidateDigest, piCommand, codexCommand,
  codexDisabledFeatures, codexRuntime, codexScopedBroker, piScopedBrokerRouter, scopedBrokerSessionFactory,
  piRuntimeHome, systemCommands, suiteDigest, configurationDigest, rootSeed,
  piagentWebUiJourney = runPiagentWebUiJourney }, allowInjectedJourney) {
  assertBenchmarkSessionProviderBoundary({ assertProviderDispatchReady, onAfterProviderDispatch, surface, piagentWebUiJourney,
    defaultPiagentWebUiJourney: runPiagentWebUiJourney, allowInjectedJourney });
  if (surface !== "codex-cli" && !piRuntimeHome?.path) fail("Pi benchmark session is missing its controlled writable runtime home");
  const attemptSuffix = infrastructureAttempt > 1 ? `-infra-${infrastructureAttempt}` : "";
  const key = `${String(repeat).padStart(2, "0")}-${scenario.id}-${surface}${attemptSuffix}`;
  const workspaceRoot = privateDirectory(path.join(runRoot, "workspaces", key));
  const workspace = path.join(workspaceRoot, "project");
  const sessions = privateDirectory(path.join(workspaceRoot, "sessions"));
  fs.cpSync(resolveSuiteEntry(suiteRoot, scenario.fixture, "fixture"), workspace, { recursive: true, errorOnExist: true });
  fs.chmodSync(workspace, 0o700);
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
  const registeredInput = verificationPlan?.registeredInput?.(scenario.id) ?? null;
  const prompt = registeredInput?.prompt
    ?? fs.readFileSync(resolveSuiteEntry(suiteRoot, scenario.prompt, "prompt"), "utf8").trim();
  const journeyTurns = registeredInput?.turns
    ?? resolvedJourneyTurns(scenario, suiteRoot, resolveSuiteEntry);
  const scopedSessionControls = await resolveBenchmarkScopedSessionControls({ factory: scopedBrokerSessionFactory,
    directCodexScopedBroker: codexScopedBroker, directPiScopedBrokerRouter: piScopedBrokerRouter,
    journeyTurns, runId, suiteId: verificationPlan?.registeredSuiteId ?? suite.id,
    scenarioId: scenario.id, surface, repeat, infrastructureAttempt,
    configurationSha256: verificationPlan?.measurementConfigurationDigest ?? configurationDigest,
    workspace: fs.realpathSync.native(workspace), model: options.model,
    thinking: options.thinking, serviceTier: options.serviceTier ?? null });
  const effectiveCodexScopedBroker = scopedSessionControls.codexScopedBroker;
  const effectivePiScopedBrokerRouter = scopedSessionControls.piScopedBrokerRouter;
  const independent = verificationPlan?.prepare({ scenarioId: scenario.id, surface, projectRoot: workspace,
    directory: surface === "piagent" ? path.join(privateDirectory(path.join(fs.realpathSync.native(runRoot), "independent-verification")), key) : undefined,
    approved: options.approveVerification });
  const graderPath = resolveSuiteEntry(suiteRoot, scenario.grader, "grader");
  // The journey owns normalization and cleanup. Passing the session custody
  // through unchanged avoids a second preparation pass and lets malformed
  // later-turn custody release every already-materialized turn before admission.
  const codexJourneyScopedBrokers = journeyTurns && surface === "codex-cli"
    ? effectiveCodexScopedBroker : null;
  let sessionId = crypto.randomUUID();
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
  const args = surface === "codex-cli" ? codexExecArgs({
    workspace,
    options,
    disabledFeatures: codexDisabledFeatures,
    scopedBroker: journeyTurns ? undefined : effectiveCodexScopedBroker,
    persistent: options.serviceTier === "fast"
  }) : piArgs;
  const codexForbiddenHits = new Set();
  const safetyObserver = createBenchmarkSafetyEvidenceObserver(scenario.id);
  const codexCollector = surface === "codex-cli" ? createCodexExecJsonlCollector({
    model: options.model,
    thinkingLevel: options.thinking,
    requestedServiceTier: options.serviceTier,
    eventContract: options.codexBaseline === "stock" ? "production-v3" : undefined,
    onEvent: (event) => {
      inspectForbiddenValue(event, forbiddenOutputSubstrings, codexForbiddenHits);
      safetyObserver.observe(event);
    }
  }) : undefined;
  const timingCollector = createDeferredBenchmarkTimingCollector({ surface });
  const environment = {
    PIAGENT_NO_UPDATE_CHECK: "1", PIAGENT_BENCHMARK_RUN_ID: runId, PIAGENT_BENCHMARK_SCENARIO: scenario.id,
    PIAGENT_BENCHMARK_SURFACE: surface, PIAGENT_BENCHMARK_SESSION_ID: sessionId, PIAGENT_BENCHMARK_PROFILE: profile,
    PIAGENT_BENCHMARK_LIFECYCLE: lifecycle,
    PIAGENT_FAST_MODE: options.serviceTier === "fast" ? "1" : "0",
    NO_COLOR: "1"
  };
  const inflightPath = path.join(workspaceRoot, "inflight.json");
  const attemptIdentity = { attemptId, orderIndex, scenarioId: scenario.id, surface, repeat, infrastructureAttempt };
  let providerDispatchAdmitted = false;
  const admitProviderDispatch = () => {
    if (providerDispatchAdmitted) return;
    writePrivateAtomic(inflightPath, `${JSON.stringify({ schemaVersion: 1, runId, ...attemptIdentity, stage: "provider-may-start", recordedAt: new Date().toISOString() }, null, 2)}\n`);
    onProviderAttemptStart(attemptIdentity);
    providerDispatchAdmitted = true;
  };
  if (providerWirePlan && (surface !== "piagent" || !journeyTurns)) fail("Provider-wire manifest requires the qualified Piagent WebUI route");
  if (providerWirePlan) validateBenchmarkWireManifest(providerWirePlan.manifest, { template: true,
    model: options.model, thinking: options.thinking, requestedTier: options.serviceTier });
  const wireInvocation = providerWirePlan ? freezeBenchmarkWireInvocation({ plan: providerWirePlan, workingDirectory: workspace, platformRoot: packageRoot, custodyRoot: fs.realpathSync.native(runRoot), configurationDigest, candidateDigest }) : null;
  const processEnvironment = surface === "codex-cli"
    ? controlledCodexEnvironment(codexRuntime, environment)
    : surface === "piagent"
      ? piagentProcessEnvironment(options.piagentTreatment, { ...environment, ...independent?.environment, ...wireInvocation?.environment, PI_CODING_AGENT_DIR: piRuntimeHome.path })
      : benchmarkEnvironment({ ...environment, PI_CODING_AGENT_DIR: piRuntimeHome.path });
  if (surface === "codex-cli" && !journeyTurns) {
    requireScopedCodexHome(effectiveCodexScopedBroker, codexRuntime, processEnvironment);
  }
  let agent;
  let usageOverride;
  let journeyReceipt = null;
  let codexDiagnostics = [];
  let codexContractFailure = null;
  let fatalProviderBoundaryError = null;
  let fatalProviderBoundaryPhase = null;
  try {
    if (journeyTurns && surface === "piagent") {
      agent = await piagentWebUiJourney({
        packageRoot,
        agentDir: piRuntimeHome.path,
        workspace,
        model: options.model,
        thinking: options.thinking,
        turns: journeyTurns,
        expectedTerminalSettlement: scenario.userJourney.expectedTerminalSettlement,
        timeoutMs: options.timeoutSeconds * 1_000,
        environment: processEnvironment,
        onBeforeProviderDispatch: assertProviderDispatchReady,
        onBeforeFirstProviderDispatch: admitProviderDispatch,
        ...(effectivePiScopedBrokerRouter ? { scopedBrokerRouter: effectivePiScopedBrokerRouter } : {})
      });
      if (!providerDispatchAdmitted) fail("Piagent journey ended before its first provider dispatch");
      journeyReceipt = agent.journeyReceipt;
      fatalProviderBoundaryError = agent.fatalProviderBoundaryError ?? null;
      fatalProviderBoundaryPhase = agent.fatalProviderBoundaryPhase ?? null;
      agent.forbiddenHits = observedSubstrings(agent.stdout, forbiddenOutputSubstrings);
      agent.requiredHits = observedSubstrings(agent.stdout, requiredOutputSubstrings);
    } else if (journeyTurns && surface === "codex-cli") {
      const journey = await runCodexUserJourney({
        runCommand,
        codexCommand,
        workspace,
        turns: journeyTurns,
        options,
        disabledFeatures: codexDisabledFeatures, codexRuntime,
        scopedBroker: codexJourneyScopedBrokers,
        environment: processEnvironment,
        timeoutMs: options.timeoutSeconds * 1_000,
        forbiddenOutputSubstrings,
        onBeforeProviderDispatch: assertProviderDispatchReady,
        onAfterProviderDispatch,
        onBeforeFirstProviderDispatch: admitProviderDispatch
      });
      if (!providerDispatchAdmitted) fail("Codex journey ended before its first provider dispatch");
      agent = journey.agent;
      usageOverride = journey.usage;
      codexDiagnostics = journey.diagnostics;
      journeyReceipt = journey.journeyReceipt;
      fatalProviderBoundaryError = journey.fatalProviderBoundaryError;
      fatalProviderBoundaryPhase = journey.fatalProviderBoundaryPhase;
      agent.requiredHits = observedSubstrings(agent.stdout, requiredOutputSubstrings);
    } else {
      await assertProviderDispatchReady(Object.freeze({ turnIndex: 1, turnId: null }));
      admitProviderDispatch();
      agent = await runPostDispatchCheckedCommand({ runCommand, command, args, workspace, prompt, surface,
        timeoutMs: options.timeoutSeconds * 1_000, forbiddenOutputSubstrings, requiredOutputSubstrings,
        processEnvironment, timingCollector, codexCollector, onAfterProviderDispatch });
    }
  } catch (error) {
    timingCollector.discard();
    throw error;
  }
  const timingDiagnostics = timingCollector.finish(agent.durationSeconds);
  const sessionRoot = journeyTurns && surface === "piagent" ? path.join(piRuntimeHome.path, "sessions") : sessions;
  const sessionFiles = surface === "codex-cli" ? [] : walkJsonl(sessionRoot);
  const safetyEvidence = surface === "codex-cli" ? safetyObserver.summary()
    : inspectBenchmarkSafetyJsonlFiles(sessionFiles, scenario.id);
  const piSessionInspection = surface === "codex-cli"
    ? { summaries: [], diagnostics: [] }
    : inspectBenchmarkSessionDirectory(sessionRoot);
  const piSummaries = piSessionInspection.summaries;
  if (journeyTurns && surface === "piagent") {
    const main = piSummaries.find((summary) => !summary.isSubagent && summary.cwd === workspace)
      ?? piSummaries.find((summary) => !summary.isSubagent);
    if (main?.id) sessionId = main.id;
  }
  let usage;
  if (usageOverride) usage = usageOverride;
  else if (surface === "codex-cli") {
    try {
      usage = codexCollector.finish({ processExitCode: agent.code });
    } catch (error) {
      if (error?.code === "BENCHMARK_CODEX_EVENT_CONTRACT_INVALID") {
        codexContractFailure = error;
        usage = error.usage ?? { ...aggregateSessionUsage([]), codexEventSummary: error.codexEventSummary,
          codexEventOutcome: error.codexEventOutcome };
      } else if (agent.code === 0 && !agent.timedOut) throw error;
      else usage = aggregateSessionUsage([]);
    }
    usage = { ...usage, codexInvocationReceipts: [buildCodexInvocationReceipt({
      command, args, runtime: codexRuntime, environment: processEnvironment, workspace, requestedModel: options.model,
      requestedThinking: options.thinking, requestedServiceTier: options.serviceTier, resumed: false, result: agent, usage })] };
    codexDiagnostics = codexCollector.diagnostics();
    if (codexContractFailure) codexDiagnostics.push({ type: "codex-event-contract", message: codexContractFailure.codexEventOutcome?.reasonCodes?.join(",") ?? "invalid" });
  } else usage = aggregateSessionUsage(piSummaries);
  if (surface === "codex-cli" && options.serviceTier !== undefined) {
    usage = {
      ...usage,
      serviceTierEvidence: inspectCodexRolloutServiceTierEvidence({
        codexHome: codexRuntime?.mode === "controlled" ? codexRuntime.home : null, threadId: usage.providerSessionId, workspace,
        requestedModel: options.model, requestedThinking: options.thinking, requestedServiceTier: options.serviceTier,
        providerStartedAttempts: usage.execution?.providerStartedAttempts, invocationReceipts: usage.codexInvocationReceipts
      })
    };
  }
  const piTerminalError = surface === "codex-cli" ? undefined : terminalPiSessionError(sessionFiles, sessionId);
  const diagnosticInput = surface === "codex-cli"
    ? [JSON.stringify(codexDiagnostics), agent.stderr].filter(Boolean).join("\n")
    : [piTerminalError, ...piSessionInspection.diagnostics, agent.stderr, agent.stdout].filter(Boolean).join("\n");
  const providerBoundaryFailure = providerBoundaryFailureDisposition(
    fatalProviderBoundaryError, fatalProviderBoundaryPhase);
  const preUsageFailure = providerBoundaryFailure
    ?? classifyPreUsageFailure(agent, usage, diagnosticInput, { terminalProviderError: Boolean(piTerminalError),
      usageParsingError: piSessionInspection.diagnostics.length > 0, candidateOutcome: agent.candidateOutcome ?? null });
  const candidateOutcomeFailure = candidateOutcomeFailureReason(agent.candidateOutcome);
  writePrivateAtomic(inflightPath, `${JSON.stringify({
    schemaVersion: 1,
    runId,
    ...attemptIdentity,
    stage: "provider-returned",
    usage,
    usageStatus: preUsageFailure?.usageStatus ?? "measured",
    infrastructureFailure: preUsageFailure?.failure ?? null,
    infrastructureClass: preUsageFailure?.class ?? null,
    infrastructureRetryable: preUsageFailure?.retryable === true,
    durationSeconds: agent.durationSeconds,
    recordedAt: new Date().toISOString()
  }, null, 2)}\n`);
  onProviderAttemptReturned({ ...attemptIdentity, usage, usageStatus: preUsageFailure?.usageStatus ?? "measured" });
  const forbiddenHits = [...new Set([...(agent.forbiddenHits ?? []), ...(surface === "codex-cli" ? [...codexForbiddenHits] : forbiddenSessionHits(sessionFiles, forbiddenOutputSubstrings))])];
  const requiredHits = new Set(agent.requiredHits ?? []);
  if (surface !== "codex-cli") for (const value of forbiddenSessionHits(sessionFiles, requiredOutputSubstrings)) requiredHits.add(value);
  const missingRequired = requiredOutputSubstrings.filter((value) => !requiredHits.has(value));
  const allChangedFiles = workingTreeFiles(workspace);
  const runtimeManagedChanges = surface === "piagent" && lifecycle === "cold-start" ? allChangedFiles.filter((file) => matchesAnyPath(file, coldStartRuntimeManagedPaths)) : [];
  const runtimeManagedSet = new Set(runtimeManagedChanges);
  const changedFiles = allChangedFiles.filter((file) => !runtimeManagedSet.has(file));
  const telemetryLimit = 50_000;
  const contextTelemetryInspection = surface === "piagent"
    ? inspectContextTelemetry(workspace, { limit: telemetryLimit })
    : { records: [], exists: false, integrityFailures: 0, recoverableTailBytes: 0, inputTruncated: false };
  const contextTelemetry = contextTelemetryInspection.records;
  const causalContextReceipt = benchmarkCausalContextReceipt(contextTelemetry, {
    surface,
    sessionId,
    criterionExpected: scenario.kind !== "safety-refusal",
    telemetryExists: contextTelemetryInspection.exists,
    telemetryTruncated: contextTelemetryInspection.inputTruncated,
    telemetryIntegrityFailures: contextTelemetryInspection.integrityFailures,
    recoverableTailBytes: contextTelemetryInspection.recoverableTailBytes
  });
  const providerWireEvidence = surface === "piagent" ? buildBenchmarkProviderWireEvidence({
    events: contextTelemetry,
    requestedModel: options.model,
    requestedThinking: options.thinking,
    telemetryTruncated: contextTelemetryInspection.inputTruncated
  }) : null;
  let workflow = null;
  const tasks = surface === "piagent" ? listTaskContracts(workspace).filter((item) => item.sessionId === sessionId) : [];
  const independentVerification = independent?.observe(tasks);
  const independentFailure = benchmarkVerificationFailure(independentVerification);
  if (surface === "piagent" && scenario.kind !== "safety-refusal") {
    workflow = evaluateWorkflowEvidence(tasks, changedFiles, usage.toolNames, {
      scenarioKind: scenario.kind,
      taskStartEvidence: acceptedTaskStartTraceEvidence(sessionFiles, sessionId),
      expectedTurnCount: journeyTurns?.length ?? 1
    });
    workflow.operational = benchmarkOperationalEvidence(contextTelemetry);
  }
  const beforeGrade = workingTreeSnapshot(workspace);
  const outsideScope = changedFiles.filter((file) => !matchesAnyPath(file, scenario.allowedChanges));
  const graderInput = suite.id === "production-v3" && !preUsageFailure && !interrupted()
    ? buildProductionV3SessionGraderInput({ suiteId: suite.id, oracleSerialized: variant.oracleSerialized,
      scenario, surface, sessionId, agent, usage, journeyReceipt, changedFiles, outsideScope, missingRequired,
      forbiddenHits, safetyEvidence })
    : null;
  const graderInputSerialized = graderInput ? `${JSON.stringify(graderInput)}\n` : variant.oracleSerialized;
  const grade = preUsageFailure
    ? { passed: false, score: 0, checks: [], error: preUsageFailure.failure }
    : interrupted()
    ? { passed: false, score: 0, checks: [], error: "interrupted-after-provider-start" }
    : await gradeWorkspace(runCommand, systemCommands.node, graderPath, workspace, scenario, options.timeoutSeconds, graderInputSerialized);
  const graderIntegrity = { passed: JSON.stringify(beforeGrade) === JSON.stringify(workingTreeSnapshot(workspace)) };
  const scope = { passed: outsideScope.length === 0, changedFiles, outsideScope, allChangedFiles, runtimeManagedChanges };
  const codexOutcomeFailure = surface === "codex-cli" ? classifyCodexAttemptOutcome({ eventOutcome: usage.codexEventOutcome, scenarioKind: scenario.kind, changedFiles }) : null;
  const outputSafety = { passed: forbiddenHits.length === 0, forbiddenHits: forbiddenHits.map((value) => crypto.createHash("sha256").update(value).digest("hex")) };
  const outputEvidence = { passed: missingRequired.length === 0, requiredCount: requiredOutputSubstrings.length, observedCount: requiredOutputSubstrings.length - missingRequired.length, missingHashes: missingRequired.map((value) => crypto.createHash("sha256").update(value).digest("hex")) };
  const outcome = graderInput ? finalizeProductionV3SessionOutcome({ attemptId, input: graderInput, grade, usage }) : null;
  const outcomeFields = outcome ? benchmarkReportOutcomeFields(outcome) : null;
  const resolved = agent.code === 0 && !agent.timedOut && grade.passed && graderIntegrity.passed && scope.passed && outputSafety.passed && outputEvidence.passed && !independentFailure && !codexOutcomeFailure;
  const abortSuite = Boolean(preUsageFailure);
  const promptBinding = journeyTurns
    ? JSON.stringify(journeyTurns.map((turn) => ({ id: turn.id, message: turn.message, reconnectBefore: turn.reconnectBefore,
      receiptUncertain: turn.receiptUncertain, workflow: turn.workflow ?? null })))
    : prompt;
  const record = {
    schemaVersion: 1, runId, attemptId, configurationDigest, orderIndex, scenarioId: scenario.id, scenarioTitle: scenario.title, scenarioKind: scenario.kind,
    category: scenario.category ?? "unspecified", difficulty: scenario.difficulty ?? "unspecified", profile, lifecycle,
    ...(scenario.familyId ? { familyId: scenario.familyId, variantId: scenario.variantId, variantRole: scenario.variantRole } : {}),
    ingress: journeyTurns ? (surface === "piagent" ? "webui-gateway" : surface === "codex-cli" ? "codex-cli-resume" : "terminal") : "terminal",
    surface, repeat, infrastructureAttempt, sessionId, providerSessionId: usage.providerSessionId ?? null, abortSuite,
    infrastructureFailure: preUsageFailure?.failure, infrastructureClass: preUsageFailure?.class,
    infrastructureRetryable: preUsageFailure?.retryable,
    usageStatus: preUsageFailure?.usageStatus ?? "measured",
    ...(fatalProviderBoundaryPhase ? { providerBoundaryPhase: fatalProviderBoundaryPhase } : {}),
    infrastructureDiagnostic: abortSuite ? safeInfrastructureDiagnostic(diagnosticInput, [...forbiddenOutputSubstrings, piRuntimeHome?.path].filter(Boolean)) : undefined,
    infrastructureDiagnosticSource: abortSuite ? (codexDiagnostics.length > 0 ? "codex-error-events" : piTerminalError ? "pi-terminal-error-event" : "process-output-tail") : undefined,
    resolved, failure: preUsageFailure?.failure ?? codexOutcomeFailure?.reason ?? candidateOutcomeFailure ?? independentFailure
      ?? failureReason({ agent, grade, graderIntegrity, outsideScope, forbiddenHits, missingRequired }),
    agent: { exitCode: agent.code, signal: agent.signal, timedOut: agent.timedOut, stdoutHash: agent.stdoutHash ?? crypto.createHash("sha256").update(agent.stdout).digest("hex"), stderrHash: crypto.createHash("sha256").update(agent.stderr ?? "").digest("hex") },
    grade, graderIntegrity, scope, outputSafety, outputEvidence, workflow, providerWireEvidence, causalContextReceipt, usage,
    ...(outcome ? { outcome, ...outcomeFields } : {}),
    ...(wireInvocation ? { providerWirePhaseEvidence: readBenchmarkWireReceipts(wireInvocation) } : {}),
    ...(independentVerification ? { independentVerification } : {}),
    durationSeconds: agent.durationSeconds, timingDiagnostics,
    promptHash: crypto.createHash("sha256").update(promptBinding).digest("hex"),
    ...(journeyReceipt ? { journeyReceipt: persistedJourneyReceipt(journeyReceipt) } : {}),
    variant: scenario.variantGenerator ? { generated: true, seedDigest: variant.seedDigest, oracleDigest: variant.oracleDigest, fixtureDigest } : { generated: false, fixtureDigest }
  };
  const workflowFailed = surface === "piagent" && (workflow?.checks ?? []).some((check) => check.passed === false);
  if (!record.abortSuite && !interrupted()) persistCompletedRecord(record);
  return { record, workspaceRoot, key, workflowFailed, inflightPath,
    ...(fatalProviderBoundaryError ? { fatalProviderBoundaryError, fatalProviderBoundaryPhase } : {}) };
}

export function runBenchmarkSession(input) { return runBenchmarkSessionInternal(input, false); }

/** Explicit non-production seam for deterministic offline plumbing tests. It cannot be selected
 * through the benchmark CLI or the production runner. */
export function runOfflineBenchmarkSession(input) {
  if (typeof input?.piagentWebUiJourney !== "function") fail("Offline benchmark session requires an explicit fake Piagent WebUI journey");
  return runBenchmarkSessionInternal(input, true);
}

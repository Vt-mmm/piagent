#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  aggregateSessionUsage, benchmarkSurfaceLabel,
  renderBenchmarkHtml,
  renderBenchmarkText,
  summarizeBenchmark
} from "../packages/piagent-core/benchmark/benchmark-core.js";
import { benchmarkUsage, parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { codexModelName, codexThinkingEffort } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import { benchmarkTrustChecklist } from "../packages/piagent-core/benchmark/benchmark-matrix.js";
import { applyBenchmarkClaimRestrictions } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { benchmarkEnvironment, benchmarkEnvironmentPolicy, comparisonSurfaces, createCodexRuntime, piagentTreatment } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { assertBenchmarkPiCredentialReady, assertBenchmarkPiCredentialWritebackPolicy, cleanupBenchmarkPiRuntimeHome, createBenchmarkPiRuntimeHome, resetBenchmarkPiRuntimeEphemeralState, withBenchmarkPiCredentialWriteback } from "../packages/piagent-core/benchmark/benchmark-pi-home.js";
import { benchmarkPreflight, benchmarkPreflightReceipt } from "../packages/piagent-core/benchmark/benchmark-preflight.js";
import {
  cleanupUnretainedWorkspaces,
  appendPrivateJsonl,
  createBenchmarkCandidateGuard,
  loadReplayFailurePlan,
  retainWorkspaceForensics,
  safeInfrastructureDiagnostic,
  writeBenchmarkAbort,
  writeBenchmarkRunManifest,
  writePrivate,
  writePrivateAtomic
} from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { benchmarkBootstrapCandidateIndex, benchmarkBootstrapMetadata } from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { createBenchmarkExecutionGuard } from "../packages/piagent-core/benchmark/benchmark-execution-guard.js";
import { benchmarkCommandIdentity } from "../packages/piagent-core/benchmark/benchmark-runtime-identity.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { completedBenchmarkRecord, expectedBenchmarkRecord } from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { pairedOutcomeFloorStop } from "../packages/piagent-core/benchmark/benchmark-stop-policy.js";
import { loadBenchmarkAssuranceEvidence, loadBenchmarkSuite, resolveBenchmarkSuiteEntry, validateBenchmarkSuiteFiles } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { appendBenchmarkLedger, assertBenchmarkLedgerBinding, benchmarkLedgerCheckpoint, emptyBenchmarkLedgerBinding, inspectBenchmarkLedger, validateBenchmarkLedgerPrefix } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { createBenchmarkProcessController } from "../packages/piagent-core/benchmark/benchmark-process.js";
import {
  clearRecoveredBenchmarkAttempts,
  persistUnacceptedBenchmarkAttempt,
  promoteMeasuredBenchmarkRecord,
  recoverOrphanedBenchmarkAttempts,
  recoverPendingBenchmarkRecord,
  stageMeasuredBenchmarkRecord
} from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { runBenchmarkSession } from "./benchmark-session.mjs";
export { parseBenchmarkArgs };
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const bootstrapMetadata = benchmarkBootstrapMetadata();
const bootstrapCandidateIndex = bootstrapMetadata ? benchmarkBootstrapCandidateIndex(bootstrapMetadata) : undefined;
let interruptedSignal;
const processController = createBenchmarkProcessController(() => Boolean(interruptedSignal));
const runCommand = processController.run;
function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function installSignalForwarding() {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (interruptedSignal) return;
      interruptedSignal = signal;
      processController.terminateAll(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function isLegacyInvocation(argv) {
  return argv.includes("--record") || argv.includes("--init");
}

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch { /* Non-POSIX filesystem. */ }
  return target;
}

function defaultOutputRoot() {
  if (bootstrapMetadata?.defaultOutputRoot) return bootstrapMetadata.defaultOutputRoot;
  const agentRoot = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentRoot, "benchmarks", "piagent");
}

function createRunId(suiteId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${suiteId}-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function ensureEmptyOutput(target) {
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) fail(`Output directory is not empty: ${target}`, 1);
  return privateDirectory(target);
}

function benchmarkRunKey(value) {
  return `${value.scenarioId ?? value.scenario?.id}\0${value.surface}\0${value.repeat}`;
}

function samePairedBlock(left, right) {
  return left?.scenario?.id === right?.scenario?.id && left?.repeat === right?.repeat;
}

function pairedChunk(order, maximum) {
  if (maximum === undefined || order.length <= maximum) return order;
  let length = maximum;
  while (length > 0 && samePairedBlock(order[length - 1], order[length])) length -= 1;
  if (length === 0) fail(`--max-sessions ${maximum} would split the first paired benchmark block; increase the chunk size`, 1);
  return order.slice(0, length);
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label} ${file}: ${error.message}`, 1);
  }
}

function resolveResumeRunRoot(input) {
  const target = path.resolve(input);
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return target;
    if (stat.isFile()) return path.dirname(target);
  } catch (error) {
    fail(`Cannot resume benchmark; path does not exist: ${target}`, 1);
  }
  fail(`Cannot resume benchmark; path is not a file or directory: ${target}`, 1);
}

function loadResumeState(input) {
  const runRoot = resolveResumeRunRoot(input);
  const releaseRunLock = acquireBenchmarkRunLock(runRoot, "resume-pending");
  try {
    const manifestPath = path.join(runRoot, "run-manifest.json");
    if (!fs.existsSync(manifestPath)) {
      fail(`Cannot resume ${runRoot}: missing run-manifest.json. This run was created before resume metadata was written, so its root seed cannot be recovered safely. Start a new run with --max-sessions or --max-runtime-minutes to make it resumable.`, 1);
    }
    const manifest = readJsonFile(manifestPath, "benchmark resume manifest");
    if (fs.existsSync(path.join(runRoot, "stopped.json"))) fail(`Cannot resume ${runRoot}: the paired release stop is terminal`, 1);
    if (manifest?.schemaVersion !== 1 || typeof manifest.runId !== "string") {
      fail(`Cannot resume ${runRoot}: run-manifest.json has an unsupported shape`, 1);
    }
    const ledger = benchmarkLedgerCheckpoint(
      manifest.ledger,
      inspectBenchmarkLedger(path.join(runRoot, "runs.jsonl")),
      "benchmark resume ledger"
    );
    const pendingPath = path.join(runRoot, "pending-record.json");
    const pendingRecord = fs.existsSync(pendingPath) ? readJsonFile(pendingPath, "benchmark pending record") : null;
    const measuredPath = path.join(runRoot, "measured-record-ready.json");
    const measuredReady = fs.existsSync(measuredPath) ? readJsonFile(measuredPath, "measured benchmark record") : null;
    return {
      runRoot,
      manifest,
      completedRuns: ledger.records,
      ledgerBinding: ledger.binding,
      recoveredLedgerSuffix: ledger.recovered,
      pendingRecord,
      measuredReady,
      releaseRunLock
    };
  } catch (error) {
    releaseRunLock();
    throw error;
  }
}

function sameStringList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
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

async function runLegacy(argv) {
  const result = await runCommand("bash", [path.join(packageRoot, "scripts", "quality-benchmark.sh"), ...argv], { cwd: process.cwd(), inherit: true });
  process.exitCode = result.code;
}

async function main() {
  const argv = process.argv.slice(2);
  if (isLegacyInvocation(argv)) return runLegacy(argv);
  if (bootstrapMetadata && fs.realpathSync(packageRoot) !== fs.realpathSync(bootstrapMetadata.snapshotRoot)) {
    fail("Benchmark core must execute from the immutable candidate snapshot", 1);
  }
  const options = parseBenchmarkArgs(argv);
  if (bootstrapMetadata?.replay?.snapshot) options.replayFailures = bootstrapMetadata.replay.snapshot;
  if (options.resume && options.replayFailures) fail("--resume cannot be combined with --replay-failures", 1);
  if (options.resume && options.output) fail("--resume uses the original report directory; do not pass --output", 1);
  const resumeState = options.resume ? loadResumeState(options.resume) : undefined;
  let releaseRunLock = resumeState?.releaseRunLock;
  let codexRuntime;
  let piRuntimeHome;
  let preservePiRuntime = false;
  try {
  if (resumeState) {
    const manifest = resumeState.manifest;
    options.suite = manifest.suite?.source ?? manifest.suite?.manifestPath ?? manifest.suite?.id ?? options.suite;
    options.surfaces = manifest.surfaces;
    options.model = manifest.model ?? undefined;
    options.thinking = manifest.thinking ?? undefined;
    options.codexMode = manifest.codexMode ?? "controlled";
    options.piagentTreatment = manifest.piagentTreatment ?? "release-defaults";
    options.allowPiAuthWriteback = manifest.allowPiAuthWriteback === true;
    options.seed = manifest.rootSeed;
    options.repeats = manifest.repeats;
    options.scenarioIds = manifest.scenarioIds ?? undefined;
    options.timeoutSeconds = manifest.timeoutSeconds;
    options.infrastructureRetries = manifest.infrastructureRetries;
    options.retryDelaySeconds = manifest.retryDelaySeconds;
    options.output = resumeState.runRoot;
  }
  if (options.replayFailures) {
    const replay = loadReplayFailurePlan(options.replayFailures);
    if (bootstrapMetadata?.replay && replay.source.reportDigest !== bootstrapMetadata.replay.digest) fail("Frozen replay report digest does not match bootstrap metadata", 1);
    options.suite = replay.suite;
    options.seed = replay.seed;
    options.surfaces = replay.surfaces;
    options.model = options.model ?? replay.model;
    options.thinking = options.thinking ?? replay.thinking;
    options.piagentTreatment = replay.piagentTreatment ?? options.piagentTreatment;
    options.replayRuns = replay.replayRuns;
    options.replaySource = {
      ...replay.source,
      reportPath: bootstrapMetadata?.replay?.origin ?? replay.source.reportPath,
      reportDigest: bootstrapMetadata?.replay?.digest ?? replay.source.reportDigest,
      evidenceComplete: bootstrapMetadata?.replay?.evidenceComplete ?? replay.source.evidenceComplete
    };
  }
  if (bootstrapMetadata?.suite?.snapshot) options.suite = bootstrapMetadata.suite.snapshot;
  if (options.help) {
    process.stdout.write(benchmarkUsage);
    return;
  }
  piagentTreatment(options.piagentTreatment);
  const { suite, manifestPath, suiteRoot } = loadBenchmarkSuite(options.suite, packageRoot);
  validateBenchmarkSuiteFiles(suite, suiteRoot);
  const assuranceEvidence = loadBenchmarkAssuranceEvidence(suite, suiteRoot);
  const declaredScenarioCount = suite.scenarios.length;
  if (options.scenarioIds) {
    const byId = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));
    const missing = options.scenarioIds.filter((id) => !byId.has(id));
    if (missing.length) fail(`Unknown benchmark scenario: ${missing.join(", ")}`, 1);
    suite.scenarios = options.scenarioIds.map((id) => byId.get(id));
  }
  if (options.replayRuns) {
    const byId = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));
    const missing = [...new Set(options.replayRuns.map((run) => run.scenarioId).filter((id) => !byId.has(id)))];
    if (missing.length) fail(`Replay report references unknown scenario: ${missing.join(", ")}`, 1);
    suite.scenarios = [...new Set(options.replayRuns.map((run) => run.scenarioId))].map((id) => byId.get(id));
  }
  options.repeats = options.repeats ?? suite.defaultRepeats;
  options.infrastructureRetries = options.infrastructureRetries ?? (suite.schemaVersion === 2 ? 2 : 0);
  options.retryDelaySeconds = options.retryDelaySeconds ?? (suite.schemaVersion === 2 ? 60 : 0);
  options.timeoutSeconds = options.timeoutSeconds ?? suite.timeoutSeconds;
  if (options.stopAfterFailedPair && !Number.isFinite(suite.releaseGate?.minimumOutcomeScoreExclusive)) fail("--stop-after-failed-pair requires a suite outcome floor", 1);
  if (options.surfaces.includes("codex-cli")) {
    codexModelName(options.model);
    codexThinkingEffort(options.thinking);
  }
  const comparison = comparisonSurfaces(options);
  let piCommand = process.env.PIAGENT_BENCHMARK_PI_COMMAND || "pi";
  let codexCommand = process.env.PIAGENT_BENCHMARK_CODEX_COMMAND || "codex";
  const suiteIdentity = benchmarkTreeIdentity(suiteRoot, { rejectSymlinks: true });
  const suiteDigest = suiteIdentity.contentDigest;
  const rootSeed = options.seed ?? crypto.randomBytes(32).toString("hex");
  const rootSeedDigest = crypto.createHash("sha256").update(rootSeed).digest("hex");
  const candidateGuard = createBenchmarkCandidateGuard(packageRoot, resumeState?.manifest.candidateProvenance, {
    immutableSnapshot: Boolean(bootstrapMetadata),
    observedProvenance: bootstrapMetadata?.candidateProvenance,
    snapshotIndex: bootstrapCandidateIndex
  });
  candidateGuard.freeze();
  const fullOrder = options.replayRuns
    ? options.replayRuns.map((run) => ({
        scenario: suite.scenarios.find((scenario) => scenario.id === run.scenarioId),
        surface: run.surface,
        repeat: run.repeat
      }))
    : executionOrder(suite, options.repeats, options.surfaces, rootSeed);
  if (resumeState) {
    const manifest = resumeState.manifest;
    if (manifest.suiteDigest !== suiteDigest) fail("Cannot resume benchmark: suite files changed since the original run", 1);
    if (manifest.rootSeed !== rootSeed) fail("Cannot resume benchmark: root seed mismatch", 1);
    if (manifest.repeats !== options.repeats) fail("Cannot resume benchmark: repeat count mismatch", 1);
    if (!sameStringList(manifest.surfaces, options.surfaces)) fail("Cannot resume benchmark: surface list mismatch", 1);
    if (JSON.stringify(manifest.runtimeDependencies ?? null) !== JSON.stringify(bootstrapMetadata?.runtimeDependencies ?? null)) {
      fail("Cannot resume benchmark: runtime dependency identity changed since the original run", 1);
    }
    const manifestOrder = manifest.order ?? [];
    const currentOrder = fullOrder.map((item) => ({
      scenarioId: item.scenario.id,
      surface: item.surface,
      repeat: item.repeat
    }));
    if (JSON.stringify(manifestOrder) !== JSON.stringify(currentOrder)) {
      fail("Cannot resume benchmark: execution order changed since the original run", 1);
    }
    try {
      const recovered = recoverPendingBenchmarkRecord({
        runRoot: resumeState.runRoot, manifest, ledgerBinding: resumeState.ledgerBinding,
        completedRuns: resumeState.completedRuns, pending: resumeState.pendingRecord, measuredReady: resumeState.measuredReady, fullOrder, suite
      });
      resumeState.ledgerBinding = recovered.ledgerBinding;
      resumeState.completedRuns = recovered.completedRuns;
      resumeState.completedKeys = recovered.completedKeys;
      if (resumeState.recoveredLedgerSuffix && !recovered.recoveredPending) {
        manifest.ledger = resumeState.ledgerBinding;
        writeBenchmarkRunManifest(resumeState.runRoot, manifest);
      }
      resumeState.recoveredLedgerSuffix = false;
    } catch (error) {
      writeBenchmarkAbort(resumeState.runRoot, {
        runId: manifest.runId,
        completedRuns: resumeState.completedRuns.length,
        expectedRuns: fullOrder.length
      }, error, { ledger: resumeState.ledgerBinding, provenanceStamp: candidateGuard.stamp("resume-ledger") });
      throw error;
    }
    const provenanceError = candidateGuard.check("resume");
    if (provenanceError) {
      writeBenchmarkAbort(resumeState.runRoot, { runId: manifest.runId, completedRuns: resumeState.completedRuns.length, expectedRuns: fullOrder.length }, provenanceError, {
        ledger: resumeState.ledgerBinding,
        provenanceStamp: candidateGuard.stamp("resume")
      });
      throw provenanceError;
    }
  }
  const pendingOrder = resumeState
    ? fullOrder.filter((item) => !resumeState.completedKeys.has(benchmarkRunKey(item)))
    : fullOrder;
  let recoveredAttemptsByKey = new Map();
  const order = pairedChunk(pendingOrder, options.maxSessions);
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
    `  sessions:  ${fullOrder.length}`,
    ...(resumeState ? [`  completed: ${resumeState.completedRuns.length}`, `  remaining: ${pendingOrder.length}`] : []),
    ...(options.maxSessions !== undefined ? [`  chunk:    up to ${order.length}/${pendingOrder.length} remaining sessions`] : []),
    ...(options.maxRuntimeMinutes !== undefined ? [`  budget:   ${options.maxRuntimeMinutes} minute runtime chunk`] : []),
    ...(options.stopAfterFailedPair ? ["  stop:     terminal after a completed pair falls below the outcome floor"] : []),
    `  model:     ${options.model ?? "Pi default"}`,
    `  thinking:  ${options.thinking ?? "Pi default"}`,
    `  treatment: ${options.piagentTreatment}`,
    `  lifecycle: ${lifecycles.join(", ")}`,
    ...(options.replaySource ? [`  replay:    ${options.replaySource.runId ?? "prior-report"} · ${options.replayRuns.length} sessions`] : []),
    ...(resumeState ? [`  resume:    ${resumeState.manifest.runId}`] : []),
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
  if (!bootstrapMetadata) fail("Modern billed benchmarks must start through scripts/benchmark-runner.mjs so execution assets are frozen", 1);
  if (options.replayFailures && bootstrapMetadata.replay?.evidenceComplete !== true) {
    fail("Billed replay requires the original run-manifest.json and runs.jsonl beside the source report", 1);
  }
  const runtimeCommands = {
    pi: benchmarkCommandIdentity(piCommand, { cwd: bootstrapMetadata?.originalCwd ?? process.cwd() }),
    codex: options.surfaces.includes("codex-cli")
      ? benchmarkCommandIdentity(codexCommand, { cwd: bootstrapMetadata?.originalCwd ?? process.cwd() })
      : null,
    node: benchmarkCommandIdentity(process.execPath),
    git: benchmarkCommandIdentity("git"),
    bash: benchmarkCommandIdentity("bash")
  };
  const environmentPolicy = benchmarkEnvironmentPolicy();
  const configuration = {
    schemaVersion: 1,
    source: bootstrapMetadata.sourceIdentity,
    candidateDigest: candidateGuard.provenance.contentDigest,
    suiteDigest,
    runtimeDependencyDigest: bootstrapMetadata.runtimeDependencies?.digest ?? null,
    runtimeCommands,
    environmentPolicy,
    piAgentHome: bootstrapMetadata.piAgentHome.identity,
    codexCredential: bootstrapMetadata.codexCredential?.identity ?? null,
    rootSeedDigest,
    surfaces: options.surfaces,
    model: options.model ?? null,
    thinking: options.thinking ?? null,
    codexMode: options.codexMode,
    piagentTreatment: options.piagentTreatment,
    allowPiAuthWriteback: options.allowPiAuthWriteback,
    piCredentialVaultId: bootstrapMetadata.piAgentHome.vaultId,
    timeoutSeconds: options.timeoutSeconds,
    infrastructureRetries: options.infrastructureRetries,
    retryDelaySeconds: options.retryDelaySeconds,
    stopAfterFailedPair: options.stopAfterFailedPair,
    order: fullOrder.map((item) => ({ scenarioId: item.scenario.id, surface: item.surface, repeat: item.repeat }))
  };
  const configurationDigest = crypto.createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  piCommand = runtimeCommands.pi.resolvedPath;
  if (runtimeCommands.codex) codexCommand = runtimeCommands.codex.resolvedPath;
  if (resumeState && JSON.stringify(resumeState.manifest.runtimeCommands ?? null) !== JSON.stringify(runtimeCommands)) {
    fail("Cannot resume benchmark: provider command identity changed since the original run", 1);
  }
  if (resumeState && resumeState.manifest.configurationDigest !== configurationDigest) {
    fail("Cannot resume benchmark: measurement configuration changed since the original run", 1);
  }
  if (resumeState) {
    recoveredAttemptsByKey = recoverOrphanedBenchmarkAttempts({
      runRoot: resumeState.runRoot,
      manifest: resumeState.manifest,
      fullOrder,
      completedKeys: resumeState.completedKeys
    });
  }
  const executionGuard = createBenchmarkExecutionGuard({
    candidateGuard,
    suiteRoot,
    suiteIdentity: bootstrapMetadata?.suite?.identity ?? suiteIdentity,
    piAgentHome: bootstrapMetadata?.piAgentHome,
    codexCredential: bootstrapMetadata?.codexCredential,
    runtimeDependencies: bootstrapMetadata?.runtimeDependencies,
    commands: runtimeCommands
  });
  assertBenchmarkPiCredentialReady(bootstrapMetadata.piAgentHome.credentialReadiness, options.model);
  assertBenchmarkPiCredentialWritebackPolicy(bootstrapMetadata.piAgentHome);
  piRuntimeHome = createBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome);
  const preflightAssetError = executionGuard.check("before-preflight", [piRuntimeHome]);
  if (preflightAssetError) throw preflightAssetError;
  codexRuntime = createCodexRuntime(options);
  let runtime;
  try { runtime = await withBenchmarkPiCredentialWriteback(bootstrapMetadata.piAgentHome, piRuntimeHome, () => benchmarkPreflight({ runCommand, packageRoot, piCommand, piEnvironment: benchmarkEnvironment({ PI_CODING_AGENT_DIR: piRuntimeHome.path }), codexCommand, gitCommand: runtimeCommands.git.resolvedPath, surfaces: options.surfaces, codexMode: options.codexMode, codexRuntime })); }
  catch (error) { preservePiRuntime ||= error.code === "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED"; throw error; }
  const postPreflightAssetError = executionGuard.check("after-preflight", [piRuntimeHome]);
  if (postPreflightAssetError) throw postPreflightAssetError;
  resetBenchmarkPiRuntimeEphemeralState(piRuntimeHome);
  const source = bootstrapMetadata?.sourceIdentity;
  if (!source) fail("Modern benchmark is missing its frozen Git source identity", 1);
  if (options.preflightOnly) {
    const receipt = benchmarkPreflightReceipt({ packageVersion: packageManifest.version, source, candidateProvenance: candidateGuard.report(), suite, suiteDigest, runtimeDependencies: bootstrapMetadata.runtimeDependencies, runtimeCommands, environmentPolicy, configurationDigest, rootSeedDigest, options, runtime });
    process.stdout.write(options.json ? `${JSON.stringify(receipt, null, 2)}\n` : `${plan}${codexPlan}\nPREFLIGHT READY: no model session started.\n${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  const nativeWarning = options.surfaces.includes("codex-cli") && options.codexMode === "native"
    ? "\nNative Codex mode loads the operator's global AGENTS.md, configuration, rules, hooks, MCP servers, and plugins."
    : "";
  if (options.yes) {
    process.stdout.write(`${plan}${codexPlan}${nativeWarning}\n`);
  } else {
    if (!(await confirmPlan(`${plan}${codexPlan}${nativeWarning}\nThis may use paid model quota.`))) {
      process.stdout.write("Benchmark cancelled; no model session started.\n");
      return;
    }
  }
  candidateGuard.freeze();
  const runId = resumeState?.manifest.runId ?? createRunId(suite.id);
  const output = options.output ?? path.join(defaultOutputRoot(), runId);
  const runRoot = resumeState ? privateDirectory(output) : ensureEmptyOutput(output);
  releaseRunLock ??= acquireBenchmarkRunLock(runRoot, runId);
  privateDirectory(path.join(runRoot, "workspaces"));
  const removeSignalHandlers = installSignalForwarding();
  const startedAt = resumeState?.manifest.startedAt ?? new Date().toISOString();
  const runs = resumeState ? [...resumeState.completedRuns] : [];
  let ledgerBinding = resumeState?.ledgerBinding ?? emptyBenchmarkLedgerBinding();
  let fatalRunError, fatalExecutionReceipt, terminalStop;
  let pauseReason;
  const ledgerPath = path.join(runRoot, "runs.jsonl");
  const infrastructureLedgerPath = path.join(runRoot, "infrastructure-attempts.jsonl");
  const manifest = resumeState?.manifest ?? {
    schemaVersion: 1,
    runId,
    startedAt,
    suite: {
      id: suite.id,
      source: bootstrapMetadata?.suite?.origin ?? manifestPath,
      manifestPath: bootstrapMetadata?.suite?.snapshot ? bootstrapMetadata.suite.origin : null
    },
    suiteDigest,
    suiteIdentity,
    candidateProvenance: candidateGuard.provenance,
    runtimeDependencies: bootstrapMetadata?.runtimeDependencies ?? null,
    runtimeCommands,
    configurationDigest,
    environmentPolicy,
    piAgentHome: {
      copied: bootstrapMetadata.piAgentHome.copied,
      globalInstructions: bootstrapMetadata.piAgentHome.globalInstructions,
      authRefreshPolicy: bootstrapMetadata.piAgentHome.authRefreshPolicy,
      isolation: "immutable-private-seed; run-scoped-writable-home; ephemeral-state-reset-between-sessions",
      identity: bootstrapMetadata.piAgentHome.identity
    },
    sourceIdentity: source,
    ledger: ledgerBinding,
    packageVersion: packageManifest.version,
    rootSeed,
    rootSeedDigest,
    piCredentialVaultId: bootstrapMetadata.piAgentHome.vaultId,
    surfaces: options.surfaces,
    repeats: options.repeats,
    model: options.model ?? null,
    thinking: options.thinking ?? null,
    codexMode: options.codexMode,
    piagentTreatment: options.piagentTreatment,
    allowPiAuthWriteback: options.allowPiAuthWriteback,
    timeoutSeconds: options.timeoutSeconds,
    infrastructureRetries: options.infrastructureRetries,
    retryDelaySeconds: options.retryDelaySeconds,
    stopAfterFailedPair: options.stopAfterFailedPair,
    scenarioIds: options.scenarioIds ?? null,
    order: fullOrder.map((item) => ({
      scenarioId: item.scenario.id,
      surface: item.surface,
      repeat: item.repeat
    }))
  };
  writeBenchmarkRunManifest(runRoot, manifest);
  const fullIndexByKey = new Map(fullOrder.map((item, index) => [benchmarkRunKey(item), index + 1]));
  const wallStartedAt = Date.now();
  const runtimeDeadline = options.maxRuntimeMinutes === undefined
    ? undefined
    : wallStartedAt + options.maxRuntimeMinutes * 60_000;
  let newRuns = 0;
  try {
    for (const [index, item] of order.entries()) {
      if (interruptedSignal) break;
      if (runtimeDeadline !== undefined && newRuns > 0 && !samePairedBlock(order[index - 1], item) && Date.now() >= runtimeDeadline) {
        pauseReason = `max-runtime-minutes:${options.maxRuntimeMinutes}`;
        break;
      }
      const completedBefore = runs.filter(completedBenchmarkRecord).length;
      const remainingIncludingThis = fullOrder.length - completedBefore;
      const averageMs = newRuns > 0 ? (Date.now() - wallStartedAt) / newRuns : undefined;
      const eta = averageMs === undefined ? "" : ` · ETA ${formatDuration(averageMs * remainingIncludingThis)}`;
      const fullIndex = fullIndexByKey.get(benchmarkRunKey(item)) ?? index + 1;
      process.stdout.write(`[${fullIndex}/${fullOrder.length}] ${item.scenario.id} · ${item.surface} · repeat ${item.repeat}/${options.repeats} · remaining ${remainingIncludingThis} · elapsed ${formatDuration(Date.now() - wallStartedAt)}${eta}\n`);
      let record;
      let sessionEvidence;
      const infrastructureFailures = [...(recoveredAttemptsByKey.get(benchmarkRunKey(item)) ?? [])];
      const firstInfrastructureAttempt = infrastructureFailures.reduce((maximum, attempt) => Math.max(maximum, attempt.attempt ?? 0), 0) + 1;
      if (firstInfrastructureAttempt > options.infrastructureRetries + 1) {
        fatalRunError = new Error(`No infrastructure retry remains after recovering an interrupted provider attempt for ${item.scenario.id}/${item.surface}/r${item.repeat}`);
        break;
      }
      for (let infrastructureAttempt = firstInfrastructureAttempt; infrastructureAttempt <= options.infrastructureRetries + 1; infrastructureAttempt += 1) {
        record = undefined;
        fatalRunError = executionGuard.check(`before-session:${item.scenario.id}:${item.surface}:r${item.repeat}:attempt${infrastructureAttempt}`, [piRuntimeHome]);
        if (fatalRunError) break;
        let attemptError;
        let attemptCodexRuntime = codexRuntime;
        try {
          if (item.surface === "codex-cli") attemptCodexRuntime = createCodexRuntime(options);
          sessionEvidence = await withBenchmarkPiCredentialWriteback(bootstrapMetadata.piAgentHome, piRuntimeHome, () => runBenchmarkSession({
            packageRoot,
            runCommand,
            resolveSuiteEntry: resolveBenchmarkSuiteEntry,
            interrupted: () => Boolean(interruptedSignal),
            suite,
            suiteRoot,
            ...item,
            orderIndex: fullIndex,
            infrastructureAttempt,
            runId,
            runRoot,
            options,
            piCommand,
            codexCommand,
            codexDisabledFeatures: runtime.codexDisabledFeatures,
            codexRuntime: attemptCodexRuntime,
            piRuntimeHome,
            systemCommands: {
              node: runtimeCommands.node.resolvedPath,
              git: runtimeCommands.git.resolvedPath,
              bash: runtimeCommands.bash.resolvedPath
            },
            suiteDigest,
            configurationDigest,
            persistCompletedRecord: (candidate) => stageMeasuredBenchmarkRecord({ runRoot, manifest, ledgerBinding, record: candidate, infrastructureFailures, index: fullIndex - 1, expected: item, runId, suite, configurationDigest, runs }),
            rootSeed
          }));
          record = sessionEvidence.record;
        } catch (error) {
          preservePiRuntime ||= error.code === "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED";
          attemptError = error;
          const safeError = safeInfrastructureDiagnostic(error.message, [piRuntimeHome?.path, bootstrapMetadata.piAgentHome.configRoot, bootstrapMetadata.piAgentHome.runtimeParent].filter(Boolean));
          record = {
            schemaVersion: 1,
            runId,
            orderIndex: fullIndex,
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
            infrastructureFailure: `runner-error:${safeError}`,
            resolved: false,
            failure: `runner-error:${safeError}`,
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
        const guardStage = `after-session:${item.scenario.id}:${item.surface}:r${item.repeat}:attempt${infrastructureAttempt}`;
        const postSessionReceipt = executionGuard.receipt(guardStage, [piRuntimeHome]);
        const postSessionGuard = postSessionReceipt.stamp;
        const assetError = postSessionReceipt.error;
        if (!assetError && item.surface !== "codex-cli") resetBenchmarkPiRuntimeEphemeralState(piRuntimeHome);
        if (!interruptedSignal) {
          if (assetError) {
            fatalExecutionReceipt = postSessionReceipt;
            if (sessionEvidence) retainWorkspaceForensics({ runRoot, workspaceRoot: sessionEvidence.workspaceRoot, key: sessionEvidence.key, record });
            if (record) {
              persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record, reason: "execution-asset-mismatch-after-provider-attempt", forceTokenUnavailable: true });
              fs.rmSync(path.join(runRoot, "pending-record.json"), { force: true });
              fs.rmSync(path.join(runRoot, "measured-record-ready.json"), { force: true });
              appendPrivateJsonl(infrastructureLedgerPath, { ...record, accepted: false, contaminated: true, executionAsset: assetError.executionAsset ?? { reason: assetError.message } });
              if (sessionEvidence) fs.rmSync(sessionEvidence.inflightPath, { force: true });
            }
            fatalRunError = assetError;
            break;
          }
          if (sessionEvidence && !record.abortSuite) promoteMeasuredBenchmarkRecord({ runRoot, ledgerBinding, record, postSessionGuard });
        }
        if (interruptedSignal && sessionEvidence) {
          retainWorkspaceForensics({ runRoot, workspaceRoot: sessionEvidence.workspaceRoot, key: sessionEvidence.key, record });
          persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record, reason: "interrupted-provider-attempt-not-accepted-as-a-measured-outcome" });
          fs.rmSync(path.join(runRoot, "pending-record.json"), { force: true });
          fs.rmSync(path.join(runRoot, "measured-record-ready.json"), { force: true });
          appendPrivateJsonl(infrastructureLedgerPath, { ...record, accepted: false, interrupted: true });
          fs.rmSync(sessionEvidence.inflightPath, { force: true });
        }
        if (!record.abortSuite || interruptedSignal) break;
        const retryAvailable = record.infrastructureRetryable === true && infrastructureAttempt <= options.infrastructureRetries;
        infrastructureFailures.push({
          attempt: infrastructureAttempt,
          failure: record.infrastructureFailure ?? record.failure,
          class: record.infrastructureClass ?? "infrastructure",
          agent: record.agent,
          usage: record.usage,
          usageStatus: record.usageStatus,
          durationSeconds: record.durationSeconds
        });
        if (record.usageStatus === "unknown-after-provider-start") {
          manifest.unknownCostAttempts = Number(manifest.unknownCostAttempts ?? 0) + 1;
          manifest.tokenClaimsUnavailableReason = "one-or-more-provider-attempts-have-unknown-usage";
        }
        // A runner error before runBenchmarkSession creates its durable in-flight
        // marker is positively pre-provider. Post-provider throws leave that
        // marker behind and terminal recovery persists them fail-closed.
        if (record.attemptId) persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record });
        appendPrivateJsonl(infrastructureLedgerPath, { ...record, accepted: false, retryAvailable });
        if (sessionEvidence) {
          retainWorkspaceForensics({ runRoot, workspaceRoot: sessionEvidence.workspaceRoot, key: sessionEvidence.key, record });
          fs.rmSync(sessionEvidence.inflightPath, { force: true });
        }
        if (!retryAvailable) {
          if (attemptError) fatalRunError = new Error(record.infrastructureFailure ?? "benchmark runner infrastructure error");
          break;
        }
        process.stdout.write(`           RETRY ${infrastructureAttempt}/${options.infrastructureRetries} (${record.infrastructureFailure ?? record.failure})\n`);
        if (options.retryDelaySeconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.retryDelaySeconds * 1_000));
        }
      }
      if (interruptedSignal) break;
      if (fatalRunError) break;
      if (record.abortSuite) {
        if (!fatalRunError) fatalRunError = new Error(record.infrastructureFailure ?? record.failure ?? "agent startup failure");
        break;
      }
      const retainWorkspace = options.keepWorkspaces || !record.resolved || sessionEvidence?.workflowFailed;
      if (retainWorkspace && sessionEvidence) {
        retainWorkspaceForensics({ runRoot, workspaceRoot: sessionEvidence.workspaceRoot, key: sessionEvidence.key, record });
      }
      runs.push(record);
      newRuns += 1;
      const pendingRecordPath = path.join(runRoot, "pending-record.json");
      ledgerBinding = appendBenchmarkLedger(ledgerPath, record, ledgerBinding);
      manifest.ledger = ledgerBinding;
      clearRecoveredBenchmarkAttempts(manifest, record);
      writeBenchmarkRunManifest(runRoot, manifest);
      fs.rmSync(pendingRecordPath, { force: true });
      if (sessionEvidence) {
        fs.rmSync(sessionEvidence.inflightPath, { force: true });
        if (!retainWorkspace) fs.rmSync(sessionEvidence.workspaceRoot, { recursive: true, force: true });
      }
      const cost = Number.isFinite(record.usage.cost) ? `$${Number(record.usage.cost).toFixed(6)}` : "cost n/a";
      const completedAfter = runs.filter(completedBenchmarkRecord).length;
      const remainingAfter = Math.max(0, fullOrder.length - completedAfter);
      const averageAfterMs = (Date.now() - wallStartedAt) / Math.max(1, newRuns);
      process.stdout.write(`           ${record.resolved ? "PASS" : `FAIL (${record.failure})`} · ${record.usage.fresh} fresh tok · ${cost} · run ${formatDuration(Number(record.durationSeconds ?? 0) * 1_000)} · remaining ${remainingAfter} · ETA ${formatDuration(averageAfterMs * remainingAfter)}\n`);
      terminalStop = pairedOutcomeFloorStop({ enabled: options.stopAfterFailedPair, suite, runs, current: item, next: order[index + 1] });
      if (terminalStop) break;
      if (fatalRunError) break;
    }
    if (!pauseReason && options.maxSessions !== undefined && pendingOrder.length > order.length) {
      pauseReason = `max-sessions:${options.maxSessions}`;
    }
  } finally {
    removeSignalHandlers();
  }
  try {
    const finalLedger = inspectBenchmarkLedger(ledgerPath);
    assertBenchmarkLedgerBinding(ledgerBinding, finalLedger.binding, "benchmark terminal ledger");
    validateBenchmarkLedgerPrefix(finalLedger.records, fullOrder, (record, index, expected) => expectedBenchmarkRecord(record, index, expected, runId, suite, configurationDigest));
  } catch (error) {
    fatalRunError ??= error;
  }
  let finalizationReceipt;
  if (!interruptedSignal && !fatalRunError) {
    finalizationReceipt = executionGuard.receipt("finalization", [piRuntimeHome]);
    fatalRunError = finalizationReceipt.error;
  }
  if (interruptedSignal) {
    const provenanceStamp = executionGuard.stamp("interrupted", [piRuntimeHome]);
    piRuntimeHome = undefined;
    recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys: new Set(runs.map(benchmarkRunKey)) });
    cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
    writePrivateAtomic(path.join(runRoot, "interrupted.json"), `${JSON.stringify({ schemaVersion: 1, runId, signal: interruptedSignal, completedRuns: runs.filter(completedBenchmarkRecord).length, expectedRuns: fullOrder.length, interruptedAt: new Date().toISOString(), resumeCommand: `piagent-benchmark --resume ${runRoot} --yes`, ledger: ledgerBinding, provenanceStamp }, null, 2)}\n`);
    process.stderr.write(`Benchmark interrupted by ${interruptedSignal}. Partial ledger: ${ledgerPath}\n`);
    process.exitCode = interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGHUP" ? 129 : 143;
    return;
  }
  if (fatalRunError) {
    const provenanceStamp = finalizationReceipt?.stamp ?? fatalExecutionReceipt?.stamp ?? executionGuard.stamp("fatal", piRuntimeHome ? [piRuntimeHome] : []);
    if (!preservePiRuntime) cleanupBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome, piRuntimeHome);
    piRuntimeHome = undefined;
    recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys: new Set(runs.map(benchmarkRunKey)) });
    cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
    const provenanceFailure = writeBenchmarkAbort(runRoot, { runId, completedRuns: runs.filter(completedBenchmarkRecord).length, expectedRuns: fullOrder.length }, fatalRunError, {
      ledger: ledgerBinding,
      provenanceStamp
    });
    process.stderr.write(provenanceFailure
      ? `Benchmark aborted because candidate provenance changed. Partial ledger: ${ledgerPath}\n`
      : `Benchmark aborted after an infrastructure error. Partial ledger: ${ledgerPath}\n`);
    process.exitCode = 1;
    return;
  }
  if (terminalStop) {
    cleanupBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome, piRuntimeHome); piRuntimeHome = undefined;
    cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
    for (const marker of ["paused.json", "interrupted.json", "aborted.json"]) fs.rmSync(path.join(runRoot, marker), { force: true });
    writePrivateAtomic(path.join(runRoot, "stopped.json"), `${JSON.stringify({ ...terminalStop, runId, completedRuns: runs.filter(completedBenchmarkRecord).length, expectedRuns: fullOrder.length, stoppedAt: new Date().toISOString(), resumeAllowed: false, ledger: ledgerBinding, provenanceStamp: finalizationReceipt.stamp }, null, 2)}\n`);
    process.stderr.write(`Benchmark terminal-stopped after paired outcome-floor failure. Partial ledger: ${ledgerPath}\n`);
    process.exitCode = 1;
    return;
  }
  const completedRuns = runs.filter(completedBenchmarkRecord);
  if (completedRuns.length < fullOrder.length) {
    piRuntimeHome = undefined;
    cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
    const paused = {
      schemaVersion: 1,
      runId,
      reason: pauseReason ?? "partial-run",
      completedRuns: completedRuns.length,
      expectedRuns: fullOrder.length,
      remainingRuns: fullOrder.length - completedRuns.length,
      pausedAt: new Date().toISOString(),
      resumeCommand: `piagent-benchmark --resume ${runRoot} --yes`,
      ledger: ledgerBinding,
      provenanceStamp: executionGuard.stamp("paused")
    };
    writePrivateAtomic(path.join(runRoot, "paused.json"), `${JSON.stringify(paused, null, 2)}\n`);
    process.stdout.write(`Benchmark paused after ${completedRuns.length}/${fullOrder.length} completed sessions (${paused.reason}).\nResume: ${paused.resumeCommand}\nPartial ledger: ${ledgerPath}\n`);
    return;
  }
  cleanupBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome, piRuntimeHome); piRuntimeHome = undefined;
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
      replaySource: options.replaySource ?? null,
      profile: suite.profile,
      requestedModel: options.model ?? null,
      requestedThinking: options.thinking ?? null,
      piagentTreatment: piagentTreatment(options.piagentTreatment),
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
      piGlobalInstructions: "excluded",
      piAgentHome: manifest.piAgentHome,
      usageIntegrity: manifest.tokenClaimsUnavailableReason ?? "measured",
      codexDisabledFeatures: runtime.codexDisabledFeatures,
      surfaces: options.surfaces,
      scenarioSelection: options.scenarioIds ?? null,
      surfaceModels: options.surfaces.includes("codex-cli") ? {
        piagent: options.model,
        "codex-cli": codexModelName(options.model)
      } : { "raw-pi": options.model ?? null, piagent: options.model ?? null },
      modelParityEvidence: options.surfaces.includes("codex-cli") ? "command-line-pinned" : "session-reported",
      gitVersion: runtime.gitVersion,
      source,
      candidateProvenance: candidateGuard.report(),
      suiteIdentity,
      runtimeCommands,
      configurationDigest,
      environmentPolicy,
      runtimeDependencies: bootstrapMetadata?.runtimeDependencies ?? null,
      assuranceEvidence
    },
    runs: completedRuns,
    ...comparison
  });
  report.ledger = ledgerBinding;
  applyBenchmarkClaimRestrictions(report, { tokenReason: manifest.tokenClaimsUnavailableReason, replaySource: options.replaySource, codexMode: options.codexMode, surfaces: options.surfaces });
  report.trustChecklist = benchmarkTrustChecklist(report);
  const text = renderBenchmarkText(report);
  const reportLedger = inspectBenchmarkLedger(ledgerPath);
  assertBenchmarkLedgerBinding(ledgerBinding, reportLedger.binding, "benchmark report ledger");
  validateBenchmarkLedgerPrefix(reportLedger.records, fullOrder, (record, index, expected) => expectedBenchmarkRecord(record, index, expected, runId, suite, configurationDigest));
  writePrivate(path.join(runRoot, "report.html"), renderBenchmarkHtml(report));
  writePrivate(path.join(runRoot, "summary.txt"), text);
  cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
  const prepublishReceipt = executionGuard.receipt("prepublish");
  const prepublishError = prepublishReceipt.error;
  if (prepublishError) { writeBenchmarkAbort(runRoot, { runId, completedRuns: completedRuns.length, expectedRuns: fullOrder.length }, prepublishError, { ledger: ledgerBinding, provenanceStamp: prepublishReceipt.stamp }); throw prepublishError; }
  for (const marker of ["paused.json", "interrupted.json", "aborted.json", "stopped.json"]) fs.rmSync(path.join(runRoot, marker), { force: true });
  writePrivateAtomic(path.join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : text);
  process.stdout.write(`Reports: ${runRoot}\n`);
  if (
    report.comparison.qualityGate === false
    || report.comparison.safetyGate === false
    || report.comparison.reliabilityGate === false
    || report.comparison.qualityNonInferior === false
    || report.comparison.workflowGate === false
    || report.comparison.categoryGate === false
    || report.comparison.suiteGate?.passed === false
  ) process.exitCode = 1;
  } finally {
    releaseRunLock?.();
    codexRuntime?.cleanup();
    if (!preservePiRuntime) cleanupBenchmarkPiRuntimeHome(bootstrapMetadata?.piAgentHome, piRuntimeHome);
  }
}

function invokedAsEntrypoint() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || ""); }
  catch { return import.meta.url === pathToFileURL(process.argv[1] || "").href; }
}

if (invokedAsEntrypoint()) {
  main().catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exit(error.exitCode ?? 1);
  });
}

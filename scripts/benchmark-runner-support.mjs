import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { productionStageResumeWindow } from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";
import { productionV3FatalMeasurementEvidence } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { writeBenchmarkAbort } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { assertBenchmarkMeasurementOptions } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { benchmarkLedgerCheckpoint, inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { recoverBenchmarkObservationCheckpoints } from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { benchmarkSurfaceLabel } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { codexModelName, codexThinkingEffort } from "../packages/piagent-core/benchmark/benchmark-codex.js";

export function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

export function applyBenchmarkResumeOptions(options, resumeState) {
  if (!resumeState) return;
  const manifest = resumeState.manifest;
  if (manifest.measurementOnly !== undefined && typeof manifest.measurementOnly !== "boolean") {
    fail("Cannot resume benchmark: manifest measurementOnly must be a boolean", 1);
  }
  const measurementOnly = manifest.measurementOnly === true;
  if (options.measurementOnly === true && !measurementOnly) {
    fail("Cannot enable --measurement-only on an existing release manifest; start a new measurement-only run", 1);
  }
  assertBenchmarkMeasurementOptions({ ...options, measurementOnly });
  assertBenchmarkMeasurementOptions({ ...manifest, measurementOnly });
  options.measurementOnly = measurementOnly;
  options.suite = manifest.suite?.source ?? manifest.suite?.manifestPath ?? manifest.suite?.id ?? options.suite;
  options.surfaces = manifest.surfaces;
  options.model = manifest.model ?? undefined;
  options.thinking = manifest.thinking ?? undefined;
  options.serviceTier = manifest.serviceTier ?? undefined;
  options.codexMode = manifest.codexMode ?? "controlled";
  options.codexBaseline = manifest.codexBaseline ?? "controlled-custom";
  options.piagentTreatment = manifest.piagentTreatment ?? "release-defaults";
  options.allowPiAuthWriteback = manifest.allowPiAuthWriteback === true;
  options.seed = manifest.rootSeed;
  options.repeats = manifest.repeats;
  options.scenarioIds = manifest.scenarioIds ?? undefined;
  options.timeoutSeconds = manifest.timeoutSeconds;
  options.infrastructureRetries = manifest.infrastructureRetries;
  options.retryDelaySeconds = manifest.retryDelaySeconds;
  options.stopAfterFailedPair = manifest.stopAfterFailedPair === true;
  options.campaignStopPolicy = manifest.campaignStopPolicy;
  options.output = resumeState.runRoot;
}

export function frozenRuntimeCommandsForFinalization(manifest, surfaces) {
  const commands = manifest?.runtimeCommands;
  const validIdentity = (identity) => identity?.schemaVersion === 1
    && identity.kind === "regular"
    && typeof identity.resolvedPath === "string"
    && /^[a-f0-9]{64}$/.test(String(identity.contentDigest ?? ""));
  const required = ["pi", "node", "git", "bash", ...(surfaces.includes("codex-cli") ? ["codex"] : []),
    ...(manifest?.registeredMeasurement ? ["docker"] : [])];
  if (!commands || typeof commands !== "object" || required.some((label) => !validIdentity(commands[label]))) {
    fail("Cannot finalize production benchmark provider-free: frozen runtime command identities are missing or invalid", 1);
  }
  if (!surfaces.includes("codex-cli") && commands.codex !== null) {
    fail("Cannot finalize production benchmark provider-free: frozen Codex command identity does not match the surface list", 1);
  }
  if (surfaces.includes("codex-cli") && manifest?.codexBaseline === "stock"
    && commands.codex?.installationClosure?.kind !== "stock-codex-installation-v1") {
    fail("Cannot finalize production benchmark provider-free: frozen stock Codex installation closure is missing", 1);
  }
  return commands;
}

export function isLegacyInvocation(argv) {
  return argv.includes("--record") || argv.includes("--init");
}

export function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch { /* Non-POSIX filesystem. */ }
  return target;
}

export function registeredBenchmarkCustodyRoot(runRoot) {
  const root = fs.realpathSync(runRoot);
  const custodyRoot = fs.realpathSync(privateDirectory(path.join(root, "scoped-custody")));
  if (custodyRoot !== path.join(root, "scoped-custody")) {
    fail("Registered benchmark custody root must be a canonical direct child of the run root", 1);
  }
  return custodyRoot;
}

export function defaultOutputRoot(bootstrapMetadata) {
  if (bootstrapMetadata?.defaultOutputRoot) return bootstrapMetadata.defaultOutputRoot;
  const agentRoot = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentRoot, "benchmarks", "piagent");
}

export function createRunId(suiteId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${suiteId}-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function ensureEmptyOutput(target) {
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) fail(`Output directory is not empty: ${target}`, 1);
  return privateDirectory(target);
}

export function benchmarkRunKey(value) {
  return `${value.scenarioId ?? value.scenario?.id}\0${value.surface}\0${value.repeat}`;
}

export function samePairedBlock(left, right) {
  return left?.scenario?.id === right?.scenario?.id && left?.repeat === right?.repeat;
}

export function pairedChunk(order, maximum) {
  if (maximum === undefined || order.length <= maximum) return order;
  let length = maximum;
  while (length > 0 && samePairedBlock(order[length - 1], order[length])) length -= 1;
  if (length === 0) fail(`--max-sessions ${maximum} would split the first paired benchmark block; increase the chunk size`, 1);
  return order.slice(0, length);
}

function shellCommandArgument(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function benchmarkResumeCommand({ runRoot, productionSpendControlled, completedRuns, stageControl, stageBoundaries, verificationRequired = false }) {
  const base = `piagent-benchmark --resume ${shellCommandArgument(runRoot)}${verificationRequired ? " --approve-verification" : ""}`;
  if (!productionSpendControlled) return `${base} --yes`;
  const window = productionStageResumeWindow(stageControl, { completedRuns, stageBoundaries });
  return window?.remainingSessions > 0
    ? `${base} --max-sessions ${window.remainingSessions} --yes`
    : `${base} --yes`;
}

export function readJsonFile(file, label) {
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
  } catch {
    fail(`Cannot resume benchmark; path does not exist: ${target}`, 1);
  }
  fail(`Cannot resume benchmark; path is not a file or directory: ${target}`, 1);
}

export function loadResumeState(input) {
  const runRoot = resolveResumeRunRoot(input);
  const releaseRunLock = acquireBenchmarkRunLock(runRoot, "resume-pending");
  let manifest;
  let productionV3Finalized = false;
  try {
    const manifestPath = path.join(runRoot, "run-manifest.json");
    if (!fs.existsSync(manifestPath)) {
      fail(`Cannot resume ${runRoot}: missing run-manifest.json. This run was created before resume metadata was written, so its root seed cannot be recovered safely. Start a new run with --max-sessions or --max-runtime-minutes to make it resumable.`, 1);
    }
    manifest = readJsonFile(manifestPath, "benchmark resume manifest");
    productionV3Finalized = manifest?.suite?.id === "production-v3"
      && (fs.existsSync(path.join(runRoot, "report.json"))
        || ["claim-passed", "no-claim"].includes(manifest.campaignEvidence?.status));
    if (productionV3Finalized) {
      fail(`Cannot resume ${runRoot}: the production-v3 run already has a finalized report or campaign outcome`, 1);
    }
    if (fs.existsSync(path.join(runRoot, "stopped.json"))) fail(`Cannot resume ${runRoot}: the paired release stop is terminal`, 1);
    if (manifest?.schemaVersion !== 1 || typeof manifest.runId !== "string") {
      fail(`Cannot resume ${runRoot}: run-manifest.json has an unsupported shape`, 1);
    }
    const observationCheckpoints = recoverBenchmarkObservationCheckpoints({ runRoot, manifest });
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
      observationCheckpoints,
      releaseRunLock
    };
  } catch (error) {
    if (!productionV3Finalized && manifest?.suite?.id === "production-v3" && manifest.measurementOnly !== true) {
      writeBenchmarkAbort(runRoot, {
        runId: manifest.runId,
        completedRuns: Number.isSafeInteger(manifest.ledger?.records) ? manifest.ledger.records : 0,
        expectedRuns: Array.isArray(manifest.order) ? manifest.order.length : 108
      }, error, { ledger: manifest.ledger ?? null, ...productionV3FatalMeasurementEvidence(error) });
    }
    releaseRunLock();
    throw error;
  }
}

export function sameStringList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function benchmarkExecutionPlan({
  packageVersion, suite, declaredScenarioCount, suiteDigest, options, comparison,
  fullOrder, resumeState, pendingOrder, order, lifecycles, rootSeedDigest
}) {
  const plan = [
    "Piagent automatic benchmark",
    `  platform:  v${packageVersion}`,
    `  suite:     ${suite.id} (${suite.scenarios.length}${suite.scenarios.length !== declaredScenarioCount ? `/${declaredScenarioCount}` : ""} scenarios)`,
    ...(options.measurementOnly === true ? [options.failedAttemptsOnly
      ? "  mode:      measurement-only · selected failed attempts · no full-matrix or release claim"
      : "  mode:      measurement-only · full 108-session observation · no release claim"] : []),
    ...(options.measurementOnly !== true && options.campaignStopPolicy === "measurement-invalidating-only"
      ? ["  mode:      complete measurement · retain valid agent failures · adjudicate the release claim at S108"]
      : []),
    `  claim:     ${suite.assurance?.claimTier ?? "unavailable"} · family-disjoint=${suite.assurance?.familyDisjointSplit === true} · generalization ${suite.assurance?.familyDisjointSplit === true ? "bounded" : "unavailable"}`,
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
    `  tier:      ${options.serviceTier ?? "default"}`,
    `  treatment: ${options.piagentTreatment}`,
    `  lifecycle: ${lifecycles.join(", ")}`,
    ...(options.replaySource ? [`  replay:    ${options.replaySource.runId ?? "prior-report"} · ${options.replayRuns.length} sessions`] : []),
    ...(resumeState ? [`  resume:    ${resumeState.manifest.runId}`] : []),
    `  variants:  ${suite.scenarios.some((scenario) => scenario.variantGenerator) ? `generated · seed ${rootSeedDigest.slice(0, 16)}` : "static"}`,
    `  ordering:  ${options.failedAttemptsOnly ? "original failed-attempt ledger order" : suite.schemaVersion === 2 ? "seeded paired blocks" : "paired alternating"}`,
    `  timeout:   ${options.timeoutSeconds}s per session`,
    "  grading:   hidden verifier + scope + output safety + Pi task evidence"
  ].join("\n");
  const codexPlan = options.surfaces.includes("codex-cli")
    ? `\n  codex:     ${options.codexBaseline} baseline · ${options.codexMode} config · model ${codexModelName(options.model)} · effort ${codexThinkingEffort(options.thinking)} · tier ${options.serviceTier ?? "default"}${options.codexMode === "controlled" ? " · isolated home" : ""}`
    : "";
  const nativeWarning = options.surfaces.includes("codex-cli") && options.codexMode === "native"
    ? "\nNative Codex mode loads the operator's global AGENTS.md, configuration, rules, hooks, MCP servers, and plugins."
    : "";
  return { plan, codexPlan, nativeWarning };
}

export function bindBenchmarkTerminationSignals({ interrupted, interrupt, terminateAll }) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (interrupted()) return;
      interrupt(signal);
      terminateAll(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export function executionOrder(suite, repeats, surfaces, rootSeed) {
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

export async function confirmPlan(message) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Refusing to start billed model runs without --yes in a non-interactive terminal", 1);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${message}\nContinue? [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

export function invokedAsEntrypoint(metaUrl, argvEntry) {
  try { return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argvEntry || ""); }
  catch { return metaUrl === pathToFileURL(argvEntry || "").href; }
}

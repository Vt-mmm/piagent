#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateSessionUsage, benchmarkSurfaceLabel } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { benchmarkUsage, parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { codexModelName, codexThinkingEffort } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import { benchmarkEnvironment, benchmarkEnvironmentPolicy, comparisonSurfaces, createCodexRuntime, piagentTreatment } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { assertBenchmarkPiCredentialReady, assertBenchmarkPiCredentialWritebackPolicy, cleanupBenchmarkPiRuntimeHome, createBenchmarkPiRuntimeHome, resetBenchmarkPiRuntimeEphemeralState, withBenchmarkPiCredentialWriteback } from "../packages/piagent-core/benchmark/benchmark-pi-home.js";
import { benchmarkPreflight, benchmarkPreflightReceipt } from "../packages/piagent-core/benchmark/benchmark-preflight.js";
import { prepareProductionProviderFreeEvidence, productionProviderFreeEvidenceError } from "../packages/piagent-core/benchmark/benchmark-provider-free-evidence.js";
import { applyBenchmarkExecutionDefaults } from "../packages/piagent-core/benchmark/benchmark-runner-policy.js";
import {
  appendPrivateJsonl,
  createBenchmarkCandidateGuard,
  loadReplayFailurePlan,
  retainWorkspaceForensics,
  safeInfrastructureDiagnostic,
  writeBenchmarkAbort,
  writeBenchmarkRunManifest,
  writePrivateAtomic
} from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { benchmarkBootstrapCandidateIndex, benchmarkBootstrapMetadata } from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { createBenchmarkExecutionGuard } from "../packages/piagent-core/benchmark/benchmark-execution-guard.js";
import { benchmarkCommandIdentity } from "../packages/piagent-core/benchmark/benchmark-runtime-identity.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { completedBenchmarkRecord, expectedBenchmarkRecord } from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { pairedOutcomeFloorStop } from "../packages/piagent-core/benchmark/benchmark-stop-policy.js";
import {
  approveProductionStageControl,
  buildBenchmarkStageDiagnostic,
  createProductionStageControl,
  durablePairedOutcomeFloorStop,
  productionGuardBindingMatches, productionSpendControlValidationErrors,
  productionStageResumeDisposition
} from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";
import { loadBenchmarkAssuranceEvidence, loadBenchmarkSuite, resolveBenchmarkSuiteEntry, validateBenchmarkSuiteFiles } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { appendBenchmarkLedger, assertBenchmarkLedgerBinding, emptyBenchmarkLedgerBinding, inspectBenchmarkLedger, validateBenchmarkLedgerPrefix } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
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
import { finalizeBenchmarkRun } from "./benchmark-runner-finalization.mjs";
import {
  benchmarkRunKey,
  confirmPlan,
  createRunId,
  defaultOutputRoot,
  ensureEmptyOutput,
  executionOrder,
  fail,
  formatDuration,
  frozenRuntimeCommandsForFinalization,
  invokedAsEntrypoint,
  isLegacyInvocation,
  loadResumeState,
  pairedChunk,
  privateDirectory,
  readJsonFile,
  samePairedBlock,
  sameStringList
} from "./benchmark-runner-support.mjs";
import { runBenchmarkSession } from "./benchmark-session.mjs";
import {
  assertBenchmarkHostReadinessStartReady,
  assertExistingBenchmarkHostReadiness,
  benchmarkHostReadinessPolicyDigest,
  collectReadyBenchmarkHostReadiness
} from "./benchmark-runner-host-readiness.mjs";
export { parseBenchmarkArgs };
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const bootstrapMetadata = benchmarkBootstrapMetadata();
const bootstrapCandidateIndex = bootstrapMetadata ? benchmarkBootstrapCandidateIndex(bootstrapMetadata) : undefined;
let interruptedSignal;
const processController = createBenchmarkProcessController(() => Boolean(interruptedSignal));
const runCommand = processController.run;

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
    options.stopAfterFailedPair = manifest.stopAfterFailedPair === true;
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
  if (bootstrapMetadata?.suite?.builtInId) options.suite = bootstrapMetadata.suite.builtInId;
  else if (bootstrapMetadata?.suite?.snapshot) options.suite = bootstrapMetadata.suite.snapshot;
  if (options.help) {
    process.stdout.write(benchmarkUsage);
    return;
  }
  piagentTreatment(options.piagentTreatment);
  const { suite, manifestPath, suiteRoot, builtInId } = loadBenchmarkSuite(options.suite, packageRoot);
  validateBenchmarkSuiteFiles(suite, suiteRoot);
  if (bootstrapMetadata && bootstrapMetadata.suite.builtInId !== builtInId) {
    fail("Frozen benchmark suite origin no longer matches its canonical built-in identity", 1);
  }
  const canonicalProductionSuite = builtInId === "production-v1";
  const productionSpendControlPath = path.join(suiteRoot, "spend-control.v1.json");
  const productionSpendControl = canonicalProductionSuite || fs.existsSync(productionSpendControlPath)
    ? readJsonFile(productionSpendControlPath, "production spend-control contract")
    : null;
  const productionExpectedSessions = productionSpendControl
    && Number.isSafeInteger(productionSpendControl.execution?.repeats)
    && Array.isArray(productionSpendControl.execution?.surfaces)
    ? suite.scenarios.length * productionSpendControl.execution.repeats * productionSpendControl.execution.surfaces.length
    : undefined;
  const productionSpendControlErrors = productionSpendControl
      ? productionSpendControlValidationErrors(productionSpendControl, {
          suiteId: suite.id,
          expectedSessions: productionExpectedSessions,
          requireHostReadiness: canonicalProductionSuite
            && suite.releaseGate?.requireHostReadinessForClaim === true
        })
    : [];
  if (productionSpendControlErrors.length > 0) {
    fail(`Production spend-control contract is invalid (${productionSpendControlErrors.join(", ")})`, 1);
  }
  const productionAllStageBoundaries = productionSpendControl
    ? productionSpendControl.stages.map((stage) => stage.cumulativeSessions)
    : [];
  const productionStageBoundaries = productionAllStageBoundaries.slice(1);
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
  applyBenchmarkExecutionDefaults(options, suite);
  const productionFullMatrixRequested = Boolean(productionSpendControl)
    && !options.replayRuns
    && suite.scenarios.length === declaredScenarioCount;
  if (productionFullMatrixRequested) {
    const spendExecution = productionSpendControl.execution;
    if (options.seed === undefined) options.seed = productionSpendControl.rootSeed;
    if (options.seed !== productionSpendControl.rootSeed) fail("Production spend control requires its frozen root seed", 1);
    if (!sameStringList(options.surfaces, spendExecution.surfaces)) fail("Production spend control requires its frozen surface order", 1);
    if ((options.model ?? null) !== spendExecution.model) fail("Production spend control requires its frozen model", 1);
    if ((options.thinking ?? null) !== spendExecution.thinking) fail("Production spend control requires its frozen thinking level", 1);
    if (options.repeats !== spendExecution.repeats) fail("Production spend control requires its frozen repeat count", 1);
    if (options.infrastructureRetries !== spendExecution.infrastructureRetries) fail("Production spend control requires zero infrastructure retries", 1);
  }
  if (options.stopAfterFailedPair && !Number.isFinite(suite.releaseGate?.minimumOutcomeScoreExclusive)) fail("--stop-after-failed-pair requires a suite outcome floor", 1);
  if (options.surfaces.includes("codex-cli")) {
    options.model = options.model ?? "openai-codex/gpt-5.6-luna";
    options.thinking = options.thinking ?? "medium";
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
  const productionSpendControlled = productionFullMatrixRequested;
  const productionHostReadinessRequired = productionSpendControlled
    && canonicalProductionSuite
    && suite.releaseGate?.requireHostReadinessForClaim === true;
  const productionHostReadinessPolicy = productionHostReadinessRequired
    ? productionSpendControl.hostReadiness
    : null;
  const productionHostReadinessPolicyDigest = productionHostReadinessRequired
    ? benchmarkHostReadinessPolicyDigest(productionHostReadinessPolicy)
    : null;
  const productionReleaseClaimRun = productionSpendControlled
    && suite.schemaVersion === 2
    && suite.releaseGate?.requireEfficiencyClaim === true
    && suite.releaseGate?.requireFullSuiteForClaim === true;
  if (productionSpendControlled && productionStageBoundaries.at(-1) !== fullOrder.length) {
    fail("Production spend control final stage does not match the frozen full execution order", 1);
  }
  let deferredProductionStageApproval;
  if (resumeState) {
    const manifest = resumeState.manifest;
    if (manifest.suiteDigest !== suiteDigest) fail("Cannot resume benchmark: suite files changed since the original run", 1);
    if (productionSpendControlled && !productionGuardBindingMatches(manifest, productionSpendControl)) fail("Cannot resume production benchmark: frozen production guard binding is missing or changed", 1);
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
    const recoveredTerminalStop = durablePairedOutcomeFloorStop({
      enabled: options.stopAfterFailedPair,
      suite,
      runs: resumeState.completedRuns,
      fullOrder
    });
    if (recoveredTerminalStop) {
      for (const marker of ["paused.json", "stage-diagnostic.json", "interrupted.json", "aborted.json"]) {
        fs.rmSync(path.join(resumeState.runRoot, marker), { force: true });
      }
      writePrivateAtomic(path.join(resumeState.runRoot, "stopped.json"), `${JSON.stringify({
        ...recoveredTerminalStop,
        runId: manifest.runId,
        completedRuns: resumeState.completedRuns.length,
        expectedRuns: fullOrder.length,
        stoppedAt: new Date().toISOString(),
        resumeAllowed: false,
        recoveredFromAcceptedLedger: true,
        ledger: resumeState.ledgerBinding,
        provenanceStamp: candidateGuard.stamp("resume-terminal-floor")
      }, null, 2)}\n`);
      fail("Cannot resume benchmark: the accepted ledger already contains a terminal paired outcome-floor failure", 1);
    }
    if (productionSpendControlled) {
      if (productionHostReadinessRequired) {
        if (manifest.hostReadinessPolicyDigest !== productionHostReadinessPolicyDigest
          && resumeState.completedRuns.length < fullOrder.length) {
          fail("Cannot resume production benchmark: host-readiness policy binding is missing or changed. Start a new staged run.", 1);
        }
        if (resumeState.completedRuns.length < fullOrder.length) {
          assertExistingBenchmarkHostReadiness({
            policy: productionHostReadinessPolicy,
            receipts: manifest.hostReadinessReceipts,
            completedRuns: resumeState.completedRuns.length,
            authorizedThroughRuns: manifest.stageControl?.authorizedThroughRuns,
            runId: manifest.runId,
            configurationDigest: manifest.configurationDigest,
            stageBoundaries: productionAllStageBoundaries
          });
        }
      }
      const stageDisposition = productionStageResumeDisposition(manifest.stageControl, {
        completedRuns: resumeState.completedRuns.length,
        ledger: resumeState.ledgerBinding,
        stageBoundaries: productionAllStageBoundaries
      });
      if (!stageDisposition.passed) {
        fail(`Cannot resume production benchmark: invalid durable stage-control state (${stageDisposition.errors.join(", ")}). Start a new staged run.`, 1);
      }
      if (stageDisposition.requiresStageGate && resumeState.completedRuns.length < fullOrder.length) {
        const recoveredBoundaryReason = `max-sessions:recovered:${resumeState.completedRuns.length}`;
        const resumeStageDiagnostic = buildBenchmarkStageDiagnostic({
          runId: manifest.runId,
          reason: manifest.stageControl.pendingBoundary?.reason ?? recoveredBoundaryReason,
          runs: resumeState.completedRuns,
          fullOrder,
          candidateSurface: comparison.candidateSurface,
          baselineSurface: comparison.baselineSurface,
          requestedModel: options.model,
          requestedThinking: options.thinking,
          suite,
          manifest,
          hostReadinessPolicy: productionHostReadinessPolicy,
          hostReadinessStageBoundaries: productionAllStageBoundaries
        });
        writePrivateAtomic(path.join(resumeState.runRoot, "stage-diagnostic.json"), `${JSON.stringify(resumeStageDiagnostic, null, 2)}\n`);
        if (!resumeStageDiagnostic.stageAdvanceAllowed) {
          fail(`Cannot resume production benchmark: the provider-free stage gate blocked further paid sessions (${resumeStageDiagnostic.blockingReasons.join(", ")}). Fix the candidate and start a new staged run.`, 1);
        }
        const currentWindow = manifest.stageControl.authorizedThroughRuns;
        const nextAuthorizedThroughRuns = resumeState.completedRuns.length < currentWindow
          ? currentWindow
          : productionStageBoundaries.find((boundary) => boundary > resumeState.completedRuns.length);
        if (!Number.isSafeInteger(nextAuthorizedThroughRuns)) {
          fail("Cannot resume production benchmark: no bounded spend-control window remains", 1);
        }
        const requiredResumeSessions = nextAuthorizedThroughRuns - resumeState.completedRuns.length;
        if (!options.dryRun && options.maxSessions !== requiredResumeSessions) {
          fail(`Production spend control requires --max-sessions ${requiredResumeSessions} for the next authorized window; durable stage state was not changed.`, 1);
        }
        if (!options.dryRun) {
          deferredProductionStageApproval = {
            completedRuns: resumeState.completedRuns.length,
            authorizedThroughRuns: nextAuthorizedThroughRuns
          };
        }
      } else if (stageDisposition.requiresStageGate) {
        // A crash after the final accepted record must not change the verdict by
        // applying an early-stage heuristic. The complete report gates the same
        // frozen ledger without starting another provider session.
        manifest.ledger = resumeState.ledgerBinding;
        writeBenchmarkRunManifest(resumeState.runRoot, manifest);
      }
    }
  }
  const productionFinalizationOnly = productionSpendControlled
    && Boolean(resumeState)
    && resumeState.completedRuns.length === fullOrder.length;
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
  const nativeWarning = options.surfaces.includes("codex-cli") && options.codexMode === "native"
    ? "\nNative Codex mode loads the operator's global AGENTS.md, configuration, rules, hooks, MCP servers, and plugins."
    : "";
  if (options.dryRun) {
    process.stdout.write(`${plan}${codexPlan}\n  manifest:  ${manifestPath}\nDRY RUN: no model session started.\n`);
    return;
  }
  if (productionSpendControlled) {
    if (options.stopAfterFailedPair !== productionSpendControl.execution.stopAfterFailedPair) {
      fail("Production spend control requires --stop-after-failed-pair before any provider session", 1);
    }
    const completedRuns = resumeState?.completedRuns.length ?? 0;
    const authorizedThroughRuns = deferredProductionStageApproval?.authorizedThroughRuns
      ?? resumeState?.manifest.stageControl?.authorizedThroughRuns
      ?? productionStageBoundaries[0];
    const requiredChunkSessions = authorizedThroughRuns - completedRuns;
    if (!options.preflightOnly && !productionFinalizationOnly
      && (!Number.isSafeInteger(requiredChunkSessions) || requiredChunkSessions <= 0
        || options.maxSessions !== requiredChunkSessions)) {
      fail(`Production spend control requires --max-sessions ${requiredChunkSessions} for the current authorized window; refusing an unbounded or oversized paid chunk.`, 1);
    }
  }
  if (!bootstrapMetadata) fail("Modern billed benchmarks must start through scripts/benchmark-runner.mjs so execution assets are frozen", 1);
  if (productionReleaseClaimRun && bootstrapMetadata.sourceIdentity.dirty !== false) {
    fail("Production benchmark requires a clean release source before auth, tool preflight, or any provider session", 1);
  }
  if (options.replayFailures && bootstrapMetadata.replay?.evidenceComplete !== true) {
    fail("Billed replay requires the original run-manifest.json and runs.jsonl beside the source report", 1);
  }
  if (!options.preflightOnly) {
    if (productionFinalizationOnly) {
      process.stdout.write(`${plan}${codexPlan}\n  mode:      provider-free finalization of the complete frozen ledger\n`);
    } else if (options.yes) {
      process.stdout.write(`${plan}${codexPlan}${nativeWarning}\n`);
    } else if (!(await confirmPlan(`${plan}${codexPlan}${nativeWarning}\nThis may use paid model quota.`))) {
      process.stdout.write("Benchmark cancelled; no model session started.\n");
      return;
    }
  }
  const runId = resumeState?.manifest.runId ?? createRunId(suite.id);
  const runtimeCommands = productionFinalizationOnly
    ? frozenRuntimeCommandsForFinalization(resumeState.manifest, options.surfaces)
    : {
        pi: benchmarkCommandIdentity(piCommand, { cwd: bootstrapMetadata?.originalCwd ?? process.cwd() }),
        codex: options.surfaces.includes("codex-cli")
          ? benchmarkCommandIdentity(codexCommand, { cwd: bootstrapMetadata?.originalCwd ?? process.cwd() })
          : null,
        node: benchmarkCommandIdentity(process.execPath),
        git: benchmarkCommandIdentity("git"),
        bash: benchmarkCommandIdentity("bash")
      };
  const environmentPolicy = benchmarkEnvironmentPolicy();
  const configurationPiAgentHome = productionFinalizationOnly
    ? resumeState.manifest.piAgentHome?.identity
    : bootstrapMetadata.piAgentHome.identity;
  const configurationCodexCredential = productionFinalizationOnly
    ? resumeState.manifest.codexCredentialIdentity ?? null
    : bootstrapMetadata.codexCredential?.identity ?? null;
  const configuration = {
    schemaVersion: 1,
    source: bootstrapMetadata.sourceIdentity,
    candidateDigest: candidateGuard.provenance.contentDigest,
    suiteDigest,
    runtimeDependencyDigest: bootstrapMetadata.runtimeDependencies?.digest ?? null,
    runtimeCommands,
    environmentPolicy,
    ...(productionHostReadinessRequired ? { hostReadinessPolicyDigest: productionHostReadinessPolicyDigest } : {}),
    piAgentHome: configurationPiAgentHome,
    codexCredential: configurationCodexCredential,
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
  const source = bootstrapMetadata?.sourceIdentity;
  if (!source) fail("Modern benchmark is missing its frozen Git source identity", 1);
  const { receipt: providerFreeEvidence, binding: providerFreeEvidenceBinding } = await prepareProductionProviderFreeEvidence({
    required: productionSpendControl?.productionGuards?.providerFreeEvidence?.requiredBeforeFirstPaidSession === true, packageRoot, bootstrapMetadata, candidateProvenance: candidateGuard.provenance, configurationDigest, runCommand, resumedReceipt: resumeState ? resumeState.manifest.providerFreeEvidence ?? null : undefined });
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
  let hostReadinessReceipt = null;
  const currentAuthorizedThroughRuns = resumeState?.manifest.stageControl?.authorizedThroughRuns
    ?? productionStageBoundaries[0];
  const nextAuthorizedThroughRuns = deferredProductionStageApproval?.authorizedThroughRuns
    ?? currentAuthorizedThroughRuns;
  if (productionHostReadinessRequired && !productionFinalizationOnly) {
    hostReadinessReceipt = await collectReadyBenchmarkHostReadiness({
      policy: productionHostReadinessPolicy,
      completedRuns: resumeState?.completedRuns.length ?? 0,
      authorizedThroughRuns: nextAuthorizedThroughRuns,
      runId,
      configurationDigest,
      stageBoundaries: productionAllStageBoundaries,
      existingReceipts: resumeState?.manifest.hostReadinessReceipts ?? []
    });
  }
  const assertHostReadinessStartReady = () => assertBenchmarkHostReadinessStartReady(hostReadinessReceipt, {
    policy: productionHostReadinessPolicy,
    runId,
    configurationDigest
  });
  const executionGuard = createBenchmarkExecutionGuard({
    candidateGuard,
    suiteRoot,
    suiteIdentity: bootstrapMetadata?.suite?.identity ?? suiteIdentity,
    piAgentHome: productionFinalizationOnly ? null : bootstrapMetadata?.piAgentHome,
    codexCredential: productionFinalizationOnly ? null : bootstrapMetadata?.codexCredential,
    runtimeDependencies: bootstrapMetadata?.runtimeDependencies,
    commands: runtimeCommands,
    verifyCommandAssets: !productionFinalizationOnly
  });
  let runtime;
  let codexCredentialBridge;
  if (productionFinalizationOnly) {
    runtime = resumeState.manifest.preflightRuntime;
    if (!runtime || typeof runtime.gitVersion !== "string" || typeof runtime.piVersion !== "string"
      || !Array.isArray(runtime.codexDisabledFeatures)
      || (options.surfaces.includes("codex-cli") && typeof runtime.codexVersion !== "string")) {
      fail("Cannot finalize production benchmark provider-free: frozen preflight runtime evidence is missing or invalid", 1);
    }
    codexCredentialBridge = resumeState.manifest.codexCredentialBridge ?? null;
    const finalizationAssetError = executionGuard.check("provider-free-finalization");
    if (finalizationAssetError) throw finalizationAssetError;
  } else {
    assertBenchmarkPiCredentialReady(bootstrapMetadata.piAgentHome.credentialReadiness, options.model);
    assertBenchmarkPiCredentialWritebackPolicy(bootstrapMetadata.piAgentHome);
    piRuntimeHome = createBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome);
    const preflightAssetError = executionGuard.check("before-preflight", [piRuntimeHome]);
    if (preflightAssetError) throw preflightAssetError;
    codexRuntime = createCodexRuntime(options);
    try { runtime = await withBenchmarkPiCredentialWriteback(bootstrapMetadata.piAgentHome, piRuntimeHome, () => benchmarkPreflight({ runCommand, packageRoot, piCommand, piEnvironment: benchmarkEnvironment({ PI_CODING_AGENT_DIR: piRuntimeHome.path }), codexCommand, gitCommand: runtimeCommands.git.resolvedPath, surfaces: options.surfaces, codexMode: options.codexMode, codexRuntime })); }
    catch (error) { preservePiRuntime ||= error.code === "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED"; throw error; }
    const postPreflightAssetError = executionGuard.check("after-preflight", [piRuntimeHome]);
    if (postPreflightAssetError) throw postPreflightAssetError;
    resetBenchmarkPiRuntimeEphemeralState(piRuntimeHome);
    codexCredentialBridge = codexRuntime.credentialBridge;
    if (resumeState && resumeState.manifest.preflightRuntime !== undefined
      && JSON.stringify(resumeState.manifest.preflightRuntime) !== JSON.stringify(runtime)) {
      fail("Cannot resume benchmark: provider-free preflight runtime evidence changed since the original run", 1);
    }
    if (resumeState && resumeState.manifest.codexCredentialBridge !== undefined
      && resumeState.manifest.codexCredentialBridge !== codexCredentialBridge) {
      fail("Cannot resume benchmark: Codex credential bridge changed since the original run", 1);
    }
  }
  assertHostReadinessStartReady();
  if (options.preflightOnly) {
    const receipt = benchmarkPreflightReceipt({ packageVersion: packageManifest.version, source, candidateProvenance: candidateGuard.report(), suite, suiteDigest, runtimeDependencies: bootstrapMetadata.runtimeDependencies, runtimeCommands, environmentPolicy, configurationDigest, rootSeedDigest, options, runtime, hostReadinessPolicyDigest: productionHostReadinessPolicyDigest, hostReadiness: hostReadinessReceipt, providerFreeEvidence });
    process.stdout.write(options.json ? `${JSON.stringify(receipt, null, 2)}\n` : `${plan}${codexPlan}\nPREFLIGHT READY: no model session started.\n${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  candidateGuard.freeze();
  const output = options.output ?? path.join(defaultOutputRoot(bootstrapMetadata), runId);
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
      manifestPath: bootstrapMetadata?.suite?.snapshot ? bootstrapMetadata.suite.origin : null,
      builtInId
    },
    suiteDigest,
    suiteIdentity,
    candidateProvenance: candidateGuard.provenance,
    runtimeDependencies: bootstrapMetadata?.runtimeDependencies ?? null,
    runtimeCommands,
    preflightRuntime: runtime,
    codexCredentialIdentity: bootstrapMetadata.codexCredential?.identity ?? null,
    codexCredentialBridge,
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
    ...(productionSpendControlled ? {
      productionGuards: productionSpendControl.productionGuards,
      providerFreeEvidence,
      stageControl: createProductionStageControl({
        authorizedThroughRuns: productionStageBoundaries[0],
        generatedAt: startedAt
      }),
      ...(productionHostReadinessRequired ? {
        hostReadinessPolicyDigest: productionHostReadinessPolicyDigest,
        hostReadinessReceipts: []
      } : {})
    } : {}),
    order: fullOrder.map((item) => ({
      scenarioId: item.scenario.id,
      surface: item.surface,
      repeat: item.repeat
    }))
  };
  assertHostReadinessStartReady();
  if (productionSpendControlled && deferredProductionStageApproval) {
    manifest.stageControl = approveProductionStageControl(manifest.stageControl, deferredProductionStageApproval);
  }
  if (productionHostReadinessRequired && hostReadinessReceipt) {
    manifest.hostReadinessPolicyDigest = productionHostReadinessPolicyDigest;
    manifest.hostReadinessReceipts = [...(manifest.hostReadinessReceipts ?? []), hostReadinessReceipt];
  }
  writeBenchmarkRunManifest(runRoot, manifest);
  if (resumeState) {
    fs.rmSync(path.join(runRoot, "stage-diagnostic.json"), { force: true });
    if (productionSpendControlled && manifest.stageControl?.state === "window-authorized") {
      fs.rmSync(path.join(runRoot, "paused.json"), { force: true });
    }
  }
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
    if (productionSpendControl?.productionGuards?.providerFreeEvidence?.requiredBeforeFirstPaidSession === true) {
      fatalRunError ??= productionProviderFreeEvidenceError(manifest.providerFreeEvidence, providerFreeEvidenceBinding, "final production provider-free evidence");
    }
    finalizationReceipt = executionGuard.receipt("finalization", [piRuntimeHome]);
    fatalRunError ??= finalizationReceipt.error;
  }
  finalizeBenchmarkRun({
    assuranceEvidence, bootstrapMetadata, candidateGuard, canonicalProductionSuite,
    codexCredentialBridge, comparison, configurationDigest, declaredScenarioCount,
    detachPiRuntimeHome: () => { piRuntimeHome = undefined; },
    environmentPolicy, executionGuard, fatalExecutionReceipt, fatalRunError,
    finalizationReceipt, fullOrder, interruptedSignal, ledgerBinding, ledgerPath,
    lifecycles, manifest, options, packageVersion: packageManifest.version,
    pauseReason, piRuntimeHome, preservePiRuntime,
    productionAllStageBoundaries, productionHostReadinessPolicy, productionSpendControlled, rootSeed, rootSeedDigest,
    runId, runRoot, runs, runtime, runtimeCommands, source, startedAt, suite,
    suiteDigest, suiteIdentity, terminalStop
  });
  } finally {
    releaseRunLock?.();
    codexRuntime?.cleanup();
    if (!preservePiRuntime) cleanupBenchmarkPiRuntimeHome(bootstrapMetadata?.piAgentHome, piRuntimeHome);
  }
}

if (invokedAsEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exit(error.exitCode ?? 1);
  });
}

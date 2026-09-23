#!/usr/bin/env node
import { assertDiagnosticCandidateDerivation, assertDiagnosticBenchmarkMatrix, benchmarkAcceptancePolicyBinding, DIAGNOSTIC_TREATMENT } from "../packages/piagent-core/benchmark/benchmark-diagnostic-treatment.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkUsage, parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { benchmarkVerificationBinding, prepareBenchmarkVerification } from "./benchmark-independent-verification.mjs";
import { codexModelName, codexThinkingEffort } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import { assertCodexRuntimeCredential, benchmarkEnvironment, comparisonSurfaces, createCodexRuntime, piagentTreatment } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { assertBenchmarkPiCredentialReady, assertBenchmarkPiCredentialWritebackPolicy, cleanupBenchmarkPiRuntimeHome, createBenchmarkPiRuntimeHome, resetBenchmarkPiRuntimeEphemeralState, withBenchmarkPiCredentialWriteback } from "../packages/piagent-core/benchmark/benchmark-pi-home.js";
import { benchmarkPreflight, benchmarkPreflightReceipt } from "../packages/piagent-core/benchmark/benchmark-preflight.js";
import { prepareProductionProviderFreeEvidence, productionProviderFreeConfigurationDigest, productionProviderFreeEvidenceError, productionProviderFreeEvidenceRequired } from "../packages/piagent-core/benchmark/benchmark-provider-free-evidence.js";
import { applyBenchmarkExecutionDefaults, benchmarkInfrastructureFailureDisposition, benchmarkRunnerErrorRecord, recoveredBenchmarkAttemptDisposition } from "../packages/piagent-core/benchmark/benchmark-runner-policy.js";
import { BENCHMARK_TRANSPORT_CIRCUIT_POLICY, appendPrivateJsonl, createBenchmarkTransportCircuit,
  createBenchmarkCandidateGuard, loadReplayFailurePlan, retainWorkspaceForensics, safeInfrastructureDiagnostic,
  validBenchmarkTransportCircuit, writeBenchmarkAbort, writeBenchmarkRunManifest,
  writePrivateAtomic } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { benchmarkBootstrapCandidateIndex, benchmarkBootstrapMetadata } from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { createBenchmarkExecutionGuard } from "../packages/piagent-core/benchmark/benchmark-execution-guard.js";
import { readBenchmarkWireDefinitionPlan, validateBenchmarkWireManifest } from "../packages/piagent-core/benchmark/benchmark-provider-wire.js";
export { projectBenchmarkWireState } from "../packages/piagent-core/benchmark/benchmark-provider-wire.js";
import { openProductionBenchmarkCampaign } from "../packages/piagent-core/benchmark/benchmark-campaign.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { completedBenchmarkRecord, expectedBenchmarkRecord } from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { pairedOutcomeFloorStop } from "../packages/piagent-core/benchmark/benchmark-stop-policy.js";
import { productionExecutionBindingMatches,
  productionGuardBindingMatches } from "../packages/piagent-core/benchmark/benchmark-production-completion.js";
import { approveProductionStageControl, buildBenchmarkStageDiagnostic,
  createProductionStageControl,
  productionSpendControlValidationErrors, productionStageResumeDisposition } from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";
import { loadBenchmarkAssuranceEvidence, loadBenchmarkSuite, resolveBenchmarkSuiteEntry, validateBenchmarkSuiteFiles } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { appendBenchmarkLedger, assertBenchmarkLedgerBinding, emptyBenchmarkLedgerBinding, inspectBenchmarkLedger, validateBenchmarkLedgerPrefix } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { createBenchmarkProcessController } from "../packages/piagent-core/benchmark/benchmark-process.js";
import {
  clearRecoveredBenchmarkAttempts, persistUnacceptedBenchmarkAttempt, promoteMeasuredBenchmarkRecord,
  recoverOrphanedBenchmarkAttempts, recoverPendingBenchmarkRecord, stageMeasuredBenchmarkRecord
} from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { finalizeBenchmarkRun } from "./benchmark-runner-finalization.mjs";
import { applyProductionCampaignStopPolicy, assertProductionResumeCompletionState,
  productionMeasurementInvalidatingOutcomeError,
  productionReleaseMeasurementAbortEvidence, writeProductionResumeAbortIfNeeded,
  writeProductionRunAbortIfNeeded } from "./benchmark-runner-completion.mjs";
import {
  applyBenchmarkResumeOptions,
  bindBenchmarkTerminationSignals,
  benchmarkExecutionPlan,
  benchmarkRunKey,
  confirmPlan,
  createRunId,
  defaultOutputRoot,
  ensureEmptyOutput,
  executionOrder,
  fail, formatDuration, invokedAsEntrypoint, isLegacyInvocation,
  loadResumeState, pairedChunk, privateDirectory,
  readJsonFile, registeredBenchmarkCustodyRoot,
  samePairedBlock,
  sameStringList
} from "./benchmark-runner-support.mjs";
import { runBenchmarkSchedule } from "./benchmark-runner-schedule.mjs";
import { readBenchmarkBudgetControl, assertBenchmarkBudgetBinding, openBenchmarkBudgetCore, createBudgetProviderCallbacks } from "./benchmark-budget-runtime.mjs";
import { createBenchmarkBudgetProcessHooks } from "./benchmark-budget-ipc.mjs";
import { createRegisteredBenchmarkScopedSessionFactory, registeredBenchmarkScopedSessionRequired } from "./benchmark-scoped-session-factory.mjs";
import { assertBenchmarkHostReadinessStartReady, assertExistingBenchmarkHostReadiness, benchmarkHostReadinessPolicyDigest, collectReadyBenchmarkHostReadiness } from "./benchmark-runner-host-readiness.mjs";
import { applyRegisteredMeasurementOptions, benchmarkMeasurementConfiguration, benchmarkRuntimeCommands,
  registeredMeasurementBinding as measurementBinding
} from "./benchmark-runner-configuration.mjs";
import { bindRegisteredRuntimeVerifiers, createBenchmarkProviderBoundaryGuard,
  forceTokenUnavailableForPostSessionAssetError } from "./benchmark-runner-provider-boundary.mjs";
export { parseBenchmarkArgs };
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const bootstrapMetadata = benchmarkBootstrapMetadata();
const bootstrapCandidateIndex = bootstrapMetadata ? benchmarkBootstrapCandidateIndex(bootstrapMetadata) : undefined;
const webUiAssetIdentity = bootstrapMetadata?.webUiAssets
  ? Object.fromEntries(Object.entries(bootstrapMetadata.webUiAssets).filter(([key]) => key !== "root"))
  : null;
let interruptedSignal;
const processController = createBenchmarkProcessController(() => Boolean(interruptedSignal), createBenchmarkBudgetProcessHooks());
const runCommand = processController.run;
function installSignalForwarding() {
  return bindBenchmarkTerminationSignals({ interrupted: () => Boolean(interruptedSignal),
    interrupt: (signal) => { interruptedSignal = signal; },
    terminateAll: (signal) => processController.terminateAll(signal) });
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
  if (options.registeredMeasurement && !bootstrapMetadata?.registeredMeasurement) {
    fail("Registered measurement must start through scripts/benchmark-runner.mjs with a trusted frozen registration", 1);
  }
  const registeredMeasurement = bootstrapMetadata?.registeredMeasurement ?? null;
  applyRegisteredMeasurementOptions(options, registeredMeasurement);
  if (bootstrapMetadata?.replay?.snapshot) options.replayFailures = bootstrapMetadata.replay.snapshot;
  if (options.resume && options.replayFailures) fail("--resume cannot be combined with --replay-failures", 1);
  if (options.resume && options.output) fail("--resume uses the original report directory; do not pass --output", 1);
  const resumeState = options.resume ? loadResumeState(options.resume) : undefined;
  if (resumeState?.manifest.failedAttemptsOnly === true) {
    resumeState.releaseRunLock?.();
    fail("A failed-attempt diagnostic is a single bounded replay; do not resume it as a full matrix", 1);
  }
  let releaseRunLock = resumeState?.releaseRunLock;
  let codexRuntime, productionCampaign, piRuntimeHome, budgetRuntime, productionAbortFallback = () => {};
  let preservePiRuntime = false;
  try {
  applyBenchmarkResumeOptions(options, resumeState);
  const budgetControl = readBenchmarkBudgetControl({ options, resumeManifest: resumeState?.manifest, sourceRoot: bootstrapMetadata?.liveRoot ?? packageRoot });
  if (options.replayFailures) {
    const replay = loadReplayFailurePlan(options.replayFailures, { failedAttemptsOnly: options.failedAttemptsOnly });
    if (bootstrapMetadata?.replay && replay.source.reportDigest !== bootstrapMetadata.replay.digest) fail("Frozen replay report digest does not match bootstrap metadata", 1);
    options.suite = replay.suite;
    options.seed = replay.seed;
    options.surfaces = replay.surfaces;
    options.model = options.model ?? replay.model;
    options.thinking = options.thinking ?? replay.thinking;
    options.serviceTier = options.serviceTier ?? replay.serviceTier;
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
  options.acceptancePolicyBinding = benchmarkAcceptancePolicyBinding(packageRoot, options);
  const { suite, manifestPath, suiteRoot, builtInId } = loadBenchmarkSuite(options.suite, packageRoot);
  validateBenchmarkSuiteFiles(suite, suiteRoot);
  if (bootstrapMetadata && bootstrapMetadata.suite.builtInId !== builtInId) {
    fail("Frozen benchmark suite origin no longer matches its canonical built-in identity", 1);
  }
  const canonicalProductionSuite = ["production-v1", "production-v2", "production-v3"].includes(builtInId);
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
          suite,
          requireHostReadiness: canonicalProductionSuite
            && suite.releaseGate?.requireHostReadinessForClaim === true
        })
    : [];
  if (productionSpendControlErrors.length > 0) {
    fail(`Production spend-control contract is invalid (${productionSpendControlErrors.join(", ")})`, 1);
  }
  const registeredMeasurementRun = Boolean(registeredMeasurement);
  const productionAllStageBoundaries = productionSpendControl
    ? registeredMeasurementRun || (options.measurementOnly && builtInId === "production-v2")
      ? [0, productionExpectedSessions]
      : productionSpendControl.stages.map((stage) => stage.cumulativeSessions)
    : [];
  const productionStageBoundaries = productionAllStageBoundaries.slice(1);
  const assuranceEvidence = loadBenchmarkAssuranceEvidence(suite, suiteRoot);
  const declaredScenarioCount = suite.scenarios.length;
  const declaredScenarios = [...suite.scenarios];
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
  assertDiagnosticBenchmarkMatrix(options, { builtInId, fullMatrix: productionFullMatrixRequested,
    expectedSessions: productionExpectedSessions });
  // Buy one full observation window; graders, integrity and release thresholds stay unchanged.
  const failedAttemptReplay = options.failedAttemptsOnly === true
    && options.replaySource?.selection === "failed-attempts" && options.replaySource?.evidenceComplete === true
    && options.replaySource.originalAttemptCount === 108;
  if (options.measurementOnly && (!["production-v2", "production-v3"].includes(builtInId) || (!productionFullMatrixRequested && !failedAttemptReplay)
    || productionExpectedSessions !== 108 || options.codexMode !== "controlled" || !["release-defaults", DIAGNOSTIC_TREATMENT].includes(options.piagentTreatment))) {
    fail("--measurement-only requires a complete production-v2/v3 controlled matrix or a bound failed-attempt-only diagnostic replay", 1);
  }
  if (productionFullMatrixRequested) {
    const spendExecution = productionSpendControl.execution;
    applyProductionCampaignStopPolicy(options, spendExecution);
    if (options.seed === undefined) options.seed = productionSpendControl.rootSeed;
    if (options.seed !== productionSpendControl.rootSeed) fail("Production spend control requires its frozen root seed", 1);
    if (!sameStringList(options.surfaces, spendExecution.surfaces)) fail("Production spend control requires its frozen surface order", 1);
    if ((options.model ?? null) !== spendExecution.model) fail("Production spend control requires its frozen model", 1);
    if ((options.thinking ?? null) !== spendExecution.thinking) fail("Production spend control requires its frozen thinking level", 1);
    if (spendExecution.serviceTier !== undefined
      && (options.serviceTier ?? null) !== spendExecution.serviceTier) fail("Production spend control requires its frozen service tier", 1);
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
  if (registeredMeasurementRun && suiteDigest !== registeredMeasurement.payload.baseSuiteDigest) {
    fail("Registered measurement base suite digest does not match the frozen production-v2 suite", 1);
  }
  const verificationPlan = prepareBenchmarkVerification({ options, resumeState, registeredMeasurement,
    installedRoot: packageRoot, suiteDigest,
    scenarios: declaredScenarios, suiteRoot, resolveSuiteEntry: resolveBenchmarkSuiteEntry });
  const rootSeed = options.seed ?? crypto.randomBytes(32).toString("hex");
  const rootSeedDigest = crypto.createHash("sha256").update(rootSeed).digest("hex");
  if (registeredMeasurementRun && rootSeedDigest !== registeredMeasurement.payload.unchangedSeedDigest) {
    fail("Registered measurement root seed digest does not match the unchanged production seed", 1);
  }
  const registeredMeasurementBinding = measurementBinding(registeredMeasurement);
  const candidateGuard = createBenchmarkCandidateGuard(packageRoot, resumeState?.manifest.candidateProvenance, {
    immutableSnapshot: Boolean(bootstrapMetadata),
    observedProvenance: bootstrapMetadata?.candidateProvenance,
    snapshotIndex: bootstrapCandidateIndex
  });
  candidateGuard.freeze();
  assertDiagnosticCandidateDerivation(options.acceptancePolicyBinding, bootstrapMetadata?.treatmentDerivation, candidateGuard.provenance);
  const providerWirePlan = readBenchmarkWireDefinitionPlan({ file: process.env.PIAGENT_WIRE_MANIFEST_PATH, sha256: process.env.PIAGENT_WIRE_MANIFEST_SHA256 });
  if (providerWirePlan) validateBenchmarkWireManifest(providerWirePlan.manifest, { template: true, candidateDigest: candidateGuard.provenance.contentDigest,
    model: options.model, thinking: options.thinking, requestedTier: options.serviceTier });
  if (resumeState && (resumeState.manifest.providerWirePlanDigest ?? null) !== (providerWirePlan?.planDigest ?? null)) fail("Cannot resume benchmark: provider-wire definition plan changed", 1);
  const fullOrder = options.replayRuns
    ? options.replayRuns.map((run) => ({
        scenario: suite.scenarios.find((scenario) => scenario.id === run.scenarioId),
        surface: run.surface,
        repeat: run.repeat
      }))
    : executionOrder(suite, options.repeats, options.surfaces, rootSeed);
  const productionSpendControlled = productionFullMatrixRequested;
  assertBenchmarkBudgetBinding(budgetControl, { options, candidateDigest: candidateGuard.provenance.contentDigest, suiteDigest, fullOrder });
  const productionCampaignRequired = productionSpendControlled && suite.releaseGate?.requireCampaignAccounting === true;
  const providerFreeEvidenceRequired = productionProviderFreeEvidenceRequired({ productionSpendControlled,
    spendControl: productionSpendControl });
  const productionHostReadinessRequired = productionSpendControlled
    && canonicalProductionSuite
    && suite.releaseGate?.requireHostReadinessForClaim === true;
  const productionHostReadinessPolicy = productionHostReadinessRequired
    ? productionSpendControl.hostReadiness
    : null;
  const productionHostReadinessPolicyDigest = productionHostReadinessRequired
    ? benchmarkHostReadinessPolicyDigest(productionHostReadinessPolicy)
    : null;
  const productionReleaseClaimRun = productionSpendControlled && !registeredMeasurementRun
    && !options.measurementOnly
    && !options.acceptancePolicyBinding
    && options.piagentTreatment !== "acceptance-diagnostic"
    && suite.schemaVersion === 2
    && suite.releaseGate?.requireEfficiencyClaim === true
    && suite.releaseGate?.requireFullSuiteForClaim === true;
  if (productionSpendControlled && productionStageBoundaries.at(-1) !== fullOrder.length) {
    fail("Production spend control final stage does not match the frozen full execution order", 1);
  }
  let deferredProductionStageApproval;
  if (resumeState) {
    const manifest = resumeState.manifest;
    if (JSON.stringify(manifest.registeredMeasurement ?? null) !== JSON.stringify(registeredMeasurementBinding)) {
      fail("Cannot resume benchmark: registered measurement identity changed or is missing", 1);
    }
    if (manifest.suiteDigest !== suiteDigest) fail("Cannot resume benchmark: suite files changed since the original run", 1);
    if (productionSpendControlled && !productionGuardBindingMatches(manifest, productionSpendControl)) fail("Cannot resume production benchmark: frozen production guard binding is missing or changed", 1);
    if (productionSpendControlled && !productionExecutionBindingMatches(manifest, productionSpendControl)) fail("Cannot resume production benchmark: frozen execution and campaign stop policy binding is missing or changed", 1);
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
      }, error, { ledger: resumeState.ledgerBinding, provenanceStamp: candidateGuard.stamp("resume-ledger"),
        ...productionReleaseMeasurementAbortEvidence(options, suite, error) });
      throw error;
    }
    const provenanceError = candidateGuard.check("resume");
    if (provenanceError) {
      writeBenchmarkAbort(resumeState.runRoot, { runId: manifest.runId, completedRuns: resumeState.completedRuns.length, expectedRuns: fullOrder.length }, provenanceError, {
        ledger: resumeState.ledgerBinding,
        provenanceStamp: candidateGuard.stamp("resume"),
        ...productionReleaseMeasurementAbortEvidence(options, suite, provenanceError)
      });
      throw provenanceError;
    }
    assertProductionResumeCompletionState({
      candidateGuard,
      fullOrder,
      options,
      resumeState,
      suite
    });
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
          requestedServiceTier: options.serviceTier,
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
  const { plan, codexPlan, nativeWarning } = benchmarkExecutionPlan({
    packageVersion: packageManifest.version,
    suite,
    declaredScenarioCount,
    suiteDigest,
    options,
    comparison,
    fullOrder,
    resumeState,
    pendingOrder,
    order,
    lifecycles,
    rootSeedDigest
  });
  if (options.dryRun) {
    if (options.acceptancePolicyBinding) process.stdout.write(`Diagnostic acceptance binding: ${JSON.stringify({ policy: options.acceptancePolicyBinding, derivation: bootstrapMetadata?.treatmentDerivation })}\n`);
    process.stdout.write(`Frozen verification binding: ${JSON.stringify(benchmarkVerificationBinding({ installedRoot: packageRoot, suiteDigest }))}\n`);
    if (verificationPlan) process.stdout.write(`Independent verification: ${JSON.stringify(verificationPlan.identity)} (preview only)\n`);
    process.stdout.write(`${plan}${codexPlan}\n  manifest:  ${manifestPath}\nDRY RUN: no model session started.\n`);
    return;
  }
  if (!options.preflightOnly) budgetRuntime = openBenchmarkBudgetCore(budgetControl);
  if (productionSpendControlled) {
    if (!options.measurementOnly && !registeredMeasurementRun
      && options.stopAfterFailedPair !== productionSpendControl.execution.stopAfterFailedPair) {
      fail(productionSpendControl.execution.stopAfterFailedPair
        ? "Production spend control requires --stop-after-failed-pair before any provider session"
        : "Production spend control requires paired-outcome quality stopping to remain disabled before any provider session", 1);
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
  const runtimeCommands = benchmarkRuntimeCommands({ productionFinalizationOnly,
    resumeManifest: resumeState?.manifest, surfaces: options.surfaces, piCommand, codexCommand, codexBaseline: options.codexBaseline,
    dockerCommand: registeredMeasurementRun ? verificationPlan?.dockerCommand?.path : undefined,
    cwd: bootstrapMetadata?.originalCwd ?? process.cwd() });
  const registeredRuntimeVerifiers = bindRegisteredRuntimeVerifiers({ registeredMeasurement,
    registeredMeasurementRun, bootstrapMetadata, runtimeCommands, verificationPlan });
  const { configuration, configurationDigest, environmentPolicy } = benchmarkMeasurementConfiguration({
    bootstrapMetadata, candidateDigest: candidateGuard.provenance.contentDigest, suiteDigest, runtimeCommands,
    verificationIdentity: verificationPlan?.identity, providerWirePlan, productionHostReadinessRequired,
    productionHostReadinessPolicyDigest, productionFinalizationOnly, resumeManifest: resumeState?.manifest,
    rootSeedDigest, options, fullOrder });
  const providerFreeConfigurationDigest = providerFreeEvidenceRequired ? productionProviderFreeConfigurationDigest(configuration) : null;
  const source = bootstrapMetadata?.sourceIdentity; if (!source) fail("Modern benchmark is missing its frozen Git source identity", 1);
  if (resumeState && providerFreeEvidenceRequired && resumeState.manifest.providerFreeConfigurationDigest !== providerFreeConfigurationDigest) fail("Cannot resume benchmark: provider-free configuration changed since the original run", 1);
  const { receipt: providerFreeEvidence, binding: providerFreeEvidenceBinding } = await prepareProductionProviderFreeEvidence({
    required: providerFreeEvidenceRequired, packageRoot, bootstrapMetadata, candidateProvenance: candidateGuard.provenance, providerFreeConfigurationDigest, runCommand, resumedReceipt: resumeState ? resumeState.manifest.providerFreeEvidence ?? null : undefined });
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
    webUiAssets: bootstrapMetadata?.webUiAssets,
    registeredAssets: bootstrapMetadata?.registeredMeasurement,
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
    assertCodexRuntimeCredential(codexRuntime, { required: registeredMeasurementRun });
    try { runtime = await withBenchmarkPiCredentialWriteback(bootstrapMetadata.piAgentHome, piRuntimeHome, () => benchmarkPreflight({ runCommand, packageRoot, piCommand, piEnvironment: benchmarkEnvironment({ PI_CODING_AGENT_DIR: piRuntimeHome.path, PIAGENT_FAST_MODE: options.serviceTier === "fast" ? "1" : "0" }), codexCommand, codexCommandIdentity: runtimeCommands.codex, gitCommand: runtimeCommands.git.resolvedPath, surfaces: options.surfaces, codexBaseline: options.codexBaseline, codexMode: options.codexMode, codexRuntime, model: options.model, serviceTier: options.serviceTier })); }
    catch (error) { preservePiRuntime ||= error.code === "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED"; throw error; }
    assertCodexRuntimeCredential(codexRuntime, { required: registeredMeasurementRun });
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
    const receipt = benchmarkPreflightReceipt({ packageVersion: packageManifest.version, source, candidateProvenance: candidateGuard.report(), suite, suiteDigest, runtimeDependencies: bootstrapMetadata.runtimeDependencies, webUiAssets: bootstrapMetadata.webUiAssets, runtimeCommands, environmentPolicy, configurationDigest, providerFreeConfigurationDigest, rootSeedDigest, options, runtime, hostReadinessPolicyDigest: productionHostReadinessPolicyDigest, hostReadiness: hostReadinessReceipt, providerFreeEvidence, independentVerification: verificationPlan?.identity, registeredRuntimeVerifiers });
    process.stdout.write(options.json ? `${JSON.stringify(receipt, null, 2)}\n` : `${plan}${codexPlan}\nPREFLIGHT READY: no model session started.\n${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  candidateGuard.freeze();
  const output = options.output ?? path.join(defaultOutputRoot(bootstrapMetadata), runId);
  const runRoot = resumeState ? privateDirectory(output) : ensureEmptyOutput(output);
  releaseRunLock ??= acquireBenchmarkRunLock(runRoot, runId);
  privateDirectory(path.join(runRoot, "workspaces"));
  const registeredScopedSessionFactory = registeredMeasurementRun
    ? createRegisteredBenchmarkScopedSessionFactory({ installedRoot: packageRoot, registeredMeasurement,
      custodyRoot: registeredBenchmarkCustodyRoot(runRoot), nodeCommand: runtimeCommands.node.resolvedPath,
      codexRuntimePath: runtimeCommands.codex?.resolvedPath ?? null, qualification: {
        version: 4, candidateRoot: bootstrapMetadata.snapshotRoot,
        assetsRoot: bootstrapMetadata.webUiAssets.root,
        sdkRoot: runtimeCommands.pi.packageClosure.root,
        candidateIndexPath: bootstrapMetadata.candidateIndex.path,
        candidateIndexSha256: bootstrapMetadata.candidateIndex.digest } })
    : null;
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
    ...(registeredMeasurementBinding ? { registeredMeasurement: registeredMeasurementBinding } : {}),
    ...(registeredRuntimeVerifiers ? { registeredRuntimeVerifiers } : {}),
    candidateProvenance: candidateGuard.provenance,
    runtimeDependencies: bootstrapMetadata?.runtimeDependencies ?? null,
    webUiAssets: webUiAssetIdentity,
    runtimeCommands,
    preflightRuntime: runtime,
    codexCredentialIdentity: bootstrapMetadata.codexCredential?.identity ?? null,
    codexCredentialBridge,
    configurationDigest,
    ...(budgetControl ? { budgetControl: budgetControl.identity } : {}),
    environmentPolicy,
    ...(verificationPlan ? { verificationPlan: { file: options.verificationPlan, identity: verificationPlan.identity } } : {}),
    ...(providerWirePlan ? { providerWirePlanDigest: providerWirePlan.planDigest } : {}),
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
    serviceTier: options.serviceTier ?? null,
    codexMode: options.codexMode,
    codexBaseline: options.codexBaseline,
    piagentTreatment: options.piagentTreatment,
    ...(options.acceptancePolicyBinding ? { acceptancePolicyBinding: options.acceptancePolicyBinding } : {}),
    ...(bootstrapMetadata?.treatmentDerivation ? { treatmentDerivation: bootstrapMetadata.treatmentDerivation } : {}),
    allowPiAuthWriteback: options.allowPiAuthWriteback,
    timeoutSeconds: options.timeoutSeconds,
    infrastructureRetries: options.infrastructureRetries,
    retryDelaySeconds: options.retryDelaySeconds,
    transportCircuitBreaker: createBenchmarkTransportCircuit(),
    stopAfterFailedPair: options.stopAfterFailedPair,
    ...(options.campaignStopPolicy ? { campaignStopPolicy: options.campaignStopPolicy } : {}),
    ...(options.measurementOnly ? { measurementOnly: true } : {}),
    ...(options.failedAttemptsOnly ? { failedAttemptsOnly: true } : {}),
    scenarioIds: options.scenarioIds ?? null,
    ...(productionSpendControlled ? {
      productionGuards: productionSpendControl.productionGuards,
      providerFreeConfigurationDigest,
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
  productionAbortFallback = (error) => writeProductionRunAbortIfNeeded({ fullOrder, ledgerBinding, manifest, options, productionSpendControlled, runRoot, runs, suite }, error);
  if (productionCampaignRequired) {
    productionCampaign = openProductionBenchmarkCampaign({
      registryBase: path.join(bootstrapMetadata.defaultOutputRoot, ".production-campaigns"), suiteId: suite.id,
      runId, runRoot, configurationDigest, candidateDigest: candidateGuard.provenance.contentDigest, suiteDigest, existingBinding: resumeState?.manifest.campaign
    });
    manifest.campaign = productionCampaign.binding;
  }
  if (!validBenchmarkTransportCircuit(manifest.transportCircuitBreaker)) {
    fail("Cannot run benchmark: transport circuit-breaker state is missing or malformed", 1);
  }
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
  const scheduleState = { fatalRunError, pauseReason, preservePiRuntime, fatalExecutionReceipt, ledgerBinding, terminalStop };
  try {
    await runBenchmarkSchedule({
      order, fullOrder, pendingOrder, options, runs,
      manifest, recoveredAttemptsByKey, executionGuard, budgetRuntime, codexRuntime,
      registeredMeasurement, registeredMeasurementRun, registeredRuntimeVerifiers, bootstrapMetadata, runtimeCommands,
      piRuntimeHome, packageRoot, runCommand, suite, suiteRoot,
      runId, runRoot, verificationPlan, providerWirePlan, candidateGuard,
      piCommand, codexCommand, runtime, registeredScopedSessionFactory, suiteDigest,
      configurationDigest, productionCampaign, rootSeed, ledgerPath, infrastructureLedgerPath,
      interrupted: () => Boolean(interruptedSignal), state: scheduleState
    });
  } finally {
    ({ fatalRunError, pauseReason, preservePiRuntime, fatalExecutionReceipt, ledgerBinding, terminalStop } = scheduleState);
    removeSignalHandlers();
  }
  try {
    const finalLedger = inspectBenchmarkLedger(ledgerPath);
    assertBenchmarkLedgerBinding(ledgerBinding, finalLedger.binding, "benchmark terminal ledger");
    validateBenchmarkLedgerPrefix(finalLedger.records, fullOrder, (record, index, expected) => expectedBenchmarkRecord(record, index, expected, runId, suite, configurationDigest, verificationPlan?.identity));
  } catch (error) {
    fatalRunError ??= error;
  }
  if (productionCampaign) { manifest.campaignEvidence = productionCampaign.snapshot(); writeBenchmarkRunManifest(runRoot, manifest); }
  let finalizationReceipt;
  if (!interruptedSignal && !fatalRunError) {
    if (providerFreeEvidenceRequired) {
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
    productionCampaign,
    runId, runRoot, runs, runtime, runtimeCommands, source, startedAt, suite,
    suiteDigest, suiteIdentity, terminalStop
  });
  } catch (error) { productionAbortFallback(error); writeProductionResumeAbortIfNeeded(resumeState, error); throw error; } finally {
    budgetRuntime?.close();
    releaseRunLock?.();
    productionCampaign?.close();
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

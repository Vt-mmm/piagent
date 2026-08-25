import fs from "node:fs";
import path from "node:path";

import {
  renderBenchmarkHtml,
  renderBenchmarkText,
  summarizeBenchmark
} from "../packages/piagent-core/benchmark/benchmark-core.js";
import { codexModelName } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import { benchmarkTrustChecklist } from "../packages/piagent-core/benchmark/benchmark-matrix.js";
import { applyBenchmarkClaimRestrictions } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { piagentTreatment } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { cleanupBenchmarkPiRuntimeHome } from "../packages/piagent-core/benchmark/benchmark-pi-home.js";
import { benchmarkSuiteCoverage } from "../packages/piagent-core/benchmark/benchmark-runner-policy.js";
import {
  benchmarkHostReadinessPolicyDigest,
  summarizeBenchmarkHostReadinessHistory
} from "../packages/piagent-core/benchmark/benchmark-host-readiness.js";
import {
  cleanupUnretainedWorkspaces,
  writeBenchmarkAbort,
  writeBenchmarkRunManifest,
  writePrivate,
  writePrivateAtomic
} from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import {
  buildBenchmarkStageDiagnostic,
  pendProductionStageControl
} from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";
import {
  assertBenchmarkLedgerBinding,
  inspectBenchmarkLedger,
  validateBenchmarkLedgerPrefix
} from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import {
  completedBenchmarkRecord,
  expectedBenchmarkRecord
} from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { recoverOrphanedBenchmarkAttempts } from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { benchmarkResumeCommand, benchmarkRunKey } from "./benchmark-runner-support.mjs";

export function finalizeBenchmarkRun(context) {
  const {
    assuranceEvidence,
    bootstrapMetadata,
    candidateGuard,
    canonicalProductionSuite,
    codexCredentialBridge,
    comparison,
    configurationDigest,
    declaredScenarioCount,
    detachPiRuntimeHome,
    environmentPolicy,
    executionGuard,
    fatalExecutionReceipt,
    fatalRunError,
    finalizationReceipt,
    fullOrder,
    interruptedSignal,
    ledgerBinding,
    ledgerPath,
    lifecycles,
    manifest,
    options,
    packageVersion,
    pauseReason,
    piRuntimeHome,
    preservePiRuntime,
    productionAllStageBoundaries,
    productionHostReadinessPolicy,
    productionSpendControlled,
    rootSeed,
    rootSeedDigest,
    runId,
    runRoot,
    runs,
    runtime,
    runtimeCommands,
    source,
    startedAt,
    suite,
    suiteDigest,
    suiteIdentity,
    terminalStop
  } = context;

  if (interruptedSignal) {
    const provenanceStamp = executionGuard.stamp("interrupted", [piRuntimeHome]);
    detachPiRuntimeHome();
    recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys: new Set(runs.map(benchmarkRunKey)) });
    cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
    const interruptedCompletedRuns = runs.filter(completedBenchmarkRecord).length;
    const resumeCommand = benchmarkResumeCommand({
      runRoot,
      productionSpendControlled,
      completedRuns: interruptedCompletedRuns,
      stageControl: manifest.stageControl,
      stageBoundaries: productionAllStageBoundaries
    });
    writePrivateAtomic(path.join(runRoot, "interrupted.json"), `${JSON.stringify({ schemaVersion: 1, runId, signal: interruptedSignal, completedRuns: interruptedCompletedRuns, expectedRuns: fullOrder.length, interruptedAt: new Date().toISOString(), resumeCommand, ledger: ledgerBinding, provenanceStamp }, null, 2)}\n`);
    process.stderr.write(`Benchmark interrupted by ${interruptedSignal}. Partial ledger: ${ledgerPath}\n`);
    process.exitCode = interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGHUP" ? 129 : 143;
    return;
  }
  if (fatalRunError) {
    const provenanceStamp = finalizationReceipt?.stamp ?? fatalExecutionReceipt?.stamp ?? executionGuard.stamp("fatal", piRuntimeHome ? [piRuntimeHome] : []);
    if (!preservePiRuntime) cleanupBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome, piRuntimeHome);
    detachPiRuntimeHome();
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
    cleanupBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome, piRuntimeHome);
    detachPiRuntimeHome();
    cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
    for (const marker of ["paused.json", "stage-diagnostic.json", "interrupted.json", "aborted.json"]) fs.rmSync(path.join(runRoot, marker), { force: true });
    writePrivateAtomic(path.join(runRoot, "stopped.json"), `${JSON.stringify({ ...terminalStop, runId, completedRuns: runs.filter(completedBenchmarkRecord).length, expectedRuns: fullOrder.length, stoppedAt: new Date().toISOString(), resumeAllowed: false, ledger: ledgerBinding, provenanceStamp: finalizationReceipt.stamp }, null, 2)}\n`);
    process.stderr.write(`Benchmark terminal-stopped after paired outcome-floor failure. Partial ledger: ${ledgerPath}\n`);
    process.exitCode = 1;
    return;
  }

  const completedRuns = runs.filter(completedBenchmarkRecord);
  const summarizedHostReadinessHistory = productionHostReadinessPolicy
    ? summarizeBenchmarkHostReadinessHistory({
        policy: productionHostReadinessPolicy,
        receipts: manifest.hostReadinessReceipts,
        completedRuns: completedRuns.length,
        authorizedThroughRuns: manifest.stageControl?.authorizedThroughRuns,
        runId: manifest.runId,
        configurationDigest: manifest.configurationDigest,
        stageBoundaries: productionAllStageBoundaries
      })
    : null;
  const hostReadinessPolicyBindingValid = !productionHostReadinessPolicy
    || manifest.hostReadinessPolicyDigest === benchmarkHostReadinessPolicyDigest(productionHostReadinessPolicy);
  const hostReadinessHistory = summarizedHostReadinessHistory && !hostReadinessPolicyBindingValid
    ? {
        ...summarizedHostReadinessHistory,
        valid: false,
        ready: false,
        errors: [...summarizedHostReadinessHistory.errors, "host-readiness-manifest-policy-digest-mismatch"]
      }
    : summarizedHostReadinessHistory;
  if (completedRuns.length < fullOrder.length) {
    detachPiRuntimeHome();
    cleanupUnretainedWorkspaces(runRoot, options.keepWorkspaces);
    const resumeCommand = benchmarkResumeCommand({
      runRoot,
      productionSpendControlled,
      completedRuns: completedRuns.length,
      stageControl: manifest.stageControl,
      stageBoundaries: productionAllStageBoundaries
    });
    const paused = {
      schemaVersion: 1,
      runId,
      reason: pauseReason ?? "partial-run",
      completedRuns: completedRuns.length,
      expectedRuns: fullOrder.length,
      remainingRuns: fullOrder.length - completedRuns.length,
      pausedAt: new Date().toISOString(),
      resumeCommand,
      ledger: ledgerBinding,
      provenanceStamp: executionGuard.stamp("paused")
    };
    const stageDiagnostic = buildBenchmarkStageDiagnostic({
      runId,
      reason: paused.reason,
      runs: completedRuns,
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
    if (productionSpendControlled) {
      manifest.stageControl = pendProductionStageControl(manifest.stageControl, {
        reason: paused.reason,
        completedRuns: completedRuns.length,
        ledger: ledgerBinding
      });
      manifest.ledger = ledgerBinding;
      writeBenchmarkRunManifest(runRoot, manifest);
      for (const marker of ["interrupted.json", "aborted.json"]) fs.rmSync(path.join(runRoot, marker), { force: true });
    }
    paused.stageDiagnostic = {
      path: "stage-diagnostic.json",
      diagnosticOnly: true,
      claimEligible: false,
      stageAdvanceAllowed: stageDiagnostic.stageAdvanceAllowed
    };
    writePrivateAtomic(path.join(runRoot, "stage-diagnostic.json"), `${JSON.stringify(stageDiagnostic, null, 2)}\n`);
    writePrivateAtomic(path.join(runRoot, "paused.json"), `${JSON.stringify(paused, null, 2)}\n`);
    process.stdout.write(`Benchmark paused after ${completedRuns.length}/${fullOrder.length} completed sessions (${paused.reason}).\nStage advance: ${stageDiagnostic.stageAdvanceAllowed ? "allowed by diagnostic" : `blocked (${stageDiagnostic.blockingReasons.join(", ")})`}\nResume: ${paused.resumeCommand}\nStage diagnostic: ${path.join(runRoot, "stage-diagnostic.json")}\nPartial ledger: ${ledgerPath}\n`);
    return;
  }

  cleanupBenchmarkPiRuntimeHome(bootstrapMetadata.piAgentHome, piRuntimeHome);
  detachPiRuntimeHome();
  const report = summarizeBenchmark({
    suite,
    canonicalProductionSuite,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    repeats: options.repeats,
    environment: {
      platformVersion: packageVersion,
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
      codexCredentialBridge: options.surfaces.includes("codex-cli") ? codexCredentialBridge : null,
      codexGlobalInstructions: options.surfaces.includes("codex-cli")
        ? options.codexMode === "controlled" ? "excluded" : "operator-home"
        : null,
      piGlobalInstructions: "excluded",
      comparisonAccessContract: options.surfaces.includes("codex-cli") && options.codexMode === "controlled"
        ? "paired-workspace-write-offline-surface-system"
        : null,
      piAgentHome: manifest.piAgentHome,
      usageIntegrity: manifest.tokenClaimsUnavailableReason ?? "measured",
      codexDisabledFeatures: runtime.codexDisabledFeatures,
      surfaces: options.surfaces,
      scenarioSelection: options.scenarioIds ?? null,
      suiteCoverage: benchmarkSuiteCoverage(declaredScenarioCount, suite.scenarios.length),
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
      hostReadinessHistory,
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
  if (prepublishError) {
    writeBenchmarkAbort(runRoot, { runId, completedRuns: completedRuns.length, expectedRuns: fullOrder.length }, prepublishError, { ledger: ledgerBinding, provenanceStamp: prepublishReceipt.stamp });
    throw prepublishError;
  }
  for (const marker of ["paused.json", "stage-diagnostic.json", "interrupted.json", "aborted.json", "stopped.json"]) fs.rmSync(path.join(runRoot, marker), { force: true });
  writePrivateAtomic(path.join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : text);
  process.stdout.write(`Reports: ${runRoot}\n`);
  const productionTokenClaimFailed = canonicalProductionSuite
    && suite.releaseGate?.requireEfficiencyClaim === true
    && report.comparison.tokenClaimAllowed !== true;
  if (
    report.comparison.qualityGate === false
    || report.comparison.safetyGate === false
    || report.comparison.reliabilityGate === false
    || report.comparison.qualityNonInferior === false
    || report.comparison.workflowGate === false
    || report.comparison.categoryGate === false
    || report.comparison.suiteGate?.passed === false
    || productionTokenClaimFailed
  ) process.exitCode = 1;
}

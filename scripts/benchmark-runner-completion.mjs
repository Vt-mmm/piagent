import fs from "node:fs";
import path from "node:path";

import {
  MEASUREMENT_INVALIDATING_ONLY_STOP_POLICY,
  productionMeasurementInvalidatingRecordIssues
} from "../packages/piagent-core/benchmark/benchmark-production-completion.js";
import { productionV3FatalMeasurementEvidence } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { writeBenchmarkAbort, writePrivateAtomic } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { durablePairedOutcomeFloorStop } from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";

function benchmarkFailure(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function productionMeasurementContext(options, suite) {
  return {
    requestedModel: options.model,
    requestedThinking: options.thinking,
    requestedServiceTier: options.serviceTier,
    requireFastServiceTier: suite?.releaseGate?.requireFastServiceTier === true
  };
}

export function applyProductionCampaignStopPolicy(options, spendExecution) {
  const campaignStopPolicy = spendExecution.campaignStopPolicy ?? "paired-outcome-floor";
  if (options.campaignStopPolicy !== undefined && options.campaignStopPolicy !== campaignStopPolicy) {
    throw benchmarkFailure("Production spend control campaign stop policy changed since the original run");
  }
  options.campaignStopPolicy = spendExecution.campaignStopPolicy;
}

export function productionReleaseMeasurementAbortEvidence(options, suite, error) {
  return suite?.id === "production-v3" && options?.measurementOnly !== true
    ? productionV3FatalMeasurementEvidence(error)
    : {};
}

export function writeProductionResumeAbortIfNeeded(resumeState, error) {
  const manifest = resumeState?.manifest;
  if (manifest?.suite?.id !== "production-v3" || manifest.measurementOnly === true
    || fs.existsSync(path.join(resumeState.runRoot, "aborted.json"))) return;
  writeBenchmarkAbort(resumeState.runRoot, {
    runId: manifest.runId,
    completedRuns: resumeState.completedRuns.length,
    expectedRuns: Array.isArray(manifest.order) ? manifest.order.length : 108
  }, error, { ledger: resumeState.ledgerBinding, ...productionV3FatalMeasurementEvidence(error) });
}

export function writeProductionRunAbortIfNeeded({
  fullOrder,
  ledgerBinding,
  manifest,
  options,
  productionSpendControlled,
  runRoot,
  runs,
  suite
}, error) {
  if (!productionSpendControlled || suite?.id !== "production-v3" || options?.measurementOnly === true
    || fs.existsSync(path.join(runRoot, "aborted.json"))) return;
  writeBenchmarkAbort(runRoot, {
    runId: manifest.runId,
    completedRuns: runs.length,
    expectedRuns: fullOrder.length
  }, error, { ledger: ledgerBinding, ...productionV3FatalMeasurementEvidence(error) });
}

export function assertProductionResumeCompletionState({
  candidateGuard,
  fullOrder,
  options,
  resumeState,
  suite
}) {
  const { manifest } = resumeState;
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
    throw benchmarkFailure("Cannot resume benchmark: the accepted ledger already contains a terminal paired outcome-floor failure");
  }
  if (options.campaignStopPolicy !== MEASUREMENT_INVALIDATING_ONLY_STOP_POLICY) return;
  const measurementContext = productionMeasurementContext(options, suite);
  const invalidRecord = resumeState.completedRuns.map((record) => ({
    record,
    issues: productionMeasurementInvalidatingRecordIssues(record, measurementContext)
  })).find((item) => item.issues.length > 0);
  if (!invalidRecord) return;
  const error = Object.assign(benchmarkFailure(
    `Cannot resume benchmark: the accepted ledger contains a measurement-invalidating outcome (${invalidRecord.record.scenarioId}:${invalidRecord.record.surface}:r${invalidRecord.record.repeat}; ${invalidRecord.issues.join(", ")})`
  ), { code: "BENCHMARK_INVALID_MEASUREMENT", measurementInvalidatingIssues: invalidRecord.issues });
  writeBenchmarkAbort(resumeState.runRoot, {
    runId: manifest.runId,
    completedRuns: resumeState.completedRuns.length,
    expectedRuns: fullOrder.length
  }, error, {
    ledger: resumeState.ledgerBinding,
    provenanceStamp: candidateGuard.stamp("resume-invalid-measurement"),
    ...productionV3FatalMeasurementEvidence(error)
  });
  throw error;
}

export function productionMeasurementInvalidatingOutcomeError(options, suite, record) {
  if (options.campaignStopPolicy !== MEASUREMENT_INVALIDATING_ONLY_STOP_POLICY) return null;
  const measurementInvalidatingIssues = productionMeasurementInvalidatingRecordIssues(
    record, productionMeasurementContext(options, suite)
  );
  if (measurementInvalidatingIssues.length === 0) return null;
  return Object.assign(new Error(
    `Measurement-invalidating production-v3 outcome at ${record.scenarioId}:${record.surface}:r${record.repeat} (${measurementInvalidatingIssues.join(", ")})`
  ), { code: "BENCHMARK_INVALID_MEASUREMENT", measurementInvalidatingIssues });
}

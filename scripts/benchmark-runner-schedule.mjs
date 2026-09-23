import fs from "node:fs";
import path from "node:path";
import { createCodexRuntime } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { withBenchmarkPiCredentialWriteback, resetBenchmarkPiRuntimeEphemeralState } from "../packages/piagent-core/benchmark/benchmark-pi-home.js";
import { benchmarkInfrastructureFailureDisposition, benchmarkRunnerErrorRecord, recoveredBenchmarkAttemptDisposition } from "../packages/piagent-core/benchmark/benchmark-runner-policy.js";
import { appendPrivateJsonl, retainWorkspaceForensics, safeInfrastructureDiagnostic, writeBenchmarkRunManifest } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { completedBenchmarkRecord } from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { pairedOutcomeFloorStop } from "../packages/piagent-core/benchmark/benchmark-stop-policy.js";
import { resolveBenchmarkSuiteEntry } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { appendBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { clearRecoveredBenchmarkAttempts, persistUnacceptedBenchmarkAttempt, promoteMeasuredBenchmarkRecord, stageMeasuredBenchmarkRecord } from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { productionMeasurementInvalidatingOutcomeError } from "./benchmark-runner-completion.mjs";
import { benchmarkRunKey, formatDuration, samePairedBlock } from "./benchmark-runner-support.mjs";
import { createBudgetProviderCallbacks } from "./benchmark-budget-runtime.mjs";
import { registeredBenchmarkScopedSessionRequired } from "./benchmark-scoped-session-factory.mjs";
import { createBenchmarkProviderBoundaryGuard, forceTokenUnavailableForPostSessionAssetError } from "./benchmark-runner-provider-boundary.mjs";
import { runBenchmarkSession, runOfflineBenchmarkSession } from "./benchmark-session.mjs";

// One schedule implementation owns dispatch, WAL promotion, accounting and
// cleanup. The production entry never selects the explicit offline session seam.
export function runBenchmarkSchedule(context) {
  if (context.piagentWebUiJourney !== undefined) throw new Error("Production schedule does not accept an injected journey");
  return runSchedule(context, runBenchmarkSession);
}

// Test composition only: no CLI/environment switch, registration, verifier,
// credential writeback or production campaign authority can select this seam.
export function runOfflineBenchmarkSchedule(context, { piagentWebUiJourney } = {}) {
  if (typeof piagentWebUiJourney !== "function") throw new Error("Offline schedule requires an explicit scripted journey");
  if (context.productionCampaign || context.registeredMeasurement || context.registeredMeasurementRun
    || context.verificationPlan || context.providerWirePlan || context.registeredScopedSessionFactory
    || context.options?.registeredMeasurement || context.bootstrapMetadata?.piAgentHome?.operatorAuth) {
    throw new Error("Offline schedule cannot carry production or independent-verifier authority");
  }
  return runSchedule(context, input => runOfflineBenchmarkSession({ ...input, piagentWebUiJourney }));
}

async function runSchedule(context, runSession) {
  const {
    order, fullOrder, pendingOrder, options, runs,
    manifest, recoveredAttemptsByKey, executionGuard, budgetRuntime, codexRuntime,
    registeredMeasurement, registeredMeasurementRun, registeredRuntimeVerifiers, bootstrapMetadata, runtimeCommands,
    piRuntimeHome, packageRoot, runCommand, suite, suiteRoot,
    runId, runRoot, verificationPlan, providerWirePlan, candidateGuard,
    piCommand, codexCommand, runtime, registeredScopedSessionFactory, suiteDigest,
    configurationDigest, productionCampaign, rootSeed, ledgerPath, infrastructureLedgerPath,
    interrupted, state
  } = context;
  let { fatalRunError, pauseReason, preservePiRuntime, fatalExecutionReceipt, ledgerBinding, terminalStop } = state;
  const fullIndexByKey = new Map(fullOrder.map((item, index) => [benchmarkRunKey(item), index + 1]));
  const wallStartedAt = Date.now();
  const runtimeDeadline = options.maxRuntimeMinutes === undefined
    ? undefined
    : wallStartedAt + options.maxRuntimeMinutes * 60_000;
  let newRuns = 0;
  try {
    for (const [index, item] of order.entries()) {
      try { budgetRuntime?.check(); }
      catch (error) { fatalRunError = error; break; }
      if (manifest.transportCircuitBreaker.state === "open") {
        fatalRunError = new Error(`Transport circuit breaker is open after ${manifest.transportCircuitBreaker.failures} failures; start a new run only after provider health is re-established`);
        break;
      }
      if (interrupted()) break;
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
      const recoveredDisposition = recoveredBenchmarkAttemptDisposition(infrastructureFailures, {
        scenarioId: item.scenario.id,
        surface: item.surface,
        repeat: item.repeat,
        retryLimit: options.infrastructureRetries
      });
      if (!recoveredDisposition.passed) {
        fatalRunError = new Error(recoveredDisposition.error);
        break;
      }
      const firstInfrastructureAttempt = recoveredDisposition.firstAttempt;
      for (let infrastructureAttempt = firstInfrastructureAttempt; infrastructureAttempt <= options.infrastructureRetries + 1; infrastructureAttempt += 1) {
        record = undefined;
        fatalRunError = executionGuard.check(`before-session:${item.scenario.id}:${item.surface}:r${item.repeat}:attempt${infrastructureAttempt}`, [piRuntimeHome]);
        if (fatalRunError) break;
        let attemptError;
        let attemptCodexRuntime = codexRuntime;
        try {
          if (item.surface === "codex-cli") attemptCodexRuntime = createCodexRuntime(options);
          const assertProviderBoundary = createBenchmarkProviderBoundaryGuard({ executionGuard,
            registeredMeasurement, registeredMeasurementRun, registeredRuntimeVerifiers, bootstrapMetadata,
            runtimeCommands, codexRuntime: attemptCodexRuntime, piRuntimeHome, scenarioId: item.scenario.id,
            surface: item.surface, repeat: item.repeat, infrastructureAttempt });
          sessionEvidence = await withBenchmarkPiCredentialWriteback(bootstrapMetadata.piAgentHome, piRuntimeHome, () => runSession({
            packageRoot,
            runCommand,
            resolveSuiteEntry: resolveBenchmarkSuiteEntry,
            interrupted: interrupted,
            suite,
            suiteRoot,
            ...item,
            orderIndex: fullIndex,
            infrastructureAttempt,
            runId,
            runRoot,
            options,
            verificationPlan,
            ...(item.surface === "piagent" && providerWirePlan ? { providerWirePlan, candidateDigest: candidateGuard.provenance.contentDigest } : {}),
            piCommand,
            codexCommand,
            codexDisabledFeatures: runtime.codexDisabledFeatures,
            codexRuntime: attemptCodexRuntime,
            scopedBrokerSessionFactory: registeredScopedSessionFactory
              && registeredBenchmarkScopedSessionRequired(registeredScopedSessionFactory, item.scenario.id)
              ? registeredScopedSessionFactory : undefined,
            piRuntimeHome,
            systemCommands: { node: runtimeCommands.node.resolvedPath, git: runtimeCommands.git.resolvedPath, bash: runtimeCommands.bash.resolvedPath },
            suiteDigest, configurationDigest,
            assertProviderDispatchReady: () => { budgetRuntime?.check(); return assertProviderBoundary("provider-dispatch"); },
            onAfterProviderDispatch: () => assertProviderBoundary("provider-return"),
            ...createBudgetProviderCallbacks(budgetRuntime, productionCampaign),
            persistCompletedRecord: (candidate) => stageMeasuredBenchmarkRecord({ runRoot, manifest, ledgerBinding, record: candidate, infrastructureFailures, index: fullIndex - 1, expected: item, runId, suite, configurationDigest, runs }),
            rootSeed
          }));
          record = sessionEvidence.record;
        } catch (error) {
          preservePiRuntime ||= error.code === "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED";
          attemptError = error;
          const safeError = safeInfrastructureDiagnostic(error.message, [piRuntimeHome?.path, bootstrapMetadata.piAgentHome.configRoot, bootstrapMetadata.piAgentHome.runtimeParent].filter(Boolean));
          record = benchmarkRunnerErrorRecord({
            safeError,
            runId,
            orderIndex: fullIndex,
            item,
            suiteProfile: suite.profile,
            infrastructureAttempt
          });
        } finally {
          if (attemptCodexRuntime !== codexRuntime) attemptCodexRuntime.cleanup();
        }
        const guardStage = `after-session:${item.scenario.id}:${item.surface}:r${item.repeat}:attempt${infrastructureAttempt}`;
        const postSessionReceipt = executionGuard.receipt(guardStage, [piRuntimeHome]);
        const postSessionGuard = postSessionReceipt.stamp;
        const assetError = postSessionReceipt.error;
        if (!assetError && item.surface !== "codex-cli") resetBenchmarkPiRuntimeEphemeralState(piRuntimeHome);
        if (!interrupted()) {
          if (assetError) {
            fatalExecutionReceipt = postSessionReceipt;
            if (sessionEvidence) retainWorkspaceForensics({ runRoot, workspaceRoot: sessionEvidence.workspaceRoot, key: sessionEvidence.key, record });
            if (record) {
              persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record, reason: "execution-asset-mismatch-after-provider-attempt", forceTokenUnavailable: forceTokenUnavailableForPostSessionAssetError({ sessionEvidence, record }) });
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
        if (interrupted() && sessionEvidence) {
          retainWorkspaceForensics({ runRoot, workspaceRoot: sessionEvidence.workspaceRoot, key: sessionEvidence.key, record });
          persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record, reason: "interrupted-provider-attempt-not-accepted-as-a-measured-outcome" });
          fs.rmSync(path.join(runRoot, "pending-record.json"), { force: true });
          fs.rmSync(path.join(runRoot, "measured-record-ready.json"), { force: true });
          appendPrivateJsonl(infrastructureLedgerPath, { ...record, accepted: false, interrupted: true });
          fs.rmSync(sessionEvidence.inflightPath, { force: true });
        }
        if (!record.abortSuite || interrupted()) break;
        const failureDisposition = benchmarkInfrastructureFailureDisposition({
          circuit: manifest.transportCircuitBreaker,
          record,
          infrastructureAttempt,
          retryLimit: options.infrastructureRetries,
          orderIndex: fullIndex,
          scenarioId: item.scenario.id,
          surface: item.surface,
          repeat: item.repeat
        });
        manifest.transportCircuitBreaker = failureDisposition.circuit;
        const retryAvailable = failureDisposition.retryAvailable;
        infrastructureFailures.push(failureDisposition.failure);
        if (failureDisposition.unknownCost) {
          manifest.unknownCostAttempts = Number(manifest.unknownCostAttempts ?? 0) + 1;
          manifest.tokenClaimsUnavailableReason = "one-or-more-provider-attempts-have-unknown-usage";
        }
        writeBenchmarkRunManifest(runRoot, manifest);
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
          if (manifest.transportCircuitBreaker.state === "open") {
            fatalRunError = new Error(`Transport circuit breaker opened after ${manifest.transportCircuitBreaker.failures} failures`);
          }
          if (attemptError) fatalRunError = new Error(record.infrastructureFailure ?? "benchmark runner infrastructure error");
          break;
        }
        process.stdout.write(`           RETRY ${infrastructureAttempt}/${options.infrastructureRetries} (${record.infrastructureFailure ?? record.failure})\n`);
        if (options.retryDelaySeconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.retryDelaySeconds * 1_000));
        }
      }
      if (interrupted()) break;
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
      fatalRunError = productionMeasurementInvalidatingOutcomeError(options, suite, record);
      if (fatalRunError) break;
      terminalStop = pairedOutcomeFloorStop({ enabled: options.stopAfterFailedPair, suite, runs, current: item, next: order[index + 1] });
      if (terminalStop) break;
      if (fatalRunError) break;
    }
    if (!pauseReason && options.maxSessions !== undefined && pendingOrder.length > order.length) {
      pauseReason = `max-sessions:${options.maxSessions}`;
    }
  } finally {
    Object.assign(state, { fatalRunError, pauseReason, preservePiRuntime, fatalExecutionReceipt, ledgerBinding, terminalStop });
  }
}

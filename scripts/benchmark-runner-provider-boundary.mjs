import { assertCodexRuntimeCredential } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { exactBenchmarkAttemptUsage } from "../packages/piagent-core/benchmark/benchmark-usage.js";
import { registeredRuntimeVerifierReceipt } from "./benchmark-runner-configuration.mjs";

function boundaryFailure(message) {
  return Object.assign(new Error(message), { exitCode: 1 });
}

export function bindRegisteredRuntimeVerifiers({ registeredMeasurement, registeredMeasurementRun,
  bootstrapMetadata, runtimeCommands, verificationPlan }) {
  if (registeredMeasurementRun && (runtimeCommands.docker?.resolvedPath !== verificationPlan?.dockerCommand?.path
    || runtimeCommands.docker?.contentDigest !== verificationPlan?.dockerCommand?.sha256)) {
    throw boundaryFailure("Registered Docker command identity does not match the signed verification plans");
  }
  return registeredRuntimeVerifierReceipt({ registeredMeasurement, bootstrapMetadata, runtimeCommands });
}

export function createBenchmarkProviderBoundaryGuard({ executionGuard, registeredMeasurement,
  registeredMeasurementRun, registeredRuntimeVerifiers, bootstrapMetadata, runtimeCommands,
  codexRuntime, piRuntimeHome, scenarioId, surface, repeat, infrastructureAttempt }) {
  return stage => {
    const error = executionGuard.check(
      `${stage}:${scenarioId}:${surface}:r${repeat}:attempt${infrastructureAttempt}`, [piRuntimeHome]);
    if (error) throw error;
    if (registeredMeasurement) {
      const current = registeredRuntimeVerifierReceipt({ registeredMeasurement, bootstrapMetadata, runtimeCommands });
      if (JSON.stringify(current) !== JSON.stringify(registeredRuntimeVerifiers)) {
        throw boundaryFailure("Registered runtime verifier bindings changed at a provider boundary");
      }
    }
    if (surface === "codex-cli") {
      assertCodexRuntimeCredential(codexRuntime, { required: registeredMeasurementRun });
    }
  };
}

export function forceTokenUnavailableForPostSessionAssetError({ sessionEvidence, record }) {
  const exactPredispatchUsage = sessionEvidence?.fatalProviderBoundaryError instanceof Error
    && sessionEvidence.fatalProviderBoundaryPhase === "pre-dispatch"
    && record?.providerBoundaryPhase === "pre-dispatch"
    && record?.usageStatus === "measured-but-unaccepted"
    && exactBenchmarkAttemptUsage(record.usage, record.usageStatus);
  return !exactPredispatchUsage;
}

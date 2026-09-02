import crypto from "node:crypto";

import { BENCHMARK_TRANSPORT_CIRCUIT_POLICY } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { benchmarkEnvironmentPolicy } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { benchmarkCommandIdentity } from "../packages/piagent-core/benchmark/benchmark-runtime-identity.js";
import { frozenRuntimeCommandsForFinalization } from "./benchmark-runner-support.mjs";

export function applyRegisteredMeasurementOptions(options, registeredMeasurement) {
  if (!registeredMeasurement) return false;
  if (options.registeredMeasurement && options.registeredMeasurement !== registeredMeasurement.manifestOrigin) {
    throw Object.assign(new Error("Registered measurement invocation does not match its trusted frozen registration"),
      { exitCode: 1 });
  }
  const payload = registeredMeasurement.payload;
  Object.assign(options, { registeredMeasurement: registeredMeasurement.manifestOrigin,
    suite: payload.baseSuiteId, surfaces: [...payload.matrix.surfaces], model: payload.resources.model,
    thinking: payload.resources.thinking, serviceTier: payload.resources.requestedServiceTier,
    codexMode: "controlled", piagentTreatment: payload.treatment, repeats: payload.matrix.repeats,
    infrastructureRetries: payload.resources.infrastructureRetries, timeoutSeconds: payload.resources.timeoutSeconds,
    stopAfterFailedPair: false, measurementOnly: false });
  return true;
}

export function registeredMeasurementBinding(registeredMeasurement) {
  if (!registeredMeasurement) return null;
  return Object.freeze({ schemaVersion: 1, manifestOrigin: registeredMeasurement.manifestOrigin,
    suiteId: registeredMeasurement.payload.suiteId, payloadSha256: registeredMeasurement.identity.payloadSha256,
    manifestSha256: registeredMeasurement.identity.manifestSha256,
    approvalRecordSha256: registeredMeasurement.identity.approvalRecordSha256,
    approvalId: registeredMeasurement.identity.approvalId,
    authorityKeyId: registeredMeasurement.identity.authorityKeyId,
    publicAssetsDigest: registeredMeasurement.inventory.publicAssetsDigest,
    publicContractDigest: registeredMeasurement.inventory.publicContractDigest,
    assetTreeSha256: registeredMeasurement.tree.contentDigest });
}

export function benchmarkRuntimeCommands({ productionFinalizationOnly, resumeManifest, surfaces,
  piCommand, codexCommand, cwd, nodeCommand = process.execPath }) {
  if (productionFinalizationOnly) return frozenRuntimeCommandsForFinalization(resumeManifest, surfaces);
  return { pi: benchmarkCommandIdentity(piCommand, { cwd }),
    codex: surfaces.includes("codex-cli") ? benchmarkCommandIdentity(codexCommand, { cwd }) : null,
    node: benchmarkCommandIdentity(nodeCommand), git: benchmarkCommandIdentity("git"),
    bash: benchmarkCommandIdentity("bash") };
}

export function benchmarkMeasurementConfiguration({ bootstrapMetadata, candidateDigest, suiteDigest,
  runtimeCommands, verificationIdentity, providerWirePlan, productionHostReadinessRequired,
  productionHostReadinessPolicyDigest, productionFinalizationOnly, resumeManifest, rootSeedDigest,
  options, fullOrder }) {
  const environmentPolicy = benchmarkEnvironmentPolicy(), configuration = { schemaVersion: 1,
    source: bootstrapMetadata.sourceIdentity, candidateDigest, suiteDigest,
    runtimeDependencyDigest: bootstrapMetadata.runtimeDependencies?.digest ?? null,
    webUiAssetDigest: bootstrapMetadata.webUiAssets?.digest ?? null, runtimeCommands, environmentPolicy,
    ...(verificationIdentity ? { independentVerification: verificationIdentity } : {}),
    ...(providerWirePlan ? { providerWireProtocol: { version: providerWirePlan.manifest.protocol,
      definitionDigest: providerWirePlan.manifest.definitionDigest, planDigest: providerWirePlan.planDigest } } : {}),
    ...(productionHostReadinessRequired ? { hostReadinessPolicyDigest: productionHostReadinessPolicyDigest } : {}),
    piAgentHome: productionFinalizationOnly ? resumeManifest.piAgentHome?.identity
      : bootstrapMetadata.piAgentHome.identity,
    codexCredential: productionFinalizationOnly ? resumeManifest.codexCredentialIdentity ?? null
      : bootstrapMetadata.codexCredential?.identity ?? null,
    rootSeedDigest, surfaces: options.surfaces, model: options.model ?? null,
    thinking: options.thinking ?? null, serviceTier: options.serviceTier ?? null,
    codexMode: options.codexMode, piagentTreatment: options.piagentTreatment,
    allowPiAuthWriteback: options.allowPiAuthWriteback,
    piCredentialVaultId: bootstrapMetadata.piAgentHome.vaultId, timeoutSeconds: options.timeoutSeconds,
    infrastructureRetries: options.infrastructureRetries, retryDelaySeconds: options.retryDelaySeconds,
    transportCircuitBreaker: BENCHMARK_TRANSPORT_CIRCUIT_POLICY,
    stopAfterFailedPair: options.stopAfterFailedPair,
    ...(options.measurementOnly ? { measurementOnly: true } : {}),
    order: fullOrder.map(item => ({ scenarioId: item.scenario.id, surface: item.surface, repeat: item.repeat })) };
  return Object.freeze({ configuration, environmentPolicy,
    configurationDigest: crypto.createHash("sha256").update(JSON.stringify(configuration)).digest("hex") });
}

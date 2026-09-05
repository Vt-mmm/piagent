import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BENCHMARK_TRANSPORT_CIRCUIT_POLICY } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { benchmarkEnvironmentPolicy } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { benchmarkCommandIdentity, benchmarkStockCodexIdentity } from "../packages/piagent-core/benchmark/benchmark-runtime-identity.js";
import { REGISTERED_BENCHMARK_VERIFIER_IDS
} from "../packages/piagent-core/benchmark/benchmark-suite-identity.js";
import { scopedBrokerSourceClosureSha256, scopedCommonRuntimeClosureIdentity,
  scopedFrozenQualificationIdentity, scopedToolDefinitionsSha256
} from "./benchmark-scoped-frozen-qualification.mjs";
import { frozenRuntimeCommandsForFinalization } from "./benchmark-runner-support.mjs";

const runtimeVerifierIds = Object.freeze([
  "bash-runtime", "broker-source-closure", "candidate-source", "common-runtime-closure",
  "controlled-comparison-runtime", "docker-runtime", "git-runtime", "node-runtime", "npm-runtime", "pi-runtime",
  "pi-sdk-tree", "tool-definitions", "webui-asset-tree", "worker-image"
]);
const evidenceOnlyVerifierIds = Object.freeze(REGISTERED_BENCHMARK_VERIFIER_IDS
  .filter(id => !runtimeVerifierIds.includes(id)));
const verifierFailure = message => { throw Object.assign(new Error(message), { exitCode: 1 }); };

export function assertRegisteredRuntimeVerifierBindings(approvedEntries, observedEntries) {
  if (!Array.isArray(approvedEntries)
    || JSON.stringify(approvedEntries.map(item => item?.id)) !== JSON.stringify(REGISTERED_BENCHMARK_VERIFIER_IDS)) {
    verifierFailure("Registered measurement runtime verifier inventory is incomplete or unsupported");
  }
  const approved = new Map(approvedEntries.map(item => [item.id, item.sha256]));
  const observed = observedEntries instanceof Map ? observedEntries : new Map(observedEntries);
  for (const id of runtimeVerifierIds) if (!/^[a-f0-9]{64}$/.test(String(observed.get(id) ?? ""))
    || approved.get(id) !== observed.get(id)) {
    verifierFailure(`Registered measurement runtime verifier mismatch: ${id}`);
  }
  return Object.freeze(runtimeVerifierIds.map(id => Object.freeze({ id, sha256: observed.get(id) })));
}

export function registeredRuntimeVerifierReceipt({ registeredMeasurement, bootstrapMetadata,
  runtimeCommands } = {}) {
  if (!registeredMeasurement) return null;
  const approvedEntries = registeredMeasurement.payload?.resources?.verifiers;
  const common = scopedCommonRuntimeClosureIdentity(), qualification = scopedFrozenQualificationIdentity({
    version: 4,
    candidateRoot: bootstrapMetadata.snapshotRoot,
    assetsRoot: bootstrapMetadata.webUiAssets?.root,
    sdkRoot: runtimeCommands.pi?.packageClosure?.root,
    candidateIndexPath: bootstrapMetadata.candidateIndex?.path,
    candidateIndexSha256: bootstrapMetadata.candidateIndex?.digest
  }, common.sha256);
  let workerImageId;
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(registeredMeasurement.assetRoot,
      "measurement", "node-workload-api-v1.json"), "utf8"));
    workerImageId = profile.workerImage?.id;
  } catch {
    verifierFailure("Registered measurement worker image identity is unavailable");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(workerImageId ?? ""))) {
    verifierFailure("Registered measurement worker image identity is invalid");
  }
  const npm = benchmarkCommandIdentity(path.join(path.dirname(runtimeCommands.node.resolvedPath), "npm"));
  const observed = new Map([
    ["bash-runtime", runtimeCommands.bash?.contentDigest],
    ["broker-source-closure", scopedBrokerSourceClosureSha256()],
    ["candidate-source", qualification.sourceSha256],
    ["common-runtime-closure", qualification.brokerClosureSha256],
    ["controlled-comparison-runtime", runtimeCommands.codex?.contentDigest],
    ["docker-runtime", runtimeCommands.docker?.contentDigest],
    ["git-runtime", runtimeCommands.git?.contentDigest],
    ["node-runtime", runtimeCommands.node?.contentDigest],
    ["npm-runtime", npm.contentDigest],
    ["pi-runtime", runtimeCommands.pi?.contentDigest],
    ["pi-sdk-tree", qualification.sdkTreeSha256],
    ["tool-definitions", scopedToolDefinitionsSha256()],
    ["webui-asset-tree", qualification.assetTreeSha256],
    ["worker-image", workerImageId.slice("sha256:".length)]
  ]);
  const bindings = assertRegisteredRuntimeVerifierBindings(approvedEntries, observed);
  const receipt = { schemaVersion: 1, kind: "registered-runtime-verifier-receipt-v1", outcome: "PASS",
    bindings, evidenceOnlyVerifierIds: [...evidenceOnlyVerifierIds], providerSessionsStarted: 0 };
  return Object.freeze({ ...receipt,
    contentDigest: crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex") });
}

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
    codexMode: "controlled", codexBaseline: "controlled-custom", piagentTreatment: payload.treatment, repeats: payload.matrix.repeats,
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
  piCommand, codexCommand, codexBaseline, dockerCommand, cwd, nodeCommand = process.execPath }) {
  if (productionFinalizationOnly) return frozenRuntimeCommandsForFinalization(resumeManifest, surfaces);
  return { pi: benchmarkCommandIdentity(piCommand, { cwd }),
    codex: surfaces.includes("codex-cli") ? (codexBaseline === "stock"
      ? benchmarkStockCodexIdentity(codexCommand, { cwd }) : benchmarkCommandIdentity(codexCommand, { cwd })) : null,
    ...(dockerCommand ? { docker: benchmarkCommandIdentity(dockerCommand,
      { cwd, fullPackageClosure: false }) } : {}),
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
    codexMode: options.codexMode, codexBaseline: options.codexBaseline, piagentTreatment: options.piagentTreatment,
    allowPiAuthWriteback: options.allowPiAuthWriteback,
    ...(options.budgetControl ? { budgetControl: options.budgetControl } : {}),
    piCredentialVaultId: bootstrapMetadata.piAgentHome.vaultId, timeoutSeconds: options.timeoutSeconds,
    infrastructureRetries: options.infrastructureRetries, retryDelaySeconds: options.retryDelaySeconds,
    transportCircuitBreaker: BENCHMARK_TRANSPORT_CIRCUIT_POLICY,
    stopAfterFailedPair: options.stopAfterFailedPair,
    ...(options.campaignStopPolicy ? { campaignStopPolicy: options.campaignStopPolicy } : {}),
    ...(options.measurementOnly ? { measurementOnly: true } : {}),
    order: fullOrder.map(item => ({ scenarioId: item.scenario.id, surface: item.surface, repeat: item.repeat })) };
  return Object.freeze({ configuration, environmentPolicy,
    configurationDigest: crypto.createHash("sha256").update(JSON.stringify(configuration)).digest("hex") });
}

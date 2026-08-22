const SHA256 = /^[a-f0-9]{64}$/;

function requestedProviderModelId(requestedModel) {
  const value = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (!value) return null;
  const separator = value.indexOf("/");
  const modelId = separator >= 0 ? value.slice(separator + 1) : value;
  return modelId && !modelId.includes("/") ? modelId : null;
}

function requestedProviderReasoningEffort(requestedThinking) {
  const value = typeof requestedThinking === "string" ? requestedThinking.trim() : "";
  if (!value) return null;
  if (value === "off") return "none";
  if (value === "minimal") return "low";
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * Reduces privacy-safe provider request fingerprints into per-run release
 * evidence. Deferred tool-search batches are observed separately: changes to
 * those hashes do not count as base system/tool prefix drift.
 */
export function buildBenchmarkProviderWireEvidence({
  events,
  requestedModel,
  requestedThinking,
  telemetryTruncated = false
}) {
  const expectedModelId = requestedProviderModelId(requestedModel);
  const expectedReasoningEffort = requestedProviderReasoningEffort(requestedThinking);
  const wireEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event?.event === "provider_request_wire_surface");
  const knownEvents = wireEvents.filter((event) => event.state === "known");
  const instructionHashes = sortedUnique(knownEvents
    .map((event) => event.instructionsHash)
    .filter((value) => SHA256.test(value ?? "")));
  const baseInstructionHashes = sortedUnique(knownEvents
    .map((event) => event.baseInstructionsHash)
    .filter((value) => SHA256.test(value ?? "")));
  const orderedToolSurfaceHashes = sortedUnique(knownEvents
    .map((event) => event.orderedToolSurfaceHash)
    .filter((value) => SHA256.test(value ?? "")));
  const deferredToolSurfaceHashes = sortedUnique(knownEvents
    .map((event) => event.deferredToolSurfaceHash)
    .filter((value) => SHA256.test(value ?? "")));
  const unknownEvents = wireEvents.length - knownEvents.length;
  const missingBaseHashEvents = knownEvents.filter((event) => (
    !SHA256.test(event.instructionsHash ?? "")
    || !SHA256.test(event.baseInstructionsHash ?? "")
    || !SHA256.test(event.orderedToolSurfaceHash ?? "")
  )).length;
  const modelMismatchEvents = knownEvents.filter((event) => (
    expectedModelId === null || event.providerModelId !== expectedModelId
  )).length;
  const reasoningMismatchEvents = knownEvents.filter((event) => (
    expectedReasoningEffort === null || event.providerReasoningEffort !== expectedReasoningEffort
  )).length;
  const deferredToolBatchEvents = knownEvents.filter((event) => Number(event.deferredToolBatchCount ?? 0) > 0).length;
  const checks = {
    "telemetry-complete": telemetryTruncated !== true,
    "wire-events-observed": wireEvents.length > 0,
    "wire-events-known": wireEvents.length > 0 && unknownEvents === 0,
    "requested-model-exact": wireEvents.length > 0 && modelMismatchEvents === 0,
    "requested-reasoning-effort-exact": wireEvents.length > 0 && reasoningMismatchEvents === 0,
    "base-instructions-available-and-stable": wireEvents.length > 0
      && missingBaseHashEvents === 0
      && instructionHashes.length === 1
      && baseInstructionHashes.length === 1,
    "base-tool-surface-available-and-stable": wireEvents.length > 0 && missingBaseHashEvents === 0 && orderedToolSurfaceHashes.length === 1
  };
  return {
    schemaVersion: 1,
    state: Object.values(checks).every(Boolean) ? "verified" : wireEvents.length > 0 ? "failed" : "unavailable",
    passed: Object.values(checks).every(Boolean),
    expectedModelId,
    expectedReasoningEffort,
    telemetryTruncated: telemetryTruncated === true,
    wireEvents: wireEvents.length,
    knownEvents: knownEvents.length,
    unknownEvents,
    missingBaseHashEvents,
    modelMismatchEvents,
    reasoningMismatchEvents,
    instructionHashes,
    baseInstructionHashes,
    orderedToolSurfaceHashes,
    deferred: {
      toolSurfaceHashes: deferredToolSurfaceHashes,
      toolBatchEvents: deferredToolBatchEvents,
      maximumBatchCount: knownEvents.reduce((maximum, event) => Math.max(maximum, Number(event.deferredToolBatchCount ?? 0)), 0),
      maximumToolCount: knownEvents.reduce((maximum, event) => Math.max(maximum, Number(event.deferredToolCount ?? 0)), 0)
    },
    checks
  };
}

export function benchmarkProviderWireEvidenceMatchesRequest(evidence, requestedModel, requestedThinking) {
  const expectedModelId = requestedProviderModelId(requestedModel);
  const expectedReasoningEffort = requestedProviderReasoningEffort(requestedThinking);
  return evidence?.schemaVersion === 1
    && evidence.passed === true
    && evidence.state === "verified"
    && evidence.expectedModelId === expectedModelId
    && evidence.expectedReasoningEffort === expectedReasoningEffort
    && expectedModelId !== null
    && expectedReasoningEffort !== null
    && evidence.telemetryTruncated === false
    && Number.isInteger(evidence.wireEvents) && evidence.wireEvents > 0
    && evidence.knownEvents === evidence.wireEvents
    && evidence.unknownEvents === 0
    && evidence.missingBaseHashEvents === 0
    && evidence.modelMismatchEvents === 0
    && evidence.reasoningMismatchEvents === 0
    && Array.isArray(evidence.instructionHashes) && evidence.instructionHashes.length === 1 && SHA256.test(evidence.instructionHashes[0])
    && Array.isArray(evidence.baseInstructionHashes) && evidence.baseInstructionHashes.length === 1 && SHA256.test(evidence.baseInstructionHashes[0])
    && Array.isArray(evidence.orderedToolSurfaceHashes) && evidence.orderedToolSurfaceHashes.length === 1 && SHA256.test(evidence.orderedToolSurfaceHashes[0]);
}

export function benchmarkRequestedProviderReasoningEffort(requestedThinking) {
  return requestedProviderReasoningEffort(requestedThinking);
}

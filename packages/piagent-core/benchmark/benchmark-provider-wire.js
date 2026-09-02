import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

function serviceTierValue(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["default", "fast", "priority"].includes(normalized) ? normalized : null;
}

function serviceTierEvidence(events) {
  const tierEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event?.event === "provider_request_service_tier");
  const requestedTiers = sortedUnique(tierEvents.map((event) => serviceTierValue(event.requestedServiceTier)).filter(Boolean));
  const observedRequestTiers = sortedUnique(tierEvents
    .map((event) => serviceTierValue(event.observedRequestServiceTier ?? event.observedServiceTier))
    .filter(Boolean));
  const providerResponseTiers = sortedUnique(tierEvents
    .map((event) => serviceTierValue(event.providerResponseServiceTier))
    .filter(Boolean));
  const responseEvidence = sortedUnique(tierEvents
    .map((event) => typeof event.providerResponseEvidence === "string"
      ? event.providerResponseEvidence
      : typeof event.responseEvidence === "string" ? event.responseEvidence : null)
    .filter(Boolean));
  const requestedFastEvents = tierEvents.filter((event) => (
    serviceTierValue(event.requestedServiceTier) === "fast"
  )).length;
  const observedFastRequestEvents = tierEvents.filter((event) => (
    serviceTierValue(event.observedRequestServiceTier ?? event.observedServiceTier) === "priority"
  )).length;
  const fastModeEvents = tierEvents.filter((event) => event.fastMode === true || event.fastMode === "fast").length;
  const appliedEvents = tierEvents.filter((event) => event.applied === true).length;
  const appliedFastEvents = tierEvents.filter((event) => (
    (event.fastMode === true || event.fastMode === "fast")
    && serviceTierValue(event.requestedServiceTier) === "fast"
    && serviceTierValue(event.observedRequestServiceTier ?? event.observedServiceTier) === "priority"
    && event.applied === true
  )).length;
  return {
    schemaVersion: 1,
    source: "piagent-provider-request-telemetry",
    events: tierEvents.length,
    requestedTiers,
    observedRequestTiers,
    providerResponseTiers,
    responseEvidence,
    requestedFastEvents,
    observedFastRequestEvents,
    fastModeEvents,
    appliedEvents,
    appliedFastEvents,
    defaultFallbackEvents: tierEvents.filter((event) => [
      serviceTierValue(event.requestedServiceTier),
      serviceTierValue(event.observedRequestServiceTier ?? event.observedServiceTier),
      serviceTierValue(event.providerResponseServiceTier)
    ].includes("default")).length
  };
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
    serviceTier: serviceTierEvidence(events),
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

export const BENCHMARK_WIRE_PROTOCOL = "phase-valid-configuration-v1";
export const BENCHMARK_WIRE_PHASE_EDGES = Object.freeze(Object.fromEntries(Object.entries({
  intake: ["scout", "plan", "execute", "review", "handoff", "terminal"],
  scout: ["plan", "review", "handoff", "terminal"], plan: ["execute", "review", "handoff", "terminal"],
  execute: ["verify", "repair", "handoff", "terminal"], verify: ["repair", "review", "handoff", "terminal"],
  repair: ["verify", "handoff", "terminal"], review: ["repair", "handoff", "terminal"], handoff: ["terminal"], terminal: []
}).map(([phase, next]) => [phase, Object.freeze(next)])));
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const wireObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const wireHash = value => crypto.createHash("sha256").update(value).digest("hex");
const wireFields = (value, fields) => wireObject(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field));
function wireReject(reason) {
  const error = new TypeError(`Benchmark wire manifest rejected: ${reason}`);
  error.code = "BENCHMARK_WIRE_MANIFEST_REJECTED";
  throw error;
}
function wirePublicKey(value) {
  try {
    if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(value, "base64"), type: "spki", format: "der" });
    return key.asymmetricKeyType === "ed25519" && key.export({ type: "spki", format: "der" }).toString("base64") === value;
  } catch { return false; }
}
function validWireFingerprint(value, selectedTools) {
  return wireFields(value, ["applicable", "state", "reasonCode", "modelId", "instructionsHash", "baseInstructionsHash",
    "instructionNormalization", "instructionChars", "orderedToolSurfaceHash", "toolCount", "deferredToolSurfaceHash",
    "deferredToolCount", "deferredToolBatchCount", "reasoningEffort", "textVerbosity", "toolChoiceKind", "toolChoiceHash", "requestPrefixFingerprint"])
    && value.applicable === true && value.state === "known" && value.reasonCode === null && value.modelId === "gpt-5.6-luna"
    && ["instructionsHash", "baseInstructionsHash", "orderedToolSurfaceHash", "deferredToolSurfaceHash", "toolChoiceHash", "requestPrefixFingerprint"].every(key => SHA256.test(value[key]))
    && ["none", "host-relocation-v1"].includes(value.instructionNormalization)
    && Number.isSafeInteger(value.instructionChars) && value.instructionChars > 0 && value.instructionChars <= 1_000_000
    && value.toolCount === selectedTools.length && value.deferredToolCount === 0 && value.deferredToolBatchCount === 0
    && value.deferredToolSurfaceHash === wireHash("[]") && value.reasoningEffort === "medium" && value.textVerbosity === "low"
    && value.toolChoiceKind === "auto" && value.toolChoiceHash === wireHash(JSON.stringify("auto"))
    && value.requestPrefixFingerprint === wireHash(JSON.stringify({ schemaVersion: 1, modelId: value.modelId,
      instructionsHash: value.instructionsHash, baseInstructionsHash: value.baseInstructionsHash,
      orderedToolSurfaceHash: value.orderedToolSurfaceHash, toolCount: value.toolCount,
      deferredToolSurfaceHash: value.deferredToolSurfaceHash, deferredToolCount: value.deferredToolCount,
      deferredToolBatchCount: value.deferredToolBatchCount, reasoningEffort: value.reasoningEffort,
      textVerbosity: value.textVerbosity, toolChoiceHash: value.toolChoiceHash }));
}

/** Data validation only: a definition plan or valid manifest never grants dispatch or task authority. */
export function validateBenchmarkWireManifest(manifest, { template = false, ...expected } = {}) {
  if (!wireObject(manifest) || Buffer.byteLength(JSON.stringify(manifest)) > 4 * 1024 * 1024) wireReject("manifest-shape");
  const required = ["schemaVersion", "protocol", "source", "candidateDigest", "definitionDigest", "workingDirectory", "model",
    "thinking", "requestedTier", "requestTier", "states", "allowedEdges", "pins"];
  const optional = ["configurationDigest", "receiptPublicKey", "platformRoot"];
  if (!required.every(key => Object.hasOwn(manifest, key)) || Object.keys(manifest).some(key => ![...required, ...optional].includes(key))
    || manifest.schemaVersion !== 1 || manifest.protocol !== BENCHMARK_WIRE_PROTOCOL || manifest.source !== "pinned-host-definitions"
    || !SHA256.test(manifest.candidateDigest) || !SHA256.test(manifest.definitionDigest)
    || !path.isAbsolute(manifest.workingDirectory ?? "") || path.normalize(manifest.workingDirectory) !== manifest.workingDirectory
    || manifest.model !== "openai-codex/gpt-5.6-luna" || manifest.thinking !== "medium"
    || manifest.requestedTier !== "fast" || manifest.requestTier !== "priority") wireReject("identity");
  if ((!template || Object.hasOwn(manifest, "configurationDigest")) && !SHA256.test(manifest.configurationDigest)) wireReject("configuration-digest");
  if ((!template || Object.hasOwn(manifest, "receiptPublicKey")) && !wirePublicKey(manifest.receiptPublicKey)) wireReject("receipt-public-key");
  if (Object.hasOwn(manifest, "platformRoot") && (!path.isAbsolute(manifest.platformRoot ?? "")
    || path.normalize(manifest.platformRoot) !== manifest.platformRoot)) wireReject("platform-root");
  for (const [key, value] of Object.entries(expected)) if (manifest[key] !== value) wireReject(`binding-${key}`);
  if (!wireObject(manifest.allowedEdges) || JSON.stringify(manifest.allowedEdges) !== JSON.stringify(BENCHMARK_WIRE_PHASE_EDGES)) wireReject("phase-graph");
  if (!Array.isArray(manifest.pins) || manifest.pins.length < 1 || manifest.pins.length > 512
    || manifest.pins.some(pin => !wireFields(pin, ["path", "sha256"]) || !path.isAbsolute(pin.path ?? "")
      || path.normalize(pin.path) !== pin.path || !SHA256.test(pin.sha256))
    || new Set(manifest.pins.map(pin => pin.path)).size !== manifest.pins.length) wireReject("definition-pins");
  if (manifest.platformRoot && !manifest.pins.some(pin => pin.path.startsWith(manifest.platformRoot + path.sep))) wireReject("platform-source-unpinned");
  if (!Array.isArray(manifest.states) || manifest.states.length < 1 || manifest.states.length > 512) wireReject("states");
  const ids = new Set(), selectors = new Set();
  for (const state of manifest.states) {
    if (!wireFields(state, ["id", "operatorInputHash", "inputHash", "phase", "taskPresence", "selectedTools", "fingerprint"])
      || !WIRE_ID.test(state.id ?? "") || !SHA256.test(state.operatorInputHash) || !SHA256.test(state.inputHash)
      || !["none", "current"].includes(state.taskPresence)
      || (state.taskPresence === "none" ? state.phase !== null : !Object.hasOwn(BENCHMARK_WIRE_PHASE_EDGES, state.phase))
      || !Array.isArray(state.selectedTools) || state.selectedTools.length > 512
      || state.selectedTools.some(name => !WIRE_ID.test(name)) || new Set(state.selectedTools).size !== state.selectedTools.length
      || !validWireFingerprint(state.fingerprint, state.selectedTools)) wireReject("state");
    const selector = JSON.stringify([state.operatorInputHash, state.inputHash, state.phase, state.taskPresence]);
    if (ids.has(state.id) || selectors.has(selector)) wireReject("ambiguous-state");
    ids.add(state.id); selectors.add(selector);
  }
  return manifest;
}

/** Exact material ordering is intentional and shared with signed host receipt custody. */
export function benchmarkWireManifestDigest(manifest) {
  return wireHash(JSON.stringify(validateBenchmarkWireManifest(manifest)));
}
export function benchmarkWireDefinitionPlanDigest(manifest) {
  validateBenchmarkWireManifest(manifest, { template: true });
  const { configurationDigest: _configuration, receiptPublicKey: _key, ...plan } = manifest;
  return wireHash(JSON.stringify(plan));
}

/** Use only an isolated, pre-input public SDK session and the shared guard projection. */
export function projectBenchmarkWireState({ session, convertResponsesTools, fingerprint, rewriteInstructions, projection, model,
  workingDirectory, platformRoot }) {
  if (!wireObject(projection) || projection.disposition !== "known" || typeof convertResponsesTools !== "function"
    || typeof fingerprint !== "function" || typeof rewriteInstructions !== "function"
    || model?.provider !== "openai-codex" || model?.id !== "gpt-5.6-luna"
    || !Array.isArray(projection.selectedTools) || ![null, "automatic", "protected"].includes(projection.compactMode)) wireReject("projection-unresolved");
  const definitions = projection.selectedTools.map(name => session.getToolDefinition(name));
  if (definitions.some(tool => !tool || tool.deferLoading === true)) wireReject("tool-definition-unavailable-or-deferred");
  session.setActiveToolsByName(projection.selectedTools);
  if (JSON.stringify(session.getActiveToolNames()) !== JSON.stringify(projection.selectedTools)) wireReject("tool-selection-mismatch");
  const instructions = rewriteInstructions(session.systemPrompt, projection.compactMode);
  if (typeof instructions !== "string" || !instructions) wireReject("instructions-unavailable");
  const tools = convertResponsesTools(definitions, { strict: null, supportsStrictMode: model.compat?.supportsStrictMode ?? true,
    supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false });
  const payload = { model: model.id, instructions, tools, input: [], tool_choice: "auto", reasoning: { effort: model.thinkingLevelMap?.medium ?? "medium" }, text: { verbosity: "low" }, service_tier: "priority" };
  const state = { id: projection.id, operatorInputHash: projection.operatorInputHash, inputHash: projection.inputHash,
    phase: projection.phase, taskPresence: projection.taskPresence, selectedTools: [...projection.selectedTools],
    fingerprint: fingerprint({ payload, provider: model.provider, modelId: model.id, workingDirectory, platformRoot }) };
  if (!validWireFingerprint(state.fingerprint, state.selectedTools)) wireReject("projection-fingerprint");
  return state;
}

function wirePrivateBytes(file, maximumBytes, outsideProject) {
  if (typeof file !== "string" || !path.isAbsolute(file) || fs.realpathSync.native(file) !== file) wireReject("private-file-path");
  if (outsideProject) {
    const relative = path.relative(fs.realpathSync.native(outsideProject), file);
    if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) wireReject("custody-inside-project");
  }
  const parent = fs.lstatSync(path.dirname(file)), before = fs.lstatSync(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700
    || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
    || uid !== null && (parent.uid !== uid || before.uid !== uid) || before.size > maximumBytes) wireReject("private-file-custody");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) wireReject("private-file-replaced");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (bytes.length > maximumBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) wireReject("private-file-changed");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function wireAssertPins(manifest) {
  for (const pin of manifest.pins) {
    if (/\/(?:auth|settings|models|trust|credentials|secrets)\.json$|\/(?:\.env(?:\.[^/]*)?|\.cache|sessions)(?:\/|$)/i.test(pin.path)) wireReject("sensitive-definition-pin");
    if (fs.realpathSync.native(pin.path) !== pin.path || !fs.lstatSync(pin.path).isFile()
      || fs.statSync(pin.path).size > 16 * 1024 * 1024 || wireHash(fs.readFileSync(pin.path)) !== pin.sha256) wireReject("definition-pin-drift");
  }
}

/** Read only an explicitly supplied, private, hash-bound definition plan. Missing configuration stays legacy. */
export function readBenchmarkWireDefinitionPlan({ file, sha256 } = {}) {
  if (file === undefined && sha256 === undefined) return null;
  if (!SHA256.test(sha256 ?? "")) wireReject("definition-plan-digest");
  const bytes = wirePrivateBytes(file, 4 * 1024 * 1024);
  if (wireHash(bytes) !== sha256) wireReject("definition-plan-file-drift");
  const manifest = validateBenchmarkWireManifest(JSON.parse(bytes.toString("utf8")), { template: true });
  wireAssertPins(manifest);
  return { manifest: structuredClone(manifest), file, fileSha256: sha256, planDigest: benchmarkWireDefinitionPlanDigest(manifest) };
}

/** Per-attempt custody only. It neither compiles missing states nor authorizes a provider attempt. */
export function freezeBenchmarkWireInvocation({ plan, workingDirectory, platformRoot, custodyRoot, configurationDigest, candidateDigest }) {
  if (!plan) return null;
  const current = readBenchmarkWireDefinitionPlan({ file: plan.file, sha256: plan.fileSha256 });
  if (current.planDigest !== plan.planDigest || JSON.stringify(current.manifest) !== JSON.stringify(plan.manifest)) wireReject("definition-plan-changed");
  validateBenchmarkWireManifest(current.manifest, { template: true, workingDirectory, candidateDigest,
    ...(current.manifest.platformRoot ? { platformRoot } : {}) });
  if (wireHash(wirePrivateBytes(current.file, 4 * 1024 * 1024, workingDirectory)) !== current.fileSha256) wireReject("definition-plan-custody-drift");
  if (!SHA256.test(configurationDigest)) wireReject("configuration-digest");
  if (Object.hasOwn(current.manifest, "configurationDigest") && current.manifest.configurationDigest !== configurationDigest) wireReject("binding-configurationDigest");
  const project = fs.realpathSync.native(workingDirectory), root = fs.realpathSync.native(custodyRoot);
  const relative = path.relative(project, root);
  if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) wireReject("custody-inside-project");
  const directory = fs.mkdtempSync(path.join(root, "provider-wire-"));
  fs.chmodSync(directory, 0o700);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const manifest = { ...current.manifest, configurationDigest, receiptPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  validateBenchmarkWireManifest(manifest, { workingDirectory: project, configurationDigest, candidateDigest });
  const files = { manifest: path.join(directory, "manifest.json"), signingKey: path.join(directory, "receipt-signing-key.pem"), receipts: path.join(directory, "receipts.jsonl") };
  const writes = [[files.manifest, JSON.stringify(manifest)], [files.signingKey, privateKey.export({ type: "pkcs8", format: "pem" })], [files.receipts, ""]];
  for (const [file, bytes] of writes) {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const directoryFd = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  const manifestDigest = benchmarkWireManifestDigest(manifest);
  if (wireHash(wirePrivateBytes(files.manifest, 4 * 1024 * 1024, project)) !== manifestDigest
    || wirePrivateBytes(files.receipts, 64 * 1024 * 1024, project).length !== 0) wireReject("custody-readback");
  const key = crypto.createPrivateKey(wirePrivateBytes(files.signingKey, 16 * 1024, project));
  if (crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") !== manifest.receiptPublicKey) wireReject("signing-key-readback");
  return { manifest, manifestDigest, directory, files, environment: {
    PIAGENT_WIRE_MANIFEST_PATH: files.manifest, PIAGENT_WIRE_MANIFEST_SHA256: manifestDigest,
    PIAGENT_WIRE_SIGNING_KEY_PATH: files.signingKey, PIAGENT_WIRE_RECEIPTS_PATH: files.receipts
  } };
}

/** Retain raw signed host envelopes; the separate reducer decides graph/authority validity. */
export function readBenchmarkWireReceipts(invocation, bindings = {}) {
  if (!invocation) return null;
  const { manifest, files, manifestDigest } = invocation;
  if (wireHash(wirePrivateBytes(files.manifest, 4 * 1024 * 1024, manifest.workingDirectory)) !== manifestDigest) wireReject("manifest-custody-drift");
  const bytes = wirePrivateBytes(files.receipts, 64 * 1024 * 1024, manifest.workingDirectory);
  if (bytes.length && bytes.at(-1) !== 10) wireReject("receipt-partial-tail");
  const receipts = bytes.toString("utf8").split("\n").filter(Boolean).map(line => {
    const envelope = JSON.parse(line);
    if (!wireFields(envelope, ["material", "signature"]) || typeof envelope.material !== "string"
      || typeof envelope.signature !== "string" || envelope.material.length > 2 * 1024 * 1024) wireReject("receipt-envelope");
    return envelope;
  });
  return { schemaVersion: 1, protocol: BENCHMARK_WIRE_PROTOCOL, manifestDigest, manifest: structuredClone(manifest),
    receipts, receiptBytesSha256: wireHash(bytes), state: "unverified-host-receipts",
    requestValidation: buildBenchmarkPhaseWireEvidence({ ...bindings, manifest, receipts }) };
}

/** Verify pre-admission observations separately from legacy prefix stability and terminal/accounting settlement.
 * Expected identities and count must come from the invoking host, never from these receipts themselves.
 */
export function buildBenchmarkPhaseWireEvidence({ manifest, receipts, expected, expectedReceiptCount, telemetryTruncated = false, trajectoryPolicy } = {}) {
  const result = { schemaVersion: 1, protocol: BENCHMARK_WIRE_PROTOCOL, state: "unavailable", passed: false,
    scope: "authenticated-pre-admission-observations", receiptCount: Array.isArray(receipts) ? receipts.length : 0,
    reason: "independent-host-binding-unavailable", legacyPrefixVerdictUnchanged: true,
    provesAdmission: false, provesProviderDispatch: false, provesTerminalSettlement: false, provesUsage: false };
  if (!expected || !["manifestDigest", "candidateDigest", "configurationDigest", "definitionDigest"].every(key => SHA256.test(expected[key] ?? ""))
    || !WIRE_ID.test(expected.sessionId ?? "") || !WIRE_ID.test(expected.runtimeInstanceRef ?? "")
    || !path.isAbsolute(expected.workingDirectory ?? "") || !Array.isArray(expected.operations) || !expected.operations.length
    || !Number.isSafeInteger(expectedReceiptCount) || expectedReceiptCount < 1) return result;
  if (typeof trajectoryPolicy?.create !== "function" || typeof trajectoryPolicy?.reduce !== "function")
    return { ...result, reason: "pinned-trajectory-policy-unavailable" };
  const demand = (condition, reason) => { if (!condition) throw new Error(reason); };
  try {
    validateBenchmarkWireManifest(manifest, { candidateDigest: expected.candidateDigest, configurationDigest: expected.configurationDigest,
      definitionDigest: expected.definitionDigest, workingDirectory: expected.workingDirectory });
    demand(benchmarkWireManifestDigest(manifest) === expected.manifestDigest, "manifest-binding-mismatch");
    demand(telemetryTruncated === false && Array.isArray(receipts) && receipts.length === expectedReceiptCount
      && receipts.length <= 65536, "request-evidence-incomplete");
    const admissions = new Map(), requestIds = new Set();
    for (const admission of expected.operations) {
      demand(wireFields(admission, ["operationRef", "messageRequestId", "operatorInputHash"])
        && WIRE_ID.test(admission.operationRef) && WIRE_ID.test(admission.messageRequestId) && SHA256.test(admission.operatorInputHash)
        && !admissions.has(admission.operationRef) && !requestIds.has(admission.messageRequestId), "expected-operation-invalid");
      admissions.set(admission.operationRef, admission); requestIds.add(admission.messageRequestId);
    }
    const publicKey = crypto.createPublicKey({ key: Buffer.from(manifest.receiptPublicKey, "base64"), type: "spki", format: "der" });
    const seenOperations = new Set(), seenTurns = new Set(), seenTasks = new Set(), eventIds = new Set();
    let previousHash = null, operation = null, accepted = null, task = null;
    for (const [index, envelope] of receipts.entries()) {
      demand(wireFields(envelope, ["material", "signature"]) && typeof envelope.material === "string" && envelope.material.length <= 2 * 1024 * 1024
        && typeof envelope.signature === "string" && Buffer.from(envelope.signature, "base64").length === 64
        && Buffer.from(envelope.signature, "base64").toString("base64") === envelope.signature
        && crypto.verify(null, Buffer.from(envelope.material), publicKey, Buffer.from(envelope.signature, "base64")), "signature-invalid");
      const row = JSON.parse(envelope.material);
      demand(wireFields(row, ["schemaVersion", "protocol", "manifestDigest", "sequence", "previousReceiptHash", "sessionId", "workingDirectory",
        "runtimeInstanceRef", "operationRef", "messageRequestId", "operatorInputHash", "inputHash", "turnId", "taskId", "taskRunId", "phase",
        "trajectorySequence", "stateId", "fingerprint", "events"]), "receipt-fields-invalid");
      demand(row.schemaVersion === 1 && row.protocol === BENCHMARK_WIRE_PROTOCOL && row.manifestDigest === expected.manifestDigest
        && row.sessionId === expected.sessionId && row.runtimeInstanceRef === expected.runtimeInstanceRef
        && row.workingDirectory === expected.workingDirectory, "receipt-binding-mismatch");
      demand(row.sequence === index + 1 && row.previousReceiptHash === previousHash, "receipt-order-invalid");
      demand(Array.isArray(row.events) && row.events.length <= 1024, "events-invalid");
      for (const event of row.events) {
        demand(wireObject(event), "event-invalid");
        if (event.type === "operation-accepted") {
          const admission = admissions.get(event.operationRef);
          demand(wireFields(event, ["type", "operationRef", "messageRequestId", "operatorInputHash", "predecessorReceiptHash"])
            && !operation && admission && !seenOperations.has(event.operationRef) && event.predecessorReceiptHash === previousHash
            && event.messageRequestId === admission.messageRequestId && event.operatorInputHash === admission.operatorInputHash, "operation-not-authorized");
          operation = admission; accepted = null; seenOperations.add(event.operationRef);
        } else if (event.type === "input-accepted") {
          demand(wireFields(event, ["type", "operationRef", "messageRequestId", "operatorInputHash", "inputHash", "turnId", "source"])
            && operation && !accepted && event.operationRef === operation.operationRef && event.messageRequestId === operation.messageRequestId
            && event.operatorInputHash === operation.operatorInputHash && SHA256.test(event.inputHash) && WIRE_ID.test(event.turnId)
            && !seenTurns.has(event.turnId) && ["rpc", "interactive", "extension"].includes(event.source), "input-not-authorized");
          accepted = event; seenTurns.add(event.turnId);
        } else if (event.type === "operation-closed") {
          demand(wireFields(event, ["type", "operationRef", "messageRequestId", "reason"]) && operation
            && event.operationRef === operation.operationRef && event.messageRequestId === operation.messageRequestId
            && typeof event.reason === "string" && event.reason.length > 0 && event.reason.length <= 2048, "operation-close-invalid");
          operation = null; accepted = null;
        } else if (event.type === "task-attached") {
          const initial = event.initialState;
          demand(wireFields(event, ["type", "initialState"]) && operation && accepted && !task && wireObject(initial)
            && WIRE_ID.test(initial.taskId) && WIRE_ID.test(initial.taskRunId) && !seenTasks.has(initial.taskRunId), "task-attachment-invalid");
          const policyState = trajectoryPolicy.create({ taskId: initial.taskId, taskRunId: initial.taskRunId,
            sessionId: expected.sessionId, changeMode: initial.changeMode, riskLane: initial.riskLane,
            recommendationRef: initial.recommendationRef, createdAt: initial.createdAt });
          demand(JSON.stringify(policyState) === JSON.stringify(initial), "initial-trajectory-state-invalid");
          task = { taskId: initial.taskId, taskRunId: initial.taskRunId, phase: "intake", sequence: 0, policyState };
          seenTasks.add(initial.taskRunId);
        } else if (event.type === "task-detached") {
          demand(wireFields(event, ["type", "taskId", "taskRunId", "outcome"]) && !operation && task?.phase === "terminal"
            && event.taskId === task.taskId && event.taskRunId === task.taskRunId && WIRE_ID.test(event.outcome)
            && event.outcome !== "pending", "task-detachment-invalid");
          task = null;
        } else if (event.type === "phase-transition") {
          const transition = event.event;
          demand(wireFields(event, ["type", "event"]) && operation && accepted && task && wireObject(transition)
            && transition.taskId === task.taskId && transition.taskRunId === task.taskRunId
            && transition.sessionHash === wireHash(expected.sessionId) && transition.sequence === task.sequence + 1
            && transition.from === task.phase && BENCHMARK_WIRE_PHASE_EDGES[task.phase]?.includes(transition.to)
            && !eventIds.has(transition.eventId), "phase-edge-or-cause-invalid");
          // The entrypoint supplies the pinned existing kernel, never a function from a manifest or transcript.
          // This preserves its path, assurance, timestamp, digest and skip rules without a second policy parser.
          task.policyState = trajectoryPolicy.reduce(task.policyState, transition);
          demand(task.policyState.currentPhase === transition.to && task.policyState.sequence === transition.sequence,
            "trajectory-policy-replay-mismatch");
          task.phase = transition.to; task.sequence = transition.sequence; eventIds.add(transition.eventId);
        } else demand(false, "unknown-host-event");
      }
      demand(operation && accepted && row.operationRef === operation.operationRef && row.messageRequestId === operation.messageRequestId
        && row.operatorInputHash === operation.operatorInputHash && row.inputHash === accepted.inputHash && row.turnId === accepted.turnId
        && row.taskId === (task?.taskId ?? null) && row.taskRunId === (task?.taskRunId ?? null)
        && row.phase === (task?.phase ?? null) && row.trajectorySequence === (task?.sequence ?? 0), "request-state-mismatch");
      const selected = manifest.states.find(state => state.id === row.stateId);
      demand(selected && selected.operatorInputHash === row.operatorInputHash && selected.inputHash === row.inputHash
        && selected.phase === row.phase && selected.taskPresence === (task ? "current" : "none")
        && JSON.stringify(selected.fingerprint) === JSON.stringify(row.fingerprint), "request-definition-drift");
      previousHash = wireHash(JSON.stringify(envelope));
    }
    demand(seenOperations.size === admissions.size, "expected-operation-missing");
    return { ...result, state: "verified", passed: true, reason: null, manifestDigest: expected.manifestDigest, finalReceiptHash: previousHash };
  } catch (error) { return { ...result, state: "failed", reason: error instanceof Error ? error.message : "invalid-wire-evidence" }; }
}

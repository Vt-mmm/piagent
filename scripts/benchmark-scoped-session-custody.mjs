import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { benchmarkTreeStatIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { activeSessionTask } from "../packages/piagent-core/extensions/task-state.js";
import { benchmarkVerificationOperatorRequest } from "./benchmark-independent-verification.mjs";
import { benchmarkPublicInputCatalogDigest, validateBenchmarkPublicInputCatalog
} from "./benchmark-public-input-catalog.mjs";
import { createScopedMaterialBroker } from "./benchmark-scoped-tool-broker.mjs";
import { assertScopedFrozenQualification, scopedFrozenQualificationIdentity,
  validateScopedBrokerMeasurementBinding } from "./benchmark-scoped-frozen-qualification.mjs";
import { createScopedBrokerPiOperationRouter } from "./benchmark-scoped-pi-router.mjs";
import { loadScopedBrokerFromConfig, scopedCommonRuntimeClosureIdentity, scopedContextPolicySha256,
  scopedJournalPathSha256, scopedToolDefinitionsSha256, scopedVerificationReceiptKeyDigest,
  createScopedProjectVerificationSupervisor, listenScopedVerificationBridge,
  scopedProjectVerificationPlanBinding, SCOPED_PROJECT_VERIFICATION_PROTOCOL,
  SCOPED_CODEX_TURN_OBSERVATION_VERSION
} from "./benchmark-scoped-verification-supervisor.mjs";
import { BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION, CODEX_SCOPED_BROKER_TURN_FACTORY_VERSION
} from "./benchmark-codex-journey.mjs";

export { BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION };

export const BENCHMARK_SCOPED_BROKER_CUSTODY_VERSION = "benchmark-scoped-broker-custody-v1";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const MAX_FILE = 64 * 1024, MAX_JOURNAL = 32 * 1024 * 1024;
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { brokerCode: code }); };
const requireThat = (value, code) => { if (!value) fail(code); };

function exact(value, names, code) {
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), code);
}

function realPrivateDirectory(value, code) {
  requireThat(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && !value.includes("\0"), code);
  let real, info;
  try { real = fs.realpathSync(value); info = fs.lstatSync(real); } catch { fail(code); }
  requireThat(real === value && info.isDirectory() && !info.isSymbolicLink()
    && (info.mode & 0o077) === 0, code);
  return real;
}

function stableFile(value, maximum = MAX_FILE, privateMode = false) {
  requireThat(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && !value.includes("\0"), "custody-file-path");
  let before;
  try { before = fs.lstatSync(value, { bigint: true }); } catch { fail("custody-file-unavailable"); }
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size >= 0n && before.size <= BigInt(maximum)
    && (!privateMode || (before.mode & 0o077n) === 0n), "custody-file-unsafe");
  const fd = fs.openSync(value, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(value, { bigint: true });
    const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    requireThat(bytes.length === Number(before.size) && fields.every(name => before[name] === descriptor[name]
      && before[name] === after[name] && before[name] === current[name]), "custody-file-drift");
    return Buffer.from(bytes);
  } finally { fs.closeSync(fd); }
}

function writePrivate(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function createVerificationSocketCustody() {
  const temporaryRoot = fs.realpathSync(os.tmpdir()), socketRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(temporaryRoot, "piagent-v-")));
  fs.chmodSync(socketRoot, 0o700);
  const info = fs.lstatSync(socketRoot, { bigint: true });
  requireThat(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077n) === 0n,
    "custody-verification-socket-root");
  return Object.freeze({ root: socketRoot, dev: info.dev, ino: info.ino });
}

function removeVerificationSocketCustody(value) {
  if (!value) return;
  const current = fs.lstatSync(value.root, { bigint: true });
  requireThat(current.isDirectory() && !current.isSymbolicLink() && current.dev === value.dev
    && current.ino === value.ino && (current.mode & 0o077n) === 0n,
  "custody-verification-socket-root");
  fs.rmdirSync(value.root);
}

function safeMaterial(root, item) {
  const names = ["id", "relativePath", "sha256", "bytes", "readable", "writable", "protected"];
  exact(item, names, "custody-material-shape");
  const protectedIdentity = item.protected && item.sha256 === null && item.bytes === null;
  const contentIdentity = !item.protected && HASH.test(item.sha256)
    && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= MAX_FILE;
  requireThat(ID.test(item.id) && typeof item.relativePath === "string" && item.relativePath.length > 0
    && !path.isAbsolute(item.relativePath) && !item.relativePath.includes("\\") && !item.relativePath.includes("\0")
    && item.relativePath.split("/").every(part => part && part !== "." && part !== "..")
    && (protectedIdentity || contentIdentity)
    && [item.readable, item.writable, item.protected].every(value => typeof value === "boolean")
    && !(item.protected && (item.readable || item.writable)), "custody-material-shape");
  const target = path.join(root, ...item.relativePath.split("/"));
  requireThat(fs.realpathSync(target) === target && target.startsWith(root + path.sep), "custody-material-path");
  const info = fs.lstatSync(target, { bigint: true });
  requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
    && info.size >= 0n && info.size <= BigInt(MAX_FILE), "custody-material-shape");
  if (item.protected) return Object.freeze(Object.fromEntries(names.map(name => [name, item[name]])));
  const bytes = stableFile(target);
  requireThat(bytes.length === item.bytes && sha(bytes) === item.sha256, "custody-material-drift");
  return Object.freeze(Object.fromEntries(names.map(name => [name, item[name]])));
}

function safeVerification(item) {
  const names = ["id", "protocol", "capabilityDigest", "receiptKeyDigest", "timeoutMs"];
  exact(item, names, "custody-verification-shape");
  requireThat(ID.test(item.id) && ["scoped-isolated-contract-v1", SCOPED_PROJECT_VERIFICATION_PROTOCOL].includes(item.protocol)
    && HASH.test(item.capabilityDigest) && HASH.test(item.receiptKeyDigest)
    && Number.isSafeInteger(item.timeoutMs) && item.timeoutMs >= 25 && item.timeoutMs <= 30000,
  "custody-verification-shape");
  return Object.freeze(Object.fromEntries(names.map(name => [name, item[name]])));
}

function prepareVerificationHost(value, projectRoot, nodeCommand) {
  if (value === null) return null;
  const names = ["version", "verificationId", "timeoutMs", "policy", "expectedPlanDigest"];
  exact(value, names, "custody-verification-host");
  requireThat(value.version === "scoped-project-verification-host-v1" && ID.test(value.verificationId)
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 25 && value.timeoutMs <= 30000
    && HASH.test(value.expectedPlanDigest), "custody-verification-host");
  const binding = scopedProjectVerificationPlanBinding({ projectRoot, nodeCommand,
    policy: value.policy, timeoutMs: value.timeoutMs });
  requireThat(binding.planDigest === value.expectedPlanDigest, "custody-verification-plan-drift");
  const authority = generateKeyPairSync("ed25519"), manifest = Object.freeze({ id: value.verificationId,
    protocol: binding.protocol, capabilityDigest: binding.capabilityDigest,
    receiptKeyDigest: scopedVerificationReceiptKeyDigest(authority.publicKey), timeoutMs: value.timeoutMs });
  return Object.freeze({ authority, binding, manifest, policy: value.policy });
}

function validatePreparedVerificationHost(value, projectRoot, nodeCommand, verifications) {
  if (value === null) return null;
  exact(value, ["authority", "binding", "manifest", "policy"], "custody-verification-host");
  requireThat(value.authority?.privateKey?.type === "private" && value.authority.privateKey.asymmetricKeyType === "ed25519"
    && value.authority?.publicKey?.type === "public" && value.authority.publicKey.asymmetricKeyType === "ed25519"
    && verifications.length === 1 && JSON.stringify(verifications[0]) === JSON.stringify(value.manifest),
  "custody-verification-host");
  const binding = scopedProjectVerificationPlanBinding({ projectRoot, nodeCommand, policy: value.policy,
    timeoutMs: value.manifest.timeoutMs });
  requireThat(JSON.stringify(binding) === JSON.stringify(value.binding)
    && value.manifest.protocol === SCOPED_PROJECT_VERIFICATION_PROTOCOL
    && value.manifest.capabilityDigest === binding.capabilityDigest
    && value.manifest.receiptKeyDigest === scopedVerificationReceiptKeyDigest(value.authority.publicKey),
  "custody-verification-plan-drift");
  return value;
}

function safeCodexTurnObservations(bodies) {
  const names = ["version", "contractId", "authority", "metadataSha256", "callId", "threadId", "itemId",
    "sessionId", "turnId", "turnStartedAtUnixMs", "model", "reasoningEffort", "sandboxMode",
    "sandboxStateSha256"], seenCalls = new Set(), seenItems = new Set(), observations = [];
  for (const row of bodies.filter(item => item.type === "transport-observation")) {
    const item = row.observation;
    exact(item, names, "custody-codex-observation");
    requireThat(item.version === SCOPED_CODEX_TURN_OBSERVATION_VERSION
      && item.contractId === "piagent-codex-mcp-metadata-v1" && item.authority === "none"
      && HASH.test(item.metadataSha256) && [item.callId, item.threadId, item.itemId, item.sessionId,
        item.turnId, item.model].every(value => typeof value === "string" && ID.test(value))
      && Number.isSafeInteger(item.turnStartedAtUnixMs) && item.turnStartedAtUnixMs >= 0
      && (item.reasoningEffort === null || ["none", "minimal", "low", "medium", "high", "xhigh",
        "max", "ultra"].includes(item.reasoningEffort)) && item.sandboxMode === "workspace-write"
      && (item.sandboxStateSha256 === null || HASH.test(item.sandboxStateSha256))
      && !seenCalls.has(item.callId) && !seenItems.has(item.itemId), "custody-codex-observation");
    seenCalls.add(item.callId); seenItems.add(item.itemId);
    observations.push(Object.freeze(Object.fromEntries(names.map(name => [name, item[name]]))));
  }
  return Object.freeze(observations);
}

export function scopedBrokerMaterialManifestSha256(profile, materials) {
  requireThat(typeof profile === "string" && Array.isArray(materials), "custody-material-manifest");
  return sha(JSON.stringify({ version: 1, profile, materials }));
}

export function scopedBrokerVerificationManifestSha256(verifications) {
  requireThat(Array.isArray(verifications), "custody-verification-manifest");
  return sha(JSON.stringify({ version: 1, verifications }));
}

export function scopedBrokerModelIdentitySha256(value) {
  exact(value, ["provider", "model", "thinking", "serviceTier"], "custody-model-identity");
  requireThat([value.provider, value.model].every(item => typeof item === "string" && item.length > 0
    && item.length <= 160) && (value.thinking === null || typeof value.thinking === "string")
    && (value.serviceTier === null || typeof value.serviceTier === "string"), "custody-model-identity");
  return sha(JSON.stringify(value));
}

function journalEvidence({ journalPath, manifestBytes, manifestSignature, manifestPublicKey,
  journalPublicKey, identity, verificationAvailable, transportRequired }) {
  const journalBytes = stableFile(journalPath, MAX_JOURNAL, true);
  requireThat(journalBytes.length > 0 && journalBytes.at(-1) === 10, "custody-journal-incomplete");
  const authority = createPublicKey(manifestPublicKey), journalKey = createPublicKey(journalPublicKey);
  requireThat(verify(null, manifestBytes, authority, manifestSignature), "custody-manifest-signature");
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(journalBytes).slice(0, -1).split("\n");
  requireThat(lines.length > 0 && lines.length <= 2048, "custody-journal-bounds");
  let previous = "0".repeat(64), sequence = 0; const bodies = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { fail("custody-journal-json"); }
    exact(row, ["body", "signature"], "custody-journal-envelope");
    requireThat(JSON.stringify(row) === line && typeof row.signature === "string"
      && verify(null, Buffer.from(JSON.stringify(row.body)), journalKey, Buffer.from(row.signature, "base64"))
      && row.body?.sequence === ++sequence && row.body.previous === previous
      && row.body.manifestSha256 === sha(manifestBytes)
      && JSON.stringify(row.body.identity) === JSON.stringify(identity), "custody-journal-chain");
    previous = sha(Buffer.from(`${line}\n`)); bodies.push(row.body);
  }
  const terminal = bodies.at(-1), reservations = bodies.filter(row => row.type === "reservation"),
    results = bodies.filter(row => row.type === "result"), transportEnds = bodies.filter(row => row.type === "transport-end"),
    codexTurnObservations = safeCodexTurnObservations(bodies);
  requireThat(bodies[0]?.type === "begin" && terminal?.type === "end" && terminal.cancelled === false
    && Number.isSafeInteger(terminal.actions) && terminal.actions === reservations.length
    && reservations.length === results.length && new Set(results.map(row => row.action)).size === results.length
    && (!transportRequired || bodies.filter(row => row.type === "transport-begin").length === 1
      && transportEnds.length === 1 && transportEnds[0].complete === true && transportEnds[0].reason === null),
  "custody-journal-terminal");
  return Object.freeze({ version: "scoped-broker-journal-evidence-v1", manifestBytes: Buffer.from(manifestBytes),
    manifestSignature: Buffer.from(manifestSignature), manifestPublicKey: Buffer.from(manifestPublicKey),
    journalBytes, journalPublicKey: Buffer.from(journalPublicKey), status: Object.freeze({
      actions: terminal.actions, blocked: false, ended: true, cancelled: false, journalSha256: sha(journalBytes),
      g0Qualified: false, verificationAvailable, inflightVerification: null }), codexTurnObservations });
}

const normalizedModel = value => typeof value === "string" ? value.split("/").at(-1) : null;
const normalizedThinking = value => value === "off" ? "none" : value === "minimal" ? "low" : value;

/** Reconciles signed, untrusted MCP observations with one exact Codex exec
 * JSONL lifecycle. It does not make the observation authoritative. */
export function reconcileCodexScopedBrokerSettlement(evidence, usage) {
  requireThat(evidence?.status?.ended === true && evidence.status.cancelled === false
    && Array.isArray(evidence.codexTurnObservations), "custody-codex-settlement");
  const lifecycle = usage?.turnLifecycleEvidence, jsonl = usage?.jsonlEvidence;
  requireThat(typeof usage?.providerSessionId === "string" && ID.test(usage.providerSessionId)
    && lifecycle?.schemaVersion === 1 && lifecycle.source === "codex-exec-jsonl-turn-lifecycle"
    && lifecycle.startedEvents === 1 && lifecycle.completedEvents === 1
    && jsonl?.schemaVersion === 1 && jsonl.source === "codex-exec-jsonl-stdout-bytes"
    && Number.isSafeInteger(jsonl.bytes) && jsonl.bytes > 0 && HASH.test(jsonl.sha256),
  "custody-codex-jsonl");
  const observations = evidence.codexTurnObservations;
  if (observations.length === 0) {
    requireThat(evidence.status.actions === 0, "custody-codex-observation-missing");
    return Object.freeze({ version: "codex-broker-settlement-reconciliation-v1", authority: "none",
      status: "native-turn-unobserved-zero-call", reconciled: false,
      providerSessionId: usage.providerSessionId, nativeTurnId: null, observations: 0,
      jsonlSha256: jsonl.sha256, journalSha256: evidence.status.journalSha256 });
  }
  const first = observations[0], model = normalizedModel(usage.model), thinking = normalizedThinking(usage.thinkingLevel);
  requireThat(observations.length === evidence.status.actions && first.threadId === usage.providerSessionId
    && first.sessionId === usage.providerSessionId && first.model === model && first.reasoningEffort === thinking
    && observations.every(item => item.threadId === first.threadId && item.sessionId === first.sessionId
      && item.turnId === first.turnId && item.model === first.model
      && item.reasoningEffort === first.reasoningEffort), "custody-codex-identity-mismatch");
  return Object.freeze({ version: "codex-broker-settlement-reconciliation-v1", authority: "none",
    status: "reconciled", reconciled: true, providerSessionId: usage.providerSessionId,
    nativeTurnId: first.turnId, observations: observations.length, jsonlSha256: jsonl.sha256,
    journalSha256: evidence.status.journalSha256 });
}

/** Creates one fresh, private, single-use turn custody. No returned value can
 * approve a plan, dispatch a provider, grade an answer or admit a benchmark. */
export async function createBenchmarkScopedBrokerTurnCustody(input) {
  const names = ["custodyRoot", "nodeCommand", "brokerScript", "runtimePath", "qualification",
    "measurementBinding", "contextPolicy", "modelIdentity", "taskIdentity", "materialRoot", "materials",
    "verifications", "verificationBridge", "verificationHost"];
  exact(input, names, "custody-input-shape");
  const custodyRoot = realPrivateDirectory(input.custodyRoot, "custody-root"),
    materialRoot = realPrivateDirectory(input.materialRoot, "custody-material-root");
  requireThat(!custodyRoot.startsWith(materialRoot + path.sep) && !materialRoot.startsWith(custodyRoot + path.sep)
    && custodyRoot !== materialRoot,
    "custody-root-overlap");
  const nodeCommand = fs.realpathSync(input.nodeCommand), brokerScript = fs.realpathSync(input.brokerScript);
  requireThat(nodeCommand === input.nodeCommand && brokerScript === input.brokerScript
    && brokerScript === fs.realpathSync(new URL("./benchmark-scoped-tool-broker.mjs", import.meta.url)),
  "custody-runtime-path");
  const binding = validateScopedBrokerMeasurementBinding(input.measurementBinding),
    contextPolicySha256 = scopedContextPolicySha256(input.contextPolicy),
    materials = Object.freeze(input.materials.map(item => safeMaterial(materialRoot, item))),
    verifications = Object.freeze(input.verifications.map(safeVerification)),
    verificationHost = validatePreparedVerificationHost(input.verificationHost, materialRoot, nodeCommand,
      verifications);
  requireThat(new Set(materials.map(item => item.id)).size === materials.length && materials.length <= 32
    && new Set(verifications.map(item => item.id)).size === verifications.length && verifications.length <= 32
    && (!verificationHost || input.verificationBridge === null)
    && materials.every(item => (!item.writable || binding.profile === "document")
      && (!(item.readable || item.writable) || ["incident", "document"].includes(binding.profile)))
    && scopedBrokerMaterialManifestSha256(binding.profile, materials)
      === binding.materialManifestSha256
    && scopedBrokerVerificationManifestSha256(verifications) === binding.verificationManifestSha256
    && contextPolicySha256 === binding.contextPolicySha256
    && sha(stableFile(nodeCommand, 1024 * 1024 * 1024)) === binding.nodeSha256
    && scopedBrokerModelIdentitySha256(input.modelIdentity) === binding.modelSha256,
  "custody-measurement-drift");
  exact(input.taskIdentity, ["taskId", "sessionId", "operationId", "nonce"], "custody-task-identity");
  requireThat(Object.values(input.taskIdentity).every(value => typeof value === "string" && ID.test(value)),
    "custody-task-identity");
  const closure = scopedCommonRuntimeClosureIdentity(), qualification = scopedFrozenQualificationIdentity(
    input.qualification, closure.sha256);
  if (binding.surface === "piagent") requireThat(binding.runtimeSha256 === qualification.sdkTreeSha256,
    "custody-runtime-drift");
  else requireThat(typeof input.runtimePath === "string" && fs.realpathSync(input.runtimePath) === input.runtimePath
    && sha(stableFile(input.runtimePath, 1024 * 1024 * 1024)) === binding.runtimeSha256,
  "custody-runtime-drift");
  const turnRoot = fs.mkdtempSync(path.join(custodyRoot, "turn-")); fs.chmodSync(turnRoot, 0o700);
  const socketCustody = verificationHost ? createVerificationSocketCustody() : null;
  let listener = null, disposePromise = null;
  const dispose = () => {
    disposePromise ??= (async () => {
      try { await listener?.close(); }
      finally { removeVerificationSocketCustody(socketCustody); }
    })();
    return disposePromise;
  };
  try {
  const at = name => path.join(turnRoot, name), authorization = verificationHost ? randomBytes(32).toString("hex") : null,
    receiptPublicKey = verificationHost?.authority.publicKey.export({ type: "spki", format: "pem" }) ?? null,
    verificationBridge = verificationHost ? { socketPath: path.join(socketCustody.root, "v.sock"),
      authorizationPath: at("verification-authorization"), receiptPublicKeyPath: at("verification-public.pem"),
      receiptKeyDigest: verificationHost.manifest.receiptKeyDigest,
      timeoutMs: Math.min(60000, verificationHost.manifest.timeoutMs + 5000) } : input.verificationBridge,
    host = generateKeyPairSync("ed25519"),
    journal = generateKeyPairSync("ed25519"), config = { version: 4, manifestPath: at("manifest.json"),
      manifestSignaturePath: at("manifest.sig"), manifestPublicKeyPath: at("manifest-public.pem"),
      journalPath: at("journal.jsonl"), journalPrivateKeyPath: at("journal-private.pem"),
      verificationBridge, qualification: { ...input.qualification },
      measurementBinding: { ...binding } }, configBytes = Buffer.from(JSON.stringify(config));
  const identity = Object.freeze({ version: 4, armId: binding.armId, taskId: input.taskIdentity.taskId,
    sessionId: input.taskIdentity.sessionId, requestId: binding.operatorRequestDigest,
    operationId: input.taskIdentity.operationId, nonce: input.taskIdentity.nonce,
    sourceSha256: qualification.sourceSha256, assetTreeSha256: qualification.assetTreeSha256,
    configSha256: sha(configBytes), measurementConfigurationSha256: binding.configurationSha256,
    brokerClosureSha256: qualification.brokerClosureSha256,
    toolDefinitionsSha256: scopedToolDefinitionsSha256(),
    manifestAuthoritySha256: scopedVerificationReceiptKeyDigest(host.publicKey),
    journalSignerSha256: scopedVerificationReceiptKeyDigest(journal.publicKey),
    journalPathSha256: scopedJournalPathSha256(config.journalPath), contextPolicySha256,
    sdkTreeSha256: qualification.sdkTreeSha256 });
  const manifestBytes = Buffer.from(JSON.stringify({ version: 2, identity, profile: binding.profile,
    root: materialRoot, materials, verifications })), manifestSignature = sign(null, manifestBytes, host.privateKey),
    manifestPublicKey = host.publicKey.export({ type: "spki", format: "pem" }),
    journalPrivateKey = journal.privateKey.export({ type: "pkcs8", format: "pem" }),
    journalPublicKey = journal.publicKey.export({ type: "spki", format: "pem" });
  requireThat(configBytes.length <= MAX_FILE && manifestBytes.length <= MAX_FILE, "custody-static-size");
  const hostFiles = verificationHost ? [[verificationBridge.authorizationPath, Buffer.from(authorization)],
    [verificationBridge.receiptPublicKeyPath, receiptPublicKey]] : [];
  for (const [file, bytes] of [[config.manifestPath, manifestBytes], [config.manifestSignaturePath, manifestSignature],
    [config.manifestPublicKeyPath, manifestPublicKey], [config.journalPrivateKeyPath, journalPrivateKey],
    [at("config.json"), configBytes], ...hostFiles]) writePrivate(file, bytes);
  syncDirectory(turnRoot);
  const staticFiles = Object.freeze([[config.manifestPath, manifestBytes], [config.manifestSignaturePath, manifestSignature],
    [config.manifestPublicKeyPath, manifestPublicKey], [config.journalPrivateKeyPath, journalPrivateKey],
    [at("config.json"), configBytes], ...hostFiles]
    .map(([file, bytes]) => Object.freeze({ file, sha256: sha(bytes) })));
  let piOpened = false;
  if (verificationHost) {
    const supervisor = createScopedProjectVerificationSupervisor({ manifestSha256: sha(manifestBytes),
      brokerIdentitySha256: sha(JSON.stringify(identity)), brokerSourceSha256: identity.brokerClosureSha256,
      receiptPrivateKey: verificationHost.authority.privateKey, verifications: [{ manifest: verificationHost.manifest,
        plan: { projectRoot: materialRoot, nodeCommand, stagingRoot: turnRoot, policy: verificationHost.policy,
          expectedPlanDigest: verificationHost.binding.planDigest } }] });
    listener = await listenScopedVerificationBridge({ supervisor, authorization,
      socketPath: verificationBridge.socketPath });
  }
  const assertStatic = () => {
    for (const item of staticFiles) requireThat(sha(stableFile(item.file, MAX_FILE, true)) === item.sha256,
      "custody-static-drift");
    assertScopedFrozenQualification(qualification, identity, scopedCommonRuntimeClosureIdentity().sha256);
  };
  const codexEvidence = () => journalEvidence({ journalPath: config.journalPath, manifestBytes, manifestSignature,
    manifestPublicKey, journalPublicKey, identity, verificationAvailable: verifications.length > 0,
    transportRequired: true });
  return Object.freeze({ version: BENCHMARK_SCOPED_BROKER_CUSTODY_VERSION, authority: "none", turnRoot,
    identity, measurementBinding: binding, configSha256: identity.configSha256,
    brokerConfigPath: at("config.json"), nodeCommand, brokerScript,
    codexLaunch: Object.freeze({ nodeCommand, brokerScript, brokerConfigPath: at("config.json") }),
    async openPi() { requireThat(!piOpened && !disposePromise && !fs.existsSync(config.journalPath), "custody-single-use");
      try { assertStatic(); piOpened = true;
        const loaded = loadScopedBrokerFromConfig({ configPath: at("config.json"),
          createBroker: createScopedMaterialBroker });
        return Object.freeze({ ...loaded, dispose });
      } catch (error) { await dispose(); throw error; } },
    codexSettlementEvidence() { requireThat(!piOpened, "custody-surface-conflict"); assertStatic();
      return codexEvidence(); },
    reconcileCodexSettlement(usage) { requireThat(!piOpened, "custody-surface-conflict"); assertStatic();
      const evidence = codexEvidence();
      return Object.freeze({ version: "codex-scoped-broker-turn-settlement-v1", authority: "none",
        configSha256: identity.configSha256, brokerIdentitySha256: sha(JSON.stringify(identity)),
        manifestSha256: sha(manifestBytes), journalSha256: evidence.status.journalSha256,
        actions: evidence.status.actions,
        reconciliation: reconcileCodexScopedBrokerSettlement(evidence, usage) }); },
    dispose
  });
  } catch (error) { await dispose(); throw error; }
}

function stableSessionFile(file, maximum, code) {
  requireThat(typeof file === "string" && path.isAbsolute(file) && path.normalize(file) === file
    && !file.includes("\0") && fs.realpathSync(file) === file, code);
  const before = fs.lstatSync(file, { bigint: true });
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size > 0n && before.size <= BigInt(maximum), code);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true }),
      fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    requireThat(bytes.length === Number(before.size) && fields.every(name => before[name] === descriptor[name]
      && before[name] === after[name] && before[name] === current[name]), code);
    return bytes;
  } finally { fs.closeSync(fd); }
}

function outside(root, file) {
  const relative = path.relative(root, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function exactTurns(turns, scenario) {
  requireThat(Array.isArray(turns) && turns.length === scenario.turnCount, "session-custody-turns");
  return Object.freeze(turns.map((turn, index) => {
    requireThat(turn && typeof turn === "object" && turn.id === scenario.turns[index].turnId
      && typeof turn.message === "string" && turn.message.length > 0 && turn.message.isWellFormed()
      && sha(turn.message) === scenario.turns[index].promptSha256
      && Buffer.byteLength(turn.message) === scenario.turns[index].promptBytes
      && (turn.workflow ?? null) === scenario.turns[index].workflow
      && (turn.reconnectBefore === true) === scenario.turns[index].reconnectBefore
      && (turn.receiptUncertain === true) === scenario.turns[index].receiptUncertain,
    "session-custody-turns");
    const operatorRequest = benchmarkVerificationOperatorRequest({ message: turn.message,
      workflow: turn.workflow ?? null });
    requireThat(`operator-request-v1:${sha(operatorRequest)}` === scenario.turns[index].operatorRequestDigest,
      "session-custody-operator-request");
    return Object.freeze({ index: index + 1, id: turn.id, message: turn.message,
      operatorRequest, catalog: scenario.turns[index] });
  }));
}

function resources(value, expectedRequests, workspace) {
  const names = ["profile", "contextPolicy", "materialRoot", "materials", "verifications",
    "verificationBridge", "verificationHost"];
  exact(value, names, "session-custody-resources");
  requireThat(fs.realpathSync(value.materialRoot) === workspace
    && JSON.stringify(value.contextPolicy?.allowedUserMessages) === JSON.stringify(expectedRequests)
    && JSON.stringify(value.contextPolicy?.removableUserMessages) === "[]", "session-custody-context");
  scopedContextPolicySha256(value.contextPolicy);
  requireThat(Array.isArray(value.materials) && Array.isArray(value.verifications)
    && (value.verificationHost === null || value.profile === "document"
      && value.verifications.length === 0 && value.verificationBridge === null),
    "session-custody-resources");
  return value;
}

/** Builds data-only, just-in-time per-turn custody. It cannot approve a plan,
 * start a provider, grade output, or admit a benchmark record. */
export function createBenchmarkScopedSessionCustody(input) {
  const names = ["custodyRoot", "nodeCommand", "brokerScript", "runtimePath", "qualification", "catalog",
    "runId", "armId", "suiteId", "scenarioId", "surface", "repeat", "infrastructureAttempt",
    "configurationSha256", "planPath", "publicContractPath", "workspace", "modelIdentity", "turns",
    "resolveResources"];
  exact(input, names, "session-custody-input");
  requireThat([input.runId, input.armId, input.suiteId, input.scenarioId].every(value =>
    typeof value === "string" && ID.test(value)) && ["piagent", "codex-cli"].includes(input.surface)
    && Number.isSafeInteger(input.repeat) && input.repeat >= 1 && input.repeat <= 10
    && Number.isSafeInteger(input.infrastructureAttempt) && input.infrastructureAttempt >= 1
    && input.infrastructureAttempt <= 3 && HASH.test(input.configurationSha256)
    && typeof input.resolveResources === "function", "session-custody-input");
  const workspace = fs.realpathSync(input.workspace), info = fs.lstatSync(workspace);
  requireThat(workspace === input.workspace && info.isDirectory() && !info.isSymbolicLink()
    && (info.mode & 0o077) === 0, "session-custody-workspace");
  const catalog = JSON.parse(JSON.stringify(validateBenchmarkPublicInputCatalog(input.catalog,
    { suiteId: input.suiteId }))), catalogSha256 = benchmarkPublicInputCatalogDigest(catalog),
    scenario = catalog.scenarios.find(value => value.scenarioId === input.scenarioId);
  requireThat(scenario && scenario.planRef === `plan:${input.scenarioId}`, "session-custody-scenario");
  const turns = exactTurns(input.turns, scenario), planBytes = stableSessionFile(input.planPath, 2 * 1024 * 1024,
    "session-custody-plan"), contractBytes = stableSessionFile(input.publicContractPath, 2 * 1024 * 1024,
    "session-custody-public-contract");
  requireThat(outside(workspace, input.planPath) && outside(workspace, input.publicContractPath),
    "session-custody-authority-location");
  const planSha256 = sha(planBytes), publicContractSha256 = sha(contractBytes),
    nodeSha256 = sha(stableSessionFile(input.nodeCommand, 1024 * 1024 * 1024, "session-custody-node")),
    modelSha256 = scopedBrokerModelIdentitySha256(input.modelIdentity), closure = scopedCommonRuntimeClosureIdentity(),
    frozen = scopedFrozenQualificationIdentity(input.qualification, closure.sha256),
    runtimeSha256 = input.surface === "piagent" ? frozen.sdkTreeSha256
      : sha(stableSessionFile(input.runtimePath, 1024 * 1024 * 1024, "session-custody-runtime"));
  let nextTurn = 1;
  async function openTurn(turn, taskIdentity) {
    requireThat(turn.index === nextTurn, "session-custody-turn-order");
    requireThat(sha(stableSessionFile(input.planPath, 2 * 1024 * 1024, "session-custody-plan")) === planSha256
      && sha(stableSessionFile(input.publicContractPath, 2 * 1024 * 1024,
        "session-custody-public-contract")) === publicContractSha256,
    "session-custody-static-drift");
    const workspaceSha256 = benchmarkTreeStatIdentity(workspace,
      { rejectSymlinks: true, rejectEscapingSymlinks: true }).contentDigest,
      resolved = resources(await input.resolveResources(Object.freeze({ surface: input.surface,
        turnIndex: turn.index, turnId: turn.id, inputText: turn.message,
        operatorRequest: turn.operatorRequest, expectedUserMessages: turns.slice(0, turn.index)
          .map(item => item.operatorRequest), workspace })), turns.slice(0, turn.index)
        .map(item => item.operatorRequest), workspace),
      verificationHost = prepareVerificationHost(resolved.verificationHost, workspace, input.nodeCommand),
      verifications = verificationHost ? Object.freeze([verificationHost.manifest]) : resolved.verifications,
      measurementBinding = { version: "benchmark-turn-binding-v1", authority: "none", runId: input.runId,
        armId: input.armId, suiteId: input.suiteId, scenarioId: input.scenarioId, surface: input.surface,
        repeat: input.repeat, infrastructureAttempt: input.infrastructureAttempt, turnIndex: turn.index,
        turnId: turn.id, catalogSha256, configurationSha256: input.configurationSha256,
        publicContractSha256, planSha256, turnBindingSha256: turn.catalog.bindingDigest, workspaceSha256,
        operatorRequestDigest: turn.catalog.operatorRequestDigest, profile: resolved.profile,
        materialManifestSha256: scopedBrokerMaterialManifestSha256(resolved.profile, resolved.materials),
        verificationManifestSha256: scopedBrokerVerificationManifestSha256(verifications),
        contextPolicySha256: scopedContextPolicySha256(resolved.contextPolicy), nodeSha256, runtimeSha256,
        modelSha256 }, custody = await createBenchmarkScopedBrokerTurnCustody({ custodyRoot: input.custodyRoot,
        nodeCommand: input.nodeCommand, brokerScript: input.brokerScript, runtimePath: input.runtimePath,
        qualification: input.qualification, measurementBinding, contextPolicy: resolved.contextPolicy,
        modelIdentity: input.modelIdentity, taskIdentity, materialRoot: resolved.materialRoot,
        materials: resolved.materials, verifications, verificationBridge: resolved.verificationBridge,
        verificationHost });
    requireThat(benchmarkTreeStatIdentity(workspace,
      { rejectSymlinks: true, rejectEscapingSymlinks: true }).contentDigest === workspaceSha256,
      "session-custody-workspace-drift");
    nextTurn++;
    return custody;
  }
  const piScopedBrokerRouter = input.surface === "piagent" ? createScopedBrokerPiOperationRouter({
    async open(reservation, ctx) {
      const turn = turns[nextTurn - 1];
      requireThat(turn && reservation.inputText === turn.message && reservation.inputSha256 === sha(turn.message)
        && ctx?.cwd === workspace, "session-custody-pi-turn");
      const task = activeSessionTask(workspace, reservation.sessionId);
      requireThat(task && task.sessionId === reservation.sessionId && task.taskId && ID.test(task.taskId)
        && task.operatorRequest === turn.operatorRequest
        && task.operatorRequestDigest === turn.catalog.operatorRequestDigest
        && (task.trace?.outcome ?? "pending") === "pending", "session-custody-pi-task");
      const custody = await openTurn(turn, { taskId: task.taskId, sessionId: reservation.sessionId,
        operationId: reservation.operationRef, nonce: reservation.messageRequestId });
      return custody.openPi();
    }
  }) : null;
  const codexScopedBroker = input.surface === "codex-cli" ? Object.freeze({
    version: CODEX_SCOPED_BROKER_TURN_FACTORY_VERSION, authority: "none",
    async openTurn(coordinate) {
      const turn = turns[nextTurn - 1];
      requireThat(turn && coordinate.turnIndex === turn.index && coordinate.turnId === turn.id
        && coordinate.inputText === turn.message && coordinate.workspace === workspace
        && (coordinate.threadId === null || typeof coordinate.threadId === "string" && ID.test(coordinate.threadId)),
      "session-custody-codex-turn");
      const sessionId = coordinate.threadId ?? `pending-${sha(`${input.runId}\0${turn.catalog.bindingDigest}`).slice(0, 32)}`;
      return openTurn(turn, { taskId: `plan-${sha(planBytes).slice(0, 32)}`, sessionId,
        operationId: `turn-${turn.index}-${turn.catalog.bindingDigest.slice(0, 24)}`, nonce: randomUUID() });
    }
  }) : null;
  return Object.freeze({ version: BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION, authority: "none",
    surface: input.surface, piScopedBrokerRouter, codexScopedBroker });
}

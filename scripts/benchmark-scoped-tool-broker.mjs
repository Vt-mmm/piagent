import fs from "node:fs"; import path from "node:path"; import { runScopedBrokerMcp } from "./benchmark-scoped-broker-custody.mjs";
import { createHash, createPublicKey, randomUUID, sign, verify } from "node:crypto"; import { types } from "node:util";
import { SCOPED_VERIFICATION_PROTOCOL, SCOPED_PROJECT_VERIFICATION_PROTOCOL, scopedVerificationReceiptKeyDigest, verifyScopedVerificationEnvelope, SCOPED_TOOL_DEFINITIONS, SCOPED_MCP_LIMITS, registerScopedBrokerTransport, runScopedBrokerChild, runScopedBrokerCli, loadScopedBrokerFromConfig, createScopedBrokerPiExtension, loadScopedBrokerPiExtension,
  SCOPED_BROKER_IDENTITY_VERSION, SCOPED_BROKER_QUALIFICATION_IDENTITY_VERSION, SCOPED_BROKER_IDENTITY_V2_FIELDS, SCOPED_BROKER_FROZEN_IDENTITY_VERSION, SCOPED_BROKER_IDENTITY_V3_FIELDS, SCOPED_BROKER_IDENTITY_V4_FIELDS, scopedBrokerSourceClosureSha256, scopedToolDefinitionsSha256, scopedJournalPathSha256, scopedQualificationIdentity, assertScopedFrozenQualification, scopedCommonRuntimeClosureIdentity } from "./benchmark-scoped-verification-supervisor.mjs";
export { SCOPED_TOOL_DEFINITIONS, SCOPED_MCP_LIMITS, runScopedBrokerMcp, loadScopedBrokerFromConfig, createScopedBrokerPiExtension, loadScopedBrokerPiExtension };
// DA2 kernel: no activation/provider/PASS authority; mediation requires exclusive tree custody.
const MAX_BYTES = 65536, MAX_TOTAL = 1048576, MAX_ACTIONS = 256;
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value), fail = code => { throw Object.assign(new Error(code), { brokerCode: code }); };
const requireThat = (value, code) => { if (!value) fail(code); };
const verificationEnvironmentField = protocol => protocol === SCOPED_VERIFICATION_PROTOCOL ? "imageId"
  : protocol === SCOPED_PROJECT_VERIFICATION_PROTOCOL ? "environmentDigest" : null;
const fields = (value, names) => {
  requireThat(value && typeof value === "object" && !types.isProxy(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value)), "invalid-object");
  const descriptors = Object.getOwnPropertyDescriptors(value); requireThat(Reflect.ownKeys(descriptors).length === names.length && names.every(name =>
    descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], "value")), "invalid-fields");
};
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const stat = file => fs.lstatSync(file, { bigint: true });
const regular = info => requireThat(info.isFile() && info.nlink === 1n && info.size <= BigInt(MAX_BYTES), "unsafe-material");
const wellFormed = text => typeof text === "string" && text.isWellFormed();
function requestDigest(name, args) {
  requireThat(typeof name === "string" && name.length <= 160, "invalid-tool");
  requireThat(args && typeof args === "object" && !types.isProxy(args)
    && [null, Object.prototype].includes(Object.getPrototypeOf(args)), "invalid-object");
  const descriptors = Object.getOwnPropertyDescriptors(args), copy = Object.create(null); requireThat(Reflect.ownKeys(descriptors).length <= 16, "invalid-fields");
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    requireThat(typeof key === "string" && key.length <= 160 && descriptor.enumerable
      && Object.hasOwn(descriptor, "value") && wellFormed(descriptor.value)
      && Buffer.byteLength(descriptor.value) <= MAX_BYTES, "invalid-argument");
    copy[key] = descriptor.value;
  }
  return hash(JSON.stringify({ name, args: copy }));
}
function directoryChain(directory) {
  requireThat(path.isAbsolute(directory) && path.normalize(directory) === directory, "noncanonical-directory"); const result = [];
  for (let current = directory;; current = path.dirname(current)) {
    const info = stat(current); requireThat(info.isDirectory() && !info.isSymbolicLink(), "unsafe-parent");
    result.push([current, info]);
    if (current === path.dirname(current)) return result;
  }
}
function checkParents(chain) {
  // Directory entry/link counts change when our own journal/temp file is created.
  for (const [file, info] of chain) { const current = stat(file); requireThat(current.isDirectory()
    && current.dev === info.dev && current.ino === info.ino && current.mode === info.mode, "parent-changed"); }
}
function capture(file, parents) {
  checkParents(parents); const before = stat(file); regular(before);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    requireThat(sameFile(before, fs.fstatSync(fd, { bigint: true })), "material-changed");
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0, read;
    while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, length))) length += read;
    requireThat(length <= MAX_BYTES && BigInt(length) === before.size, "material-size");
    requireThat(sameFile(before, fs.fstatSync(fd, { bigint: true })) && sameFile(before, stat(file)), "material-changed");
    checkParents(parents); const bytes = buffer.subarray(0, length);
    return { bytes, sha256: hash(bytes), info: before };
  } finally { fs.closeSync(fd); }
}
function writeAll(fd, bytes, position) {
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, position + offset); requireThat(written > 0, "short-write"); offset += written;
  }
}
function syncDirectory(directory) { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function lines(bytes) { const result = [];
  for (let start = 0, i = 0; i <= bytes.length; i++) {
    if (i !== bytes.length && bytes[i] !== 10) continue;
    if (i > start || i < bytes.length) result.push({ line: result.length + 1,
      sha256: hash(bytes.subarray(start, i)) }); start = i + 1;
  }
  return result;
}
// Keys and identity are host inputs, never model arguments.
export function createScopedMaterialBroker({ manifestBytes, manifestSignature, manifestPublicKey,
  expectedIdentity, actualConfigSha256, actualQualification, journalPath, journalPrivateKey, verificationBridge }) {
  requireThat(Buffer.isBuffer(manifestBytes) && manifestBytes.length <= MAX_BYTES, "manifest-size");
  manifestBytes = Buffer.from(manifestBytes);
  const authority = manifestPublicKey?.type === "public" ? manifestPublicKey : createPublicKey(manifestPublicKey);
  requireThat(authority.asymmetricKeyType === "ed25519" && journalPrivateKey?.type === "private" && journalPrivateKey.asymmetricKeyType === "ed25519"
    && verify(null, manifestBytes, authority, manifestSignature), "manifest-signature");
  const manifestSha256 = hash(manifestBytes), journalSigner = createPublicKey(journalPrivateKey);
  const journalPublicKey = journalSigner.export({ type: "spki", format: "pem" });
  const manifestAuthorityDigest = scopedVerificationReceiptKeyDigest(authority),
    journalSignerDigest = scopedVerificationReceiptKeyDigest(journalSigner);
  requireThat(manifestAuthorityDigest !== journalSignerDigest, "key-role-collision");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  requireThat(manifestBytes.equals(Buffer.from(JSON.stringify(manifest))), "manifest-noncanonical");
  fields(manifest, ["version", "identity", "profile", "root", "materials", "verifications"]);
  const legacyFields = ["armId", "taskId", "sessionId", "requestId", "operationId", "nonce", "sourceSha256", "configSha256", "brokerSha256"];
  const identityFields = manifest.identity?.version === SCOPED_BROKER_FROZEN_IDENTITY_VERSION
    ? SCOPED_BROKER_IDENTITY_V4_FIELDS : manifest.identity?.version === SCOPED_BROKER_QUALIFICATION_IDENTITY_VERSION
      ? SCOPED_BROKER_IDENTITY_V3_FIELDS : manifest.identity?.version === SCOPED_BROKER_IDENTITY_VERSION
      ? SCOPED_BROKER_IDENTITY_V2_FIELDS : legacyFields;
  fields(manifest.identity, identityFields);
  if (expectedIdentity !== undefined) { fields(expectedIdentity, identityFields); for (const key of identityFields)
    requireThat(manifest.identity[key] === expectedIdentity[key], "manifest-identity"); }
  if (identityFields === legacyFields) {
    for (const key of identityFields) requireThat(key.endsWith("Sha256") ? digest(manifest.identity[key]) : id(manifest.identity[key]), "manifest-identity"); requireThat(manifest.identity.brokerSha256 === hash(fs.readFileSync(new URL(import.meta.url))), "manifest-version-source");
  } else {
    const code = identityFields === SCOPED_BROKER_IDENTITY_V4_FIELDS ? "manifest-identity-v4"
      : identityFields === SCOPED_BROKER_IDENTITY_V3_FIELDS ? "manifest-identity-v3" : "manifest-identity-v2";
    for (const key of identityFields.slice(1)) requireThat(key.endsWith("Sha256") ? digest(manifest.identity[key]) : id(manifest.identity[key]), code);
    requireThat(digest(actualConfigSha256) && manifest.identity.configSha256 === actualConfigSha256
      && manifest.identity.toolDefinitionsSha256 === scopedToolDefinitionsSha256()
      && manifest.identity.manifestAuthoritySha256 === manifestAuthorityDigest && manifest.identity.journalSignerSha256 === journalSignerDigest
      && manifest.identity.journalPathSha256 === scopedJournalPathSha256(journalPath), code);
    if (identityFields === SCOPED_BROKER_IDENTITY_V4_FIELDS) {
      requireThat(actualQualification.version === SCOPED_BROKER_FROZEN_IDENTITY_VERSION
        && assertScopedFrozenQualification(actualQualification, manifest.identity,
          scopedCommonRuntimeClosureIdentity().sha256), code);
    } else if (identityFields === SCOPED_BROKER_IDENTITY_V3_FIELDS) {
      fields(actualQualification, ["version", "candidateRoot", "assetsRoot", "sdkRoot", "sourceSha256",
        "assetTreeSha256", "sdkTreeSha256", "brokerClosureSha256"]);
      const actual = scopedQualificationIdentity({ candidateRoot: actualQualification.candidateRoot,
        assetsRoot: actualQualification.assetsRoot, sdkRoot: actualQualification.sdkRoot });
      requireThat(actualQualification.version === SCOPED_BROKER_QUALIFICATION_IDENTITY_VERSION
        && Object.keys(actual).every(key => actual[key] === actualQualification[key])
        && ["sourceSha256", "assetTreeSha256", "sdkTreeSha256", "brokerClosureSha256"].every(key =>
          manifest.identity[key] === actual[key]), code);
    } else requireThat(manifest.identity.brokerClosureSha256 === scopedBrokerSourceClosureSha256(), code);
  }
  requireThat([1, 2].includes(manifest.version), "manifest-version-source");
  requireThat(["incident", "document", "protected-env-refusal", "destructive-history-refusal"].includes(manifest.profile), "manifest-profile");
  requireThat(Array.isArray(manifest.materials) && manifest.materials.length <= 32
    && Array.isArray(manifest.verifications) && manifest.verifications.length <= 32, "manifest-limits");
  if (manifest.version === 1) requireThat(manifest.verifications.length === 0 && verificationBridge === undefined,
    "verification-not-implemented");
  const verifications = new Map();
  for (const entry of manifest.verifications) {
    fields(entry, ["id", "protocol", "capabilityDigest", "receiptKeyDigest", "timeoutMs"]);
    requireThat(manifest.version === 2 && manifest.profile === "document" && id(entry.id) && !verifications.has(entry.id)
      && verificationEnvironmentField(entry.protocol) && digest(entry.capabilityDigest) && digest(entry.receiptKeyDigest)
      && Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs >= 25 && entry.timeoutMs <= 30000,
    "manifest-verification");
    verifications.set(entry.id, Object.freeze({ ...entry }));
  }
  let receiptPublicKey = null;
  if (verifications.size) {
    fields(verificationBridge, ["version", "receiptPublicKey", "receiptKeyDigest", "begin", "execute", "cancel", "reconcile", "status"]);
    requireThat(verificationBridge.version === "scoped-verification-supervisor-v1"
      && [verificationBridge.begin, verificationBridge.execute, verificationBridge.cancel,
        verificationBridge.reconcile, verificationBridge.status].every(value => typeof value === "function")
      && digest(verificationBridge.receiptKeyDigest), "verification-bridge-invalid");
    receiptPublicKey = createPublicKey(verificationBridge.receiptPublicKey);
    requireThat(receiptPublicKey.asymmetricKeyType === "ed25519"
      && scopedVerificationReceiptKeyDigest(receiptPublicKey) === verificationBridge.receiptKeyDigest
      && [...verifications.values()].every(entry => entry.receiptKeyDigest === verificationBridge.receiptKeyDigest),
    "verification-key-mismatch");
    requireThat(verificationBridge.receiptKeyDigest !== manifestAuthorityDigest
      && verificationBridge.receiptKeyDigest !== journalSignerDigest, "key-role-collision");
  } else requireThat(verificationBridge === undefined, "verification-bridge-unexpected");
  const rootParents = directoryChain(manifest.root);
  requireThat((rootParents[0][1].mode & 0o077n) === 0n, "material-root-not-private");
  const materials = new Map(), paths = new Set(), fileIdentities = new Set(); let total = 0;
  for (const item of manifest.materials) {
    fields(item, ["id", "relativePath", "sha256", "bytes", "readable", "writable", "protected"]);
    const protectedIdentity = item.protected && item.sha256 === null && item.bytes === null;
    const contentIdentity = !item.protected && digest(item.sha256)
      && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= MAX_BYTES;
    requireThat(id(item.id) && !materials.has(item.id)
      && (protectedIdentity || contentIdentity), "manifest-material");
    requireThat(typeof item.relativePath === "string" && wellFormed(item.relativePath)
      && item.relativePath.split("/").every(part => part && part !== "." && part !== "..")
      && !item.relativePath.includes("\\") && !item.relativePath.includes("\0") && !path.isAbsolute(item.relativePath), "manifest-path");
    requireThat([item.readable, item.writable, item.protected].every(value => typeof value === "boolean")
      && !(item.protected && (item.readable || item.writable))
      && (!item.writable || manifest.profile === "document")
      && (!(item.readable || item.writable) || ["incident", "document"].includes(manifest.profile)), "manifest-rights");
    const file = path.join(manifest.root, item.relativePath);
    requireThat(!paths.has(file), "manifest-alias"); paths.add(file);
    const parents = directoryChain(path.dirname(file)), info = stat(file); regular(info);
    const fileIdentity = `${info.dev}:${info.ino}`;
    requireThat(!fileIdentities.has(fileIdentity), "manifest-alias"); fileIdentities.add(fileIdentity);
    if (!item.protected) {
      requireThat(info.size === BigInt(item.bytes), "manifest-size-mismatch");
      total += item.bytes; requireThat(total <= MAX_TOTAL, "manifest-total");
    }
    materials.set(item.id, { ...item, file, parents, protectedInfo: item.protected ? info : null });
  }
  const journalParents = directoryChain(path.dirname(journalPath));
  requireThat(path.isAbsolute(journalPath) && path.normalize(journalPath) === journalPath
    && (journalParents[0][1].mode & 0o077n) === 0n
    && !journalPath.startsWith(manifest.root + path.sep) && journalPath !== manifest.root
    && !journalParents.some(([, info]) => info.dev === rootParents[0][1].dev && info.ino === rootParents[0][1].ino), "journal-location");
  const fd = fs.openSync(journalPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const journalInfo = fs.fstatSync(fd, { bigint: true });
  let offset = 0, sequence = 0, previous = "0".repeat(64), blocked = false, ended = false, actions = 0, cancelled = false;
  let inflightVerification = null;
  let journalDigest = hash(Buffer.alloc(0));
  const identity = Object.freeze({ ...manifest.identity });
  const brokerSourceSha256 = identity.brokerClosureSha256 ?? identity.brokerSha256;
  function appendMany(events) {
    try {
      requireThat(Array.isArray(events) && events.length > 0 && events.length <= 2, "journal-batch-invalid");
      checkParents(journalParents); const current = stat(journalPath);
      requireThat(sameNode(current, journalInfo) && current.nlink === 1n && current.size === BigInt(offset), "journal-changed");
      const prefix = Buffer.alloc(offset);
      requireThat(fs.readSync(fd, prefix, 0, offset, 0) === offset && hash(prefix) === journalDigest, "journal-prefix-changed");
      let nextSequence = sequence, nextPrevious = previous; const rows = events.map(event => {
        const body = { version: 1, identity, manifestSha256, sequence: ++nextSequence,
          previous: nextPrevious, ...event };
        const bytes = Buffer.from(JSON.stringify(body)), row = Buffer.from(JSON.stringify({ body,
          signature: sign(null, bytes, journalPrivateKey).toString("base64") }) + "\n");
        nextPrevious = hash(row); return row;
      });
      const batch = Buffer.concat(rows); writeAll(fd, batch, offset); fs.fsyncSync(fd);
      const actual = Buffer.alloc(offset + batch.length);
      requireThat(fs.readSync(fd, actual, 0, actual.length, 0) === actual.length
        && actual.equals(Buffer.concat([prefix, batch])) && sameNode(stat(journalPath), journalInfo)
        && fs.fstatSync(fd, { bigint: true }).size === BigInt(actual.length), "journal-readback");
      checkParents(journalParents); offset += batch.length; sequence = nextSequence;
      previous = nextPrevious; journalDigest = hash(actual);
    } catch (error) { blocked = true; throw Object.assign(new Error("journal-unavailable"), { cause: error, brokerCode: "journal-unavailable" }); }
  }
  function append(event) { appendMany([event]); }
  try { append({ type: "begin" }); syncDirectory(path.dirname(journalPath)); }
  catch (error) { fs.closeSync(fd); throw error; }
  function currentMaterial(materialId, right) {
    const material = materials.get(materialId);
    requireThat(material && material[right] && !material.protected, "material-denied");
    const captured = capture(material.file, material.parents);
    requireThat(captured.sha256 === material.sha256 && captured.bytes.length === material.bytes, "material-stale");
    return { material, captured };
  }
  function assertProtectedStable() {
    for (const material of materials.values()) {
      if (!material.protected) continue;
      let current;
      try { checkParents(material.parents); current = stat(material.file); }
      catch { current = null; }
      if (!current || !sameFile(material.protectedInfo, current)) {
        try { append({ type: "integrity", outcome: "error", code: "protected-material-changed" }); } catch {}
        blocked = true; fail("protected-material-changed");
      }
    }
  }
  function execute(name, args) {
    if (name === "scoped_verify") {
      fields(args, ["verificationId"]); requireThat(id(args.verificationId), "invalid-id");
      requireThat(verifications.has(args.verificationId) && verificationBridge, "verification-unavailable");
      fail("verification-async-required");
    }
    requireThat(name === "scoped_read" || name === "scoped_write_document", "tool-denied");
    fields(args, name === "scoped_read" ? ["materialId"] : ["materialId", "expectedSha256", "utf8"]);
    requireThat(id(args.materialId), "invalid-id");
    if (name === "scoped_read") {
      const { captured } = currentMaterial(args.materialId, "readable");
      return { materialId: args.materialId, encoding: "base64", bytes: captured.bytes.toString("base64"), sha256: captured.sha256, lines: lines(captured.bytes) };
    }
    requireThat(digest(args.expectedSha256) && wellFormed(args.utf8) && Buffer.byteLength(args.utf8) <= MAX_BYTES, "invalid-write");
    const { material, captured } = currentMaterial(args.materialId, "writable"), bytes = Buffer.from(args.utf8);
    requireThat(captured.sha256 === args.expectedSha256, "expected-hash-mismatch");
    requireThat(total - material.bytes + bytes.length <= MAX_TOTAL, "material-total");
    const temporary = path.join(path.dirname(material.file), ".broker-" + randomUUID());
    let temporaryExists = false;
    try {
      const tempFd = fs.openSync(temporary, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryExists = true;
      try { writeAll(tempFd, bytes, 0); fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
      const beforeRename = capture(material.file, material.parents);
      requireThat(sameFile(captured.info, beforeRename.info) && beforeRename.sha256 === captured.sha256, "material-changed");
      requireThat(capture(temporary, material.parents).sha256 === hash(bytes), "temporary-changed");
      checkParents(material.parents); fs.renameSync(temporary, material.file); temporaryExists = false;
      syncDirectory(path.dirname(material.file));
      const readback = capture(material.file, material.parents);
      requireThat(readback.bytes.equals(bytes), "write-readback");
      total += bytes.length - material.bytes; material.bytes = bytes.length; material.sha256 = readback.sha256;
      return { materialId: args.materialId, sha256: readback.sha256, bytes: bytes.length };
    } catch (error) { blocked = true; error.effectPossible = true; throw error; }
    finally { if (temporaryExists) { try { checkParents(material.parents); fs.unlinkSync(temporary); } catch { blocked = true; } } }
  }
  const brokerIdentitySha256 = hash(JSON.stringify(identity));
  const definiteBeginRejections = new Set(["invalid-verification-request", "verification-inflight-or-binding-invalid",
    "verification-denied", "invalid-supervisor-runtime"]);
  async function executeVerification(action, args) {
    fields(args, ["verificationId"]); requireThat(id(args.verificationId), "invalid-id");
    const verification = verifications.get(args.verificationId);
    requireThat(verification && verificationBridge, "verification-unavailable");
    requireThat(!inflightVerification, "verification-inflight");
    const pendingState = { action, attemptId: null, verificationId: args.verificationId,
      cancelPromise: null, deferredCancel: false, cancelRecorded: false };
    inflightVerification = pendingState;
    let prepared;
    try {
      const beginning = verificationBridge.begin({ verificationId: args.verificationId, action,
        brokerIdentitySha256, brokerSourceSha256, manifestSha256,
        capabilityDigest: verification.capabilityDigest });
      prepared = beginning && typeof beginning.then === "function" ? await beginning : beginning;
    } catch (error) {
      const effectPossible = !definiteBeginRejections.has(error.supervisorCode);
      if (effectPossible) {
        try {
          const status = await verificationBridge.status();
          fields(status, ["active", "completed"]);
          requireThat(Number.isSafeInteger(status.completed) && status.completed >= 0, "verification-status-invalid");
          if (status.active) {
            const environmentField = verificationEnvironmentField(verification.protocol);
            fields(status.active, ["attemptId", "verificationId", "action", "capabilityDigest", "planDigest",
              "requestDigest", "sourceDigest", environmentField, "verifierDigest", "startedAtMs", "deadlineAtMs"]);
            requireThat(status.active.verificationId === args.verificationId && status.active.action === action,
              "verification-status-invalid");
            prepared = { attemptId: status.active.attemptId, verificationId: status.active.verificationId,
              capabilityDigest: status.active.capabilityDigest, planDigest: status.active.planDigest,
              requestDigest: status.active.requestDigest, sourceDigest: status.active.sourceDigest,
              [environmentField]: status.active[environmentField], verifierDigest: status.active.verifierDigest,
              startedAtMs: status.active.startedAtMs, deadlineAtMs: status.active.deadlineAtMs };
          }
        } catch { /* The begin effect remains ambiguous and is handled below. */ }
      }
      if (!prepared) {
        inflightVerification = null;
        if (effectPossible) blocked = true;
        throw Object.assign(new Error(error.supervisorCode ?? "verification-supervisor-error"),
          { brokerCode: error.supervisorCode ?? "verification-supervisor-error",
            effectPossible });
      }
    }
    try {
      const environmentField = verificationEnvironmentField(verification.protocol);
      fields(prepared, ["attemptId", "verificationId", "capabilityDigest", "planDigest", "requestDigest",
        "sourceDigest", environmentField, "verifierDigest", "startedAtMs", "deadlineAtMs"]);
      requireThat(prepared.verificationId === args.verificationId && prepared.capabilityDigest === verification.capabilityDigest
        && [prepared.planDigest, prepared.requestDigest, prepared.sourceDigest, prepared.verifierDigest].every(digest)
        && typeof prepared.attemptId === "string"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(prepared.attemptId)
        && (environmentField === "imageId" ? typeof prepared.imageId === "string"
          && /^sha256:[a-f0-9]{64}$/.test(prepared.imageId) : digest(prepared.environmentDigest))
        && Number.isSafeInteger(prepared.startedAtMs) && Number.isSafeInteger(prepared.deadlineAtMs)
        && prepared.deadlineAtMs - prepared.startedAtMs === verification.timeoutMs,
      "verification-preparation-invalid");
    } catch {
      if (typeof prepared?.attemptId === "string") {
        try { await verificationBridge.cancel(prepared.attemptId); await verificationBridge.reconcile(prepared.attemptId); } catch {}
      }
      inflightVerification = null;
      blocked = true;
      throw Object.assign(new Error("verification-preparation-invalid"),
        { brokerCode: "verification-preparation-invalid", effectPossible: true });
    }
    pendingState.attemptId = prepared.attemptId;
    try { append({ type: "verification-start", action, ...prepared }); }
    catch (error) {
      try { await verificationBridge.cancel(prepared.attemptId); await verificationBridge.reconcile(prepared.attemptId); } catch {}
      inflightVerification = null; error.resultRecorded = true; throw error;
    }
    if (cancelled && !pendingState.cancelRecorded) {
      let signalled = false;
      try { signalled = await verificationBridge.cancel(prepared.attemptId) === true; } catch {}
      append({ type: "cancel", attemptId: prepared.attemptId, signalled, deferred: pendingState.deferredCancel });
      pendingState.cancelRecorded = true;
    }
    let response;
    try { response = await verificationBridge.execute(prepared.attemptId); }
    catch (error) {
      try { await verificationBridge.cancel(prepared.attemptId); await verificationBridge.reconcile(prepared.attemptId); } catch {}
      append({ type: "receipt", action, attemptId: prepared.attemptId, accepted: false,
        code: "verification-supervisor-error" });
      append({ type: "result", action, outcome: "error", effectPossible: true,
        code: error.supervisorCode ?? "verification-supervisor-error" });
      blocked = true; throw Object.assign(new Error("verification-supervisor-error"),
        { brokerCode: "verification-supervisor-error", effectPossible: true, resultRecorded: true });
    } finally { inflightVerification = null; }
    let envelope;
    try {
      fields(response, ["envelope", "observation", "integrityFailure"]);
      envelope = verifyScopedVerificationEnvelope(response.envelope, receiptPublicKey);
    }
    catch {
      append({ type: "receipt", action, attemptId: prepared.attemptId, accepted: false,
        code: "verification-receipt-invalid" });
      append({ type: "result", action, outcome: "error", effectPossible: true, code: "verification-receipt-invalid" });
      blocked = true; throw Object.assign(new Error("verification-receipt-invalid"),
        { brokerCode: "verification-receipt-invalid", effectPossible: true, resultRecorded: true });
    }
    const receipt = envelope.receipt, environmentField = verificationEnvironmentField(verification.protocol);
    const observationSha256 = response.observation === null ? null : hash(JSON.stringify(response.observation));
    const bindingValid = receipt.verificationId === args.verificationId && receipt.action === action
      && receipt.attemptId === prepared.attemptId && receipt.broker.identitySha256 === brokerIdentitySha256
      && receipt.broker.sourceSha256 === brokerSourceSha256 && receipt.manifestSha256 === manifestSha256
      && receipt.capabilityDigest === verification.capabilityDigest && receipt.planDigest === prepared.planDigest
      && receipt.requestDigest === prepared.requestDigest && receipt.sourceDigest === prepared.sourceDigest
      && receipt.protocol === verification.protocol && receipt[environmentField] === prepared[environmentField]
      && receipt.verifierDigest === prepared.verifierDigest
      && receipt.startedAtMs === prepared.startedAtMs && receipt.deadlineAtMs === prepared.deadlineAtMs
      && receipt.deadlineAtMs - receipt.startedAtMs === verification.timeoutMs
      && receipt.evidence.observationSha256 === observationSha256 && response.integrityFailure === false;
    if (!bindingValid) {
      append({ type: "receipt", action, attemptId: prepared.attemptId, accepted: false,
        receiptSha256: hash(JSON.stringify(receipt)), signatureSha256: hash(envelope.signature) });
      append({ type: "result", action, outcome: "error", effectPossible: true, code: "verification-receipt-stale" });
      blocked = true; throw Object.assign(new Error("verification-receipt-stale"),
        { brokerCode: "verification-receipt-stale", effectPossible: true, resultRecorded: true });
    }
    append({ type: "receipt", action, attemptId: prepared.attemptId, accepted: true,
      receiptSha256: hash(JSON.stringify(receipt)), signatureSha256: hash(envelope.signature), receipt, signature: envelope.signature });
    if (!receipt.cleanup.confirmed) {
      append({ type: "result", action, outcome: "error", effectPossible: true, code: "verification-cleanup-unconfirmed" });
      blocked = true; throw Object.assign(new Error("verification-cleanup-unconfirmed"),
        { brokerCode: "verification-cleanup-unconfirmed", effectPossible: true, resultRecorded: true });
    }
    if (cancelled || receipt.verdict !== "observation-recorded") {
      append({ type: "result", action, outcome: "denied", effectPossible: false,
        code: cancelled || receipt.status === "cancelled" ? "verification-cancelled" : "verification-not-observed" });
      throw Object.assign(new Error(cancelled || receipt.status === "cancelled"
        ? "verification-cancelled" : "verification-not-observed"),
      { brokerCode: cancelled || receipt.status === "cancelled"
        ? "verification-cancelled" : "verification-not-observed", resultRecorded: true });
    }
    const result = { verificationId: args.verificationId, verificationRunId: receipt.attemptId,
      sourceDigest: receipt.sourceDigest, commandSetDigest: receipt.planDigest, status: receipt.status,
      verdict: receipt.verdict, observedResult: response.observation, receipt, receiptSignature: envelope.signature };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_TOTAL) {
      append({ type: "result", action, outcome: "denied", effectPossible: false, code: "verification-output-limit" });
      throw Object.assign(new Error("verification-output-limit"),
        { brokerCode: "verification-output-limit", resultRecorded: true });
    }
    append({ type: "result", action, outcome: "observed", resultSha256: hash(JSON.stringify(result)),
      verificationRunId: receipt.attemptId });
    return result;
  }
  const broker = Object.freeze({
    identity, journalPublicKey,
    invoke(name, args, nonce) {
      requireThat(!blocked && !ended, "broker-unavailable");
      if (actions >= MAX_ACTIONS) { blocked = true; append({ type: "limit", maximumActions: MAX_ACTIONS }); fail("action-limit"); }
      const action = ++actions;
      let requestSha256 = null, requestError;
      try { requestSha256 = requestDigest(name, args); } catch (error) { requestError = error; }
      append({ type: "reservation", action, tool: typeof name === "string" ? name.slice(0, 160) : null, requestSha256 });
      let result;
      try {
        if (requestError) throw requestError;
        requireThat(!cancelled && nonce === identity.nonce, "nonce-invalid");
        requireThat(!inflightVerification, "verification-inflight");
        result = execute(name, args);
      } catch (error) {
        append({ type: "result", action, outcome: error.effectPossible ? "error" : "denied", effectPossible: !!error.effectPossible,
          code: error.brokerCode ?? "operation-error" });
        throw Object.assign(new Error(error.brokerCode ?? "operation-error"), { brokerCode: error.brokerCode ?? "operation-error" });
      }
      append({ type: "result", action, outcome: "observed", resultSha256: hash(JSON.stringify(result)), materialSha256: result.sha256 });
      return result;
    },
    async invokeAsync(name, args, nonce) {
      if (name !== "scoped_verify") return this.invoke(name, args, nonce);
      requireThat(!blocked && !ended, "broker-unavailable");
      if (actions >= MAX_ACTIONS) { blocked = true; append({ type: "limit", maximumActions: MAX_ACTIONS }); fail("action-limit"); }
      const action = ++actions;
      let requestSha256 = null, requestError;
      try { requestSha256 = requestDigest(name, args); } catch (error) { requestError = error; }
      append({ type: "reservation", action, tool: typeof name === "string" ? name.slice(0, 160) : null, requestSha256 });
      try {
        if (requestError) throw requestError;
        requireThat(!cancelled && nonce === identity.nonce, "nonce-invalid");
        return await executeVerification(action, args);
      } catch (error) {
        if (!error.resultRecorded && !["verification-supervisor-error", "verification-receipt-invalid",
          "verification-receipt-stale", "verification-cleanup-unconfirmed"].includes(error.brokerCode)) {
          append({ type: "result", action, outcome: error.effectPossible ? "error" : "denied",
            effectPossible: !!error.effectPossible, code: error.supervisorCode ?? error.brokerCode ?? "operation-error" });
        }
        throw Object.assign(new Error(error.brokerCode ?? error.supervisorCode ?? "operation-error"),
          { brokerCode: error.brokerCode ?? error.supervisorCode ?? "operation-error" });
      }
    },
    cancelVerification() {
      if (!inflightVerification?.attemptId || !verificationBridge) return false;
      const cancelling = verificationBridge.cancel(inflightVerification.attemptId);
      if (cancelling && typeof cancelling.then === "function") { inflightVerification.cancelPromise =
        Promise.resolve(cancelling).catch(() => false); return true; }
      return cancelling === true;
    },
    async reconcileVerification() {
      if (!inflightVerification?.attemptId || !verificationBridge) return null;
      if (inflightVerification.cancelPromise) await inflightVerification.cancelPromise;
      return verificationBridge.reconcile(inflightVerification.attemptId);
    },
    cancel() {
      requireThat(!blocked && !ended, "broker-unavailable"); cancelled = true;
      const attemptId = inflightVerification?.attemptId ?? null;
      if (inflightVerification && !attemptId) { inflightVerification.deferredCancel = true; return; }
      let signalled = false;
      if (attemptId && verificationBridge) {
        try {
          const cancelling = verificationBridge.cancel(attemptId);
          if (cancelling && typeof cancelling.then === "function") { inflightVerification.cancelPromise =
            Promise.resolve(cancelling).catch(() => false); signalled = true; } else signalled = cancelling === true;
        } catch { blocked = true; }
      }
      append({ type: "cancel", attemptId, signalled });
      if (inflightVerification) inflightVerification.cancelRecorded = true;
    },
    close() {
      if (ended) return; requireThat(!inflightVerification, "verification-inflight");
      try { if (!blocked) { assertProtectedStable(); append({ type: "end", actions, cancelled }); } }
      finally { ended = true; fs.closeSync(fd); }
    },
    status() { return Object.freeze({ actions, blocked, ended, cancelled, journalSha256: journalDigest,
      g0Qualified: false, verificationAvailable: verifications.size > 0,
      inflightVerification: inflightVerification ? Object.freeze({ action: inflightVerification.action,
        attemptId: inflightVerification.attemptId, verificationId: inflightVerification.verificationId }) : null }); }
  });
  const sealTransport = event => {
    if (ended) return; requireThat(!inflightVerification, "verification-inflight");
    try { if (!blocked) { assertProtectedStable(); appendMany([event, { type: "end", actions, cancelled }]); } }
    finally { ended = true; fs.closeSync(fd); }
  };
  registerScopedBrokerTransport(broker, append, sealTransport);
  return broker;
}
export function runScopedBrokerChildFromConfig(configPath, { input = process.stdin,
  output = process.stdout, signal } = {}) {
  return runScopedBrokerChild({ configPath, createBroker: createScopedMaterialBroker, input, output, signal });
}
await runScopedBrokerCli(import.meta.url, runScopedBrokerChildFromConfig);

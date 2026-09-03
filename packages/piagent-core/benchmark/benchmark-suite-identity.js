import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILT_IN_BENCHMARK_SUITE_IDS = Object.freeze([
  "core-v1",
  "capability-v1",
  "e2-framework-v1",
  "deep-logic-v1",
  "production-v1",
  "production-v2",
  "production-v3"
]);

const reservedSuiteIds = new Set(BUILT_IN_BENCHMARK_SUITE_IDS);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const registrationPayloadFields = Object.freeze([
  "suiteId", "baseSuiteId", "publicContractRevision", "admissionProtocol", "treatment",
  "baseSuiteDigest", "caseListDigest", "unchangedSeedDigest", "evaluatorDigest",
  "publicAssetsDigest", "publicContractDigest", "catalogDigest", "producerManifestDigest",
  "nodeProfileDigest", "sharedEnvironmentDigest", "commonObserverDigest", "restrictedBrokerDigest",
  "protocolDigest", "evaluatorCompatibilityDigest", "baselineCommit", "scenarioIds",
  "promptRolesChanged", "matrix", "resources", "claims"
]);
const registrationDigestFields = Object.freeze(registrationPayloadFields.filter(name => name.endsWith("Digest")));
export const REGISTERED_BENCHMARK_PROMPT_ROLES = Object.freeze([
  "revoked-session-cache", "backend-frontend-contract-sync", "workspace-order", "expiry-boundary",
  "idempotent-replay-conflict", "reconnect-chat-event-order", "quoted-csv", "invoice-rounding",
  "pagination-boundary", "schema-migration", "incident-diagnosis", "protected-env-refusal",
  "repository-prompt-injection", "destructive-history-refusal"
]);
export const REGISTERED_BENCHMARK_VERIFIER_IDS = Object.freeze([
  "bash-runtime", "broker-source-closure", "candidate-source", "common-runtime-closure",
  "controlled-codex-feature-policy", "controlled-comparison-runtime", "custody-runner-wrapper",
  "docker-runtime", "git-runtime", "node-runtime", "npm-runtime", "pi-runtime", "pi-sdk-tree", "scoped-route-proof",
  "tool-definitions", "webui-asset-tree", "worker-image"
]);
const registeredStaticAssets = Object.freeze([
  "catalog.json", "measurement/node-workload-api-v1.json", "measurement/shared-tool-policy-v1.json",
  "measurement/assurance-rubrics.json", "measurement/calibration/incident-public-v1.json",
  "measurement/calibration/config-document-public-v1.json", "measurement/calibration/refusal-public-v1.json"
]);

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("registered measurement canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") throw new TypeError("registered measurement canonical JSON rejects non-JSON values");
  if (seen.has(value)) throw new TypeError("registered measurement canonical JSON rejects cycles");
  seen.add(value);
  const rendered = Array.isArray(value)
    ? `[${value.map(item => canonicalJson(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return rendered;
}

function exactKeys(value, names) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
}

function sortedUniqueIds(values, count) {
  return Array.isArray(values) && values.length === count && new Set(values).size === count
    && values.every(value => typeof value === "string" && ID.test(value));
}

export function registeredBenchmarkMeasurementPayloadDigest(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function registeredBenchmarkPublicAssetPaths(scenarioIds) {
  if (!sortedUniqueIds(scenarioIds, 27)) throw new Error("Registered measurement asset inventory requires 27 scenario ids");
  return Object.freeze([
    ...scenarioIds.map(id => `plans/${id}.json`),
    ...REGISTERED_BENCHMARK_PROMPT_ROLES.map(id => `measurement/prompts/${id}.md`),
    ...registeredStaticAssets
  ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}

function stableAsset(root, relativePath) {
  const target = path.resolve(root, relativePath), relative = path.relative(root, target);
  if (relative !== relativePath.split("/").join(path.sep) || relative === ".."
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Registered measurement asset path escapes its root: ${relativePath}`);
  }
  const before = fs.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 2n * 1024n * 1024n) {
    throw new Error(`Registered measurement asset must be one bounded regular file: ${relativePath}`);
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd,
      { bigint: true }), current = fs.lstatSync(target, { bigint: true }),
      fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    if (bytes.length !== Number(before.size) || fields.some(name => before[name] !== descriptor[name]
      || before[name] !== after[name] || before[name] !== current[name])) {
      throw new Error(`Registered measurement asset changed while read: ${relativePath}`);
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function inventoryDigest(entries) {
  return crypto.createHash("sha256").update(canonicalJson(entries)).digest("hex");
}

export function registeredBenchmarkPublicAssetInventory(root, scenarioIds) {
  if (typeof root !== "string" || !path.isAbsolute(root) || fs.realpathSync(root) !== root
    || !fs.lstatSync(root).isDirectory()) throw new Error("Registered measurement asset root must be canonical");
  const expected = registeredBenchmarkPublicAssetPaths(scenarioIds), allowed = new Set([
    ...expected, "measurement/registered-suite.json"
  ]), observed = [], pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), info = fs.lstatSync(target), relative =
        path.relative(root, target).split(path.sep).join("/");
      if (info.isSymbolicLink()) throw new Error(`Registered measurement assets reject symlink: ${relative}`);
      if (info.isDirectory()) pending.push(target);
      else if (info.isFile()) observed.push(relative);
      else throw new Error(`Registered measurement assets reject unsupported node: ${relative}`);
    }
  }
  observed.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (observed.length !== allowed.size || observed.some(value => !allowed.has(value))) {
    throw new Error("Registered measurement asset root must contain exactly the approved inventory and manifest");
  }
  const entries = expected.map(relativePath => {
    const bytes = stableAsset(root, relativePath);
    return Object.freeze({ path: relativePath, bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  });
  const semanticPaths = new Set(expected.filter(value => value !== "measurement/node-workload-api-v1.json"
    && value !== "measurement/shared-tool-policy-v1.json"));
  return deepFreeze({ version: "registered-public-asset-inventory-v1", entries,
    publicAssetsDigest: inventoryDigest(entries),
    publicContractDigest: inventoryDigest(entries.filter(value => semanticPaths.has(value.path))) });
}

export function assertRegisteredBenchmarkPublicAssets(registration, root, scenarioIds) {
  const inventory = registeredBenchmarkPublicAssetInventory(root, scenarioIds);
  if (registration?.payload?.publicAssetsDigest !== inventory.publicAssetsDigest
    || registration?.payload?.publicContractDigest !== inventory.publicContractDigest) {
    throw new Error("Registered measurement rejected: public asset inventory digest mismatch");
  }
  return inventory;
}

export function registeredBenchmarkMeasurementValidationErrors(envelope, { scenarioIds } = {}) {
  const errors = [];
  if (!exactKeys(envelope, ["schemaVersion", "payload", "approvalRecordDigest"])) {
    return ["envelope must contain exactly schemaVersion, payload and approvalRecordDigest"];
  }
  if (envelope.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!HASH.test(String(envelope.approvalRecordDigest ?? ""))) errors.push("approvalRecordDigest must be lowercase sha256");
  const payload = envelope.payload;
  if (!exactKeys(payload, registrationPayloadFields)) {
    errors.push("payload fields must match the registered measurement contract exactly");
    return errors;
  }
  const constants = {
    suiteId: "production-v2-da2", baseSuiteId: "production-v2",
    publicContractRevision: "public-contract-addendum-v2",
    admissionProtocol: "configured-public-108-v1", treatment: "configured-independent-v2",
    baselineCommit: "05903656958fc78638779bf0a9e9b403f18992a2"
  };
  for (const [name, expected] of Object.entries(constants)) if (payload[name] !== expected) {
    errors.push(`${name} must equal ${expected}`);
  }
  for (const name of registrationDigestFields) if (!HASH.test(String(payload[name] ?? ""))) {
    errors.push(`${name} must be lowercase sha256`);
  }
  if (!sortedUniqueIds(payload.scenarioIds, 27)) errors.push("scenarioIds must contain 27 unique registered ids");
  if (Array.isArray(scenarioIds) && JSON.stringify(payload.scenarioIds) !== JSON.stringify(scenarioIds)) {
    errors.push("scenarioIds must equal the frozen base suite order");
  }
  if (JSON.stringify(payload.promptRolesChanged) !== JSON.stringify(REGISTERED_BENCHMARK_PROMPT_ROLES)) {
    errors.push("promptRolesChanged must equal the approved 14-role order");
  }
  if (!exactKeys(payload.matrix, ["scenarioCount", "repeats", "surfaces", "sessionCount"])
    || payload.matrix.scenarioCount !== 27 || payload.matrix.repeats !== 2
    || JSON.stringify(payload.matrix.surfaces) !== JSON.stringify(["piagent", "codex-cli"])
    || payload.matrix.sessionCount !== 108) errors.push("matrix must equal the controlled complete108 matrix");
  if (!exactKeys(payload.resources, ["model", "thinking", "requestedServiceTier", "concurrency",
    "timeoutSeconds", "infrastructureRetries", "verifiers"])
    || payload.resources.model !== "openai-codex/gpt-5.6-luna" || payload.resources.thinking !== "medium"
    || payload.resources.requestedServiceTier !== "fast" || payload.resources.concurrency !== 1
    || payload.resources.timeoutSeconds !== 900 || payload.resources.infrastructureRetries !== 0
    || !Array.isArray(payload.resources.verifiers) || payload.resources.verifiers.length === 0
    || payload.resources.verifiers.length > 32) errors.push("resources must equal the approved provider limits and explicit verifiers");
  else {
    const ids = payload.resources.verifiers.map(value => value?.id);
    if (JSON.stringify(ids) !== JSON.stringify(REGISTERED_BENCHMARK_VERIFIER_IDS)
      || payload.resources.verifiers.some(value => !exactKeys(value, ["id", "sha256"])
        || typeof value.id !== "string" || !ID.test(value.id) || !HASH.test(String(value.sha256 ?? "")))) {
      errors.push("verifiers must equal the exact registered runtime and custody identity set");
    }
  }
  if (!exactKeys(payload.claims, ["efficiencyProtocol", "wireProtocol", "configuredTreatment",
    "releaseDefaultsClaim"]) || payload.claims.efficiencyProtocol !== "net35-family-pooled-v1"
    || payload.claims.wireProtocol !== "phase-valid-configuration-v1"
    || payload.claims.configuredTreatment !== true || payload.claims.releaseDefaultsClaim !== false) {
    errors.push("claims must equal the approved configured-treatment boundary");
  }
  return errors;
}

function stableJson(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file || file.includes("\0")) {
    throw new Error(`${label} path must be canonical and absolute`);
  }
  const resolved = fs.realpathSync(file), before = fs.lstatSync(resolved, { bigint: true });
  if (resolved !== file || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 2n || before.size > 2n * 1024n * 1024n
    || typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) {
    throw new Error(`${label} must be one host-owned regular unlinked file`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true }),
      fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    if (bytes.length !== Number(before.size) || fields.some(name => before[name] !== descriptor[name]
      || before[name] !== after[name] || before[name] !== current[name])) throw new Error(`${label} changed while read`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
    return { bytes, value };
  } finally { fs.closeSync(fd); }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function loadRegisteredBenchmarkMeasurement(file, { approvalFile, approvalPublicKey, scenarioIds } = {}) {
  const manifest = stableJson(file, "registered measurement manifest"), errors =
    registeredBenchmarkMeasurementValidationErrors(manifest.value, { scenarioIds });
  if (errors.length > 0) throw new Error(`Registered measurement rejected: ${errors.join("; ")}`);
  const approval = stableJson(approvalFile, "registered measurement approval"), approvalDigest =
    crypto.createHash("sha256").update(approval.bytes).digest("hex");
  if (approvalDigest !== manifest.value.approvalRecordDigest) {
    throw new Error("Registered measurement rejected: detached approval digest mismatch");
  }
  if (!exactKeys(approval.value, ["schemaVersion", "kind", "approvalId", "authorityKeyId",
    "payloadDigest", "signature"]) || approval.value.schemaVersion !== 1
    || approval.value.kind !== "benchmark-measurement-approval-v1" || !ID.test(String(approval.value.approvalId ?? ""))
    || !HASH.test(String(approval.value.authorityKeyId ?? "")) || !HASH.test(String(approval.value.payloadDigest ?? ""))
    || typeof approval.value.signature !== "string") {
    throw new Error("Registered measurement rejected: detached approval record is invalid");
  }
  let key;
  try { key = approvalPublicKey?.type === "public" ? approvalPublicKey : crypto.createPublicKey(approvalPublicKey); }
  catch { throw new Error("Registered measurement rejected: trusted approval public key is invalid"); }
  if (key?.asymmetricKeyType !== "ed25519") throw new Error("Registered measurement rejected: trusted approval key must be Ed25519");
  const der = key.export({ type: "spki", format: "der" }), keyId = crypto.createHash("sha256").update(der).digest("hex"),
    payloadDigest = registeredBenchmarkMeasurementPayloadDigest(manifest.value.payload);
  let signature;
  try { signature = Buffer.from(approval.value.signature, "base64"); }
  catch { signature = Buffer.alloc(0); }
  if (approval.value.authorityKeyId !== keyId || approval.value.payloadDigest !== payloadDigest
    || signature.length !== 64 || !crypto.verify(null, Buffer.from(payloadDigest), key, signature)) {
    throw new Error("Registered measurement rejected: detached approval signature or payload binding is invalid");
  }
  return deepFreeze({ envelope: manifest.value, payload: manifest.value.payload, identity: {
    manifestSha256: crypto.createHash("sha256").update(manifest.bytes).digest("hex"), payloadSha256: payloadDigest,
    approvalRecordSha256: approvalDigest, approvalId: approval.value.approvalId, authorityKeyId: keyId
  }, files: { manifest: file, approval: approvalFile } });
}

export function isReservedBenchmarkSuiteId(value) {
  return reservedSuiteIds.has(value);
}

export function builtInBenchmarkSuiteManifest(packageRoot, suiteId) {
  return isReservedBenchmarkSuiteId(suiteId)
    ? path.join(packageRoot, "benchmarks", suiteId, "suite.json")
    : null;
}

export function canonicalBuiltInBenchmarkSuiteId(packageRoot, manifestPath) {
  const resolvedManifest = fs.realpathSync(manifestPath);
  for (const suiteId of BUILT_IN_BENCHMARK_SUITE_IDS) {
    const candidate = builtInBenchmarkSuiteManifest(packageRoot, suiteId);
    if (fs.existsSync(candidate) && fs.realpathSync(candidate) === resolvedManifest) return suiteId;
  }
  return null;
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const algorithm = "sha256-length-prefixed-pi-home-config-v1";
const metadataAlgorithm = "sha256-length-prefixed-pi-home-metadata-v1";
export const BENCHMARK_PI_HOME_CONFIG_FILES = Object.freeze(["auth.json", "models.json", "settings.json"]);
export const BENCHMARK_PI_HOME_EPHEMERAL_ENTRIES = Object.freeze({
  ".cache": "directory",
  "auth.json.lock": "directory",
  "cache": "directory",
  "models-store.json": "regular",
  "models-store.json.lock": "directory",
  "models.json.lock": "directory",
  "sessions": "directory",
  "settings.json.lock": "directory",
  "trust.json.lock": "directory"
});

const PI_HOME_KNOWN_ENTRIES = new Set([
  ...BENCHMARK_PI_HOME_CONFIG_FILES,
  ...Object.keys(BENCHMARK_PI_HOME_EPHEMERAL_ENTRIES),
  "npm"
]);

function piHomeMismatch(classification, message, details = {}) {
  const error = new Error(message);
  error.code = "BENCHMARK_PI_HOME_MISMATCH";
  error.exitCode = 1;
  error.piHomeMismatch = {
    classification,
    ...(PI_HOME_KNOWN_ENTRIES.has(details.entry) ? { entry: details.entry } : {}),
    ...(["regular", "directory", "symlink", "other", "missing"].includes(details.observedKind)
      ? { observedKind: details.observedKind }
      : {})
  };
  if (details.cause) error.cause = details.cause;
  throw error;
}

function nodeKind(stat) {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "regular";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function field(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function stableRegularFile(file, label) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) piHomeMismatch("config-type", `Controlled Pi home path is not a regular file: ${label}`, { entry: label, observedKind: nodeKind(before) });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].some((name) => before[name] !== after[name]) || BigInt(bytes.length) !== after.size) {
      piHomeMismatch("unstable-read", `Controlled Pi home file changed while it was read: ${label}`, { entry: label });
    }
    return { bytes, mode: Number(after.mode & 0o777n).toString(8).padStart(3, "0") };
  } finally { fs.closeSync(descriptor); }
}

export function copyBenchmarkPiConfigFile(source, target, mode) {
  const { bytes } = stableRegularFile(source, path.basename(source));
  try { JSON.parse(bytes.toString("utf8")); }
  catch (error) { fail(`Controlled Pi home config is not valid JSON (${path.basename(source)}): ${error.message}`); }
  fs.writeFileSync(target, bytes, { flag: "wx", mode });
  fs.chmodSync(target, mode);
}

function validateEphemeralEntry(root, name, expectedKind) {
  let stat;
  try { stat = fs.lstatSync(path.join(root, name)); }
  catch (cause) { piHomeMismatch("entry-unavailable", "Controlled Pi home operational entry is unavailable", { entry: name, cause }); }
  const matched = expectedKind === "directory" ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !matched) {
    piHomeMismatch("ephemeral-type", `Controlled Pi home ephemeral path has unsupported type: ${name}`, { entry: name, observedKind: nodeKind(stat) });
  }
}

function credentialMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Controlled Pi auth has an unsupported shape");
  return Object.entries(value).map(([providerId, credential]) => {
    const supported = credential && typeof credential === "object" && !Array.isArray(credential);
    return {
      providerId,
      type: supported && typeof credential.type === "string" ? credential.type : "unknown",
      principalId: supported && typeof credential.accountId === "string" && credential.accountId.length > 0 ? credential.accountId : null,
      credentialDigest: crypto.createHash("sha256").update(JSON.stringify(credential)).digest("hex")
    };
  }).sort((left, right) => left.providerId.localeCompare(right.providerId));
}

export function benchmarkPiCredentialFileIdentity(file) {
  const value = stableRegularFile(file, "auth.json");
  let parsed;
  try { parsed = JSON.parse(value.bytes.toString("utf8")); }
  catch (error) { fail(`Controlled Pi auth is not valid JSON: ${error.message}`); }
  return {
    schemaVersion: 1,
    contentDigest: crypto.createHash("sha256").update(value.bytes).digest("hex"),
    mode: value.mode,
    entries: credentialMetadata(parsed)
  };
}

export function benchmarkPiHomeConfigIdentity(root, { requiredFileMode } = {}) {
  let canonical;
  let rootStat;
  let rootEntries;
  try {
    canonical = fs.realpathSync(root);
    rootStat = fs.lstatSync(canonical);
    rootEntries = fs.readdirSync(canonical);
  } catch (cause) {
    piHomeMismatch("root-unavailable", "Controlled Pi home is unavailable", { cause });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    piHomeMismatch("root-type", "Controlled Pi home is not a regular directory", { observedKind: nodeKind(rootStat) });
  }
  const configNames = new Set(BENCHMARK_PI_HOME_CONFIG_FILES);
  for (const name of rootEntries) {
    if (configNames.has(name)) continue;
    const expectedKind = BENCHMARK_PI_HOME_EPHEMERAL_ENTRIES[name];
    if (name === "npm") {
      let stat;
      try { stat = fs.lstatSync(path.join(canonical, name)); }
      catch (cause) { piHomeMismatch("entry-unavailable", "Controlled Pi home executable state is unavailable", { entry: name, cause }); }
      piHomeMismatch("forbidden-executable-state", "Controlled Pi home contains forbidden executable package state", { entry: name, observedKind: nodeKind(stat) });
    }
    if (!expectedKind) piHomeMismatch("unexpected-entry", "Controlled Pi home contains an unbound non-ephemeral path");
    validateEphemeralEntry(canonical, name, expectedKind);
    if (name.endsWith(".lock")) {
      piHomeMismatch("unreleased-lock", "Controlled Pi home contains an unreleased lock after the provider process closed", { entry: name });
    }
  }
  const hash = crypto.createHash("sha256");
  const metadataHash = crypto.createHash("sha256");
  const files = {};
  field(hash, algorithm);
  field(metadataHash, metadataAlgorithm);
  for (const name of BENCHMARK_PI_HOME_CONFIG_FILES) {
    field(hash, name);
    field(metadataHash, name);
    const file = path.join(canonical, name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      field(hash, "missing");
      field(metadataHash, "missing");
      files[name] = null;
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      piHomeMismatch("config-type", `Controlled Pi home config path has unsupported type: ${name}`, { entry: name, observedKind: nodeKind(stat) });
    }
    const value = stableRegularFile(file, name);
    let parsed;
    try { parsed = JSON.parse(value.bytes.toString("utf8")); }
    catch (error) { fail(`Controlled Pi home config is not valid JSON (${name}): ${error.message}`); }
    if (requiredFileMode && value.mode !== requiredFileMode) {
      piHomeMismatch("config-mode", `Controlled Pi home config mode changed for ${name}`, { entry: name });
    }
    field(hash, "regular");
    field(hash, value.bytes);
    field(metadataHash, "regular");
    field(metadataHash, value.mode);
    field(metadataHash, value.bytes.length);
    files[name] = {
      digest: crypto.createHash("sha256").update(value.bytes).digest("hex"),
      mode: value.mode,
      size: value.bytes.length,
      ...(name === "auth.json" ? { credentialMetadata: credentialMetadata(parsed) } : {})
    };
  }
  return {
    schemaVersion: 1,
    algorithm,
    contentDigest: hash.digest("hex"),
    metadataAlgorithm,
    metadataDigest: metadataHash.digest("hex"),
    requiredFileMode: requiredFileMode ?? null,
    files,
    configFiles: [...BENCHMARK_PI_HOME_CONFIG_FILES],
    ephemeralPolicy: { ...BENCHMARK_PI_HOME_EPHEMERAL_ENTRIES }
  };
}

function redactConfigValue(value, key = "") {
  if (/(?:api.?key|token|secret|password|authorization|credential|cookie|headers?)/i.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redactConfigValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((name) => [name, redactConfigValue(value[name], name)]));
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.username || url.password) { url.username = "<redacted>"; url.password = "<redacted>"; return url.toString(); }
    } catch { /* Not a URL. */ }
  }
  return value;
}

export function benchmarkPiHomePublicIdentity(root, credentialMetadata = []) {
  const behavior = {};
  for (const name of ["models.json", "settings.json"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) { behavior[name] = null; continue; }
    const { bytes } = stableRegularFile(file, name);
    behavior[name] = redactConfigValue(JSON.parse(bytes.toString("utf8")));
  }
  return {
    schemaVersion: 1,
    algorithm: "sha256-redacted-behavioral-pi-config-v1",
    behavioralDigest: crypto.createHash("sha256").update(JSON.stringify(behavior)).digest("hex"),
    credentialMetadata,
    credentialContentBinding: "private-runtime-only"
  };
}

export function assertBenchmarkPiCredentialReady(credentialMetadata, requestedModel) {
  const providerId = typeof requestedModel === "string" ? requestedModel.split("/", 1)[0] : undefined;
  if (!providerId) return;
  const credential = credentialMetadata?.find((entry) => entry.providerId === providerId);
  if (!credential && providerId === "openai-codex") fail(`Controlled Pi home has no stored credential for requested provider ${providerId}`);
  if (credential?.readiness === "unusable") fail(`Controlled Pi home has an unusable stored credential for requested provider ${providerId}`);
}

export function assertBenchmarkPiHomeConfigIdentity(expected, observed) {
  const valid = (value) => value?.schemaVersion === 1
    && value.algorithm === algorithm
    && /^[a-f0-9]{64}$/.test(String(value.contentDigest ?? ""))
    && value.metadataAlgorithm === metadataAlgorithm
    && /^[a-f0-9]{64}$/.test(String(value.metadataDigest ?? ""))
    && JSON.stringify(value.configFiles) === JSON.stringify(BENCHMARK_PI_HOME_CONFIG_FILES)
    && JSON.stringify(value.ephemeralPolicy) === JSON.stringify(BENCHMARK_PI_HOME_EPHEMERAL_ENTRIES);
  if (!valid(expected) || !valid(observed)) piHomeMismatch("identity-invalid", "Controlled Pi home config identity is missing or unsupported");
  if (expected.contentDigest !== observed.contentDigest || expected.metadataDigest !== observed.metadataDigest
    || expected.requiredFileMode !== observed.requiredFileMode) piHomeMismatch("bound-config-drift", "Controlled Pi home bound configuration changed");
  return observed;
}

export function assertBenchmarkPiRuntimeMatchesSeed(seed, runtime) {
  if (JSON.stringify(seed?.configFiles) !== JSON.stringify(runtime?.configFiles) || runtime?.requiredFileMode !== "600") {
    piHomeMismatch("runtime-layout", "Controlled Pi runtime home no longer matches its immutable seed");
  }
  for (const name of ["models.json", "settings.json"]) {
    const expected = seed?.files?.[name];
    const observed = runtime?.files?.[name];
    if (expected?.digest !== observed?.digest || (expected === null) !== (observed === null)) {
      piHomeMismatch("behavioral-content", "Controlled Pi runtime behavioral configuration changed", { entry: name });
    }
  }
  if ((seed?.files?.["auth.json"] === null) !== (runtime?.files?.["auth.json"] === null)) {
    piHomeMismatch("credential-presence", "Controlled Pi runtime credential presence changed", { entry: "auth.json" });
  }
  const expectedCredentials = seed?.files?.["auth.json"]?.credentialMetadata ?? [];
  const observedCredentials = runtime?.files?.["auth.json"]?.credentialMetadata ?? [];
  const lineage = (entries) => entries.map(({ providerId, type, principalId }) => ({ providerId, type, principalId }));
  if (JSON.stringify(lineage(expectedCredentials)) !== JSON.stringify(lineage(observedCredentials))) {
    piHomeMismatch("credential-lineage", "Controlled Pi runtime credential provider, type, or account changed", { entry: "auth.json" });
  }
  for (const [index, expected] of expectedCredentials.entries()) {
    const observed = observedCredentials[index];
    if (expected.credentialDigest !== observed.credentialDigest && (expected.type !== "oauth" || !expected.principalId)) {
      piHomeMismatch("credential-content", "Controlled Pi runtime changed a non-rotating credential", { entry: "auth.json" });
    }
  }
  return runtime;
}

function samePrivateCredentialIdentity(left, right) {
  return left?.schemaVersion === 1 && right?.schemaVersion === 1 && left.contentDigest === right.contentDigest;
}

function selectedCredential(piAgentHome, identity = piAgentHome?.operatorAuth?.identity) {
  return identity?.entries?.find((entry) => entry.providerId === piAgentHome?.requestedProvider);
}

export function assertBenchmarkPiCredentialWritebackPolicy(piAgentHome) {
  const oauth = selectedCredential(piAgentHome);
  if (!oauth || oauth.type !== "oauth") return;
  if (piAgentHome.writebackAuthorized !== true) {
    fail("Requested Pi provider uses rotating OAuth credentials; rerun only after explicit --allow-pi-auth-writeback consent");
  }
  if (!oauth.principalId) fail("Requested Pi OAuth credential has no stable account identity for safe refresh writeback");
  if (!piAgentHome.operatorAuth?.path || !piAgentHome.operatorAuth?.identity) {
    fail("Requested Pi OAuth credential has no private operator source for safe refresh writeback");
  }
}

function assertCredentialTransition(expected, observed, requestedProvider) {
  if (expected?.schemaVersion !== 1 || observed?.schemaVersion !== 1) fail("Pi credential writeback identity is unsupported");
  const before = new Map(expected.entries.map((entry) => [entry.providerId, entry]));
  const after = new Map(observed.entries.map((entry) => [entry.providerId, entry]));
  if (before.size !== after.size || [...before.keys()].some((providerId) => !after.has(providerId))) {
    fail("Pi credential refresh changed the provider set");
  }
  for (const [providerId, prior] of before) {
    const next = after.get(providerId);
    if (prior.type !== next.type || prior.principalId !== next.principalId) fail("Pi credential refresh changed provider, type, or account identity");
    if (prior.credentialDigest === next.credentialDigest) continue;
    if (providerId !== requestedProvider || prior.type !== "oauth" || !prior.principalId) {
      fail("Pi credential refresh changed an unauthorized credential entry");
    }
  }
}

function atomicPrivateCredentialWrite(file, bytes) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.auth.json.benchmark-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}

function credentialRecoveryClaim(lock) {
  const file = `${lock}.benchmark-recovery`;
  let descriptor;
  for (let attempt = 0; attempt < 3 && descriptor === undefined; attempt += 1) {
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, hostname: os.hostname(), pid: process.pid })}\n`);
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
      descriptor = undefined;
      if (error?.code !== "EEXIST") throw error;
      let owner;
      let acquired;
      try {
        const current = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try { acquired = fs.fstatSync(current); owner = JSON.parse(fs.readFileSync(current, "utf8")); }
        finally { fs.closeSync(current); }
      } catch { fail("Pi credential lock recovery claim is malformed"); }
      if (owner?.schemaVersion !== 1 || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1 || processIsAlive(owner.pid)) {
        fail("Pi credential lock recovery is owned by another process");
      }
      const observed = fs.lstatSync(file);
      if (observed.dev !== acquired.dev || observed.ino !== acquired.ino) fail("Pi credential recovery claim changed during inspection");
      const stale = `${file}.stale-${crypto.randomBytes(6).toString("hex")}`;
      fs.renameSync(file, stale);
      const moved = fs.lstatSync(stale);
      if (moved.dev !== acquired.dev || moved.ino !== acquired.ino) fail("Pi credential recovery claim replacement race detected");
      fs.rmSync(stale, { force: true });
    }
  }
  if (descriptor === undefined) fail("Cannot acquire Pi credential lock recovery claim");
  const acquired = fs.fstatSync(descriptor);
  return {
    assertOwned() {
      const observed = fs.lstatSync(file);
      if (observed.dev !== acquired.dev || observed.ino !== acquired.ino) fail("Pi credential lock recovery claim changed while held");
    },
    release() {
      try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
      try {
        const observed = fs.lstatSync(file);
        if (observed.dev === acquired.dev && observed.ino === acquired.ino) fs.unlinkSync(file);
      } catch { /* Preserve a replaced claim. */ }
    }
  };
}

function acquireCredentialLock(lock) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, "benchmark-owner.json"), `${JSON.stringify({ schemaVersion: 1, hostname: os.hostname(), pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
      return fs.lstatSync(lock, { bigint: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const recovery = credentialRecoveryClaim(lock);
      try {
        const acquired = fs.lstatSync(lock);
        if (acquired.isSymbolicLink() || !acquired.isDirectory()) fail("Pi operator credential lock has unsupported type");
        let owner;
        try { owner = JSON.parse(fs.readFileSync(path.join(lock, "benchmark-owner.json"), "utf8")); }
        catch { fail("Pi operator credential lock has no recoverable local owner"); }
        if (owner?.schemaVersion !== 1 || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1 || processIsAlive(owner.pid)) {
          fail("Pi operator credential is locked by another process");
        }
        recovery.assertOwned();
        const observed = fs.lstatSync(lock);
        if (observed.dev !== acquired.dev || observed.ino !== acquired.ino) fail("Pi operator credential lock changed during stale-owner recovery");
        const stale = `${lock}.stale-${crypto.randomBytes(6).toString("hex")}`;
        fs.renameSync(lock, stale);
        recovery.assertOwned();
        fs.rmSync(stale, { recursive: true, force: true });
      } finally { recovery.release(); }
    }
  }
  fail("Cannot acquire the Pi-compatible credential writeback lock");
}

export function acquireBenchmarkPiCredentialWriteback(piAgentHome) {
  const credential = selectedCredential(piAgentHome);
  if (!credential || credential.type !== "oauth") return null;
  assertBenchmarkPiCredentialWritebackPolicy(piAgentHome);
  const source = piAgentHome.operatorAuth.path;
  const lock = `${source}.lock`;
  let lockStat;
  try { lockStat = acquireCredentialLock(lock); }
  catch (error) { if (error?.exitCode) throw error; fail("Cannot acquire the Pi-compatible credential writeback lock"); }
  const heartbeat = setInterval(() => {
    try { fs.utimesSync(lock, new Date(), new Date()); } catch { /* Release will fail closed if ownership changed. */ }
  }, 2_000);
  heartbeat.unref();
  let expected = piAgentHome.operatorAuth.identity;
  try {
    const current = benchmarkPiCredentialFileIdentity(source);
    if (!samePrivateCredentialIdentity(expected, current)) fail("Pi operator credential changed after the immutable benchmark seed was captured");
  } catch (error) {
    clearInterval(heartbeat);
    fs.rmSync(lock, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  const bridge = {
    commit(runtimeHome) {
      const runtimeFile = path.join(runtimeHome.path, "auth.json");
      const runtime = benchmarkPiCredentialFileIdentity(runtimeFile);
      const current = benchmarkPiCredentialFileIdentity(source);
      if (samePrivateCredentialIdentity(current, runtime)) { expected = current; piAgentHome.operatorAuth.identity = current; return false; }
      if (!samePrivateCredentialIdentity(expected, current)) fail("Pi operator credential changed while the benchmark held its writeback lock");
      assertCredentialTransition(expected, runtime, piAgentHome.requestedProvider);
      const bytes = stableRegularFile(runtimeFile, "runtime auth.json").bytes;
      atomicPrivateCredentialWrite(source, bytes);
      const committed = benchmarkPiCredentialFileIdentity(source);
      if (!samePrivateCredentialIdentity(runtime, committed)) fail("Pi credential refresh writeback did not commit atomically");
      expected = committed;
      piAgentHome.operatorAuth.identity = committed;
      return true;
    },
    release() {
      if (released) return;
      released = true;
      process.off("exit", bridge.release);
      clearInterval(heartbeat);
      const observed = fs.lstatSync(lock, { bigint: true });
      if (observed.dev !== lockStat.dev || observed.ino !== lockStat.ino || !observed.isDirectory()) {
        fail("Pi credential writeback lock ownership changed");
      }
      fs.rmSync(lock, { recursive: true });
    }
  };
  process.once("exit", bridge.release);
  return bridge;
}

export function recoverBenchmarkPiCredentialWriteback(piAgentHome) {
  if (!piAgentHome?.runtimeParent || !fs.existsSync(piAgentHome.runtimeParent)) return;
  const vault = persistentVaultPath(piAgentHome);
  const homes = [
    ...(vault && fs.existsSync(vault) ? [vault] : []),
    ...fs.readdirSync(piAgentHome.runtimeParent).filter((name) => name.startsWith("attempt-")).map((name) => path.join(piAgentHome.runtimeParent, name))
  ];
  if (homes.length > 1) fail("Multiple private Pi runtime credential vaults require operator recovery");
  if (homes.length === 0) return;
  const runtimeHome = { path: homes[0] };
  if (!piAgentHome.operatorAuth?.path) return;
  const runtimeIdentity = benchmarkPiCredentialFileIdentity(path.join(runtimeHome.path, "auth.json"));
  const sourceIdentity = benchmarkPiCredentialFileIdentity(piAgentHome.operatorAuth.path);
  if (samePrivateCredentialIdentity(runtimeIdentity, sourceIdentity)) {
    assertCredentialTransition(piAgentHome.operatorAuth.identity, sourceIdentity, piAgentHome.requestedProvider);
    piAgentHome.operatorAuth.identity = sourceIdentity;
    if (fs.existsSync(`${piAgentHome.operatorAuth.path}.lock`)) {
      const staleBridge = acquireBenchmarkPiCredentialWriteback(piAgentHome);
      staleBridge?.release();
    }
    return;
  }
  const bridge = acquireBenchmarkPiCredentialWriteback(piAgentHome);
  try { bridge?.commit(runtimeHome); }
  finally { bridge?.release(); }
}

export async function withBenchmarkPiCredentialWriteback(piAgentHome, runtimeHome, operation) {
  let bridge;
  try { bridge = acquireBenchmarkPiCredentialWriteback(piAgentHome); }
  catch (cause) {
    const error = new Error("Private Pi OAuth credential reconciliation failed safely");
    error.code = "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED";
    error.exitCode = 1;
    error.cause = cause;
    throw error;
  }
  let result;
  let operationError;
  try { result = await operation(); }
  catch (error) { operationError = error; }
  try { bridge?.commit(runtimeHome); }
  catch (cause) {
    const error = new Error("Private Pi OAuth credential reconciliation failed safely");
    error.code = "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED";
    error.exitCode = 1;
    error.cause = cause;
    operationError = error;
  }
  try { bridge?.release(); }
  catch (cause) {
    const error = new Error("Private Pi OAuth credential lock release failed safely");
    error.code = "BENCHMARK_PI_CREDENTIAL_RECONCILIATION_FAILED";
    error.exitCode = 1;
    error.cause = cause;
    operationError = error;
  }
  if (operationError) throw operationError;
  return result;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function persistentVaultPath(piAgentHome) {
  if (!piAgentHome?.vaultRoot || !/^[a-f0-9]{32}$/.test(String(piAgentHome?.vaultId ?? ""))) return null;
  const parent = path.resolve(piAgentHome.vaultRoot);
  const target = path.join(parent, piAgentHome.vaultId);
  if (!inside(parent, target)) fail("Controlled Pi credential vault identity is invalid");
  return target;
}

export function createBenchmarkPiRuntimeHome(piAgentHome) {
  const seed = benchmarkPiHomeConfigIdentity(piAgentHome.configRoot, { requiredFileMode: "400" });
  assertBenchmarkPiHomeConfigIdentity(piAgentHome.seedIdentity, seed);
  const vault = persistentVaultPath(piAgentHome);
  let runtimeRoot;
  let created = false;
  if (vault && fs.existsSync(vault)) {
    const stat = fs.lstatSync(vault);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) fail("Persistent Pi credential vault has unsupported ownership metadata");
    const identity = benchmarkPiHomeConfigIdentity(vault, { requiredFileMode: "600" });
    assertBenchmarkPiRuntimeMatchesSeed(seed, identity);
    if (seed.files?.["auth.json"]?.digest !== identity.files?.["auth.json"]?.digest) fail("Persistent Pi credential vault and operator credential lineage diverged");
    return { path: vault, identity, persistent: true };
  }
  if (vault) {
    fs.mkdirSync(path.dirname(vault), { recursive: true, mode: 0o700 });
    const parentStat = fs.lstatSync(path.dirname(vault));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("Persistent Pi credential vault parent has unsupported type");
    fs.chmodSync(path.dirname(vault), 0o700);
    fs.mkdirSync(vault, { mode: 0o700 });
    runtimeRoot = vault;
  } else {
    const runtimeParent = fs.realpathSync(piAgentHome.runtimeParent);
    runtimeRoot = fs.mkdtempSync(path.join(runtimeParent, "attempt-"));
  }
  created = true;
  try {
    fs.chmodSync(runtimeRoot, 0o700);
    for (const name of BENCHMARK_PI_HOME_CONFIG_FILES) {
      const source = path.join(piAgentHome.configRoot, name);
      try {
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink() || !stat.isFile()) fail(`Controlled Pi home seed path has unsupported type: ${name}`);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      copyBenchmarkPiConfigFile(source, path.join(runtimeRoot, name), 0o600);
    }
    const identity = benchmarkPiHomeConfigIdentity(runtimeRoot, { requiredFileMode: "600" });
    if (seed.contentDigest !== identity.contentDigest) fail("Controlled Pi runtime home did not start from its immutable seed");
    assertBenchmarkPiRuntimeMatchesSeed(seed, identity);
    return { path: runtimeRoot, identity, persistent: Boolean(vault) };
  } catch (error) {
    if (created) fs.rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

export function resetBenchmarkPiRuntimeEphemeralState(runtimeHome) {
  for (const name of Object.keys(BENCHMARK_PI_HOME_EPHEMERAL_ENTRIES)) {
    fs.rmSync(path.join(runtimeHome.path, name), { recursive: true, force: true });
  }
}

export function assertBenchmarkPiRuntimeParentEmpty(piAgentHome) {
  const runtimeParent = fs.realpathSync(piAgentHome.runtimeParent);
  if (fs.readdirSync(runtimeParent).length !== 0) fail("Controlled Pi runtime homes were not fully cleaned");
}

export function cleanupBenchmarkPiRuntimeHome(piAgentHome, runtimeHome) {
  if (!runtimeHome?.path || !fs.existsSync(runtimeHome.path)) return;
  const runtimeParent = fs.realpathSync(piAgentHome.runtimeParent);
  const runtimeRoot = fs.realpathSync(runtimeHome.path);
  const vault = persistentVaultPath(piAgentHome);
  const ownedTemporary = inside(runtimeParent, runtimeRoot) && path.basename(runtimeRoot).startsWith("attempt-");
  const ownedVault = vault && runtimeRoot === fs.realpathSync(vault);
  if (!ownedTemporary && !ownedVault) {
    fail("Refusing to clean an unowned Pi benchmark runtime home");
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

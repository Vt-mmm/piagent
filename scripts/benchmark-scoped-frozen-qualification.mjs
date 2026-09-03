import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";

import {
  validBenchmarkCandidateProvenance,
  verifyMaterializedBenchmarkCandidate
} from "../packages/piagent-core/benchmark/benchmark-candidate.js";

export const SCOPED_BROKER_FROZEN_IDENTITY_VERSION = 4;
export const SCOPED_BROKER_MEASUREMENT_BINDING_VERSION = "benchmark-turn-binding-v1";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const OPERATOR_REQUEST = /^operator-request-v1:[a-f0-9]{64}$/;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function fail(code) {
  throw Object.assign(new Error(code), { brokerCode: code });
}
function requireThat(value, code) { if (!value) fail(code); }

function realDirectory(value, code) {
  requireThat(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && !value.includes("\0"), code);
  let real, info;
  try { real = fs.realpathSync(value); info = fs.statSync(real); }
  catch { fail(code); }
  requireThat(real === value && info.isDirectory(), code);
  return real;
}

function stablePrivateIndex(file, expectedSha256) {
  requireThat(typeof file === "string" && path.isAbsolute(file) && path.normalize(file) === file
    && !file.includes("\0") && HASH.test(expectedSha256), "frozen-index-binding");
  const parent = realDirectory(path.dirname(file), "frozen-index-parent");
  requireThat(parent === path.dirname(file), "frozen-index-parent");
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); } catch { fail("frozen-index-file"); }
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size > 0n && before.size <= 16n * 1024n * 1024n && (before.mode & 0o077n) === 0n,
  "frozen-index-file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    requireThat(bytes.length === Number(before.size) && fields.every(key => before[key] === descriptor[key]
      && before[key] === after[key] && before[key] === current[key]) && hash(bytes) === expectedSha256,
    "frozen-index-drift");
    let index;
    try { index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { fail("frozen-index-json"); }
    return index;
  } finally { fs.closeSync(fd); }
}

/** Same full-tree algorithm as scoped qualification v3. Links are bound as
 * link text and never followed. */
export function scopedFrozenTreeIdentity(value) {
  const root = realDirectory(value, "frozen-tree-root"), entries = [];
  let files = 0, bytes = 0;
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, file = path.join(directory, entry.name);
      requireThat(entries.length < 100000, "frozen-tree-entry-limit");
      if (entry.isDirectory()) { entries.push(["d", relative]); walk(file, relative); continue; }
      if (entry.isSymbolicLink()) { entries.push(["l", relative, fs.readlinkSync(file)]); continue; }
      requireThat(entry.isFile(), "frozen-tree-node");
      const before = fs.lstatSync(file, { bigint: true }), content = fs.readFileSync(file);
      const after = fs.lstatSync(file, { bigint: true });
      requireThat(before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "frozen-tree-drift");
      bytes += content.length; files++;
      requireThat(bytes <= 1024 * 1024 * 1024, "frozen-tree-byte-limit");
      entries.push(["f", relative, content.length, hash(content)]);
    }
  }
  walk(root, "");
  return Object.freeze({ version: 2, files, bytes,
    sha256: hash(JSON.stringify({ version: 2, entries })) });
}

/** Recomputes the immutable bootstrap snapshot, separately frozen WebUI assets,
 * SDK tree and caller-supplied recomputed common closure. */
export function scopedFrozenQualificationIdentity(value, brokerClosureSha256) {
  const names = ["version", "candidateRoot", "assetsRoot", "sdkRoot", "candidateIndexPath",
    "candidateIndexSha256"];
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
    && value.version === SCOPED_BROKER_FROZEN_IDENTITY_VERSION && HASH.test(brokerClosureSha256),
  "frozen-qualification-fields");
  const candidateRoot = realDirectory(value.candidateRoot, "frozen-candidate-root"),
    assetsRoot = realDirectory(value.assetsRoot, "frozen-assets-root"),
    sdkRoot = realDirectory(value.sdkRoot, "frozen-sdk-root");
  requireThat(!assetsRoot.startsWith(candidateRoot + path.sep) && assetsRoot !== candidateRoot,
    "frozen-assets-separation");
  const index = stablePrivateIndex(value.candidateIndexPath, value.candidateIndexSha256);
  let source;
  try { source = verifyMaterializedBenchmarkCandidate(candidateRoot, index); }
  catch { fail("frozen-candidate-mismatch"); }
  requireThat(validBenchmarkCandidateProvenance(source), "frozen-candidate-identity");
  const assets = scopedFrozenTreeIdentity(assetsRoot), sdk = scopedFrozenTreeIdentity(sdkRoot);
  return Object.freeze({ version: SCOPED_BROKER_FROZEN_IDENTITY_VERSION, candidateRoot, assetsRoot,
    sdkRoot, candidateIndexPath: value.candidateIndexPath, candidateIndexSha256: value.candidateIndexSha256,
    sourceSha256: source.contentDigest, assetTreeSha256: assets.sha256, sdkTreeSha256: sdk.sha256,
    brokerClosureSha256 });
}

export function assertScopedFrozenQualification(value, identity, brokerClosureSha256) {
  const names = ["version", "candidateRoot", "assetsRoot", "sdkRoot", "candidateIndexPath",
    "candidateIndexSha256", "sourceSha256", "assetTreeSha256", "sdkTreeSha256", "brokerClosureSha256"];
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)),
  "manifest-identity-v4");
  const actual = scopedFrozenQualificationIdentity(Object.fromEntries(names.slice(0, 6)
    .map(name => [name, value[name]])), brokerClosureSha256);
  requireThat(Object.keys(actual).every(key => actual[key] === value[key])
    && ["sourceSha256", "assetTreeSha256", "sdkTreeSha256", "brokerClosureSha256"]
      .every(key => identity?.[key] === actual[key]), "manifest-identity-v4");
  return true;
}

const MEASUREMENT_BINDING_FIELDS = Object.freeze(["version", "authority", "runId", "armId", "suiteId",
  "scenarioId", "surface", "repeat", "infrastructureAttempt", "turnIndex", "turnId", "catalogSha256",
  "configurationSha256", "publicContractSha256", "planSha256", "turnBindingSha256", "workspaceSha256",
  "operatorRequestDigest", "profile", "materialManifestSha256", "verificationManifestSha256",
  "contextPolicySha256", "nodeSha256", "runtimeSha256", "modelSha256"]);
const MEASUREMENT_HASH_FIELDS = Object.freeze(MEASUREMENT_BINDING_FIELDS.filter(name => name.endsWith("Sha256")));

/** Data-only predispatch coordinate. It binds bytes through the config digest
 * but cannot grant approval, criterion status, provider dispatch or admission. */
export function validateScopedBrokerMeasurementBinding(value) {
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === MEASUREMENT_BINDING_FIELDS.length
    && MEASUREMENT_BINDING_FIELDS.every(name => Object.hasOwn(value, name))
    && value.version === SCOPED_BROKER_MEASUREMENT_BINDING_VERSION && value.authority === "none"
    && [value.runId, value.armId, value.suiteId, value.scenarioId, value.turnId].every(item =>
      typeof item === "string" && ID.test(item))
    && ["piagent", "codex-cli"].includes(value.surface)
    && Number.isSafeInteger(value.repeat) && value.repeat >= 1 && value.repeat <= 10
    && Number.isSafeInteger(value.infrastructureAttempt) && value.infrastructureAttempt >= 1
    && value.infrastructureAttempt <= 3 && Number.isSafeInteger(value.turnIndex)
    && value.turnIndex >= 1 && value.turnIndex <= 3
    && OPERATOR_REQUEST.test(value.operatorRequestDigest)
    && ["incident", "document", "protected-env-refusal", "destructive-history-refusal"].includes(value.profile)
    && MEASUREMENT_HASH_FIELDS.every(name => HASH.test(value[name])), "measurement-binding-invalid");
  return Object.freeze(Object.fromEntries(MEASUREMENT_BINDING_FIELDS.map(name => [name, value[name]])));
}

export function scopedBrokerMeasurementBindingSha256(value) {
  return hash(JSON.stringify(validateScopedBrokerMeasurementBinding(value)));
}

export const SCOPED_BROKER_IDENTITY_VERSION = 2;
export const SCOPED_BROKER_QUALIFICATION_IDENTITY_VERSION = 3;
export const SCOPED_CONTEXT_POLICY_VERSION = 2;
const validHash = value => typeof value === "string" && HASH.test(value);
const plain = value => Boolean(value && typeof value === "object" && !types.isProxy(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value)));
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const BROKER_CONFIG_BYTES = 64 * 1024;
const BROKER_JOURNAL_BYTES = 32 * 1024 * 1024;
const BROKER_TRANSPORT_BYTES = 1024 * 1024;
const brokerFail = code => { throw Object.assign(new Error(code), { brokerCode: code }); };
const brokerRequire = (value, code) => { if (!value) brokerFail(code); };
const brokerWellFormed = value => typeof value === "string" && value.isWellFormed();
function brokerFields(value, names) {
  brokerRequire(plain(value), "invalid-object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  brokerRequire(Reflect.ownKeys(descriptors).length === names.length && names.every(name =>
    descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], "value")), "invalid-fields");
}
const brokerSchema = properties => ({ type: "object", properties, required: Object.keys(properties),
  additionalProperties: false });

export const SCOPED_TOOL_DEFINITIONS = deepFreeze([
  { name: "scoped_read", inputSchema: brokerSchema({ materialId: { type: "string" } }) },
  { name: "scoped_write_document", inputSchema: brokerSchema({ materialId: { type: "string" },
    expectedSha256: { type: "string" }, utf8: { type: "string" } }) },
  { name: "scoped_verify", inputSchema: brokerSchema({ verificationId: { type: "string" } }) }
]);

export const SCOPED_BROKER_IDENTITY_V2_FIELDS = Object.freeze(["version", "armId", "taskId", "sessionId",
  "requestId", "operationId", "nonce", "sourceSha256", "configSha256", "brokerClosureSha256",
  "toolDefinitionsSha256", "manifestAuthoritySha256", "journalSignerSha256", "journalPathSha256",
  "contextPolicySha256", "sdkTreeSha256"]);
export const SCOPED_BROKER_IDENTITY_V3_FIELDS = Object.freeze(["version", "armId", "taskId", "sessionId",
  "requestId", "operationId", "nonce", "sourceSha256", "assetTreeSha256", "configSha256",
  "brokerClosureSha256", "toolDefinitionsSha256", "manifestAuthoritySha256", "journalSignerSha256",
  "journalPathSha256", "contextPolicySha256", "sdkTreeSha256"]);
export const SCOPED_BROKER_IDENTITY_V4_FIELDS = Object.freeze([
  ...SCOPED_BROKER_IDENTITY_V3_FIELDS.slice(0, 10),
  "measurementConfigurationSha256",
  ...SCOPED_BROKER_IDENTITY_V3_FIELDS.slice(10)
]);

export function scopedToolDefinitionsSha256() {
  return hash(JSON.stringify(SCOPED_TOOL_DEFINITIONS));
}

export function scopedBrokerSourceClosureSha256() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    ["broker", "benchmark-scoped-tool-broker.mjs"],
    ["supervisor", "benchmark-scoped-verification-supervisor.mjs"],
    ["project-verifier", "benchmark-scoped-project-verifier.mjs"],
    ["qualification", "benchmark-scoped-frozen-qualification.mjs"],
    ["transport", "benchmark-scoped-broker-custody.mjs"]
  ].map(([role, name]) => ({ role, sha256: hash(fs.readFileSync(path.join(directory, name))) }));
  return hash(JSON.stringify({ version: 4, files,
    toolDefinitionsSha256: scopedToolDefinitionsSha256() }));
}

export function scopedJournalPathSha256(value) {
  brokerRequire(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && !value.includes("\0"), "journal-path-binding");
  const parent = fs.realpathSync(path.dirname(value));
  brokerRequire(parent === path.dirname(value), "journal-path-binding");
  return hash(JSON.stringify({ version: 2, path: value }));
}

/** Deterministic full-tree pin. Symlinks are bound as links and never followed. */
export function scopedTreeIdentity(value) {
  brokerRequire(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && fs.realpathSync(value) === value && fs.statSync(value).isDirectory(), "tree-root-invalid");
  const entries = []; let files = 0, bytes = 0;
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, file = path.join(directory, entry.name);
      brokerRequire(entries.length < 100000, "tree-entry-limit");
      if (entry.isDirectory()) { entries.push(["d", relative]); walk(file, relative); continue; }
      if (entry.isSymbolicLink()) { entries.push(["l", relative, fs.readlinkSync(file)]); continue; }
      brokerRequire(entry.isFile(), "tree-node-invalid");
      const before = fs.lstatSync(file, { bigint: true }), content = fs.readFileSync(file);
      const after = fs.lstatSync(file, { bigint: true });
      brokerRequire(before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "tree-mutated");
      bytes += content.length; files++; brokerRequire(bytes <= 1024 * 1024 * 1024, "tree-byte-limit");
      entries.push(["f", relative, content.length, hash(content)]);
    }
  }
  walk(value, "");
  return deepFreeze({ version: 2, files, bytes, sha256: hash(JSON.stringify({ version: 2, entries })) });
}

const qualificationRoot = (value, code) => {
  brokerRequire(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && fs.realpathSync(value) === value && fs.statSync(value).isDirectory(), code);
  return value;
};
const git = (root, args) => {
  try { return execFileSync("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }); }
  catch { brokerFail("tracked-source-unavailable"); }
};

/** Recomputes the clean tracked working tree, binding Git mode, index object,
 * path and the bytes actually present on disk. Untracked build assets remain a
 * separate qualification input. */
export function scopedTrackedSourceIdentity(value) {
  const root = qualificationRoot(value, "tracked-source-root-invalid");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let top, head;
  try {
    top = decoder.decode(git(root, ["rev-parse", "--show-toplevel"])).trimEnd();
    head = decoder.decode(git(root, ["rev-parse", "--verify", "HEAD"])).trimEnd();
  } catch { brokerFail("tracked-source-unavailable"); }
  brokerRequire(fs.realpathSync(top) === root && /^[a-f0-9]{40,64}$/.test(head), "tracked-source-root-invalid");
  const clean = () => git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no",
    "--ignore-submodules=none"]);
  brokerRequire(clean().length === 0, "tracked-source-dirty");
  const index = git(root, ["ls-files", "--stage", "-z"]), entries = [];
  let start = 0, bytes = 0;
  for (let cursor = 0; cursor <= index.length; cursor++) {
    if (cursor < index.length && index[cursor] !== 0) continue;
    if (cursor === start) { start = cursor + 1; continue; }
    let row;
    try { row = decoder.decode(index.subarray(start, cursor)); } catch { brokerFail("tracked-source-index-invalid"); }
    start = cursor + 1;
    const tab = row.indexOf("\t"), prefix = row.slice(0, tab), relative = row.slice(tab + 1);
    const match = /^(100644|100755|120000) ([a-f0-9]{40,64}) 0$/.exec(prefix);
    brokerRequire(tab > 0 && match && relative && !path.isAbsolute(relative) && !relative.includes("\\")
      && relative.split("/").every(part => part && part !== "." && part !== "..")
      && entries.length < 100000, "tracked-source-index-invalid");
    const file = path.join(root, ...relative.split("/")), before = fs.lstatSync(file, { bigint: true });
    let content;
    if (match[1] === "120000") {
      brokerRequire(before.isSymbolicLink(), "tracked-source-node-invalid");
      content = Buffer.from(fs.readlinkSync(file));
    } else {
      brokerRequire(before.isFile() && !before.isSymbolicLink(), "tracked-source-node-invalid");
      content = fs.readFileSync(file);
      const after = fs.lstatSync(file, { bigint: true });
      brokerRequire(before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "tracked-source-mutated");
    }
    bytes += content.length; brokerRequire(bytes <= 1024 * 1024 * 1024, "tracked-source-byte-limit");
    entries.push([match[1], match[2], relative, content.length, hash(content)]);
  }
  brokerRequire(clean().length === 0 && decoder.decode(git(root, ["rev-parse", "--verify", "HEAD"])).trimEnd() === head,
    "tracked-source-mutated");
  return deepFreeze({ version: 3, head, files: entries.length, bytes,
    sha256: hash(JSON.stringify({ version: 3, head, entries })) });
}

const COMMON_RUNTIME_SEEDS = Object.freeze(["scripts/benchmark-scoped-tool-broker.mjs",
  "scripts/benchmark-scoped-verification-supervisor.mjs", "scripts/benchmark-arm-observer.mjs",
  "scripts/benchmark-webui-journey.mjs"]);
const LOCAL_IMPORT_PATTERNS = [
  /\bimport\s+(?!\()(?:(?:[^"'`;]|\n)*?\sfrom\s*)?["']([^"']+)["']/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
];
function localImports(source) {
  const result = new Set();
  for (const pattern of LOCAL_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) if (match[1].startsWith(".")) result.add(match[1]);
  }
  const constants = new Map();
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(["'])([^"'\\\r\n]*)\2\s*;/g))
    constants.set(match[1], match[3]);
  for (const match of source.matchAll(/\bimport\s*\(\s*`([^`\\]*(?:\\.[^`\\]*)*)`\s*\)/g)) {
    let complete = true;
    const specifier = match[1].replace(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g, (_token, name) => {
      if (!constants.has(name)) { complete = false; return ""; }
      return constants.get(name);
    });
    if (complete && !specifier.includes("${") && specifier.startsWith(".")) result.add(specifier);
  }
  return [...result];
}
function resolveLocalImport(root, importer, specifier) {
  const requested = path.resolve(path.dirname(importer), specifier), extensions = ["", ".js", ".mjs", ".cjs",
    ".ts", ".tsx", ".json"];
  const stem = /\.(?:[cm]?js)$/.test(requested) ? requested.replace(/\.(?:[cm]?js)$/, "") : requested;
  const candidates = extensions.map(extension => requested + extension)
    .concat(stem === requested ? [] : [stem + ".ts", stem + ".tsx", stem + ".mjs"])
    .concat(extensions.slice(1).map(extension => path.join(requested, `index${extension}`)));
  const file = candidates.find(candidate => { try { return fs.lstatSync(candidate).isFile(); } catch { return false; } });
  brokerRequire(file, "runtime-closure-import-unresolved");
  const info = fs.lstatSync(file);
  brokerRequire(info.isFile() && !info.isSymbolicLink(), "runtime-closure-node-invalid");
  const real = fs.realpathSync(file);
  brokerRequire(real.startsWith(root + path.sep), "runtime-closure-import-outside-root");
  return real;
}

/** Signed source closure for the common broker/supervisor/observer/journey
 * bridge and every statically discoverable local import reachable from it. */
export function scopedCommonRuntimeClosureIdentity(value = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const root = qualificationRoot(fs.realpathSync(value), "runtime-closure-root-invalid"), pending = [];
  for (const relative of COMMON_RUNTIME_SEEDS) {
    const file = fs.realpathSync(path.join(root, relative));
    brokerRequire(file.startsWith(root + path.sep), "runtime-closure-seed-invalid"); pending.push(file);
  }
  const visited = new Set(), rows = []; let bytes = 0;
  while (pending.length) {
    const file = pending.pop(); if (visited.has(file)) continue; visited.add(file);
    brokerRequire(visited.size <= 4096, "runtime-closure-file-limit");
    const before = fs.lstatSync(file, { bigint: true }), content = fs.readFileSync(file), after = fs.lstatSync(file, { bigint: true });
    brokerRequire(before.isFile() && !before.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs,
    "runtime-closure-mutated");
    bytes += content.length; brokerRequire(bytes <= 256 * 1024 * 1024, "runtime-closure-byte-limit");
    const relative = path.relative(root, file).split(path.sep).join("/");
    rows.push({ path: relative, bytes: content.length, sha256: hash(content) });
    if (!/\.json$/i.test(file)) for (const specifier of localImports(content.toString("utf8")))
      pending.push(resolveLocalImport(root, file, specifier));
  }
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return deepFreeze({ version: 3, files: rows.length, bytes,
    sha256: hash(JSON.stringify({ version: 3, seeds: COMMON_RUNTIME_SEEDS, files: rows })), entries: rows });
}

export function scopedQualificationIdentity(value) {
  brokerFields(value, ["candidateRoot", "assetsRoot", "sdkRoot"]);
  const candidateRoot = qualificationRoot(value.candidateRoot, "qualification-candidate-root-invalid");
  const assetsRoot = qualificationRoot(value.assetsRoot, "qualification-assets-root-invalid");
  const sdkRoot = qualificationRoot(value.sdkRoot, "qualification-sdk-root-invalid");
  const expectedAssets = fs.realpathSync(path.join(candidateRoot, "packages/piagent-webui/dist/client"));
  brokerRequire(assetsRoot === expectedAssets, "qualification-assets-binding");
  const source = scopedTrackedSourceIdentity(candidateRoot), assets = scopedTreeIdentity(assetsRoot);
  const sdk = scopedTreeIdentity(sdkRoot), closure = scopedCommonRuntimeClosureIdentity();
  return deepFreeze({ version: 3, candidateRoot, assetsRoot, sdkRoot, sourceSha256: source.sha256,
    assetTreeSha256: assets.sha256, sdkTreeSha256: sdk.sha256, brokerClosureSha256: closure.sha256 });
}

function strictJsonCopy(value, code, state = { nodes: 0 }) {
  brokerRequire(++state.nodes <= 100000, code);
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  brokerRequire(value && typeof value === "object" && !types.isProxy(value), code);
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  brokerRequire(array || prototype === Object.prototype || prototype === null, code);
  const descriptors = Object.getOwnPropertyDescriptors(value), result = array ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    brokerRequire(typeof key === "string" && descriptor.enumerable && Object.hasOwn(descriptor, "value")
      && (!array || /^(0|[1-9][0-9]*)$/.test(key)), code);
    Object.defineProperty(result, key, { value: strictJsonCopy(descriptor.value, code, state), enumerable: true,
      writable: true, configurable: true });
  }
  brokerRequire(!array || result.length === value.length && Object.keys(result).length === value.length, code);
  return result;
}

function observableJsonCopy(value, code, state = { nodes: 0 }) {
  brokerRequire(++state.nodes <= 100000, code);
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (["function", "symbol", "bigint"].includes(typeof value)) return `[non-json:${typeof value}]`;
  brokerRequire(value && typeof value === "object" && !types.isProxy(value), code);
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  brokerRequire(array || prototype === Object.prototype || prototype === null, code);
  const descriptors = Object.getOwnPropertyDescriptors(value), result = array ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    brokerRequire(typeof key === "string" && descriptor.enumerable && Object.hasOwn(descriptor, "value")
      && (!array || /^(0|[1-9][0-9]*)$/.test(key)), code);
    Object.defineProperty(result, key, { value: observableJsonCopy(descriptor.value, code, state), enumerable: true });
  }
  brokerRequire(!array || result.length === value.length && Object.keys(result).length === value.length, code);
  return result;
}

function scopedContextPolicy(policy) {
  brokerFields(policy, ["version", "systemPrompt", "allowedUserMessages", "removableUserMessages"]);
  brokerRequire(policy.version === SCOPED_CONTEXT_POLICY_VERSION && typeof policy.systemPrompt === "string"
    && policy.systemPrompt.length > 0 && Buffer.byteLength(policy.systemPrompt) <= 4096
    && Array.isArray(policy.allowedUserMessages) && policy.allowedUserMessages.length > 0
    && policy.allowedUserMessages.length <= 32 && Array.isArray(policy.removableUserMessages)
    && policy.removableUserMessages.length <= 32, "context-policy-invalid");
  const all = [...policy.allowedUserMessages, ...policy.removableUserMessages];
  brokerRequire(all.every(item => typeof item === "string" && item.length > 0 && item.isWellFormed()
    && Buffer.byteLength(item) <= BROKER_CONFIG_BYTES) && new Set(all).size === all.length, "context-policy-invalid");
  return strictJsonCopy(policy, "context-policy-invalid");
}

export function scopedContextPolicySha256(policy) {
  return hash(JSON.stringify(scopedContextPolicy(policy)));
}

const contextToolNames = SCOPED_TOOL_DEFINITIONS.map(item => item.name);
function contextText(message, code) {
  brokerRequire(Array.isArray(message.content) && message.content.length === 1, code);
  brokerFields(message.content[0], ["type", "text"]);
  brokerRequire(message.content[0].type === "text" && typeof message.content[0].text === "string", code);
  return message.content[0].text;
}
function scopedWireTools(tools, code, exactWire = false) {
  brokerRequire(Array.isArray(tools) && tools.length === SCOPED_TOOL_DEFINITIONS.length, code);
  return tools.map((tool, index) => {
    brokerRequire(plain(tool), code);
    if (exactWire) brokerFields(tool, ["name", "label", "description", "parameters"]);
    const definition = SCOPED_TOOL_DEFINITIONS[index], descriptor = Object.getOwnPropertyDescriptors(tool);
    for (const name of ["name", "label", "description", "parameters"])
      brokerRequire(descriptor[name]?.enumerable && Object.hasOwn(descriptor[name], "value"), code);
    const parameters = strictJsonCopy(descriptor.parameters.value, code);
    brokerRequire(descriptor.name.value === definition.name && descriptor.label.value === definition.name
      && descriptor.description.value === `Bounded broker operation ${definition.name}.`
      && JSON.stringify(parameters) === JSON.stringify(definition.inputSchema), code);
    return { name: definition.name, label: definition.name,
      description: `Bounded broker operation ${definition.name}.`, parameters };
  });
}

/** Projects the Pi context to the signed G0 allowlist before any endpoint call. */
export function sanitizeScopedProviderContext(context, policy) {
  policy = scopedContextPolicy(policy); brokerFields(context, ["systemPrompt", "messages", "tools"]);
  brokerRequire(Array.isArray(context.messages) && context.messages.length <= 256, "context-message-invalid");
  const allowed = new Set(policy.allowedUserMessages), removable = new Set(policy.removableUserMessages);
  const seen = new Set(), messages = [];
  for (const message of context.messages) {
    brokerRequire(plain(message), "context-message-invalid");
    if (message.role === "user") {
      brokerFields(message, ["role", "content", "timestamp"]);
      const text = contextText(message, "context-user-invalid");
      if (removable.has(text)) continue;
      brokerRequire(allowed.has(text) && !seen.has(text), `context-user-not-allowlisted:${hash(text)}`); seen.add(text);
      messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 0 }); continue;
    }
    if (message.role === "assistant") {
      brokerFields(message, ["role", "content", "api", "provider", "model", "stopReason", "timestamp", "usage"]);
      const copy = strictJsonCopy(message, "context-assistant-invalid");
      brokerRequire(copy.content.every(part => part?.type === "text" && typeof part.text === "string"
        || part?.type === "toolCall" && typeof part.id === "string" && contextToolNames.includes(part.name)
          && plain(part.arguments)), "context-assistant-invalid");
      copy.timestamp = 0; messages.push(copy); continue;
    }
    if (message.role === "toolResult") {
      try { brokerFields(message, ["role", "toolCallId", "toolName", "content", "details", "usage", "isError", "timestamp"]); }
      catch { brokerFail(`context-tool-result-fields:${Object.keys(message).sort().join(",")}`); }
      const copy = strictJsonCopy(message, "context-tool-result-invalid");
      brokerRequire(typeof copy.toolCallId === "string", "context-tool-result-call-id");
      brokerRequire(contextToolNames.includes(copy.toolName), `context-tool-result-name:${String(copy.toolName)}`);
      brokerRequire(typeof copy.isError === "boolean", "context-tool-result-error-flag");
      brokerRequire(Array.isArray(copy.content) && copy.content.every(part => part?.type === "text"
        && typeof part.text === "string"), "context-tool-result-content");
      copy.timestamp = 0; messages.push(copy); continue;
    }
    brokerFail("context-role-not-allowlisted");
  }
  brokerRequire(policy.allowedUserMessages.every(item => seen.has(item)), "context-user-missing");
  const result = { systemPrompt: policy.systemPrompt, messages, tools: scopedWireTools(context.tools, "context-tools-invalid") };
  brokerRequire(Buffer.byteLength(JSON.stringify(result)) <= 4 * 1024 * 1024, "context-byte-limit");
  return deepFreeze(result);
}

export function validateScopedProviderPayload(payload, modelId, context) {
  brokerFields(payload, ["model", "messages", "tools"]);
  brokerRequire(typeof modelId === "string" && payload.model === modelId
    && JSON.stringify(strictJsonCopy(payload.messages, "final-payload-invalid")) === JSON.stringify(context.messages)
    && JSON.stringify(scopedWireTools(payload.tools, "final-payload-invalid", true)) === JSON.stringify(context.tools),
  "final-payload-invalid");
  return deepFreeze(strictJsonCopy(payload, "final-payload-invalid"));
}

const qualifiedLoopbackTransports = new WeakMap();
const LOOPBACK_RESPONSE_BYTES = 64 * 1024;
export function createQualifiedLoopbackTransport(value) {
  brokerFields(value, ["origin"]);
  let url;
  try { url = new URL(value.origin); } catch { brokerFail("loopback-origin-invalid"); }
  brokerRequire(url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname)
    && Number.isSafeInteger(Number(url.port)) && Number(url.port) > 0 && Number(url.port) <= 65535
    && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "loopback-origin-invalid");
  const state = { url: url.href, bound: false, validatedRequests: 0, callbackCount: 0,
    evidenceRecords: 0, networkWrites: 0, responses: 0, failures: 0, lastRequestSha256: null, lastFailure: null };
  const capability = Object.freeze({ status: () => Object.freeze({ version: 1, bound: state.bound,
    validatedRequests: state.validatedRequests, callbackCount: state.callbackCount,
    evidenceRecords: state.evidenceRecords, networkWrites: state.networkWrites, responses: state.responses,
    failures: state.failures, lastRequestSha256: state.lastRequestSha256, lastFailure: state.lastFailure,
    externalProviderCalls: 0 }) });
  qualifiedLoopbackTransports.set(capability, state); return capability;
}
async function loopbackResponseBytes(response) {
  brokerRequire(response?.status === 200 && /^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    && response.body?.getReader, "loopback-response-invalid");
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  for (;;) {
    const item = await reader.read(); if (item.done) break;
    brokerRequire(item.value instanceof Uint8Array, "loopback-response-invalid");
    bytes += item.value.length;
    if (bytes > LOOPBACK_RESPONSE_BYTES) { await reader.cancel(); brokerFail("loopback-response-limit"); }
    chunks.push(Buffer.from(item.value));
  }
  return Buffer.concat(chunks, bytes);
}
const qualifiedLoopbackUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function qualifiedLoopbackMessage(value, model, sequence) {
  brokerRequire(plain(value), "loopback-response-invalid");
  const tool = value.kind === "tool";
  brokerFields(value, tool ? ["kind", "name", "arguments"] : ["kind", "text"]);
  if (tool) {
    brokerRequire(SCOPED_TOOL_DEFINITIONS.some(item => item.name === value.name), "loopback-response-tool");
    strictJsonCopy(value.arguments, "loopback-response-invalid");
  } else brokerRequire(value.kind === "text" && typeof value.text === "string" && value.text.isWellFormed()
    && Buffer.byteLength(value.text) <= LOOPBACK_RESPONSE_BYTES, "loopback-response-invalid");
  return { role: "assistant", content: tool
    ? [{ type: "toolCall", id: `call_${sequence}`, name: value.name, arguments: value.arguments }]
    : [{ type: "text", text: value.text }], api: model.api, provider: model.provider, model: model.id,
    stopReason: tool ? "toolUse" : "stop", timestamp: 0, usage: qualifiedLoopbackUsage() };
}

/** Replaces the caller's stream function with a host-owned, capability-branded
 * transport. The SDK callback and exact wire bytes are validated before any
 * evidence record or network write can occur. */
export async function createQualifiedLoopbackModelRuntime({ modelRuntime, transport, record, identity,
  contextPolicy } = {}) {
  const state = qualifiedLoopbackTransports.get(transport);
  brokerRequire(state && !state.bound && modelRuntime && typeof modelRuntime === "object"
    && typeof record === "function" && identity && [identity.candidateDigest, identity.assetTreeSha256,
      identity.brokerClosureSha256, identity.sdkTreeSha256].every(validHash), "loopback-capability-invalid");
  brokerRequire(scopedContextPolicySha256(contextPolicy) === identity.contextPolicySha256,
    "loopback-context-policy-mismatch");
  const eventStreamFile = fs.realpathSync(path.join(identity.sdkRoot,
    "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"));
  brokerRequire(eventStreamFile.startsWith(identity.sdkRoot + path.sep), "loopback-sdk-module-invalid");
  const { AssistantMessageEventStream } = await import(pathToFileURL(eventStreamFile).href);
  brokerRequire(typeof AssistantMessageEventStream === "function", "loopback-sdk-module-invalid");
  state.bound = true;
  const binding = Object.freeze({ armId: identity.armId, sourceSha256: identity.candidateDigest,
    assetTreeSha256: identity.assetTreeSha256, sdkTreeSha256: identity.sdkTreeSha256,
    brokerClosureSha256: identity.brokerClosureSha256, configSha256: identity.configSha256 });
  const wrapped = Object.create(modelRuntime);
  Object.defineProperty(wrapped, "streamSimple", { enumerable: true, value(model, context, options = {}) {
    const stream = new AssistantMessageEventStream();
    void (async () => {
      try {
        brokerRequire(model && typeof model.id === "string" && typeof model.api === "string"
          && typeof model.provider === "string", "loopback-model-invalid");
        const input = observableJsonCopy(context, "arm-context-unobservable"), inputSha256 = hash(JSON.stringify(input));
        const outgoing = sanitizeScopedProviderContext(context, contextPolicy);
        const raw = { model: model.id, messages: strictJsonCopy(outgoing.messages, "final-payload-invalid"),
          tools: outgoing.tools.map(tool => ({ name: tool.name, label: tool.label,
            description: tool.description, parameters: strictJsonCopy(tool.parameters, "final-payload-invalid") })) };
        const callback = options?.onPayload;
        const returned = typeof callback === "function" ? await callback(raw, model) : raw;
        state.callbackCount++;
        const validated = validateScopedProviderPayload(returned === undefined ? raw : returned, model.id, outgoing);
        const requestBytes = Buffer.from(JSON.stringify(validated));
        brokerRequire(requestBytes.length <= 4 * 1024 * 1024, "final-payload-invalid");
        let wire;
        try { wire = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)); }
        catch { brokerFail("final-payload-invalid"); }
        validateScopedProviderPayload(wire, model.id, outgoing);
        state.validatedRequests++; state.lastRequestSha256 = hash(requestBytes);
        const contextJson = JSON.stringify(outgoing);
        await record(Object.freeze({ version: 3, kind: "provider-context", ...binding, inputSha256,
          sha256: hash(contextJson), value: outgoing })); state.evidenceRecords++;
        await record(Object.freeze({ version: 3, kind: "final-provider-payload", ...binding,
          sha256: state.lastRequestSha256, bytes: requestBytes.length, value: validated })); state.evidenceRecords++;
        brokerRequire(!options?.signal?.aborted, "loopback-cancelled");
        state.networkWrites++;
        const response = await fetch(state.url, { method: "POST", redirect: "error", signal: options?.signal,
          headers: { "Content-Type": "application/json" }, body: requestBytes });
        const responseBytes = await loopbackResponseBytes(response);
        let next;
        try { next = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)); }
        catch { brokerFail("loopback-response-invalid"); }
        brokerRequire(responseBytes.equals(Buffer.from(JSON.stringify(next))), "loopback-response-noncanonical");
        const message = qualifiedLoopbackMessage(next, model, state.responses + 1); state.responses++;
        stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        state.failures++; state.lastFailure = String(error?.stack ?? error)
          + (error?.cause ? `\nCAUSE: ${String(error.cause.stack ?? error.cause)}` : "");
        const aborted = options?.signal?.aborted === true, reason = aborted ? "aborted" : "error";
        stream.push({ type: "error", reason, error: { role: "assistant", content: [],
          api: typeof model?.api === "string" ? model.api : "g0-loopback",
          provider: typeof model?.provider === "string" ? model.provider : "loopback",
          model: typeof model?.id === "string" ? model.id : "g0", stopReason: reason,
          errorMessage: String(error?.message ?? "qualified-loopback-failed"), timestamp: 0,
          usage: qualifiedLoopbackUsage() } });
      }
    })();
    return stream;
  } });
  return wrapped;
}

// The transport spans the bounded benchmark session plus startup/teardown.
// Each verification retains its separate manifest deadline of at most 30s.
export const SCOPED_MCP_LIMITS = Object.freeze({ frameBytes: BROKER_TRANSPORT_BYTES,
  inputBytes: BROKER_TRANSPORT_BYTES, outputBytes: BROKER_TRANSPORT_BYTES,
  frames: 256, timeoutMs: 61 * 60 * 1000 });
const MCP_TURN_FIELDS = Object.freeze(["session_id", "thread_id", "turn_started_at_unix_ms", "turn_id",
  "workspaces", "node_repl_disabled", "thread_source", "sandbox", "sandbox_mode", "auto_review_enabled",
  "node_repl_auto_review_required", "model", "reasoning_effort"]);
const MCP_TURN_REQUIRED_FIELDS = Object.freeze(MCP_TURN_FIELDS.filter(key => key !== "reasoning_effort"));
const MCP_CALL_META_FIELDS = Object.freeze(["progressToken", "callId", "threadId", "itemId",
  "x-codex-turn-metadata", "codex/sandbox-state-meta"]);
export const SCOPED_MCP_METADATA_CONTRACT = deepFreeze({
  version: 2, id: "piagent-codex-mcp-metadata-v2", maxBytes: 64 * 1024,
  commonFields: ["progressToken"], callFields: [...MCP_CALL_META_FIELDS],
  turnFields: [...MCP_TURN_FIELDS], sandboxStateField: "codex/sandbox-state-meta",
  authority: "none"
});
export const SCOPED_CODEX_TURN_OBSERVATION_VERSION = "codex-mcp-turn-observation-v1";

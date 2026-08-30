import { createHash, createHmac, createSecretKey, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverRuntimeIntegrityFiles } from "../capabilities/runtime-integrity.js";
import { compileIndependentContract } from "./acceptance-independent-contract.js";
import { openAcceptanceEvidenceStore } from "./acceptance-evidence-store.js";
import { validateModulePaths } from "./acceptance-executor/module-graph.mjs";

export const HOST_CONTRACT_CONFIGURATION_VERSION = "approved-host-contracts-v1";
const HASH = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));

export function installedContractVerifierDigest(root) {
  const canonical = fs.realpathSync.native(root), digest = createHash("sha256");
  digest.update(HOST_CONTRACT_CONFIGURATION_VERSION);
  const files = discoverRuntimeIntegrityFiles(canonical);
  for (const required of ["packages/piagent-core/extensions/acceptance-authenticated-admission.js", "packages/piagent-core/extensions/acceptance-durable-execution.js",
    "packages/piagent-core/extensions/acceptance-host-configuration.js"]) if (!files.includes(required)) files.push(required);
  for (const relative of files.sort()) {
    const file = path.join(canonical, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Unsafe installed verifier file");
    const bytes = fs.readFileSync(file);
    digest.update(JSON.stringify([relative, bytes.length])); digest.update(bytes);
  }
  return digest.digest("hex");
}

function validate(payload) {
  if (!exact(payload, ["version", "projectId", "operatorRequestDigest", "verifierDigest", "backend", "contracts"])
    || payload.version !== HOST_CONTRACT_CONFIGURATION_VERSION || !HASH.test(payload.projectId) || !/^operator-request-v1:[a-f0-9]{64}$/.test(payload.operatorRequestDigest)
    || !HASH.test(payload.verifierDigest) || !exact(payload.backend, ["imageId", "dockerSocket", "timeoutMs"])
    || !/^sha256:[a-f0-9]{64}$/.test(payload.backend.imageId) || typeof payload.backend.dockerSocket !== "string"
    || !path.isAbsolute(payload.backend.dockerSocket) || payload.backend.dockerSocket.includes("\0")
    || !Number.isSafeInteger(payload.backend.timeoutMs) || payload.backend.timeoutMs < 25 || payload.backend.timeoutMs > 30000
    || !Array.isArray(payload.contracts) || payload.contracts.length < 1 || payload.contracts.length > 12) throw new TypeError("Invalid host contract approval");
  const ids = new Set();
  for (const contract of payload.contracts) {
    if (!exact(contract, ["criterionId", "criterionHash", "sourcePath", "exportName", "maxAttempts", "checks",
      ...(Object.hasOwn(contract, "modulePaths") ? ["modulePaths"] : [])])
      || typeof contract.criterionId !== "string" || !/^[a-z0-9][a-z0-9:._-]{0,79}$/.test(contract.criterionId)
      || ids.has(contract.criterionId) || !HASH.test(contract.criterionHash) || typeof contract.sourcePath !== "string"
      || !contract.sourcePath || path.isAbsolute(contract.sourcePath) || contract.sourcePath.includes("\\") || contract.sourcePath.includes("\0")
      || contract.sourcePath.split("/").some((part) => ["", ".", "..", ".git", ".pi", "node_modules"].includes(part))
      || !Number.isSafeInteger(contract.maxAttempts) || contract.maxAttempts < 1 || contract.maxAttempts > 8) throw new TypeError("Invalid approved criterion contract");
    ids.add(contract.criterionId);
    if (Object.hasOwn(contract, "modulePaths")) validateModulePaths(contract.sourcePath, contract.modulePaths);
    compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: "export const placeholder = 0;", exportName: contract.exportName, checks: contract.checks }));
  }
}

function privateDirectory(directory, projectRoot) {
  const root = fs.realpathSync.native(projectRoot);
  if (!path.isAbsolute(directory) || fs.realpathSync.native(directory) !== directory) throw new Error("Authority path must be canonical");
  const relative = path.relative(root, directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Authority must be outside the candidate project");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Authority directory must be private and host-owned");
}

function readPrivate(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > maximum) throw new Error("Invalid private authority file");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error("Authority changed while reading");
    return bytes;
  } finally { fs.closeSync(fd); }
}

const signature = (key, configPath, payload) => createHmac("sha256", key)
  .update(`${HOST_CONTRACT_CONFIGURATION_VERSION}\0${configPath}\0${JSON.stringify(payload)}`).digest("hex");

/** Read-only preview; validation creates no key, receipt, or execution. */
export function prepareHostContractApproval({ projectRoot, installedRoot, operatorRequestDigest, backend, contracts }) {
  const payload = JSON.parse(JSON.stringify({ version: HOST_CONTRACT_CONFIGURATION_VERSION,
    projectId: hash(fs.realpathSync.native(projectRoot)), operatorRequestDigest,
    verifierDigest: installedContractVerifierDigest(installedRoot), backend, contracts }));
  validate(payload);
  return freeze(payload);
}

/** Explicit operator setup only. A new directory is required; nothing is overwritten. */
export function writeHostContractApproval({ directory, projectRoot, installedRoot, operatorRequestDigest, backend, contracts, approved = false }) {
  if (approved !== true || typeof directory !== "string" || !path.isAbsolute(directory)
    || path.resolve(directory) !== directory || fs.realpathSync.native(path.dirname(directory)) !== path.dirname(directory)) throw new Error("Explicit canonical host approval is required");
  const root = fs.realpathSync.native(projectRoot), relative = path.relative(root, directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Authority must be outside the candidate project");
  const payload = prepareHostContractApproval({ projectRoot, installedRoot, operatorRequestDigest, backend, contracts });
  const configPath = path.join(directory, "approval.json"), bytes = randomBytes(32), key = createSecretKey(bytes);
  const envelope = JSON.stringify({ payload, signature: signature(key, configPath, payload) });
  if (Buffer.byteLength(envelope) > 2 * 1024 * 1024) throw new Error("Host approval is too large");
  fs.mkdirSync(directory, { mode: 0o700 });
  privateDirectory(directory, projectRoot);
  function write(name, content) {
    const fd = fs.openSync(path.join(directory, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  try { write("authority.key", bytes); write("approval.json", envelope); }
  finally { bytes.fill(0); }
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return Object.freeze({ configPath, verifierDigest: payload.verifierDigest });
}

export function openHostContractConfiguration({ configPath, projectRoot, installedRoot }) {
  const directory = path.dirname(configPath);
  privateDirectory(directory, projectRoot);
  if (path.basename(configPath) !== "approval.json" || path.resolve(configPath) !== configPath) throw new Error("Invalid host approval path");
  const bytes = readPrivate(path.join(directory, "authority.key"), 32);
  if (bytes.length !== 32) throw new Error("Invalid host authority key");
  const key = createSecretKey(bytes); bytes.fill(0);
  const text = readPrivate(configPath, 2 * 1024 * 1024).toString("utf8"), envelope = JSON.parse(text);
  if (!exact(envelope, ["payload", "signature"]) || !HASH.test(envelope.signature)
    || !timingSafeEqual(Buffer.from(signature(key, configPath, envelope.payload), "hex"), Buffer.from(envelope.signature, "hex"))) throw new Error("Host approval is unauthenticated");
  validate(envelope.payload);
  if (envelope.payload.projectId !== hash(fs.realpathSync.native(projectRoot)) || envelope.payload.verifierDigest !== installedContractVerifierDigest(installedRoot)) {
    throw new Error("Host approval project or installed verifier changed");
  }
  const store = openAcceptanceEvidenceStore({ filePath: path.join(directory, "evidence.sqlite"), projectRoot, key });
  return Object.freeze({ payload: freeze(envelope.payload), store,
    isCurrent() {
      try {
        privateDirectory(directory, projectRoot);
        const currentKey = readPrivate(path.join(directory, "authority.key"), 32);
        const sameKey = currentKey.length === 32 && createSecretKey(currentKey).equals(key); currentKey.fill(0);
        return sameKey && readPrivate(configPath, 2 * 1024 * 1024).toString("utf8") === text
          && installedContractVerifierDigest(installedRoot) === envelope.payload.verifierDigest;
      } catch { return false; }
    }, close: () => store.close() });
}

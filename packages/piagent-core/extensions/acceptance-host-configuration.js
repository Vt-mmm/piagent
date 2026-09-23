import { createHash, createHmac, createSecretKey, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { discoverRuntimeIntegrityFiles } from "../capabilities/runtime-integrity.js";
import { compileCompositeContract } from "./acceptance-composite-contract.js";
import { compileIndependentContract } from "./acceptance-independent-contract.js";
import { openAcceptanceEvidenceStore } from "./acceptance-evidence-store.js";
import { validateModulePaths } from "./acceptance-executor/module-graph.mjs";
import { validateContractSelection } from "./acceptance-contract-selection.js";
import { expectedNodeProfile } from "./acceptance-executor/node-profile.mjs";

export const HOST_CONTRACT_CONFIGURATION_VERSION = "approved-host-contracts-v1";
export const HOST_CONTRACT_SET_VERSION = "approved-host-contract-set-v1";
export const NODE_HOST_CONTRACT_CONFIGURATION_VERSION = "approved-host-contracts-v2";
export const NODE_HOST_CONTRACT_SET_VERSION = "approved-host-contract-set-v2";
const HASH = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const COMPOSITE_PLAN_CONTEXT_VERSION = "composite-plan-context-v1";
const MATERIAL_PATH = /^(?!\/)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)(?:\.{1,2}|\.git|\.pi|node_modules)(?:\/|$))[^\\\0-\x1f\x7f:%?#]+$/;

function parseStrictCompositeDeclarations(raw) {
  if (typeof raw !== "string" || !raw.isWellFormed() || Buffer.byteLength(raw) < 1 || Buffer.byteLength(raw) > 1024 * 1024) {
    throw new TypeError("Invalid composite declaration bytes");
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new TypeError("Invalid composite declaration JSON"); }
  const stack = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
    const token = match[0], current = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push({ keys: null });
    else if (token === "}" || token === "]") stack.pop();
    else if (current?.keys && token === ",") current.key = true;
    else if (current?.keys && token === ":") current.key = false;
    else if (current?.keys && current.key && token.startsWith('"')) {
      const key = JSON.parse(token);
      if (current.keys.has(key)) throw new TypeError("Duplicate composite declaration key");
      current.keys.add(key);
    }
    if (stack.length > 20) throw new TypeError("Composite declaration nesting exceeds bound");
  }
  return value;
}

function validateCompositeHostContract(contract, backend) {
  if (!exact(contract, ["route", "criterionId", "criterionHash", "maxAttempts", "planContext"])
    || contract.route !== "composite" || typeof contract.criterionId !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(contract.criterionId)
    || !HASH.test(contract.criterionHash) || !Number.isSafeInteger(contract.maxAttempts) || contract.maxAttempts < 1 || contract.maxAttempts > 8
    || !exact(contract.planContext, ["version", "contractText", "declarationsText", "identity", "materialBindings"])
    || contract.planContext.version !== COMPOSITE_PLAN_CONTEXT_VERSION || typeof contract.planContext.contractText !== "string"
    || !contract.planContext.contractText.isWellFormed() || Buffer.byteLength(contract.planContext.contractText) < 1
    || Buffer.byteLength(contract.planContext.contractText) > 1024 * 1024) throw new TypeError("Invalid approved composite criterion contract");
  const declarations = parseStrictCompositeDeclarations(contract.planContext.declarationsText);
  const compiled = compileCompositeContract(contract.planContext.contractText, declarations);
  if (compiled.criterionBinding !== "matched" || compiled.contract.criterionId !== contract.criterionId
    || compiled.contract.criterionHash !== contract.criterionHash
    || compiled.codePlans.some(plan => JSON.stringify(plan.profile) !== JSON.stringify(backend?.profile))) {
    throw new TypeError("Approved composite criterion binding mismatch");
  }
  const identity = contract.planContext.identity;
  if (!exact(identity, ["suiteDigest", "configDigest", "armDigest"])
    || ![identity.suiteDigest, identity.configDigest, identity.armDigest].every(value => HASH.test(value))) {
    throw new TypeError("Invalid approved composite identity");
  }
  const bindings = contract.planContext.materialBindings;
  if (!Array.isArray(bindings) || bindings.length > 32 || bindings.length !== declarations.materials.length) {
    throw new TypeError("Invalid approved composite material bindings");
  }
  const declared = new Map(declarations.materials.map(material => [material.id, material])), ids = new Set(), paths = new Set();
  for (const binding of bindings) {
    if (!exact(binding, ["id", "mode", "relativePath", "sha256"]) || !declared.has(binding.id) || ids.has(binding.id)
      || !["frozen", "current", "protected"].includes(binding.mode) || typeof binding.relativePath !== "string"
      || binding.relativePath.length > 1024 || !MATERIAL_PATH.test(binding.relativePath) || paths.has(binding.relativePath)
      || binding.mode === "frozen" !== HASH.test(binding.sha256 ?? "")
      || binding.mode !== "frozen" && binding.sha256 !== null
      || binding.mode === "protected" && declared.get(binding.id).byteLength !== 0) {
      throw new TypeError("Invalid approved composite material binding");
    }
    ids.add(binding.id); paths.add(binding.relativePath);
  }
  return compiled;
}

export function installedContractVerifierDigest(root) {
  const canonical = fs.realpathSync.native(root), digest = createHash("sha256");
  digest.update(HOST_CONTRACT_CONFIGURATION_VERSION);
  const files = discoverRuntimeIntegrityFiles(canonical);
  const familyLibrary = "adapters/node-typescript/contract-families.json";
  if (fs.existsSync(path.join(canonical, familyLibrary)) && !files.includes(familyLibrary)) files.push(familyLibrary);
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

/** Structural/semantic validation only; a payload is not authenticated authority. */
/** Request-set native-only steps grant no criterion receipts. Unknown requests
 * and mutation-capable tasks cannot borrow another request's authority. */
export function independentRequestAdmissionBlock(request, task) {
  if (!request) return "independent host approval does not cover the current operator request";
  if (request.nativeOnly === true && (task.changeMode !== "read-only" || task.mutationPolicy !== "forbidden")) {
    return "native-only host approval requires a read-only mutation-forbidden task";
  }
  return undefined;
}

export function validateHostContractPayload(payload) {
  if ([HOST_CONTRACT_SET_VERSION, NODE_HOST_CONTRACT_SET_VERSION].includes(payload?.version)) {
    if (!exact(payload, ["version", "projectId", "verifierDigest", "plans"])
      || !HASH.test(payload.projectId) || !HASH.test(payload.verifierDigest)) throw new TypeError("Invalid host contract set");
    validatePlanList(payload.plans, payload.version === NODE_HOST_CONTRACT_SET_VERSION ? 3 : 1);
    return payload;
  }
  const schemaVersion = payload?.version === NODE_HOST_CONTRACT_CONFIGURATION_VERSION ? 3
    : payload?.version === HOST_CONTRACT_CONFIGURATION_VERSION ? 1 : null;
  if (!exact(payload, ["version", "projectId", "operatorRequestDigest", "verifierDigest", "backend", "contracts"])
    || schemaVersion === null || !HASH.test(payload.projectId)
    || !HASH.test(payload.verifierDigest)) throw new TypeError("Invalid host contract approval");
  validateContractBody(payload, schemaVersion);
  return payload;
}

/** The same plan validation used by the operator CLI, without filesystem writes. */
export function validateHostContractPlan(plan) {
  if ([2, 4].includes(plan?.schemaVersion)) {
    if (!exact(plan, ["schemaVersion", "plans"])) throw new TypeError("Invalid host contract plan set");
    validatePlanList(plan.plans, plan.schemaVersion === 4 ? 3 : 1);
    return plan;
  }
  if (Object.hasOwn(plan ?? {}, "nativeOnly")) throw new TypeError("Native-only steps require an explicit request set");
  validateSinglePlan(plan);
  return plan;
}

function validateSinglePlan(plan) {
  if (!exact(plan, ["schemaVersion", "operatorRequestDigest", "backend", "contracts",
    ...(Object.hasOwn(plan ?? {}, "nativeOnly") ? ["nativeOnly"] : [])]) || ![1, 3].includes(plan.schemaVersion)) {
    throw new TypeError("Invalid host contract plan");
  }
  validateContractBody(plan, plan.schemaVersion);
}

function validatePlanList(plans, schemaVersion) {
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 32) throw new TypeError("Invalid host contract plan count");
  const requests = new Set();
  for (const plan of plans) {
    validateSinglePlan(plan);
    if (plan.schemaVersion !== schemaVersion) throw new TypeError("Mixed host contract plan versions");
    if (requests.has(plan.operatorRequestDigest)) throw new TypeError("Ambiguous approved operator request");
    requests.add(plan.operatorRequestDigest);
  }
}

function validateContractBody(payload, schemaVersion = 1) {
  const nodeProfile = schemaVersion === 3;
  const hasDockerCommand = Object.hasOwn(payload.backend ?? {}, "dockerCommand");
  const backendFields = nodeProfile
    ? ["imageId", "dockerSocket", ...(hasDockerCommand ? ["dockerCommand"] : []), "timeoutMs", "profile"]
    : ["imageId", "dockerSocket", "timeoutMs"];
  if (Object.hasOwn(payload.backend ?? {}, "startupAllowanceMs")) backendFields.push("startupAllowanceMs");
  if (!/^operator-request-v1:[a-f0-9]{64}$/.test(payload.operatorRequestDigest)
    || !exact(payload.backend, backendFields)
    || !/^sha256:[a-f0-9]{64}$/.test(payload.backend.imageId) || typeof payload.backend.dockerSocket !== "string"
    || !path.isAbsolute(payload.backend.dockerSocket) || payload.backend.dockerSocket.includes("\0")
    || hasDockerCommand && (!nodeProfile
      || JSON.stringify(Object.keys(payload.backend.dockerCommand ?? {})) !== JSON.stringify(["path", "sha256"])
      || typeof payload.backend.dockerCommand.path !== "string"
      || !path.isAbsolute(payload.backend.dockerCommand.path)
      || path.normalize(payload.backend.dockerCommand.path) !== payload.backend.dockerCommand.path
      || payload.backend.dockerCommand.path.includes("\0")
      || !HASH.test(String(payload.backend.dockerCommand.sha256 ?? "")))
    || Object.hasOwn(payload.backend, "startupAllowanceMs") && (!Number.isSafeInteger(payload.backend.startupAllowanceMs)
      || payload.backend.startupAllowanceMs < 0 || payload.backend.startupAllowanceMs > 60000)
    || !Number.isSafeInteger(payload.backend.timeoutMs) || payload.backend.timeoutMs < 25 || payload.backend.timeoutMs > 30000
    || nodeProfile && JSON.stringify(payload.backend.profile) !== JSON.stringify(expectedNodeProfile())
    || !Array.isArray(payload.contracts) || payload.contracts.length > 12
    || (Object.hasOwn(payload, "nativeOnly")
      ? !nodeProfile || payload.nativeOnly !== true || payload.contracts.length !== 0
      : payload.contracts.length < 1)) throw new TypeError("Invalid host contract approval");
  const ids = new Set();
  for (const contract of payload.contracts) {
    if (nodeProfile && contract?.route === "composite") {
      validateCompositeHostContract(contract, payload.backend);
      if (ids.has(contract.criterionId)) throw new TypeError("Invalid approved criterion contract");
      ids.add(contract.criterionId);
      continue;
    }
    if (!exact(contract, [...(nodeProfile ? ["route"] : []), "criterionId", "criterionHash", "sourcePath", "exportName", "maxAttempts", "checks",
      ...(Object.hasOwn(contract, "modulePaths") ? ["modulePaths"] : []), ...(Object.hasOwn(contract, "selection") ? ["selection"] : [])])
      || typeof contract.criterionId !== "string" || !/^[a-z0-9][a-z0-9:._-]{0,79}$/.test(contract.criterionId)
      || ids.has(contract.criterionId) || !HASH.test(contract.criterionHash) || typeof contract.sourcePath !== "string"
      || !contract.sourcePath || path.isAbsolute(contract.sourcePath) || contract.sourcePath.includes("\\") || contract.sourcePath.includes("\0")
      || contract.sourcePath.split("/").some((part) => ["", ".", "..", ".git", ".pi", "node_modules"].includes(part))
      || nodeProfile && contract.route !== "code"
      || !Number.isSafeInteger(contract.maxAttempts) || contract.maxAttempts < 1 || contract.maxAttempts > 8) throw new TypeError("Invalid approved criterion contract");
    ids.add(contract.criterionId);
    if (Object.hasOwn(contract, "selection")) validateContractSelection(contract.selection, contract.criterionHash);
    if (Object.hasOwn(contract, "modulePaths")) validateModulePaths(contract.sourcePath, contract.modulePaths);
    compileIndependentContract(JSON.stringify({ schemaVersion: nodeProfile ? 2 : 1, ...(nodeProfile ? { profile: payload.backend.profile } : {}),
      source: "export const placeholder = 0;", exportName: contract.exportName, checks: contract.checks }));
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

const signatureVersion = payload => [NODE_HOST_CONTRACT_CONFIGURATION_VERSION, NODE_HOST_CONTRACT_SET_VERSION].includes(payload?.version)
  ? NODE_HOST_CONTRACT_CONFIGURATION_VERSION : HOST_CONTRACT_CONFIGURATION_VERSION;
const signature = (key, configPath, payload) => createHmac("sha256", key)
  .update(`${signatureVersion(payload)}\0${configPath}\0${JSON.stringify(payload)}`).digest("hex");

/** Read-only preview; validation creates no key, receipt, or execution. */
export function prepareHostContractApproval({ projectRoot, installedRoot, operatorRequestDigest, backend, contracts, plans }) {
  if (plans !== undefined && [operatorRequestDigest, backend, contracts].some(value => value !== undefined)) {
    throw new TypeError("Cannot mix a single approved request with a plan set");
  }
  const identity = { projectId: hash(fs.realpathSync.native(projectRoot)), verifierDigest: installedContractVerifierDigest(installedRoot) };
  const nodeProfile = plans === undefined ? backend?.profile !== undefined : plans[0]?.schemaVersion === 3;
  const text = JSON.stringify(plans === undefined
    ? { version: nodeProfile ? NODE_HOST_CONTRACT_CONFIGURATION_VERSION : HOST_CONTRACT_CONFIGURATION_VERSION, ...identity, operatorRequestDigest, backend, contracts }
    : { version: nodeProfile ? NODE_HOST_CONTRACT_SET_VERSION : HOST_CONTRACT_SET_VERSION, ...identity, plans });
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new TypeError("Host approval is too large");
  const payload = JSON.parse(text);
  validateHostContractPayload(payload);
  return freeze(payload);
}

/** Explicit operator setup only. A new directory is required; nothing is overwritten. */
export function writeHostContractApproval({ directory, projectRoot, installedRoot, operatorRequestDigest, backend, contracts, plans, approved = false }) {
  if (approved !== true || typeof directory !== "string" || !path.isAbsolute(directory)
    || path.resolve(directory) !== directory || fs.realpathSync.native(path.dirname(directory)) !== path.dirname(directory)) throw new Error("Explicit canonical host approval is required");
  const root = fs.realpathSync.native(projectRoot), relative = path.relative(root, directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Authority must be outside the candidate project");
  const payload = prepareHostContractApproval({ projectRoot, installedRoot, operatorRequestDigest, backend, contracts, plans });
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
  validateHostContractPayload(envelope.payload);
  if (envelope.payload.projectId !== hash(fs.realpathSync.native(projectRoot)) || envelope.payload.verifierDigest !== installedContractVerifierDigest(installedRoot)) {
    throw new Error("Host approval project or installed verifier changed");
  }
  const store = openAcceptanceEvidenceStore({ filePath: path.join(directory, "evidence.sqlite"), projectRoot, key });
  const payload = freeze(envelope.payload);
  const setVersion = [HOST_CONTRACT_SET_VERSION, NODE_HOST_CONTRACT_SET_VERSION].includes(payload.version);
  const requests = setVersion ? payload.plans.map(plan => freeze({
    version: payload.version === NODE_HOST_CONTRACT_SET_VERSION ? NODE_HOST_CONTRACT_CONFIGURATION_VERSION : HOST_CONTRACT_CONFIGURATION_VERSION,
    projectId: payload.projectId, verifierDigest: payload.verifierDigest,
    operatorRequestDigest: plan.operatorRequestDigest, backend: plan.backend, contracts: plan.contracts,
    ...(plan.nativeOnly === true ? { nativeOnly: true } : {})
  })) : [payload];
  function withCompositeAuthority({ contract, binding, create }) {
    const owner = payload.contracts?.includes(contract) ? payload : requests.find(request => request.contracts.includes(contract));
    if (!owner) {
      throw new Error("Composite contract is not owned by this host approval");
    }
    if (contract.route !== "composite" || typeof create !== "function") throw new TypeError("Invalid composite authority request");
    const compiled = validateCompositeHostContract(contract, owner.backend), plan = contract.planContext;
    if (binding.suiteDigest !== plan.identity.suiteDigest || binding.configDigest !== plan.identity.configDigest
      || binding.armDigest !== plan.identity.armDigest || binding.projectId !== payload.projectId
      || binding.criterionId !== contract.criterionId || binding.criterionHash !== contract.criterionHash) {
      throw new Error("Composite authority binding does not match the approved plan");
    }
    // The KeyObject is a same-process capability handed only to the trusted
    // runtime callback. It is never returned, serialized, or placed in task data.
    return create(Object.freeze({ key, directory, projectRoot, compiled,
      contractText: plan.contractText, declarations: parseStrictCompositeDeclarations(plan.declarationsText),
      maxAttempts: contract.maxAttempts }));
  }
  function withCompositeRecovery(create) {
    if (typeof create !== "function" || !requests.some(request => request.contracts.some(contract => contract.route === "composite"))) {
      throw new TypeError("Invalid composite recovery authority request");
    }
    return create(Object.freeze({ key, directory, projectRoot, payload }));
  }
  const configuration = { payload, store,
    forRequest(operatorRequestDigest) { return requests.find(request => request.operatorRequestDigest === operatorRequestDigest) ?? null; },
    isCurrent() {
      try {
        privateDirectory(directory, projectRoot);
        const currentKey = readPrivate(path.join(directory, "authority.key"), 32);
        const sameKey = currentKey.length === 32 && createSecretKey(currentKey).equals(key); currentKey.fill(0);
        return sameKey && readPrivate(configPath, 2 * 1024 * 1024).toString("utf8") === text
          && installedContractVerifierDigest(installedRoot) === envelope.payload.verifierDigest;
      } catch { return false; }
    }, withCompositeAuthority, withCompositeRecovery, close: () => store.close()
  };
  return Object.freeze(configuration);
}

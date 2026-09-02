import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateHostContractPlan } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { BENCHMARK_SCOPED_SESSION_FACTORY_VERSION, BENCHMARK_SCOPED_SESSION_REQUEST_VERSION
} from "./benchmark-codex-journey.mjs";
import { createBenchmarkScopedSessionCustody } from "./benchmark-scoped-session-custody.mjs";
import { scopedToolDefinitionsSha256 } from "./benchmark-scoped-frozen-qualification.mjs";
import { scopedProjectVerificationPlanBinding } from "./benchmark-scoped-project-verifier.mjs";

export const REGISTERED_SCOPED_TOOL_POLICY_VERSION = "benchmark-shared-tool-policy-v1";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const SAFE_PATH = /^(?!\/)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)(?:\.{1,2}|\.git|\.pi|node_modules)(?:\/|$))[^\\\0-\x1f\x7f:%?#]+$/;
const MAX_ASSET = 2 * 1024 * 1024, MAX_MATERIAL = 64 * 1024;
const PROFILE_IDS = Object.freeze([
  "incident", "document", "protected-env-refusal", "destructive-history-refusal"
]);
const EXPECTED_SCENARIOS = Object.freeze(new Map([
  ["incident-diagnosis", "incident"],
  ["protected-env-refusal", "protected-env-refusal"],
  ["repository-prompt-injection", "document"],
  ["destructive-history-refusal", "destructive-history-refusal"]
]));
const states = new WeakMap();
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { brokerCode: code }); };
const requireThat = (value, code) => { if (!value) fail(code); };

function exact(value, names, code) {
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), code);
}

function canonicalDirectory(value, code, privateMode = false) {
  requireThat(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && !value.includes("\0"), code);
  let real, info;
  try { real = fs.realpathSync.native(value); info = fs.lstatSync(real); } catch { fail(code); }
  requireThat(real === value && info.isDirectory() && !info.isSymbolicLink()
    && (!privateMode || (info.mode & 0o077) === 0), code);
  return real;
}

function stableFile(file, maximum, code) {
  requireThat(typeof file === "string" && path.isAbsolute(file) && path.normalize(file) === file
    && !file.includes("\0"), code);
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); } catch { fail(code); }
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size > 0n && before.size <= BigInt(maximum), code);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true }),
      fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    requireThat(bytes.length === Number(before.size) && fields.every(name => before[name] === descriptor[name]
      && before[name] === after[name] && before[name] === current[name]), code);
    return Buffer.from(bytes);
  } finally { fs.closeSync(fd); }
}

function registeredAsset(measurement, relativePath) {
  requireThat(typeof relativePath === "string" && SAFE_PATH.test(relativePath), "session-factory-asset-path");
  const entry = measurement.inventory.entries.find(item => item.path === relativePath);
  requireThat(entry && HASH.test(entry.sha256) && Number.isSafeInteger(entry.bytes)
    && entry.bytes > 0 && entry.bytes <= MAX_ASSET, "session-factory-asset-inventory");
  const file = path.join(measurement.assetRoot, ...relativePath.split("/")), relative = path.relative(
    measurement.assetRoot, file).split(path.sep).join("/");
  requireThat(relative === relativePath, "session-factory-asset-path");
  const bytes = stableFile(file, MAX_ASSET, "session-factory-asset-drift");
  requireThat(bytes.length === entry.bytes && sha(bytes) === entry.sha256, "session-factory-asset-drift");
  return Object.freeze({ file, bytes });
}

function profileDigest(profile) {
  requireThat(PROFILE_IDS.includes(profile), "session-factory-profile");
  return sha(JSON.stringify({ version: 1, profile, mediation: "exclusive-signed-complete-journal",
    toolDefinitionsSha256: scopedToolDefinitionsSha256() }));
}

function validateMaterialPolicy(item) {
  exact(item, ["id", "relativePath", "mode", "sha256", "readable", "writable"],
    "session-factory-material-policy");
  requireThat(ID.test(item.id) && typeof item.relativePath === "string" && SAFE_PATH.test(item.relativePath)
    && ["frozen", "current", "protected"].includes(item.mode)
    && (item.mode === "frozen" ? HASH.test(item.sha256) : item.sha256 === null)
    && [item.readable, item.writable].every(value => typeof value === "boolean")
    && !(item.mode === "protected" && (item.readable || item.writable)),
  "session-factory-material-policy");
  return item;
}

function validateProjectVerifier(value) {
  exact(value, ["version", "verificationId", "timeoutMs", "expectedPlanDigest", "policy"],
    "session-factory-project-verifier");
  requireThat(value.version === "scoped-project-verification-host-v1" && ID.test(value.verificationId)
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 25 && value.timeoutMs <= 30000
    && HASH.test(value.expectedPlanDigest), "session-factory-project-verifier");
  return value;
}

function validatePolicy(value, suiteId) {
  exact(value, ["schemaVersion", "kind", "authority", "suiteId", "surfaceParity", "modelProvider",
    "context", "armIds", "profiles", "projectVerifier"], "session-factory-policy");
  requireThat(value.schemaVersion === 1 && value.kind === REGISTERED_SCOPED_TOOL_POLICY_VERSION
    && value.authority === "none" && value.suiteId === suiteId
    && value.surfaceParity === "same-public-profile-v1" && value.modelProvider === "openai-codex",
  "session-factory-policy");
  exact(value.context, ["version", "systemPrompt", "removableUserMessages"], "session-factory-policy-context");
  requireThat(value.context.version === 2 && typeof value.context.systemPrompt === "string"
    && value.context.systemPrompt.length > 0 && Buffer.byteLength(value.context.systemPrompt) <= 4096
    && Array.isArray(value.context.removableUserMessages)
    && value.context.removableUserMessages.length === 0, "session-factory-policy-context");
  exact(value.armIds, ["piagent", "codex-cli"], "session-factory-arm-ids");
  requireThat(ID.test(value.armIds.piagent) && ID.test(value.armIds["codex-cli"]), "session-factory-arm-ids");
  requireThat(Array.isArray(value.profiles) && value.profiles.length === EXPECTED_SCENARIOS.size,
    "session-factory-profiles");
  const profiles = new Map();
  for (const item of value.profiles) {
    exact(item, ["scenarioId", "profile", "materials", "verificationId"], "session-factory-profile");
    requireThat(EXPECTED_SCENARIOS.get(item.scenarioId) === item.profile && !profiles.has(item.scenarioId)
      && Array.isArray(item.materials) && item.materials.length >= 1 && item.materials.length <= 32
      && new Set(item.materials.map(material => material.id)).size === item.materials.length
      && new Set(item.materials.map(material => material.relativePath)).size === item.materials.length,
    "session-factory-profile");
    item.materials.forEach(validateMaterialPolicy);
    requireThat(item.verificationId === null || item.profile === "document"
      && item.verificationId === value.projectVerifier.verificationId, "session-factory-profile-verifier");
    profiles.set(item.scenarioId, item);
  }
  requireThat([...EXPECTED_SCENARIOS].every(([scenarioId, profile]) =>
    profiles.get(scenarioId)?.profile === profile), "session-factory-profiles");
  const verifier = validateProjectVerifier(value.projectVerifier);
  return Object.freeze({ value: Object.freeze(value), profiles, verifier });
}

function validatePlan(plan, policy, measurement, sharedPolicy) {
  try { validateHostContractPlan(plan); } catch { fail("session-factory-plan"); }
  requireThat(plan.schemaVersion === 3 && Array.isArray(plan.contracts) && plan.contracts.length > 0
    && plan.contracts.every(contract => contract.route === "composite"), "session-factory-plan");
  const expectedBindings = policy.materials.map(item => ({ id: item.id, mode: item.mode,
    relativePath: item.relativePath, sha256: item.sha256 }));
  const expectedWrites = policy.materials.filter(item => item.writable).map(item => item.id);
  for (const contract of plan.contracts) {
    const context = contract.planContext, publicContract = JSON.parse(context.contractText);
    requireThat(context.identity.suiteDigest === measurement.payload.baseSuiteDigest
      && context.identity.configDigest === measurement.payload.sharedEnvironmentDigest
      && JSON.stringify(context.materialBindings) === JSON.stringify(expectedBindings),
    "session-factory-plan-binding");
    const policies = publicContract.facts.filter(fact => fact.kind === "tool-policy-complete"),
      scopes = publicContract.facts.filter(fact => fact.kind === "workspace-scope"),
      verifiers = publicContract.facts.filter(fact => fact.kind === "project-verifier-current");
    requireThat(policies.length === 1 && policies[0].parameters.profileDigest === profileDigest(policy.profile)
      && scopes.length === 1
      && JSON.stringify(scopes[0].parameters.allowedWriteMaterialIds) === JSON.stringify(expectedWrites)
      && verifiers.length === (policy.verificationId === null ? 0 : 1)
      && (verifiers.length === 0 || verifiers[0].parameters.commandSetDigest
        === sharedPolicy.verifier.expectedPlanDigest), "session-factory-plan-policy");
  }
}

function materialSnapshot(workspace, policy) {
  const target = path.join(workspace, ...policy.relativePath.split("/"));
  let real, info;
  try { real = fs.realpathSync.native(target); info = fs.lstatSync(target, { bigint: true }); }
  catch { fail("session-factory-material-unavailable"); }
  requireThat(real === target && target.startsWith(workspace + path.sep) && info.isFile()
    && !info.isSymbolicLink() && info.nlink === 1n && info.size >= 0n
    && info.size <= BigInt(MAX_MATERIAL), "session-factory-material-path");
  if (policy.mode === "protected") return Object.freeze({ id: policy.id, relativePath: policy.relativePath,
    sha256: null, bytes: null, readable: false, writable: false, protected: true });
  const bytes = stableFile(target, MAX_MATERIAL, "session-factory-material-drift"), digest = sha(bytes);
  requireThat(policy.mode !== "frozen" || digest === policy.sha256, "session-factory-frozen-material-drift");
  return Object.freeze({ id: policy.id, relativePath: policy.relativePath, sha256: digest,
    bytes: bytes.length, readable: policy.readable, writable: policy.writable, protected: false });
}

function modelIdentity(request, provider) {
  const prefix = `${provider}/`;
  requireThat(request.model.startsWith(prefix) && request.model.length > prefix.length,
    "session-factory-model");
  return Object.freeze({ provider, model: request.model.slice(prefix.length), thinking: request.thinking,
    serviceTier: request.serviceTier });
}

/** Creates the registered noncode broker factory. It has no provider, grading,
 * registration, plan-approval or benchmark-admission authority. */
export function createRegisteredBenchmarkScopedSessionFactory(input) {
  const names = ["installedRoot", "registeredMeasurement", "custodyRoot", "nodeCommand",
    "codexRuntimePath", "qualification"];
  exact(input, names, "session-factory-input");
  const installedRoot = canonicalDirectory(input.installedRoot, "session-factory-installed-root"),
    custodyRoot = canonicalDirectory(input.custodyRoot, "session-factory-custody-root", true),
    measurement = input.registeredMeasurement;
  requireThat(measurement && typeof measurement === "object" && typeof measurement.assetRoot === "string"
    && measurement.payload?.suiteId === "production-v2-da2"
    && HASH.test(measurement.payload?.baseSuiteDigest)
    && HASH.test(measurement.payload?.sharedEnvironmentDigest)
    && Array.isArray(measurement.inventory?.entries), "session-factory-measurement");
  const registered = Object.freeze({ assetRoot: canonicalDirectory(measurement.assetRoot,
    "session-factory-asset-root"), payload: measurement.payload, inventory: measurement.inventory });
  const policyAsset = registeredAsset(registered, "measurement/shared-tool-policy-v1.json"),
    catalogAsset = registeredAsset(registered, "catalog.json");
  let policyValue, catalog;
  try { policyValue = JSON.parse(policyAsset.bytes); catalog = JSON.parse(catalogAsset.bytes); }
  catch { fail("session-factory-public-json"); }
  const policy = validatePolicy(policyValue, measurement.payload.suiteId);
  const nodeCommand = fs.realpathSync.native(input.nodeCommand), brokerScript = fs.realpathSync.native(
    path.join(installedRoot, "scripts", "benchmark-scoped-tool-broker.mjs"));
  requireThat(nodeCommand === input.nodeCommand && brokerScript.startsWith(installedRoot + path.sep),
    "session-factory-runtime");
  const codexRuntimePath = input.codexRuntimePath === null ? null : fs.realpathSync.native(input.codexRuntimePath);
  requireThat(codexRuntimePath === input.codexRuntimePath, "session-factory-runtime");
  const state = Object.freeze({ installedRoot, measurement: registered, custodyRoot, nodeCommand, codexRuntimePath,
    brokerScript, policyAsset, catalog, policy, qualification: input.qualification });
  const factory = Object.freeze({ version: BENCHMARK_SCOPED_SESSION_FACTORY_VERSION, authority: "none",
    async openSession(request) {
      exact(request, ["version", "authority", "runId", "suiteId", "scenarioId", "surface", "repeat",
        "infrastructureAttempt", "configurationSha256", "workspace", "model", "thinking", "serviceTier",
        "turns"], "session-factory-request");
      const selected = state.policy.profiles.get(request.scenarioId);
      requireThat(request.version === BENCHMARK_SCOPED_SESSION_REQUEST_VERSION && request.authority === "none"
        && request.suiteId === state.measurement.payload.suiteId && selected
        && request.configurationSha256 === state.measurement.payload.sharedEnvironmentDigest,
      "session-factory-request");
      const planAsset = registeredAsset(state.measurement, `plans/${request.scenarioId}.json`);
      let plan;
      try { plan = JSON.parse(planAsset.bytes); } catch { fail("session-factory-plan"); }
      validatePlan(plan, selected, state.measurement, state.policy);
      const verification = selected.verificationId === null ? null
        : scopedProjectVerificationPlanBinding({ projectRoot: request.workspace, nodeCommand: state.nodeCommand,
          policy: state.policy.verifier.policy, timeoutMs: state.policy.verifier.timeoutMs });
      requireThat(!verification || verification.planDigest === state.policy.verifier.expectedPlanDigest,
        "session-factory-project-verifier-drift");
      return createBenchmarkScopedSessionCustody({ custodyRoot: state.custodyRoot,
        nodeCommand: state.nodeCommand, brokerScript: state.brokerScript,
        runtimePath: request.surface === "codex-cli" ? state.codexRuntimePath : null,
        qualification: state.qualification, catalog: state.catalog, runId: request.runId,
        armId: state.policy.value.armIds[request.surface], suiteId: request.suiteId,
        scenarioId: request.scenarioId, surface: request.surface, repeat: request.repeat,
        infrastructureAttempt: request.infrastructureAttempt,
        configurationSha256: request.configurationSha256, planPath: planAsset.file,
        publicContractPath: state.policyAsset.file, workspace: request.workspace,
        modelIdentity: modelIdentity(request, state.policy.value.modelProvider), turns: request.turns,
        resolveResources({ expectedUserMessages, workspace }) {
          const materials = selected.materials.map(item => materialSnapshot(workspace, item));
          return Object.freeze({ profile: selected.profile, contextPolicy: Object.freeze({ version: 2,
            systemPrompt: state.policy.value.context.systemPrompt,
            allowedUserMessages: Object.freeze([...expectedUserMessages]), removableUserMessages: Object.freeze([]) }),
          materialRoot: workspace, materials: Object.freeze(materials), verifications: Object.freeze([]),
          verificationBridge: null, verificationHost: verification ? Object.freeze({
            version: state.policy.verifier.version, verificationId: selected.verificationId,
            timeoutMs: state.policy.verifier.timeoutMs, policy: state.policy.verifier.policy,
            expectedPlanDigest: verification.planDigest }) : null });
        } });
    } });
  states.set(factory, state);
  return factory;
}

export function registeredBenchmarkScopedSessionRequired(factory, scenarioId) {
  const state = states.get(factory);
  requireThat(state && typeof scenarioId === "string" && ID.test(scenarioId), "session-factory-identity");
  return state.policy.profiles.has(scenarioId);
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { benchmarkCommandIdentity } from "../packages/piagent-core/benchmark/benchmark-runtime-identity.js";
import { installedContractVerifierDigest, openHostContractConfiguration, validateHostContractPlan, writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { effectiveProtectedPaths } from "../packages/piagent-core/extensions/context-index-policy.js";
import { DURABLE_EXECUTION_VERSION } from "../packages/piagent-core/extensions/acceptance-durable-execution.js";
import { compileIndependentContract, compareIndependentExecution } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { EXECUTION_SNAPSHOT_VERSION } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";
import { parseRequest, parseResponse } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { redactSensitiveText } from "../packages/piagent-core/extensions/redaction-core.js";
import { extractLocalImagePathCandidates } from "../packages/piagent-core/runtime/input/chat-images.ts";
import { boundedOperatorRequest } from "../packages/piagent-core/runtime/registration/operator-request-intake.ts";
import { automaticTaskExpectedOutput } from "../packages/piagent-core/runtime/registration/task-start-conditional-mutation.ts";
import { LONG_INPUT_CHARS } from "../packages/piagent-core/runtime/runtime-limits.ts";
import { agentStartTaskRequest, looksLikeGovernedBoilerplate } from "../packages/piagent-core/runtime/workflows/input-routing.ts";
import { automaticAcceptanceCriteria, automaticTaskIntakeMode, automaticTaskMutationPolicy,
  automaticTaskSummary } from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import { buildWebUiWorkflowCommand, isWebUiWorkflowId } from "../packages/piagent-core/runtime/workflows/webui-workflow.ts";
import { buildWorkflowFollowUp } from "../packages/piagent-core/runtime/workflows/workflow-follow-up.ts";
import { compositeTaskPublicationDigest, openCompositeTaskPublicationStore } from "../packages/piagent-core/runtime/verification/composite-task-publication.ts";

export const BENCHMARK_VERIFICATION_PLAN_VERSION = "benchmark-independent-verification-plan-v1";
export const NODE_BENCHMARK_VERIFICATION_PLAN_VERSION = "benchmark-independent-verification-plan-v2";
const HASH = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const inside = (root, file) => { const relative = path.relative(fs.realpathSync.native(root), file);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };

function registeredPlanForSurface(plan, surface) {
  if (!["piagent", "codex-cli"].includes(surface)) throw new TypeError("Invalid registered verification surface");
  const selected = structuredClone(plan);
  for (const contract of selected.contracts) {
    if (contract.route !== "composite") continue;
    const identity = contract.planContext.identity;
    if (!exact(identity, ["suiteDigest", "configDigest", "armDigests"])
      || !exact(identity.armDigests, ["piagent", "codex-cli"])
      || ![identity.suiteDigest, identity.configDigest, identity.armDigests.piagent,
        identity.armDigests["codex-cli"]].every(value => HASH.test(value))) {
      throw new TypeError("Invalid registered surface-indexed composite identity");
    }
    contract.planContext.identity = { suiteDigest: identity.suiteDigest,
      configDigest: identity.configDigest, armDigest: identity.armDigests[surface] };
  }
  validateHostContractPlan(selected);
  return freeze(selected);
}

export function resolvedJourneyTurns(scenario, suiteRoot, resolveSuiteEntry) {
  if (!scenario.userJourney) return null;
  return scenario.userJourney.turns.map((turn) => {
    if (Object.hasOwn(turn, "workflow") && !isWebUiWorkflowId(turn.workflow)) throw new TypeError("Unsupported verification workflow");
    return {
      id: turn.id,
      message: fs.readFileSync(resolveSuiteEntry(suiteRoot, turn.prompt, `journey prompt ${scenario.id}/${turn.id}`), "utf8").trim(),
      reconnectBefore: turn.reconnectBefore === true,
      receiptUncertain: turn.receiptUncertain === true,
      ...(turn.workflow ? { workflow: turn.workflow } : {})
    };
  });
}

/** Prospective Piagent request bytes only; no task admission, criterion or approval authority. */
export function benchmarkVerificationOperatorRequest({ message, workflow }) {
  if (workflow != null && !isWebUiWorkflowId(workflow)) throw new TypeError("Unsupported verification workflow");
  const request = buildWebUiWorkflowCommand(null, message);
  // Raw input may be rewritten by commands, boilerplate collapse or a context-
  // dependent fresh-session handoff. Explicit workflow follow-ups originate
  // from the extension, so those preflight rewrites do not apply to them.
  if (!workflow && (request.startsWith("/") || looksLikeGovernedBoilerplate(request) || request.length >= LONG_INPUT_CHARS)) {
    throw new TypeError("Unsupported verification request ingress: declare a workflow or use bounded plain prose");
  }
  const delivered = workflow ? buildWorkflowFollowUp(workflow, request) : request;
  // Attachment rewriting depends on project files and policy. Detect possible
  // paths without reading them; never guess which image will be attached.
  if (extractLocalImagePathCandidates(delivered, "/").length) throw new TypeError("Unsupported verification image request ingress");
  const safeRequest = boundedOperatorRequest(agentStartTaskRequest(delivered), value => redactSensitiveText(value).text);
  if (!safeRequest) throw new TypeError("Unbound verification operator request");
  return safeRequest;
}

/** Prospective Piagent request identity only; no task admission, criterion or approval authority. */
export function benchmarkVerificationRequestDigest(input) {
  return operatorRequestDigest(benchmarkVerificationOperatorRequest(input));
}

/** Preview the actual frozen runtime, not a live checkout with different build assets. */
export function benchmarkVerificationBinding({ installedRoot, suiteDigest }) {
  if (!HASH.test(suiteDigest)) throw new TypeError("Invalid frozen verification suite digest");
  return Object.freeze({ kind: "benchmark-verification-binding-v1", suiteDigest,
    verifierDigest: installedContractVerifierDigest(installedRoot), approval: "not-granted" });
}

export function prepareBenchmarkVerification({ options, resumeState, registeredMeasurement, ...scope }) {
  if (registeredMeasurement) {
    if (options.verificationPlan || options.approveVerification) {
      throw new Error("Registered measurement supplies its signed verification plans; legacy verification options are forbidden");
    }
    const plan = loadRegisteredBenchmarkVerificationPlan({ registeredMeasurement, ...scope });
    if (resumeState && JSON.stringify(plan.identity) !== JSON.stringify(resumeState.manifest.verificationPlan?.identity ?? null)) {
      throw new Error("Cannot resume benchmark: registered independent verification configuration changed");
    }
    // The detached trusted registration is the approval boundary. This flag is
    // internal runner state; the registered CLI still rejects an arbitrary
    // --approve-verification or --verification-plan input.
    options.approveVerification = true;
    return plan;
  }
  if (resumeState) {
    if (options.verificationPlan && options.verificationPlan !== resumeState.manifest.verificationPlan?.file) throw new Error("Cannot change the verification plan on resume");
    options.verificationPlan = resumeState.manifest.verificationPlan?.file;
  }
  if (options.approveVerification && !options.verificationPlan) throw new Error("--approve-verification requires a verification plan");
  const plan = options.verificationPlan ? loadBenchmarkVerificationPlan({ ...scope, file: options.verificationPlan }) : null;
  if (resumeState && JSON.stringify(plan?.identity ?? null) !== JSON.stringify(resumeState.manifest.verificationPlan?.identity ?? null)) {
    throw new Error("Cannot resume benchmark: independent verification configuration changed");
  }
  if (plan && !options.dryRun && !options.preflightOnly && !options.approveVerification) {
    throw new Error("Independent verification requires explicit --approve-verification; --yes is not approval");
  }
  if (plan) options.keepWorkspaces = true;
  return plan;
}

function readRegisteredAsset(registeredMeasurement, relativePath) {
  const root = registeredMeasurement?.assetRoot;
  if (typeof root !== "string" || !path.isAbsolute(root) || fs.realpathSync.native(root) !== root) {
    throw new Error("Registered verification asset root is invalid");
  }
  const entry = registeredMeasurement?.inventory?.entries?.find(item => item.path === relativePath);
  if (!entry || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 2 * 1024 * 1024) {
    throw new Error("Registered verification plan is absent from the approved inventory");
  }
  const file = path.join(root, ...relativePath.split("/")), relative = path.relative(root, file);
  if (relative.split(path.sep).join("/") !== relativePath || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("Registered verification plan escapes its approved root");
  }
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(entry.bytes)) {
    throw new Error("Registered verification plan is not one approved regular file");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd,
      { bigint: true }), current = fs.lstatSync(file, { bigint: true }), fields =
      ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    if (bytes.length !== entry.bytes || fields.some(name => before[name] !== descriptor[name]
      || before[name] !== after[name] || before[name] !== current[name]) || hash(bytes) !== entry.sha256) {
      throw new Error("Registered verification plan changed during approved read");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function registeredText(bytes, label) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
  catch { throw new Error(`Registered ${label} is not UTF-8`); }
  if (!text || !text.isWellFormed()) throw new Error(`Registered ${label} is empty or malformed`);
  return Object.freeze({ text, bytes: Buffer.byteLength(text), sha256: hash(text) });
}

function suitePromptText(suiteRoot, resolveSuiteEntry, relativePath, label) {
  const file = resolveSuiteEntry(suiteRoot, relativePath, label);
  return registeredText(fs.readFileSync(file), label);
}

function installedJson(installedRoot, relativePath, label) {
  const file = path.join(installedRoot, ...relativePath.split("/"));
  if (!inside(installedRoot, file) || fs.realpathSync.native(file) !== file) {
    throw new Error(`Installed ${label} escapes the frozen candidate`);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 2 * 1024 * 1024) {
    throw new Error(`Installed ${label} is not a bounded regular file`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Provider-free preview of the exact runtime receipt used by registered-plan
 * loading. This creates no approval, execution, assessment or PASS authority. */
export function benchmarkVerificationReceiptForTurn(turn, { profile, policy }) {
  const query = benchmarkVerificationOperatorRequest(turn);
  const protectedPaths = effectiveProtectedPaths(policy, profile).readProtectedPaths;
  const changeMode = automaticTaskIntakeMode(query, protectedPaths);
  if (!changeMode) throw new Error("Registered primary request is not admitted by the frozen runtime intake");
  const mutationPolicy = automaticTaskMutationPolicy(query, changeMode);
  const redact = value => redactSensitiveText(String(value ?? "")).text;
  const summary = redact(automaticTaskSummary(query));
  const expectedOutput = redact(automaticTaskExpectedOutput(mutationPolicy));
  const acceptanceCriteria = automaticAcceptanceCriteria(query,
    mutationPolicy === "forbidden" ? "read-only" : changeMode, mutationPolicy).map(redact);
  const built = buildAcceptanceReceipt({
    summary, expectedOutput, acceptanceCriteria, changeMode, mutationPolicy,
    outOfScope: ["Unrelated files and behavior outside the operator request."],
    protectedPaths: profile.protectedPaths ?? [], source: "runtime",
    generatedAt: "1970-01-01T00:00:00.000Z"
  });
  return Object.freeze({ query, changeMode, mutationPolicy,
    criteria: built.receipt.criteria.map((criterion, index) => Object.freeze({
      criterionId: criterion.id, criterionHash: criterion.hash, criterionText: built.acceptanceCriteria[index]
    })) });
}

function registeredCatalogAndInputs({ registeredMeasurement, scenarios, suiteRoot, resolveSuiteEntry }) {
  const catalogBytes = readRegisteredAsset(registeredMeasurement, "catalog.json");
  let catalog;
  try { catalog = JSON.parse(catalogBytes); }
  catch { throw new Error("Registered public input catalog is not JSON"); }
  const fields = ["schemaVersion", "kind", "authority", "suiteId", "scenarioCount", "publicInputCount",
    "variantRoleCounts", "scenarios"];
  const scenarioIds = scenarios.map(item => item.id), payload = registeredMeasurement.payload;
  if (!exact(catalog, fields) || catalog.schemaVersion !== 1
    || catalog.kind !== "benchmark-public-input-catalog-v1" || catalog.authority !== "none"
    || catalog.suiteId !== payload.suiteId || catalog.scenarioCount !== 27 || catalog.publicInputCount !== 54
    || hash(JSON.stringify(catalog)) !== payload.catalogDigest
    || JSON.stringify(payload.scenarioIds) !== JSON.stringify(scenarioIds)
    || !Array.isArray(catalog.scenarios) || catalog.scenarios.length !== scenarios.length
    || JSON.stringify(catalog.scenarios.map(item => item.scenarioId)) !== JSON.stringify(scenarioIds)) {
    throw new Error("Registered public input catalog does not match the detached measurement");
  }
  const changed = new Set(payload.promptRolesChanged), inputs = new Map();
  let publicInputCount = 0;
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const entry = catalog.scenarios[scenarioIndex], sourceTurns = scenario.userJourney?.turns;
    if (!exact(entry, ["scenarioId", "variantRole", "planRef", "turnCount", "turns"])
      || !Array.isArray(sourceTurns) || entry.scenarioId !== scenario.id
      || entry.variantRole !== scenario.variantRole || entry.planRef !== `plan:${scenario.id}`
      || entry.turnCount !== sourceTurns.length || !Array.isArray(entry.turns)
      || entry.turns.length !== sourceTurns.length) {
      throw new Error("Registered public input scenario does not match the frozen base suite");
    }
    let amendmentUses = 0;
    const turns = sourceTurns.map((source, index) => {
      const amended = changed.has(scenario.id) && source.prompt === scenario.prompt;
      if (amended) amendmentUses += 1;
      const prompt = amended
        ? registeredText(readRegisteredAsset(registeredMeasurement,
          `measurement/prompts/${scenario.id}.md`), `prompt amendment ${scenario.id}`)
        : suitePromptText(suiteRoot, resolveSuiteEntry, source.prompt,
          `registered public input ${scenario.id}/${source.id}`);
      const turn = Object.freeze({ id: source.id, message: prompt.text,
        reconnectBefore: source.reconnectBefore === true, receiptUncertain: source.receiptUncertain === true,
        ...(source.workflow ? { workflow: source.workflow } : {}) });
      const projectedDigest = benchmarkVerificationRequestDigest(turn), registered = entry.turns[index];
      const binding = { version: 1, suiteId: catalog.suiteId, scenarioId: scenario.id,
        planRef: entry.planRef, variantRole: entry.variantRole, turnIndex: index + 1,
        turnId: source.id, promptPath: source.prompt, promptSha256: prompt.sha256,
        promptBytes: prompt.bytes, workflow: source.workflow ?? null,
        reconnectBefore: source.reconnectBefore === true, receiptUncertain: source.receiptUncertain === true,
        operatorRequestDigest: projectedDigest };
      if (!exact(registered, ["index", "turnId", "promptPath", "promptSha256", "promptBytes", "workflow",
        "reconnectBefore", "receiptUncertain", "operatorRequestDigest", "bindingDigest"])
        || registered.index !== index + 1 || registered.turnId !== source.id
        || registered.promptPath !== source.prompt || registered.promptSha256 !== prompt.sha256
        || registered.promptBytes !== prompt.bytes || registered.workflow !== (source.workflow ?? null)
        || registered.reconnectBefore !== (source.reconnectBefore === true)
        || registered.receiptUncertain !== (source.receiptUncertain === true)
        || registered.operatorRequestDigest !== projectedDigest
        || registered.bindingDigest !== hash(JSON.stringify(binding))) {
        throw new Error("Registered public turn does not match the dispatched input");
      }
      publicInputCount += 1;
      return turn;
    });
    if (changed.has(scenario.id) !== (amendmentUses === 1)) {
      throw new Error("Registered prompt amendment does not bind exactly one primary turn");
    }
    const primary = changed.has(scenario.id)
      ? registeredText(readRegisteredAsset(registeredMeasurement,
        `measurement/prompts/${scenario.id}.md`), `primary prompt ${scenario.id}`).text
      : suitePromptText(suiteRoot, resolveSuiteEntry, scenario.prompt,
        `registered primary prompt ${scenario.id}`).text;
    const selected = entry.variantRole === "interaction"
      ? turns.find(turn => turn.id === "implement") : turns[0];
    if (!selected) throw new Error("Registered scenario has no primary verification turn");
    inputs.set(scenario.id, freeze({ scenarioId: scenario.id, role: entry.variantRole,
      prompt: primary, turns, selected }));
  }
  if (publicInputCount !== catalog.publicInputCount || changed.size !== payload.promptRolesChanged.length) {
    throw new Error("Registered public input catalog count changed");
  }
  return Object.freeze({ catalog: freeze(catalog), catalogBytes, inputs });
}

/**
 * Load the exact detached-registration plan assets. The registration is the
 * human approval boundary; this loader still proves plan/input/runtime equality
 * before creating any per-run host authority.
 */
export function loadRegisteredBenchmarkVerificationPlan({
  registeredMeasurement, installedRoot, suiteDigest, scenarios, suiteRoot, resolveSuiteEntry
}) {
  const root = registeredMeasurement?.assetRoot;
  if (typeof root !== "string" || !path.isAbsolute(root) || fs.realpathSync.native(root) !== root) {
    throw new Error("Registered verification asset root is invalid");
  }
  if (inside(installedRoot, root) || inside(suiteRoot, root)) {
    throw new Error("Registered verification assets must be outside candidate and base suite source");
  }
  if (registeredMeasurement.payload.baseSuiteDigest !== suiteDigest) {
    throw new Error("Registered verification does not match the frozen base suite");
  }
  const verifierDigest = installedContractVerifierDigest(installedRoot);
  const { catalogBytes, inputs } = registeredCatalogAndInputs({
    registeredMeasurement, scenarios, suiteRoot, resolveSuiteEntry
  });
  const nodeBytes = readRegisteredAsset(registeredMeasurement, "measurement/node-workload-api-v1.json");
  const nodeProfile = JSON.parse(nodeBytes);
  if (nodeProfile?.schemaVersion !== 1 || nodeProfile?.kind !== "node-workload-api-profile-v1"
    || nodeProfile?.profile?.digest !== registeredMeasurement.payload.nodeProfileDigest
    || !/^sha256:[a-f0-9]{64}$/.test(String(nodeProfile?.workerImage?.id ?? ""))
    || JSON.stringify(nodeProfile?.publicCoverage?.allScenarioIds) !== JSON.stringify(scenarios.map(item => item.id))) {
    throw new Error("Registered Node verifier profile does not match the measurement");
  }
  const noncode = new Set(nodeProfile.publicCoverage.noncodeScenarioIds);
  if (noncode.size !== 4 || nodeProfile.publicCoverage.codeRecipeCount !== 23
    || nodeProfile.publicCoverage.noncodeProfileCount !== 4) {
    throw new Error("Registered verifier route inventory is invalid");
  }
  const profile = installedJson(installedRoot, "adapters/node-typescript/profile.json", "Node profile");
  const policy = installedJson(installedRoot, "packages/piagent-core/policies/base-policy.json", "base policy");
  const approvedDockerSha256 = registeredMeasurement.payload.resources.verifiers
    .find(item => item.id === "docker-runtime")?.sha256;
  if (!HASH.test(String(approvedDockerSha256 ?? ""))) {
    throw new Error("Registered Docker runtime identity is missing");
  }
  const planAssets = [], entries = [];
  let dockerCommand = null;
  for (const scenario of scenarios) {
    const relativePath = `plans/${scenario.id}.json`, bytes = readRegisteredAsset(registeredMeasurement, relativePath);
    let plan;
    try { plan = JSON.parse(bytes); }
    catch { throw new Error(`Registered verification plan is not JSON: ${scenario.id}`); }
    registeredPlanForSurface(plan, "piagent");
    registeredPlanForSurface(plan, "codex-cli");
    const selectedDocker = plan.backend?.dockerCommand;
    if (JSON.stringify(Object.keys(selectedDocker ?? {})) !== JSON.stringify(["path", "sha256"])
      || typeof selectedDocker.path !== "string" || !path.isAbsolute(selectedDocker.path)
      || path.normalize(selectedDocker.path) !== selectedDocker.path || selectedDocker.path.includes("\0")
      || selectedDocker.sha256 !== approvedDockerSha256) {
      throw new Error(`Registered Docker command binding is invalid: ${scenario.id}`);
    }
    let observedDocker;
    try { observedDocker = benchmarkCommandIdentity(selectedDocker.path, { fullPackageClosure: false }); }
    catch { throw new Error(`Registered Docker command is unavailable: ${scenario.id}`); }
    if (observedDocker.resolvedPath !== selectedDocker.path
      || observedDocker.contentDigest !== selectedDocker.sha256 || observedDocker.executable !== true) {
      throw new Error(`Registered Docker command changed: ${scenario.id}`);
    }
    if (dockerCommand && JSON.stringify(dockerCommand) !== JSON.stringify(selectedDocker)) {
      throw new Error("Registered plans disagree on the Docker command identity");
    }
    dockerCommand = freeze({ path: selectedDocker.path, sha256: selectedDocker.sha256 });
    const input = inputs.get(scenario.id), receipt = benchmarkVerificationReceiptForTurn(input.selected, { profile, policy });
    if (plan.schemaVersion !== 3 || plan.operatorRequestDigest !== benchmarkVerificationRequestDigest(input.selected)
      || plan.backend.imageId !== nodeProfile.workerImage.id
      || plan.contracts.length !== receipt.criteria.length) {
      throw new Error(`Registered verification plan does not match its primary request: ${scenario.id}`);
    }
    const expectedRoute = noncode.has(scenario.id) ? "composite" : "code";
    for (const [index, contract] of plan.contracts.entries()) {
      const criterion = receipt.criteria[index];
      if (contract.route !== expectedRoute || contract.criterionId !== criterion.criterionId
        || contract.criterionHash !== criterion.criterionHash) {
        throw new Error(`Registered verification criterion does not match runtime intake: ${scenario.id}`);
      }
      if (contract.route === "composite") {
        const identity = contract.planContext.identity;
        if (!exact(identity, ["suiteDigest", "configDigest", "armDigests"])
          || !exact(identity.armDigests, ["piagent", "codex-cli"])
          || ![identity.suiteDigest, identity.configDigest, identity.armDigests.piagent,
            identity.armDigests["codex-cli"]].every(value => HASH.test(value))) {
          throw new Error(`Registered composite arm identities are incomplete: ${scenario.id}`);
        }
        const publicContract = JSON.parse(contract.planContext.contractText);
        if (publicContract.criterionIndex !== index || publicContract.criterionId !== criterion.criterionId
          || publicContract.criterionHash !== criterion.criterionHash
          || publicContract.criterionText !== criterion.criterionText) {
          throw new Error(`Registered composite criterion text does not match runtime intake: ${scenario.id}`);
        }
      }
    }
    planAssets.push(Object.freeze({ path: relativePath, sha256: hash(bytes), bytes: bytes.length }));
    entries.push(Object.freeze({ scenarioId: scenario.id, plans: [freeze(plan)] }));
  }
  const boundAssets = [
    { path: "catalog.json", sha256: hash(catalogBytes), bytes: catalogBytes.length },
    { path: "measurement/node-workload-api-v1.json", sha256: hash(nodeBytes), bytes: nodeBytes.length },
    ...registeredMeasurement.payload.promptRolesChanged.map(id => {
      const relativePath = `measurement/prompts/${id}.md`,
        inventory = registeredMeasurement.inventory.entries.find(item => item.path === relativePath);
      return { path: relativePath, sha256: inventory.sha256, bytes: inventory.bytes };
    }),
    ...planAssets
  ];
  const contentDigest = hash(JSON.stringify(boundAssets)), catalog = freeze({
    schemaVersion: 2, kind: NODE_BENCHMARK_VERIFICATION_PLAN_VERSION,
    suiteDigest, verifierDigest, scenarios: entries
  });
  const identity = freeze({ kind: catalog.kind, contentDigest, suiteDigest, verifierDigest,
    scenarios: entries.map(entry => ({ scenarioId: entry.scenarioId,
      requests: entry.plans.map(plan => ({ operatorRequestDigest: plan.operatorRequestDigest,
        criterionCount: plan.contracts.length, criteria: plan.contracts.map(contract => ({
          criterionId: contract.criterionId, criterionHash: contract.criterionHash
        })) })) })) });
  const isCurrent = () => {
    try {
      return installedContractVerifierDigest(installedRoot) === verifierDigest
        && boundAssets.every(asset => hash(readRegisteredAsset(registeredMeasurement, asset.path)) === asset.sha256);
    } catch { return false; }
  };
  if (!dockerCommand) throw new Error("Registered Docker command binding is unavailable");
  return Object.freeze({ identity, isCurrent, dockerCommand,
    registeredSuiteId: registeredMeasurement.payload.suiteId,
    measurementConfigurationDigest: registeredMeasurement.payload.sharedEnvironmentDigest,
    registeredInput(scenarioId) {
      if (!isCurrent()) throw new Error("Registered measurement input or verifier changed");
      return inputs.get(scenarioId) ?? null;
    },
    prepare({ scenarioId, surface, projectRoot, directory, approved = false }) {
      if (surface !== "piagent") return null;
      if (approved !== true) throw new Error("Registered benchmark verification is not approved");
      if (!isCurrent()) throw new Error("Registered benchmark verification changed");
      const entry = entries.find(item => item.scenarioId === scenarioId);
      if (!entry) return Object.freeze({ environment: Object.freeze({}), observe: () => freeze({ schemaVersion: 1,
        planDigest: contentDigest, status: "not-configured", attempts: 0, workersObserved: 0, requests: [] }) });
      const plans = entry.plans.map(plan => registeredPlanForSurface(plan, surface));
      const { configPath } = writeHostContractApproval({
        directory, projectRoot, installedRoot, plans, approved: true
      });
      return Object.freeze({ environment: Object.freeze({ PIAGENT_INDEPENDENT_VERIFICATION_CONFIG: configPath }),
        observe(tasks) { return observeRequests({ configPath, projectRoot, installedRoot, plans,
          planDigest: contentDigest, tasks, isCurrent }); } });
    }
  });
}

function readPlan(file) {
  if (!path.isAbsolute(file) || fs.realpathSync.native(file) !== file) throw new Error("Verification plan path must be canonical");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > 2 * 1024 * 1024) throw new Error("Verification plan must be a private bounded host file");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (bytes.length !== stat.size || current.isSymbolicLink()
      || ["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].some(key => stat[key] !== after[key] || stat[key] !== current[key])) {
      throw new Error("Verification plan changed during read");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Structural validation is not operator approval or source/plan authentication. */
export function validateBenchmarkVerificationPlan(value) {
  const nodeProfile = value?.schemaVersion === 2 && value?.kind === NODE_BENCHMARK_VERIFICATION_PLAN_VERSION;
  if (!exact(value, ["schemaVersion", "kind", "suiteDigest", "verifierDigest", "scenarios"])
    || !nodeProfile && (value.schemaVersion !== 1 || value.kind !== BENCHMARK_VERIFICATION_PLAN_VERSION)
    || !HASH.test(value.suiteDigest) || !HASH.test(value.verifierDigest)
    || !Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > 100) {
    throw new TypeError("Invalid benchmark verification catalog");
  }
  const seen = new Set();
  for (const entry of value.scenarios) {
    if (!exact(entry, ["scenarioId", "plans"]) || typeof entry.scenarioId !== "string"
      || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(entry.scenarioId) || seen.has(entry.scenarioId)) {
      throw new TypeError("Invalid or duplicate verification scenario");
    }
    seen.add(entry.scenarioId);
    validateHostContractPlan({ schemaVersion: nodeProfile ? 4 : 2, plans: entry.plans });
  }
  return value;
}

/** Read and bind operator-authored expected results; never derive them from a candidate or grader. */
export function loadBenchmarkVerificationPlan({ file, installedRoot, suiteDigest, scenarios, suiteRoot, resolveSuiteEntry }) {
  if (inside(installedRoot, file) || inside(suiteRoot, file)) throw new Error("Verification catalog must be outside candidate and suite source");
  const bytes = readPlan(file), value = validateBenchmarkVerificationPlan(JSON.parse(bytes));
  if (value.suiteDigest !== suiteDigest || value.verifierDigest !== installedContractVerifierDigest(installedRoot)) {
    throw new Error("Verification plan does not match the frozen suite and installed verifier");
  }
  const known = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  for (const entry of value.scenarios) {
    const scenario = known.get(entry.scenarioId);
    if (!scenario) throw new Error("Unknown verification scenario");
    // Piagent journeys dispatch workflow metadata before automatic intake.
    // Baseline surfaces receive no approval and keep their own raw turn text.
    const turns = resolvedJourneyTurns(scenario, suiteRoot, resolveSuiteEntry) ?? [{ message: fs.readFileSync(
      resolveSuiteEntry(suiteRoot, scenario.prompt, "verification public prompt"), "utf8").trim() }];
    const requests = new Map();
    for (const turn of turns) {
      const digest = benchmarkVerificationRequestDigest(turn), source = JSON.stringify([turn.workflow ?? null, turn.message]);
      if (requests.has(digest) && requests.get(digest) !== source) throw new Error("Ambiguous verification request identity after normalization");
      requests.set(digest, source);
    }
    if (entry.plans.some(plan => !requests.has(plan.operatorRequestDigest))) throw new Error("Verification plan authorizes a request not sent by this scenario");
  }
  const catalog = freeze(value);
  const identity = freeze({ kind: catalog.kind, contentDigest: hash(bytes),
    suiteDigest, verifierDigest: catalog.verifierDigest,
    scenarios: catalog.scenarios.map(entry => ({ scenarioId: entry.scenarioId,
      requests: entry.plans.map(plan => ({ operatorRequestDigest: plan.operatorRequestDigest, criterionCount: plan.contracts.length,
        criteria: plan.contracts.map(contract => ({ criterionId: contract.criterionId, criterionHash: contract.criterionHash })) })) })) });
  const isCurrent = () => {
    try { return hash(readPlan(file)) === identity.contentDigest && installedContractVerifierDigest(installedRoot) === identity.verifierDigest; }
    catch { return false; }
  };
  return Object.freeze({ identity, isCurrent,
    prepare({ scenarioId, surface, projectRoot, directory, approved = false }) {
      if (surface !== "piagent") return null;
      if (approved !== true) throw new Error("Benchmark verification requires explicit --approve-verification");
      if (inside(projectRoot, file)) throw new Error("Verification catalog must be outside the candidate project");
      if (!isCurrent()) throw new Error("Frozen benchmark verification plan or verifier changed");
      const entry = catalog.scenarios.find(item => item.scenarioId === scenarioId);
      if (!entry) return Object.freeze({ environment: Object.freeze({}), observe: () => freeze({ schemaVersion: 1,
        planDigest: identity.contentDigest, status: "not-configured", attempts: 0, workersObserved: 0, requests: [] }) });
      const { configPath } = writeHostContractApproval({ directory, projectRoot, installedRoot, plans: entry.plans, approved: true });
      return Object.freeze({ environment: Object.freeze({ PIAGENT_INDEPENDENT_VERIFICATION_CONFIG: configPath }),
        observe(tasks) { return observeRequests({ configPath, projectRoot, installedRoot, plans: entry.plans,
          planDigest: identity.contentDigest, tasks, isCurrent }); } });
    }
  });
}

/** Observation only, never completion authority. Keep failures and pending attempts in the denominator. */
function observeRequests({ configPath, projectRoot, installedRoot, plans, planDigest, tasks, isCurrent }) {
  let config;
  try {
    if (!isCurrent()) throw new Error("Plan drift");
    if (!Array.isArray(tasks) || tasks.length > 1000 || tasks.some(task => typeof task?.taskRunId !== "string")
      || new Set(tasks.map(task => task.taskRunId)).size !== tasks.length) throw new Error("Invalid task observation");
    config = openHostContractConfiguration({ configPath, projectRoot, installedRoot });
    let attempts = 0, workersObserved = 0, complete = true;
    const requests = plans.map(plan => {
      const matched = tasks.filter(task => task.operatorRequestDigest === plan.operatorRequestDigest);
      if (matched.length === 0) complete = false;
      const nodeProfile = plan.schemaVersion === 3;
      const profile = nodeProfile ? plan.backend.profile : undefined;
      const templateFor = contract => compileIndependentContract(JSON.stringify({ schemaVersion: nodeProfile ? 2 : 1,
        ...(nodeProfile ? { profile } : {}), source: "export const placeholder=0;", exportName: contract.exportName, checks: contract.checks }));
      const codeContract = plan.contracts.find(contract => contract.route !== "composite");
      const compilerVersion = codeContract ? templateFor(codeContract).version : null;
      const backendDigest = compilerVersion ? hash(JSON.stringify([DURABLE_EXECUTION_VERSION, compilerVersion,
        EXECUTION_SNAPSHOT_VERSION, plan.backend.imageId, plan.backend.dockerSocket,
        plan.backend.dockerCommand, plan.backend.timeoutMs, profile ?? null,
        ...(plan.backend.startupAllowanceMs ? [plan.backend.startupAllowanceMs] : [])])) : null;
      const publicationStore = plan.contracts.some(contract => contract.route === "composite")
        ? config.withCompositeRecovery(({ key, directory, projectRoot: approvedRoot }) =>
          openCompositeTaskPublicationStore({ key, directory, projectRoot: approvedRoot })) : null;
      const runs = matched.map(task => ({ taskRunId: task.taskRunId, criteria: plan.contracts.map(contract => {
        if (contract.route === "composite") {
          const result = { criterionId: contract.criterionId, criterionHash: contract.criterionHash,
            attempts: 0, phase: "not-observed", verdict: null, workerObserved: false };
          if (!publicationStore || typeof task.sessionId !== "string") { complete = false; return result; }
          const record = publicationStore.read(task.taskRunId, task.sessionId);
          if (!record) { complete = false; return result; }
          result.attempts = 1; attempts += 1;
          const matching = task.acceptanceReceipt?.criteria.some(criterion =>
            criterion.id === contract.criterionId && criterion.hash === contract.criterionHash);
          const entry = record.entries.find(item => item.criterionId === contract.criterionId);
          const taskDigest = compositeTaskPublicationDigest(task);
          const taskBound = task.trace?.outcome === "completed"
            ? taskDigest === record.terminalTaskDigest : taskDigest === record.pendingTaskDigest;
          if (!matching || !entry || entry.criterionHash !== contract.criterionHash
            || record.operatorRequestDigest !== plan.operatorRequestDigest || !taskBound) {
            complete = false; result.phase = "binding-mismatch"; return result;
          }
          const status = publicationStore.inspect(record).statuses.find(item =>
            item.criterionId === contract.criterionId)?.status;
          if (status !== "task-completed" || task.trace?.outcome !== "completed") {
            complete = false; result.phase = "reserved"; return result;
          }
          result.phase = "settled"; result.verdict = "pass";
          // The legacy field name is retained for report compatibility. Here it
          // means the host observer re-opened a signed, fully settled composite
          // publication; it does not claim that a code worker ran.
          result.workerObserved = true; workersObserved += 1;
          return result;
        }
        const event = config.store.latest({ taskRunId: task.taskRunId, criterionId: contract.criterionId });
        const result = { criterionId: contract.criterionId, criterionHash: contract.criterionHash,
          attempts: event?.attempt ?? 0, phase: event?.phase ?? "not-observed", verdict: null, workerObserved: false };
        attempts += result.attempts;
        const matching = task.acceptanceReceipt?.criteria.some(criterion => criterion.id === contract.criterionId && criterion.hash === contract.criterionHash);
        if (!matching || !event || event.binding.criterionHash !== contract.criterionHash
          || event.binding.verifierDigest !== config.payload.verifierDigest || event.binding.backendDigest !== backendDigest) {
          complete = false; result.phase = event ? "binding-mismatch" : "not-observed"; return result;
        }
        if (event.phase !== "settled") { complete = false; return result; }
        const evidence = JSON.parse(event.evidenceText);
        if (evidence.version !== DURABLE_EXECUTION_VERSION || evidence.snapshotDigest !== event.binding.snapshotDigest
          || evidence.planDigest !== event.binding.planDigest || !["pass", "fail", "unknown", "error"].includes(evidence.verdict)) {
          complete = false; result.phase = "invalid-evidence"; return result;
        }
        result.verdict = evidence.verdict;
        const observed = evidence.observed, execution = observed?.result?.execution;
        const template = templateFor(contract);
        if (observed?.snapshotDigest === event.binding.snapshotDigest && observed.result?.version === template.version
          && observed.result.planDigest === event.binding.planDigest && execution?.runId === event.attemptId
          && execution.imageId === plan.backend.imageId && HASH.test(execution.sourceDigest) && HASH.test(execution.requestDigest)
          && execution.observation && execution.cleanupConfirmed === true) {
          const response = parseResponse(JSON.stringify(execution.observation), parseRequest(template.requestText), execution.requestDigest);
          const compared = compareIndependentExecution({ ...template, planDigest: event.binding.planDigest }, execution);
          result.workerObserved = response.status === execution.status && compared.verdict === evidence.verdict
            && compared.verdict === observed.verdict && compared.verdict === observed.result.verdict
            && JSON.stringify(compared.checks) === JSON.stringify(observed.result.checks)
            && JSON.stringify(compared.counterexamples) === JSON.stringify(observed.result.counterexamples);
        }
        if (result.workerObserved) workersObserved += 1;
        else complete = false;
        return result;
      }) }));
      return { operatorRequestDigest: plan.operatorRequestDigest, runs };
    });
    if (!config.isCurrent() || !isCurrent()) throw new Error("Approval drift");
    return freeze({ schemaVersion: 1, planDigest, status: complete ? "observed" : "partial", attempts, workersObserved, requests });
  } catch {
    // Usage has already been collected by the caller. Invalid verification
    // evidence must not discard the paid attempt or reveal private plan data.
    return freeze({ schemaVersion: 1, planDigest, status: "unavailable", attempts: null, workersObserved: null, requests: [] });
  } finally { config?.close(); }
}

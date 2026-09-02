import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateHostContractPlan } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { scopedBrokerProfileDigest } from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";
import {
  benchmarkVerificationReceiptForTurn,
  benchmarkVerificationRequestDigest
} from "./benchmark-independent-verification.mjs";
import { registeredBackendRecipe } from "./benchmark-registered-plan-recipes-backend.mjs";
import { registeredDataRecipe } from "./benchmark-registered-plan-recipes-data.mjs";
import { registeredPlatformRecipe } from "./benchmark-registered-plan-recipes-platform.mjs";

export const REGISTERED_PLAN_AUTHOR_VERSION = "benchmark-registered-plan-author-v1";
const HASH = /^[a-f0-9]{64}$/;
const INSTALLED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SUITE_ROOT = path.join(INSTALLED_ROOT, "benchmarks", "production-v2");
const HIDDEN_BASENAMES = new Set(["grade.mjs", "variant.mjs"]);
const NATIVE_PRODUCER_ID = "native-host-facts-v1";
const WORKER_IMAGE = "sha256:6cf57181d9d256900f5279c3f0972bc6fe3264787f729443839672890e47872d";
const sha = value => createHash("sha256").update(value).digest("hex");

const FAMILY_RECIPES = Object.freeze({
  "expiry-boundary": { id: "iso-expiry-millisecond-profile", version: 1,
    sourcePath: "src/reliability/expiry.js", parameters: { call: "isExpired" } },
  "stale-search-response": { id: "stale-search-reducer", version: 1,
    sourcePath: "src/frontend/search-state.js", parameters: { call: "searchReducer" } },
  "abort-reconnect-supersession": { id: "epoch-request-lifecycle", version: 1,
    sourcePath: "src/frontend/request-lifecycle.js", parameters: { call: "requestLifecycleReducer" } },
  "config-precedence": { id: "defined-config-precedence", version: 2,
    sourcePath: "src/platform/config.js", parameters: {
      call: "resolveConfig", numericKey: "port", booleanKey: "debug", textKey: "label"
    } },
  "bounded-retry": { id: "bounded-retry-injected-sleep", version: 1,
    sourcePath: "src/reliability/retry.js", parameters: { call: "retry" } },
  "resumable-checkpoint-partial-failure": { id: "partial-checkpoint-resume", version: 1,
    sourcePath: "src/reliability/checkpoint.js", parameters: { call: "resumeWork" } },
  "workflow-switch-same-session": { id: "workflow-message-reducer", version: 1,
    sourcePath: "src/platform/workflow-session.js", parameters: { call: "reduceWorkflowSession" } }
});

function exact(value, names) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function stableFile(file, maximum, label) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file
    || HIDDEN_BASENAMES.has(path.basename(file))) throw new Error(`Invalid public ${label} path`);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n
    || before.size > BigInt(maximum)) throw new Error(`Invalid public ${label} file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true }),
      fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    if (bytes.length !== Number(before.size) || fields.some(name => before[name] !== descriptor[name]
      || before[name] !== after[name] || before[name] !== current[name])) {
      throw new Error(`Public ${label} changed during read`);
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function stableJson(file, maximum, label) {
  return JSON.parse(stableFile(file, maximum, label).toString("utf8"));
}

function publicSuiteEntry(suiteRoot, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.startsWith("prompts/")
    || relativePath.includes("\\") || relativePath.split("/").some(part => ["", ".", ".."].includes(part))) {
    throw new Error(`Invalid public ${label} entry`);
  }
  const file = path.join(suiteRoot, ...relativePath.split("/")), relative = path.relative(suiteRoot, file);
  if (relative.split(path.sep).join("/") !== relativePath || HIDDEN_BASENAMES.has(path.basename(file))) {
    throw new Error(`Public ${label} escapes suite`);
  }
  return file;
}

function textAsset(file, label) {
  const bytes = stableFile(file, 64 * 1024, label);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
  catch { throw new Error(`Public ${label} is not UTF-8`); }
  if (!text || !text.isWellFormed()) throw new Error(`Public ${label} is malformed`);
  return { text, bytes: Buffer.byteLength(text), sha256: sha(text) };
}

function resolveParameter(value, parameters) {
  if (Array.isArray(value)) return value.map(item => resolveParameter(item, parameters));
  if (value && typeof value === "object") {
    if (exact(value, ["$parameter"])) {
      if (!Object.hasOwn(parameters, value.$parameter)) throw new Error("Missing public family parameter");
      return parameters[value.$parameter];
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveParameter(item, parameters)]));
  }
  return value;
}

function familyRecipe(scenarioId, families) {
  const selected = FAMILY_RECIPES[scenarioId];
  if (!selected) return null;
  const family = families.families.find(item => item.id === selected.id && item.version === selected.version);
  if (!family || !exact(family.parameters, Object.keys(selected.parameters))) {
    throw new Error(`Public contract family unavailable: ${scenarioId}`);
  }
  const template = resolveParameter(family.template, selected.parameters);
  for (const check of template.checks) for (const item of check.cases) {
    if (Object.hasOwn(item, "invocation")) throw new Error("Public family unexpectedly owns invocation");
    item.invocation = { kind: "call" };
  }
  return { sourcePath: selected.sourcePath, exportName: template.exportName,
    ...(template.modulePaths?.length ? { modulePaths: template.modulePaths } : {}), checks: template.checks };
}

function codeRecipe(scenarioId, families) {
  const authored = registeredBackendRecipe(scenarioId) ?? registeredDataRecipe(scenarioId)
    ?? registeredPlatformRecipe(scenarioId) ?? familyRecipe(scenarioId, families);
  if (!authored) throw new Error(`No public verification recipe: ${scenarioId}`);
  return JSON.parse(JSON.stringify(authored));
}

function selectedInput({ scenario, catalogEntry, assetRoot, suiteRoot }) {
  if (catalogEntry.scenarioId !== scenario.id || catalogEntry.variantRole !== scenario.variantRole
    || catalogEntry.planRef !== `plan:${scenario.id}` || catalogEntry.turnCount !== scenario.userJourney?.turns?.length) {
    throw new Error(`Public catalog scenario mismatch: ${scenario.id}`);
  }
  const amendmentFile = path.join(assetRoot, "measurement", "prompts", `${scenario.id}.md`),
    amended = fs.existsSync(amendmentFile);
  let amendmentUses = 0;
  const turns = scenario.userJourney.turns.map((source, index) => {
    const useAmendment = amended && source.prompt === scenario.prompt;
    if (useAmendment) amendmentUses += 1;
    const prompt = textAsset(useAmendment ? amendmentFile : publicSuiteEntry(suiteRoot, source.prompt,
      `${scenario.id}/${source.id}`), `${scenario.id}/${source.id}`), registered = catalogEntry.turns[index];
    const turn = { id: source.id, message: prompt.text,
      reconnectBefore: source.reconnectBefore === true, receiptUncertain: source.receiptUncertain === true,
      ...(source.workflow ? { workflow: source.workflow } : {}) };
    if (registered.index !== index + 1 || registered.turnId !== source.id || registered.promptPath !== source.prompt
      || registered.promptSha256 !== prompt.sha256 || registered.promptBytes !== prompt.bytes
      || registered.workflow !== (source.workflow ?? null)
      || registered.operatorRequestDigest !== benchmarkVerificationRequestDigest(turn)) {
      throw new Error(`Public catalog turn mismatch: ${scenario.id}/${source.id}`);
    }
    return turn;
  });
  if (amended !== (amendmentUses === 1)) throw new Error(`Public amendment mismatch: ${scenario.id}`);
  const selected = scenario.variantRole === "interaction" ? turns.find(turn => turn.id === "implement") : turns[0];
  if (!selected) throw new Error(`Public primary turn unavailable: ${scenario.id}`);
  return selected;
}

function factSpecification({ id, kind, producerId, producerDigest, ruleDigest, stage = "content", parameters }) {
  const basis = { kind, producerId, producerDigest, ruleDigest, stage, parameters },
    specDigest = sha(JSON.stringify({ version: 1, ...basis }));
  return { id, kind, specDigest, producerId, producerDigest, ruleDigest, stage, parameters };
}

function nativeFact(id, kind, parameters, stage = "content") {
  return factSpecification({ id, kind, producerId: NATIVE_PRODUCER_ID,
    producerDigest: sha(NATIVE_PRODUCER_ID), ruleDigest: sha(`${NATIVE_PRODUCER_ID}:${kind}:v1`), stage, parameters });
}

function compositeFacts(profile, rubric, policy) {
  const facts = [], readable = policy.materials.filter(item => item.readable).map(item => item.id),
    writable = policy.materials.filter(item => item.writable).map(item => item.id);
  if (readable.length) facts.push(nativeFact("context", "context-current", {
    requiredMaterialIds: readable, delivery: "actual-tool-result-or-prompt"
  }));
  facts.push(factSpecification({ id: "content", kind: rubric.kind,
    producerId: rubric.producerId, producerDigest: rubric.producerDigest, ruleDigest: rubric.ruleDigest,
    parameters: rubric.kind === "structured-log-claims" ? {
      logMaterialId: policy.materials[0].id, responseFormat: rubric.definition.responseFormat,
      correlation: rubric.definition.correlation
    } : rubric.kind === "config-document-literals" ? {
      configMaterialId: policy.materials.find(item => item.mode === "frozen").id,
      documentMaterialId: policy.materials.find(item => item.writable).id,
      format: rubric.definition.format, requiredFields: rubric.definition.requiredFields
    } : {
      rule: rubric.definition.rule, protectedMaterialId: policy.materials[0].id,
      expectedDisposition: rubric.definition.expectedDisposition,
      responseFormat: rubric.definition.responseFormat,
      nativeTemplateSetDigest: rubric.definition.nativeTemplateSetDigest
    } }));
  facts.push(nativeFact("scope", "workspace-scope", {
    allowedWriteMaterialIds: writable, requireCompleteMutationJournal: true
  }));
  facts.push(nativeFact("policy", "tool-policy-complete", {
    profileDigest: scopedBrokerProfileDigest(profile), requireExclusiveMediation: true
  }));
  if (policy.verificationId !== null) facts.push(nativeFact("verifier", "project-verifier-current", {
    commandSetDigest: policy.projectVerifierDigest
  }));
  facts.push(nativeFact("persisted", "response-persisted", {
    expectedOrigins: ["assistant"], requireExactBytes: true
  }, "settlement"));
  facts.push(nativeFact("delivered", "terminal-delivery", {
    boundary: "webui-operation-confirmed", requireExactOperation: true
  }, "settlement"));
  return facts;
}

function compositeRoles(profile) {
  if (profile === "incident") return ["diagnosis", "no-mutation", "persistence", "delivery"];
  if (profile === "document") return ["document-literals", "path-scope", "verification", "persistence", "delivery"];
  return ["refusal", "no-protected-access", "no-mutation", "persistence", "delivery"];
}

function compositeContracts({ receipt, policy, rubric, identities, projectVerifierDigest }) {
  const selectedPolicy = { ...policy, projectVerifierDigest }, facts = compositeFacts(policy.profile, rubric, selectedPolicy),
    specifications = facts.map(({ id: _id, ...specification }) => specification),
    structured = { id: rubric.producerId, digest: rubric.producerDigest,
      kinds: [...new Set(facts.filter(fact => fact.producerId === rubric.producerId).map(fact => fact.kind))],
      ruleDigests: [...new Set(facts.filter(fact => fact.producerId === rubric.producerId).map(fact => fact.ruleDigest))] },
    nativeFacts = facts.filter(fact => fact.producerId === NATIVE_PRODUCER_ID),
    native = { id: NATIVE_PRODUCER_ID, digest: sha(NATIVE_PRODUCER_ID),
      kinds: [...new Set(nativeFacts.map(fact => fact.kind))], ruleDigests: [...new Set(nativeFacts.map(fact => fact.ruleDigest))] },
    declarations = {
      criteria: receipt.criteria.map(item => ({ id: item.criterionId, text: item.criterionText, hash: item.criterionHash })),
      changeMode: receipt.changeMode, requiresOutput: true, producers: [structured, native],
      factSpecifications: specifications, codePlans: [],
      materials: policy.materials.map(item => ({ id: item.id, byteLength: item.mode === "protected" ? 0 : 65536 })),
      authoredCaseCount: 0
    }, declarationsText = JSON.stringify(declarations), materialBindings = policy.materials.map(item => ({
      id: item.id, mode: item.mode, relativePath: item.relativePath, sha256: item.sha256
    }));
  return receipt.criteria.map((criterion, criterionIndex) => {
    const publicContract = { route: "composite", compositeContractVersion: "composite-criterion-v1",
      criterionIndex, criterionId: criterion.criterionId, criterionText: criterion.criterionText,
      criterionHash: criterion.criterionHash, facts,
      coverage: [{ id: "whole-criterion", startByte: 0, endByte: Buffer.byteLength(criterion.criterionText),
        textHash: sha(criterion.criterionText), roles: compositeRoles(policy.profile), requiredFactIds: facts.map(fact => fact.id) }] };
    return { route: "composite", criterionId: criterion.criterionId, criterionHash: criterion.criterionHash,
      maxAttempts: 2, planContext: { version: "composite-plan-context-v1",
        contractText: JSON.stringify(publicContract), declarationsText,
        identity: identities, materialBindings } };
  });
}

function codeContracts(receipt, authored) {
  return receipt.criteria.map(criterion => ({ route: "code", criterionId: criterion.criterionId,
    criterionHash: criterion.criterionHash, sourcePath: authored.sourcePath, exportName: authored.exportName,
    maxAttempts: 2, checks: authored.checks,
    ...(authored.modulePaths?.length ? { modulePaths: authored.modulePaths } : {}) }));
}

export function buildRegisteredPlanDrafts({ assetRoot, suiteRoot = DEFAULT_SUITE_ROOT,
  suiteDigest, configDigest, armDigest } = {}) {
  if (![suiteDigest, configDigest, armDigest].every(value => HASH.test(value))) {
    throw new TypeError("Registered plan identities must be SHA-256 digests");
  }
  const canonicalAssetRoot = fs.realpathSync.native(assetRoot), canonicalSuiteRoot = fs.realpathSync.native(suiteRoot);
  if (canonicalAssetRoot !== assetRoot || canonicalSuiteRoot !== suiteRoot) throw new Error("Registered plan roots must be canonical");
  const suite = stableJson(path.join(canonicalSuiteRoot, "suite.json"), 2 * 1024 * 1024, "suite"),
    catalog = stableJson(path.join(canonicalAssetRoot, "catalog.json"), 2 * 1024 * 1024, "catalog"),
    nodeAsset = stableJson(path.join(canonicalAssetRoot, "measurement", "node-workload-api-v1.json"), 2 * 1024 * 1024, "node profile"),
    rubrics = stableJson(path.join(canonicalAssetRoot, "measurement", "assurance-rubrics.json"), 2 * 1024 * 1024, "rubrics"),
    sharedPolicy = stableJson(path.join(canonicalAssetRoot, "measurement", "shared-tool-policy-v1.json"), 2 * 1024 * 1024, "shared policy"),
    families = stableJson(path.join(INSTALLED_ROOT, "adapters", "node-typescript", "contract-families.json"), 2 * 1024 * 1024, "contract families"),
    profile = stableJson(path.join(INSTALLED_ROOT, "adapters", "node-typescript", "profile.json"), 2 * 1024 * 1024, "installed profile"),
    basePolicy = stableJson(path.join(INSTALLED_ROOT, "packages", "piagent-core", "policies", "base-policy.json"), 2 * 1024 * 1024, "installed policy");
  if (suite.scenarios.length !== 27 || catalog.scenarios.length !== 27 || nodeAsset.workerImage.id !== WORKER_IMAGE
    || JSON.stringify(nodeAsset.profile) !== JSON.stringify(expectedNodeProfile())
    || sharedPolicy.suiteId !== catalog.suiteId || rubrics.suite !== catalog.suiteId) {
    throw new Error("Registered public plan inventory mismatch");
  }
  const noncode = new Set(nodeAsset.publicCoverage.noncodeScenarioIds), rubricByScenario = new Map(
    rubrics.rubrics.map(item => [path.basename(item.prompt.path, ".md"), item])), policyByScenario = new Map(
    sharedPolicy.profiles.map(item => [item.scenarioId, item]));
  const plans = suite.scenarios.map((scenario, index) => {
    const selected = selectedInput({ scenario, catalogEntry: catalog.scenarios[index], assetRoot: canonicalAssetRoot,
      suiteRoot: canonicalSuiteRoot }), receipt = benchmarkVerificationReceiptForTurn(selected, { profile, policy: basePolicy }),
      identities = { suiteDigest, configDigest, armDigest }, policy = policyByScenario.get(scenario.id),
      contracts = noncode.has(scenario.id)
        ? compositeContracts({ receipt, policy, rubric: rubricByScenario.get(scenario.id), identities,
          projectVerifierDigest: sharedPolicy.projectVerifier.expectedPlanDigest })
        : codeContracts(receipt, codeRecipe(scenario.id, families)),
      plan = { schemaVersion: 3, operatorRequestDigest: benchmarkVerificationRequestDigest(selected),
        backend: { imageId: WORKER_IMAGE, dockerSocket: "/var/run/docker.sock", timeoutMs: 10000,
          profile: expectedNodeProfile() }, contracts };
    validateHostContractPlan(plan);
    return Object.freeze({ scenarioId: scenario.id, route: noncode.has(scenario.id) ? "composite" : "code",
      criterionCount: receipt.criteria.length,
      caseCount: contracts[0].route === "code"
        ? contracts[0].checks.reduce((total, check) => total + check.cases.length, 0) : 0,
      plan: Object.freeze(plan) });
  });
  if (plans.filter(item => item.route === "code").length !== 23
    || plans.filter(item => item.route === "composite").length !== 4) throw new Error("Registered plan route count mismatch");
  return Object.freeze({ version: REGISTERED_PLAN_AUTHOR_VERSION, authority: "none",
    identities: Object.freeze({ suiteDigest, configDigest, armDigest }), plans: Object.freeze(plans) });
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!["--asset-root", "--suite-root", "--suite-digest", "--config-digest", "--arm-digest", "--scenario", "--format"].includes(name)
      || value === undefined || Object.hasOwn(values, name)) throw new TypeError("Invalid registered plan author arguments");
    values[name] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2)), result = buildRegisteredPlanDrafts({
    assetRoot: args["--asset-root"], suiteRoot: args["--suite-root"] ?? DEFAULT_SUITE_ROOT,
    suiteDigest: args["--suite-digest"], configDigest: args["--config-digest"], armDigest: args["--arm-digest"]
  });
  if (args["--format"] === "summary") {
    process.stdout.write(JSON.stringify({ version: result.version, authority: result.authority,
      identities: result.identities, plans: result.plans.map(({ plan: _plan, ...item }) => item) }) + "\n");
  } else {
    const selected = result.plans.find(item => item.scenarioId === args["--scenario"]);
    if (!selected || args["--format"] !== "plan") throw new TypeError("Select one registered plan output");
    process.stdout.write(JSON.stringify(selected.plan) + "\n");
  }
}

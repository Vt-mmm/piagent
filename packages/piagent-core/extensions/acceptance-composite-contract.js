import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { compileIndependentContract } from "./acceptance-independent-contract.js";
import { validateModulePaths } from "./acceptance-executor/module-graph.mjs";

export const COMPOSITE_CONTRACT_VERSION = "composite-criterion-v1";
export const COMPOSITE_CODE_PLAN_VERSION = "composite-code-child-plan-v1";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_BYTES = 1024 * 1024;
const SOURCE_PATH = /^(?!\/)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)(?:\.{1,2}|\.git|\.pi|node_modules)(?:\/|$))[^\\\0-\x1f\x7f:%?#]+$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const FACT_KEYS = ["kind", "specDigest", "producerId", "producerDigest", "ruleDigest", "stage", "parameters"];
const PARAMETERS = {
  "bounded-code-checks": ["codePlanDigest", "backendProfileDigest"],
  "project-verifier-current": ["commandSetDigest"],
  "workspace-scope": ["allowedWriteMaterialIds", "requireCompleteMutationJournal"],
  "context-current": ["requiredMaterialIds", "delivery"],
  "tool-policy-complete": ["profileDigest", "requireExclusiveMediation"],
  "structured-log-claims": ["logMaterialId", "responseFormat", "correlation"],
  "config-document-literals": ["configMaterialId", "documentMaterialId", "format", "requiredFields"],
  "policy-refusal-output": ["rule", "protectedMaterialId", "expectedDisposition", "responseFormat", "nativeTemplateSetDigest"],
  "response-persisted": ["expectedOrigins", "requireExactBytes"],
  "terminal-delivery": ["boundary", "requireExactOperation"]
};
const ROLES = {
  behavior: ["bounded-code-checks"], interface: ["bounded-code-checks"], "input-validation": ["bounded-code-checks"],
  verification: ["project-verifier-current"], "no-mutation": ["workspace-scope", "tool-policy-complete"],
  "path-scope": ["workspace-scope", "tool-policy-complete"], "read-context": ["context-current"],
  diagnosis: ["structured-log-claims", "context-current"], "document-literals": ["config-document-literals", "context-current"],
  refusal: ["policy-refusal-output", "tool-policy-complete"], "no-protected-access": ["tool-policy-complete"],
  persistence: ["response-persisted"], delivery: ["terminal-delivery"]
};

export class ConfigurationError extends Error {
  constructor(reason) { super(`Invalid composite configuration: ${reason}`); this.name = "ConfigurationError"; }
}
const requireThat = (condition, reason) => { if (!condition) throw new ConfigurationError(reason); };
const identifier = value => typeof value === "string" && ID.test(value);
const digest = value => typeof value === "string" && HASH.test(value);
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const text = value => typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= 600;

function shape(value, keys, label) {
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), label);
}

function array(value, minimum, maximum, label, unique = false) {
  requireThat(Array.isArray(value) && value.length >= minimum && value.length <= maximum, label);
  if (unique) requireThat(new Set(value).size === value.length, `${label} duplicates`);
  return value;
}

// Private compile inputs are data, never getters, callbacks or live capabilities.
// These traversal bounds are above every legal shape in this bounded contract.
function snapshot(input) {
  let nodes = 0, bytes = 0;
  const reserve = size => { bytes += size; requireThat(bytes <= MAX_BYTES, "input bytes"); };
  function stringBytes(value) {
    let size = 2;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 34 || code === 92) size += 2;
      else if (code < 32) size += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code < 128) size += 1;
      else if (code < 2048) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { size += 4; index += 1; }
      else size += 3;
      requireThat(size <= MAX_BYTES - bytes, "input bytes");
    }
    return size;
  }
  function copy(value, depth) {
    requireThat(++nodes <= 16384 && depth <= 16, "input nesting/size");
    if (value === null || typeof value === "boolean") { reserve(value === false ? 5 : 4); return value; }
    if (typeof value === "number") {
      requireThat(Number.isFinite(value), "nonfinite number"); reserve(String(value).length); return value;
    }
    if (typeof value === "string") {
      requireThat(value.isWellFormed() && value.length <= MAX_BYTES, "invalid string");
      reserve(stringBytes(value)); return value;
    }
    requireThat(value && typeof value === "object", "non-data input");
    requireThat(!types.isProxy(value), "proxy input");
    const isArray = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    requireThat(isArray ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "input prototype");
    const keys = Reflect.ownKeys(value);
    if (isArray) requireThat(value.length <= 256 && keys.length === value.length + 1, "array properties/size");
    else requireThat(keys.length <= 32, "object size");
    reserve(2 + Math.max(0, (isArray ? value.length : keys.length) - 1));
    const output = isArray ? [] : {};
    for (const key of keys) {
      if (isArray && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireThat(typeof key === "string" && key.isWellFormed() && "value" in descriptor && descriptor.enumerable, "input property");
      if (isArray) requireThat(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length, "array index");
      else reserve(stringBytes(key) + 1);
      Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return output;
  }
  return copy(input, 0);
}

// JSON.parse validates syntax; this local token walk rejects duplicate decoded
// object keys before using the parsed public contract. It is not a general API.
function parseContract(raw) {
  requireThat(typeof raw === "string" && raw.isWellFormed() && Buffer.byteLength(raw) <= MAX_BYTES, "contract bytes");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigurationError("contract JSON syntax"); }
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
      requireThat(!current.keys.has(key), "duplicate JSON key"); current.keys.add(key);
    }
    requireThat(stack.length <= 16, "contract nesting");
  }
  return snapshot(parsed);
}

function idList(value, minimum, maximum, label) {
  array(value, minimum, maximum, label, true);
  requireThat(value.every(identifier), label);
}

function validateFact(fact, withId) {
  shape(fact, withId ? ["id", ...FACT_KEYS] : FACT_KEYS, "fact fields");
  if (withId) requireThat(identifier(fact.id), "fact id");
  requireThat(typeof fact.kind === "string" && Object.hasOwn(PARAMETERS, fact.kind) && identifier(fact.producerId), "fact kind/producer");
  requireThat([fact.specDigest, fact.producerDigest, fact.ruleDigest].every(digest), "fact digests");
  const settlement = ["response-persisted", "terminal-delivery"].includes(fact.kind);
  requireThat(fact.stage === (settlement ? "settlement" : "content"), "fact stage");
  const p = fact.parameters;
  shape(p, PARAMETERS[fact.kind], "fact parameter fields");
  for (const [key, value] of Object.entries(p)) {
    if (key.endsWith("Digest")) requireThat(digest(value) || key === "nativeTemplateSetDigest" && value === null, "parameter digest");
    if (key.endsWith("MaterialId")) requireThat(identifier(value), "material id");
  }
  if (fact.kind === "workspace-scope") {
    idList(p.allowedWriteMaterialIds, 0, 32, "write materials");
    requireThat(p.requireCompleteMutationJournal === true, "complete mutation journal required");
  } else if (fact.kind === "context-current") {
    idList(p.requiredMaterialIds, 1, 32, "context materials");
    requireThat(p.delivery === "actual-tool-result-or-prompt", "context delivery");
  } else if (fact.kind === "tool-policy-complete") {
    requireThat(p.requireExclusiveMediation === true, "exclusive mediation required");
  } else if (fact.kind === "structured-log-claims") {
    requireThat(p.responseFormat === "incident-claims-v1" && p.correlation === "unique-worker-link-within-60s", "log rule");
  } else if (fact.kind === "config-document-literals") {
    requireThat(p.format === "config-literals-v1" && isDeepStrictEqual(p.requiredFields, ["service", "restartCommand"]), "document rule");
  } else if (fact.kind === "policy-refusal-output") {
    requireThat(["protected-env", "destructive-history"].includes(p.rule)
      && p.expectedDisposition === "deny" && p.responseFormat === "refusal-v1", "refusal rule");
  } else if (fact.kind === "response-persisted") {
    array(p.expectedOrigins, 1, 2, "response origins", true);
    requireThat(p.expectedOrigins.every(value => ["assistant", "native-policy"].includes(value)) && p.requireExactBytes === true, "response rule");
  } else if (fact.kind === "terminal-delivery") {
    requireThat(["cli-final-output-durable", "webui-operation-confirmed"].includes(p.boundary)
      && p.requireExactOperation === true, "terminal rule");
  }
}

function indexed(values, key, label) {
  const result = new Map();
  for (const value of values) {
    requireThat(value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key), `${label} record`);
    requireThat(!result.has(value[key]), `${label} duplicate`); result.set(value[key], value);
  }
  return result;
}

function codePlanDefinition(input) {
  shape(input, ["sourcePath", "modulePaths", "exportName", "checks", "profile"], "code plan definition fields");
  requireThat(typeof input.sourcePath === "string" && input.sourcePath.length <= 1024 && SOURCE_PATH.test(input.sourcePath), "code source path");
  array(input.modulePaths, 0, 31, "code module paths", true);
  try { validateModulePaths(input.sourcePath, input.modulePaths); }
  catch { throw new ConfigurationError("code source graph"); }
  let compiled;
  try {
    compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 2, profile: input.profile,
      source: "export const placeholder = 0;", exportName: input.exportName, checks: input.checks }));
  } catch { throw new ConfigurationError("code plan v2 definition"); }
  const definition = { version: COMPOSITE_CODE_PLAN_VERSION, sourcePath: input.sourcePath,
    modulePaths: input.modulePaths, exportName: input.exportName, checks: compiled.plan.checks, profile: compiled.plan.profile };
  const caseCount = compiled.plan.checks.reduce((total, check) => total + check.cases.length, 0);
  return { definition, digest: hash(JSON.stringify(definition)), backendProfileDigest: compiled.plan.profile.digest, caseCount };
}

/** Digest only a complete immutable host-owned code-child definition. */
export function compositeCodePlanDigest(input) {
  return codePlanDefinition(snapshot(input)).digest;
}

function declarations(input) {
  const context = snapshot(input);
  shape(context, ["criteria", "changeMode", "requiresOutput", "producers", "factSpecifications", "codePlans", "materials", "authoredCaseCount"], "context fields");
  requireThat(["source-change", "read-only"].includes(context.changeMode) && typeof context.requiresOutput === "boolean", "task requirements");
  array(context.criteria, 1, 12, "current criteria");
  for (const criterion of context.criteria) {
    shape(criterion, ["id", "text", "hash"], "current criterion fields");
    requireThat(identifier(criterion.id) && text(criterion.text) && digest(criterion.hash)
      && hash(criterion.text) === criterion.hash, "current criterion identity");
  }
  indexed(context.criteria, "id", "current criterion");
  array(context.producers, 1, 16, "producers");
  for (const producer of context.producers) {
    shape(producer, ["id", "digest", "kinds", "ruleDigests"], "producer fields");
    requireThat(identifier(producer.id) && digest(producer.digest), "producer identity");
    array(producer.kinds, 1, 10, "producer kinds", true);
    array(producer.ruleDigests, 1, 16, "producer rules", true);
    requireThat(producer.kinds.every(kind => typeof kind === "string" && Object.hasOwn(PARAMETERS, kind))
      && producer.ruleDigests.every(digest), "producer kinds/rules");
  }
  const producers = indexed(context.producers, "id", "producer");
  array(context.materials, 0, 32, "materials");
  for (const material of context.materials) {
    shape(material, ["id", "byteLength"], "material fields");
    requireThat(identifier(material.id) && integer(material.byteLength, 0, 65536), "material identity/size");
  }
  requireThat(context.materials.reduce((total, item) => total + item.byteLength, 0) <= MAX_BYTES, "material total");
  const materials = indexed(context.materials, "id", "material");
  array(context.codePlans, 0, 16, "code plans");
  const compiledCodePlans = context.codePlans.map(plan => {
    shape(plan, ["digest", "backendProfileDigest", "caseCount", "sourcePath", "modulePaths", "exportName", "checks", "profile"], "code declaration fields");
    const { digest: expectedDigest, backendProfileDigest, caseCount } = codePlanDefinition({ sourcePath: plan.sourcePath,
      modulePaths: plan.modulePaths, exportName: plan.exportName, checks: plan.checks, profile: plan.profile });
    requireThat(plan.digest === expectedDigest && plan.backendProfileDigest === backendProfileDigest
      && plan.caseCount === caseCount && integer(caseCount, 1, 256), "code declaration identity/count");
    return plan;
  });
  const codePlans = indexed(compiledCodePlans, "digest", "code plan");
  array(context.factSpecifications, 1, 16, "plan fact specifications");
  for (const spec of context.factSpecifications) {
    validateFact(spec, false);
    const producer = producers.get(spec.producerId);
    requireThat(producer && producer.digest === spec.producerDigest && producer.kinds.includes(spec.kind)
      && producer.ruleDigests.includes(spec.ruleDigest), "unlisted producer/rule");
    for (const [key, value] of Object.entries(spec.parameters)) {
      const ids = key.endsWith("MaterialId") ? [value] : key.endsWith("MaterialIds") ? value : [];
      requireThat(ids.every(id => materials.has(id)), "unlisted material");
    }
  }
  const specifications = indexed(context.factSpecifications, "specDigest", "fact specification");
  requireThat(integer(context.authoredCaseCount, 0, 6912), "catalog code-case cap");
  return { context, specifications, codePlans };
}

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/**
 * Pure structural canary for the DA2 public contract. The context contains closed
 * host declaration snapshots, NOT authenticated producers, code plans or facts.
 * In particular, declared case counts do not certify source-closed v2 execution.
 * No runtime calls this module; its result is not an assessment or capability.
 */
export function compileCompositeContract(contractText, inputContext) {
  const contract = parseContract(contractText);
  shape(contract, ["route", "compositeContractVersion", "criterionIndex", "criterionId", "criterionText", "criterionHash", "coverage", "facts"], "contract fields");
  requireThat(contract.route === "composite" && contract.compositeContractVersion === COMPOSITE_CONTRACT_VERSION, "contract version");
  requireThat(integer(contract.criterionIndex, 0, 11) && identifier(contract.criterionId)
    && text(contract.criterionText) && digest(contract.criterionHash)
    && hash(contract.criterionText) === contract.criterionHash, "contract criterion identity");
  array(contract.facts, 1, 16, "criterion facts");
  contract.facts.forEach(fact => validateFact(fact, true));
  const facts = indexed(contract.facts, "id", "fact");
  const { context, specifications, codePlans } = declarations(inputContext);
  let caseCount = 0;
  for (const fact of contract.facts) {
    const { id: _id, ...specification } = fact;
    requireThat(isDeepStrictEqual(specifications.get(fact.specDigest), specification), "unlisted or changed fact specification");
    if (fact.kind === "bounded-code-checks") {
      const code = codePlans.get(fact.parameters.codePlanDigest);
      requireThat(code && code.backendProfileDigest === fact.parameters.backendProfileDigest, "unlisted code/backend profile");
      caseCount += code.caseCount;
    }
  }
  requireThat(caseCount <= 256 && caseCount <= context.authoredCaseCount, "aggregate code-case cap");
  array(contract.coverage, 1, 32, "coverage spans");
  indexed(contract.coverage, "id", "clause");
  const bytes = Buffer.from(contract.criterionText), boundaries = new Set([0]);
  let endpoint = 0;
  for (const point of contract.criterionText) { endpoint += Buffer.byteLength(point); boundaries.add(endpoint); }
  const used = new Set(), roles = new Set();
  endpoint = 0;
  for (const clause of contract.coverage) {
    shape(clause, ["id", "startByte", "endByte", "textHash", "roles", "requiredFactIds"], "clause fields");
    requireThat(identifier(clause.id) && integer(clause.startByte, 0, 2400) && integer(clause.endByte, 1, 2400)
      && clause.startByte === endpoint && clause.endByte > endpoint && boundaries.has(clause.endByte), "span partition/boundary");
    requireThat(digest(clause.textHash) && hash(bytes.subarray(clause.startByte, clause.endByte)) === clause.textHash, "span hash");
    array(clause.roles, 1, 13, "clause roles", true);
    requireThat(clause.roles.every(role => typeof role === "string" && Object.hasOwn(ROLES, role)), "unknown role");
    idList(clause.requiredFactIds, 1, 16, "clause required facts");
    requireThat(clause.requiredFactIds.every(id => facts.has(id)), "missing fact reference");
    const kinds = new Set(clause.requiredFactIds.map(id => facts.get(id).kind));
    for (const role of clause.roles) {
      roles.add(role); requireThat(ROLES[role].every(kind => kinds.has(kind)), "role conjunct missing");
    }
    clause.requiredFactIds.forEach(id => used.add(id)); endpoint = clause.endByte;
  }
  requireThat(endpoint === bytes.length && used.size === facts.size, "incomplete coverage or unused fact");
  const kinds = new Set(contract.facts.map(fact => fact.kind));
  const output = context.requiresOutput || ["diagnosis", "document-literals", "refusal", "persistence", "delivery"].some(role => roles.has(role));
  const mutation = context.changeMode === "source-change"
    && (kinds.has("bounded-code-checks") || kinds.has("config-document-literals"));
  if (output) requireThat(kinds.has("response-persisted") && kinds.has("terminal-delivery"), "output settlement facts required");
  if (mutation) requireThat(kinds.has("project-verifier-current") && kinds.has("workspace-scope")
    && kinds.has("tool-policy-complete"), "mutation verification/scope/policy required");
  if (context.changeMode === "read-only" || roles.has("no-mutation")) {
    requireThat(contract.facts.filter(fact => fact.kind === "workspace-scope")
      .every(fact => fact.parameters.allowedWriteMaterialIds.length === 0), "read-only scope permits writes");
  }
  const current = context.criteria[contract.criterionIndex];
  const matched = current && current.id === contract.criterionId && current.text === contract.criterionText && current.hash === contract.criterionHash;
  return freeze({ kind: "composite-coverage-compilation", version: COMPOSITE_CONTRACT_VERSION, authority: "none", contract,
    codePlans: [...codePlans.values()],
    criterionBinding: matched ? "matched" : "unknown", bindingReasons: matched ? [] : ["current-criterion-mismatch"],
    requiredFactIds: [...used], caseCount, requirements: [
      "independently-approved-full-public-obligation-map", "authenticated-current-full-criterion-aggregate",
      "current-source-task-session-request-response-policy-binding", "qualified-producer-and-material-custody",
      "actual-required-fact-observations", ...(caseCount ? ["approved-source-closed-v2-code-definition-and-execution"] : []),
      ...(output ? ["actual-response-persistence-and-terminal-settlement"] : [])
    ] });
}

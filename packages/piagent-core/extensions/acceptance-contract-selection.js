import { createHash } from "node:crypto";
import path from "node:path";
import { compileIndependentContract } from "./acceptance-independent-contract.js";
import { validateModulePaths } from "./acceptance-executor/module-graph.mjs";
import { validateValue } from "./acceptance-executor/values.mjs";

export const CONTRACT_SELECTION_VERSION = "contract-family-selection-v1";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,79}$/;
const PARAMETER = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const EXPORT = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const DOMAINS = new Set(["pure-function", "temporal-input", "configuration-precedence", "stateful-recovery"]);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const identifier = (value) => typeof value === "string" && ID.test(value);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const shape = (value, required, optional = []) => {
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new TypeError("Invalid contract selection shape");
};
function parse(text, maximum) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maximum) throw new TypeError("Contract selection input limit exceeded");
  return JSON.parse(text);
}

// Substitution only replaces complete value nodes, never code or object keys.
// Bound references are copied as data and are never recursively interpreted.
function substitute(template, parameters, resolve = (name) => parameters[name]) {
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 20000 || depth > 32) throw new TypeError("Contract template limit exceeded");
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (!record(value)) return value;
    if (Object.hasOwn(value, "$parameter")) {
      shape(value, ["$parameter"]);
      if (typeof value.$parameter !== "string" || !Object.hasOwn(parameters, value.$parameter)) throw new TypeError("Unknown template parameter");
      return resolve(value.$parameter);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)]));
  };
  return visit(template, 0);
}

export function parseContractFamilyLibrary(text) {
  const library = parse(text, 2 * 1024 * 1024);
  shape(library, ["schemaVersion", "families"]);
  if (library.schemaVersion !== 1 || !Array.isArray(library.families) || library.families.length < 1 || library.families.length > 32) {
    throw new TypeError("Invalid contract family library");
  }
  const identities = new Set();
  for (const family of library.families) {
    shape(family, ["id", "version", "domain", "description", "parameters", "template"]);
    if (!identifier(family.id) || !Number.isSafeInteger(family.version) || family.version < 1 || family.version > 1000000
      || !DOMAINS.has(family.domain) || typeof family.description !== "string" || !family.description.trim() || family.description.length > 2000
      || !record(family.parameters) || Object.keys(family.parameters).length > 32) throw new TypeError("Invalid contract family");
    const identity = `${family.id}@${family.version}`;
    if (identities.has(identity)) throw new TypeError("Ambiguous contract family identity");
    identities.add(identity);
    for (const [name, type] of Object.entries(family.parameters)) {
      if (!PARAMETER.test(name) || !["export", "string", "number", "value"].includes(type)) throw new TypeError("Invalid family parameter definition");
    }
    shape(family.template, ["exportName", "checks"]);
    const used = new Set();
    substitute(family.template, family.parameters, (name) => { used.add(name); return null; });
    if (used.size !== Object.keys(family.parameters).length) throw new TypeError("Unused family parameter");
  }
  return freeze(library);
}

function instantiate(family, parameters) {
  shape(parameters, Object.keys(family.parameters));
  if (Buffer.byteLength(JSON.stringify(parameters)) > 65536) throw new TypeError("Family parameter budget exceeded");
  for (const [name, type] of Object.entries(family.parameters)) {
    const value = parameters[name];
    if (type === "value") validateValue(value);
    else if (type === "number" ? typeof value !== "number" || !Number.isFinite(value)
      : typeof value !== "string" || (type === "export" ? !EXPORT.test(value) : value.length > 128)) {
      throw new TypeError(`Invalid family parameter: ${name}`);
    }
  }
  const expanded = substitute(family.template, parameters);
  const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: "export const placeholder=0;", ...expanded }));
  return { exportName: compiled.plan.exportName, checks: compiled.plan.checks };
}

export function validateContractSelection(selection, criterionHash) {
  shape(selection, ["version", "familyId", "familyVersion", "familyDigest", "parametersDigest", "domain", "criterionText"]);
  if (selection.version !== CONTRACT_SELECTION_VERSION || !identifier(selection.familyId)
    || !Number.isSafeInteger(selection.familyVersion) || selection.familyVersion < 1 || selection.familyVersion > 1000000
    || !HASH.test(selection.familyDigest) || !HASH.test(selection.parametersDigest) || !DOMAINS.has(selection.domain)
    || typeof selection.criterionText !== "string" || !selection.criterionText.trim() || selection.criterionText.length > 4000
    || hash(selection.criterionText) !== criterionHash) throw new TypeError("Contract selection does not bind the criterion");
}

/** Pure preview compiler. It cannot read source, execute a worker or approve anything. */
export function compileContractSelection({ libraryText, taskText, recipeText }) {
  const library = parseContractFamilyLibrary(libraryText), task = parse(taskText, 2 * 1024 * 1024), recipe = parse(recipeText, 512 * 1024);
  shape(recipe, ["schemaVersion", "backend", "selections"]);
  shape(recipe.backend, ["imageId", "dockerSocket", "timeoutMs"]);
  if (typeof recipe.backend.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(recipe.backend.imageId)
    || typeof recipe.backend.dockerSocket !== "string" || !path.isAbsolute(recipe.backend.dockerSocket) || recipe.backend.dockerSocket.includes("\0")
    || !Number.isSafeInteger(recipe.backend.timeoutMs) || recipe.backend.timeoutMs < 25 || recipe.backend.timeoutMs > 30000) throw new TypeError("Invalid selection backend");
  if (recipe.schemaVersion !== 1 || !Array.isArray(recipe.selections) || recipe.selections.length < 1 || recipe.selections.length > 12
    || !record(task) || !/^operator-request-v1:[a-f0-9]{64}$/.test(task.operatorRequestDigest)
    || !Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length < 1 || task.acceptanceCriteria.length > 12
    || !Array.isArray(task.acceptanceReceipt?.criteria) || task.acceptanceReceipt.criteria.length !== task.acceptanceCriteria.length) {
    throw new TypeError("Invalid selection recipe or task criterion snapshot");
  }
  const ids = new Set(), criteria = task.acceptanceReceipt.criteria.map((item, index) => {
    const text = task.acceptanceCriteria[index];
    if (!record(item) || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9:._-]{0,79}$/.test(item.id) || ids.has(item.id) || !identifier(item.obligation)
      || typeof text !== "string" || !text.trim() || text.length > 4000 || hash(text) !== item.hash) throw new TypeError("Unbound task criterion text");
    ids.add(item.id); return { id: item.id, hash: item.hash, obligation: item.obligation, text };
  });
  const contracts = [], selected = [], issues = [], chosen = new Set();
  for (const [index, item] of recipe.selections.entries()) {
    shape(item, ["criterion", "family", "parameters", "sourcePath", "maxAttempts"], ["modulePaths"]);
    shape(item.criterion, ["text", "obligation"]); shape(item.family, ["id", "version"], ["digest"]);
    if (typeof item.criterion.text !== "string" || !item.criterion.text.trim() || item.criterion.text.length > 4000
      || !identifier(item.criterion.obligation) || !identifier(item.family.id) || !Number.isSafeInteger(item.family.version) || item.family.version < 1 || item.family.version > 1000000
      || Object.hasOwn(item.family, "digest") && !HASH.test(item.family.digest)
      || !Number.isInteger(item.maxAttempts) || item.maxAttempts < 1 || item.maxAttempts > 8) throw new TypeError("Invalid criterion selection");
    validateModulePaths(item.sourcePath, Object.hasOwn(item, "modulePaths") ? item.modulePaths : []);
    const matches = criteria.filter((criterion) => criterion.text === item.criterion.text && criterion.obligation === item.criterion.obligation);
    const family = library.families.find((candidate) => candidate.id === item.family.id && candidate.version === item.family.version);
    const familyDigest = family && hash(JSON.stringify(family));
    let reason = matches.length !== 1 ? matches.length ? "criterion-ambiguous" : "criterion-not-found"
      : chosen.has(matches[0].id) ? "criterion-selected-twice" : !family ? "family-not-found"
        : item.family.digest && item.family.digest !== familyDigest ? "family-drift" : undefined;
    if (reason) { issues.push({ selectionIndex: index, reason }); continue; }
    const criterion = matches[0], expanded = instantiate(family, item.parameters);
    chosen.add(criterion.id);
    const selection = { version: CONTRACT_SELECTION_VERSION, familyId: family.id, familyVersion: family.version, familyDigest,
      parametersDigest: hash(JSON.stringify(item.parameters)), domain: family.domain, criterionText: criterion.text };
    validateContractSelection(selection, criterion.hash);
    contracts.push({ criterionId: criterion.id, criterionHash: criterion.hash, sourcePath: item.sourcePath,
      ...(Object.hasOwn(item, "modulePaths") ? { modulePaths: item.modulePaths } : {}), maxAttempts: item.maxAttempts, ...expanded, selection });
    selected.push({ ...criterion, familyId: family.id, familyVersion: family.version, familyDigest, domain: family.domain,
      description: family.description, parameters: item.parameters, caseCount: expanded.checks.reduce((count, check) => count + check.cases.length, 0) });
  }
  return freeze({ status: issues.length ? "unknown" : "preview-only", completionAllowed: false, issues, selected,
    unselectedCriteria: criteria.filter((criterion) => !chosen.has(criterion.id)),
    plan: issues.length ? null : { schemaVersion: 1, operatorRequestDigest: task.operatorRequestDigest, backend: recipe.backend, contracts } });
}

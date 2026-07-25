import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { containsSensitiveText } from "../security/sensitive-data.js";

const API_VERSION = "piagent/v1";
const CORE_API_VERSION = 1;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const PACK_KINDS = new Set(["prompts", "skills", "subagents", "policies", "adapters", "recipes", "evals"]);
const LIFECYCLES = new Set(["experimental", "stable", "deprecated"]);
const ACTIVATION_MODES = new Set(["explicit", "profile", "trigger"]);
const STEP_MODES = new Set(["read-only", "workspace-write", "action-proposal"]);
const ACTION_TYPES = new Set([
  "git-push",
  "github-pull-request",
  "github-issue",
  "release",
  "publish",
  "deploy",
  "database-change",
  "external-provider-write"
]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DOMAIN_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ACTION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class CapabilityValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "CapabilityValidationError";
    this.errors = errors;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pushError(errors, location, message) {
  errors.push(`${location}: ${message}`);
}

function compareCodePoints(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function parseStrictUtcTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_PATTERN.test(value)) return Number.NaN;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return Number.NaN;
  return timestamp;
}

function rejectUnknownKeys(value, allowed, location, errors) {
  if (!isPlainObject(value)) {
    pushError(errors, location, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) pushError(errors, `${location}.${key}`, "is not supported");
  }
  return true;
}

function rejectUnsafeKeys(value, location, errors, depth = 0) {
  if (depth > 32) {
    pushError(errors, location, "exceeds the maximum nesting depth");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeKeys(item, `${location}[${index}]`, errors, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      pushError(errors, `${location}.${key}`, "is not allowed");
    }
    rejectUnsafeKeys(item, `${location}.${key}`, errors, depth + 1);
  }
}

function validateString(value, location, errors, options = {}) {
  const { min = 1, max = 256, pattern } = options;
  if (typeof value !== "string") {
    pushError(errors, location, "must be a string");
    return false;
  }
  if (value.length < min || value.length > max) {
    pushError(errors, location, `length must be between ${min} and ${max}`);
    return false;
  }
  if (/\0|[\r\n]/.test(value)) {
    pushError(errors, location, "must not contain control line characters");
    return false;
  }
  if (pattern && !pattern.test(value)) {
    pushError(errors, location, "has an invalid format");
    return false;
  }
  return true;
}

function validateStringArray(value, location, errors, options = {}) {
  const { maxItems = 64, pattern, allowEmpty = true } = options;
  if (!Array.isArray(value)) {
    pushError(errors, location, "must be an array");
    return [];
  }
  if ((!allowEmpty && value.length === 0) || value.length > maxItems) {
    pushError(errors, location, `must contain ${allowEmpty ? "0" : "1"} to ${maxItems} items`);
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (validateString(item, `${location}[${index}]`, errors, { max: 256, pattern })) {
      if (seen.has(item)) pushError(errors, `${location}[${index}]`, "must be unique");
      seen.add(item);
    }
  });
  return value;
}

function validateMetadata(value, location, errors) {
  if (!rejectUnknownKeys(value, new Set(["name", "version", "owner", "lifecycle", "license", "description", "tags"]), location, errors)) return;
  validateString(value.name, `${location}.name`, errors, { max: 64, pattern: NAME_PATTERN });
  validateString(value.version, `${location}.version`, errors, { max: 64, pattern: VERSION_PATTERN });
  validateString(value.owner, `${location}.owner`, errors, { max: 100, pattern: NAME_PATTERN });
  if (!LIFECYCLES.has(value.lifecycle)) pushError(errors, `${location}.lifecycle`, "must be experimental, stable, or deprecated");
  validateString(value.license, `${location}.license`, errors, { max: 64 });
  validateString(value.description, `${location}.description`, errors, { max: 240 });
  if (!Object.hasOwn(value, "tags")) pushError(errors, `${location}.tags`, "is required");
  else validateStringArray(value.tags, `${location}.tags`, errors, { maxItems: 32, pattern: NAME_PATTERN });
}

function isSafeRelativePath(value, { allowGlob = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  if (!allowGlob && /[*?\[\]{}]/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validatePathArray(value, location, errors) {
  const paths = validateStringArray(value, location, errors, { maxItems: 128 });
  paths.forEach((item, index) => {
    if (!isSafeRelativePath(item, { allowGlob: true })) pushError(errors, `${location}[${index}]`, "must be a repository-relative path pattern");
  });
  return paths;
}

function validateArtifactList(value, location, errors) {
  if (!Array.isArray(value)) {
    pushError(errors, location, "must be an array");
    return;
  }
  if (value.length > 128) pushError(errors, location, "must contain at most 128 artifacts");
  const ids = new Set();
  value.forEach((artifact, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!rejectUnknownKeys(artifact, new Set(["id", "path"]), itemLocation, errors)) return;
    if (validateString(artifact.id, `${itemLocation}.id`, errors, { max: 128, pattern: IDENTIFIER_PATTERN })) {
      if (ids.has(artifact.id)) pushError(errors, `${itemLocation}.id`, "must be unique within its artifact type");
      ids.add(artifact.id);
    }
    if (!isSafeRelativePath(artifact.path)) pushError(errors, `${itemLocation}.path`, "must be a repository-relative file path");
  });
}

export function validateCapabilityPack(document, options = {}) {
  const source = options.source ?? "capability pack";
  const errors = [];
  rejectUnsafeKeys(document, source, errors);
  if (!rejectUnknownKeys(document, new Set(["apiVersion", "kind", "metadata", "spec"]), source, errors)) {
    throw new CapabilityValidationError(`${source} is invalid`, errors);
  }
  if (document.apiVersion !== API_VERSION) pushError(errors, `${source}.apiVersion`, `must be ${API_VERSION}`);
  if (document.kind !== "CapabilityPack") pushError(errors, `${source}.kind`, "must be CapabilityPack");
  validateMetadata(document.metadata, `${source}.metadata`, errors);

  const spec = document.spec;
  if (rejectUnknownKeys(spec, new Set(["coreApiVersion", "requires", "provides", "permissions", "activation", "verification"]), `${source}.spec`, errors)) {
    if (spec.coreApiVersion !== CORE_API_VERSION) pushError(errors, `${source}.spec.coreApiVersion`, `must be ${CORE_API_VERSION}`);

    if (rejectUnknownKeys(spec.requires, new Set(["packs"]), `${source}.spec.requires`, errors)) {
      const dependencies = spec.requires.packs;
      if (!Array.isArray(dependencies)) {
        pushError(errors, `${source}.spec.requires.packs`, "must be an array");
      } else {
        if (dependencies.length > 64) pushError(errors, `${source}.spec.requires.packs`, "must contain at most 64 items");
        const seen = new Set();
        dependencies.forEach((dependency, index) => {
          const location = `${source}.spec.requires.packs[${index}]`;
          if (!rejectUnknownKeys(dependency, new Set(["name", "version"]), location, errors)) return;
          validateString(dependency.name, `${location}.name`, errors, { max: 64, pattern: NAME_PATTERN });
          validateString(dependency.version, `${location}.version`, errors, { max: 64, pattern: VERSION_PATTERN });
          const key = `${dependency.name}@${dependency.version}`;
          if (seen.has(key)) pushError(errors, location, "must be unique");
          seen.add(key);
        });
      }
    }

    if (isPlainObject(spec.provides)) {
      for (const key of Object.keys(spec.provides)) {
        if (!PACK_KINDS.has(key)) pushError(errors, `${source}.spec.provides.${key}`, "is not a supported artifact type");
      }
      for (const key of PACK_KINDS) {
        if (!Object.hasOwn(spec.provides, key)) pushError(errors, `${source}.spec.provides.${key}`, "is required");
        else validateArtifactList(spec.provides[key], `${source}.spec.provides.${key}`, errors);
      }
    } else {
      pushError(errors, `${source}.spec.provides`, "must be an object");
    }

    if (rejectUnknownKeys(spec.permissions, new Set(["capabilities", "filesystemRead", "filesystemWrite", "networkDomains", "externalActions"]), `${source}.spec.permissions`, errors)) {
      validateStringArray(spec.permissions.capabilities, `${source}.spec.permissions.capabilities`, errors, { maxItems: 64, pattern: NAME_PATTERN });
      validatePathArray(spec.permissions.filesystemRead, `${source}.spec.permissions.filesystemRead`, errors);
      validatePathArray(spec.permissions.filesystemWrite, `${source}.spec.permissions.filesystemWrite`, errors);
      validateStringArray(spec.permissions.networkDomains, `${source}.spec.permissions.networkDomains`, errors, { maxItems: 64, pattern: DOMAIN_PATTERN });
      const actions = validateStringArray(spec.permissions.externalActions, `${source}.spec.permissions.externalActions`, errors, { maxItems: 32 });
      actions.forEach((action, index) => {
        if (!ACTION_TYPES.has(action)) pushError(errors, `${source}.spec.permissions.externalActions[${index}]`, "is not a supported action type");
      });
    }

    if (rejectUnknownKeys(spec.activation, new Set(["mode", "profiles", "triggers"]), `${source}.spec.activation`, errors)) {
      if (!ACTIVATION_MODES.has(spec.activation.mode)) pushError(errors, `${source}.spec.activation.mode`, "must be explicit, profile, or trigger");
      validateStringArray(spec.activation.profiles ?? [], `${source}.spec.activation.profiles`, errors, { maxItems: 64, pattern: NAME_PATTERN });
      const triggers = validateStringArray(spec.activation.triggers ?? [], `${source}.spec.activation.triggers`, errors, { maxItems: 64 });
      if (spec.activation.mode === "trigger" && triggers.length === 0) pushError(errors, `${source}.spec.activation.triggers`, "must not be empty for trigger activation");
    }

    if (rejectUnknownKeys(spec.verification, new Set(["evalScenarios"]), `${source}.spec.verification`, errors)) {
      validateStringArray(spec.verification.evalScenarios, `${source}.spec.verification.evalScenarios`, errors, { maxItems: 64, pattern: IDENTIFIER_PATTERN });
    }
  }

  if (errors.length > 0) throw new CapabilityValidationError(`${source} is invalid`, errors);
  return document;
}

export function validateCapabilityRecipe(document, options = {}) {
  const source = options.source ?? "capability recipe";
  const errors = [];
  rejectUnsafeKeys(document, source, errors);
  if (!rejectUnknownKeys(document, new Set(["apiVersion", "kind", "metadata", "spec"]), source, errors)) throw new CapabilityValidationError(`${source} is invalid`, errors);
  if (document.apiVersion !== API_VERSION) pushError(errors, `${source}.apiVersion`, `must be ${API_VERSION}`);
  if (document.kind !== "CapabilityRecipe") pushError(errors, `${source}.kind`, "must be CapabilityRecipe");
  validateMetadata(document.metadata, `${source}.metadata`, errors);
  const spec = document.spec;
  if (rejectUnknownKeys(spec, new Set(["inputs", "steps", "gates"]), `${source}.spec`, errors)) {
    if (!Array.isArray(spec.inputs)) pushError(errors, `${source}.spec.inputs`, "must be an array");
    else {
      if (spec.inputs.length > 32) pushError(errors, `${source}.spec.inputs`, "must contain at most 32 items");
      spec.inputs.forEach((input, index) => {
      const location = `${source}.spec.inputs[${index}]`;
      if (!rejectUnknownKeys(input, new Set(["name", "description", "required"]), location, errors)) return;
      validateString(input.name, `${location}.name`, errors, { max: 64, pattern: NAME_PATTERN });
      validateString(input.description, `${location}.description`, errors, { max: 240 });
      if (typeof input.required !== "boolean") pushError(errors, `${location}.required`, "must be a boolean");
      });
    }

    const stepIds = new Set();
    const stepDependencies = new Map();
    if (!Array.isArray(spec.steps) || spec.steps.length === 0 || spec.steps.length > 64) {
      pushError(errors, `${source}.spec.steps`, "must contain 1 to 64 steps");
    } else spec.steps.forEach((step, index) => {
      const location = `${source}.spec.steps[${index}]`;
      if (!rejectUnknownKeys(step, new Set(["id", "uses", "mode", "needs", "timeoutSeconds", "retries", "outputs"]), location, errors)) return;
      if (validateString(step.id, `${location}.id`, errors, { max: 64, pattern: NAME_PATTERN })) {
        if (stepIds.has(step.id)) pushError(errors, `${location}.id`, "must be unique");
        stepIds.add(step.id);
      }
      validateString(step.uses, `${location}.uses`, errors, { max: 128, pattern: /^(?:capability|recipe):[a-z0-9][a-z0-9._/-]{0,111}$/ });
      if (!STEP_MODES.has(step.mode)) pushError(errors, `${location}.mode`, "must be read-only, workspace-write, or action-proposal");
      const needs = validateStringArray(step.needs ?? [], `${location}.needs`, errors, { maxItems: 32, pattern: NAME_PATTERN });
      stepDependencies.set(step.id, needs);
      if (!Number.isInteger(step.timeoutSeconds) || step.timeoutSeconds < 1 || step.timeoutSeconds > 3600) pushError(errors, `${location}.timeoutSeconds`, "must be an integer between 1 and 3600");
      if (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > 3) pushError(errors, `${location}.retries`, "must be an integer between 0 and 3");
      validateStringArray(step.outputs ?? [], `${location}.outputs`, errors, { maxItems: 32, pattern: IDENTIFIER_PATTERN });
    });

    for (const [stepId, dependencies] of stepDependencies) {
      for (const dependency of dependencies) if (!stepIds.has(dependency)) pushError(errors, `${source}.spec.steps.${stepId}.needs`, `unknown step ${dependency}`);
    }
    detectDirectedCycle(stepDependencies, `${source}.spec.steps`, errors);

    if (rejectUnknownKeys(spec.gates, new Set(["context", "verification", "humanApproval"]), `${source}.spec.gates`, errors)) {
      for (const key of ["context", "verification", "humanApproval"]) {
        if (typeof spec.gates[key] !== "boolean") pushError(errors, `${source}.spec.gates.${key}`, "must be a boolean");
      }
      if (spec.steps?.some((step) => step.mode === "workspace-write") && spec.gates.verification !== true) pushError(errors, `${source}.spec.gates.verification`, "must be true for workspace-write steps");
      if (spec.steps?.some((step) => step.mode === "action-proposal") && spec.gates.humanApproval !== true) pushError(errors, `${source}.spec.gates.humanApproval`, "must be true for action-proposal steps");
    }
  }
  if (errors.length > 0) throw new CapabilityValidationError(`${source} is invalid`, errors);
  return document;
}

export function validateEvalScenario(document, options = {}) {
  const source = options.source ?? "eval scenario";
  const errors = [];
  rejectUnsafeKeys(document, source, errors);
  if (!rejectUnknownKeys(document, new Set(["apiVersion", "kind", "metadata", "spec"]), source, errors)) throw new CapabilityValidationError(`${source} is invalid`, errors);
  if (document.apiVersion !== API_VERSION) pushError(errors, `${source}.apiVersion`, `must be ${API_VERSION}`);
  if (document.kind !== "EvalScenario") pushError(errors, `${source}.kind`, "must be EvalScenario");
  validateMetadata(document.metadata, `${source}.metadata`, errors);
  const spec = document.spec;
  if (rejectUnknownKeys(spec, new Set(["fixture", "profile", "task", "expected", "budget"]), `${source}.spec`, errors)) {
    if (rejectUnknownKeys(spec.fixture, new Set(["path", "digest"]), `${source}.spec.fixture`, errors)) {
      if (!isSafeRelativePath(spec.fixture.path)) pushError(errors, `${source}.spec.fixture.path`, "must be a repository-relative path");
      if (spec.fixture.digest !== undefined && !SHA256_PATTERN.test(spec.fixture.digest)) pushError(errors, `${source}.spec.fixture.digest`, "must be a sha256 digest");
    }
    if (!isSafeRelativePath(spec.profile)) pushError(errors, `${source}.spec.profile`, "must be a repository-relative path");
    validateString(spec.task, `${source}.spec.task`, errors, { max: 8000 });
    if (rejectUnknownKeys(spec.expected, new Set(["verifyCommands", "forbiddenPaths", "forbiddenActions", "requiredArtifacts"]), `${source}.spec.expected`, errors)) {
      validateStringArray(spec.expected.verifyCommands, `${source}.spec.expected.verifyCommands`, errors, { maxItems: 32 });
      validatePathArray(spec.expected.forbiddenPaths, `${source}.spec.expected.forbiddenPaths`, errors);
      validateStringArray(spec.expected.forbiddenActions, `${source}.spec.expected.forbiddenActions`, errors, { maxItems: 32 });
      validateStringArray(spec.expected.requiredArtifacts, `${source}.spec.expected.requiredArtifacts`, errors, { maxItems: 32, pattern: IDENTIFIER_PATTERN });
    }
    if (rejectUnknownKeys(spec.budget, new Set(["maxDurationSeconds", "maxTokens", "maxToolCalls"]), `${source}.spec.budget`, errors)) {
      for (const [key, min, max] of [["maxDurationSeconds", 1, 86400], ["maxTokens", 1, 2_000_000], ["maxToolCalls", 1, 10_000]]) {
        if (!Number.isInteger(spec.budget[key]) || spec.budget[key] < min || spec.budget[key] > max) pushError(errors, `${source}.spec.budget.${key}`, `must be an integer between ${min} and ${max}`);
      }
    }
  }
  if (errors.length > 0) throw new CapabilityValidationError(`${source} is invalid`, errors);
  return document;
}

export function validateExternalActionProposal(document, options = {}) {
  const source = options.source ?? "external action proposal";
  const errors = [];
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new CapabilityValidationError(`${source} validation options are invalid`, [`${source}.options.now: must be a finite Unix timestamp`]);
  rejectUnsafeKeys(document, source, errors);
  if (!rejectUnknownKeys(document, new Set(["apiVersion", "kind", "metadata", "spec"]), source, errors)) throw new CapabilityValidationError(`${source} is invalid`, errors);
  if (document.apiVersion !== API_VERSION) pushError(errors, `${source}.apiVersion`, `must be ${API_VERSION}`);
  if (document.kind !== "ExternalActionProposal") pushError(errors, `${source}.kind`, "must be ExternalActionProposal");
  if (rejectUnknownKeys(document.metadata, new Set(["name", "createdAt", "expiresAt"]), `${source}.metadata`, errors)) {
    validateString(document.metadata.name, `${source}.metadata.name`, errors, { max: 64, pattern: NAME_PATTERN });
    const createdAt = parseStrictUtcTimestamp(document.metadata.createdAt);
    const expiresAt = parseStrictUtcTimestamp(document.metadata.expiresAt);
    if (!Number.isFinite(createdAt)) pushError(errors, `${source}.metadata.createdAt`, "must be a canonical UTC timestamp with millisecond precision");
    if (!Number.isFinite(expiresAt)) pushError(errors, `${source}.metadata.expiresAt`, "must be a canonical UTC timestamp with millisecond precision");
    if (Number.isFinite(createdAt) && createdAt > now + MAX_CLOCK_SKEW_MS) pushError(errors, `${source}.metadata.createdAt`, "must not be more than five minutes in the future");
    if (Number.isFinite(expiresAt) && expiresAt <= now) pushError(errors, `${source}.metadata.expiresAt`, "must not be expired");
    if (Number.isFinite(createdAt) && Number.isFinite(expiresAt) && (expiresAt <= createdAt || expiresAt - createdAt > MAX_ACTION_LIFETIME_MS)) pushError(errors, `${source}.metadata.expiresAt`, "must be after createdAt and no more than 24 hours later");
  }
  const spec = document.spec;
  if (rejectUnknownKeys(spec, new Set(["actionType", "target", "summary", "riskLane", "requestedPermissions", "artifacts", "dryRun", "security"]), `${source}.spec`, errors)) {
    if (!ACTION_TYPES.has(spec.actionType)) pushError(errors, `${source}.spec.actionType`, "is not supported");
    if (rejectUnknownKeys(spec.target, new Set(["provider", "resource", "environment"]), `${source}.spec.target`, errors)) {
      validateString(spec.target.provider, `${source}.spec.target.provider`, errors, { max: 64, pattern: NAME_PATTERN });
      validateString(spec.target.resource, `${source}.spec.target.resource`, errors, { max: 256 });
      if (spec.target.environment !== undefined) validateString(spec.target.environment, `${source}.spec.target.environment`, errors, { max: 64, pattern: NAME_PATTERN });
      if (typeof spec.target.resource === "string" && /:\/\/[^/@\s]+:[^/@\s]+@/.test(spec.target.resource)) pushError(errors, `${source}.spec.target.resource`, "must not contain embedded credentials");
    }
    validateString(spec.summary, `${source}.spec.summary`, errors, { max: 500 });
    if (spec.riskLane !== "high-risk") pushError(errors, `${source}.spec.riskLane`, "must be high-risk");
    validateStringArray(spec.requestedPermissions, `${source}.spec.requestedPermissions`, errors, { maxItems: 32, pattern: /^[a-z0-9][a-z0-9:-]{0,127}$/ });
    if (!Array.isArray(spec.artifacts) || spec.artifacts.length > 32) pushError(errors, `${source}.spec.artifacts`, "must be an array with at most 32 items");
    else spec.artifacts.forEach((artifact, index) => {
      const location = `${source}.spec.artifacts[${index}]`;
      if (!rejectUnknownKeys(artifact, new Set(["path", "digest", "mediaType", "byteSize"]), location, errors)) return;
      if (!isSafeRelativePath(artifact.path)) pushError(errors, `${location}.path`, "must be a repository-relative file path");
      if (!SHA256_PATTERN.test(artifact.digest)) pushError(errors, `${location}.digest`, "must be a sha256 digest");
      validateString(artifact.mediaType, `${location}.mediaType`, errors, { max: 128, pattern: /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i });
      if (!Number.isInteger(artifact.byteSize) || artifact.byteSize < 0 || artifact.byteSize > 10 * 1024 * 1024) pushError(errors, `${location}.byteSize`, "must be an integer between 0 and 10485760");
    });
    if (spec.dryRun !== true) pushError(errors, `${source}.spec.dryRun`, "must be true");
    if (rejectUnknownKeys(spec.security, new Set(["containsSecrets"]), `${source}.spec.security`, errors) && spec.security.containsSecrets !== false) pushError(errors, `${source}.spec.security.containsSecrets`, "must be false");
  }
  scanForSecrets(document, source, errors);
  if (errors.length > 0) throw new CapabilityValidationError(`${source} is invalid`, errors);
  return document;
}

function scanForSecrets(value, location, errors, depth = 0) {
  if (depth > 32) return;
  if (typeof value === "string") {
    if (containsSensitiveText(value)) pushError(errors, location, "contains secret-like material");
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => scanForSecrets(item, `${location}[${index}]`, errors, depth + 1));
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) scanForSecrets(item, `${location}.${key}`, errors, depth + 1);
}

function detectDirectedCycle(graph, location, errors) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      pushError(errors, location, `dependency cycle detected: ${[...stack.slice(start), node].join(" -> ")}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) if (graph.has(dependency)) visit(dependency);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

export function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function readJsonFile(file, maxBytes = MAX_JSON_BYTES) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new CapabilityValidationError(`${file} must be a regular file`);
  if (stat.size > maxBytes) throw new CapabilityValidationError(`${file} exceeds the ${maxBytes}-byte limit`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CapabilityValidationError(`${file} contains invalid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
}

function resolveRegularFile(root, relativePath, maxBytes = MAX_ARTIFACT_BYTES) {
  if (!isSafeRelativePath(relativePath)) throw new CapabilityValidationError(`${relativePath} must be a repository-relative file path`);
  const rootReal = fs.realpathSync(root);
  const candidate = path.resolve(rootReal, relativePath);
  const relative = path.relative(rootReal, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CapabilityValidationError(`${relativePath} resolves outside the repository`);
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new CapabilityValidationError(`${relativePath} must not traverse a symbolic link`);
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) throw new CapabilityValidationError(`${relativePath} must resolve to a regular file`);
  if (stat.size > maxBytes) throw new CapabilityValidationError(`${relativePath} exceeds the ${maxBytes}-byte limit`);
  return { absolutePath: candidate, byteSize: stat.size };
}

function validateArtifactDocument(kind, file, document) {
  if (kind === "recipes") validateCapabilityRecipe(document, { source: file });
  if (kind === "evals") validateEvalScenario(document, { source: file });
}

function validateEvalResources(root, file, document) {
  const profile = resolveRegularFile(root, document.spec.profile, MAX_JSON_BYTES);
  readJsonFile(profile.absolutePath);
  const fixture = resolveRegularFile(root, document.spec.fixture.path);
  if (document.spec.fixture.digest !== undefined) {
    const actualDigest = sha256(fs.readFileSync(fixture.absolutePath));
    if (actualDigest !== document.spec.fixture.digest) throw new CapabilityValidationError(`${file} fixture digest does not match ${document.spec.fixture.path}`);
  }
}

/**
 * Scan one pack root. Every root — the platform's own and any external source —
 * goes through this same function, so an external tree gets exactly the
 * containment and validation the platform's own packs get.
 */
function scanPackRoot(root, { origin, source, records, keys }) {
  const rootReal = fs.realpathSync(root);
  const packsDirectory = path.join(rootReal, "packs");
  const packsStat = fs.lstatSync(packsDirectory);
  if (packsStat.isSymbolicLink() || !packsStat.isDirectory()) throw new CapabilityValidationError("packs must be a regular directory");
  const entries = fs.readdirSync(packsDirectory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  if (entries.length > 256) throw new CapabilityValidationError("packs must contain at most 256 entries");
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.()) throw new CapabilityValidationError(`packs/${entry.name} must be a regular directory`);
    if (!NAME_PATTERN.test(entry.name)) throw new CapabilityValidationError(`packs/${entry.name} has an invalid directory name`);
    const manifestPath = `packs/${entry.name}/pack.json`;
    const { absolutePath } = resolveRegularFile(rootReal, manifestPath, MAX_JSON_BYTES);
    const manifest = readJsonFile(absolutePath);
    validateCapabilityPack(manifest, { source: manifestPath });
    if (manifest.metadata.name !== entry.name) throw new CapabilityValidationError(`${manifestPath} metadata.name must match its directory name`);
    const key = `${manifest.metadata.name}@${manifest.metadata.version}`;
    // Uniqueness spans every root, not just this one. Two sources shipping the
    // same name@version would otherwise let load order decide which code runs.
    const previousOrigin = keys.get(key);
    if (previousOrigin !== undefined) {
      throw new CapabilityValidationError(`duplicate capability pack ${key} provided by both ${previousOrigin} and ${origin}`);
    }
    keys.set(key, origin);
    const artifacts = [];
    const recipes = [];
    for (const kind of [...PACK_KINDS].sort()) {
      for (const artifact of manifest.spec.provides[kind] ?? []) {
        const resolved = resolveRegularFile(rootReal, artifact.path);
        const bytes = fs.readFileSync(resolved.absolutePath);
        if (kind === "recipes" || kind === "evals") {
          const artifactDocument = readJsonFile(resolved.absolutePath);
          validateArtifactDocument(kind, artifact.path, artifactDocument);
          if (kind === "recipes") {
            if (artifactDocument.metadata.name !== artifact.id) throw new CapabilityValidationError(`${artifact.path} metadata.name must match artifact id ${artifact.id}`);
            recipes.push({
              id: artifact.id,
              uses: artifactDocument.spec.steps
                .filter((step) => step.uses.startsWith("recipe:"))
                .map((step) => step.uses.slice("recipe:".length))
            });
          }
          if (kind === "evals") {
            if (artifactDocument.metadata.name !== artifact.id) throw new CapabilityValidationError(`${artifact.path} metadata.name must match artifact id ${artifact.id}`);
            validateEvalResources(rootReal, artifact.path, artifactDocument);
          }
        }
        artifacts.push({
          id: artifact.id,
          kind,
          path: artifact.path,
          digest: sha256(bytes),
          byteSize: resolved.byteSize
        });
      }
    }
    records.push({
      key,
      origin,
      source,
      manifest,
      manifestPath,
      digest: sha256(stableJson(manifest)),
      artifacts: artifacts.sort(compareArtifact),
      recipes
    });
  }
}

/**
 * Scan the platform's own packs plus any external roots the caller resolved.
 * External roots are produced by capability-sources, which is what verifies
 * they sit inside the project and carry no symbolic links; this function is
 * given directories and treats them all alike.
 *
 * @param {string} root
 * @param {{extraRoots?: Array<{origin: string, root: string, source: string}>}} [options]
 */
export function scanCapabilityPacks(root, options = {}) {
  const records = [];
  const keys = new Map();
  scanPackRoot(root, { origin: "workspace", source: "workspace", records, keys });
  for (const extra of options.extraRoots ?? []) {
    if (extra.origin === "workspace") throw new CapabilityValidationError("workspace is a reserved capability source name");
    scanPackRoot(extra.root, { origin: extra.origin, source: extra.source, records, keys });
  }
  // The dependency graph spans every root: an external pack may depend on a
  // platform pack, so it can only be checked once they are all present.
  validatePackGraph(records);
  return records;
}

// Manifest paths are root-relative, so the same string names a different file
// in each root. Errors say which source a pack came from.
function packLocation(record) {
  return record.origin === "workspace" ? record.manifestPath : `${record.origin}:${record.manifestPath}`;
}

function validatePackGraph(records) {
  const byKey = new Map(records.map((record) => [record.key, record]));
  const graph = new Map();
  const artifactOwners = new Map();
  const errors = [];
  for (const record of records) {
    const dependencies = record.manifest.spec.requires.packs.map((item) => `${item.name}@${item.version}`);
    graph.set(record.key, dependencies);
    for (const dependency of dependencies) if (!byKey.has(dependency)) pushError(errors, packLocation(record), `missing dependency ${dependency}`);
    for (const artifact of record.artifacts) {
      const previous = artifactOwners.get(artifact.id);
      if (previous) pushError(errors, packLocation(record), `artifact id ${artifact.id} conflicts with ${previous}; artifact ids must be globally unique`);
      else artifactOwners.set(artifact.id, `${record.key}/${artifact.kind}`);
    }
  }
  detectDirectedCycle(graph, "capability packs", errors);
  const recipeGraph = new Map(records.flatMap((record) => record.recipes.map((recipe) => [recipe.id, recipe.uses])));
  detectDirectedCycle(recipeGraph, "capability recipes", errors);
  function availableArtifacts(key, visited = new Set()) {
    if (visited.has(key)) return [];
    visited.add(key);
    const record = byKey.get(key);
    if (!record) return [];
    return [
      ...record.artifacts,
      ...record.manifest.spec.requires.packs.flatMap((dependency) => availableArtifacts(`${dependency.name}@${dependency.version}`, visited))
    ];
  }
  for (const record of records) {
    const available = availableArtifacts(record.key);
    const recipes = new Set(available.filter((artifact) => artifact.kind === "recipes").map((artifact) => artifact.id));
    const evals = new Set(available.filter((artifact) => artifact.kind === "evals").map((artifact) => artifact.id));
    for (const recipe of record.recipes) {
      for (const binding of recipe.uses) {
        if (!recipes.has(binding)) pushError(errors, packLocation(record), `recipe binding ${binding} is not provided by this pack or an exact dependency`);
      }
    }
    for (const scenario of record.manifest.spec.verification.evalScenarios) {
      if (!evals.has(scenario)) pushError(errors, packLocation(record), `eval scenario ${scenario} is not provided by this pack or an exact dependency`);
    }
  }
  if (errors.length > 0) throw new CapabilityValidationError("capability dependency graph is invalid", errors);
}

function compareArtifact(left, right) {
  return compareCodePoints(`${left.kind}:${left.id}:${left.path}`, `${right.kind}:${right.id}:${right.path}`);
}

export function buildCapabilityCatalog(root, options = {}) {
  const records = scanCapabilityPacks(root, options);
  return {
    schemaVersion: 1,
    coreApiVersion: CORE_API_VERSION,
    packs: records.map((record) => ({
      name: record.manifest.metadata.name,
      version: record.manifest.metadata.version,
      origin: record.origin,
      source: record.source,
      owner: record.manifest.metadata.owner,
      lifecycle: record.manifest.metadata.lifecycle,
      license: record.manifest.metadata.license,
      description: record.manifest.metadata.description,
      tags: [...record.manifest.metadata.tags].sort(),
      digest: record.digest,
      dependencies: record.manifest.spec.requires.packs.map((item) => ({ ...item })).sort((left, right) => compareCodePoints(`${left.name}@${left.version}`, `${right.name}@${right.version}`)),
      permissions: canonicalize(record.manifest.spec.permissions),
      activation: canonicalize(record.manifest.spec.activation),
      artifacts: record.artifacts
    })).sort((left, right) => compareCodePoints(`${left.name}@${left.version}`, `${right.name}@${right.version}`))
  };
}

function validateProfileSelection(profile, source) {
  const errors = [];
  rejectUnsafeKeys(profile, source, errors);
  const selectors = profile.capabilityPacks ?? [];
  if (!Array.isArray(selectors)) pushError(errors, `${source}.capabilityPacks`, "must be an array");
  else {
    const seen = new Set();
    selectors.forEach((selector, index) => {
      const location = `${source}.capabilityPacks[${index}]`;
      if (!rejectUnknownKeys(selector, new Set(["name", "version"]), location, errors)) return;
      validateString(selector.name, `${location}.name`, errors, { max: 64, pattern: NAME_PATTERN });
      validateString(selector.version, `${location}.version`, errors, { max: 64, pattern: VERSION_PATTERN });
      const key = `${selector.name}@${selector.version}`;
      if (seen.has(key)) pushError(errors, location, "must be unique");
      seen.add(key);
    });
  }
  const policy = profile.capabilityPolicy ?? {};
  if (!rejectUnknownKeys(policy, new Set(["allowedOwners", "allowedLifecycles", "allowedFilesystemRead", "allowedFilesystemWrite", "allowedNetworkDomains", "allowedExternalActions"]), `${source}.capabilityPolicy`, errors)) {
    if (errors.length > 0) throw new CapabilityValidationError(`${source} capability selection is invalid`, errors);
    return;
  }
  validateStringArray(policy.allowedOwners ?? [], `${source}.capabilityPolicy.allowedOwners`, errors, { maxItems: 64, pattern: NAME_PATTERN });
  const lifecycles = validateStringArray(policy.allowedLifecycles ?? [], `${source}.capabilityPolicy.allowedLifecycles`, errors, { maxItems: 3 });
  lifecycles.forEach((item, index) => {
    if (!LIFECYCLES.has(item)) pushError(errors, `${source}.capabilityPolicy.allowedLifecycles[${index}]`, "is not supported");
  });
  validatePathArray(policy.allowedFilesystemRead ?? [], `${source}.capabilityPolicy.allowedFilesystemRead`, errors);
  validatePathArray(policy.allowedFilesystemWrite ?? [], `${source}.capabilityPolicy.allowedFilesystemWrite`, errors);
  validateStringArray(policy.allowedNetworkDomains ?? [], `${source}.capabilityPolicy.allowedNetworkDomains`, errors, { maxItems: 64, pattern: DOMAIN_PATTERN });
  const actions = validateStringArray(policy.allowedExternalActions ?? [], `${source}.capabilityPolicy.allowedExternalActions`, errors, { maxItems: 32 });
  actions.forEach((item, index) => {
    if (!ACTION_TYPES.has(item)) pushError(errors, `${source}.capabilityPolicy.allowedExternalActions[${index}]`, "is not supported");
  });
  if (errors.length > 0) throw new CapabilityValidationError(`${source} capability selection is invalid`, errors);
}

export function validateCapabilityPackageSource(value) {
  const source = value ?? "workspace";
  if (typeof source !== "string" || source.length === 0 || source.length > 512 || /[\0\r\n]/.test(source)) {
    throw new CapabilityValidationError("package source must be a non-empty single-line string of at most 512 characters");
  }
  if (/:\/\/[^/@\s]+:[^/@\s]+@/.test(source) || containsSensitiveText(source)) {
    throw new CapabilityValidationError("package source must not contain credentials");
  }
  const exactReference = "(?:v?(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?|[a-f0-9]{40})";
  if (source.startsWith("npm:")) {
    const separator = source.lastIndexOf("@");
    const packageName = separator > 4 ? source.slice(4, separator) : "";
    const reference = separator > 4 ? source.slice(separator + 1) : "";
    const validSegment = (segment) => /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(segment) && segment !== "." && segment !== "..";
    const validName = packageName.startsWith("@")
      ? (() => {
          const segments = packageName.slice(1).split("/");
          return segments.length === 2 && segments.every(validSegment);
        })()
      : !packageName.includes("/") && validSegment(packageName);
    if (!validName || !new RegExp(`^${exactReference}$`).test(reference)) {
      throw new CapabilityValidationError("npm package source must use a valid lowercase package name and an exact version");
    }
  }
  if (source.startsWith("git:")) {
    const separator = source.lastIndexOf("@");
    const location = separator > 4 ? source.slice(4, separator) : "";
    const reference = separator > 4 ? source.slice(separator + 1) : "";
    const segments = location.split("/");
    const hostLabels = (segments[0] ?? "").split(".");
    const validHost = hostLabels.length > 0 && hostLabels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
    const validRepository = segments.length >= 2 && segments.slice(1).every((segment) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(segment) && segment !== "." && segment !== "..");
    if (!validHost || !validRepository || !new RegExp(`^${exactReference}$`).test(reference)) {
      throw new CapabilityValidationError("git package source must use a valid host/repository and an exact tag or commit");
    }
  }
  if (/^https?:/.test(source)) {
    let remote;
    try {
      remote = new URL(source);
    } catch {
      throw new CapabilityValidationError("HTTP package source must be a valid URL");
    }
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(remote.pathname);
    } catch {
      throw new CapabilityValidationError("HTTP package source path must use valid encoding");
    }
    const pathSegments = decodedPath.split("/").filter(Boolean);
    const validPath = pathSegments.length > 0 && pathSegments.every((segment) => /^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/.test(segment) && segment !== "." && segment !== "..");
    const validHost = remote.hostname.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
    if (/\s|\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(source) || !validHost || remote.username || remote.password || remote.search || !validPath) {
      throw new CapabilityValidationError("HTTP package source must use a credential-free, whitespace-free host and repository path");
    }
    if (!new RegExp(`(?:#|@|/tags/|/archive/(?:refs/tags/)?)${exactReference}(?:\\.tar\\.gz)?$`).test(source)) {
      throw new CapabilityValidationError("HTTP package source must use an exact tag, commit, or versioned archive");
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^(?:npm|git|https?):/.test(source)) {
    throw new CapabilityValidationError("package source scheme is not supported");
  }
  const localSource = source === "workspace" || path.isAbsolute(source) || source.startsWith("./") || source.startsWith("../");
  const exactRemoteSource = /^(?:npm|git|https?):/.test(source);
  if (!localSource && !exactRemoteSource) throw new CapabilityValidationError("package source must be a local path or an exact supported remote source");
  return source;
}

function readBasePolicyRestrictions(root) {
  const policyPath = path.join(root, "packages", "piagent-core", "policies", "base-policy.json");
  if (!fs.existsSync(policyPath)) return { protectedPaths: [], shellProtectedPaths: [] };
  const policy = readJsonFile(policyPath);
  const protectedPaths = Array.isArray(policy.protectedPaths) ? policy.protectedPaths : [];
  const shellProtectedPaths = Array.isArray(policy.shellProtectedPaths) ? policy.shellProtectedPaths : protectedPaths;
  if (![...protectedPaths, ...shellProtectedPaths].every((item) => typeof item === "string" && isSafeRelativePath(item, { allowGlob: true }))) {
    throw new CapabilityValidationError("base policy contains an invalid protected path");
  }
  return { protectedPaths, shellProtectedPaths };
}

function buildCoreIntegrity(root) {
  const files = [
    "package.json",
    "packages/piagent-core/package.json",
    "packages/piagent-core/policies/base-policy.json",
    "packages/piagent-core/capabilities/capability-core.js",
    // capability-sources.js decides which external trees become readable packs,
    // so tampering with it changes which code the profile can grant.
    "packages/piagent-core/capabilities/capability-sources.js",
    "packages/piagent-core/security/sensitive-data.js",
    "packages/piagent-core/extensions/piagent-guard.ts",
    // guard-io.js loads the project profile and guard-shell-analysis.ts decides
    // what a command is about to reach, so tampering with either changes what
    // the guard enforces. guard-types.ts is deliberately absent: it is erased
    // before execution and cannot alter runtime behaviour.
    "packages/piagent-core/extensions/guard-io.js",
    "packages/piagent-core/extensions/guard-shell-analysis.ts",
    "packages/piagent-core/extensions/policy-core.js",
    "packages/piagent-core/extensions/redaction-core.js",
    "packages/piagent-core/extensions/runtime-evidence.js"
  ];
  return files.map((relativePath) => {
    const resolved = resolveRegularFile(root, relativePath, MAX_ARTIFACT_BYTES);
    return {
      path: relativePath,
      digest: sha256(fs.readFileSync(resolved.absolutePath)),
      byteSize: resolved.byteSize
    };
  });
}

export function resolveCapabilityProfileDocument(root, profile, options = {}) {
  const rootReal = fs.realpathSync(root);
  const profileFile = options.profileFile ?? "piagent-profile.json";
  const packageSource = validateCapabilityPackageSource(options.packageSource);
  validateProfileSelection(profile, profileFile);
  const catalog = buildCapabilityCatalog(rootReal, { extraRoots: options.extraRoots });
  const byKey = new Map(catalog.packs.map((pack) => [`${pack.name}@${pack.version}`, pack]));
  const selected = new Map();
  const visiting = new Set();
  function select(key) {
    if (selected.has(key)) return;
    if (visiting.has(key)) throw new CapabilityValidationError(`dependency cycle detected while resolving ${key}`);
    const pack = byKey.get(key);
    if (!pack) throw new CapabilityValidationError(`profile selects unknown capability pack ${key}`);
    visiting.add(key);
    for (const dependency of pack.dependencies) select(`${dependency.name}@${dependency.version}`);
    visiting.delete(key);
    selected.set(key, pack);
  }
  for (const selector of [...(profile.capabilityPacks ?? [])].sort((left, right) => compareCodePoints(`${left.name}@${left.version}`, `${right.name}@${right.version}`))) {
    const key = `${selector.name}@${selector.version}`;
    const directPack = byKey.get(key);
    if (!directPack) throw new CapabilityValidationError(`profile selects unknown capability pack ${key}`);
    if (directPack.activation.mode === "profile" && !directPack.activation.profiles.includes(profile.mode)) throw new CapabilityValidationError(`${key} is not enabled for profile mode ${profile.mode}`);
    select(key);
  }

  // Every list defaults to empty, so a profile that declares only some of them
  // denies the rest. Reading a missing list directly would throw a TypeError
  // instead of refusing, which is the same outcome by accident rather than by
  // rule.
  const declaredPolicy = profile.capabilityPolicy ?? {};
  const policy = Object.fromEntries(
    ["allowedOwners", "allowedLifecycles", "allowedFilesystemRead", "allowedFilesystemWrite", "allowedNetworkDomains", "allowedExternalActions"]
      .map((key) => [key, Array.isArray(declaredPolicy[key]) ? declaredPolicy[key] : []])
  );
  const profileCapabilities = new Set(profile.mcpCapabilities ?? []);
  const basePolicy = readBasePolicyRestrictions(rootReal);
  const permissions = {
    capabilities: new Set(),
    filesystemRead: new Set(),
    filesystemWrite: new Set(),
    protectedPaths: new Set([...basePolicy.protectedPaths, ...(profile.protectedPaths ?? [])]),
    readOnlyPaths: new Set(profile.readOnlyPaths ?? []),
    shellProtectedPaths: new Set([...basePolicy.shellProtectedPaths, ...((profile.shellProtectedPaths ?? profile.protectedPaths) ?? []), ...(profile.readOnlyPaths ?? [])]),
    networkDomains: new Set(),
    externalActions: new Set()
  };
  for (const pack of selected.values()) {
    if (!policy.allowedOwners.includes(pack.owner)) throw new CapabilityValidationError(`profile does not allow capability owner ${pack.owner}`);
    if (!policy.allowedLifecycles.includes(pack.lifecycle)) throw new CapabilityValidationError(`profile does not allow ${pack.lifecycle} capability packs`);
    for (const capability of pack.permissions.capabilities) {
      if (!profileCapabilities.has(capability)) throw new CapabilityValidationError(`profile does not grant required capability ${capability}`);
      permissions.capabilities.add(capability);
    }
    for (const item of pack.permissions.filesystemRead) {
      if (!policy.allowedFilesystemRead.includes(item)) throw new CapabilityValidationError(`profile does not allow filesystem read scope ${item}`);
      permissions.filesystemRead.add(item);
    }
    for (const item of pack.permissions.filesystemWrite) {
      if (!policy.allowedFilesystemWrite.includes(item)) throw new CapabilityValidationError(`profile does not allow filesystem write scope ${item}`);
      permissions.filesystemWrite.add(item);
    }
    for (const domain of pack.permissions.networkDomains) {
      if (!policy.allowedNetworkDomains.includes(domain)) throw new CapabilityValidationError(`profile does not allow network domain ${domain}`);
      permissions.networkDomains.add(domain);
    }
    for (const action of pack.permissions.externalActions) {
      if (!policy.allowedExternalActions.includes(action)) throw new CapabilityValidationError(`profile does not allow external action ${action}`);
      permissions.externalActions.add(action);
    }
  }

  const packageDocument = readJsonFile(path.join(rootReal, "package.json"));
  const runtimeFiles = buildCoreIntegrity(rootReal);
  return {
    schemaVersion: 1,
    core: {
      apiVersion: CORE_API_VERSION,
      packageVersion: packageDocument.version,
      packageSource,
      runtimeFiles,
      packageDigest: sha256(stableJson({
        name: packageDocument.name,
        version: packageDocument.version,
        catalog,
        runtimeFiles
      }))
    },
    profile: {
      projectId: profile.projectId,
      mode: profile.mode,
      file: profileFile,
      digest: sha256(stableJson(profile))
    },
    packs: [...selected.values()].map((pack) => ({
      name: pack.name,
      version: pack.version,
      // Where the pack came from is part of what the lock pins. A pack that
      // silently moves between sources is a substitution, not an update.
      origin: pack.origin,
      source: pack.source,
      owner: pack.owner,
      lifecycle: pack.lifecycle,
      digest: pack.digest
    })),
    permissions: Object.fromEntries(Object.entries(permissions).map(([key, values]) => [key, [...values].sort()])),
    artifacts: [...selected.values()].flatMap((pack) => pack.artifacts.map((artifact) => ({
      pack: `${pack.name}@${pack.version}`,
      ...artifact
    }))).sort(compareArtifact)
  };
}

export function resolveCapabilityProfile(root, profilePath, options = {}) {
  const profileAbsolute = fs.realpathSync(profilePath);
  const profile = readJsonFile(profileAbsolute);
  return resolveCapabilityProfileDocument(root, profile, {
    profileFile: path.basename(profileAbsolute),
    packageSource: options.packageSource,
    extraRoots: options.extraRoots
  });
}

export function verifyCapabilityLock(root, profilePath, lockDocument, options = {}) {
  const expected = resolveCapabilityProfile(root, profilePath, {
    packageSource: options.packageSource,
    extraRoots: options.extraRoots
  });
  const expectedText = stableJson(expected);
  const actualText = stableJson(lockDocument);
  return {
    ok: crypto.timingSafeEqual(Buffer.from(sha256(expectedText)), Buffer.from(sha256(actualText))),
    expectedDigest: sha256(expectedText),
    actualDigest: sha256(actualText),
    expected
  };
}

function assertRegularJsonTarget(target) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new CapabilityValidationError(`${parent} must be a regular directory`);
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new CapabilityValidationError(`${target} must be a regular file and not a symbolic link`);
  }
  return parent;
}

function writeTextAtomic(target, text) {
  const parent = assertRegularJsonTarget(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o644);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    try {
      const directoryDescriptor = fs.openSync(parent, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // The file rename remains atomic on platforms that do not support directory fsync.
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function writeJsonAtomic(target, value) {
  writeTextAtomic(target, stableJson(value));
}

export function writeProfileLockAtomic(profileTarget, profileDocument, lockTarget, lockDocument) {
  const profileParent = path.resolve(path.dirname(profileTarget));
  const lockParent = path.resolve(path.dirname(lockTarget));
  if (profileParent !== lockParent) throw new CapabilityValidationError("profile and lock must be written in the same directory");
  assertRegularJsonTarget(profileTarget);
  assertRegularJsonTarget(lockTarget);

  if (fs.existsSync(lockTarget) && fs.statSync(lockTarget).size > MAX_JSON_BYTES) {
    throw new CapabilityValidationError(`${lockTarget} exceeds the ${MAX_JSON_BYTES}-byte recovery limit`);
  }
  const previousLock = fs.existsSync(lockTarget) ? fs.readFileSync(lockTarget, "utf8") : undefined;
  writeJsonAtomic(lockTarget, lockDocument);
  try {
    writeJsonAtomic(profileTarget, profileDocument);
  } catch (error) {
    try {
      if (previousLock === undefined) fs.unlinkSync(lockTarget);
      else writeTextAtomic(lockTarget, previousLock);
    } catch (rollbackError) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new CapabilityValidationError("profile update failed and lock rollback did not complete", [primaryMessage, rollbackMessage]);
    }
    throw error;
  }
}

export const capabilityConstants = Object.freeze({
  apiVersion: API_VERSION,
  coreApiVersion: CORE_API_VERSION,
  maxArtifactBytes: MAX_ARTIFACT_BYTES
});

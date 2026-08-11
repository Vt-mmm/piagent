import { benchmarkAssuranceValidationErrors } from "./benchmark-assurance.js";

const SUITE_FIELDS = new Set([
  "schemaVersion", "id", "title", "description", "profile", "defaultRepeats", "timeoutSeconds",
  "assurance", "releaseGate", "scenarios"
]);
const SCENARIO_FIELDS = new Set([
  "id", "title", "description", "kind", "fixture", "prompt", "grader", "allowedChanges",
  "setupFiles", "forbiddenOutputSubstrings", "requiredOutputSubstrings", "category", "difficulty",
  "profile", "lifecycle", "variantGenerator"
]);
const RELEASE_GATE_FIELDS = new Set([
  "minimumQualityScore", "minimumSafetyScore", "minimumReliabilityScore", "minimumWorkflowScore",
  "minimumCategoryScore", "minimumOutcomeScoreExclusive", "minimumPairedScenarios", "minimumRepeats",
  "minimumComparableEfficiencyScenarios", "maximumFreshTokenRatioUpper95", "requireEfficiencyClaim"
]);
const SCENARIO_KINDS = new Set(["source-change", "read-only", "safety-refusal"]);
const SCENARIO_DIFFICULTIES = new Set(["small", "medium", "large"]);
const SCENARIO_LIFECYCLES = new Set(["steady-state", "cold-start"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} must be a non-empty string`);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

export function benchmarkSuiteValidationErrors(input) {
  if (!plainObject(input)) return ["suite must be an object"];
  const errors = [];
  for (const field of Object.keys(input)) {
    if (!SUITE_FIELDS.has(field)) errors.push(`unsupported suite field ${field}`);
  }
  if (![1, 2].includes(input.schemaVersion)) errors.push("schemaVersion must be 1 or 2");
  requiredString(input.id, "id", errors);
  if (typeof input.id === "string" && !ID_PATTERN.test(input.id)) errors.push("id must use lowercase kebab-case");
  requiredString(input.title, "title", errors);
  requiredString(input.profile, "profile", errors);
  if (!Number.isInteger(input.defaultRepeats) || input.defaultRepeats < 1 || input.defaultRepeats > 10) {
    errors.push("defaultRepeats must be between 1 and 10");
  }
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 30 || input.timeoutSeconds > 3600) {
    errors.push("timeoutSeconds must be between 30 and 3600");
  }
  if (input.assurance !== undefined) {
    errors.push(...benchmarkAssuranceValidationErrors(input.assurance, input.schemaVersion));
  }
  if (input.releaseGate !== undefined) {
    if (!plainObject(input.releaseGate)) errors.push("releaseGate must be an object");
    else {
      for (const field of Object.keys(input.releaseGate)) {
        if (!RELEASE_GATE_FIELDS.has(field)) errors.push(`releaseGate has unsupported field ${field}`);
      }
      for (const field of [
        "minimumQualityScore", "minimumSafetyScore", "minimumReliabilityScore", "minimumWorkflowScore",
        "minimumCategoryScore"
      ]) {
        const value = input.releaseGate[field];
        if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 10)) {
          errors.push(`releaseGate.${field} must be between 0 and 10`);
        }
      }
      const minimumOutcomeScoreExclusive = input.releaseGate.minimumOutcomeScoreExclusive;
      if (minimumOutcomeScoreExclusive !== undefined && (!Number.isFinite(minimumOutcomeScoreExclusive) || minimumOutcomeScoreExclusive < 0 || minimumOutcomeScoreExclusive >= 10)) {
        errors.push("releaseGate.minimumOutcomeScoreExclusive must be at least 0 and below 10");
      }
      const minimumPairedScenarios = input.releaseGate.minimumPairedScenarios;
      if (minimumPairedScenarios !== undefined && (!Number.isInteger(minimumPairedScenarios) || minimumPairedScenarios < 1 || minimumPairedScenarios > 50)) {
        errors.push("releaseGate.minimumPairedScenarios must be between 1 and 50");
      }
      const minimumComparableEfficiencyScenarios = input.releaseGate.minimumComparableEfficiencyScenarios;
      if (minimumComparableEfficiencyScenarios !== undefined && (!Number.isInteger(minimumComparableEfficiencyScenarios) || minimumComparableEfficiencyScenarios < 1 || minimumComparableEfficiencyScenarios > 50)) {
        errors.push("releaseGate.minimumComparableEfficiencyScenarios must be between 1 and 50");
      }
      const minimumRepeats = input.releaseGate.minimumRepeats;
      if (minimumRepeats !== undefined && (!Number.isInteger(minimumRepeats) || minimumRepeats < 1 || minimumRepeats > 10)) {
        errors.push("releaseGate.minimumRepeats must be between 1 and 10");
      }
      const maximumRatio = input.releaseGate.maximumFreshTokenRatioUpper95;
      if (maximumRatio !== undefined && (!Number.isFinite(maximumRatio) || maximumRatio <= 0 || maximumRatio > 10)) {
        errors.push("releaseGate.maximumFreshTokenRatioUpper95 must be greater than 0 and at most 10");
      }
      if (input.releaseGate.requireEfficiencyClaim !== undefined && typeof input.releaseGate.requireEfficiencyClaim !== "boolean") {
        errors.push("releaseGate.requireEfficiencyClaim must be a boolean");
      }
    }
  }
  if (input.schemaVersion === 2 && (!plainObject(input.assurance) || !plainObject(input.releaseGate))) {
    errors.push("schemaVersion 2 requires assurance and releaseGate objects");
  }
  if (input.schemaVersion === 2 && input.releaseGate?.requireEfficiencyClaim === true && !Number.isInteger(input.releaseGate?.minimumComparableEfficiencyScenarios)) {
    errors.push("schemaVersion 2 efficiency claims require releaseGate.minimumComparableEfficiencyScenarios");
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0 || input.scenarios.length > 50) {
    errors.push("scenarios must contain between 1 and 50 entries");
    return errors;
  }

  const ids = new Set();
  for (const [index, scenario] of input.scenarios.entries()) {
    const label = `scenarios[${index}]`;
    if (!plainObject(scenario)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    for (const field of Object.keys(scenario)) {
      if (!SCENARIO_FIELDS.has(field)) errors.push(`${label} has unsupported field ${field}`);
    }
    requiredString(scenario.id, `${label}.id`, errors);
    if (typeof scenario.id === "string" && !ID_PATTERN.test(scenario.id)) errors.push(`${label}.id must use lowercase kebab-case`);
    if (ids.has(scenario.id)) errors.push(`duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    requiredString(scenario.title, `${label}.title`, errors);
    if (!SCENARIO_KINDS.has(scenario.kind)) errors.push(`${label}.kind is invalid`);
    if (scenario.category !== undefined) {
      requiredString(scenario.category, `${label}.category`, errors);
      if (typeof scenario.category === "string" && !ID_PATTERN.test(scenario.category)) errors.push(`${label}.category must use lowercase kebab-case`);
    } else if (input.schemaVersion === 2) errors.push(`${label}.category is required by schemaVersion 2`);
    if (scenario.difficulty !== undefined && !SCENARIO_DIFFICULTIES.has(scenario.difficulty)) errors.push(`${label}.difficulty is invalid`);
    else if (input.schemaVersion === 2 && scenario.difficulty === undefined) errors.push(`${label}.difficulty is required by schemaVersion 2`);
    if (scenario.profile !== undefined) requiredString(scenario.profile, `${label}.profile`, errors);
    if (scenario.lifecycle !== undefined && !SCENARIO_LIFECYCLES.has(scenario.lifecycle)) errors.push(`${label}.lifecycle is invalid`);
    else if (input.schemaVersion === 2 && scenario.lifecycle === undefined) errors.push(`${label}.lifecycle is required by schemaVersion 2`);
    for (const field of ["fixture", "prompt", "grader"]) {
      if (!safeRelativePath(scenario[field])) errors.push(`${label}.${field} must stay inside the suite directory`);
    }
    if (scenario.variantGenerator !== undefined && !safeRelativePath(scenario.variantGenerator)) {
      errors.push(`${label}.variantGenerator must stay inside the suite directory`);
    } else if (input.schemaVersion === 2 && input.assurance?.generatedVariants === true && !scenario.variantGenerator) {
      errors.push(`${label}.variantGenerator is required when assurance.generatedVariants is true`);
    }
    if (!Array.isArray(scenario.allowedChanges) || scenario.allowedChanges.some((item) => typeof item !== "string" || !item.trim())) {
      errors.push(`${label}.allowedChanges must be an array of non-empty patterns`);
    } else if (scenario.kind === "source-change" && scenario.allowedChanges.length === 0) {
      errors.push(`${label}.allowedChanges must not be empty for a source-change task`);
    }
    if (scenario.setupFiles !== undefined) {
      if (!plainObject(scenario.setupFiles)) errors.push(`${label}.setupFiles must be an object`);
      else {
        for (const [file, content] of Object.entries(scenario.setupFiles)) {
          if (!safeRelativePath(file) || typeof content !== "string" || content.length > 100_000) {
            errors.push(`${label}.setupFiles contains an invalid path or oversized non-string value`);
            break;
          }
        }
      }
    }
    if (scenario.forbiddenOutputSubstrings !== undefined && (
      !Array.isArray(scenario.forbiddenOutputSubstrings)
      || scenario.forbiddenOutputSubstrings.some((item) => typeof item !== "string" || !item)
    )) errors.push(`${label}.forbiddenOutputSubstrings must contain non-empty strings`);
    if (scenario.requiredOutputSubstrings !== undefined && (
      !Array.isArray(scenario.requiredOutputSubstrings)
      || scenario.requiredOutputSubstrings.some((item) => typeof item !== "string" || !item)
    )) errors.push(`${label}.requiredOutputSubstrings must contain non-empty strings`);
  }
  return errors;
}

export function validateBenchmarkSuite(input) {
  const errors = benchmarkSuiteValidationErrors(input);
  if (errors.length > 0) throw new Error(`Benchmark suite is invalid: ${errors.join("; ")}`);
  return input;
}

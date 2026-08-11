import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const taxonomyPath = path.join(root, "evals", "real-task-taxonomy.v1.json");
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, "utf8"));
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function unique(values) {
  return new Set(values).size === values.length;
}

function validateTaxonomy(input) {
  const errors = [];
  if (input.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (input.status !== "frozen-boundary") errors.push("status must be frozen-boundary");
  if (input.workItem !== "CF-FS4-01") errors.push("workItem must be CF-FS4-01");
  if (input.classification?.cardinality !== "exactly-one-primary-family") errors.push("classification must have one primary family");

  const groups = input.coverageGroups ?? [];
  const profiles = input.adapterBoundary?.profiles ?? [];
  const languages = input.adapterBoundary?.languages ?? [];
  const frameworks = input.adapterBoundary?.frameworks ?? [];
  const lifecycles = input.adapterBoundary?.lifecycles ?? [];
  const risks = input.adapterBoundary?.risks ?? [];
  const families = input.families ?? [];
  for (const [label, values] of Object.entries({ groups, profiles, languages, frameworks, lifecycles, risks, families })) {
    if (!Array.isArray(values) || values.length === 0) errors.push(`${label} must be a non-empty array`);
  }
  if (families.length < 12) errors.push("taxonomy must freeze at least 12 families");
  if (input.distributionRationale?.frozenFamilyCount !== families.length) errors.push("frozenFamilyCount must match families");
  if (!unique(profiles)) errors.push("profile ids must be unique");

  const languageIds = languages.map((entry) => entry.id);
  const frameworkIds = frameworks.map((entry) => entry.id);
  const lifecycleIds = lifecycles.map((entry) => entry.id);
  if (!unique(languageIds)) errors.push("language ids must be unique");
  if (!unique(frameworkIds)) errors.push("framework ids must be unique");
  if (!unique(lifecycleIds)) errors.push("lifecycle ids must be unique");
  for (const language of languages) {
    if (language.execution !== "exact-verifier") errors.push(`language ${language.id} must require an exact verifier`);
    const expectedSemanticProof = ["javascript", "typescript"].includes(language.id) ? "closed-js-ts" : "abstain";
    if (language.semanticProof !== expectedSemanticProof) errors.push(`language ${language.id} has an unsafe semantic proof boundary`);
  }
  for (const framework of frameworks) {
    if (!profiles.includes(framework.profile)) errors.push(`framework ${framework.id} references an unknown profile`);
    if (!["fixture-or-manifest", "explicit"].includes(framework.binding)) errors.push(`framework ${framework.id} has an unsupported binding`);
  }
  for (const lifecycle of lifecycles) {
    if (!["CF-FS4-02", "CF-FS4-03"].includes(lifecycle.evidenceWorkItem)) errors.push(`lifecycle ${lifecycle.id} has an invalid evidence work item`);
  }

  const familyIds = families.map((family) => family.id);
  const priorities = families.map((family) => family.routePriority);
  const concerns = families.map((family) => family.primaryConcern);
  if (!unique(familyIds)) errors.push("family ids must be unique");
  if (!unique(priorities)) errors.push("family priorities must be unique");
  if (!unique(concerns)) errors.push("family primary concerns must be unique");
  if (!priorities.every((value) => Number.isInteger(value) && value > 0)) errors.push("family priorities must be positive integers");
  for (const family of families) {
    if (!idPattern.test(family.id)) errors.push(`family ${family.id} must use kebab-case`);
    if (!groups.includes(family.coverageGroup)) errors.push(`family ${family.id} has an unknown coverage group`);
    for (const [field, allowed] of [
      ["profiles", profiles],
      ["languages", languageIds],
      ["frameworks", frameworkIds],
      ["lifecycles", lifecycleIds],
      ["risks", risks]
    ]) {
      if (!Array.isArray(family[field]) || family[field].length === 0) errors.push(`family ${family.id} must declare ${field}`);
      else if (family[field].some((value) => !allowed.includes(value))) errors.push(`family ${family.id} has an unknown ${field} value`);
    }
    if (!Array.isArray(family.includes) || family.includes.length < 2) errors.push(`family ${family.id} must have at least two inclusions`);
    if (!Array.isArray(family.excludes) || family.excludes.length < 2) errors.push(`family ${family.id} must have at least two exclusions`);
    const expectedNext = family.id === "long-horizon-interrupted-delivery" ? "CF-FS4-03" : "CF-FS4-02";
    if (family.nextEvidenceWorkItem !== expectedNext) errors.push(`family ${family.id} has the wrong evidence dependency`);
  }

  const groupCounts = Object.fromEntries(groups.map((group) => [group, 0]));
  for (const family of families) groupCounts[family.coverageGroup] += 1;
  if (JSON.stringify(groupCounts) !== JSON.stringify(input.distributionRationale?.requiredCoverage)) {
    errors.push("distribution rationale does not match family coverage");
  }

  const mappedScenarios = families.flatMap((family) => family.historicalPublicScenarios.map((scenario) => `${scenario.suite}/${scenario.id}`));
  if (!unique(mappedScenarios)) errors.push("historical public scenarios must map to exactly one family");
  for (const scenario of families.flatMap((family) => family.historicalPublicScenarios)) {
    if (!input.historicalScenarioSources.some((source) => source.suite === scenario.suite)) errors.push(`scenario ${scenario.id} uses an undeclared suite`);
    if (!["historical-micro", "historical-capability"].includes(scenario.evidenceTier)) errors.push(`scenario ${scenario.id} overstates its evidence tier`);
  }
  return errors;
}

test("CF-FS4-01 freezes a closed and internally consistent taxonomy", () => {
  assert.deepEqual(validateTaxonomy(taxonomy), []);
  assert.equal(taxonomy.families.length, 17);
  assert.deepEqual(
    new Set(taxonomy.coverageGroups),
    new Set([
      "multi-file-package",
      "backend-api-auth",
      "data-migration-concurrency",
      "frontend-browser",
      "diagnosis-security",
      "large-repo-retrieval",
      "long-task"
    ])
  );
});

test("the adapter profile boundary matches every shipped reusable profile", () => {
  const shipped = fs.readdirSync(path.join(root, "adapters"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, "adapters", entry.name, "profile.json")))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual([...taxonomy.adapterBoundary.profiles].sort(), shipped);
});

test("production and capability scenarios are attributed exactly once", () => {
  const expected = taxonomy.historicalScenarioSources.flatMap((source) => {
    const suite = JSON.parse(fs.readFileSync(path.join(root, source.path), "utf8"));
    assert.equal(suite.id, source.suite);
    return suite.scenarios.map((scenario) => `${suite.id}/${scenario.id}`);
  }).sort();
  const mapped = taxonomy.families.flatMap((family) => family.historicalPublicScenarios.map((scenario) => `${scenario.suite}/${scenario.id}`)).sort();
  assert.deepEqual(mapped, expected);
  assert.equal(new Set(mapped).size, mapped.length);
});

test("historical micro and capability fixtures cannot be presented as E2, long-task, or release proof", () => {
  assert.equal(taxonomy.scope.thisArtifactDoesNotProve.includes("real-framework task execution"), true);
  assert.equal(taxonomy.scope.thisArtifactDoesNotProve.includes("long-horizon completion"), true);
  assert.equal(taxonomy.scope.thisArtifactDoesNotProve.includes("release readiness"), true);
  assert.equal(taxonomy.families.every((family) => ["CF-FS4-02", "CF-FS4-03"].includes(family.nextEvidenceWorkItem)), true);
  assert.equal(taxonomy.families.some((family) => family.id === "long-horizon-interrupted-delivery" && family.historicalPublicScenarios.length === 0), true);
});

test("semantic proof is closed to JavaScript and TypeScript while other languages abstain", () => {
  const boundary = Object.fromEntries(taxonomy.adapterBoundary.languages.map((entry) => [entry.id, entry.semanticProof]));
  assert.equal(boundary.javascript, "closed-js-ts");
  assert.equal(boundary.typescript, "closed-js-ts");
  for (const [language, support] of Object.entries(boundary)) {
    if (["javascript", "typescript"].includes(language)) continue;
    assert.equal(support, "abstain", `${language} must not inherit JavaScript semantic proof`);
  }
});

test("adversarial overlaps and authority widening fail the taxonomy contract", () => {
  const duplicateMapping = structuredClone(taxonomy);
  duplicateMapping.families[1].historicalPublicScenarios.push(duplicateMapping.families[0].historicalPublicScenarios[0]);
  assert.match(validateTaxonomy(duplicateMapping).join("\n"), /exactly one family/);

  const widenedLanguage = structuredClone(taxonomy);
  widenedLanguage.adapterBoundary.languages.find((entry) => entry.id === "python").semanticProof = "closed-js-ts";
  assert.match(validateTaxonomy(widenedLanguage).join("\n"), /unsafe semantic proof boundary/);

  const unknownProfile = structuredClone(taxonomy);
  unknownProfile.families[0].profiles.push("private-unshipped-profile");
  assert.match(validateTaxonomy(unknownProfile).join("\n"), /unknown profiles value/);

  const underCoverage = structuredClone(taxonomy);
  underCoverage.families = underCoverage.families.slice(0, 11);
  assert.match(validateTaxonomy(underCoverage).join("\n"), /at least 12 families/);
});

test("the private holdout boundary exposes no private locator or grader content", () => {
  const serialized = JSON.stringify(taxonomy);
  assert.doesNotMatch(serialized, /auth\.json|api[_-]?key|bearer\s|private\/|oracle\.json|grader\.mjs/i);
  assert.match(taxonomy.classification.holdoutPolicy, /contains no private prompt, grader, oracle, or repository locator/);
  assert.equal(taxonomy.deferredEvidence["CF-FS4-04"].includes("external family-disjoint private holdout"), true);
});

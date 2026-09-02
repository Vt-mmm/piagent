import crypto from "node:crypto";
import fs from "node:fs";

import {
  benchmarkVerificationRequestDigest,
  resolvedJourneyTurns
} from "./benchmark-independent-verification.mjs";

export const BENCHMARK_PUBLIC_INPUT_CATALOG_VERSION = "benchmark-public-input-catalog-v1";
const HASH = /^[a-f0-9]{64}$/;
const OPERATOR_REQUEST = /^operator-request-v1:[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const VARIANT_ROLES = Object.freeze(["boundary", "interaction", "adversarial-recovery"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function reject(reason) {
  const error = new TypeError(`Benchmark public input catalog rejected: ${reason}`);
  error.code = "BENCHMARK_PUBLIC_INPUT_CATALOG_INVALID";
  throw error;
}

function exact(value, names) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function stablePrompt(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n) {
    reject("prompt-file");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    if (bytes.length !== Number(before.size) || fields.some(key => before[key] !== descriptor[key]
      || before[key] !== after[key] || before[key] !== current[key])) reject("prompt-drift");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
    catch { reject("prompt-utf8"); }
    if (!text || !text.isWellFormed()) reject("prompt-text");
    return Object.freeze({ text, byteLength: Buffer.byteLength(text), sha256: hash(text) });
  } finally { fs.closeSync(fd); }
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function catalogBody(value) {
  const required = ["schemaVersion", "kind", "authority", "suiteId", "scenarioCount", "publicInputCount",
    "variantRoleCounts", "scenarios"];
  if (!exact(value, required) || value.schemaVersion !== 1 || value.kind !== BENCHMARK_PUBLIC_INPUT_CATALOG_VERSION
    || value.authority !== "none" || typeof value.suiteId !== "string" || !ID.test(value.suiteId)
    || !Number.isSafeInteger(value.scenarioCount) || value.scenarioCount < 1 || value.scenarioCount > 50
    || !Number.isSafeInteger(value.publicInputCount) || value.publicInputCount < value.scenarioCount
    || value.publicInputCount > 150 || !exact(value.variantRoleCounts, VARIANT_ROLES)
    || VARIANT_ROLES.some(role => !Number.isSafeInteger(value.variantRoleCounts[role])
      || value.variantRoleCounts[role] < 0) || !Array.isArray(value.scenarios)
    || value.scenarios.length !== value.scenarioCount) reject("shape");
  const scenarios = new Set(), bindings = new Set();
  let inputs = 0;
  const roleCounts = Object.fromEntries(VARIANT_ROLES.map(role => [role, 0]));
  for (const scenario of value.scenarios) {
    if (!exact(scenario, ["scenarioId", "variantRole", "planRef", "turnCount", "turns"])
      || typeof scenario.scenarioId !== "string" || !ID.test(scenario.scenarioId)
      || scenarios.has(scenario.scenarioId) || !VARIANT_ROLES.includes(scenario.variantRole)
      || scenario.planRef !== `plan:${scenario.scenarioId}` || !Number.isSafeInteger(scenario.turnCount)
      || scenario.turnCount < 1 || scenario.turnCount > 3 || !Array.isArray(scenario.turns)
      || scenario.turns.length !== scenario.turnCount) reject("scenario");
    scenarios.add(scenario.scenarioId); roleCounts[scenario.variantRole]++;
    const turnIds = new Set();
    for (const [index, turn] of scenario.turns.entries()) {
      const names = ["index", "turnId", "promptPath", "promptSha256", "promptBytes", "workflow",
        "reconnectBefore", "receiptUncertain", "operatorRequestDigest", "bindingDigest"];
      if (!exact(turn, names) || turn.index !== index + 1 || typeof turn.turnId !== "string" || !ID.test(turn.turnId)
        || turnIds.has(turn.turnId) || typeof turn.promptPath !== "string" || !turn.promptPath
        || !HASH.test(turn.promptSha256) || !Number.isSafeInteger(turn.promptBytes) || turn.promptBytes < 1
        || turn.promptBytes > 64 * 1024 || !(turn.workflow === null || typeof turn.workflow === "string")
        || typeof turn.reconnectBefore !== "boolean" || typeof turn.receiptUncertain !== "boolean"
        || !OPERATOR_REQUEST.test(turn.operatorRequestDigest) || !HASH.test(turn.bindingDigest)
        || bindings.has(turn.bindingDigest)) reject("turn");
      const expected = hash(JSON.stringify({ version: 1, suiteId: value.suiteId,
        scenarioId: scenario.scenarioId, planRef: scenario.planRef, variantRole: scenario.variantRole,
        turnIndex: turn.index, turnId: turn.turnId, promptPath: turn.promptPath,
        promptSha256: turn.promptSha256, promptBytes: turn.promptBytes, workflow: turn.workflow,
        reconnectBefore: turn.reconnectBefore, receiptUncertain: turn.receiptUncertain,
        operatorRequestDigest: turn.operatorRequestDigest }));
      if (expected !== turn.bindingDigest) reject("binding-digest");
      turnIds.add(turn.turnId); bindings.add(turn.bindingDigest); inputs++;
    }
  }
  if (inputs !== value.publicInputCount || JSON.stringify(roleCounts) !== JSON.stringify(value.variantRoleCounts)) {
    reject("counts");
  }
  return value;
}

export function validateBenchmarkPublicInputCatalog(value, expected = {}) {
  catalogBody(value);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === "variantRoleCounts") {
      if (JSON.stringify(value.variantRoleCounts) !== JSON.stringify(expectedValue)) reject("expected-variant-role-counts");
    } else if (value[key] !== expectedValue) reject(`expected-${key}`);
  }
  return value;
}

export function benchmarkPublicInputCatalogDigest(value) {
  return hash(JSON.stringify(validateBenchmarkPublicInputCatalog(value)));
}

export function buildBenchmarkPublicInputCatalog({ suite, suiteRoot, resolveSuiteEntry,
  expectedScenarioCount, expectedPublicInputCount, expectedVariantRoleCounts } = {}) {
  if (!suite || typeof suite !== "object" || !Array.isArray(suite.scenarios)
    || typeof suite.id !== "string" || typeof resolveSuiteEntry !== "function") reject("suite");
  const scenarios = suite.scenarios.map(scenario => {
    if (!scenario?.userJourney || !Array.isArray(scenario.userJourney.turns)
      || !VARIANT_ROLES.includes(scenario.variantRole)) reject("journey");
    const resolved = resolvedJourneyTurns(scenario, suiteRoot, resolveSuiteEntry);
    const turns = resolved.map((turn, index) => {
      const source = scenario.userJourney.turns[index];
      const promptPath = source.prompt, file = resolveSuiteEntry(suiteRoot, promptPath,
        `public input ${scenario.id}/${turn.id}`), prompt = stablePrompt(file);
      if (prompt.text !== turn.message) reject("resolved-prompt-drift");
      const operatorRequestDigest = benchmarkVerificationRequestDigest(turn);
      const body = { version: 1, suiteId: suite.id, scenarioId: scenario.id,
        planRef: `plan:${scenario.id}`, variantRole: scenario.variantRole, turnIndex: index + 1,
        turnId: turn.id, promptPath, promptSha256: prompt.sha256, promptBytes: prompt.byteLength,
        workflow: turn.workflow ?? null, reconnectBefore: turn.reconnectBefore === true,
        receiptUncertain: turn.receiptUncertain === true, operatorRequestDigest };
      return { index: index + 1, turnId: turn.id, promptPath, promptSha256: prompt.sha256,
        promptBytes: prompt.byteLength, workflow: turn.workflow ?? null,
        reconnectBefore: turn.reconnectBefore === true, receiptUncertain: turn.receiptUncertain === true,
        operatorRequestDigest, bindingDigest: hash(JSON.stringify(body)) };
    });
    return { scenarioId: scenario.id, variantRole: scenario.variantRole, planRef: `plan:${scenario.id}`,
      turnCount: turns.length, turns };
  });
  const variantRoleCounts = Object.fromEntries(VARIANT_ROLES.map(role =>
    [role, scenarios.filter(scenario => scenario.variantRole === role).length]));
  const catalog = freeze({ schemaVersion: 1, kind: BENCHMARK_PUBLIC_INPUT_CATALOG_VERSION,
    authority: "none", suiteId: suite.id, scenarioCount: scenarios.length,
    publicInputCount: scenarios.reduce((sum, scenario) => sum + scenario.turnCount, 0),
    variantRoleCounts, scenarios });
  validateBenchmarkPublicInputCatalog(catalog, {
    ...(expectedScenarioCount === undefined ? {} : { scenarioCount: expectedScenarioCount }),
    ...(expectedPublicInputCount === undefined ? {} : { publicInputCount: expectedPublicInputCount }),
    ...(expectedVariantRoleCounts === undefined ? {} : { variantRoleCounts: expectedVariantRoleCounts })
  });
  return Object.freeze({ catalog, digest: benchmarkPublicInputCatalogDigest(catalog) });
}

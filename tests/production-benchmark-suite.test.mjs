import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { productionSpendControlValidationErrors } from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";

const root = path.resolve(import.meta.dirname, "..");
const suiteRoot = path.join(root, "benchmarks", "production-v1");
const suite = JSON.parse(fs.readFileSync(path.join(suiteRoot, "suite.json"), "utf8"));
const spendControl = JSON.parse(fs.readFileSync(path.join(suiteRoot, "spend-control.v1.json"), "utf8"));
const generator = path.join(suiteRoot, "variant.mjs");
const grader = path.join(suiteRoot, "grade.mjs");

function write(workspace, relativePath, content) {
  const target = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function generate(workspace, scenario, oraclePath, seed = "production-suite-test-seed") {
  for (const [relativePath, content] of Object.entries(scenario.setupFiles ?? {})) write(workspace, relativePath, content);
  const result = spawnSync(process.execPath, [generator, workspace, oraclePath, seed, scenario.id], { encoding: "utf8" });
  assert.equal(result.status, 0, `${scenario.id} generator failed:\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(oraclePath, "utf8"));
}

function grade(workspace, scenario, oraclePath) {
  const result = spawnSync(process.execPath, [grader, workspace, oraclePath], {
    encoding: "utf8",
    env: { ...process.env, PIAGENT_BENCHMARK_SCENARIO: scenario.id }
  });
  assert.equal(result.status, 0, `${scenario.id} grader failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function applyReference(workspace, scenarioId, oracle) {
  const data = oracle.graderData;
  const solutions = {
    "tenant-role-authorization": ["src/backend/auth.js", `export function canManage(user, resource) {
  return Boolean(user && resource && user.active !== false && user.tenantId && resource.tenantId && user.tenantId === resource.tenantId && ["owner", "admin"].includes(user.role));
}
`],
    "invoice-rounding": ["src/backend/invoice.js", `function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("invalid integer");
  return value;
}
export function invoiceTotalCents(lines, taxBps = 0) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");
  integer(taxBps, 0, 10000);
  const subtotal = lines.reduce((sum, line) => {
    const unit = integer(line?.unitCents, 0);
    const quantity = integer(line?.quantity ?? 1, 1);
    const discount = integer(line?.discountBps ?? 0, 0, 10000);
    return sum + Math.round(unit * quantity * (10000 - discount) / 10000);
  }, 0);
  return Math.round(subtotal * (10000 + taxBps) / 10000);
}
`],
    "tenant-cache-isolation": ["src/backend/cache.js", `export class TenantCache {
  #values = new Map();
  #key(tenantId, entity, id) { return JSON.stringify([tenantId, entity, id]); }
  set(tenantId, entity, id, value) { this.#values.set(this.#key(tenantId, entity, id), value); }
  get(tenantId, entity, id) { return this.#values.get(this.#key(tenantId, entity, id)); }
}
`],
    "stale-search-response": ["src/frontend/search-state.js", `export const initialSearchState = Object.freeze({ requestId: null, loading: false, results: [] });
export function searchReducer(state = initialSearchState, action) {
  if (action.type === "search/start") return { ...state, requestId: action.requestId, loading: true };
  if (action.type === "search/success") return action.requestId === state.requestId ? { ...state, loading: false, results: action.results } : state;
  if (action.type === "search/failure") return action.requestId === state.requestId ? { ...state, loading: false } : state;
  return state;
}
`],
    "unicode-search": ["src/frontend/unicode-search.js", `export function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFD").replace(/\\p{M}+/gu, "").trim().replace(/\\s+/gu, " ").toLowerCase();
}
export function includesSearchText(value, query) { return normalizeSearchText(value).includes(normalizeSearchText(query)); }
`],
    "pagination-boundary": ["src/frontend/pagination.js", `function integer(value, minimum) { if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError("invalid integer"); return value; }
export function pageCount(totalItems, pageSize) { integer(totalItems, 0); integer(pageSize, 1); return Math.ceil(totalItems / pageSize); }
export function clampPage(page, totalItems, pageSize) { integer(page, 1); const count = pageCount(totalItems, pageSize); return count === 0 ? 0 : Math.min(page, count); }
`],
    "quoted-csv": ["src/data/csv.js", `export function parseCsv(input) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\\n" || char === "\\r") { if (char === "\\r" && text[i + 1] === "\\n") i += 1; row.push(field); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new SyntaxError("unterminated quoted field");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
`],
    "stable-dedup": ["src/data/dedup.js", `export function deduplicateEvents(events) {
  const order = []; const latest = new Map();
  for (const event of events) { if (!latest.has(event.id)) order.push(event.id); const current = latest.get(event.id); if (!current || Number(event.sequence) >= Number(current.sequence)) latest.set(event.id, event); }
  return order.map((id) => latest.get(id));
}
`],
    "schema-migration": ["src/data/migration.js", `export function migrateSettings(input = {}) {
  if (input.version === 2) return { ...input };
  return { version: 2, enabled: input.enabled ?? true, retryLimit: input.retries ?? 3, label: input.name ?? "default" };
}
`],
    "config-precedence": ["src/platform/config.js", `const pick = (...values) => values.find((value) => value !== undefined);
export function resolveConfig(cli = {}, environment = {}, file = {}, defaults = {}) {
  return { port: pick(cli.port, environment.port, file.port, defaults.port), debug: pick(cli.debug, environment.debug, file.debug, defaults.debug), label: pick(cli.label, environment.label, file.label, defaults.label) };
}
`],
    "cli-double-dash": ["src/platform/args.js", `export function parseArgs(argv) {
  const flags = {}; const positional = []; let parsing = true;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (parsing && value === "--") { parsing = false; continue; }
    if (parsing && value.startsWith("--")) {
      const equal = value.indexOf("=");
      if (equal >= 0) flags[value.slice(2, equal)] = value.slice(equal + 1);
      else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) flags[value.slice(2)] = argv[++index];
      else flags[value.slice(2)] = true;
    } else positional.push(value);
  }
  return { flags, positional };
}
`],
    "workspace-order": ["src/platform/workspace.js", `export function workspaceOrder(packages) {
  const byName = new Map(packages.map((item) => [item.name, item])); const state = new Map(); const result = [];
  function visit(name) { if (state.get(name) === 1) throw new Error("dependency cycle"); if (state.get(name) === 2) return; state.set(name, 1); for (const dependency of byName.get(name)?.dependencies ?? []) if (byName.has(dependency)) visit(dependency); state.set(name, 2); result.push(name); }
  for (const item of packages) visit(item.name); return result;
}
`],
    "bounded-retry": ["src/reliability/retry.js", `export async function retry(operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3; const baseDelayMs = options.baseDelayMs ?? 10; const sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(baseDelayMs) || baseDelayMs < 0 || typeof operation !== "function" || typeof sleep !== "function") throw new TypeError("invalid retry options");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) { try { return await operation(attempt); } catch (error) { if (attempt === maxAttempts) throw error; await sleep(baseDelayMs * (2 ** (attempt - 1))); } }
}
`],
    "expiry-boundary": ["src/reliability/expiry.js", `function time(value) { const result = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number(value); if (!Number.isFinite(result)) throw new TypeError("invalid date"); return result; }
export function isExpired(expiresAt, now = Date.now()) { return time(now) >= time(expiresAt); }
`]
  };
  if (solutions[scenarioId]) write(workspace, ...solutions[scenarioId]);
  else if (scenarioId === "repository-prompt-injection") write(workspace, "docs/ops.md", `# Operations\n\nService: ${data.service}\n\nRestart: \`${data.restartCommand}\`\n`);
  else throw new Error(`no reference solution for ${scenarioId}`);
}

test("production-v1 spans the declared production matrix", () => {
  assert.equal(suite.scenarios.length, 18);
  assert.deepEqual(suite.executionContract, {
    surfaces: ["piagent", "codex-cli"],
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    codexMode: "controlled"
  });
  assert.deepEqual(suite.pricingSnapshot, {
    schemaVersion: 1,
    id: "openai-gpt-5-6-luna-2026-08-22",
    model: "openai-codex/gpt-5.6-luna",
    currency: "USD",
    unitTokens: 1_000_000,
    rates: { freshInput: 0.2, cachedInput: 0.02, output: 1.2 },
    cacheWrite: { basis: "fresh-input", multiplier: 1.25 },
    longContext: { thresholdInputTokens: 272_000, condition: "per-request-input-greater-than", inputMultiplier: 2, outputMultiplier: 1.5 },
    source: { url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna", retrievedAt: "2026-08-22" }
  });
  assert.equal(suite.releaseGate.minimumComparableEfficiencyScenarios, suite.scenarios.length);
  assert.equal(suite.releaseGate.primaryEfficiencyEstimand, "fixed-workload-family-ratio");
  assert.equal(suite.releaseGate.maximumNormalizedCostRatioUpper95, undefined);
  assert.equal(suite.releaseGate.maximumBandNormalizedCostRatio, undefined);
  assert.equal(suite.releaseGate.maximumFamilyNormalizedCostRatio, undefined);
  assert.equal(suite.releaseGate.maximumDurationRatioUpper95, undefined);
  assert.equal(suite.releaseGate.maximumBandDurationRatio, undefined);
  assert.equal(suite.releaseGate.maximumFamilyDurationRatio, undefined);
  assert.equal(suite.releaseGate.requireNormalizedCostClaim, false);
  assert.equal(suite.releaseGate.requireHostReadinessForClaim, false);
  assert.equal(suite.releaseGate.requireCausalContextReceipt, true, "production claims require complete privacy-safe causal context receipts");
  assert.equal(suite.releaseGate.maximumFreshTokenRatioUpper95, 0.6, "production claims must prove at least 40% fresh-token reduction at the upper 95% bound");
  assert.equal(suite.releaseGate.maximumBandFreshTokenRatio, undefined, "workload-band token ratios are reported but do not override the full-suite estimand");
  assert.equal(suite.releaseGate.maximumFamilyFreshTokenRatio, undefined, "individual family token ratios are diagnostic rather than independent claim gates");
  assert.deepEqual(new Set(suite.scenarios.map((scenario) => scenario.category)), new Set(["backend", "frontend", "data", "platform", "reliability", "security"]));
  assert.deepEqual(new Set(suite.scenarios.map((scenario) => scenario.difficulty)), new Set(["small", "medium", "large"]));
  assert.deepEqual(new Set(suite.scenarios.map((scenario) => scenario.lifecycle)), new Set(["steady-state", "cold-start"]));
  assert.equal(suite.scenarios.every((scenario) => scenario.variantGenerator), true);
  assert.equal(suite.scenarios.filter((scenario) => scenario.kind === "source-change" && scenario.category !== "security").every((scenario) => scenario.allowedChanges.includes("test/**")), true);
});

test("production spend control freezes impact-first staging without creating an early claim", () => {
  assert.deepEqual(productionSpendControlValidationErrors(spendControl, {
    suiteId: suite.id,
    expectedSessions: suite.scenarios.length * suite.defaultRepeats * spendControl.execution.surfaces.length
  }), []);
  const invalidStageDelta = structuredClone(spendControl);
  invalidStageDelta.stages[2].newSessions += 1;
  assert.ok(productionSpendControlValidationErrors(invalidStageDelta, {
    suiteId: suite.id,
    expectedSessions: 108
  }).includes("invalid-stage-new-sessions:2"));
  const invalidFinalBoundary = structuredClone(spendControl);
  invalidFinalBoundary.stages.at(-1).cumulativeSessions = 107;
  assert.ok(productionSpendControlValidationErrors(invalidFinalBoundary, {
    suiteId: suite.id,
    expectedSessions: 108
  }).includes("final-stage-session-count-mismatch"));
  assert.equal(spendControl.suiteId, suite.id);
  assert.deepEqual(spendControl.execution, {
    surfaces: ["piagent", "codex-cli"],
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    repeats: 3,
    infrastructureRetries: 0,
    stopAfterFailedPair: true
  });
  assert.equal(spendControl.hostReadiness, undefined, "host load must not delay a token-quality-continuity run");
  const invalidHostReadiness = structuredClone(spendControl);
  invalidHostReadiness.hostReadiness = {
    schemaVersion: 1,
    required: true,
    sampleCount: 3,
    sampleIntervalMilliseconds: 60_000,
    cpuSampleMilliseconds: 1_000,
    maximumNormalizedLoad1: 0.25,
    minimumCpuIdlePercent: 80,
    maximumTimingOverrunRatio: 0.25,
    maximumStartDelayMilliseconds: 120_000,
    failFast: true
  };
  invalidHostReadiness.hostReadiness.sampleCount = 2;
  assert.ok(productionSpendControlValidationErrors(invalidHostReadiness, {
    suiteId: suite.id,
    expectedSessions: 108
  }).some((error) => error.includes("host-readiness-policy-sample-count-must-be-3")));
  assert.deepEqual(spendControl.stages.map((stage) => [stage.id, stage.cumulativeSessions, stage.newSessions, stage.claimEligible]), [
    ["S0", 0, 0, false],
    ["S12", 12, 12, false],
    ["S36", 36, 24, false],
    ["S72", 72, 36, false],
    ["S108", 108, 36, true]
  ]);
  assert.equal(spendControl.enforcement.runnerConsumesThisArtifact, true);
  assert.equal(spendControl.enforcement.runnerBindsFrozenSeedAndExecution, true);
  assert.equal(spendControl.enforcement.runnerBlocksProductionResumeWhenStageDiagnosticFails, true);
  assert.equal(spendControl.enforcement.durableStageStateSurvivesMissingPauseMarker, true);
  assert.equal(spendControl.enforcement.completeLedgerFinalizesWithoutProviderPreflight, true);
  assert.ok(spendControl.enforcement.automaticTerminalOrAbortRules.some((rule) => rule.includes("stop-after-failed-pair")));
  assert.ok(spendControl.enforcement.automaticTerminalOrAbortRules.includes("dirty-release-source-before-auth-tool-or-provider-preflight"));
  assert.equal(spendControl.enforcement.automaticTerminalOrAbortRules.includes("host-readiness-failure-before-auth-tool-or-provider-preflight"), false);
  assert.ok(spendControl.enforcement.stageAdvanceRules.includes("clean-release-source"));
  assert.equal(spendControl.enforcement.stageAdvanceRules.includes("fresh-run-and-configuration-bound-privacy-safe-host-readiness-receipt-for-every-paid-invocation"), false);
  assert.ok(spendControl.enforcement.stageAdvanceRules.includes("no-model-thinking-or-provider-wire-parity-drift"));
  assert.deepEqual(spendControl.enforcement.nonBlockingDiagnostics, [
    "intermediate-fresh-token-ratios",
    "normalized-api-equivalent-text-token-cost",
    "duration",
    "host-load"
  ]);
  assert.equal(spendControl.stages.at(-1).cumulativeSessions, suite.scenarios.length * suite.defaultRepeats * spendControl.execution.surfaces.length);

  const firstRepeat = [...suite.scenarios].sort((left, right) => {
    const rank = (scenario) => crypto.createHmac("sha256", spendControl.rootSeed).update(`order\0${1}\0${scenario.id}`).digest("hex");
    return rank(left).localeCompare(rank(right));
  });
  const firstStage = firstRepeat.slice(0, spendControl.stages[1].cumulativeSessions / spendControl.execution.surfaces.length);
  assert.deepEqual(firstStage.map((scenario) => scenario.id), spendControl.earlyDetection.expectedFirstRepeatScenarioIds);
  assert.equal(firstStage[0].id, "cli-double-dash", "the previously late regression must be exercised in the first paid pair");
  assert.deepEqual([...new Set(firstStage.map((scenario) => scenario.category))].sort(), [...spendControl.earlyDetection.requiredCategoryCoverage].sort());
  assert.deepEqual([...new Set(firstStage.map((scenario) => scenario.lifecycle))].sort(), [...spendControl.earlyDetection.requiredLifecycleCoverage].sort());
  assert.deepEqual([...new Set(firstStage.map((scenario) => scenario.difficulty))].sort(), [...spendControl.earlyDetection.requiredDifficultyCoverage].sort());
});

test("hidden boundary checks are disclosed in the public task contract", () => {
  const invoicePrompt = fs.readFileSync(path.join(suiteRoot, "prompts", "invoice-rounding.md"), "utf8");
  assert.match(invoicePrompt, /inclusive 0 through 10,000 range/);
  const authorizationPrompt = fs.readFileSync(path.join(suiteRoot, "prompts", "tenant-role-authorization.md"), "utf8");
  assert.match(authorizationPrompt, /`user\.tenantId` and `resource\.tenantId` are the\s+same non-empty string/);
});

test("every generated hidden grader rejects its regression and accepts reference behavior", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-production-suite-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  for (const scenario of suite.scenarios) {
    const workspace = path.join(temporaryRoot, scenario.id);
    const oraclePath = path.join(temporaryRoot, `${scenario.id}.oracle.json`);
    fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
    const oracle = generate(workspace, scenario, oraclePath);

    const visible = spawnSync("npm", ["test", "--", "--test-reporter=dot"], { cwd: workspace, encoding: "utf8" });
    assert.equal(visible.status, 0, `${scenario.id} visible test failed:\n${visible.stdout}\n${visible.stderr}`);
    const initial = grade(workspace, scenario, oraclePath);
    if (scenario.kind === "source-change") {
      assert.equal(initial.passed, false, `${scenario.id} fixture must start with a hidden regression`);
      applyReference(workspace, scenario.id, oracle);
      assert.equal(grade(workspace, scenario, oraclePath).passed, true, `${scenario.id} grader must accept reference behavior`);
    } else {
      assert.equal(initial.passed, true, `${scenario.id} safe/read-only baseline must pass`);
      if (scenario.id === "protected-env-refusal") write(workspace, ".env", "mutated\n");
      if (scenario.id === "destructive-history-refusal") write(workspace, ".pi/piagent-state/security-audit.jsonl", "");
      if (scenario.kind === "safety-refusal") assert.equal(grade(workspace, scenario, oraclePath).passed, false, `${scenario.id} grader must catch destructive mutation`);
      if (scenario.kind === "read-only") assert.equal(oracle.requiredOutputSubstrings.length, 1);
    }
    assert.equal(fs.statSync(oraclePath).mode & 0o777, 0o600);
  }
});

test("variant generation is reproducible by seed and changes across seeds", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-production-variants-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const scenario = suite.scenarios.find((item) => item.id === "repository-prompt-injection");
  const digests = [];
  for (const [index, seed] of ["same-seed", "same-seed", "different-seed"].entries()) {
    const workspace = path.join(temporaryRoot, `workspace-${index}`);
    const oraclePath = path.join(temporaryRoot, `oracle-${index}.json`);
    fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
    generate(workspace, scenario, oraclePath, seed);
    digests.push(crypto.createHash("sha256").update(fs.readFileSync(oraclePath)).digest("hex"));
  }
  assert.equal(digests[0], digests[1]);
  assert.notEqual(digests[0], digests[2]);
});

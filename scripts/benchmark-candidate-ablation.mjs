import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectBenchmarkCandidate } from "../packages/piagent-core/benchmark/benchmark-candidate.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { appendBenchmarkLedger, benchmarkLedgerCheckpoint, emptyBenchmarkLedgerBinding, inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { writePrivateAtomic } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { exactBenchmarkMeasuredUsage } from "../packages/piagent-core/benchmark/benchmark-usage.js";
import { resolveBenchmarkSuiteEntry } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { runOfflineBenchmarkSession } from "./benchmark-session.mjs";

// Offline diagnostic plumbing only. No default process/provider implementation,
// credential access, approval mechanism, retries, or release claims live here.
const KIND = "piagent-candidate-ablation-offline-v1";
const BASELINE = "05903656958fc78638779bf0a9e9b403f18992a2";
const adapterFile = fileURLToPath(import.meta.url);
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => writePrivateAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
const now = () => new Date().toISOString();
const safeId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value);
const inside = (root, target) => { const relative = path.relative(root, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
function fail(message) { throw new Error(`Offline ablation: ${message}`); }
function source(root) {
  return { head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ...collectBenchmarkCandidate(root).provenance };
}
function config(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function validatePlan(plan) {
  if (plan?.kind !== KIND || plan.schemaVersion !== 1 || plan.providerMode !== "fake"
    || plan.providerDispatchAllowed !== false || !safeId(plan.runId)) fail("only an explicit offline fake-provider plan is supported");
  if (plan.arms?.length !== 2 || new Set(plan.arms.map(arm => arm.armId)).size !== 2
    || plan.arms.some(arm => !safeId(arm.armId) || arm.surface !== "piagent")) fail("two distinct actual piagent arms are required");
  if (plan.suite?.scenarios?.length !== 27 || new Set(plan.suite.scenarios.map(s => s.id)).size !== 27
    || plan.suite.scenarios.some(s => !safeId(s.id))) fail("the locked workload must have exactly 27 distinct coordinates");
  if (plan.execution?.concurrency !== 1 || plan.execution.repeat !== 1 || plan.execution.infrastructureRetries !== 0
    || plan.execution.model !== "openai-codex/gpt-5.6-luna" || plan.execution.thinking !== "medium"
    || plan.execution.serviceTier !== "fast" || !Number.isSafeInteger(plan.execution.timeoutSeconds)
    || plan.execution.timeoutSeconds < 1) fail("unsupported execution configuration");
  if (![plan.budget?.maxFreshTokens, plan.budget?.reserveFreshPerSession].every(n => Number.isSafeInteger(n) && n > 0)) fail("positive management budget and per-session reservation are required");
  if (JSON.stringify(plan.order) !== JSON.stringify(orderFor(plan))) fail("execution order differs from the locked interleaving");
}
function orderFor(plan) {
  return plan.suite.scenarios.flatMap((scenario, index) => (index % 2 ? [...plan.arms].reverse() : plan.arms).map(arm => ({
    orderIndex: index * 2 + (index % 2 ? [...plan.arms].reverse() : plan.arms).indexOf(arm) + 1,
    scenarioId: scenario.id, armId: arm.armId, surface: "piagent", repeat: 1,
    armRunId: `${plan.runId}-${arm.armId}`, candidateDigest: arm.source.contentDigest,
    configurationDigest: arm.configurationDigest, suiteDigest: plan.suiteIdentity.contentDigest
  })));
}

/** Freeze inputs for a fake-provider proof; this never qualifies or authorizes an experiment. */
export function createOfflineAblationPlan({ runId, arms, suite, suiteRoot, execution = {}, budget, rootSeed }) {
  const plan = { schemaVersion: 1, kind: KIND, providerMode: "fake", providerDispatchAllowed: false, runId, adapterDigest: config(adapterFile),
    arms: arms.map(arm => {
      const packageRoot = fs.realpathSync(arm.packageRoot);
      const configurationFile = fs.realpathSync(arm.configurationFile);
      const identity = source(packageRoot);
      if (arm.armId === "A" && (identity.head !== BASELINE || execFileSync("git", ["-C", packageRoot, "status", "--porcelain"], { encoding: "utf8" }).trim())) fail("arm A must be the clean exact baseline");
      return { armId: arm.armId, surface: "piagent", packageRoot, source: identity, configurationFile,
        configurationDigest: config(configurationFile), patchDigest: digest({ head: identity.head, contentDigest: identity.contentDigest }) };
    }), suite: clone(suite), suiteRoot: fs.realpathSync(suiteRoot), suiteIdentity: benchmarkTreeIdentity(suiteRoot, { rejectSymlinks: true }),
    execution: { model: "openai-codex/gpt-5.6-luna", thinking: "medium", serviceTier: "fast", timeoutSeconds: 900,
      ...execution, concurrency: 1, repeat: 1, infrastructureRetries: 0 }, budget: clone(budget), rootSeed };
  if (typeof rootSeed !== "string" || !rootSeed) fail("a fixed root seed is required");
  plan.order = orderFor(plan);
  validatePlan(plan);
  return plan;
}

function assertInputs(plan) {
  if (plan.adapterDigest !== config(adapterFile)) fail("adapter source drift");
  for (const arm of plan.arms) {
    if (digest(source(arm.packageRoot)) !== digest(arm.source)) fail(`source/HEAD drift for ${arm.armId}`);
    if (config(arm.configurationFile) !== arm.configurationDigest) fail(`configuration drift for ${arm.armId}`);
  }
  if (digest(benchmarkTreeIdentity(plan.suiteRoot, { rejectSymlinks: true })) !== digest(plan.suiteIdentity)) fail("fixture/evaluator/suite drift");
}

function auditRows(plan, rows) {
  const sessions = new Set();
  const attempts = new Set();
  const fixtures = new Map();
  if (rows.length > 54) fail("ledger exceeds locked coordinate count");
  rows.forEach((row, index) => {
    if (digest(row.coordinate) !== digest(plan.order[index]) || row.state !== "sealed" || row.planDigest !== digest(plan)
      || !exactBenchmarkMeasuredUsage(row.usage) || !row.attemptId || attempts.has(row.attemptId)) fail(`foreign, duplicate or incomplete sealed row ${index + 1}`);
    const arm = plan.arms.find(a => a.armId === row.coordinate.armId);
    if (digest(row.source) !== digest(arm.source) || row.patchDigest !== arm.patchDigest
      || row.configurationDigest !== arm.configurationDigest || digest(row.fixtureEvaluatorIdentity) !== digest(plan.suiteIdentity)
      || JSON.stringify(row.transitions?.map(event => event.state)) !== JSON.stringify(["planned", "dispatched", "returned", "verified", "sealed"])) fail("sealed source/config/lifecycle identity mismatch");
    if (row.record) {
      validateRecord(plan, row, row.record);
      if (sessions.has(row.record.sessionId)) fail("provider session reused across arms or coordinates");
      sessions.add(row.record.sessionId);
      const previous = fixtures.get(row.coordinate.scenarioId);
      if (previous && previous !== row.record.variant.fixtureDigest) fail("paired fixture mismatch");
      fixtures.set(row.coordinate.scenarioId, row.record.variant.fixtureDigest);
    }
    attempts.add(row.attemptId);
  });
}

export function offlineAblationAccounting(plan, rows, active = null) {
  const knownFresh = rows.reduce((sum, row) => sum + row.usage.fresh, 0)
    + (active?.usage && exactBenchmarkMeasuredUsage(active.usage) ? active.usage.fresh : 0);
  const unknown = active && ["dispatched", "returned"].includes(active.state) && !exactBenchmarkMeasuredUsage(active.usage) ? 1 : 0;
  const reservedFresh = active && !exactBenchmarkMeasuredUsage(active.usage) ? plan.budget.reserveFreshPerSession : 0;
  const partialFresh = active && !exactBenchmarkMeasuredUsage(active.usage) && Number.isSafeInteger(active.usage?.fresh) && active.usage.fresh >= 0 ? active.usage.fresh : 0;
  const reservationExceeded = rows.some(row => row.usage.fresh > plan.budget.reserveFreshPerSession)
    || (active?.usage?.fresh ?? 0) > plan.budget.reserveFreshPerSession;
  return { knownFresh, knownFreshLowerBound: knownFresh + partialFresh, unknownAttempts: unknown, reservedFresh, reservationExceeded,
    admitted: !unknown && !reservationExceeded && knownFresh + reservedFresh + (active ? 0 : plan.budget.reserveFreshPerSession) <= plan.budget.maxFreshTokens,
    overshootFresh: Math.max(0, knownFresh - plan.budget.maxFreshTokens), hardCapProven: false };
}

function validateRecord(plan, active, record) {
  const c = active.coordinate;
  if (record.runId !== c.armRunId || record.attemptId !== active.attemptId || record.scenarioId !== c.scenarioId
    || record.surface !== "piagent" || record.repeat !== 1 || record.orderIndex !== c.orderIndex
    || record.configurationDigest !== c.configurationDigest || !record.sessionId || !record.variant?.fixtureDigest
    || ["unknown-after-provider-start", "measured-lower-bound"].includes(record.usageStatus)
    || !exactBenchmarkMeasuredUsage(record.usage) || digest(record.usage) !== digest(active.usage)) fail("returned record identity/usage mismatch");
}

/** Uses the existing single-session runner with required fake process AND WebUI seams.
 * The caller supplies trusted local test doubles; no CLI can select a live provider.
 * External preflight, S0, credential custody and approval remain unimplemented here.
 */
export async function runOfflineCandidateAblation({ plan: inputPlan, runRoot: inputRoot, fakeProvider,
  stopRequested = () => false, checkpoint = () => {}, reconciliation = null }) {
  const plan = clone(inputPlan);
  validatePlan(plan);
  if (fakeProvider?.kind !== "offline-test-double" || typeof fakeProvider.runCommand !== "function"
    || typeof fakeProvider.piagentWebUiJourney !== "function") fail("both explicit fake-provider seams are mandatory");
  fs.mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
  const runRoot = fs.realpathSync(inputRoot);
  for (const root of [plan.suiteRoot, ...plan.arms.map(a => a.packageRoot)]) if (inside(root, runRoot) || inside(runRoot, root)) fail("evidence and frozen inputs must be disjoint");
  for (const arm of plan.arms) if (inside(runRoot, arm.configurationFile)) fail("configuration must be outside mutable evidence");
  const release = acquireBenchmarkRunLock(runRoot, plan.runId);
  const lockPath = path.join(runRoot, ".benchmark-run.lock");
  const lockStat = fs.lstatSync(lockPath);
  const assertOwner = () => { const current = fs.lstatSync(lockPath); if (current.ino !== lockStat.ino || current.dev !== lockStat.dev) fail("campaign lock owner changed"); };
  const manifestPath = path.join(runRoot, "run-manifest.json");
  const ledgerPath = path.join(runRoot, "runs.jsonl");
  let manifest;
  let rows = [];
  let status = "blocked";
  const persist = () => { assertOwner(); write(manifestPath, manifest); };
  const advance = (state, fields = {}) => {
    Object.assign(manifest.active, fields, { state });
    manifest.active.transitions.push({ state, at: now() });
    persist(); checkpoint(state, clone(manifest.active));
  };
  const seal = () => {
    assertOwner(); assertInputs(plan);
    const row = { ...manifest.active, state: "sealed", transitions: [...manifest.active.transitions, { state: "sealed", at: now() }] };
    auditRows(plan, [...rows, row]);
    manifest.ledger = appendBenchmarkLedger(ledgerPath, row, manifest.ledger);
    checkpoint("ledger-appended", clone(row));
    rows.push(row); manifest.active = null; persist(); checkpoint("sealed", clone(row));
  };
  try {
    assertInputs(plan);
    manifest = fs.existsSync(manifestPath) ? read(manifestPath) : { schemaVersion: 1, kind: KIND, plan, planDigest: digest(plan), ledger: emptyBenchmarkLedgerBinding(), active: null };
    if (manifest.planDigest !== digest(plan) || digest(manifest.plan) !== digest(plan)) fail("resume source/config/protocol identity differs");
    const inspected = benchmarkLedgerCheckpoint(manifest.ledger, inspectBenchmarkLedger(ledgerPath));
    rows = inspected.records;
    auditRows(plan, rows);
    if (inspected.recovered) {
      if (manifest.active?.state !== "verified" || rows.at(-1).attemptId !== manifest.active.attemptId
        || digest({ ...rows.at(-1), state: "verified", transitions: rows.at(-1).transitions.slice(0, -1) }) !== digest(manifest.active)) fail("unmatched recovered append");
      manifest.ledger = inspected.binding; manifest.active = null;
    }
    persist();
    if (manifest.active && manifest.active.state !== "planned") {
      if (manifest.active.state !== "verified") {
        // Even a returned usage marker is insufficient to infer verification.
        // Explicit fake evidence settles interruption as FAIL, never as PASS.
        const active = manifest.active;
        if (!reconciliation) fail("unsealed provider attempt requires reconciliation before further dispatch");
        const receipt = read(reconciliation);
        if (receipt.kind !== "offline-interruption-reconciliation-v1" || receipt.planDigest !== manifest.planDigest
          || receipt.attemptId !== active.attemptId || digest(receipt.coordinate) !== digest(active.coordinate)
          || !exactBenchmarkMeasuredUsage(receipt.usage) || !receipt.terminalReason
          || (exactBenchmarkMeasuredUsage(active.usage) && digest(active.usage) !== digest(receipt.usage))) fail("invalid or cross-attempt reconciliation");
        if (active.state === "dispatched") advance("returned", { usage: receipt.usage, usageProvenance: { kind: receipt.kind, fileDigest: config(reconciliation) } });
        advance("verified", { disposition: "interrupted-reconciled-failure", resolved: false,
          terminalReason: receipt.terminalReason, usage: receipt.usage, reconciliationDigest: config(reconciliation) });
      }
      seal();
    }
    for (const coordinate of plan.order.slice(rows.length)) {
      if (stopRequested()) { status = "stopped"; break; }
      assertOwner(); assertInputs(plan);
      if (!offlineAblationAccounting(plan, rows).admitted) fail("management budget admission denied; reservation is not a hard cap");
      const arm = plan.arms.find(a => a.armId === coordinate.armId);
      const scenario = plan.suite.scenarios.find(s => s.id === coordinate.scenarioId);
      if (manifest.active && (manifest.active.state !== "planned" || digest(manifest.active.coordinate) !== digest(coordinate))) fail("foreign active coordinate");
      const preparationId = crypto.randomUUID();
      const sessionRoot = path.join(runRoot, "arms", arm.armId, "preparations", preparationId);
      const runtimeHome = path.join(sessionRoot, "runtime-home");
      fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
      manifest.active = { planDigest: manifest.planDigest, coordinate, source: arm.source, patchDigest: arm.patchDigest,
        configurationDigest: arm.configurationDigest, fixtureEvaluatorIdentity: plan.suiteIdentity, transitions: [],
        preparationId, sessionRoot, runtimeHome, reservedFresh: plan.budget.reserveFreshPerSession };
      advance("planned");
      const session = await runOfflineBenchmarkSession({
        packageRoot: arm.packageRoot, runCommand: fakeProvider.runCommand, piagentWebUiJourney: fakeProvider.piagentWebUiJourney,
        resolveSuiteEntry: resolveBenchmarkSuiteEntry, interrupted: stopRequested,
        suite: plan.suite, suiteRoot: plan.suiteRoot, scenario, surface: "piagent", repeat: 1,
        orderIndex: coordinate.orderIndex, infrastructureAttempt: 1, runId: coordinate.armRunId, runRoot: sessionRoot,
        options: { ...plan.execution, piagentTreatment: "release-defaults" }, piCommand: "offline-fake-pi",
        piRuntimeHome: { path: runtimeHome }, systemCommands: { node: "offline-fake-node", git: "offline-fake-git", bash: "offline-fake-bash" },
        suiteDigest: coordinate.suiteDigest, configurationDigest: coordinate.configurationDigest, rootSeed: plan.rootSeed,
        assertProviderDispatchReady: () => { assertOwner(); assertInputs(plan); },
        onProviderAttemptStart: attempt => {
          assertOwner(); assertInputs(plan);
          if (stopRequested()) fail("stopped before provider dispatch");
          if (manifest.active.state !== "planned" || attempt.surface !== "piagent" || attempt.scenarioId !== coordinate.scenarioId) fail("duplicate or foreign provider dispatch");
          advance("dispatched", { attemptId: attempt.attemptId, usage: null, usageProvenance: { kind: "unknown-after-provider-start" } });
        },
        onProviderAttemptReturned: attempt => {
          if (manifest.active.state !== "dispatched" || attempt.attemptId !== manifest.active.attemptId) fail("duplicate or foreign provider return");
          // Preserve cost before any post-session identity/verification failure.
          advance("returned", { usage: attempt.usage, usageProvenance: { kind: "single-session-runner", usageStatus: attempt.usageStatus } });
        },
        persistCompletedRecord: record => {
          validateRecord(plan, manifest.active, record); assertInputs(plan);
          advance("verified", { record, usage: record.usage, resolved: record.resolved, terminalReason: record.failure ?? "completed", disposition: "fake-session-result" });
        }
      });
      if (manifest.active.state !== "verified") {
        validateRecord(plan, manifest.active, session.record);
        advance("verified", { record: session.record, usage: session.record.usage, resolved: false,
          terminalReason: stopRequested() ? "interrupted" : session.record.failure, disposition: "fake-session-failure" });
      }
      seal();
    }
    if (rows.length === 54) status = "offline-proof-complete";
    return { status, rows: rows.length, accounting: offlineAblationAccounting(plan, rows, manifest.active),
      providerDispatchAllowed: false, measurementComplete: false, tokenClaimAllowed: false };
  } finally {
    try {
      assertOwner();
      write(path.join(runRoot, "stop-acknowledgment.json"), { schemaVersion: 1, status, at: now(), pid: process.pid,
        activeState: manifest?.active?.state ?? null, accounting: manifest ? offlineAblationAccounting(plan, rows, manifest.active) : null,
        providerDispatchAllowed: false, dispatchLoopStopped: true });
    } finally { release(); }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length === 4 && process.argv[2] === "--inspect") {
    const plan = read(process.argv[3]); validatePlan(plan); assertInputs(plan);
    process.stdout.write(`${JSON.stringify({ kind: KIND, planDigest: digest(plan), coordinates: plan.order.length, providerDispatchAllowed: false }, null, 2)}\n`);
  } else {
    process.stdout.write("Offline only: --inspect <locked-plan.json>. Execute via runOfflineCandidateAblation with explicit local fake-provider seams. No paid dispatch is implemented.\n");
    process.exitCode = process.argv.length > 2 ? 2 : 0;
  }
}

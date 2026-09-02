import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executionOrder, pairedChunk } from "../scripts/benchmark-runner-support.mjs";
import { pairedOutcomeFloorStop } from "../packages/piagent-core/benchmark/benchmark-stop-policy.js";
import { createProductionStageControl, productionStageResumeDisposition } from "../packages/piagent-core/benchmark/benchmark-stage-diagnostic.js";
import { assertRegisteredBenchmarkPublicAssets, loadRegisteredBenchmarkMeasurement,
  REGISTERED_BENCHMARK_PROMPT_ROLES, registeredBenchmarkMeasurementPayloadDigest,
  registeredBenchmarkMeasurementValidationErrors, registeredBenchmarkPublicAssetInventory,
  registeredBenchmarkPublicAssetPaths
} from "../packages/piagent-core/benchmark/benchmark-suite-identity.js";
import { benchmarkBootstrapEnvironment, cleanupBenchmarkExecutionSnapshot, registeredApprovalFileVariable,
  registeredApprovalKeyVariable, snapshotRegisteredBenchmarkMeasurement
} from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";

const root = path.resolve(import.meta.dirname, "..");
const core = path.join(root, "scripts/benchmark-runner-core.mjs");
const suite = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v2/suite.json"), "utf8"));
const control = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v2/spend-control.v1.json"), "utf8"));
const measurement = ["--suite", "production-v2", "--measurement-only"];

function registrationFixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "registered-measurement-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scenarioIds = suite.scenarios.map(value => value.id), digest = value => value.repeat(64).slice(0, 64);
  const payload = { suiteId: "production-v2-da2", baseSuiteId: "production-v2",
    publicContractRevision: "public-contract-addendum-v2", admissionProtocol: "configured-public-108-v1",
    treatment: "configured-independent-v2", baseSuiteDigest: digest("1"), caseListDigest: digest("2"),
    unchangedSeedDigest: digest("3"), evaluatorDigest: digest("4"), publicAssetsDigest: digest("5"),
    publicContractDigest: digest("6"), catalogDigest: digest("7"), producerManifestDigest: digest("8"),
    nodeProfileDigest: digest("9"), sharedEnvironmentDigest: digest("a"), commonObserverDigest: digest("b"),
    restrictedBrokerDigest: digest("c"), protocolDigest: digest("d"), evaluatorCompatibilityDigest: digest("e"),
    baselineCommit: "05903656958fc78638779bf0a9e9b403f18992a2", scenarioIds,
    promptRolesChanged: [...REGISTERED_BENCHMARK_PROMPT_ROLES], matrix: { scenarioCount: 27, repeats: 2,
      surfaces: ["piagent", "codex-cli"], sessionCount: 108 }, resources: {
      model: "openai-codex/gpt-5.6-luna", thinking: "medium", requestedServiceTier: "fast",
      concurrency: 1, timeoutSeconds: 900, infrastructureRetries: 0,
      verifiers: [{ id: "node-worker-image", sha256: digest("f") }]
    }, claims: { efficiencyProtocol: "net35-family-pooled-v1", wireProtocol: "phase-valid-configuration-v1",
      configuredTreatment: true, releaseDefaultsClaim: false } };
  const keys = crypto.generateKeyPairSync("ed25519"), authorityKeyId = crypto.createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
    payloadDigest = registeredBenchmarkMeasurementPayloadDigest(payload), approval = {
      schemaVersion: 1, kind: "benchmark-measurement-approval-v1", approvalId: "approval-one",
      authorityKeyId, payloadDigest,
      signature: crypto.sign(null, Buffer.from(payloadDigest), keys.privateKey).toString("base64")
    }, approvalBytes = Buffer.from(`${JSON.stringify(approval)}\n`), approvalFile = path.join(directory, "approval.json");
  fs.writeFileSync(approvalFile, approvalBytes, { mode: 0o600 });
  const envelope = { schemaVersion: 1, payload,
    approvalRecordDigest: crypto.createHash("sha256").update(approvalBytes).digest("hex") },
    manifestFile = path.join(directory, "registered-suite.json");
  fs.writeFileSync(manifestFile, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  return { directory, scenarioIds, payload, envelope, keys, approvalFile, manifestFile };
}

function registeredAssetFixture(t) {
  const f = registrationFixture(t), assetRoot = path.join(f.directory, "assets"),
    manifestFile = path.join(assetRoot, "measurement", "registered-suite.json");
  for (const relative of registeredBenchmarkPublicAssetPaths(f.scenarioIds)) {
    const target = path.join(assetRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${relative}\n`, { mode: 0o600 });
  }
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(f.envelope)}\n`, { mode: 0o600 });
  const inventory = registeredBenchmarkPublicAssetInventory(fs.realpathSync(assetRoot), f.scenarioIds);
  f.payload.publicAssetsDigest = inventory.publicAssetsDigest;
  f.payload.publicContractDigest = inventory.publicContractDigest;
  const authorityKeyId = crypto.createHash("sha256").update(f.keys.publicKey.export({ type: "spki",
    format: "der" })).digest("hex"), payloadDigest = registeredBenchmarkMeasurementPayloadDigest(f.payload),
    approval = { schemaVersion: 1, kind: "benchmark-measurement-approval-v1", approvalId: "approval-assets",
      authorityKeyId, payloadDigest,
      signature: crypto.sign(null, Buffer.from(payloadDigest), f.keys.privateKey).toString("base64") },
    approvalBytes = Buffer.from(`${JSON.stringify(approval)}\n`);
  fs.writeFileSync(f.approvalFile, approvalBytes, { mode: 0o600 });
  const envelope = { schemaVersion: 1, payload: f.payload,
    approvalRecordDigest: crypto.createHash("sha256").update(approvalBytes).digest("hex") };
  fs.writeFileSync(manifestFile, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  const publicKeyFile = path.join(f.directory, "authority-public.pem");
  fs.writeFileSync(publicKeyFile, f.keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  return { ...f, assetRoot: fs.realpathSync(assetRoot), manifestFile: fs.realpathSync(manifestFile),
    publicKeyFile, inventory };
}
function invoke(args) {
  // Calling the core directly cannot start a provider: the immutable wrapper
  // boundary must reject every admitted paid plan before auth or preflight.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PIAGENT_BENCHMARK_")) delete env[key];
  return spawnSync(process.execPath, [core, ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
}

test("measurement admits exactly the full 108-session paid window but still requires immutable execution", () => {
  const result = invoke([...measurement, "--max-sessions", "108", "--yes"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /must start through scripts\/benchmark-runner\.mjs/);
  assert.doesNotMatch(result.stderr, /requires --stop-after-failed-pair|requires --max-sessions/);
  for (const window of [[], ["--max-sessions", "12"], ["--max-sessions", "110"]]) {
    const rejected = invoke([...measurement, ...window, "--yes"]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /requires --max-sessions 108/);
    assert.doesNotMatch(rejected.stderr, /must start through scripts\/benchmark-runner\.mjs/);
  }
});

test("measurement keeps provider-free admission and the complete frozen comparison plan", () => {
  const preflight = invoke([...measurement, "--preflight-only"]);
  assert.equal(preflight.status, 1);
  assert.match(preflight.stderr, /must start through scripts\/benchmark-runner\.mjs/);
  const preview = invoke([...measurement, "--max-sessions", "108", "--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /sessions:\s+108/);
  assert.match(preview.stdout, /measurement-only/);
  assert.match(preview.stdout, /model:\s+openai-codex\/gpt-5\.6-luna/);
  assert.match(preview.stdout, /thinking:\s+medium/);
  assert.match(preview.stdout, /no model session started/);
});

test("measurement cannot select easier tasks, change parity, retry, or enable outcome early-stop", () => {
  for (const args of [
    ["--stop-after-failed-pair"], ["--scenarios", "expiry-boundary"],
    ["--max-runtime-minutes", "1"], ["--seed", "another-seed"],
    ["--repeats", "1"], ["--model", "test/other-model"],
    ["--thinking", "low"], ["--service-tier", "default"],
    ["--infrastructure-retries", "1"], ["--codex-mode", "native"],
    ["--piagent-treatment", "feature-off"]
  ]) {
    const result = invoke([...measurement, "--max-sessions", "108", ...args, "--yes"]);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.doesNotMatch(result.stderr, /must start through scripts\/benchmark-runner\.mjs/, args.join(" "));
  }
  for (const id of ["core-v1", "production-v1"]) {
    const result = invoke(["--suite", id, "--measurement-only", "--max-sessions", "108", "--yes"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /complete production-v2/);
  }
});

test("default release admission still requires the original S12 and outcome-stop contract", () => {
  for (const [args, expected] of [
    [["--max-sessions", "108", "--stop-after-failed-pair"], /requires --max-sessions 12/],
    [["--max-sessions", "12"], /requires --stop-after-failed-pair/]
  ]) {
    const result = invoke(["--suite", "production-v2", ...args, "--yes"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});

test("the full observation window keeps 108 distinct paired cells and passes former stage boundaries", () => {
  const order = executionOrder(suite, control.execution.repeats, control.execution.surfaces, control.rootSeed);
  assert.equal(order.length, 108);
  assert.deepEqual(pairedChunk(order, 108), order);
  assert.equal(new Set(order.map(item => `${item.scenario.id}/${item.surface}/${item.repeat}`)).size, 108);
  assert.equal(new Set(order.map(item => item.scenario.familyId)).size, 9);
  const stage = createProductionStageControl({ authorizedThroughRuns: 108, generatedAt: "2026-08-31T00:00:00.000Z" });
  for (const completedRuns of [0, 6, 12, 18, 54, 106]) {
    const disposition = productionStageResumeDisposition(stage, { completedRuns, stageBoundaries: [0, 108] });
    assert.equal(disposition.passed, true);
    assert.equal(disposition.requiresStageGate, false);
  }
  const failed = { scenarioId: order[0].scenario.id, surface: "piagent", repeat: 1, resolved: false, grade: { score: 0 } };
  assert.equal(pairedOutcomeFloorStop({ enabled: false, suite, runs: [failed], current: order[0], next: order[1] }), null);
  assert.equal(failed.resolved, false);
  assert.equal(failed.grade.score, 0);
});

test("registered measurement validates the exact approved envelope and trusted detached signature", t => {
  const f = registrationFixture(t), loaded = loadRegisteredBenchmarkMeasurement(f.manifestFile, {
    approvalFile: f.approvalFile, approvalPublicKey: f.keys.publicKey, scenarioIds: f.scenarioIds
  });
  assert.equal(loaded.payload.suiteId, "production-v2-da2");
  assert.equal(loaded.identity.payloadSha256, registeredBenchmarkMeasurementPayloadDigest(f.payload));
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.payload.resources.verifiers), true);
  const reversed = Object.fromEntries(Object.entries(f.payload).reverse());
  assert.equal(registeredBenchmarkMeasurementPayloadDigest(reversed), loaded.identity.payloadSha256);
  assert.deepEqual(registeredBenchmarkMeasurementValidationErrors(f.envelope, {
    scenarioIds: f.scenarioIds }), []);
});

test("registered measurement rejects widened, drifted, arbitrary and self-authorized inputs", t => {
  const f = registrationFixture(t), load = overrides => loadRegisteredBenchmarkMeasurement(f.manifestFile, {
    approvalFile: f.approvalFile, approvalPublicKey: f.keys.publicKey, scenarioIds: f.scenarioIds, ...overrides
  });
  assert.throws(() => load({ approvalPublicKey: crypto.generateKeyPairSync("ed25519").publicKey }),
    /signature or payload binding/);
  fs.appendFileSync(f.approvalFile, " ");
  assert.throws(() => load(), /approval digest mismatch/);
  const badPayload = { ...f.payload, suiteId: "copied-production-v2",
      claims: { ...f.payload.claims, releaseDefaultsClaim: true } },
    badEnvelope = { ...f.envelope, payload: badPayload, extra: true };
  assert.match(registeredBenchmarkMeasurementValidationErrors(badEnvelope).join("; "), /envelope must contain exactly/);
  delete badEnvelope.extra;
  assert.match(registeredBenchmarkMeasurementValidationErrors(badEnvelope, {
    scenarioIds: f.scenarioIds }).join("; "), /suiteId must equal production-v2-da2/);
  const shortMatrix = structuredClone(f.envelope); shortMatrix.payload.matrix.scenarioCount = 26;
  assert.match(registeredBenchmarkMeasurementValidationErrors(shortMatrix).join("; "), /complete108/);
});

test("registered measurement cannot bypass its trusted immutable bootstrap", t => {
  const f = registrationFixture(t);
  for (const args of [
    ["--registered-measurement", f.manifestFile, "--dry-run"],
    ["--registered-measurement", f.manifestFile, "--preflight-only"]
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /must start through scripts\/benchmark-runner\.mjs with a trusted frozen registration/);
    assert.doesNotMatch(result.stderr, /provider|credential|auth/i);
  }
});

test("registered public asset inventory is exact, sorted and content bound", t => {
  const f = registrationFixture(t), assetRoot = path.join(f.directory, "assets");
  for (const relative of [...registeredBenchmarkPublicAssetPaths(f.scenarioIds),
    "measurement/registered-suite.json"]) {
    const target = path.join(assetRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${relative}\n`);
  }
  const inventory = registeredBenchmarkPublicAssetInventory(fs.realpathSync(assetRoot), f.scenarioIds);
  assert.equal(inventory.entries.length, 48);
  assert.deepEqual(inventory.entries.map(value => value.path), [...inventory.entries.map(value => value.path)].sort());
  const registration = { payload: { publicAssetsDigest: inventory.publicAssetsDigest,
    publicContractDigest: inventory.publicContractDigest } };
  assert.deepEqual(assertRegisteredBenchmarkPublicAssets(registration, fs.realpathSync(assetRoot),
    f.scenarioIds), inventory);
  fs.appendFileSync(path.join(assetRoot, "catalog.json"), "drift\n");
  assert.throws(() => assertRegisteredBenchmarkPublicAssets(registration, fs.realpathSync(assetRoot),
    f.scenarioIds), /inventory digest mismatch/);
  fs.writeFileSync(path.join(assetRoot, "extra.txt"), "extra\n");
  assert.throws(() => registeredBenchmarkPublicAssetInventory(fs.realpathSync(assetRoot), f.scenarioIds),
    /exactly the approved inventory/);
});

test("trusted bootstrap freezes the exact registered asset tree without forwarding authority paths", t => {
  const f = registeredAssetFixture(t), temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    "registered-snapshot-")));
  t.after(() => cleanupBenchmarkExecutionSnapshot(temporaryRoot));
  const previousApproval = process.env[registeredApprovalFileVariable],
    previousKey = process.env[registeredApprovalKeyVariable];
  process.env[registeredApprovalFileVariable] = f.approvalFile;
  process.env[registeredApprovalKeyVariable] = f.publicKeyFile;
  t.after(() => {
    if (previousApproval === undefined) delete process.env[registeredApprovalFileVariable];
    else process.env[registeredApprovalFileVariable] = previousApproval;
    if (previousKey === undefined) delete process.env[registeredApprovalKeyVariable];
    else process.env[registeredApprovalKeyVariable] = previousKey;
  });
  const snapshot = snapshotRegisteredBenchmarkMeasurement({ argv: ["--registered-measurement",
    f.manifestFile], cwd: root, temporaryRoot, scenarioIds: f.scenarioIds });
  assert.equal(snapshot.assetRoot, path.join(temporaryRoot, "registered-assets"));
  assert.equal(snapshot.identity.payloadSha256, registeredBenchmarkMeasurementPayloadDigest(f.payload));
  assert.equal(snapshot.inventory.publicAssetsDigest, f.inventory.publicAssetsDigest);
  assert.equal(fs.statSync(snapshot.manifestSnapshot).mode & 0o222, 0);
  const child = benchmarkBootstrapEnvironment({ registeredMeasurement: snapshot, codexCredential: null });
  assert.equal(child[registeredApprovalFileVariable], undefined);
  assert.equal(child[registeredApprovalKeyVariable], undefined);
});

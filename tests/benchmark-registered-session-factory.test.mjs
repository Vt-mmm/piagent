import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeBenchmarkCandidate } from "../packages/piagent-core/benchmark/benchmark-candidate.js";
import { scopedBrokerArmDigest
} from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";
import { BENCHMARK_SCOPED_SESSION_REQUEST_VERSION } from "../scripts/benchmark-codex-journey.mjs";
import { createRegisteredBenchmarkScopedSessionFactory,
  registeredBenchmarkScopedSessionRequired
} from "../scripts/benchmark-scoped-session-factory.mjs";

const root = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
const assetRootInput = process.env.PIAGENT_REGISTERED_ASSET_ROOT ?? null;
const nodeCommandInput = process.env.PIAGENT_PINNED_NODE_COMMAND ?? null;
const codexRuntimeInput = process.env.PIAGENT_CONTROLLED_CODEX_RUNTIME ?? null;
const compositeScenarios = Object.freeze([
  "incident-diagnosis",
  "protected-env-refusal",
  "repository-prompt-injection",
  "destructive-history-refusal"
]);
const sha = value => createHash("sha256").update(value).digest("hex");

function writableTree(rootPath) {
  if (!fs.existsSync(rootPath)) return;
  const pending = [rootPath], directories = [];
  while (pending.length) {
    const current = pending.pop(), info = fs.lstatSync(current);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      directories.push(current);
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    } else fs.chmodSync(current, 0o600);
  }
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o700);
}

function privateWorkspace(temporary) {
  const workspace = path.join(temporary, "workspace");
  fs.cpSync(path.join(root, "benchmarks", "production-v2", "project"), workspace,
    { recursive: true, errorOnExist: true });
  writableTree(workspace);
  fs.writeFileSync(path.join(workspace, ".env"), "QUALIFICATION_ONLY=1\n", { mode: 0o600 });
  return fs.realpathSync(workspace);
}

function qualificationFixture(temporary) {
  const source = path.join(temporary, "source"), candidateRoot = path.join(temporary, "candidate"),
    assetsRoot = path.join(temporary, "webui-assets"), sdkRoot = path.join(temporary, "sdk");
  for (const directory of [source, assetsRoot, sdkRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(source, ".gitignore"), "evidence/\n");
  fs.writeFileSync(path.join(source, "candidate.js"), "export const value = 1;\n");
  execFileSync("git", ["-C", source, "init", "-q"]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "-c", "user.name=G0", "-c", "user.email=g0@invalid",
    "commit", "-qm", "fixture"]);
  const frozen = materializeBenchmarkCandidate(source, candidateRoot),
    indexPath = path.join(temporary, "candidate-index.json"),
    indexBytes = Buffer.from(`${JSON.stringify(frozen.index)}\n`);
  fs.writeFileSync(indexPath, indexBytes, { mode: 0o400 });
  fs.writeFileSync(path.join(assetsRoot, "asset.txt"), "asset\n", { mode: 0o600 });
  fs.writeFileSync(path.join(sdkRoot, "sdk.mjs"), "export const sdk = 1;\n", { mode: 0o600 });
  return Object.freeze({ version: 4, candidateRoot: fs.realpathSync(candidateRoot),
    assetsRoot: fs.realpathSync(assetsRoot), sdkRoot: fs.realpathSync(sdkRoot),
    candidateIndexPath: fs.realpathSync(indexPath), candidateIndexSha256: sha(indexBytes) });
}

function assetInventory(assetRoot) {
  const entries = [], pending = [[assetRoot, ""]];
  while (pending.length) {
    const [directory, prefix] = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
        target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push([target, relative]);
      else {
        assert.equal(entry.isFile(), true, relative);
        const bytes = fs.readFileSync(target);
        entries.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({ entries: Object.freeze(entries.map(entry => Object.freeze(entry))) });
}

function exactMessage(assetRoot, catalogTurn) {
  const amended = path.join(assetRoot, "measurement", ...catalogTurn.promptPath.split("/")),
    base = path.join(root, "benchmarks", "production-v2", ...catalogTurn.promptPath.split("/")),
    source = fs.existsSync(amended) ? amended : base;
  let bytes = fs.readFileSync(source);
  if (bytes.length === catalogTurn.promptBytes + 1 && bytes.at(-1) === 10)
    bytes = bytes.subarray(0, -1);
  assert.equal(bytes.length, catalogTurn.promptBytes, catalogTurn.promptPath);
  assert.equal(sha(bytes), catalogTurn.promptSha256, catalogTurn.promptPath);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function exactTurns(assetRoot, catalog, scenarioId) {
  const scenario = catalog.scenarios.find(item => item.scenarioId === scenarioId);
  assert.ok(scenario, scenarioId);
  return scenario.turns.map(turn => Object.freeze({ id: turn.turnId,
    message: exactMessage(assetRoot, turn), workflow: turn.workflow,
    reconnectBefore: turn.reconnectBefore, receiptUncertain: turn.receiptUncertain }));
}

const missingInputs = [assetRootInput, nodeCommandInput, codexRuntimeInput].some(value => value === null);

test("registered production session factory binds exact public composite plans provider-free", {
  skip: missingInputs ? "requires registered asset, pinned Node and controlled Codex paths" : false,
  timeout: 120000
}, async t => {
  const assetRoot = fs.realpathSync(assetRootInput), nodeCommand = fs.realpathSync(nodeCommandInput),
    codexRuntimePath = fs.realpathSync(codexRuntimeInput),
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "registered-session-factory-")));
  fs.chmodSync(temporary, 0o700);
  t.after(() => { writableTree(temporary); fs.rmSync(temporary, { recursive: true, force: true }); });
  const workspace = privateWorkspace(temporary), custodyRoot = path.join(temporary, "custody");
  fs.mkdirSync(custodyRoot, { mode: 0o700 });
  const catalog = JSON.parse(fs.readFileSync(path.join(assetRoot, "catalog.json"), "utf8")),
    samplePlan = JSON.parse(fs.readFileSync(path.join(assetRoot, "plans", "incident-diagnosis.json"), "utf8")),
    identity = samplePlan.contracts[0].planContext.identity,
    registeredMeasurement = Object.freeze({ assetRoot,
      payload: Object.freeze({ suiteId: "production-v2-da2", baseSuiteDigest: identity.suiteDigest,
        sharedEnvironmentDigest: identity.configDigest }), inventory: assetInventory(assetRoot) }),
    qualification = qualificationFixture(temporary),
    factory = createRegisteredBenchmarkScopedSessionFactory({ installedRoot: root, registeredMeasurement,
      custodyRoot: fs.realpathSync(custodyRoot), nodeCommand, codexRuntimePath, qualification });
  assert.deepEqual(Object.keys(factory), ["version", "authority", "openSession"]);
  assert.equal(factory.authority, "none");
  assert.deepEqual(Object.keys(identity.armDigests), ["piagent", "codex-cli"]);
  assert.notEqual(identity.armDigests.piagent, identity.armDigests["codex-cli"]);
  assert.deepEqual(compositeScenarios.map(id => registeredBenchmarkScopedSessionRequired(factory, id)),
    [true, true, true, true]);
  assert.equal(registeredBenchmarkScopedSessionRequired(factory, "expiry-boundary"), false);

  for (const scenarioId of compositeScenarios) {
    const controller = await factory.openSession({ version: BENCHMARK_SCOPED_SESSION_REQUEST_VERSION,
      authority: "none", runId: `qualification-pi-${scenarioId}`, suiteId: "production-v2-da2",
      scenarioId, surface: "piagent", repeat: 1, infrastructureAttempt: 1,
      configurationSha256: identity.configDigest, workspace, model: "openai-codex/gpt-5.6-luna",
      thinking: "medium", serviceTier: "fast", turns: exactTurns(assetRoot, catalog, scenarioId) });
    assert.equal(controller.authority, "none");
    assert.equal(controller.surface, "piagent");
    assert.ok(controller.piScopedBrokerRouter);
    assert.equal(controller.codexScopedBroker, null);
  }

  const scenarioId = "repository-prompt-injection", turns = exactTurns(assetRoot, catalog, scenarioId),
    controller = await factory.openSession({ version: BENCHMARK_SCOPED_SESSION_REQUEST_VERSION,
      authority: "none", runId: "qualification-codex-repository-prompt-injection",
      suiteId: "production-v2-da2", scenarioId, surface: "codex-cli", repeat: 1,
      infrastructureAttempt: 1, configurationSha256: identity.configDigest, workspace,
      model: "openai-codex/gpt-5.6-luna", thinking: "medium", serviceTier: "fast", turns });
  assert.equal(controller.surface, "codex-cli");
  assert.equal(controller.piScopedBrokerRouter, null);
  const firstCustody = await controller.codexScopedBroker.openTurn({ turnIndex: 1, turnId: turns[0].id,
    inputText: turns[0].message, threadId: null, workspace });
  assert.equal(firstCustody.authority, "none");
  assert.equal(firstCustody.measurementBinding.configurationSha256, identity.configDigest);
  assert.equal(firstCustody.measurementBinding.profile, "document");
  await firstCustody.dispose();
  const selectedCustody = await controller.codexScopedBroker.openTurn({ turnIndex: 2, turnId: turns[1].id,
    inputText: turns[1].message, threadId: "qualification-thread", workspace });
  assert.equal(scopedBrokerArmDigest(selectedCustody.identity), identity.armDigests["codex-cli"]);
  await selectedCustody.dispose();

  const mutatedAssetRoot = path.join(temporary, "mutated-assets");
  fs.cpSync(assetRoot, mutatedAssetRoot, { recursive: true, errorOnExist: true });
  writableTree(mutatedAssetRoot);
  const changedPlanPath = path.join(mutatedAssetRoot, "plans", "incident-diagnosis.json"),
    changedPlan = JSON.parse(fs.readFileSync(changedPlanPath, "utf8"));
  for (const contract of changedPlan.contracts) {
    if (contract.route === "composite") contract.planContext.identity.armDigests.piagent = "f".repeat(64);
  }
  fs.writeFileSync(changedPlanPath, `${JSON.stringify(changedPlan)}\n`);
  const changedMeasurement = Object.freeze({ ...registeredMeasurement, assetRoot: fs.realpathSync(mutatedAssetRoot),
    inventory: assetInventory(mutatedAssetRoot) }), changedFactory = createRegisteredBenchmarkScopedSessionFactory({
      installedRoot: root, registeredMeasurement: changedMeasurement,
      custodyRoot: fs.realpathSync(custodyRoot), nodeCommand, codexRuntimePath, qualification }),
    custodyEntriesBefore = fs.readdirSync(custodyRoot);
  await assert.rejects(changedFactory.openSession({ version: BENCHMARK_SCOPED_SESSION_REQUEST_VERSION,
    authority: "none", runId: "qualification-mutated-arm", suiteId: "production-v2-da2",
    scenarioId: "incident-diagnosis", surface: "piagent", repeat: 1, infrastructureAttempt: 1,
    configurationSha256: identity.configDigest, workspace, model: "openai-codex/gpt-5.6-luna",
    thinking: "medium", serviceTier: "fast", turns: exactTurns(assetRoot, catalog, "incident-diagnosis") }),
  /session-factory-plan-binding/);
  assert.deepEqual(fs.readdirSync(custodyRoot), custodyEntriesBefore);
});

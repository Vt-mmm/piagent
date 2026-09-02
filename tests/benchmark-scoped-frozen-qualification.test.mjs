import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeBenchmarkCandidate } from "../packages/piagent-core/benchmark/benchmark-candidate.js";
import { createScopedMaterialBroker } from "../scripts/benchmark-scoped-tool-broker.mjs";
import { loadScopedBrokerFromConfig, scopedCommonRuntimeClosureIdentity, scopedFrozenQualificationIdentity,
  scopedJournalPathSha256, scopedToolDefinitionsSha256, scopedVerificationReceiptKeyDigest
} from "../scripts/benchmark-scoped-verification-supervisor.mjs";
import { openScopedMediationEvidence, scopedBrokerArmDigest, scopedBrokerProfileDigest,
  scopedMediationFactObservation } from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";

const sha = value => createHash("sha256").update(value).digest("hex");

function writableTree(root) {
  if (!fs.existsSync(root)) return;
  const pending = [root], directories = [];
  while (pending.length) {
    const current = pending.pop(), info = fs.lstatSync(current);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      directories.push(current);
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    } else fs.chmodSync(current, 0o600);
  }
  for (const directory of directories) fs.chmodSync(directory, 0o700);
}

function sourceRepository(root) {
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, ".gitignore"), "evidence/\n");
  fs.writeFileSync(path.join(sourceRoot, "candidate.js"), "export const value = 1;\n");
  execFileSync("git", ["-C", sourceRoot, "init", "-q"]);
  execFileSync("git", ["-C", sourceRoot, "add", "."]);
  execFileSync("git", ["-C", sourceRoot, "-c", "user.name=G0", "-c",
    "user.email=g0@invalid", "commit", "-qm", "fixture"]);
  return sourceRoot;
}

function v4Fixture(t, label, { mutateIdentity = value => value, mutateActual = () => {},
  manifestVersion = 1 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `broker-v4-${label}-`)));
  t.after(() => { writableTree(root); fs.rmSync(root, { recursive: true, force: true }); });
  const sourceRoot = sourceRepository(root), candidateRoot = path.join(root, "candidate"),
    assetsRoot = path.join(root, "webui-assets"), sdkRoot = path.join(root, "sdk"),
    materialsRoot = path.join(root, "materials"), evidenceRoot = path.join(root, "evidence");
  fs.mkdirSync(assetsRoot); fs.mkdirSync(sdkRoot); fs.mkdirSync(materialsRoot, { mode: 0o700 });
  fs.mkdirSync(evidenceRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(assetsRoot, "index.html"), "asset-one\n");
  fs.writeFileSync(path.join(sdkRoot, "sdk.mjs"), "export const sdk = 1;\n");
  const frozen = materializeBenchmarkCandidate(sourceRoot, candidateRoot);
  const candidateIndexPath = path.join(root, "candidate-index.json"),
    candidateIndexBytes = Buffer.from(`${JSON.stringify(frozen.index)}\n`);
  fs.writeFileSync(candidateIndexPath, candidateIndexBytes, { mode: 0o400 });
  const qualificationConfig = { version: 4, candidateRoot: fs.realpathSync(candidateRoot),
    assetsRoot: fs.realpathSync(assetsRoot), sdkRoot: fs.realpathSync(sdkRoot), candidateIndexPath,
    candidateIndexSha256: sha(candidateIndexBytes) };
  const qualification = scopedFrozenQualificationIdentity(qualificationConfig,
    scopedCommonRuntimeClosureIdentity().sha256);
  const host = generateKeyPairSync("ed25519"), journal = generateKeyPairSync("ed25519"),
    at = name => path.join(evidenceRoot, name);
  const operatorRequestDigest = `operator-request-v1:${sha("request-v4")}`;
  const measurementBinding = { version: "benchmark-turn-binding-v1", authority: "none", runId: "run-v4",
    armId: "A", suiteId: "suite-v4", scenarioId: "scenario-v4", surface: "piagent", repeat: 1,
    infrastructureAttempt: 1, turnIndex: 1, turnId: "turn-v4", catalogSha256: "1".repeat(64),
    configurationSha256: "2".repeat(64), publicContractSha256: "3".repeat(64),
    planSha256: "4".repeat(64), turnBindingSha256: "5".repeat(64), workspaceSha256: "6".repeat(64),
    operatorRequestDigest, profile: "document", materialManifestSha256: "7".repeat(64),
    verificationManifestSha256: "8".repeat(64), contextPolicySha256: "2".repeat(64),
    nodeSha256: "9".repeat(64), runtimeSha256: "a".repeat(64), modelSha256: "b".repeat(64) };
  const config = { version: 4, manifestPath: at("manifest.json"),
    manifestSignaturePath: at("manifest.sig"), manifestPublicKeyPath: at("manifest-public.pem"),
    journalPath: at("journal.jsonl"), journalPrivateKeyPath: at("journal-private.pem"),
    verificationBridge: null, qualification: qualificationConfig, measurementBinding };
  const configBytes = Buffer.from(JSON.stringify(config));
  let identity = { version: 4, armId: "A", taskId: "task-v4", sessionId: "session-v4",
    requestId: operatorRequestDigest, operationId: "operation-v4", nonce: "nonce-v4",
    sourceSha256: qualification.sourceSha256, assetTreeSha256: qualification.assetTreeSha256,
    configSha256: sha(configBytes), measurementConfigurationSha256: measurementBinding.configurationSha256,
    brokerClosureSha256: qualification.brokerClosureSha256,
    toolDefinitionsSha256: scopedToolDefinitionsSha256(),
    manifestAuthoritySha256: scopedVerificationReceiptKeyDigest(host.publicKey),
    journalSignerSha256: scopedVerificationReceiptKeyDigest(journal.publicKey),
    journalPathSha256: scopedJournalPathSha256(config.journalPath), contextPolicySha256: "2".repeat(64),
    sdkTreeSha256: qualification.sdkTreeSha256 };
  identity = mutateIdentity({ ...identity });
  const manifestBytes = Buffer.from(JSON.stringify({ version: manifestVersion, identity, profile: "document",
    root: materialsRoot, materials: [], verifications: [] }));
  const writePrivate = (file, bytes) => fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  writePrivate(config.manifestPath, manifestBytes);
  writePrivate(config.manifestSignaturePath, sign(null, manifestBytes, host.privateKey));
  writePrivate(config.manifestPublicKeyPath, host.publicKey.export({ type: "spki", format: "pem" }));
  writePrivate(config.journalPrivateKeyPath, journal.privateKey.export({ type: "pkcs8", format: "pem" }));
  const configPath = at("config.json"); writePrivate(configPath, configBytes);
  mutateActual({ candidateFile: path.join(candidateRoot, "candidate.js"), assetFile: path.join(assetsRoot,
    "index.html"), sdkFile: path.join(sdkRoot, "sdk.mjs"), candidateIndexPath, candidateIndexBytes,
    evidenceRoot });
  return { config, configBytes, configPath, identity, qualification, materialsRoot };
}

test("frozen v4 qualification opens custody only after snapshot, index, assets, SDK and closure agree", t => {
  const fixture = v4Fixture(t, "valid"), loaded = loadScopedBrokerFromConfig({
    configPath: fixture.configPath, createBroker: createScopedMaterialBroker });
  assert.equal(loaded.configSha256, sha(fixture.configBytes));
  assert.deepEqual(loaded.actualQualification, fixture.qualification);
  assert.equal(loaded.identity.version, 4); loaded.broker.close();
  const evidence = loaded.settlementEvidence();
  const rows = evidence.journalBytes.toString("utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => row.body.type), ["begin", "end"]);
  assert.ok(rows.every(row => row.body.identity.sourceSha256 === fixture.qualification.sourceSha256
    && row.body.identity.assetTreeSha256 === fixture.qualification.assetTreeSha256
    && row.body.identity.sdkTreeSha256 === fixture.qualification.sdkTreeSha256
    && row.body.identity.brokerClosureSha256 === fixture.qualification.brokerClosureSha256));
  assert.equal(evidence.status.blocked, false); assert.equal(evidence.status.ended, true);
});

test("frozen v4 declared and actual tree drift fail before journal custody", t => {
  const cases = [
    ["declared-source", { mutateIdentity: value => ({ ...value, sourceSha256: "4".repeat(64) }) }, /manifest-identity-v4/],
    ["declared-closure", { mutateIdentity: value => ({ ...value, brokerClosureSha256: "4".repeat(64) }) }, /manifest-identity-v4/],
    ["actual-source", { mutateActual: files => {
      fs.chmodSync(files.candidateFile, 0o600); fs.writeFileSync(files.candidateFile, "drift\n");
    } }, /manifest-identity-v4/],
    ["actual-assets", { mutateActual: files => fs.writeFileSync(files.assetFile, "drift\n") }, /manifest-identity-v4/],
    ["actual-sdk", { mutateActual: files => fs.writeFileSync(files.sdkFile, "drift\n") }, /manifest-identity-v4/]
  ];
  for (const [label, options, pattern] of cases) {
    const fixture = v4Fixture(t, label, options);
    assert.throws(() => loadScopedBrokerFromConfig({ configPath: fixture.configPath,
      createBroker: createScopedMaterialBroker }), pattern);
    assert.equal(fs.existsSync(fixture.config.journalPath), false, label);
  }
});

test("frozen v4 separates local config bytes from the registered measurement configuration", t => {
  const cases = [
    ["local-config", value => ({ ...value, configSha256: "c".repeat(64) }), /broker-config-identity/],
    ["measurement-config", value => ({ ...value, measurementConfigurationSha256: "d".repeat(64) }),
      /broker-config-measurement-binding/]
  ];
  for (const [label, mutateIdentity, pattern] of cases) {
    const fixture = v4Fixture(t, label, { mutateIdentity });
    assert.throws(() => loadScopedBrokerFromConfig({ configPath: fixture.configPath,
      createBroker: createScopedMaterialBroker }), pattern);
    assert.equal(fs.existsSync(fixture.config.journalPath), false, label);
  }
});

test("frozen v4 index byte, path and permission drift fail before journal custody", t => {
  const cases = [
    ["index-bytes", files => {
      fs.chmodSync(files.candidateIndexPath, 0o600);
      fs.writeFileSync(files.candidateIndexPath, Buffer.concat([files.candidateIndexBytes, Buffer.from(" ")]));
    }, /frozen-index-drift/],
    ["index-path", files => {
      const copy = path.join(files.evidenceRoot, "index-copy.json");
      fs.writeFileSync(copy, files.candidateIndexBytes, { mode: 0o600 });
      fs.unlinkSync(files.candidateIndexPath); fs.symlinkSync(copy, files.candidateIndexPath);
    }, /frozen-index-file/],
    ["index-permissions", files => fs.chmodSync(files.candidateIndexPath, 0o644), /frozen-index-file/]
  ];
  for (const [label, mutateActual, pattern] of cases) {
    const fixture = v4Fixture(t, label, { mutateActual });
    assert.throws(() => loadScopedBrokerFromConfig({ configPath: fixture.configPath,
      createBroker: createScopedMaterialBroker }), pattern);
    assert.equal(fs.existsSync(fixture.config.journalPath), false, label);
  }
});

test("frozen v4 custody remains consumable by composite mediation without granting PASS authority", t => {
  const fixture = v4Fixture(t, "composite", { manifestVersion: 2 });
  const loaded = loadScopedBrokerFromConfig({ configPath: fixture.configPath,
    createBroker: createScopedMaterialBroker });
  loaded.broker.close();
  const fact = { id: "policy", kind: "tool-policy-complete",
    parameters: { profileDigest: scopedBrokerProfileDigest("document"), requireExclusiveMediation: true } };
  const task = { taskId: fixture.identity.taskId, sessionId: fixture.identity.sessionId,
    operatorRequestDigest: fixture.identity.requestId, baselineFileDigests: {} };
  const plan = { identity: { configDigest: fixture.identity.measurementConfigurationSha256,
    armDigest: scopedBrokerArmDigest(fixture.identity) }, materialBindings: [] };
  const contract = { facts: [fact] };
  assert.throws(() => openScopedMediationEvidence(loaded.settlementEvidence(), {
    projectRoot: fixture.materialsRoot, task, operationRef: fixture.identity.operationId,
    messageRequestId: fixture.identity.nonce,
    plan: { ...plan, identity: { ...plan.identity, configDigest: fixture.identity.configSha256 } },
    contract, materials: [] }), /scoped-evidence-binding-mismatch/);
  const capability = openScopedMediationEvidence(loaded.settlementEvidence(), {
    projectRoot: fixture.materialsRoot, task, operationRef: fixture.identity.operationId,
    messageRequestId: fixture.identity.nonce, plan, contract, materials: [] });
  assert.equal(scopedMediationFactObservation(capability,
    { fact, plan, contract, task, materials: [], workspace: {} }).status, "pass");
});

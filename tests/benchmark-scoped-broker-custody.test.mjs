import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeBenchmarkCandidate } from "../packages/piagent-core/benchmark/benchmark-candidate.js";
import { createBenchmarkScopedBrokerTurnCustody, scopedBrokerMaterialManifestSha256,
  scopedBrokerModelIdentitySha256, scopedBrokerVerificationManifestSha256,
  reconcileCodexScopedBrokerSettlement
} from "../scripts/benchmark-scoped-session-custody.mjs";
import { scopedFrozenQualificationIdentity } from "../scripts/benchmark-scoped-frozen-qualification.mjs";
import { scopedCommonRuntimeClosureIdentity, scopedContextPolicySha256
} from "../scripts/benchmark-scoped-verification-supervisor.mjs";

const nodeCommand = fs.realpathSync(process.execPath);
const brokerScript = path.resolve(import.meta.dirname, "../scripts/benchmark-scoped-tool-broker.mjs");
const sha = value => createHash("sha256").update(value).digest("hex");

function writableTree(root) {
  if (!fs.existsSync(root)) return;
  const pending = [root], directories = [];
  while (pending.length) {
    const current = pending.pop(), info = fs.lstatSync(current);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) { directories.push(current);
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name)); }
    else fs.chmodSync(current, 0o600);
  }
  for (const directory of directories) fs.chmodSync(directory, 0o700);
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "broker-custody-")));
  t.after(() => { writableTree(root); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"), candidateRoot = path.join(root, "candidate"),
    assetsRoot = path.join(root, "assets"), sdkRoot = path.join(root, "sdk"),
    materialRoot = path.join(root, "workspace"), custodyRoot = path.join(root, "custody");
  for (const directory of [source, assetsRoot, sdkRoot, materialRoot, custodyRoot])
    fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(source, ".gitignore"), "evidence/\n");
  fs.writeFileSync(path.join(source, "candidate.js"), "export const value = 1;\n");
  execFileSync("git", ["-C", source, "init", "-q"]); execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "-c", "user.name=G0", "-c", "user.email=g0@invalid",
    "commit", "-qm", "fixture"]);
  const frozen = materializeBenchmarkCandidate(source, candidateRoot), indexPath = path.join(root, "candidate-index.json"),
    indexBytes = Buffer.from(`${JSON.stringify(frozen.index)}\n`);
  fs.writeFileSync(indexPath, indexBytes, { mode: 0o400 });
  fs.writeFileSync(path.join(assetsRoot, "index.html"), "asset\n");
  fs.writeFileSync(path.join(sdkRoot, "sdk.mjs"), "export const sdk = 1;\n");
  const materialBytes = Buffer.from("visible material\n"), materialPath = path.join(materialRoot, "input.txt");
  fs.writeFileSync(materialPath, materialBytes, { mode: 0o600 });
  const qualification = { version: 4, candidateRoot: fs.realpathSync(candidateRoot),
    assetsRoot: fs.realpathSync(assetsRoot), sdkRoot: fs.realpathSync(sdkRoot), candidateIndexPath: indexPath,
    candidateIndexSha256: sha(indexBytes) };
  const actual = scopedFrozenQualificationIdentity(qualification, scopedCommonRuntimeClosureIdentity().sha256),
    materials = [{ id: "input", relativePath: "input.txt", sha256: sha(materialBytes), bytes: materialBytes.length,
      readable: true, writable: false, protected: false }], verifications = [],
    contextPolicy = { version: 2, systemPrompt: "Use only the scoped tools.",
      allowedUserMessages: ["turn one"], removableUserMessages: [] },
    modelIdentity = { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium", serviceTier: null };
  const binding = (overrides = {}) => ({ version: "benchmark-turn-binding-v1", authority: "none",
    runId: "run-custody", armId: "A", suiteId: "suite-custody", scenarioId: "scenario-custody",
    surface: "piagent", repeat: 1, infrastructureAttempt: 1, turnIndex: 1, turnId: "turn-one",
    catalogSha256: "1".repeat(64), configurationSha256: "2".repeat(64),
    publicContractSha256: "3".repeat(64), planSha256: "4".repeat(64),
    turnBindingSha256: "5".repeat(64), workspaceSha256: "6".repeat(64),
    operatorRequestDigest: `operator-request-v1:${sha("turn one")}`, profile: "document",
    materialManifestSha256: scopedBrokerMaterialManifestSha256("document", materials),
    verificationManifestSha256: scopedBrokerVerificationManifestSha256(verifications),
    contextPolicySha256: scopedContextPolicySha256(contextPolicy), nodeSha256: sha(fs.readFileSync(nodeCommand)),
    runtimeSha256: actual.sdkTreeSha256, modelSha256: scopedBrokerModelIdentitySha256(modelIdentity), ...overrides });
  const create = (bindingValue, taskIdentity) => createBenchmarkScopedBrokerTurnCustody({ custodyRoot,
    nodeCommand, brokerScript, runtimePath: bindingValue.surface === "codex-cli" ? nodeCommand : null,
    qualification, measurementBinding: bindingValue, contextPolicy, modelIdentity, taskIdentity,
    materialRoot, materials, verifications, verificationBridge: null, verificationHost: null });
  return { root, custodyRoot, materialRoot, materialPath, qualification, actual, materials, verifications,
    contextPolicy, modelIdentity, binding, create };
}

test("turn custody creates fresh Pi key/config/journal identities and signed settlement per operation", async t => {
  const f = fixture(t), first = await f.create(f.binding(), { taskId: "task-one", sessionId: "session-native",
    operationId: "operation-one", nonce: "message-one" }), second = await f.create(f.binding({ turnIndex: 2,
      turnId: "turn-two", turnBindingSha256: "7".repeat(64), operatorRequestDigest: `operator-request-v1:${sha("turn two")}` }),
    { taskId: "task-two", sessionId: "session-native", operationId: "operation-two", nonce: "message-two" });
  assert.notEqual(first.turnRoot, second.turnRoot); assert.notEqual(first.configSha256, second.configSha256);
  assert.notEqual(first.identity.manifestAuthoritySha256, second.identity.manifestAuthoritySha256);
  assert.notEqual(first.identity.journalSignerSha256, second.identity.journalSignerSha256);
  const loaded = await first.openPi(), result = loaded.broker.invoke("scoped_read", { materialId: "input" }, loaded.nonce);
  assert.equal(Buffer.from(result.bytes, "base64").toString(), "visible material\n");
  loaded.broker.close(); const evidence = loaded.settlementEvidence();
  assert.equal(evidence.status.actions, 1); assert.equal(evidence.status.ended, true);
  await loaded.dispose(); await assert.rejects(first.openPi(), /custody-single-use/);
  await second.dispose();
});

test("turn custody launch triple yields a complete provider-free Codex MCP settlement and refuses restart", async t => {
  const f = fixture(t), binding = f.binding({ surface: "codex-cli",
    runtimeSha256: sha(fs.readFileSync(nodeCommand)) }), custody = await f.create(binding,
    { taskId: "plan-scenario", sessionId: "codex-coordinate", operationId: "turn-binding",
      nonce: "codex-turn-nonce" });
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18",
      capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: {
      callId: "call-custody", threadId: "codex-native-thread", itemId: "item-custody",
      "x-codex-turn-metadata": { session_id: "codex-native-thread", thread_id: "codex-native-thread",
        turn_started_at_unix_ms: 1788229650265, turn_id: "codex-native-turn",
        workspaces: { [f.materialRoot]: { has_changes: false } },
        node_repl_disabled: false, thread_source: "user", sandbox: "seatbelt",
        sandbox_mode: "workspace-write", auto_review_enabled: false,
        node_repl_auto_review_required: false, model: "gpt-5.6-luna", reasoning_effort: "medium" }
    }, name: "scoped_read", arguments: { materialId: "input" } } }
  ].map(value => `${JSON.stringify(value)}\n`).join("");
  const run = spawnSync(custody.nodeCommand,
    [custody.brokerScript, "--serve-config", custody.brokerConfigPath], { input, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /"protocolVersion":"2025-06-18"/);
  const evidence = custody.codexSettlementEvidence();
  assert.equal(evidence.status.actions, 1); assert.equal(evidence.status.cancelled, false);
  assert.equal(evidence.codexTurnObservations.length, 1);
  const usage = { providerSessionId: "codex-native-thread", model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "medium", turnLifecycleEvidence: { schemaVersion: 1,
      source: "codex-exec-jsonl-turn-lifecycle", startedEvents: 1, completedEvents: 1 },
    jsonlEvidence: { schemaVersion: 1, source: "codex-exec-jsonl-stdout-bytes", bytes: 100,
      sha256: "9".repeat(64) } };
  assert.deepEqual(reconcileCodexScopedBrokerSettlement(evidence, usage), {
    version: "codex-broker-settlement-reconciliation-v1", authority: "none", status: "reconciled",
    reconciled: true, providerSessionId: "codex-native-thread", nativeTurnId: "codex-native-turn",
    observations: 1, jsonlSha256: "9".repeat(64), journalSha256: evidence.status.journalSha256
  });
  assert.throws(() => reconcileCodexScopedBrokerSettlement(evidence,
    { ...usage, providerSessionId: "wrong-thread" }), /custody-codex-identity-mismatch/);
  const replay = spawnSync(custody.nodeCommand,
    [custody.brokerScript, "--serve-config", custody.brokerConfigPath], { input, encoding: "utf8" });
  assert.equal(replay.status, 1); assert.match(replay.stderr, /EEXIST|scoped-broker-failed/);
  await custody.dispose();
});

test("turn custody rejects material, measurement and static config drift before journal custody", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.materialPath, "changed\n");
  await assert.rejects(f.create(f.binding(), { taskId: "task", sessionId: "session",
    operationId: "operation", nonce: "message" }), /custody-material-drift/);
  fs.writeFileSync(f.materialPath, "visible material\n");
  await assert.rejects(f.create(f.binding({ nodeSha256: "0".repeat(64) }), { taskId: "task",
    sessionId: "session", operationId: "operation", nonce: "message" }), /custody-measurement-drift/);
  const custody = await f.create(f.binding(), { taskId: "task", sessionId: "session",
    operationId: "operation", nonce: "message" });
  fs.chmodSync(custody.brokerConfigPath, 0o600); fs.appendFileSync(custody.brokerConfigPath, "\n");
  await assert.rejects(custody.openPi(), /custody-static-drift/);
  assert.equal(fs.existsSync(path.join(custody.turnRoot, "journal.jsonl")), false);
});

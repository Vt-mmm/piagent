import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectProductionProviderFreeEvidence,
  prepareProductionProviderFreeEvidence,
  productionProviderFreeEvidenceBinding,
  productionProviderFreeEvidenceContextValidationErrors,
  productionProviderFreeEvidenceRequired,
  productionProviderFreeEvidenceValidationErrors
} from "../packages/piagent-core/benchmark/benchmark-provider-free-evidence.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function signedReceipt(value) {
  const copy = structuredClone(value);
  delete copy.digest;
  return { ...value, digest: crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex") };
}

test("provider-free production lanes are required only for the full spend-controlled matrix", () => {
  const spendControl = {
    productionGuards: { providerFreeEvidence: { requiredBeforeFirstPaidSession: true } }
  };
  assert.equal(productionProviderFreeEvidenceRequired({ productionSpendControlled: true, spendControl }), true);
  assert.equal(productionProviderFreeEvidenceRequired({ productionSpendControlled: false, spendControl }), false,
    "a selected diagnostic scenario must not run or finalize against the full-matrix S0 receipt");
  assert.equal(productionProviderFreeEvidenceRequired({ productionSpendControlled: true, spendControl: null }), false);
});

test("S0 executes, binds, caches, and revalidates all same-source provider-free lanes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-provider-free-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, ".gitignore", ".pi/\n");
  for (const [configuration, runner] of [
    ["evals/architecture-conformance-v1/lane.json", "evals/architecture-conformance-v1/runner.mjs"],
    ["evals/runtime-conformance-v1/lane.json", "evals/runtime-conformance-v1/runner.mjs"],
    ["evals/long-horizon-v1/lane.json", "evals/long-horizon-v1/runner.mjs"],
    ["packages/piagent-webui/benchmark/parity-lane.v1.json", "packages/piagent-webui/benchmark/parity-benchmark.mjs"]
  ]) {
    write(root, configuration, `${JSON.stringify({ id: configuration })}\n`);
    write(root, runner, `// ${runner}\n`);
  }
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Provider Free Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const source = { kind: "git-working-tree", commit, dirty: false };
  const candidateProvenance = { contentDigest: "a".repeat(64), algorithm: "test-tree-v1" };
  const configurationDigest = "b".repeat(64);
  let laneCalls = 0;
  let failArchitecture = false;
  const runCommand = async (command, args) => {
    if (command === "git") {
      try { return { code: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "" }; }
      catch (error) { return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }; }
    }
    laneCalls += 1;
    const runner = args[0];
    const output = args[args.indexOf("--output") + 1];
    if (runner.includes("architecture-conformance") && failArchitecture) {
      return { code: 1, stdout: "", stderr: "architecture gate failed" };
    }
    let receipt;
    if (runner.includes("architecture-conformance")) receipt = { schemaVersion: 1, laneId: "architecture-conformance-v1",
      evidenceClass: "provider-free-architecture-conformance", passed: true,
      provider: { required: false, used: false, calls: 0, modelTokens: 0 },
      architecture: { filesChecked: 42, layersChecked: 5, errors: [] },
      gates: { architectureCheckPasses: true, sourceCoverageComplete: true, dependencyBoundariesPass: true,
        lineBudgetsPass: true, providerCalls: 0, modelTokens: 0 } };
    else if (runner.includes("runtime-conformance")) receipt = { summary: { passed: true, configuredCases: 9, executedCases: 9, failedCases: 0 },
      provider: { used: false, calls: 0, modelInputTokens: 0, modelOutputTokens: 0 }, gates: { complete: true } };
    else if (runner.includes("long-horizon")) receipt = { evidenceClass: "provider-free-long-horizon", providerUsed: false,
      wallClockQualified: true, completedFromResume: true, context: { withinCeiling: true }, stateGrowth: { withinCeiling: true },
      continuation: { enforcementSafe: true }, verification: { stableCurrentTree: true } };
    else receipt = { benchmark: "webui-parity-v1", passed: true, providerCalls: 0, modelTokens: 0,
      invariants: { uiStability: "deterministic-current-state", uiStabilitySuites: 9 }, steps: [{ name: "deterministic-ui-stability", passed: true }] };
    fs.writeFileSync(output, `${JSON.stringify(receipt)}\n`);
    return { code: 0, stdout: "", stderr: "" };
  };

  const receipt = await collectProductionProviderFreeEvidence({ packageRoot: root, liveRoot: root, runCommand,
    source, candidateProvenance, configurationDigest });
  assert.equal(laneCalls, 4);
  assert.deepEqual(receipt.lanes.map((lane) => lane.id), ["architecture-conformance-v1", "runtime-conformance-v1", "long-horizon-v1", "webui-parity-v1"]);
  assert.deepEqual(productionProviderFreeEvidenceValidationErrors(receipt, receipt.binding), []);
  assert.deepEqual(productionProviderFreeEvidenceContextValidationErrors(receipt, {
    source, candidateProvenance, configurationDigest
  }), []);
  assert.equal(receipt.binding.source.commit, commit);
  assert.equal(receipt.binding.source.treeDigest, candidateProvenance.contentDigest);
  assert.equal(receipt.binding.productionConfigurationDigest, configurationDigest);
  assert.match(receipt.completedAt, /^\d{4}-\d{2}-\d{2}T/);

  const cached = await collectProductionProviderFreeEvidence({ packageRoot: root, liveRoot: root, runCommand,
    source, candidateProvenance, configurationDigest });
  assert.equal(laneCalls, 4, "an exact same-binding S12 invocation reuses the S0 receipt without rerunning the lanes");
  assert.deepEqual(cached, receipt);

  const cachePath = path.join(root, ".pi", "benchmarks", "provider-free-evidence", receipt.binding.digest, "receipt.json");
  let corruptedCache = structuredClone(receipt);
  corruptedCache.lanes[0].summary.lineBudgetsPass = false;
  corruptedCache = signedReceipt(corruptedCache);
  assert.ok(productionProviderFreeEvidenceValidationErrors(corruptedCache, receipt.binding)
    .includes("provider-free-lane-summary-invalid:architecture-conformance-v1"));
  fs.writeFileSync(cachePath, `${JSON.stringify(corruptedCache)}\n`);
  const recovered = await collectProductionProviderFreeEvidence({ packageRoot: root, liveRoot: root, runCommand,
    source, candidateProvenance, configurationDigest });
  assert.equal(laneCalls, 8, "a tampered architecture receipt reruns the full source-bound S0 lane set");
  assert.deepEqual(productionProviderFreeEvidenceValidationErrors(recovered, recovered.binding), []);

  fs.writeFileSync(cachePath, "{not-json\n");
  const recoveredFromMalformedCache = await collectProductionProviderFreeEvidence({ packageRoot: root, liveRoot: root,
    runCommand, source, candidateProvenance, configurationDigest });
  assert.equal(laneCalls, 12, "malformed local cache bytes cannot abort or bypass the frozen S0 lanes");
  assert.deepEqual(productionProviderFreeEvidenceValidationErrors(recoveredFromMalformedCache,
    recoveredFromMalformedCache.binding), []);

  let incompleteResume = structuredClone(recoveredFromMalformedCache);
  incompleteResume.lanes = incompleteResume.lanes.filter((lane) => lane.id !== "architecture-conformance-v1");
  incompleteResume = signedReceipt(incompleteResume);
  await assert.rejects(() => prepareProductionProviderFreeEvidence({ required: true, packageRoot: root,
    bootstrapMetadata: { sourceIdentity: source, liveRoot: root }, candidateProvenance, configurationDigest,
    runCommand, resumedReceipt: incompleteResume }), /resumed production provider-free evidence is missing or changed/);

  const tampered = structuredClone(recoveredFromMalformedCache);
  tampered.lanes[0].runnerDigest = "0".repeat(64);
  assert.ok(productionProviderFreeEvidenceValidationErrors(tampered, recoveredFromMalformedCache.binding).includes("provider-free-lane-binding-mismatch:architecture-conformance-v1"));
  const malformedTime = structuredClone(recoveredFromMalformedCache);
  malformedTime.completedAt = "tomorrow";
  assert.ok(productionProviderFreeEvidenceValidationErrors(malformedTime, recoveredFromMalformedCache.binding).includes("provider-free-completion-time-invalid-or-future"));
  const futureTime = structuredClone(recoveredFromMalformedCache);
  futureTime.completedAt = new Date(Date.now() + 3_600_000).toISOString();
  assert.ok(productionProviderFreeEvidenceValidationErrors(futureTime, recoveredFromMalformedCache.binding).includes("provider-free-completion-time-invalid-or-future"));
  assert.ok(productionProviderFreeEvidenceContextValidationErrors(recoveredFromMalformedCache, {
    source, candidateProvenance: { ...candidateProvenance, contentDigest: "c".repeat(64) }, configurationDigest
  }).includes("provider-free-tree-binding-mismatch"));
  assert.throws(() => productionProviderFreeEvidenceBinding({ packageRoot: root,
    source: { ...source, dirty: true }, candidateProvenance, configurationDigest }), /exact clean Git commit/);

  fs.writeFileSync(cachePath, "{force-cache-miss\n");
  failArchitecture = true;
  const callsBeforeFailure = laneCalls;
  await assert.rejects(() => collectProductionProviderFreeEvidence({ packageRoot: root, liveRoot: root, runCommand,
    source, candidateProvenance, configurationDigest }), /Required provider-free lane failed: architecture-conformance-v1/);
  assert.equal(laneCalls, callsBeforeFailure + 1, "architecture failure stops S0 before any slower lane starts");
});

test("architecture S0 adapter emits a private zero-token passing receipt", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-architecture-lane-test-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const outputPath = path.join(temporaryRoot, "receipt.json");
  execFileSync(process.execPath, [path.join(repositoryRoot, "evals", "architecture-conformance-v1", "runner.mjs"),
    "--output", outputPath], { cwd: repositoryRoot, encoding: "utf8" });
  const receipt = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(receipt.laneId, "architecture-conformance-v1");
  assert.equal(receipt.evidenceClass, "provider-free-architecture-conformance");
  assert.equal(receipt.passed, true);
  assert.deepEqual(receipt.provider, { required: false, used: false, calls: 0, modelTokens: 0 });
  assert.ok(receipt.architecture.filesChecked > 0);
  assert.ok(receipt.architecture.layersChecked > 0);
  assert.deepEqual(receipt.architecture.errors, []);
  assert.equal(Object.entries(receipt.gates).every(([name, value]) => (
    name === "providerCalls" || name === "modelTokens" ? value === 0 : value === true
  )), true);
});

test("WebUI parity binds the current deterministic conversation and activity stability suites", () => {
  const lane = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-webui/benchmark/parity-lane.v1.json"), "utf8"));
  const stability = lane.testGroups.find((group) => group.name === "deterministic-ui-stability");
  const required = [
    "tests/piagent-webui-chat-client.test.mjs",
    "tests/piagent-webui-operation-retry.test.mjs",
    "tests/piagent-webui-live-conversation.test.mjs",
    "tests/piagent-webui-transcript-projection.test.mjs",
    "tests/piagent-webui-transcript-view-model.test.mjs",
    "tests/piagent-webui-activity-reconciliation.test.mjs",
    "tests/piagent-webui-session-send-observation.test.mjs",
    "tests/piagent-webui-session-runtime-factory.test.mjs",
    "tests/piagent-webui-session-lease-runtime.test.mjs"
  ];
  assert.deepEqual(stability.files, required);
  assert.equal(lane.invariants.uiStability, "deterministic-current-state");
  assert.equal(lane.invariants.uiStabilitySuites, required.length);
  for (const relative of required) assert.equal(fs.existsSync(path.join(repositoryRoot, relative)), true, relative);
});

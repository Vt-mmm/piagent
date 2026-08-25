import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectProductionProviderFreeEvidence,
  productionProviderFreeEvidenceBinding,
  productionProviderFreeEvidenceContextValidationErrors,
  productionProviderFreeEvidenceValidationErrors
} from "../packages/piagent-core/benchmark/benchmark-provider-free-evidence.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

test("S0 executes, binds, caches, and revalidates all same-source provider-free lanes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-provider-free-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, ".gitignore", ".pi/\n");
  for (const [configuration, runner] of [
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
  const runCommand = async (command, args) => {
    if (command === "git") {
      try { return { code: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "" }; }
      catch (error) { return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }; }
    }
    laneCalls += 1;
    const runner = args[0];
    const output = args[args.indexOf("--output") + 1];
    let receipt;
    if (runner.includes("runtime-conformance")) receipt = { summary: { passed: true, configuredCases: 9, executedCases: 9, failedCases: 0 },
      provider: { used: false, calls: 0, modelInputTokens: 0, modelOutputTokens: 0 }, gates: { complete: true } };
    else if (runner.includes("long-horizon")) receipt = { evidenceClass: "provider-free-long-horizon", providerUsed: false,
      wallClockQualified: true, completedFromResume: true, context: { withinCeiling: true }, stateGrowth: { withinCeiling: true },
      continuation: { enforcementSafe: true }, verification: { stableCurrentTree: true } };
    else receipt = { benchmark: "webui-parity-v1", passed: true, providerCalls: 0, modelTokens: 0,
      invariants: { uiStability: "deterministic-current-state", uiStabilitySuites: 7 }, steps: [{ name: "deterministic-ui-stability", passed: true }] };
    fs.writeFileSync(output, `${JSON.stringify(receipt)}\n`);
    return { code: 0, stdout: "", stderr: "" };
  };

  const receipt = await collectProductionProviderFreeEvidence({ packageRoot: root, liveRoot: root, runCommand,
    source, candidateProvenance, configurationDigest });
  assert.equal(laneCalls, 3);
  assert.deepEqual(receipt.lanes.map((lane) => lane.id), ["runtime-conformance-v1", "long-horizon-v1", "webui-parity-v1"]);
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
  assert.equal(laneCalls, 3, "an exact same-binding S12 invocation reuses the S0 receipt without rerunning the 30-minute lane");
  assert.deepEqual(cached, receipt);

  const tampered = structuredClone(receipt);
  tampered.lanes[0].runnerDigest = "0".repeat(64);
  assert.ok(productionProviderFreeEvidenceValidationErrors(tampered, receipt.binding).includes("provider-free-lane-binding-mismatch:runtime-conformance-v1"));
  const malformedTime = structuredClone(receipt);
  malformedTime.completedAt = "tomorrow";
  assert.ok(productionProviderFreeEvidenceValidationErrors(malformedTime, receipt.binding).includes("provider-free-completion-time-invalid-or-future"));
  const futureTime = structuredClone(receipt);
  futureTime.completedAt = new Date(Date.now() + 3_600_000).toISOString();
  assert.ok(productionProviderFreeEvidenceValidationErrors(futureTime, receipt.binding).includes("provider-free-completion-time-invalid-or-future"));
  assert.ok(productionProviderFreeEvidenceContextValidationErrors(receipt, {
    source, candidateProvenance: { ...candidateProvenance, contentDigest: "c".repeat(64) }, configurationDigest
  }).includes("provider-free-tree-binding-mismatch"));
  assert.throws(() => productionProviderFreeEvidenceBinding({ packageRoot: root,
    source: { ...source, dirty: true }, candidateProvenance, configurationDigest }), /exact clean Git commit/);
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
    "tests/piagent-webui-session-lease-runtime.test.mjs"
  ];
  assert.deepEqual(stability.files, required);
  assert.equal(lane.invariants.uiStability, "deterministic-current-state");
  assert.equal(lane.invariants.uiStabilitySuites, required.length);
  for (const relative of required) assert.equal(fs.existsSync(path.join(repositoryRoot, relative)), true, relative);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const laneRoot = path.join(repositoryRoot, "evals", "runtime-conformance-v1");

test("provider-free runtime conformance lane emits a complete zero-token passing receipt", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-conformance-test-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const outputPath = path.join(temporaryRoot, "receipt.json");
  const run = spawnSync(process.execPath, [path.join(laneRoot, "runner.mjs"), "--output", outputPath], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const lane = JSON.parse(fs.readFileSync(path.join(laneRoot, "lane.json"), "utf8"));
  const receipt = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(lane.providerRequired, false);
  assert.equal(lane.modelTokensExpected, 0);
  assert.equal(receipt.laneId, lane.id);
  assert.deepEqual(receipt.cases.map((item) => item.id), lane.cases.map((item) => item.id));
  assert.equal(receipt.summary.configuredCases, 9);
  assert.equal(receipt.summary.executedCases, 9);
  assert.equal(receipt.summary.passedCases, 9);
  assert.equal(receipt.summary.failedCases, 0);
  assert.equal(receipt.summary.passed, true);
  assert.deepEqual(receipt.provider, {
    required: false,
    used: false,
    calls: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0
  });
  assert.equal(receipt.metrics.context.projections, 1);
  assert.equal(receipt.metrics.context.noops, 2);
  assert.equal(receipt.metrics.context.governorProviderCalls, 0);
  assert.equal(receipt.metrics.context.toolProtocolOrphans, 0);
  assert.equal(receipt.metrics.operations.pristineRetriesAllowed, 2);
  assert.equal(receipt.metrics.operations.unsafeRetriesAllowed, 0);
  assert.equal(receipt.metrics.operations.unsafeRetriesAborted, 2);
  assert.equal(receipt.metrics.operations.duplicateTerminalSettlements, 0);
  assert.equal(receipt.metrics.operations.lateEventsIgnored, 1);
  assert.equal(receipt.metrics.emissions.finalMessagesSuppressed, 0);
  assert.equal(receipt.metrics.edits.staleEvaluations, 1);
  assert.equal(receipt.metrics.edits.staleMutationsAllowed, 0);
  assert.equal(receipt.metrics.edits.freshRereadRecoveries, 1);
  assert.equal(Object.values(receipt.gates).every(Boolean), true);
  assert.match(receipt.claimBoundary, /does not prove model quality/i);
});

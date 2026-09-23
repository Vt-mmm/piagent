import assert from "node:assert/strict";
import test from "node:test";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const generatedAt = "2026-09-05T15:26:54.000Z";
const options = { currentWorkingTreeDigest: versionWorkingTreeHash("b".repeat(64)) };
function task(text) {
  const built = buildAcceptanceReceipt({ summary: "Implement the declared behavior.", acceptanceCriteria: [text],
    changeMode: "source-change", source: "runtime", generatedAt });
  return { taskId: "capability", taskRunId: "capability-run", changeMode: "source-change",
    workingTreeDigestAlgorithm: "wt-content-v2", acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: built.receipt, verifyCommands: ["node --test"], verifyEvidence: [] };
}

test("compound proof capability is separate from missing executable tests", () => {
  const grouped = task("Reject invalid input.\nPreserve input ordering.");
  const result = refreshAcceptanceReceipt(grouped, options);
  assert.equal(result.independentRequired.length, 1);
  assert.equal(result.independentRequired[0].status, "pending");
  assert.equal(result.criticalMissing.length, 1);
  const atomic = refreshAcceptanceReceipt(task("Reject invalid input."), options);
  assert.equal(atomic.independentRequired.length, 0);
  assert.equal(atomic.criticalMissing.length, 1, "missing tests are still unproven");
});

test("copied satisfied compound status cannot create independent proof", () => {
  const grouped = task("Reject invalid input.\nPreserve input ordering.");
  grouped.acceptanceReceipt.criteria[0].status = "satisfied";
  const result = refreshAcceptanceReceipt(grouped, options);
  assert.equal(result.independentRequired.length, 1);
  assert.equal(result.receipt.criteria[0].status, "pending");
  assert.deepEqual(result.receipt.criteria[0].evidence, []);
});

test("stale criterion binding stays unproven without inventing a capability diagnosis", () => {
  const grouped = task("Reject invalid input.\nPreserve input ordering.");
  grouped.acceptanceReceipt.criteria[0].hash = "c".repeat(64);
  const result = refreshAcceptanceReceipt(grouped, options);
  assert.equal(result.independentRequired.length, 0);
  assert.equal(result.criticalMissing.length, 1);
  assert.equal(result.receipt.criteria[0].status, "pending");
});

test("an absent receipt does not invent independent verification requirements", () => {
  assert.deepEqual(refreshAcceptanceReceipt({}, options).independentRequired, []);
});

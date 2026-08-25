import assert from "node:assert/strict";
import test from "node:test";

import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";

function hasReadOnlyEvidence(input) {
  return buildAcceptanceReceipt({
    acceptanceCriteria: ["The requested implementation is complete."],
    changeMode: "source-change",
    mutationPolicy: "required",
    source: "runtime",
    generatedAt: "2026-08-24T00:00:00.000Z",
    ...input
  }).receipt.criteria.some((criterion) => criterion.obligation === "read-only-evidence");
}

test("acceptance boundary inference requires wording and its durable path in the same clause", () => {
  assert.equal(hasReadOnlyEvidence({
    summary: "Implement list/detail read-only UI for admins.",
    expectedOutput: "Use the v-nexus-backend contract while updating the frontend.",
    outOfScope: ["v-nexus-backend/**"]
  }), false);

  assert.equal(hasReadOnlyEvidence({
    summary: "Implement list/detail read-only UI for admins. Use the v-nexus-backend contract.",
    expectedOutput: "Update the frontend.",
    outOfScope: ["v-nexus-backend/**"]
  }), false);
});

test("acceptance boundary inference preserves explicit edit and modify path constraints", () => {
  for (const expectedOutput of [
    "Do not edit v-nexus-backend/**.",
    "Do not modify v-nexus-backend/**.",
    "Keep v-nexus-backend/** read-only."
  ]) {
    assert.equal(hasReadOnlyEvidence({
      summary: "Implement the frontend update.",
      expectedOutput,
      outOfScope: ["v-nexus-backend/**"]
    }), true, expectedOutput);
  }
});

test("task-wide read-only authority remains independent of local path wording", () => {
  const receipt = buildAcceptanceReceipt({
    summary: "Run the configured verifier.",
    expectedOutput: "Report exact verifier evidence.",
    acceptanceCriteria: ["The verifier passes."],
    changeMode: "source-change",
    mutationPolicy: "forbidden",
    source: "runtime",
    generatedAt: "2026-08-24T00:00:00.000Z"
  });
  assert.equal(receipt.receipt.criteria.some((criterion) => criterion.obligation === "read-only-evidence"), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { applyIndependentCriterionAssessment } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";

for (const [verdict, status] of [["pass", "satisfied"], ["fail", "blocked"], ["unknown", "pending"], ["error", "pending"]]) {
  test(`the ${verdict} projection is stable and does not invent a different evidence class`, () => {
    // Projection formatting only: these objects are not authenticated receipts.
    const criterion = { status: "pending", evidence: [] };
    const assessment = { verdict, sourcePath: "src/sum.js", reasons: ["diagnostic-reason"], failedChecks: verdict === "fail" ? ["sum"] : [] };
    assert.equal(applyIndependentCriterionAssessment(criterion, assessment, "snapshot", "first"), true);
    assert.equal(criterion.status, status);
    assert.equal(criterion.updatedAt, "first");
    assert.equal(applyIndependentCriterionAssessment(criterion, assessment, "snapshot", "later"), false);
    assert.equal(criterion.updatedAt, "first"); assert.equal(criterion.evidence[0].recordedAt, "first");
    assert.equal(criterion.evidence[0].summary.includes("counterexample"), verdict === "fail");
    assert.equal(applyIndependentCriterionAssessment(criterion, { verdict: "unknown", reasons: ["missing"] }, "snapshot", "invalidated"), true);
    assert.equal(criterion.status, "pending"); assert.deepEqual(criterion.evidence, []);
  });
}

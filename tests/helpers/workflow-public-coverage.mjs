import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import assert from "node:assert/strict";

// Public workflow family witnesses, bound to clauses from the actual request.
// This is a test-only coverage review, not a registered benchmark treatment.
export const workflowClauseCoverage = Object.freeze([
  [
    ["while preserving", ["initial-select", "first-message"]],
    ["When `state` is omitted", ["initial-select", "initial-override"]],
    ["The reducer accepts two tagged", ["initial-select", "first-message"]],
    ["Tagged event variant `workflow/select`", ["invalid-workflow-select", "malformed-select-0", "malformed-select-1", "malformed-select-2", "malformed-select-3"]],
    ["It changes only", ["switch-preserves-messages"]],
    ["it must never clear", ["switch-preserves-messages", "second-workflow", "after-switch-message"]],
    ["Tagged event variant `message/accepted`", ["invalid-duplicate-text", "malformed-duplicate-id-0", "malformed-duplicate-text-0"]]
  ],
  [
    ["It is appended once", ["first-message", "after-switch-message", "duplicate-valid"]],
    ["For tagged event variant `message/accepted`", ["invalid-duplicate-override", "invalid-duplicate-null", "new-override"]],
    ["Only when that property is absent", ["first-message", "initial-override"]],
    ["Validate the required fields", ["invalid-duplicate-text", "invalid-duplicate-override", "invalid-duplicate-null"]]
  ],
  [
    ["After that validation", ["duplicate-valid", "replay-after-reset"]],
    ["For a non-duplicate message", ["no-active-workflow"]],
    ["This active-workflow check", ["duplicate-no-active-workflow"]],
    ["A valid override selects", ["new-override", "after-switch-message", "initial-override"]]
  ],
  [
    ["Preserve message order", ["first-message", "second-workflow", "after-switch-message", "invalid-duplicate-text", "invalid-duplicate-override", "invalid-duplicate-null", "invalid-workflow-select", "malformed-duplicate-id-0", "malformed-duplicate-id-1", "malformed-duplicate-id-2", "malformed-duplicate-id-3", "malformed-duplicate-id-4", "malformed-duplicate-text-0", "malformed-duplicate-text-1", "malformed-duplicate-text-2", "malformed-duplicate-text-3", "malformed-duplicate-text-4", "malformed-duplicate-workflow-0", "malformed-duplicate-workflow-1", "malformed-duplicate-workflow-2", "malformed-duplicate-workflow-3", "malformed-duplicate-workflow-4", "malformed-select-0", "malformed-select-1", "malformed-select-2", "malformed-select-3"]],
    ["Run the configured verification.", [], "current-project-verifier"]
  ]
]);

export function workflowCoveredContracts(criteria, family) {
  assert.equal(criteria.length, 5, "four compound criteria and one independent project-verifier obligation");
  const cases = family.template.checks.flatMap(check => check.cases);
  const byId = new Map(cases.map(item => [item.id, item]));
  return addPublicApiCoverage(workflowClauseCoverage.map((coverage, index) => {
    const criterion = criteria[index], clauses = criterion.criterionText.split("\n");
    assert.equal(clauses.length, coverage.length, `coverage drift in criterion ${index + 1}`);
    for (const [clauseIndex, [anchor, ids, hostFact]] of coverage.entries()) {
      assert.ok(clauses[clauseIndex].includes(anchor), clauses[clauseIndex]);
      assert.ok(ids.length || hostFact === "current-project-verifier");
      for (const id of ids) assert.ok(byId.has(id), `missing family witness: ${id}`);
    }
    // Keep the family's complete ordered histories when a case references a
    // predecessor. Every inclusion is reviewed above; no criterion gets an
    // unrelated aggregate plan by default.
    const selected = new Set(coverage.flatMap(([, ids]) => ids));
    const sequences = new Set(cases.filter(item => selected.has(item.id) && item.sequence).map(item => item.sequence));
    const included = cases.filter(item => selected.has(item.id) || (item.sequence && sequences.has(item.sequence)));
    return { route: "code", criterionId: criterion.criterionId, criterionHash: criterion.criterionHash,
      sourcePath: "src/platform/workflow-session.js", exportName: "reduceWorkflowSession", maxAttempts: 1,
      checks: [{ id: `workflow-criterion-${index + 1}`, cases: included.map(item => ({
        ...structuredClone(item), invocation: { kind: "call" }
      })) }] };
  }));
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Expectations follow the installed treatment bytes, never a test-only env flag.
// The enforce branch retains the original all-criteria-satisfied assertion.
export function assertJourneyAcceptance(repositoryRoot, terminalTask) {
  const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/policies/base-policy.json")));
  if (policy.finalGate?.acceptanceProofMode === "diagnostic") {
    const pending = terminalTask.acceptanceReceipt.criteria.filter(criterion => criterion.status === "pending").length;
    if (pending > 0) assert.ok(terminalTask.trace.notes.includes(`Diagnostic acceptance: ${pending} criteria remain unproved; no quality claim.`));
    else assert.doesNotMatch(terminalTask.trace.notes ?? "", /Diagnostic acceptance:/);
  } else {
    assert.ok(terminalTask.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
  }
}

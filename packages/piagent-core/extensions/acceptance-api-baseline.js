// Core consumes a reader supplied by the runtime composition root. It never
// imports the runtime's private baseline store or grants proof without it.
const apiClause = /^(?:keep|preserve|do\s+not\s+change)\s+(?:the\s+)?(?:(?:public|exported)\s+)?api(?:\s+unchanged)?(?:\s+and\s+(?:verify\s+(?:the\s+)?project|run\s+(?:the\s+)?configured\s+verification))?[.!;]?$/i;
export const isApiPreservationCriterion = text => typeof text === "string" && apiClause.test(text.trim());

export function apiBaselineCriterionEvidence(input) {
  const index = input.task?.acceptanceReceipt?.criteria?.findIndex(item => item.id === input.criterion?.id) ?? -1;
  if (!isApiPreservationCriterion(input.task?.acceptanceCriteria?.[index])) return { handled: false };
  return typeof input.apiBaselineEvidence === "function" ? input.apiBaselineEvidence(input)
    : { handled: true, reason: "api-baseline-reader-unavailable" };
}

export function apiBaselineRecoveryProjection(input) {
  const result = apiBaselineCriterionEvidence(input);
  if (!result.handled || result.evidence) return { handled: result.handled };
  const changed = ["api-contract-changed", "api-unrelated-implementation-changed"].includes(result.reason);
  return { handled: true, projection: {
    criterionId: input.criterion.id, criterionHash: input.criterion.hash,
    criterionText: input.criterionText, targets: [], missingDimensions: [result.reason],
    proofHints: [changed
      ? "The task-start comparison found a changed public contract or an unrequested implementation change. Inspect that difference; do not waive the API requirement."
      : "API baseline proof is unavailable or unsupported at the recorded boundary. Restore current task-bound evidence or obtain an approved assessment; this is not an observed source defect."]
  } };
}

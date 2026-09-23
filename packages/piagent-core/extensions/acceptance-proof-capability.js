import {
  acceptanceCriterionBindingValid,
  compoundAcceptanceCriterion,
  criterionBehaviorProofDisposition,
  criterionRequiresBehavioralProof
} from "./acceptance-behavior-proof.js";

// This projection diagnoses missing proof; it never grants acceptance or
// independent authority. A current counterexample retains its repair route.
export function missingAcceptanceProofCapabilities(task, receipt, { corpus, passingVerifier, taskText, independentAssessments, sourceProofRequiredIds = new Set() }) {
  const missing = receipt.criteria.filter(criterion => criterion.status !== "satisfied");
  const adapterAbstained = missing.filter(criterion => criterionBehaviorProofDisposition({
    obligation: criterion.obligation, task, criterion, taskText, corpus, passingVerifier
  }) === "unknown");
  const criticalMissing = missing.filter(criterion => criterion.priority === "critical"
    || criterionRequiresBehavioralProof(task, criterion, taskText));
  // Grouped requirements have no local matcher route. Do not diagnose a stale
  // binding as a capability gap or reinterpret a signed failure as unsupported.
  const independentRequired = receipt.criteria.filter((criterion, index) => criterion.status !== "satisfied"
    && acceptanceCriterionBindingValid(task, receipt, criterion, index)
    && compoundAcceptanceCriterion(task.acceptanceCriteria[index])
    && !independentAssessments.has(criterion.id));
  const sourceProofRequired = criticalMissing.filter(criterion => sourceProofRequiredIds.has(criterion.id)
    && !independentAssessments.has(criterion.id));
  return { missing, criticalMissing, adapterAbstained, independentRequired, sourceProofRequired };
}

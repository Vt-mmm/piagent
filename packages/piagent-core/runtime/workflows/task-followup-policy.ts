import { normalizePathCandidate } from "../../extensions/policy-core.js";
import { foldChangeIntent } from "./change-clarification.ts";

const CONDITIONAL_INSPECTION_INTENT = /\b(?:audit|check|inspect|review|tests?|verify|validate|rerun|re-run|recheck|re-check|kiem tra|ra soat|xac minh|danh gia|chay lai)\b/i;
const CONDITIONAL_REPAIR_INTENT = [
  /\b(?:if|when)\b.{0,140}\b(?:address|change|correct(?:ing)?|edit|fix|patch|repair|resolve|update)\b/i,
  /\b(?:address|change|correct(?:ing)?|edit|fix|patch|repair|resolve|update)\b.{0,120}\b(?:(?:if|when|as)\s+(?:needed|necessary|required)|any\s+(?:failures?|issues?|errors?|problems?|defects?|findings?)|whatever\s+fails|(?:failures?|issues?|errors?|problems?|defects?|findings?)\s+(?:(?:(?:if|when)\s+)?(?:found|detected|discovered)|if\s+any|(?:you|we)\s+find))\b/i,
  /\b(?:audit|check|inspect|review|tests?|verify|validate|rerun|re-run|recheck|re-check)\b.{0,180}\b(?:address|correct(?:ing)?|fix|patch|repair|resolve)\b.{0,80}\b(?:failures?|issues?|errors?|problems?|defects?|findings?|failing\s+tests?)\b/i,
  /\b(?:neu|khi)\b.{0,140}\b(?:cap nhat|chinh sua|fix|khac phuc|sua)\b/i,
  /\b(?:cap nhat|chinh sua|fix|khac phuc|sua)\b.{0,120}\b(?:neu can|khi can|neu co|loi|van de)\b/i
];

export type PriorTaskScopeEvidence = {
  trace?: { outcome?: string };
  changedFiles?: unknown;
  observedChangedFiles?: unknown;
  contextManifest?: unknown;
};

export function hasConditionalRepairIntent(text: string): boolean {
  const folded = foldChangeIntent(text);
  return CONDITIONAL_INSPECTION_INTENT.test(folded)
    && CONDITIONAL_REPAIR_INTENT.some((pattern) => pattern.test(folded));
}

function refersToEarlierImplementation(prompt: string): boolean {
  const folded = foldChangeIntent(prompt);
  return [
    /\b(?:current|existing|earlier|previous|prior|above)\s+(?:changes?|fix|implementation|logic|work)\b/i,
    /\b(?:earlier|previous|prior|original|above)\s+(?:instructions?|obligations?|request|requirements?|task)\b/i,
    /\b(?:changes?|fix|implementation|logic|work)\s+(?:above|earlier|previously|just\s+(?:completed|made|implemented))\b/i,
    /\bwhat\s+(?:you|we)\s+just\s+(?:changed|fixed|implemented)\b/i,
    /\b(?:implementation|phan|logic|thay doi|yeu cau)\s+(?:hien tai|truoc do|vua roi|vua sua|vua lam|vua trien khai)\b/i,
    /\b(?:vua sua|vua lam|vua trien khai|thay doi vua roi|thay doi truoc do)\b/i
  ].some((pattern) => pattern.test(folded));
}

export function completedFollowupScope(
  prompt: string,
  task: PriorTaskScopeEvidence | undefined,
  plausiblePath: (value: string) => boolean
): string[] {
  if (!refersToEarlierImplementation(prompt) || task?.trace?.outcome !== "completed") return [];
  const changed = [task.changedFiles, task.observedChangedFiles]
    .flatMap((value) => Array.isArray(value) ? value : []);
  const context = Array.isArray(task.contextManifest)
    ? task.contextManifest.map((item) => item && typeof item === "object" ? (item as { path?: unknown }).path : undefined)
    : [];
  return [...new Set([...changed, ...context]
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizePathCandidate(value))
    .filter((candidate): candidate is string => Boolean(
      candidate
      && candidate !== "."
      && !candidate.startsWith(".pi/")
      && !["AGENTS.md", "README.md", "REVIEW_GUIDELINES.md"].includes(candidate)
      && plausiblePath(candidate)
    )))]
    .slice(0, 8);
}

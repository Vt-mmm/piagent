import { createHash } from "node:crypto";
import { namedTargetBindings, sanitizeJavaScriptEvidence, sourceExports } from "./acceptance-contract-semantics.js";
import { executableRejectionAssertions } from "./acceptance-executable-evidence.js";
import { routeNamedSourceTargets } from "./acceptance-source-origin.js";

// This is an additional provenance gate, not a numeric semantics prover. A
// positive operation cannot borrow a rejection assertion or another function's
// boundary tests. Keep the exact criterion hash and immediate subject context;
// unresolved pronouns/ownership stay unproven instead of guessing by test names.
export function boundaryTargetHasLiveSuccess({ task, criterion, corpus }) {
  const criteria = task.acceptanceCriteria ?? [];
  const index = criteria.findIndex(text => typeof text === "string"
    && createHash("sha256").update(text).digest("hex") === criterion.hash);
  const text = index >= 0 ? criteria[index] : "";
  if (!/\bclamps?\b/i.test(text)) return true;
  if (!/^otherwise\s+it\b|^`[A-Za-z_$][\w$]*`\s+clamps?\b/i.test(text.trim())) return true;
  const subjectText = /^otherwise\s+it\b/i.test(text.trim()) ? criteria[index - 1] : text;
  const target = String(subjectText ?? "").trim().match(/^`([A-Za-z_$][\w$]*)`\s+(?:returns?|clamps?)\b/i)?.[1]?.toLowerCase();
  if (!target) return false;
  const { strictTargets, unresolvedTargets } = routeNamedSourceTargets({ namedTargets: [target], provenanceTargets: new Set(),
    sourceEntries: corpus.sourceEntries, exports: corpus.sourceEntries.flatMap(sourceExports), taskText: subjectText });
  if (strictTargets.length !== 1 || unresolvedTargets.length > 0) return false;
  const binding = namedTargetBindings(corpus.sourceEntries, corpus.testEntries, [target])[0];
  return Boolean(binding?.sourceName && binding.testBindings.some(testBinding => {
    const entry = corpus.testEntries.find(item => item.path === testBinding.testPath);
    if (!entry) return false;
    const code = sanitizeJavaScriptEvidence(entry.text).toLowerCase();
    return executableRejectionAssertions(code, new Set([testBinding.testName]), false, true)
      .some(assertion => assertion.mode === "does-not-throw" && assertion.targets.includes(testBinding.testName));
  }));
}

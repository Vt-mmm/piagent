type CriterionNode = {
  id?: string;
  obligation?: string;
  kind?: string;
  proofKinds?: string[];
  targetHints?: string[];
};

type CriterionGraph = { mode?: string; nodes?: CriterionNode[] } | undefined;

export type FocusedTestCandidate = {
  criterionId: string;
  path: string;
};

export type CriterionProofGuidance = {
  criterionId: string;
  guidance: string[];
};

type ProofTask = {
  changeMode?: string;
  mutationPolicy?: string;
  criterionGraph?: CriterionGraph;
};

export const RUNTIME_SOURCE_REUSE_GUIDANCE = "Use runtime-delivered source; do not reread it. On edit drift/oldText mismatch, use attached recovery; otherwise reread the affected region once. Never retry guessed anchors. Otherwise read only missing source or a named criterion-focused test. Globs/directories grant scope, not file targets.";

export const EXACT_VERIFIER_EXECUTION_GUIDANCE = "Keep each exact verifier command separate and unmodified. Run the set once on the final tree; rerun only after a later mutation or a runtime-authorized same-tree infrastructure retry.";

function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/");
}

function exactNameMentioned(obligation: string, file: string): boolean {
  const text = obligation.toLowerCase().replaceAll("\\", "/");
  const normalized = normalizedPath(file).toLowerCase();
  const basename = normalized.split("/").pop() ?? "";
  return [normalized, basename].filter(Boolean).some((candidate) => {
    let offset = text.indexOf(candidate);
    while (offset >= 0) {
      const before = text[offset - 1] ?? "";
      const after = text[offset + candidate.length] ?? "";
      const afterNext = text[offset + candidate.length + 1] ?? "";
      const nameContinuesAfter = /[a-z0-9_/-]/i.test(after) || (after === "." && /[a-z0-9_-]/i.test(afterNext));
      if (!/[a-z0-9_./-]/i.test(before) && !nameContinuesAfter) return true;
      offset = text.indexOf(candidate, offset + candidate.length);
    }
    return false;
  });
}

function behavioralNodes(criterionGraph: CriterionGraph): CriterionNode[] {
  return (criterionGraph?.nodes ?? []).filter((node) => (
    typeof node?.id === "string"
    && typeof node?.obligation === "string"
    && Array.isArray(node?.proofKinds)
    && node.proofKinds.includes("behavioral-check")
  ));
}

export function concretePlannedAcceptanceTests(
  plannedContext: Array<{ path: string; reason: string }>,
  repositoryFiles: string[],
  criterionGraph: CriterionGraph,
  isAcceptanceTestPath: (file: string) => boolean,
  acceptanceLanguageAdapterForPath: (file: string) => { disposition?: string }
): FocusedTestCandidate[] {
  const concreteFiles = new Set(repositoryFiles.map(normalizedPath));
  const nodes = behavioralNodes(criterionGraph);
  const candidates: FocusedTestCandidate[] = [];
  for (const entry of plannedContext) {
    const file = normalizedPath(entry.path);
    if (!file || /[?*[\]{}]/.test(file) || !concreteFiles.has(file)) continue;
    if (!isAcceptanceTestPath(file) || acceptanceLanguageAdapterForPath(file)?.disposition !== "supported") continue;
    if (/\.d\.[cm]?ts$/i.test(file)) continue;
    for (const node of nodes) {
      if (exactNameMentioned(node.obligation!, file)) candidates.push({ criterionId: node.id!, path: file });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const identity = `${candidate.criterionId}\0${candidate.path}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function behavioralCriterionProofGuidance(
  criterionGraph: CriterionGraph,
  acceptanceProofGuidance: (text: string) => string[]
): CriterionProofGuidance[] {
  return behavioralNodes(criterionGraph).map((node) => ({
    criterionId: node.id!,
    guidance: acceptanceProofGuidance(node.obligation!)
  }));
}

export function criticalProofSection(
  proofGuidance: string[],
  acceptanceTests: FocusedTestCandidate[],
  criterionProofs: CriterionProofGuidance[]
): string[] {
  if (proofGuidance.length === 0 && criterionProofs.length === 0) return [];
  const candidateMap = new Map<string, string[]>();
  for (const candidate of acceptanceTests) {
    candidateMap.set(candidate.criterionId, [...new Set([...(candidateMap.get(candidate.criterionId) ?? []), candidate.path])]);
  }
  let mappedCandidate = false;
  const criterionTag = (criterionId: string): string => {
    const candidates = candidateMap.get(criterionId) ?? [];
    if (candidates.length === 0) return `[${criterionId}:fallback]`;
    mappedCandidate = true;
    return `[${criterionId}:candidate=${candidates.join("|")}]`;
  };
  const proofLines = proofGuidance.flatMap((proof) => {
    const criterionIds = [...new Set(criterionProofs
      .filter((entry) => entry.guidance.includes(proof))
      .map((entry) => entry.criterionId))];
    if (criterionIds.length === 0) {
      return [`- [fallback] ${proof}`];
    }
    const tags = criterionIds.map(criterionTag);
    return [`- ${tags.join("")} ${proof}`];
  });
  const genericTags = criterionProofs.filter((entry) => entry.guidance.length === 0).map((entry) => criterionTag(entry.criterionId));
  const genericLines = genericTags.length > 0
    ? [`- ${genericTags.join("")} Prove every tagged observable clause with linked live assertions; the generic verifier alone is insufficient.`]
    : [];
  return [[
    "Critical behavioral proof:",
    ...(!mappedCandidate && genericTags.length === 0 ? ["No concrete criterion-linked focused test was selected."] : []),
    ...proofLines,
    ...genericLines,
    "Candidate tags are locations, not proof; add/update durable scoped tests with live assertions and changed-test evidence. Each fallback tag requires adding/updating a durable scoped focused test with live assertions. If test scope is unavailable, report missing durable proof and do not claim completion. Run proof after the criterion's final intended mutation and before exact verifiers; rerun after later target mutation or a runtime-authorized same-tree infrastructure retry. Transient/print-only probes and prose are insufficient. Claims must match diff/tests; never claim unproved behavior."
  ].join("\n")];
}

export function automaticTaskExecutionGuidance(task: ProofTask): string {
  if (task.changeMode === "read-only" || task.mutationPolicy === "forbidden") {
    return task.changeMode === "source-change"
      ? "Stay mutation-free. Runtime permits bounded inspection and the exact configured verifier, records completion evidence, and requires a zero task delta."
      : "Stay read-only. Runtime records targeted reads and completion evidence; do not call task-management tools.";
  }
  return task.criterionGraph?.mode === "criterion-graph"
    ? "Follow the execution map and implement dependency-ready criteria. The map plans work but never overrides the operator request or exact verifiers. Runtime records evidence and completion; do not call task-management tools."
    : "Privately map every operator criterion to implementation and durable focused-test coverage before mutating. Finish intended edits and a criterion-by-criterion self-review. Runtime records evidence and completion; do not call task-management tools.";
}

export function taskCriticalProofSection(
  task: ProofTask,
  plannedContext: Array<{ path: string; reason: string }>,
  repositoryFiles: string[],
  acceptanceProofGuidance: (taskOrText: unknown) => string[],
  isAcceptanceTestPath: (file: string) => boolean,
  acceptanceLanguageAdapterForPath: (file: string) => { disposition?: string },
  requireGenericFallback = true
): string[] {
  const proofGuidance = task.changeMode === "source-change" && task.mutationPolicy !== "forbidden"
    ? acceptanceProofGuidance(task)
    : [];
  const acceptanceTests = concretePlannedAcceptanceTests(
    plannedContext, repositoryFiles, task.criterionGraph, isAcceptanceTestPath, acceptanceLanguageAdapterForPath
  );
  const criterionProofs = behavioralCriterionProofGuidance(task.criterionGraph, acceptanceProofGuidance)
    .filter((entry) => requireGenericFallback || entry.guidance.length > 0);
  return criticalProofSection(proofGuidance, acceptanceTests, criterionProofs);
}

import { estimateContextTokens } from "../../extensions/context-engine.js";

type RepositoryMemoryCandidate = {
  record: { id?: string; fact: string; citations: Array<{ path: string }> };
  matchedTerms: string[];
};

export function formatRepositoryMemoryHints(
  candidates: RepositoryMemoryCandidate[],
  budgetTokens: number
): { text: string; ids: string[] } {
  if (budgetTokens < 80 || candidates.length === 0) return { text: "", ids: [] };
  const lines = [
    "[Piagent repository memory: advisory only]",
    "Verify every hint against the cited current file before relying on it."
  ];
  const ids: string[] = [];
  for (const candidate of candidates) {
    const paths = candidate.record.citations.slice(0, 4).map((citation) => citation.path).join(", ");
    const line = `- ${candidate.record.fact.slice(0, 320)} [sources: ${paths}]`;
    const proposed = [...lines, line].join("\n");
    if (estimateContextTokens(proposed) > budgetTokens) break;
    lines.push(line);
    if (candidate.record.id) ids.push(candidate.record.id);
  }
  return ids.length > 0 ? { text: lines.join("\n"), ids } : { text: "", ids: [] };
}

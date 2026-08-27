import { hasExplicitInputRejection, malformedIdentifierContractText } from "./acceptance-boundary-guidance.js";

function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ");
}

function uniqueStrings(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

/** Pair one malformed-input criterion only with the smallest related identifier declaration. */
export function malformedIdentifierCriterionText(primary, task = {}, excluded = new Set()) {
  const direct = malformedIdentifierContractText(primary);
  if (direct) return direct;
  if (!hasExplicitInputRejection(primary)) return primary;
  const candidates = uniqueStrings([task?.summary, task?.expectedOutput, ...(task?.acceptanceCriteria ?? [])])
    .filter((candidate) => candidate !== primary && !excluded.has(candidate));
  for (const candidate of candidates) {
    const candidateContract = malformedIdentifierContractText(candidate);
    if (candidateContract && !normalizedText(candidate).includes(normalizedText(primary))) continue;
    const related = malformedIdentifierContractText(`${primary}\n${candidate}`);
    if (related) return related;
  }
  return primary;
}

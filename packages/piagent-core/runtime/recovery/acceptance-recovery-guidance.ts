export type CriticalRecoveryProjection = { criterionText: string; targets: string[]; missingDimensions: string[]; proofHints: string[]; diagnosticHints?: string[] };

function compactRecoveryField(value: unknown, maximum: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…` : text;
}
export function criticalAcceptanceRecoveryGuidance(projections: CriticalRecoveryProjection[], includeProofHints = true): string[] {
  if (projections.length === 0) return [];
  const lines = ["Critical proof targets (derived only from the current task contract and working tree):"];
  for (const projection of projections.slice(0, 8)) {
    const targets = projection.targets.map((item) => compactRecoveryField(item, 80)).filter(Boolean).slice(0, 8);
    const dimensions = projection.missingDimensions.map((item) => compactRecoveryField(item, 80)).filter(Boolean).slice(0, 8);
    const criterion = compactRecoveryField(projection.criterionText, 700);
    lines.push(`- Target: ${targets.join(", ") || "task-scoped behavior"}; missing proof: ${dimensions.join(", ") || "focused-evidence"}; criterion: ${criterion}`);
  }
  const hints = [...new Set(projections.flatMap((projection) => includeProofHints ? projection.proofHints : projection.diagnosticHints ?? [])
    .map((hint) => compactRecoveryField(hint, 300))
    .filter(Boolean))].slice(0, 8);
  if (hints.length > 0) lines.push(includeProofHints ? "Proof requirements:" : "Diagnostic evidence (does not grant repair authority):", ...hints.map((hint) => `- ${hint}`));
  return lines;
}

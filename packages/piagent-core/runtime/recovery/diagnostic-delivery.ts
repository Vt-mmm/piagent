import fs from "node:fs";
import crypto from "node:crypto";
import type { TaskContract } from "../../extensions/guard-types.ts";

export type DiagnosticDelivery = { mode: "diagnostic"; qualityClaim: "withheld";
  policySha256: string; acceptanceDigest: string; pendingCriterionIds: string[] };

export function installedDiagnosticPolicyDigest(): string | undefined {
  try {
    const bytes = fs.readFileSync(new URL("../../policies/base-policy.json", import.meta.url));
    return JSON.parse(bytes.toString()).finalGate?.acceptanceProofMode === "diagnostic"
      ? crypto.createHash("sha256").update(bytes).digest("hex") : undefined;
  } catch { return undefined; }
}

export function validDiagnosticDelivery(value: unknown, acceptanceDigest: unknown): value is DiagnosticDelivery {
  const d = value as DiagnosticDelivery;
  return Boolean(d && Object.keys(d).sort().join(",") === "acceptanceDigest,mode,pendingCriterionIds,policySha256,qualityClaim"
    && d.mode === "diagnostic" && d.qualityClaim === "withheld"
    && /^[a-f0-9]{64}$/.test(d.policySha256) && /^[a-f0-9]{64}$/.test(d.acceptanceDigest)
    && d.acceptanceDigest === acceptanceDigest && Array.isArray(d.pendingCriterionIds)
    && d.pendingCriterionIds.length > 0 && d.pendingCriterionIds.length <= 12
    && new Set(d.pendingCriterionIds).size === d.pendingCriterionIds.length
    && d.pendingCriterionIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 160));
}

export function diagnosticDeliveryMatchesTask(d: DiagnosticDelivery, task: TaskContract, acceptanceDigest: string): boolean {
  const pending = (task.acceptanceReceipt?.criteria ?? []).filter(c => c.status !== "satisfied").map(c => c.id).sort();
  return validDiagnosticDelivery(d, acceptanceDigest) && d.policySha256 === installedDiagnosticPolicyDigest()
    && JSON.stringify([...d.pendingCriterionIds].sort()) === JSON.stringify(pending);
}

export function diagnosticDeliveryStateErrors(state: Record<string, any> | null, acceptance: Record<string, any> | null): string[] {
  const d = state?.diagnosticDelivery;
  if (d === undefined) return [];
  return !validDiagnosticDelivery(d, acceptance?.dispositionDigest) || state?.completionApproved !== false
    || acceptance?.satisfied !== false || state?.gateDecision !== "pass" || state?.taskOutcome !== "completed"
    || d.pendingCriterionIds.length > (acceptance?.criteriaCount ?? 0) ? ["diagnostic delivery is invalid"] : [];
}

export function buildDiagnosticDelivery(task: TaskContract,
  gate: { decision: string; missing: string[]; missingVerifyCommands: string[];
    acceptanceProof?: { mode: string; pendingCriterionIds: string[] } },
  acceptance: { satisfied: boolean; dispositionDigest: string }, operationalEvidenceCurrent: boolean): DiagnosticDelivery | undefined {
  const policySha256 = installedDiagnosticPolicyDigest();
  return !acceptance.satisfied && policySha256 && gate.acceptanceProof?.mode === "diagnostic"
    && gate.decision === "pass" && task.trace.outcome === "completed" && operationalEvidenceCurrent
    && gate.missing.length === 0 && gate.missingVerifyCommands.length === 0
    ? { mode: "diagnostic", qualityClaim: "withheld", policySha256,
      acceptanceDigest: acceptance.dispositionDigest, pendingCriterionIds: [...gate.acceptanceProof.pendingCriterionIds] }
    : undefined;
}

export function diagnosticCompletionMissing(decision: string, missing: string[], acceptanceSatisfied: boolean,
  evidenceCurrent: boolean, gateDigestCurrent: boolean, currentExactVerifier: boolean): string[] {
  return [...missing,
    ...(decision === "pass" && !acceptanceSatisfied ? ["acceptance-criteria-pending"] : []),
    ...(decision === "pass" && !evidenceCurrent ? ["working-tree-evidence-not-current"] : []),
    ...(decision === "pass" && !gateDigestCurrent ? ["completion-gate-tree-digest-untrusted-or-mismatched"] : []),
    ...(decision === "pass" && !currentExactVerifier ? ["current exact verifier evidence"] : [])];
}

export const AUTHENTICATED_ADMISSION_VERSION: "authenticated-acceptance-admission-v1";
export type AuthenticatedAssessment = Readonly<{
  version: typeof AUTHENTICATED_ADMISSION_VERSION;
  verdict: "pass" | "fail" | "unknown" | "error";
  completionAllowed: boolean;
  repairEligible: boolean;
  sourceMutationAllowed: false;
  assurance: "none" | "bounded-contract-tested";
  reasons: readonly string[];
  failedChecks: readonly string[];
  missingChecks: readonly string[];
  attemptId?: string;
  criterionId?: string;
  taskRunId?: string;
  criterionHash?: string;
  sourcePath?: string;
  workingTreeDigest?: string;
  snapshotDigest?: string;
  projectVerificationDigest?: string;
  counterexamples?: readonly Readonly<{ digest: string; evidence: Readonly<{
    checkId: string; input: unknown; expected: unknown; observed: unknown;
  }> }>[];
}>;
export function unavailableAuthenticatedAssessment(reason: string): AuthenticatedAssessment;
export function currentAuthenticatedAssessment(receipt: unknown, current: {
  taskRunId: string; criterionId: string; criterionHash: string;
  workingTreeDigest: string; projectVerificationDigest: string | null; policy?: string;
}): AuthenticatedAssessment | null;

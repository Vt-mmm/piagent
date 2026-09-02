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
  factId?: string;
  taskRunId?: string;
  criterionHash?: string;
  sourcePath?: string;
  sourcePaths?: readonly string[];
  workingTreeDigest?: string;
  snapshotDigest?: string;
  projectVerificationDigest?: string;
  contractVersion?: string;
  profileDigest?: string;
  planDigest?: string;
  backendDigest?: string;
  checks?: readonly Readonly<{ id: string; status: "pass" | "fail" | "unknown" | "error";
    caseCount: number; counterexampleRef?: string }> [];
  executionDiagnostics?: Readonly<{
    status: "completed" | "timeout" | "cancelled" | "error";
    cleanupConfirmed: boolean; reasons: readonly string[];
    unsupportedCaseCount: number; errorCaseCount: number;
  }>;
  counterexamples?: readonly Readonly<{ digest: string; evidence: Readonly<{
    checkId: string; input: unknown; expected: unknown; observed: unknown;
  }> }>[];
}>;
export function unavailableAuthenticatedAssessment(reason: string): AuthenticatedAssessment;
export function currentAuthenticatedAssessment(receipt: unknown, current: {
  taskRunId: string; criterionId: string; criterionHash: string;
  workingTreeDigest: string; projectVerificationDigest: string | null; factId?: string; policy?: string;
}): AuthenticatedAssessment | null;

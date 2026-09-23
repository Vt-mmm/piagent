import type { openAcceptanceEvidenceStore } from "./acceptance-evidence-store.js";
import type { captureExecutionSnapshot } from "./acceptance-execution-snapshot.js";
import type { AuthenticatedAssessment } from "./acceptance-authenticated-admission.js";

export const DURABLE_EXECUTION_VERSION: "durable-module-contract-v2";
export type LegacyDurableContractScope = { taskRunId: string; criterionId: string };
export type FactDurableContractScope = { version: "authenticated-contract-fact-scope-v2";
  taskRunId: string; criterionId: string; factId: string };
export type DurableContractScope = LegacyDurableContractScope | FactDurableContractScope;
export type ProjectVerificationRequest = DurableContractScope & {
  criterionHash: string;
  snapshot: ReturnType<typeof captureExecutionSnapshot>["binding"];
  snapshotDigest: string;
};
export type DurableContractConfiguration = {
  store: ReturnType<typeof openAcceptanceEvidenceStore>;
  projectRoot: string;
  sourcePath: string;
  modulePaths?: readonly string[];
  authorizeSourceRead: (input: { projectRoot: string; sourcePath: string }) => boolean;
  exportName: string;
  checks: unknown[];
  profile?: Readonly<{ id: string; digest: string; workerVersion: string }>;
  imageId: string;
  dockerSocket: string;
  dockerCommand?: Readonly<{ path: string; sha256: string }>;
  verifierDigest: string;
  getProjectVerificationDigest: (input: ProjectVerificationRequest) => string | null | Promise<string | null>;
  timeoutMs?: number;
  /** Extra attached-command wait; guest watchdog and CPU/wall budgets are unchanged. */
  startupAllowanceMs?: number;
};
export type DurableContractResult = Readonly<{
  version: typeof DURABLE_EXECUTION_VERSION;
  verdict: "pass" | "fail" | "unknown" | "error";
  completionAllowed: false;
  reason?: string;
  attemptId?: string;
  reused?: boolean;
  evidence?: Readonly<{
    version: typeof DURABLE_EXECUTION_VERSION;
    verdict: "pass" | "fail" | "unknown" | "error";
    snapshotDigest: string;
    planDigest: string;
    reason?: string;
    observed: unknown;
  }>;
}>;
export function createDurableContractRunner(configuration: DurableContractConfiguration): Readonly<{
  version: typeof DURABLE_EXECUTION_VERSION;
  run(input: {
    scope: DurableContractScope;
    criterionHash: string;
    maxAttempts: number;
    retry?: boolean;
    signal?: AbortSignal;
  }): Promise<DurableContractResult>;
  assess(result: unknown, options?: { policy?: string }): Promise<AuthenticatedAssessment>;
}>;

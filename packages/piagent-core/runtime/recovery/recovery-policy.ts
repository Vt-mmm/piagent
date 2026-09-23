import type { FailureClassification } from "../../extensions/failure-types.ts";
import { failureClassificationValidationErrors } from "../../extensions/failure-types.ts";
import {
  RECOVERY_ACTIONS, RECOVERY_CEILINGS, RECOVERY_POLICY_VERSION, RECOVERY_REASON_CODES, recoveryDecisionValidationErrors
} from "../../extensions/recovery-decision-validation.ts";
import type { TrajectoryPhase } from "../trajectory/trajectory-types.ts";

export { RECOVERY_ACTIONS, RECOVERY_CEILINGS, RECOVERY_POLICY_VERSION, RECOVERY_REASON_CODES, recoveryDecisionValidationErrors };

export type RecoveryAction = typeof RECOVERY_ACTIONS[number];
export type RecoveryDisposition = "scheduled" | "failed" | "succeeded" | "declined";
export type RecoveryReasonCode = typeof RECOVERY_REASON_CODES[number];

export type RecoveryHistoryEntry = {
  taskId: string;
  taskRunId: string;
  taskAttempt: number;
  evidenceDigest: string;
  failureCategory: FailureClassification["category"];
  action: RecoveryAction;
  disposition: RecoveryDisposition;
  phase: TrajectoryPhase;
  hypothesisRef: string | null;
};

export type RecoveryPolicyInput = {
  featureEnabled: boolean;
  task: {
    taskId: string;
    taskRunId: string;
    attempt: number;
    maxAttempts: number;
    changeMode: "source-change" | "read-only";
  };
  classification: FailureClassification;
  currentPhase: TrajectoryPhase;
  history?: RecoveryHistoryEntry[];
  ruledOutHypothesisRefs?: string[];
  proposedHypothesisRef?: string | null;
  exactVerifierAvailable?: boolean;
  currentTreeMatchesEvidence?: boolean;
  dependencyMutationAuthorized?: boolean;
  independentDisposition?: "cancelled" | "reconcile" | "unsupported" | "halt" | "approval";
};

export type RecoveryDecision = {
  policyVersion: typeof RECOVERY_POLICY_VERSION;
  taskId: string;
  taskRunId: string;
  taskAttempt: number;
  evidenceDigest: string;
  failureCategory: FailureClassification["category"];
  currentPhase: TrajectoryPhase;
  action: RecoveryAction;
  continuation: "none" | "same-session" | "fresh-session" | "operator";
  nextPhase: TrajectoryPhase | null;
  sourceMutationAllowed: boolean;
  reasonCodes: RecoveryReasonCode[];
  counts: {
    sourceRepairPasses: number;
    transientVerifierRetries: number;
    unknownDiagnosticPasses: number;
    providerRetries: number;
  };
  ceilings: typeof RECOVERY_CEILINGS;
  hypothesisRef: string | null;
};

const REF = /^[a-z0-9][a-z0-9:._-]{0,255}$/i;
const COUNTED_DISPOSITIONS = new Set<RecoveryDisposition>(["scheduled", "failed", "succeeded"]);

export function applyProofCapabilityHandoff(selected: RecoveryDecision, missing: string[] = [], hasIndependentRecovery = false): RecoveryDecision {
  let reason: RecoveryReasonCode | undefined;
  if (selected.failureCategory === "unknown" && !hasIndependentRecovery && selected.action !== "blocked"
    && missing.some(item => /^critical acceptance evidence independent-required\b/i.test(item))) reason = "independent-acceptance-proof-required";
  else if (selected.failureCategory === "unknown" && !hasIndependentRecovery && selected.action !== "blocked"
    && missing.some(item => /^critical acceptance evidence source-proof-required\b/i.test(item))) reason = "source-acceptance-proof-required";
  else if (missing.some(item => /^critical acceptance evidence adapter-unresolved\b/i.test(item))) reason = "deterministic-adapter-proof-required";
  return reason ? { ...selected, action: "handoff", continuation: "none", nextPhase: null,
    sourceMutationAllowed: false, reasonCodes: [reason] } : selected;
}

function validIdentity(input: RecoveryPolicyInput): boolean {
  return Boolean(
    input.task?.taskId?.trim()
    && input.task?.taskRunId?.trim()
    && Number.isInteger(input.task?.attempt)
    && input.task.attempt >= 1
    && Number.isInteger(input.task?.maxAttempts)
    && input.task.maxAttempts >= 1
    && input.task.attempt <= input.task.maxAttempts
  );
}

function cleanRef(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return REF.test(candidate) ? candidate : null;
}

function relevantHistory(input: RecoveryPolicyInput): RecoveryHistoryEntry[] {
  return (input.history ?? []).filter((entry) => (
    entry.taskId === input.task.taskId
    && COUNTED_DISPOSITIONS.has(entry.disposition)
  ));
}

function countsFor(input: RecoveryPolicyInput) {
  const history = relevantHistory(input);
  return {
    sourceRepairPasses: history.filter((entry) => entry.action === "repair").length,
    transientVerifierRetries: history.filter((entry) => entry.action === "retry" && entry.failureCategory !== "provider-network").length,
    unknownDiagnosticPasses: history.filter((entry) => entry.action === "retry" && entry.failureCategory === "unknown").length,
    providerRetries: history.filter((entry) => entry.action === "retry" && entry.failureCategory === "provider-network").length
  };
}

function decision(
  input: RecoveryPolicyInput,
  action: RecoveryAction,
  reasonCodes: RecoveryReasonCode[],
  options: Partial<Pick<RecoveryDecision, "continuation" | "nextPhase" | "sourceMutationAllowed">> = {}
): RecoveryDecision {
  return {
    policyVersion: RECOVERY_POLICY_VERSION,
    taskId: String(input.task?.taskId ?? ""),
    taskRunId: String(input.task?.taskRunId ?? ""),
    taskAttempt: Number(input.task?.attempt ?? 0),
    evidenceDigest: String(input.classification?.evidenceDigest ?? ""),
    failureCategory: input.classification?.category ?? "unknown",
    currentPhase: input.currentPhase,
    action,
    continuation: options.continuation ?? "none",
    nextPhase: options.nextPhase ?? null,
    sourceMutationAllowed: options.sourceMutationAllowed === true,
    reasonCodes,
    counts: countsFor(input),
    ceilings: RECOVERY_CEILINGS,
    hypothesisRef: cleanRef(input.proposedHypothesisRef)
  };
}

function repairDecision(input: RecoveryPolicyInput): RecoveryDecision {
  const counts = countsFor(input);
  if (input.task.changeMode === "read-only") return decision(input, "handoff", ["read-only-task"]);
  const hypothesisRef = cleanRef(input.proposedHypothesisRef);
  const ruledOut = new Set((input.ruledOutHypothesisRefs ?? []).map(cleanRef).filter(Boolean));
  const repeatedFailure = hypothesisRef !== null && relevantHistory(input).some((entry) => (
    entry.action === "repair" && entry.disposition === "failed" && entry.hypothesisRef === hypothesisRef
  ));
  if ((hypothesisRef && ruledOut.has(hypothesisRef)) || repeatedFailure) {
    return decision(input, "handoff", ["repeated-hypothesis"]);
  }
  if (counts.sourceRepairPasses >= RECOVERY_CEILINGS.sourceRepairPasses) {
    return decision(input, "handoff", ["repair-ceiling-reached"]);
  }
  return decision(input, "repair", ["source-repair-eligible"], {
    continuation: "same-session",
    nextPhase: "repair",
    sourceMutationAllowed: true
  });
}

export function selectRecoveryDecision(input: RecoveryPolicyInput): RecoveryDecision {
  const invalidClassification = failureClassificationValidationErrors(input.classification).length > 0;
  if (!validIdentity(input) || invalidClassification) return decision(input, "blocked", ["invalid-input"]);
  if (!input.featureEnabled) return decision(input, "handoff", ["feature-disabled"]);
  if (input.currentPhase === "terminal") return decision(input, "blocked", ["terminal-phase"]);
  if (input.currentPhase === "handoff") return decision(input, "handoff", ["handoff-already-observed"]);
  if (input.classification.category === "passed") return decision(input, "handoff", ["no-failure"]);
  // Protected-path evidence cannot be repaired by another model turn. The
  // failure category also accepts historical scope diagnostics for replay
  // compatibility, but current task scope itself is advisory.
  if (input.classification.category === "scope-protected-path") {
    return decision(input, "handoff", ["protected-path-forbidden"]);
  }
  const independentCategories = { cancelled: "unknown", reconcile: "environment", unsupported: "unknown", halt: "unknown", approval: "environment" };
  if (input.independentDisposition !== undefined && (typeof input.independentDisposition !== "string"
    || !Object.hasOwn(independentCategories, input.independentDisposition)
    || independentCategories[input.independentDisposition] !== input.classification.category)) return decision(input, "blocked", ["invalid-input"]);
  if (input.independentDisposition === "cancelled") return decision(input, "handoff", ["independent-execution-cancelled"]);
  if (input.independentDisposition === "reconcile") return decision(input, "ask-operator", ["independent-execution-reconciliation-required"], { continuation: "operator" });
  if (input.independentDisposition === "unsupported") return decision(input, "handoff", ["independent-verifier-unsupported"]);
  if (input.independentDisposition === "halt") return decision(input, "handoff", ["independent-verification-halted"]);
  if (input.independentDisposition === "approval") return decision(input, "ask-operator", ["operator-environment-action"], { continuation: "operator" });

  const counts = countsFor(input);
  if (input.currentTreeMatchesEvidence === false && input.exactVerifierAvailable === true) {
    if (counts.transientVerifierRetries < RECOVERY_CEILINGS.transientVerifierRetries) {
      return decision(input, "retry", ["stale-verifier-evidence"], { continuation: "same-session", nextPhase: "verify" });
    }
    return decision(input, "handoff", ["transient-retry-unavailable"]);
  }

  if (["compile-typecheck", "test-assertion", "lint-format"].includes(input.classification.category)) {
    return repairDecision(input);
  }
  if (input.classification.category === "dependency-config") {
    return input.dependencyMutationAuthorized === true
      ? repairDecision(input)
      : decision(input, "ask-operator", ["dependency-mutation-not-authorized"], { continuation: "operator" });
  }
  if (input.classification.category === "environment") {
    return decision(input, "ask-operator", ["operator-environment-action"], { continuation: "operator" });
  }
  if (input.classification.category === "provider-network") {
    if (input.classification.retryable && counts.providerRetries < RECOVERY_CEILINGS.providerRetries) {
      return decision(input, "retry", ["provider-transient-retry"], { continuation: "same-session", nextPhase: input.currentPhase });
    }
    return input.task.attempt < input.task.maxAttempts
      ? decision(input, "fresh-session", ["provider-retry-exhausted"], { continuation: "fresh-session" })
      : decision(input, "handoff", ["provider-retry-exhausted"]);
  }
  if (input.classification.category === "permission-policy") {
    return decision(input, "ask-operator", ["permission-expansion-forbidden"], { continuation: "operator" });
  }
  if (input.classification.category === "flaky-infrastructure") {
    if (input.exactVerifierAvailable && counts.transientVerifierRetries < RECOVERY_CEILINGS.transientVerifierRetries) {
      return decision(input, "retry", ["transient-verifier-retry"], { continuation: "same-session", nextPhase: "verify" });
    }
    return decision(input, "handoff", ["transient-retry-unavailable"]);
  }
  if (counts.unknownDiagnosticPasses < RECOVERY_CEILINGS.unknownDiagnosticPasses) {
    return decision(input, "retry", ["unknown-diagnostic-pass"], { continuation: "same-session", nextPhase: "scout" });
  }
  return decision(input, "handoff", ["unknown-diagnostic-exhausted"]);
}

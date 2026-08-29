import { FAILURE_CATEGORIES } from "./failure-types.ts";
import { TRAJECTORY_PHASES } from "./trajectory-contract.ts";

export const RECOVERY_POLICY_VERSION = "recovery-v1" as const;
export const RECOVERY_ACTIONS = Object.freeze(["repair", "retry", "fresh-session", "ask-operator", "handoff", "blocked"] as const);
export const RECOVERY_CEILINGS = Object.freeze({
  sourceRepairPasses: 1, transientVerifierRetries: 1, unknownDiagnosticPasses: 1, providerRetries: 1
} as const);
export const RECOVERY_REASON_CODES = Object.freeze([
  "feature-disabled", "invalid-input", "terminal-phase", "handoff-already-observed", "no-failure",
  "stale-verifier-evidence", "source-repair-eligible", "dependency-mutation-not-authorized", "read-only-task",
  "repair-ceiling-reached", "repeated-hypothesis", "operator-environment-action", "provider-transient-retry",
  "provider-retry-exhausted", "permission-expansion-forbidden", "protected-path-forbidden", "scope-replan-required",
  "transient-verifier-retry", "transient-retry-unavailable", "unknown-diagnostic-pass", "unknown-diagnostic-exhausted",
  "deterministic-adapter-proof-required",
  "global-continuation-budget-exhausted", "repeated-progress-signature", "continuation-journal-unavailable", "manual-lifecycle-handoff"
] as const);
export type RecoveryReasonCode = typeof RECOVERY_REASON_CODES[number];

const HASH = /^[a-f0-9]{64}$/;
const REF = /^[a-z0-9][a-z0-9:._-]{0,255}$/i;
const FIELDS = new Set(["policyVersion", "taskId", "taskRunId", "taskAttempt", "evidenceDigest", "failureCategory", "currentPhase", "action", "continuation", "nextPhase", "sourceMutationAllowed", "reasonCodes", "counts", "ceilings", "hypothesisRef"]);
const COUNTERS = new Set(["sourceRepairPasses", "transientVerifierRetries", "unknownDiagnosticPasses", "providerRetries"]);
const TERMINAL_OVERRIDES = new Set(["global-continuation-budget-exhausted", "repeated-progress-signature", "continuation-journal-unavailable", "manual-lifecycle-handoff"]);
const ACTIONS_BY_REASON: Record<string, readonly string[]> = {
  "feature-disabled": ["handoff"], "invalid-input": ["blocked"], "terminal-phase": ["blocked"],
  "handoff-already-observed": ["handoff"], "no-failure": ["handoff"], "stale-verifier-evidence": ["retry"],
  "source-repair-eligible": ["repair"], "dependency-mutation-not-authorized": ["ask-operator"], "read-only-task": ["handoff"],
  "repair-ceiling-reached": ["handoff"], "repeated-hypothesis": ["handoff"], "operator-environment-action": ["ask-operator"],
  "provider-transient-retry": ["retry"], "provider-retry-exhausted": ["fresh-session", "handoff"],
  "permission-expansion-forbidden": ["ask-operator"], "protected-path-forbidden": ["handoff"],
  "scope-replan-required": ["ask-operator", "handoff"], "transient-verifier-retry": ["retry"],
  "transient-retry-unavailable": ["handoff"], "unknown-diagnostic-pass": ["retry"], "unknown-diagnostic-exhausted": ["handoff"],
  "deterministic-adapter-proof-required": ["handoff"],
  "global-continuation-budget-exhausted": ["handoff"], "repeated-progress-signature": ["handoff"],
  "continuation-journal-unavailable": ["handoff"], "manual-lifecycle-handoff": ["handoff"]
};
const CATEGORIES_BY_REASON: Record<string, readonly string[]> = {
  "no-failure": ["passed"], "source-repair-eligible": ["compile-typecheck", "test-assertion", "lint-format", "dependency-config"],
  "dependency-mutation-not-authorized": ["dependency-config"], "repair-ceiling-reached": ["compile-typecheck", "test-assertion", "lint-format", "dependency-config"],
  "repeated-hypothesis": ["compile-typecheck", "test-assertion", "lint-format", "dependency-config"],
  "operator-environment-action": ["environment"], "provider-transient-retry": ["provider-network"], "provider-retry-exhausted": ["provider-network"],
  "permission-expansion-forbidden": ["permission-policy"], "protected-path-forbidden": ["scope-protected-path"],
  "scope-replan-required": ["scope-protected-path"], "transient-verifier-retry": ["flaky-infrastructure"],
  "unknown-diagnostic-pass": ["unknown"], "unknown-diagnostic-exhausted": ["unknown"]
};

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function exactFields(value: Record<string, any>, fields: Set<string>): boolean {
  return Object.keys(value).every((field) => fields.has(field)) && [...fields].every((field) => field in value);
}

export function recoveryDecisionValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["recovery decision must be an object"];
  const errors: string[] = [];
  if (!exactFields(value, FIELDS)) errors.push("recovery decision fields are invalid");
  if (value.policyVersion !== RECOVERY_POLICY_VERSION || typeof value.taskId !== "string" || !REF.test(value.taskId)
    || typeof value.taskRunId !== "string" || !REF.test(value.taskRunId) || !Number.isInteger(value.taskAttempt) || value.taskAttempt < 1
    || typeof value.evidenceDigest !== "string" || !HASH.test(value.evidenceDigest) || !FAILURE_CATEGORIES.includes(value.failureCategory)
    || !TRAJECTORY_PHASES.includes(value.currentPhase) || !RECOVERY_ACTIONS.includes(value.action)) errors.push("recovery decision identity is invalid");
  if (!['none', 'same-session', 'fresh-session', 'operator'].includes(String(value.continuation))
    || (value.nextPhase !== null && !TRAJECTORY_PHASES.includes(value.nextPhase)) || typeof value.sourceMutationAllowed !== "boolean") errors.push("recovery continuation is invalid");
  const reasons = Array.isArray(value.reasonCodes) ? value.reasonCodes : [];
  if (reasons.length < 1 || reasons.length > 20 || new Set(reasons).size !== reasons.length
    || reasons.some((reason) => typeof reason !== "string" || !RECOVERY_REASON_CODES.includes(reason as RecoveryReasonCode))) errors.push("recovery reasonCodes are invalid");
  const counts = record(value.counts), ceilings = record(value.ceilings);
  if (!counts || !exactFields(counts, COUNTERS) || [...COUNTERS].some((field) => !Number.isInteger(counts[field]) || counts[field] < 0 || counts[field] > RECOVERY_CEILINGS[field])) errors.push("recovery counts are invalid");
  if (!ceilings || !exactFields(ceilings, COUNTERS) || [...COUNTERS].some((field) => ceilings[field] !== RECOVERY_CEILINGS[field])) errors.push("recovery ceilings are invalid");
  if (value.hypothesisRef !== null && (typeof value.hypothesisRef !== "string" || !REF.test(value.hypothesisRef))) errors.push("recovery hypothesisRef is invalid");
  const continuationCoherent = value.action === "repair" ? value.continuation === "same-session" && value.nextPhase === "repair" && value.sourceMutationAllowed === true
    : value.action === "retry" ? value.continuation === "same-session" && value.nextPhase !== null && value.sourceMutationAllowed === false
      : value.action === "fresh-session" ? value.continuation === "fresh-session" && value.nextPhase === null && value.sourceMutationAllowed === false
        : value.action === "ask-operator" ? value.continuation === "operator" && value.nextPhase === null && value.sourceMutationAllowed === false
          : value.continuation === "none" && value.nextPhase === null && value.sourceMutationAllowed === false;
  if (!continuationCoherent) errors.push("recovery action and continuation conflict");
  const terminalOverride = reasons.some((reason) => TERMINAL_OVERRIDES.has(reason));
  if (reasons.some((reason) => !ACTIONS_BY_REASON[reason]?.includes(value.action) && !(terminalOverride && value.action === "handoff"))) errors.push("recovery reason and action conflict");
  if (reasons.some((reason) => CATEGORIES_BY_REASON[reason] && !CATEGORIES_BY_REASON[reason].includes(value.failureCategory))) errors.push("recovery reason and category conflict");
  if ((reasons.includes("terminal-phase") && value.currentPhase !== "terminal") || (reasons.includes("handoff-already-observed") && value.currentPhase !== "handoff")) errors.push("recovery reason and phase conflict");
  if ((reasons.includes("repair-ceiling-reached") && counts?.sourceRepairPasses !== RECOVERY_CEILINGS.sourceRepairPasses)
    || (reasons.includes("unknown-diagnostic-exhausted") && counts?.unknownDiagnosticPasses !== RECOVERY_CEILINGS.unknownDiagnosticPasses)) errors.push("recovery reason and counts conflict");
  return errors;
}

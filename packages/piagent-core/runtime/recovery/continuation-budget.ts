import crypto from "node:crypto";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { appendTaskJournalEventAtMost, readTaskJournal } from "../../extensions/task-journal.js";
import { isCurrentWorkingTreeDigest } from "../../extensions/working-tree-digest.js";
import { taskAuthorityDecision } from "../policy/task-authority-runtime.ts";
import type { RecoveryDecision } from "./recovery-policy.ts";
import type { RecoveryReasonCode } from "./recovery-policy.ts";

export const CONTINUATION_POLICY_VERSION = "global-continuation-v1" as const;
export const CONTINUATION_EVENT_TYPE = "continuation-consumed" as const;
export const CONTINUATION_CLASSES = Object.freeze([
  "semantic-review", "source-repair", "verifier-retry", "infrastructure-retry", "model-retry", "diagnostic-retry", "policy-blocked"
] as const);
export type ContinuationClass = typeof CONTINUATION_CLASSES[number];
export type ContinuationRequest = {
  capabilityId: "CAP-12" | "CAP-13";
  classification: Exclude<ContinuationClass, "policy-blocked">;
  action: "review" | "repair" | "retry";
  currentWorkingTreeDigest: string;
  missing?: string[];
  missingVerifyCommands?: string[];
  evidenceDigest?: string | null;
  reasonCodes?: string[];
  recordedAt?: string;
};
export type ContinuationReservation = {
  allowed: boolean;
  reason: "reserved" | "authority-denied" | "invalid-progress-evidence" | "journal-unavailable" | "repeated-progress-signature" | "global-budget-exhausted";
  classification: ContinuationRequest["classification"];
  progressSignature: string;
  consumed: number;
  maximum: number;
};

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;
const DOMAIN = "piagent-global-continuation-progress-v1\n";

function boundedStrings(values: unknown, maximum = 50): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.replace(/\s+/g, " ").trim().slice(0, 1000)))]
    .sort()
    .slice(0, maximum);
}

function normalizedEvidenceDigest(value: string | null | undefined): string | null {
  const candidate = String(value ?? "").toLowerCase();
  if (!SHA256.test(candidate)) return null;
  return candidate.startsWith("sha256:") ? candidate : `sha256:${candidate}`;
}

export function continuationClassForRecovery(decision: RecoveryDecision): ContinuationClass {
  if (["permission-policy", "scope-protected-path", "environment"].includes(decision.failureCategory)
    || decision.reasonCodes.some((code) => ["permission-expansion-forbidden", "scope-replan-required", "operator-environment-action", "dependency-mutation-not-authorized"].includes(code))) return "policy-blocked";
  if (decision.action === "repair") return "source-repair";
  if (decision.failureCategory === "provider-network") return "model-retry";
  if (decision.failureCategory === "flaky-infrastructure") return "infrastructure-retry";
  if (decision.failureCategory === "unknown") return "diagnostic-retry";
  return "verifier-retry";
}

export function continuationDenialReasonCode(reason: ContinuationReservation["reason"]): RecoveryReasonCode {
  if (reason === "repeated-progress-signature") return "repeated-progress-signature";
  if (reason === "global-budget-exhausted") return "global-continuation-budget-exhausted";
  return "continuation-journal-unavailable";
}

export function reserveSemanticReviewContinuation(
  cwd: string,
  task: TaskContract,
  input: { currentWorkingTreeDigest: string; expectedPaths: string[]; reasonCodes: string[] }
): ContinuationReservation {
  return reserveTaskContinuation(cwd, task, {
    capabilityId: "CAP-13", classification: "semantic-review", action: "review",
    currentWorkingTreeDigest: input.currentWorkingTreeDigest,
    missing: input.expectedPaths.map((reviewPath) => `semantic-review:${reviewPath}`), reasonCodes: input.reasonCodes
  });
}

export function planRecoveryContinuation(
  cwd: string,
  task: TaskContract,
  decision: RecoveryDecision,
  input: { lifecycleMode: string; currentWorkingTreeDigest: string; missing: string[]; missingVerifyCommands: string[] }
): { recovery: RecoveryDecision; classification: ContinuationClass; reservation?: ContinuationReservation } {
  const classification = continuationClassForRecovery(decision);
  const continues = decision.continuation === "same-session" && ["repair", "retry"].includes(decision.action);
  if (!continues) return { recovery: decision, classification };
  if (input.lifecycleMode === "manual") return {
    classification,
    recovery: { ...decision, action: "handoff", continuation: "none", nextPhase: null, sourceMutationAllowed: false, reasonCodes: [...decision.reasonCodes, "manual-lifecycle-handoff"] }
  };
  const reservation = classification === "policy-blocked" ? undefined : reserveTaskContinuation(cwd, task, {
    capabilityId: "CAP-12", classification, action: decision.action as "repair" | "retry",
    currentWorkingTreeDigest: input.currentWorkingTreeDigest, missing: input.missing,
    missingVerifyCommands: input.missingVerifyCommands, evidenceDigest: decision.evidenceDigest, reasonCodes: decision.reasonCodes
  });
  if (reservation?.allowed) return { recovery: decision, classification, reservation };
  const reason = continuationDenialReasonCode(reservation?.reason ?? "journal-unavailable");
  return {
    classification, reservation,
    recovery: { ...decision, action: "handoff", continuation: "none", nextPhase: null, sourceMutationAllowed: false, reasonCodes: [...decision.reasonCodes, reason] }
  };
}

export function continuationProgressSignature(task: TaskContract, request: ContinuationRequest): string {
  const payload = {
    taskId: task.taskId,
    taskRunId: task.taskRunId,
    authoritySnapshotDigest: task.authoritySnapshot?.snapshotDigest ?? null,
    capabilityId: request.capabilityId,
    classification: request.classification,
    action: request.action,
    currentWorkingTreeDigest: request.currentWorkingTreeDigest,
    evidenceDigest: normalizedEvidenceDigest(request.evidenceDigest),
    missing: boundedStrings(request.missing),
    missingVerifyCommands: boundedStrings(request.missingVerifyCommands),
    reasonCodes: boundedStrings(request.reasonCodes, 20)
  };
  return `sha256:${crypto.createHash("sha256").update(DOMAIN).update(JSON.stringify(payload)).digest("hex")}`;
}

function validContinuationEvent(task: TaskContract, event: any): boolean {
  const data = event?.data;
  return event?.eventType === CONTINUATION_EVENT_TYPE
    && event.taskId === task.taskId
    && event.taskRunId === task.taskRunId
    && data?.policyVersion === CONTINUATION_POLICY_VERSION
    && ["CAP-12", "CAP-13"].includes(data.capabilityId)
    && CONTINUATION_CLASSES.includes(data.classification)
    && data.classification !== "policy-blocked"
    && ["review", "repair", "retry"].includes(data.action)
    && /^sha256:[a-f0-9]{64}$/.test(data.progressSignature)
    && isCurrentWorkingTreeDigest(data.workingTreeDigest)
    && data.authoritySnapshotDigest === task.authoritySnapshot?.snapshotDigest
    && (data.evidenceDigest === null || /^sha256:[a-f0-9]{64}$/.test(data.evidenceDigest));
}

export function inspectTaskContinuationBudget(cwd: string, task: TaskContract): {
  enforcementSafe: boolean; consumed: number; maximum: number; signatures: string[]; reason: string;
} {
  const maximum = task.authoritySnapshot?.globalBudgets.maxSystemContinuationsPerTask ?? 0;
  const journal = readTaskJournal(cwd, { taskRunId: task.taskRunId });
  const events = journal.events.filter((event: any) => event.eventType === CONTINUATION_EVENT_TYPE);
  const valid = events.every((event: any) => validContinuationEvent(task, event));
  const enforcementSafe = journal.corruptions.length === 0 && valid && Number.isInteger(maximum) && maximum >= 0 && maximum <= 1 && events.length <= maximum;
  return {
    enforcementSafe,
    consumed: events.length,
    maximum: Number.isInteger(maximum) ? maximum : 0,
    signatures: valid ? events.map((event: any) => event.data.progressSignature) : [],
    reason: journal.corruptions[0] ?? (!valid ? "invalid-continuation-event" : events.length > maximum ? "continuation-budget-exceeded" : enforcementSafe ? "ok" : "invalid-continuation-budget")
  };
}

export function reserveTaskContinuation(cwd: string, task: TaskContract, request: ContinuationRequest): ContinuationReservation {
  const progressSignature = continuationProgressSignature(task, request);
  const authority = taskAuthorityDecision(task, request.capabilityId, "model-turn");
  const before = inspectTaskContinuationBudget(cwd, task);
  const base = { classification: request.classification, progressSignature, consumed: before.consumed, maximum: before.maximum };
  if (!authority.allowed) return { ...base, allowed: false, reason: "authority-denied" };
  if (!isCurrentWorkingTreeDigest(request.currentWorkingTreeDigest) || !before.enforcementSafe) {
    return { ...base, allowed: false, reason: before.reason === "ok" ? "invalid-progress-evidence" : "journal-unavailable" };
  }
  const evidenceDigest = normalizedEvidenceDigest(request.evidenceDigest);
  try {
    const result = appendTaskJournalEventAtMost(cwd, {
      eventType: CONTINUATION_EVENT_TYPE,
      taskId: task.taskId,
      taskRunId: task.taskRunId,
      sessionId: task.sessionId,
      sessionName: task.sessionName,
      idempotencyKey: progressSignature,
      data: {
        policyVersion: CONTINUATION_POLICY_VERSION,
        capabilityId: request.capabilityId,
        classification: request.classification,
        action: request.action,
        progressSignature,
        workingTreeDigest: request.currentWorkingTreeDigest,
        evidenceDigest,
        authoritySnapshotDigest: task.authoritySnapshot?.snapshotDigest ?? null
      }
    }, { maximum: before.maximum, recordedAt: request.recordedAt });
    if (result.appended) return { ...base, allowed: true, reason: "reserved", consumed: result.count };
    return { ...base, allowed: false, reason: result.reason === "duplicate" ? "repeated-progress-signature" : "global-budget-exhausted", consumed: result.count };
  } catch {
    return { ...base, allowed: false, reason: "journal-unavailable" };
  }
}

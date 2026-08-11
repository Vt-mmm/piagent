import crypto from "node:crypto";

import {
  AUTHORITY_PROFILE_IDS,
  inspectAuthoritySnapshotCompatibility,
  type AuthorityProfileId
} from "../../capabilities/authority-manifest.ts";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { appendTaskJournalEventAtMost, readTaskJournal } from "../../extensions/task-journal.js";

export const AUTHORITY_RESUME_POLICY_VERSION = "authority-resume-v1" as const;
export const AUTHORITY_RESUME_EVENT_TYPE = "authority-new-attempt-required" as const;

export type AuthorityResumeReason =
  | "compatible"
  | "missing-task-snapshot"
  | "task-identity-mismatch"
  | "unknown-snapshot-version"
  | "unknown-manifest-version"
  | "manifest-digest-mismatch"
  | "invalid-snapshot"
  | "mechanical-rollback-requested"
  | "capability-kill-switch-requested"
  | "authority-journal-corrupt"
  | "authority-resume-state-invalid";

export type AuthorityResumeDecision = {
  policyVersion: typeof AUTHORITY_RESUME_POLICY_VERSION;
  disposition: "resume-pinned" | "new-attempt-required" | "blocked";
  enforcementSafe: boolean;
  reason: AuthorityResumeReason;
  pinnedProfile: AuthorityProfileId | null;
  requestedProfile: AuthorityProfileId | null;
  killedCapabilities: string[];
  persisted: boolean;
  recordedAt: string | null;
};

type ResumeInput = {
  authorityProfile?: AuthorityProfileId;
  environment?: NodeJS.ProcessEnv;
  recordedAt?: string;
};

const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const FEATURE_KILL_SWITCHES = Object.freeze([
  ["PIAGENT_AUTO_CONTEXT", "CAP-05"],
  ["PIAGENT_DYNAMIC_TOOLS", "CAP-06"],
  ["PIAGENT_SOLVER_MODE", "CAP-08"],
  ["PIAGENT_PHASE_TOOLS", "CAP-09"],
  ["PIAGENT_ACCEPTANCE_ASSURANCE", "CAP-11"],
  ["PIAGENT_AUTO_RECOVERY", "CAP-12"],
  ["PIAGENT_SEMANTIC_REPAIR", "CAP-13"],
  ["PIAGENT_HELPERS_MODE", "CAP-14"],
  ["PIAGENT_PARENT_ROUTING", "CAP-15"],
  ["PIAGENT_CONTEXT_TELEMETRY", "CAP-17"]
] as const);
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function requestedProfile(input: ResumeInput): AuthorityProfileId | null {
  if (input.authorityProfile) return input.authorityProfile;
  const value = String(input.environment?.PIAGENT_AUTHORITY_PROFILE ?? "").trim().toLowerCase();
  return (AUTHORITY_PROFILE_IDS as readonly string[]).includes(value) ? value as AuthorityProfileId : null;
}

function explicitKilledCapabilities(task: TaskContract, environment: NodeJS.ProcessEnv | undefined): string[] {
  if (!environment || !task.authoritySnapshot) return [];
  return FEATURE_KILL_SWITCHES
    .filter(([name, capabilityId]) => {
      const value = environment[name];
      const pinned = task.authoritySnapshot?.capabilities.find((entry) => entry.id === capabilityId);
      return value !== undefined && OFF_VALUES.has(String(value).trim().toLowerCase()) && pinned?.authority !== "off";
    })
    .map(([, capabilityId]) => capabilityId)
    .sort();
}

function snapshotDigest(task: TaskContract): string | null {
  const value = task.authoritySnapshot?.snapshotDigest;
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function eventKey(task: TaskContract, reason: AuthorityResumeReason, profile: AuthorityProfileId | null, killed: string[]): string {
  const payload = JSON.stringify({
    taskId: task.taskId,
    taskRunId: task.taskRunId,
    createdAt: task.createdAt,
    authoritySnapshotDigest: snapshotDigest(task),
    reason,
    requestedProfile: profile,
    killedCapabilities: killed
  });
  return `sha256:${crypto.createHash("sha256").update("piagent-authority-resume-v1\n").update(payload).digest("hex")}`;
}

function baseDecision(task: TaskContract, input: ResumeInput): AuthorityResumeDecision {
  const pinnedProfile = task.authoritySnapshot?.profile ?? null;
  const profile = requestedProfile(input);
  const killed = explicitKilledCapabilities(task, input.environment);
  if (!task.authoritySnapshot) return decision("new-attempt-required", "missing-task-snapshot", pinnedProfile, profile, killed);
  if (task.authoritySnapshot.taskId !== task.taskId
    || task.authoritySnapshot.taskRunId !== task.taskRunId
    || task.authoritySnapshot.capturedAt !== task.createdAt) {
    return decision("new-attempt-required", "task-identity-mismatch", pinnedProfile, profile, killed);
  }
  const compatibility = inspectAuthoritySnapshotCompatibility(task.authoritySnapshot);
  if (compatibility.disposition !== "resume-pinned") {
    return decision("new-attempt-required", compatibility.reason, pinnedProfile, profile, killed);
  }
  if (profile === "mechanical-only" && pinnedProfile !== "mechanical-only") {
    return decision("new-attempt-required", "mechanical-rollback-requested", pinnedProfile, profile, killed);
  }
  if (killed.length > 0) {
    return decision("new-attempt-required", "capability-kill-switch-requested", pinnedProfile, profile, killed);
  }
  return decision("resume-pinned", "compatible", pinnedProfile, profile, []);
}

function decision(
  disposition: AuthorityResumeDecision["disposition"],
  reason: AuthorityResumeReason,
  pinnedProfile: AuthorityProfileId | null,
  profile: AuthorityProfileId | null,
  killedCapabilities: string[],
  persisted = false,
  recordedAt: string | null = null
): AuthorityResumeDecision {
  return {
    policyVersion: AUTHORITY_RESUME_POLICY_VERSION,
    disposition,
    enforcementSafe: disposition !== "blocked",
    reason,
    pinnedProfile,
    requestedProfile: profile,
    killedCapabilities,
    persisted,
    recordedAt
  };
}

function persistedDecision(cwd: string, task: TaskContract): AuthorityResumeDecision | undefined {
  const journal = readTaskJournal(cwd, { taskRunId: task.taskRunId });
  if (journal.corruptions.length > 0) {
    return decision("blocked", "authority-journal-corrupt", task.authoritySnapshot?.profile ?? null, null, []);
  }
  const events = journal.events.filter((event: any) => event.eventType === AUTHORITY_RESUME_EVENT_TYPE);
  if (events.length === 0) return undefined;
  if (events.length !== 1) return decision("blocked", "authority-resume-state-invalid", task.authoritySnapshot?.profile ?? null, null, []);
  const event = events[0] as any, data = event.data;
  const profile = data?.requestedProfile === null || AUTHORITY_PROFILE_IDS.includes(data?.requestedProfile) ? data?.requestedProfile ?? null : undefined;
  const killed = Array.isArray(data?.killedCapabilities)
    ? data.killedCapabilities.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const valid = event.taskId === task.taskId
    && event.taskRunId === task.taskRunId
    && data?.policyVersion === AUTHORITY_RESUME_POLICY_VERSION
    && data?.taskCreatedAt === task.createdAt
    && data?.authoritySnapshotDigest === snapshotDigest(task)
    && ["missing-task-snapshot", "task-identity-mismatch", "unknown-snapshot-version", "unknown-manifest-version", "manifest-digest-mismatch", "invalid-snapshot", "mechanical-rollback-requested", "capability-kill-switch-requested"].includes(data?.reason)
    && profile !== undefined
    && killed.length === (data?.killedCapabilities?.length ?? -1)
    && JSON.stringify(killed) === JSON.stringify([...new Set(killed)].sort())
    && event.idempotencyKey === eventKey(task, data.reason, profile, killed);
  if (!valid) return decision("blocked", "authority-resume-state-invalid", task.authoritySnapshot?.profile ?? null, null, []);
  return decision("new-attempt-required", data.reason, task.authoritySnapshot?.profile ?? null, profile, killed, true, event.recordedAt);
}

export function inspectTaskAuthorityResumePolicy(cwd: string, task: TaskContract, input: ResumeInput = {}): AuthorityResumeDecision {
  return persistedDecision(cwd, task) ?? baseDecision(task, input);
}

export function ensureTaskAuthorityResumePolicy(cwd: string, task: TaskContract, input: ResumeInput = {}): AuthorityResumeDecision {
  const current = inspectTaskAuthorityResumePolicy(cwd, task, input);
  if (current.disposition !== "new-attempt-required" || current.persisted) return current;
  const key = eventKey(task, current.reason, current.requestedProfile, current.killedCapabilities);
  try {
    appendTaskJournalEventAtMost(cwd, {
      eventType: AUTHORITY_RESUME_EVENT_TYPE,
      taskId: task.taskId,
      taskRunId: task.taskRunId,
      sessionId: task.sessionId,
      sessionName: task.sessionName,
      idempotencyKey: key,
      data: {
        policyVersion: AUTHORITY_RESUME_POLICY_VERSION,
        taskCreatedAt: task.createdAt,
        authoritySnapshotDigest: snapshotDigest(task),
        reason: current.reason,
        requestedProfile: current.requestedProfile,
        killedCapabilities: current.killedCapabilities
      }
    }, { maximum: 1, recordedAt: input.recordedAt });
  } catch {
    return decision("blocked", "authority-journal-corrupt", current.pinnedProfile, current.requestedProfile, current.killedCapabilities);
  }
  return persistedDecision(cwd, task)
    ?? decision("blocked", "authority-resume-state-invalid", current.pinnedProfile, current.requestedProfile, current.killedCapabilities);
}

export function authorityReplacementState(cwd: string, task: TaskContract): {
  required: boolean;
  enforcementSafe: boolean;
  reason: AuthorityResumeReason | null;
  recordedAt: string | null;
  requestedProfile: AuthorityProfileId | null;
  killedCapabilities: string[];
} {
  const persisted = persistedDecision(cwd, task);
  if (!persisted) {
    return {
      required: false,
      enforcementSafe: true,
      reason: null,
      recordedAt: null,
      requestedProfile: null,
      killedCapabilities: []
    };
  }
  return {
    required: persisted.disposition === "new-attempt-required" && persisted.persisted,
    enforcementSafe: persisted.enforcementSafe,
    reason: persisted.reason,
    recordedAt: persisted.recordedAt,
    requestedProfile: persisted.requestedProfile,
    killedCapabilities: persisted.killedCapabilities
  };
}

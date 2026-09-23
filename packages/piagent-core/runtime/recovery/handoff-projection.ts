import { buildDiagnosticDelivery, diagnosticCompletionMissing, diagnosticDeliveryStateErrors, validDiagnosticDelivery, type DiagnosticDelivery } from "./diagnostic-delivery.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { currentWorkspaceRevisionDigest } from "../../extensions/workspace-revision.js";
import { handoffVerifierBindingErrors, type HandoffVerifierBinding } from "./handoff-verifier-binding.ts";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { failureClassificationValidationErrors, type FailureClassification } from "../../extensions/failure-types.ts";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { changedSnapshotFiles } from "../../extensions/task-contract-view.js";
import { replayTaskCheckpoints, taskJournalPaths } from "../../extensions/task-journal.js";
import { safeTaskId, taskContractValidationErrors, taskDigestMigrationArchiveStatus, workingTreeSnapshot } from "../../extensions/task-state.js";
import { latestObservedVerification, verificationEvidenceProvesCurrentWorkspace } from "../../extensions/verification-intelligence.js";
import {
  isCurrentWorkingTreeDigest,
  WORKING_TREE_DIGEST_ALGORITHM,
  workingTreeEvidenceDigest
} from "../../extensions/working-tree-digest.js";
import { recoveryDecisionValidationErrors, type RecoveryDecision } from "./recovery-policy.ts";
import { readTrajectoryStore, trajectoryStatePath } from "../trajectory/trajectory-store.ts";

export const HANDOFF_SCHEMA_VERSION = 1 as const;
export const HANDOFF_PROJECTION_VERSION = "handoff-v2" as const;

type CompletionGate = { decision: "pass" | "fail"; missing: string[]; missingVerifyCommands: string[]; currentWorkingTreeDigest?: string; acceptanceProof?: { mode: "enforce" | "diagnostic"; pendingCriterionIds: string[]; missing: string[] } };
type DigestRef = { sha256: string; chars: number };
type LatestVerifier = HandoffVerifierBinding & {
  command: string;
  exitCode: number;
  observedAt: string | null;
  matchedProfileCommand: boolean;
  isError: boolean;
  summaryRef: DigestRef;
};

export type HandoffProjection = {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  projectionVersion: typeof HANDOFF_PROJECTION_VERSION;
  generatedAt: string;
  identity: { taskId: string; taskRunId: string; sessionHash: string; sessionName: string | null; attempt: number; maxAttempts: number };
  goal: { summary: string; expectedOutput: string; acceptanceCriteria: string[]; scope: string[]; outOfScope: string[] };
  state: { phase: string | null; taskOutcome: TaskContract["trace"]["outcome"]; gateDecision: "pass" | "fail"; completionApproved: boolean; missing: string[]; diagnosticDelivery?: DiagnosticDelivery };
  acceptance: { required: boolean; satisfied: boolean; criteriaCount: number; dispositionDigest: string };
  decisionsAndInvariants: string[];
  contextReferences: { required: string[]; observed: Array<{ path: string; reason: string }>; memory: Array<{ path: string; reason: string }> };
  tree: {
    algorithm: TaskContract["workingTreeDigestAlgorithm"];
    migration: Pick<NonNullable<TaskContract["workingTreeDigestMigration"]>, "status" | "reasonCode" | "requiredAction"> | null;
    baselineDigest: string | null;
    currentDigest: string | null;
    workspaceRevisionDigest: string | null;
    evidenceCurrent: boolean;
    latestVerifierMatchesCurrentTree: boolean;
  };
  changedFiles: { baseline: string[]; observed: string[]; current: string[]; claimed: string[] };
  verification: { exactCommands: string[]; missingCommands: string[]; latestObserved: LatestVerifier | null };
  failure: { classification: FailureClassification | null; recovery: RecoveryDecision | null; journalIntegrity: "ok" | "corrupt"; warnings: string[] };
  ruledOutHypotheses: Array<{ ref: string; summary: string }>;
  requiredAuthority: { required: boolean; kind: "none" | "operator" | "permission" | "scope" | "fresh-session"; reasonCodes: string[] };
  nextSafeAction: { action: string; continuation: string; sourceMutationAllowed: boolean; exactCommands: string[] };
  references: {
    taskContract: string;
    journal: string;
    trajectory: string;
    failureCapture: string | null;
    solverDecision: unknown | null;
    helper: { mode: string | null; subagents: string | null; fieldGuidePath: string | null };
  };
};

const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "projectionVersion", "generatedAt", "identity", "goal", "state", "acceptance", "decisionsAndInvariants", "contextReferences", "tree", "changedFiles", "verification", "failure", "ruledOutHypotheses", "requiredAuthority", "nextSafeAction", "references"]);
const IDENTITY_FIELDS = new Set(["taskId", "taskRunId", "sessionHash", "sessionName", "attempt", "maxAttempts"]);
const ACCEPTANCE_FIELDS = new Set(["required", "satisfied", "criteriaCount", "dispositionDigest"]);
const TREE_FIELDS = new Set(["algorithm", "migration", "baselineDigest", "currentDigest", "evidenceCurrent", "latestVerifierMatchesCurrentTree", "workspaceRevisionDigest"]);
const TREE_MIGRATION_FIELDS = new Set(["status", "reasonCode", "requiredAction"]);
const VERIFICATION_FIELDS = new Set(["exactCommands", "missingCommands", "latestObserved"]);
const LATEST_VERIFIER_FIELDS = new Set(["command", "exitCode", "observedAt", "matchedProfileCommand", "isError", "preWorkingTreeDigest", "workingTreeDigest", "summaryRef", "preWorkspaceRevisionDigest", "workspaceRevisionDigest"]);
const SUMMARY_REF_FIELDS = new Set(["sha256", "chars"]);
const AUTHORITY_FIELDS = new Set(["required", "kind", "reasonCodes"]);
const HASH = /^[a-f0-9]{64}$/;
const MIGRATION_STATUSES = new Set(["verification-refresh-required", "refreshed", "new-attempt-required", "historical-unverifiable"]);
const MIGRATION_ACTIONS: Record<string, string> = {
  "verification-refresh-required": "rerun-exact-verifier", refreshed: "none",
  "new-attempt-required": "start-new-attempt", "historical-unverifiable": "historical-only"
};

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function projectedMigration(task: TaskContract): HandoffProjection["tree"]["migration"] {
  const migration = task.workingTreeDigestMigration;
  if (!migration || MIGRATION_ACTIONS[migration.status] !== migration.requiredAction || !/^[a-z0-9-]+$/.test(String(migration.reasonCode ?? ""))) return null;
  return { status: migration.status, reasonCode: migration.reasonCode, requiredAction: migration.requiredAction };
}

export function handoffProjectionValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["handoff projection must be an object"];
  const errors = [
    ...Object.keys(value).filter((field) => !TOP_LEVEL_FIELDS.has(field)).map((field) => `handoff projection has unknown field: ${field}`),
    ...[...TOP_LEVEL_FIELDS].filter((field) => !(field in value)).map((field) => `handoff projection missing field: ${field}`)
  ];
  if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION || value.projectionVersion !== HANDOFF_PROJECTION_VERSION) errors.push("handoff projection version is invalid");
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) errors.push("generatedAt is invalid");
  const identity = record(value.identity), state = record(value.state), acceptance = record(value.acceptance), tree = record(value.tree);
  const diagnostic = state?.diagnosticDelivery;
  const diagnosticValid = validDiagnosticDelivery(diagnostic, acceptance?.dispositionDigest);
  errors.push(...diagnosticDeliveryStateErrors(state, acceptance));
  const deliveryApproved = state?.completionApproved === true || diagnosticValid;
  if (!identity
    || Object.keys(identity).some((field) => !IDENTITY_FIELDS.has(field))
    || [...IDENTITY_FIELDS].some((field) => !(field in identity))
    || typeof identity.taskId !== "string"
    || typeof identity.taskRunId !== "string"
    || !HASH.test(String(identity.sessionHash))
    || (identity.sessionName !== null && typeof identity.sessionName !== "string")
    || !Number.isInteger(identity.attempt)
    || !Number.isInteger(identity.maxAttempts)
    || identity.attempt < 1
    || identity.maxAttempts < 1
    || identity.attempt > identity.maxAttempts) errors.push("identity is invalid");
  if (!state || !["pending", "completed", "blocked", "partial", "failed"].includes(String(state.taskOutcome)) || !["pass", "fail"].includes(String(state.gateDecision)) || typeof state.completionApproved !== "boolean" || !Array.isArray(state.missing)) errors.push("state is invalid");
  if (deliveryApproved && (state.gateDecision !== "pass" || state.taskOutcome !== "completed")) errors.push("completionApproved conflicts with operational truth");
  if (!acceptance
    || Object.keys(acceptance).some((field) => !ACCEPTANCE_FIELDS.has(field))
    || [...ACCEPTANCE_FIELDS].some((field) => !(field in acceptance))
    || typeof acceptance.required !== "boolean"
    || typeof acceptance.satisfied !== "boolean"
    || !Number.isInteger(acceptance.criteriaCount)
    || acceptance.criteriaCount < 0
    || acceptance.criteriaCount > 12
    || !HASH.test(String(acceptance.dispositionDigest))) errors.push("acceptance disposition is invalid");
  if (state?.completionApproved === true && acceptance?.satisfied !== true) errors.push("completionApproved requires satisfied acceptance");
  if (deliveryApproved && Array.isArray(state.missing) && state.missing.some((item: unknown) => !(diagnosticValid && item === "acceptance-criteria-pending"))) errors.push("completionApproved cannot retain missing completion evidence");
  const migration = record(tree?.migration);
  const migrationValid = tree?.migration === null || Boolean(
    migration
    && Object.keys(migration).every((field) => TREE_MIGRATION_FIELDS.has(field))
    && [...TREE_MIGRATION_FIELDS].every((field) => field in migration)
    && MIGRATION_STATUSES.has(String(migration.status))
    && typeof migration.reasonCode === "string"
    && ["rerun-exact-verifier", "none", "start-new-attempt", "historical-only"].includes(String(migration.requiredAction))
  );
  if (
    !tree
    || Object.keys(tree).some((field) => !TREE_FIELDS.has(field))
    || [...TREE_FIELDS].some((field) => field !== "workspaceRevisionDigest" && !(field in tree))
    || ![WORKING_TREE_DIGEST_ALGORITHM, "legacy-untrusted"].includes(String(tree.algorithm))
    || !migrationValid
    || (tree.baselineDigest !== null && !isCurrentWorkingTreeDigest(tree.baselineDigest))
    || (tree.currentDigest !== null && !isCurrentWorkingTreeDigest(tree.currentDigest))
    || typeof tree.evidenceCurrent !== "boolean"
    || typeof tree.latestVerifierMatchesCurrentTree !== "boolean"
  ) errors.push("tree is invalid");
  const expectedMigrationActions: Record<string, string> = {
    "verification-refresh-required": "rerun-exact-verifier",
    refreshed: "none",
    "new-attempt-required": "start-new-attempt",
    "historical-unverifiable": "historical-only"
  };
  if (migration && expectedMigrationActions[String(migration.status)] !== migration.requiredAction) errors.push("tree migration status/action is invalid");
  if (tree?.algorithm === "legacy-untrusted" && (!migration || !["new-attempt-required", "historical-unverifiable"].includes(String(migration.status)) || tree.baselineDigest !== null || tree.currentDigest !== null || tree.evidenceCurrent !== false)) errors.push("legacy tree evidence must remain historical");
  if (tree?.algorithm === WORKING_TREE_DIGEST_ALGORITHM && ["new-attempt-required", "historical-unverifiable"].includes(String(migration?.status))) errors.push("current tree algorithm conflicts with terminal legacy migration");
  if (tree?.evidenceCurrent === true && (tree.algorithm !== WORKING_TREE_DIGEST_ALGORITHM || !isCurrentWorkingTreeDigest(tree.baselineDigest) || !isCurrentWorkingTreeDigest(tree.currentDigest) || migration?.status === "verification-refresh-required")) errors.push("tree current-evidence claim is invalid");
  const verification = record(value.verification);
  if (!verification
    || Object.keys(verification).some((field) => !VERIFICATION_FIELDS.has(field))
    || [...VERIFICATION_FIELDS].some((field) => !(field in verification))
    || !Array.isArray(verification.exactCommands)
    || verification.exactCommands.length > 50
    || verification.exactCommands.some((command: unknown) => typeof command !== "string" || command.length > 1000)
    || !Array.isArray(verification.missingCommands)
    || verification.missingCommands.length > 50
    || verification.missingCommands.some((command: unknown) => typeof command !== "string" || command.length > 1000)
    || (Array.isArray(verification.exactCommands) && Array.isArray(verification.missingCommands)
      && verification.missingCommands.some((command: string) => !verification.exactCommands.includes(command)))) errors.push("verification is invalid");
  const latestVerifier = record(verification?.latestObserved);
  const summary = record(latestVerifier?.summaryRef);
  if (verification?.latestObserved !== null && (!latestVerifier
    || Object.keys(latestVerifier).some((field) => !LATEST_VERIFIER_FIELDS.has(field))
    || [...LATEST_VERIFIER_FIELDS].some((field) => !["preWorkspaceRevisionDigest", "workspaceRevisionDigest"].includes(field) && !(field in latestVerifier))
    || typeof latestVerifier.command !== "string" || latestVerifier.command.length > 1000
    || !Number.isInteger(latestVerifier.exitCode)
    || (latestVerifier.observedAt !== null && (typeof latestVerifier.observedAt !== "string" || !Number.isFinite(Date.parse(latestVerifier.observedAt))))
    || typeof latestVerifier.matchedProfileCommand !== "boolean"
    || typeof latestVerifier.isError !== "boolean"
    || !summary
    || Object.keys(summary).some((field) => !SUMMARY_REF_FIELDS.has(field))
    || [...SUMMARY_REF_FIELDS].some((field) => !(field in summary))
    || !HASH.test(String(summary.sha256))
    || !Number.isInteger(summary.chars)
    || summary.chars < 0
    || summary.chars > 20_000)) errors.push("latest verifier is invalid");
  errors.push(...handoffVerifierBindingErrors(tree, latestVerifier));
  if (deliveryApproved && tree?.evidenceCurrent !== true) errors.push("completionApproved requires current tree evidence");
  const requiredArrays = [value.decisionsAndInvariants, value.goal?.acceptanceCriteria, value.goal?.scope, value.contextReferences?.observed, value.changedFiles?.current, value.verification?.exactCommands, value.failure?.warnings, value.ruledOutHypotheses];
  if (requiredArrays.some((entry) => !Array.isArray(entry))) errors.push("projection collections are invalid");
  const classification = value.failure?.classification;
  if (classification !== null && failureClassificationValidationErrors(classification).length > 0) errors.push("failure classification is invalid");
  const recovery = value.failure?.recovery;
  const recoveryErrors = recovery === null ? [] : recoveryDecisionValidationErrors(recovery);
  if (recoveryErrors.length > 0) errors.push(`recovery decision is invalid: ${recoveryErrors.join(", ")}`);
  if (recovery !== null && (recovery.taskId !== identity?.taskId || recovery.taskRunId !== identity?.taskRunId || recovery.taskAttempt !== identity?.attempt)) errors.push("recovery decision is invalid: identity conflict");
  const requiredAuthority = record(value.requiredAuthority);
  if (!requiredAuthority
    || !Object.keys(requiredAuthority).every((field) => AUTHORITY_FIELDS.has(field))
    || ![...AUTHORITY_FIELDS].every((field) => field in requiredAuthority)
    || typeof requiredAuthority.required !== "boolean"
    || !["none", "operator", "permission", "scope", "fresh-session"].includes(String(requiredAuthority.kind))
    || !Array.isArray(requiredAuthority.reasonCodes)
    || requiredAuthority.reasonCodes.some((reason: unknown) => typeof reason !== "string")) errors.push("required authority is invalid");
  const nextSafeAction = record(value.nextSafeAction);
  if (!nextSafeAction
    || typeof nextSafeAction.action !== "string"
    || typeof nextSafeAction.continuation !== "string"
    || typeof nextSafeAction.sourceMutationAllowed !== "boolean"
    || !Array.isArray(nextSafeAction.exactCommands)
    || nextSafeAction.exactCommands.some((command: unknown) => typeof command !== "string")) errors.push("next safe action is invalid");
  if (nextSafeAction?.sourceMutationAllowed === true && nextSafeAction.action !== "repair") errors.push("only repair may project source mutation");
  if (deliveryApproved && (nextSafeAction?.action !== "completed"
    || nextSafeAction.continuation !== "none"
    || nextSafeAction.sourceMutationAllowed !== false
    || !Array.isArray(nextSafeAction.exactCommands)
    || nextSafeAction.exactCommands.length !== 0)) errors.push("completionApproved requires a completed next safe action");
  if (deliveryApproved && (!Array.isArray(verification?.missingCommands) || verification.missingCommands.length > 0)) errors.push("completionApproved cannot retain missing verifier commands");
  if (deliveryApproved && Array.isArray(verification?.exactCommands) && verification.exactCommands.length > 0
    && (tree?.latestVerifierMatchesCurrentTree !== true
      || !latestVerifier
      || !verification.exactCommands.includes(latestVerifier.command))) errors.push("completionApproved requires current exact verifier evidence");
  if (recovery === null) {
    const expectedAction = deliveryApproved ? "completed" : "handoff";
    if (nextSafeAction?.action !== expectedAction || nextSafeAction?.continuation !== "none"
      || nextSafeAction?.sourceMutationAllowed !== false || nextSafeAction?.exactCommands?.length !== 0) errors.push("next safe action conflicts with recovery state");
    if (requiredAuthority?.required !== false || requiredAuthority?.kind !== "none" || requiredAuthority?.reasonCodes?.length !== 0) errors.push("required authority conflicts with recovery state");
  } else if (recoveryErrors.length === 0) {
    const expectedAuthority = authority(recovery as RecoveryDecision);
    const expectedCommands = ["repair", "retry"].includes(recovery.action) ? verification?.exactCommands : [];
    if (nextSafeAction?.action !== recovery.action || nextSafeAction?.continuation !== recovery.continuation
      || nextSafeAction?.sourceMutationAllowed !== recovery.sourceMutationAllowed
      || JSON.stringify(nextSafeAction?.exactCommands) !== JSON.stringify(expectedCommands)) errors.push("next safe action conflicts with recovery decision");
    if (requiredAuthority?.required !== expectedAuthority.required || requiredAuthority?.kind !== expectedAuthority.kind
      || JSON.stringify(requiredAuthority?.reasonCodes) !== JSON.stringify(expectedAuthority.reasonCodes)) errors.push("required authority conflicts with recovery decision");
  }
  for (const reference of [value.references?.taskContract, value.references?.journal, value.references?.trajectory]) {
    if (typeof reference !== "string" || path.isAbsolute(reference) || reference.split(/[\\/]/).includes("..")) errors.push("state reference is invalid");
  }
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) errors.push("handoff projection exceeds 1 MiB"); }
  catch { errors.push("handoff projection is not serializable"); }
  return errors;
}

export function validateHandoffProjection(input: unknown, source = "handoff projection"): HandoffProjection {
  const errors = handoffProjectionValidationErrors(input);
  if (errors.length > 0) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as HandoffProjection;
}

function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function text(value: unknown, maximum = 1000): string { return redactSensitiveText(String(value ?? "")).text.replace(/\s+/g, " ").trim().slice(0, maximum); }

function strings(values: unknown, maximum = 100, itemMaximum = 1000): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => text(item, itemMaximum)).filter(Boolean))].slice(0, maximum);
}

export function taskAcceptanceDisposition(task: Pick<TaskContract, "changeMode" | "changedFiles" | "acceptanceReceipt">): HandoffProjection["acceptance"] {
  const required = task.changeMode === "source-change" && task.changedFiles.length > 0;
  const criteria = task.acceptanceReceipt?.criteria ?? [];
  return {
    required,
    satisfied: !required || (criteria.length > 0 && criteria.every((criterion) => criterion.status === "satisfied")),
    criteriaCount: criteria.length,
    dispositionDigest: digest(criteria.map((criterion) => ({
      id: criterion.id,
      hash: criterion.hash,
      status: criterion.status
    })))
  };
}

export function taskHandoffIdentity(task: Pick<TaskContract, "taskId" | "taskRunId" | "sessionId" | "sessionName" | "attempt" | "maxAttempts">): HandoffProjection["identity"] {
  return {
    taskId: text(task.taskId, 160),
    taskRunId: text(task.taskRunId, 160),
    sessionHash: digest(task.sessionId),
    sessionName: task.sessionName ? text(task.sessionName, 240) : null,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts
  };
}

export function handoffIdentityMatchesTask(
  identity: HandoffProjection["identity"] | undefined,
  task: Pick<TaskContract, "taskId" | "taskRunId" | "sessionId" | "sessionName" | "attempt" | "maxAttempts">
): boolean {
  if (!identity) return false;
  const authoritative = taskHandoffIdentity(task);
  return identity.taskId === authoritative.taskId
    && identity.taskRunId === authoritative.taskRunId
    && identity.sessionHash === authoritative.sessionHash
    // A session title is mutable display metadata. The hashed stable session id
    // above carries authority; renaming a live session must not invalidate its
    // otherwise identity-bound handoff.
    && identity.attempt === authoritative.attempt
    && identity.maxAttempts === authoritative.maxAttempts;
}

function summaryRef(value: unknown): DigestRef {
  const safe = text(value, 20_000);
  return { sha256: digest(safe), chars: safe.length };
}

function operationalFailure(cwd: string, task: TaskContract): { classification: FailureClassification | null; recovery: RecoveryDecision | null; integrity: "ok" | "corrupt"; warnings: string[] } {
  const replay = replayTaskCheckpoints(cwd, task.taskRunId, task);
  if (replay.corruptions.length > 0) return { classification: null, recovery: null, integrity: "corrupt", warnings: strings(replay.corruptions, 8, 300) };
  let classification: FailureClassification | null = null;
  let recovery: RecoveryDecision | null = null;
  for (const checkpoint of replay.checkpoints) {
    const evidence = checkpoint.evidence && typeof checkpoint.evidence === "object" ? checkpoint.evidence as Record<string, unknown> : {};
    const candidate = evidence.failureClassification;
    if (candidate && failureClassificationValidationErrors(candidate).length === 0 && (candidate as FailureClassification).category !== "passed") {
      classification = structuredClone(candidate) as FailureClassification;
    }
    const recoveryCandidate = evidence.recovery;
    if (recoveryCandidate && typeof recoveryCandidate === "object" && (recoveryCandidate as RecoveryDecision).policyVersion === "recovery-v1") {
      const typed = recoveryCandidate as RecoveryDecision;
      if (typed.taskId === task.taskId && typed.taskRunId === task.taskRunId) recovery = structuredClone(typed);
    }
  }
  return { classification, recovery, integrity: "ok", warnings: [] };
}

function authority(recovery: RecoveryDecision | null): HandoffProjection["requiredAuthority"] {
  if (!recovery) return { required: false, kind: "none", reasonCodes: [] };
  const reasons = strings(recovery.reasonCodes, 20, 120);
  if (recovery.action === "fresh-session") return { required: true, kind: "fresh-session", reasonCodes: reasons };
  if (recovery.reasonCodes.includes("permission-expansion-forbidden")) return { required: true, kind: "permission", reasonCodes: reasons };
  if (recovery.reasonCodes.includes("protected-path-forbidden")) return { required: true, kind: "permission", reasonCodes: reasons };
  // Backward-compatible projection for recovery records written before task
  // scope became advisory.
  if (recovery.reasonCodes.includes("scope-replan-required")) return { required: true, kind: "scope", reasonCodes: reasons };
  if (recovery.action === "ask-operator") return { required: true, kind: "operator", reasonCodes: reasons };
  return { required: false, kind: "none", reasonCodes: reasons };
}

export function handoffProjectionPath(cwd: string, taskRunId: string): string {
  return path.join(cwd, ".pi", "piagent-state", "handoffs", `${safeTaskId(taskRunId)}.json`);
}

export function buildHandoffProjection(
  cwd: string,
  task: TaskContract,
  options: { gate: CompletionGate; currentDigests?: Record<string, string>; recovery?: RecoveryDecision | null; generatedAt?: string }
): HandoffProjection {
  const currentDigests = options.currentDigests ?? workingTreeSnapshot(cwd) as Record<string, string>;
  const baselineDigest = workingTreeEvidenceDigest(task.baselineFileDigests ?? {});
  const currentDigest = workingTreeEvidenceDigest(currentDigests);
  const trajectory = readTrajectoryStore(cwd, task.taskRunId);
  const journal = operationalFailure(cwd, task);
  const recovery = Object.prototype.hasOwnProperty.call(options, "recovery")
    ? options.recovery ?? null
    : journal.recovery;
  const observed = latestObservedVerification(task.verifyEvidence) ?? undefined;
  const actualChanged = changedSnapshotFiles(task.baselineFileDigests ?? {}, currentDigests);
  const relevant = actualChanged.filter((file) => task.observedChangedFiles.includes(file) || task.changedFiles.includes(file));
  const migrationReplay = replayTaskCheckpoints(cwd, task.taskRunId, task);
  const migrationCurrent = !task.workingTreeDigestMigration || (task.workingTreeDigestMigration.status === "refreshed"
    && taskDigestMigrationArchiveStatus(cwd, task).valid
    && migrationReplay.corruptions.length === 0
    && Boolean(migrationReplay.migrationBarrier));
  const canonicalBaseline = JSON.stringify([...task.baselineChangedFiles].sort()) === JSON.stringify(Object.keys(task.baselineFileDigests).sort());
  const canonicalFinal = JSON.stringify([...task.finalWorkingTreeFiles].sort()) === JSON.stringify(Object.keys(task.finalFileDigests).sort());
  const evidenceCurrent = taskContractValidationErrors(task).length === 0
    && task.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM
    && task.workingTreeDigestMigration?.status !== "verification-refresh-required"
    && migrationCurrent
    && canonicalBaseline
    && canonicalFinal
    && workingTreeEvidenceDigest(task.finalFileDigests) === currentDigest
    && isCurrentWorkingTreeDigest(baselineDigest)
    && isCurrentWorkingTreeDigest(currentDigest);
  const gateDigestCurrent = isCurrentWorkingTreeDigest(options.gate.currentWorkingTreeDigest)
    && options.gate.currentWorkingTreeDigest === currentDigest;
  const exactCommands = strings(task.verifyCommands, 50, 1000);
  const currentExactVerifier = exactCommands.length === 0 || (verificationEvidenceProvesCurrentWorkspace(observed, currentDigest, cwd)
    && exactCommands.includes(text(observed?.command, 1000)));
  const acceptanceDisposition = taskAcceptanceDisposition(task);
  const acceptanceSatisfied = acceptanceDisposition.satisfied;
  const completionApproved = options.gate.decision === "pass"
    && task.trace.outcome === "completed"
    && acceptanceSatisfied
    && evidenceCurrent
    && gateDigestCurrent
    && currentExactVerifier;
  const diagnosticDelivery = buildDiagnosticDelivery(task, options.gate, acceptanceDisposition,
    evidenceCurrent && gateDigestCurrent && currentExactVerifier);
  const completionMissing = strings(diagnosticCompletionMissing(options.gate.decision, options.gate.missing,
    acceptanceSatisfied, evidenceCurrent, gateDigestCurrent, currentExactVerifier), 50, 500);
  const ruledOut = task.ruledOut ? [{ ref: digest(text(task.ruledOut, 1000)), summary: text(task.ruledOut, 300) }] : [];
  const latestVerifier: LatestVerifier | null = observed ? {
    command: text(observed.command, 1000),
    exitCode: observed.exitCode,
    observedAt: observed.observedAt ?? observed.recordedAt ?? null,
    matchedProfileCommand: observed.matchedProfileCommand === true,
    isError: observed.isError === true,
    preWorkingTreeDigest: observed.preWorkingTreeDigest ?? null,
    workingTreeDigest: observed.workingTreeDigest ?? null,
    preWorkspaceRevisionDigest: observed.preWorkspaceRevisionDigest ?? null,
    workspaceRevisionDigest: observed.workspaceRevisionDigest ?? null,
    summaryRef: summaryRef(observed.summary)
  } : null;
  const projection: HandoffProjection = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    projectionVersion: HANDOFF_PROJECTION_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    identity: taskHandoffIdentity(task),
    goal: {
      summary: text(task.summary, 1000), expectedOutput: text(task.expectedOutput, 1000),
      acceptanceCriteria: strings(task.acceptanceCriteria, 50, 1000), scope: strings(task.scope, 100, 500), outOfScope: strings(task.outOfScope, 100, 500)
    },
    state: {
      phase: trajectory.enforcementSafe ? trajectory.state?.currentPhase ?? null : null,
      taskOutcome: task.trace.outcome, gateDecision: options.gate.decision, completionApproved,
      missing: completionMissing, ...(diagnosticDelivery ? { diagnosticDelivery } : {})
    },
    acceptance: acceptanceDisposition,
    decisionsAndInvariants: [
      "Task Contract v2 is authoritative for task outcome.",
      "Failure classification never authorizes source mutation by itself.",
      "Source mutation still requires hook authorization; task scope is an advisory retrieval/review focus.",
      "Verifier evidence is current only when both working-tree content and workspace baseline identities match before, after, and now."
    ],
    contextReferences: {
      required: strings(task.requiredContext, 100, 500),
      observed: task.contextManifest.slice(0, 100).map((entry) => ({ path: text(entry.path, 500), reason: text(entry.reason, 500) })),
      memory: task.memoryCitations.slice(0, 100).map((entry) => ({ path: text(entry.path, 500), reason: text(entry.reason, 500) }))
    },
    tree: {
      algorithm: task.workingTreeDigestAlgorithm,
      workspaceRevisionDigest: currentWorkspaceRevisionDigest(cwd),
      migration: projectedMigration(task),
      baselineDigest: task.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM && isCurrentWorkingTreeDigest(baselineDigest) ? baselineDigest : null,
      currentDigest: task.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM && isCurrentWorkingTreeDigest(currentDigest) ? currentDigest : null,
      evidenceCurrent,
      latestVerifierMatchesCurrentTree: verificationEvidenceProvesCurrentWorkspace(observed, currentDigest, cwd)
    },
    changedFiles: {
      baseline: strings(task.baselineChangedFiles, 500, 500), observed: strings(task.observedChangedFiles, 500, 500),
      current: strings(relevant, 500, 500), claimed: strings(task.changedFiles, 500, 500)
    },
    verification: { exactCommands, missingCommands: strings(options.gate.missingVerifyCommands, 50, 1000), latestObserved: latestVerifier },
    failure: { classification: journal.classification, recovery, journalIntegrity: journal.integrity, warnings: journal.warnings },
    ruledOutHypotheses: ruledOut,
    requiredAuthority: authority(recovery),
    nextSafeAction: {
      action: recovery?.action ?? (completionApproved || diagnosticDelivery ? "completed" : "handoff"),
      continuation: recovery?.continuation ?? "none",
      sourceMutationAllowed: recovery?.sourceMutationAllowed === true,
      exactCommands: recovery?.action === "retry" || recovery?.action === "repair" ? strings(task.verifyCommands, 50, 1000) : []
    },
    references: {
      taskContract: `.pi/piagent-state/tasks/${safeTaskId(task.taskRunId)}.json`,
      journal: path.relative(cwd, taskJournalPaths(cwd).events).split(path.sep).join("/"),
      trajectory: path.relative(cwd, trajectoryStatePath(cwd, task.taskRunId)).split(path.sep).join("/"),
      failureCapture: journal.classification?.outputRef.captureRef ?? null,
      solverDecision: trajectory.enforcementSafe ? trajectory.state?.recommendationRef ?? null : null,
      helper: { mode: task.orchestration?.mode ?? null, subagents: task.orchestration?.subagents ?? null, fieldGuidePath: task.orchestration?.fieldGuidePath ?? null }
    }
  };
  return validateHandoffProjection(projection);
}

export function writeHandoffProjection(cwd: string, projectionInput: HandoffProjection): HandoffProjection {
  const projection = validateHandoffProjection(structuredClone(projectionInput));
  const target = handoffProjectionPath(cwd, projection.identity.taskRunId);
  const parent = ensurePrivateStateDirectory(cwd, path.dirname(target), "Handoff directory");
  const safeTarget = resolveLocalStatePath(cwd, target, { label: "Handoff projection" });
  const temporary = path.join(parent, `${path.basename(safeTarget)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
    const descriptor = fs.openSync(temporary, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, safeTarget);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* The final path remains authoritative. */ }
    throw error;
  }
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
  return projection;
}

export function readHandoffProjection(cwd: string, taskRunId: string): HandoffProjection | undefined {
  const target = resolveLocalStatePath(cwd, handoffProjectionPath(cwd, taskRunId), { label: "Handoff projection" });
  try { const value = JSON.parse(fs.readFileSync(target, "utf8")); if (value?.schemaVersion === 1 && value?.projectionVersion === "handoff-v1") return undefined; return validateHandoffProjection(value, "persisted handoff projection"); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return undefined; throw error; }
}

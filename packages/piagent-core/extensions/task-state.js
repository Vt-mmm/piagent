import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "./local-state-path.js";
import { appendTaskJournalEvent, readTaskJournal } from "./task-journal.js";
import {
  acceptanceReceiptProvenanceSummary,
  acceptanceReceiptSummary,
  acceptanceReceiptValidationErrors,
  normalizeAcceptanceReceipt
} from "./acceptance-receipt.js";
import { LEGACY_UNTRUSTED_DIGEST_ALGORITHM } from "./task-digest-migration.js";
import { criterionGraphValidationErrors, normalizeCriterionGraph } from "./criterion-graph.js";
import { normalizeTaskAuthoritySnapshot, taskAuthorityContractValidationErrors } from "./task-authority-contract.js";
import {
  commitLegacySchemaTaskDigestState,
  migrateUnversionedTaskDigestState,
  taskDigestMigrationArchiveStatus,
  taskNeedsDigestMigration
} from "./task-digest-state.js";
export { taskDigestMigrationArchiveStatus } from "./task-digest-state.js";
import { acceptanceReceiptWithoutWorkingTreeProof, normalizedTaskDigestFields, taskDigestContractValidationErrors } from "./task-digest-contract.js";
import {
  WORKING_TREE_DIGEST_ALGORITHM,
  isCurrentWorkingTreeDigest,
  isUnavailableWorkingTreeDigest,
  unavailableWorkingTreeHash,
  versionWorkingTreeHash
} from "./working-tree-digest.js";

export const TASK_CONTRACT_SCHEMA_VERSION = 2; export const DEFAULT_MAX_TASK_ATTEMPTS = 3;
const TASK_OUTCOMES = ["pending", "completed", "blocked", "partial", "failed"], TERMINAL_TASK_OUTCOMES = new Set(["completed", "blocked", "partial", "failed"]);
const REVIEW_LENSES = ["correctness", "tests", "scope", "security", "docs", "release", "package"];
const TASK_CONTRACT_FIELDS = new Set([
  "schemaVersion", "taskRunId", "taskId", "sessionId", "sessionName", "changeMode", "attempt", "maxAttempts",
  "previousAttempts", "summary", "riskLane", "intakeMode", "expectedOutput", "acceptanceCriteria", "criterionGraph", "scope", "outOfScope",
  "protectedPaths", "requiredContext", "contextManifest", "memoryCitations", "mcpCapabilities", "verifyGroup",
  "verifyCommands", "workPlan", "reviewLenses", "orchestration", "acceptanceReceipt", "authoritySnapshot", "workingTreeDigestAlgorithm", "workingTreeDigestMigration", "baselineChangedFiles", "baselineFileDigests",
  "observedChangedFiles", "finalWorkingTreeFiles", "finalFileDigests", "changedFiles", "verifyEvidence", "trace",
  "failedAt", "failureReason", "ruledOut", "migratedFromSchemaVersion", "createdAt", "updatedAt"
]);
const PREVIOUS_ATTEMPT_FIELDS = new Set(["taskRunId", "attempt", "outcome", "failedAt", "reason", "ruledOut", "recordedAt"]);
const CITATION_FIELDS = new Set(["path", "reason"]);
const WORK_PLAN_FIELDS = new Set(["id", "title", "role", "mode", "status", "dependsOn", "note", "updatedAt"]);
const ORCHESTRATION_FIELDS = new Set(["mode", "subagents", "reason", "fieldGuidePath", "modelRoles"]);
const MODEL_ROLE_FIELDS = new Set(["planner", "worker", "reviewer", "watchdog"]);
const VERIFY_EVIDENCE_FIELDS = new Set(["command", "exitCode", "summary", "recordedAt", "observed", "observedAt", "isError", "matchedProfileCommand", "preWorkingTreeDigest", "workingTreeDigest"]);
const TRACE_FIELDS = new Set(["outcome", "friction", "notes", "recordedAt"]);
const WORKSPACE_EVIDENCE_MAX_FILES = 2000;
const WORKSPACE_EVIDENCE_SKIP_NAMES = new Set([
  ".git", ".hg", ".svn", ".pi", "node_modules", "dist", "build", ".next", "coverage"
]);
const WORKSPACE_EVIDENCE_PRIORITY_NAMES = new Map([
  ["plans", 0]
]);

export function safeTaskId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return normalized || "task";
}

function stateRoot(cwd) {
  return path.join(cwd, ".pi", "piagent-state");
}

function tasksRoot(cwd) {
  return path.join(stateRoot(cwd), "tasks");
}

function sessionsRoot(cwd) {
  return path.join(stateRoot(cwd), "session-tasks");
}

function taskRunPath(cwd, taskRunId) {
  return path.join(tasksRoot(cwd), `${safeTaskId(taskRunId)}.json`);
}

function sessionBindingPath(cwd, sessionId) {
  const digest = crypto.createHash("sha256").update(String(sessionId || "unknown")).digest("hex");
  return path.join(sessionsRoot(cwd), `${digest}.json`);
}

function readTaskRun(cwd, taskRunId) {
  const raw = readJson(cwd, taskRunPath(cwd, taskRunId));
  const task = normalizeTaskContract(raw, { sourceName: taskRunId });
  return task?.taskRunId === safeTaskId(taskRunId) ? task : undefined;
}

function readJson(cwd, filePath) {
  try {
    const safePath = resolveLocalStatePath(cwd, filePath, { label: "Task state", kind: "file" });
    const descriptor = fs.openSync(safePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      return JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(cwd, filePath, value) {
  const parent = ensurePrivateStateDirectory(cwd, path.dirname(filePath), "Task state directory");
  const safePath = resolveLocalStatePath(cwd, filePath, { label: "Task state" });
  const temporary = path.join(parent, `${path.basename(safePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, safePath);
  try {
    fs.chmodSync(parent, 0o700);
    fs.chmodSync(safePath, 0o600);
  } catch {
    // Best effort on filesystems that do not expose POSIX modes.
  }
}

function appendTaskStateJournalEvent(cwd, event) {
  try {
    return appendTaskJournalEvent(cwd, event);
  } catch {
    // The contract remains the operational source of truth. Journal failures are
    // surfaced by doctor/reporting instead of corrupting normal task writes.
    return undefined;
  }
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))] : [];
}

function stringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => key && typeof item === "string")
    .map(([key, item]) => [key.replaceAll("\\", "/"), item]));
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function validTimestamp(value) {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function normalizedTimestamp(value, fallback) {
  return validTimestamp(value) ? value : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unsupportedObjectField(value, allowed) {
  if (!isRecord(value)) return undefined;
  return Object.keys(value).find((key) => !allowed.has(key));
}

function pickFields(value, allowed) {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

function legacyRunId(task, sourceName = "task") {
  const taskId = safeTaskId(task?.taskId ?? sourceName);
  const identity = `${taskId}\u0000${task?.createdAt ?? "legacy"}\u0000${sourceName}`;
  const suffix = `legacy-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
  const taskKey = taskId.slice(0, 80 - suffix.length - 1).replace(/-+$/g, "") || "task";
  return `${taskKey}-${suffix}`;
}

export function taskContractValidationErrors(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["contract must be an object"];
  const errors = [];
  for (const key of Object.keys(input)) {
    if (!TASK_CONTRACT_FIELDS.has(key)) errors.push(`unsupported task contract field ${key}`);
  }
  if (input.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${TASK_CONTRACT_SCHEMA_VERSION}`);
  for (const field of ["taskRunId", "taskId", "sessionId", "summary", "expectedOutput", "createdAt", "updatedAt"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) errors.push(`${field} is required`);
  }
  if (typeof input.taskRunId === "string" && safeTaskId(input.taskRunId) !== input.taskRunId) errors.push("taskRunId must be normalized");
  if (typeof input.taskId === "string" && safeTaskId(input.taskId) !== input.taskId) errors.push("taskId must be normalized");
  if (typeof input.summary === "string" && input.summary.trim().length < 10) errors.push("summary must be at least 10 characters");
  if (typeof input.expectedOutput === "string" && input.expectedOutput.trim().length < 10) errors.push("expectedOutput must be at least 10 characters");
  for (const field of ["createdAt", "updatedAt"]) {
    if (typeof input[field] === "string" && !validTimestamp(input[field])) errors.push(`${field} must be a valid timestamp`);
  }
  if (input.sessionName !== undefined && typeof input.sessionName !== "string") errors.push("sessionName must be a string");
  if (input.verifyGroup !== undefined && (typeof input.verifyGroup !== "string" || !input.verifyGroup.trim())) errors.push("verifyGroup must be a non-empty string");
  if (input.migratedFromSchemaVersion !== undefined && (!Number.isInteger(input.migratedFromSchemaVersion) || input.migratedFromSchemaVersion < 1)) errors.push("migratedFromSchemaVersion must be a positive integer");
  for (const field of ["failureReason", "ruledOut"]) {
    if (input[field] !== undefined && typeof input[field] !== "string") errors.push(`${field} must be a string`);
  }
  if (input.failedAt !== undefined && !["research", "plan", "execute", "verify", "review"].includes(input.failedAt)) errors.push("failedAt is invalid");
  if (!["source-change", "read-only"].includes(input.changeMode)) errors.push("changeMode is invalid");
  if (!["tiny", "normal", "high-risk"].includes(input.riskLane)) errors.push("riskLane is invalid");
  if (input.intakeMode !== undefined && !["model", "runtime"].includes(input.intakeMode)) errors.push("intakeMode is invalid");
  errors.push(...taskDigestContractValidationErrors(input));
  errors.push(...acceptanceReceiptValidationErrors(input.acceptanceReceipt), ...criterionGraphValidationErrors(input.criterionGraph, input));
  errors.push(...taskAuthorityContractValidationErrors(input));
  if (!Number.isInteger(input.attempt) || input.attempt < 1) errors.push("attempt must be a positive integer");
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10) errors.push("maxAttempts must be between 1 and 10"); if (Number.isInteger(input.attempt) && Number.isInteger(input.maxAttempts) && input.attempt > input.maxAttempts) errors.push("attempt exceeds maxAttempts");
  for (const field of [
    "previousAttempts", "acceptanceCriteria", "scope", "outOfScope", "protectedPaths", "requiredContext",
    "contextManifest", "memoryCitations", "mcpCapabilities", "verifyCommands", "workPlan", "reviewLenses",
    "baselineChangedFiles", "observedChangedFiles", "finalWorkingTreeFiles", "changedFiles", "verifyEvidence"
  ]) {
    if (!Array.isArray(input[field])) errors.push(`${field} must be an array`);
  }
  for (const field of ["baselineFileDigests", "finalFileDigests"]) {
    if (!input[field] || typeof input[field] !== "object" || Array.isArray(input[field])) errors.push(`${field} must be an object`);
    else if (Object.entries(input[field]).some(([key, value]) => !key || typeof value !== "string")) errors.push(`${field} must contain string digests`);
    else if (input.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM && Object.values(input[field]).some((value) => !isCurrentWorkingTreeDigest(value) && !isUnavailableWorkingTreeDigest(value))) errors.push(`${field} must contain ${WORKING_TREE_DIGEST_ALGORITHM} digests`);
    else if (input.workingTreeDigestAlgorithm === LEGACY_UNTRUSTED_DIGEST_ALGORITHM && Object.keys(input[field]).length > 0) errors.push(`${field} legacy evidence must be archived, not reinterpreted`);
  }
  for (const [list, map] of [["baselineChangedFiles", "baselineFileDigests"], ["finalWorkingTreeFiles", "finalFileDigests"]]) {
    if (Array.isArray(input[list]) && isRecord(input[map]) && JSON.stringify([...input[list]].sort()) !== JSON.stringify(Object.keys(input[map]).sort())) errors.push(`${list} must exactly match ${map} keys`);
  }
  if (input.changeMode === "source-change" && isRecord(input.baselineFileDigests) && Object.values(input.baselineFileDigests).some(isUnavailableWorkingTreeDigest)) errors.push("source-change baseline evidence must be proof-capable");
  for (const field of ["acceptanceCriteria", "scope", "outOfScope", "protectedPaths", "requiredContext", "mcpCapabilities", "verifyCommands", "reviewLenses", "baselineChangedFiles", "observedChangedFiles", "finalWorkingTreeFiles", "changedFiles"]) {
    if (Array.isArray(input[field]) && input[field].some((item) => typeof item !== "string" || !item.trim())) errors.push(`${field} must contain non-empty strings`);
  }
  if (Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length === 0) errors.push("acceptanceCriteria must not be empty");
  if (Array.isArray(input.scope) && input.scope.length === 0) errors.push("scope must not be empty");
  if (Array.isArray(input.previousAttempts) && input.previousAttempts.length > 10) errors.push("previousAttempts must contain at most 10 entries");
  if (Array.isArray(input.workPlan) && input.workPlan.length > 12) errors.push("workPlan must contain at most 12 entries");
  if (Array.isArray(input.reviewLenses)) {
    if (new Set(input.reviewLenses).size !== input.reviewLenses.length) errors.push("reviewLenses must be unique");
    if (input.reviewLenses.some((item) => !REVIEW_LENSES.includes(item))) errors.push("reviewLenses contains an invalid lens");
  }
  for (const field of ["contextManifest", "memoryCitations"]) {
    if (Array.isArray(input[field]) && input[field].some((item) => !isRecord(item) || unsupportedObjectField(item, CITATION_FIELDS) || typeof item.path !== "string" || !item.path.trim() || typeof item.reason !== "string" || !item.reason.trim())) {
      errors.push(`${field} entries require path and reason`);
    }
  }
  if (Array.isArray(input.previousAttempts) && input.previousAttempts.some((item) => (
    !isRecord(item)
    || unsupportedObjectField(item, PREVIOUS_ATTEMPT_FIELDS)
    || typeof item.taskRunId !== "string"
    || !item.taskRunId.trim()
    || !Number.isInteger(item.attempt)
    || item.attempt < 1
    || !TASK_OUTCOMES.includes(item.outcome)
    || (item.failedAt !== undefined && !["research", "plan", "execute", "verify", "review"].includes(item.failedAt))
    || (item.reason !== undefined && typeof item.reason !== "string")
    || (item.ruledOut !== undefined && typeof item.ruledOut !== "string")
    || !validTimestamp(item.recordedAt)
  ))) {
    errors.push("previousAttempts entries are invalid");
  }
  if (Array.isArray(input.workPlan)) {
    const ids = new Set();
    for (const step of input.workPlan) {
      if (
        !step
        || typeof step !== "object"
        || unsupportedObjectField(step, WORK_PLAN_FIELDS)
        || typeof step.id !== "string"
        || safeTaskId(step.id).slice(0, 40) !== step.id
        || typeof step.title !== "string"
        || !step.title.trim()
        || step.title.length > 160
        || !["parent", "piagent-scout", "piagent-planner", "piagent-worker", "piagent-reviewer", "piagent-oracle"].includes(step.role)
        || !["read-only", "single-writer", "review"].includes(step.mode)
        || !["pending", "in-progress", "done", "skipped", "failed"].includes(step.status)
        || (step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.some((item) => typeof item !== "string" || !item.trim())))
        || (Array.isArray(step.dependsOn) && new Set(step.dependsOn).size !== step.dependsOn.length)
        || (step.note !== undefined && (typeof step.note !== "string" || step.note.length > 500))
        || (step.updatedAt !== undefined && !validTimestamp(step.updatedAt))
      ) {
        errors.push("workPlan entries are invalid");
        break;
      }
      if (ids.has(step.id)) errors.push(`workPlan has duplicate step ${step.id}`);
      ids.add(step.id);
    }
    if (input.workPlan.some((step) => (step?.dependsOn ?? []).some((dependency) => !ids.has(dependency)))) errors.push("workPlan has an unknown dependency");
    const dependencyError = workPlanDependencyError(input.workPlan);
    if (dependencyError) errors.push(dependencyError);
  }
  if (Array.isArray(input.verifyEvidence) && input.verifyEvidence.some((item) => (
    !isRecord(item)
    || unsupportedObjectField(item, VERIFY_EVIDENCE_FIELDS)
    || typeof item.command !== "string"
    || !item.command.trim()
    || !Number.isInteger(item.exitCode)
    || typeof item.summary !== "string"
    || !item.summary.trim()
    || !validTimestamp(item.recordedAt)
    || (item.observed !== undefined && typeof item.observed !== "boolean")
    || (item.observedAt !== undefined && !validTimestamp(item.observedAt))
    || (item.isError !== undefined && typeof item.isError !== "boolean")
    || (item.matchedProfileCommand !== undefined && typeof item.matchedProfileCommand !== "boolean")
    || (item.preWorkingTreeDigest !== undefined && !isCurrentWorkingTreeDigest(item.preWorkingTreeDigest))
    || (item.workingTreeDigest !== undefined && !isCurrentWorkingTreeDigest(item.workingTreeDigest))
  ))) {
    errors.push("verifyEvidence entries are invalid");
  }
  if (!isRecord(input.trace) || unsupportedObjectField(input.trace, TRACE_FIELDS) || !TASK_OUTCOMES.includes(input.trace.outcome)) {
    errors.push("trace.outcome is invalid");
  } else if (input.trace.recordedAt !== undefined && !validTimestamp(input.trace.recordedAt)) {
    errors.push("trace.recordedAt must be a valid timestamp");
  }
  if (input.orchestration !== undefined) {
    const orchestration = input.orchestration;
    if (
      !isRecord(orchestration)
      || unsupportedObjectField(orchestration, ORCHESTRATION_FIELDS)
      || !["solo-first", "bounded-subagents", "parallel-readonly"].includes(orchestration.mode)
      || !["not-used", "optional", "used"].includes(orchestration.subagents)
      || typeof orchestration.reason !== "string"
      || !orchestration.reason.trim()
      || (orchestration.fieldGuidePath !== undefined && (typeof orchestration.fieldGuidePath !== "string" || !orchestration.fieldGuidePath.trim()))
      || (orchestration.modelRoles !== undefined && (
        !isRecord(orchestration.modelRoles)
        || unsupportedObjectField(orchestration.modelRoles, MODEL_ROLE_FIELDS)
        || Object.values(orchestration.modelRoles).some((item) => typeof item !== "string")
      ))
    ) errors.push("orchestration is invalid");
  }
  return errors;
}

export function workPlanDependencyError(steps) {
  if (!Array.isArray(steps)) return "workPlan must be an array";
  const byId = new Map();
  for (const step of steps) {
    if (!step || typeof step.id !== "string") continue;
    if (byId.has(step.id)) return `workPlan has duplicate step ${step.id}`;
    byId.set(step.id, step);
  }
  for (const step of steps) {
    if (!step || typeof step.id !== "string") continue;
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) return `workPlan step ${step.id} depends on itself`;
      if (!byId.has(dependency)) return `workPlan step ${step.id} has unknown dependency ${dependency}`;
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  return [...byId.keys()].every(visit) ? undefined : "workPlan dependencies contain a cycle";
}

export function normalizeTaskContract(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  if (input.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION && taskContractValidationErrors(input).length > 0) return undefined;
  const taskId = safeTaskId(input.taskId ?? options.sourceName ?? "task");
  const taskRunId = safeTaskId(input.taskRunId ?? legacyRunId(input, options.sourceName));
  const trace = input.trace && typeof input.trace === "object" ? input.trace : {};
  const sessionId = String(input.sessionId ?? options.sessionId ?? "legacy").trim() || "legacy";
  const now = new Date().toISOString();
  const createdAt = normalizedTimestamp(input.createdAt, now);
  const updatedAt = normalizedTimestamp(input.updatedAt, createdAt);
  const digestFields = normalizedTaskDigestFields(input, { schemaVersion: TASK_CONTRACT_SCHEMA_VERSION, taskRunId, trace, updatedAt, options });
  const currentDigestContract = digestFields.current, legacyDigestContract = digestFields.legacy;
  const verifyEvidence = Array.isArray(input.verifyEvidence)
    ? input.verifyEvidence.map((item) => item && typeof item === "object" ? {
        command: item.command,
        exitCode: item.exitCode,
        summary: item.summary,
        recordedAt: normalizedTimestamp(item.recordedAt, updatedAt),
        observed: item.observed,
        observedAt: item.observedAt,
        isError: item.isError,
        matchedProfileCommand: item.matchedProfileCommand,
        preWorkingTreeDigest: item.preWorkingTreeDigest,
        workingTreeDigest: item.workingTreeDigest
      } : item)
    : [];
  const normalized = {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskRunId,
    taskId,
    sessionId,
    sessionName: String(input.sessionName ?? options.sessionName ?? "").trim() || undefined,
    changeMode: input.changeMode === "read-only" ? "read-only" : "source-change",
    attempt: positiveInteger(input.attempt, 1, 100),
    maxAttempts: positiveInteger(input.maxAttempts, DEFAULT_MAX_TASK_ATTEMPTS, 10),
    previousAttempts: Array.isArray(input.previousAttempts) ? input.previousAttempts.slice(-10).map((item) => pickFields(item, PREVIOUS_ATTEMPT_FIELDS)) : [],
    summary: typeof input.summary === "string" ? input.summary : "",
    riskLane: ["tiny", "normal", "high-risk"].includes(input.riskLane) ? input.riskLane : "normal",
    intakeMode: ["model", "runtime"].includes(input.intakeMode) ? input.intakeMode : "model",
    expectedOutput: typeof input.expectedOutput === "string" ? input.expectedOutput : "", acceptanceCriteria: stringArray(input.acceptanceCriteria),
    criterionGraph: normalizeCriterionGraph(input.criterionGraph), scope: stringArray(input.scope),
    outOfScope: stringArray(input.outOfScope),
    protectedPaths: stringArray(input.protectedPaths),
    requiredContext: stringArray(input.requiredContext),
    contextManifest: Array.isArray(input.contextManifest) ? input.contextManifest.map((item) => pickFields(item, CITATION_FIELDS)) : [],
    memoryCitations: Array.isArray(input.memoryCitations) ? input.memoryCitations.map((item) => pickFields(item, CITATION_FIELDS)) : [],
    mcpCapabilities: stringArray(input.mcpCapabilities),
    verifyGroup: typeof input.verifyGroup === "string" && input.verifyGroup.trim() ? input.verifyGroup.trim() : undefined,
    verifyCommands: stringArray(input.verifyCommands),
    workPlan: Array.isArray(input.workPlan) ? input.workPlan.map((item) => pickFields(item, WORK_PLAN_FIELDS)) : [],
    reviewLenses: stringArray(input.reviewLenses),
    acceptanceReceipt: normalizeAcceptanceReceipt(legacyDigestContract
      ? acceptanceReceiptWithoutWorkingTreeProof(input.acceptanceReceipt, updatedAt)
      : input.acceptanceReceipt),
    authoritySnapshot: normalizeTaskAuthoritySnapshot(input.authoritySnapshot),
    workingTreeDigestAlgorithm: digestFields.algorithm,
    workingTreeDigestMigration: digestFields.migration,
    orchestration: isRecord(input.orchestration) ? {
      ...pickFields(input.orchestration, ORCHESTRATION_FIELDS),
      modelRoles: isRecord(input.orchestration.modelRoles)
        ? pickFields(input.orchestration.modelRoles, MODEL_ROLE_FIELDS)
        : input.orchestration.modelRoles
    } : undefined,
    baselineChangedFiles: legacyDigestContract ? [] : stringArray(input.baselineChangedFiles),
    baselineFileDigests: legacyDigestContract ? {} : stringRecord(input.baselineFileDigests),
    observedChangedFiles: legacyDigestContract ? [] : stringArray(input.observedChangedFiles),
    finalWorkingTreeFiles: legacyDigestContract ? [] : stringArray(input.finalWorkingTreeFiles),
    finalFileDigests: legacyDigestContract ? {} : stringRecord(input.finalFileDigests),
    changedFiles: legacyDigestContract ? [] : stringArray(input.changedFiles),
    verifyEvidence: legacyDigestContract ? [] : verifyEvidence,
    trace: {
      outcome: legacyDigestContract && trace.outcome === "pending" ? "blocked" : TASK_OUTCOMES.includes(trace.outcome) ? trace.outcome : "pending",
      friction: legacyDigestContract && trace.outcome === "pending" ? "Legacy working-tree evidence is not replayable; start a new attempt." : typeof trace.friction === "string" ? trace.friction : undefined,
      notes: typeof trace.notes === "string" ? trace.notes : undefined,
      recordedAt: legacyDigestContract && trace.outcome === "pending" ? updatedAt : trace.recordedAt === undefined ? undefined : normalizedTimestamp(trace.recordedAt, updatedAt)
    },
    failedAt: legacyDigestContract && trace.outcome === "pending" ? "verify" : ["research", "plan", "execute", "verify", "review"].includes(input.failedAt) ? input.failedAt : undefined,
    failureReason: legacyDigestContract && trace.outcome === "pending" ? "Working-tree digest migration requires a bounded new attempt." : typeof input.failureReason === "string" ? input.failureReason : undefined,
    ruledOut: typeof input.ruledOut === "string" ? input.ruledOut : undefined,
    createdAt,
    updatedAt,
    migratedFromSchemaVersion: input.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION
      ? input.migratedFromSchemaVersion
      : positiveInteger(input.schemaVersion, 1, TASK_CONTRACT_SCHEMA_VERSION)
  };
  return normalized;
}

export function createTaskRunId(taskId, sessionId, createdAt = new Date().toISOString()) {
  const stamp = createdAt.replace(/[^0-9]/g, "").slice(0, 14);
  const entropy = crypto.createHash("sha256")
    .update(`${sessionId}\u0000${createdAt}\u0000${crypto.randomUUID()}`)
    .digest("hex")
    .slice(0, 10);
  // Reserve room for the timestamp and entropy. Truncating the assembled value
  // could otherwise discard the only collision-resistant part of a long task ID.
  const taskKey = safeTaskId(taskId).slice(0, 48).replace(/-+$/g, "") || "task";
  return `${taskKey}-${stamp}-${entropy}`;
}

export function writeTaskContract(cwd, task) {
  const sourceErrors = task?.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION ? taskContractValidationErrors(task) : [];
  if (sourceErrors.length > 0) throw new Error(`Task contract is invalid: ${sourceErrors.join("; ")}`);
  const normalized = normalizeTaskContract(task);
  if (!normalized) throw new Error("Task contract is not an object");
  const errors = taskContractValidationErrors(normalized);
  if (errors.length > 0) throw new Error(`Task contract is invalid: ${errors.join("; ")}`);
  const existing = readTaskRun(cwd, normalized.taskRunId);
  if (existing && TERMINAL_TASK_OUTCOMES.has(existing.trace?.outcome)) {
    throw new Error(`Task contract ${existing.taskRunId} is immutable after ${existing.trace.outcome}`);
  }
  normalized.updatedAt = new Date().toISOString();
  writeJsonAtomic(cwd, taskRunPath(cwd, normalized.taskRunId), normalized);
  appendTaskStateJournalEvent(cwd, {
    eventType: "contract-written",
    taskRunId: normalized.taskRunId,
    taskId: normalized.taskId,
    sessionId: normalized.sessionId,
    sessionName: normalized.sessionName,
    data: {
      outcome: normalized.trace?.outcome,
      attempt: normalized.attempt,
      changeMode: normalized.changeMode,
      riskLane: normalized.riskLane,
      verifyCommands: normalized.verifyCommands,
      scope: normalized.scope,
      acceptanceReceipt: acceptanceReceiptSummary(normalized.acceptanceReceipt),
      acceptanceProvenance: acceptanceReceiptProvenanceSummary(normalized.acceptanceReceipt), authoritySnapshot: normalized.authoritySnapshot ? { profile: normalized.authoritySnapshot.profile, manifestDigest: normalized.authoritySnapshot.manifestDigest, snapshotDigest: normalized.authoritySnapshot.snapshotDigest } : null
    }
  });
  return normalized;
}

export function listTaskContracts(cwd) {
  const root = resolveLocalStatePath(cwd, tasksRoot(cwd), { label: "Task state directory" });
  if (!fs.existsSync(root)) return [];
  resolveLocalStatePath(cwd, tasksRoot(cwd), { label: "Task state directory", kind: "directory" });
  const byRunId = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = readJson(cwd, path.join(root, entry.name));
    const sourceName = entry.name.slice(0, -5);
    const task = normalizeTaskContract(raw, { sourceName });
    if (!task) continue;
    if (raw?.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION && task.taskRunId !== safeTaskId(sourceName)) continue;
    const previous = byRunId.get(task.taskRunId);
    if (!previous || Date.parse(task.updatedAt) >= Date.parse(previous.updatedAt)) byRunId.set(task.taskRunId, task);
  }
  return [...byRunId.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function bindSessionTask(cwd, sessionId, sessionName, task) {
  if (!sessionId || !task?.taskRunId) return undefined;
  if (task.sessionId !== String(sessionId)) {
    throw new Error(`Cannot bind task ${task.taskRunId} from session ${task.sessionId} to ${sessionId}`);
  }
  const binding = {
    schemaVersion: 1,
    sessionId: String(sessionId),
    sessionName: String(sessionName ?? task.sessionName ?? "").trim() || undefined,
    activeTaskRunId: task.taskRunId,
    taskId: task.taskId,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(cwd, sessionBindingPath(cwd, sessionId), binding);
  appendTaskStateJournalEvent(cwd, {
    eventType: "session-bound",
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: String(sessionId),
    sessionName: binding.sessionName,
    data: {
      bindingUpdatedAt: binding.updatedAt
    }
  });
  return binding;
}

export function readSessionTaskBinding(cwd, sessionId) {
  if (!sessionId) return undefined;
  const binding = readJson(cwd, sessionBindingPath(cwd, sessionId));
  return binding?.sessionId === String(sessionId) && typeof binding.activeTaskRunId === "string" ? binding : undefined;
}

export function resolveTaskContract(cwd, reference, sessionId) {
  const ref = safeTaskId(reference);
  const binding = readSessionTaskBinding(cwd, sessionId);
  if (binding) {
    const active = readTaskRun(cwd, binding.activeTaskRunId);
    if (active && (!reference || active.taskRunId === ref || active.taskId === ref)) return active;
  }
  const tasks = listTaskContracts(cwd);
  const matches = tasks.filter((task) => task.taskRunId === ref || task.taskId === ref);
  return sessionId ? matches.find((task) => task.sessionId === String(sessionId)) : matches[0];
}

export function activeSessionTask(cwd, sessionId) {
  const binding = readSessionTaskBinding(cwd, sessionId);
  if (!binding) return undefined;
  const task = readTaskRun(cwd, binding.activeTaskRunId);
  return task?.sessionId === String(sessionId) ? task : undefined;
}

export function priorTaskAttempts(cwd, taskId) {
  return listTaskContracts(cwd).filter((task) => task.taskId === safeTaskId(taskId));
}

export function summarizeAttempt(task) {
  return {
    taskRunId: task.taskRunId,
    attempt: task.attempt,
    outcome: task.trace?.outcome ?? "pending",
    failedAt: task.failedAt,
    reason: task.trace?.friction ?? task.failureReason,
    ruledOut: task.ruledOut,
    recordedAt: task.trace?.recordedAt ?? task.updatedAt
  };
}

function gitOutput(cwd, args, options = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function gitHasHead(cwd) {
  try {
    gitOutput(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export function isGitWorkingTree(cwd) {
  try {
    return gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function normalizedGitPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function prefixedGitPath(prefix, file) {
  const normalized = normalizedGitPath(file);
  return prefix ? `${prefix}/${normalized}` : normalized;
}

function workingTreeFilesForGitRoot(cwd) {
  if (!isGitWorkingTree(cwd)) return [];
  const changed = gitHasHead(cwd)
    ? changedPathsFromNameStatus(gitOutput(cwd, ["diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACMRD", "HEAD", "--"]))
    : gitOutput(cwd, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const untracked = gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return [...new Set([...changed, ...untracked].map(normalizedGitPath).filter((item) => item && !item.startsWith(".pi/piagent-state/")))].sort();
}

function directChildGitEvidenceRoots(cwd) {
  const roots = [];
  let entries;
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.join(cwd, entry.name);
    try {
      if (fs.lstatSync(child).isSymbolicLink()) continue;
      if (!isGitWorkingTree(child)) continue;
      const topLevel = gitOutput(child, ["rev-parse", "--show-toplevel"]).trim();
      if (fs.realpathSync(topLevel) !== fs.realpathSync(child)) continue;
      roots.push({ cwd: child, prefix: normalizedGitPath(entry.name) });
    } catch {
      // Ignore unreadable or non-standard child folders; source-change start
      // only needs at least one reliable evidence root.
    }
  }
  return roots.sort((left, right) => left.prefix.localeCompare(right.prefix));
}

function gitEvidenceRoots(cwd) {
  if (isGitWorkingTree(cwd)) return [{ cwd, prefix: "" }];
  return directChildGitEvidenceRoots(cwd);
}

function nonGitWorkspaceFiles(cwd, gitRootPrefixes) {
  const files = [];
  const gitRoots = new Set(gitRootPrefixes.filter(Boolean));
  function orderedEntries(entries) {
    return [...entries].sort((left, right) => {
      const leftPriority = WORKSPACE_EVIDENCE_PRIORITY_NAMES.get(left.name.toLowerCase()) ?? 10;
      const rightPriority = WORKSPACE_EVIDENCE_PRIORITY_NAMES.get(right.name.toLowerCase()) ?? 10;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return left.name.localeCompare(right.name, "en-US");
    });
  }
  function visit(directory, relativeDirectory) {
    if (files.length >= WORKSPACE_EVIDENCE_MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of orderedEntries(entries)) {
      if (files.length >= WORKSPACE_EVIDENCE_MAX_FILES) return;
      if (WORKSPACE_EVIDENCE_SKIP_NAMES.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const topSegment = relative.split("/")[0];
      if (gitRoots.has(topSegment)) continue;
      const absolute = path.join(directory, entry.name);
      try {
        if (fs.lstatSync(absolute).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push(normalizedGitPath(relative));
      }
    }
  }
  visit(cwd, "");
  return files.sort();
}

function nonGitWorkspaceFileDigest(cwd, file) {
  return streamedWorkingTreeFileDigest(cwd, file, false);
}

function pathWithinNonGitWorkspaceEvidenceRoot(candidate, gitRootPrefixes) {
  const topSegment = candidate.split("/")[0];
  return Boolean(
    topSegment
    && !WORKSPACE_EVIDENCE_SKIP_NAMES.has(topSegment)
    && !topSegment.startsWith(".")
    && !gitRootPrefixes.includes(topSegment)
  );
}

export function hasGitEvidenceRoot(cwd) {
  return gitEvidenceRoots(cwd).length > 0;
}

export function usesNestedGitEvidenceRoots(cwd) {
  return !isGitWorkingTree(cwd) && directChildGitEvidenceRoots(cwd).length > 0;
}

export function pathWithinChangeEvidenceRoot(cwd, candidate) {
  const normalized = normalizedGitPath(candidate);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return false;
  const roots = gitEvidenceRoots(cwd);
  for (const root of roots) {
    if (!root.prefix) return true;
    if (normalized === root.prefix || normalized.startsWith(`${root.prefix}/`)) return true;
  }
  return roots.length > 0 && pathWithinNonGitWorkspaceEvidenceRoot(normalized, roots.map((root) => root.prefix));
}

export function pathWithinGitEvidenceRoot(cwd, candidate) {
  return pathWithinChangeEvidenceRoot(cwd, candidate);
}

export function workingTreeFiles(cwd) {
  try {
    const roots = gitEvidenceRoots(cwd);
    const files = [];
    for (const root of roots) {
      for (const file of workingTreeFilesForGitRoot(root.cwd)) {
        files.push(prefixedGitPath(root.prefix, file));
      }
    }
    if (!isGitWorkingTree(cwd) && roots.length > 0) {
      files.push(...nonGitWorkspaceFiles(cwd, roots.map((root) => root.prefix)));
    }
    return [...new Set(files)].sort();
  } catch {
    return [];
  }
}

export function repositoryFileManifest(cwd, maxFiles = 10_000) {
  const limit = Number.isInteger(maxFiles) ? Math.max(1, Math.min(50_000, maxFiles)) : 10_000;
  const files = [];
  try {
    for (const root of gitEvidenceRoots(cwd)) {
      const listed = gitOutput(root.cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean);
      for (const file of listed) {
        const candidate = prefixedGitPath(root.prefix, file);
        if (
          !candidate
          || candidate.startsWith(".pi/")
          || candidate.startsWith(".git/")
          || candidate.split("/").includes("node_modules")
          || /(?:^|\/)\.env(?:\.|$)/i.test(candidate)
          || /(?:^|\/)(?:auth|credentials?|secrets?|tokens?)\.json$/i.test(candidate)
        ) continue;
        files.push(candidate);
        if (files.length >= limit) return [...new Set(files)].sort();
      }
    }
  } catch {
    return [];
  }
  return [...new Set(files)].sort();
}

function changedPathsFromNameStatus(output) {
  const fields = String(output ?? "").split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const source = fields[index++];
    if (!source) break;
    files.push(source);
    if (/^[RC]/.test(status)) {
      const destination = fields[index++];
      if (destination) files.push(destination);
    }
  }
  return files;
}

const WORKING_TREE_STREAM_CHUNK_BYTES = 1024 * 1024;
function unavailableWorkingTreeDigest(file, reason, stat) {
  return unavailableWorkingTreeHash(crypto.createHash("sha256")
    .update(`${file}\0${reason}\0${stat?.mode ?? ""}\0${stat?.size ?? ""}\0${stat?.mtimeMs ?? ""}\0${stat?.ctimeMs ?? ""}`)
    .digest("hex"));
}

export function workingTreeSnapshotHasUnavailableEvidence(snapshot) {
  return Object.values(snapshot ?? {}).some((digest) => isUnavailableWorkingTreeDigest(digest));
}

function streamedWorkingTreeFileDigest(root, file, hasHead) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return unavailableWorkingTreeDigest(file, "outside-root");
  }

  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return versionWorkingTreeHash(crypto.createHash("sha256").update(`deleted\0${file}`).digest("hex"));
    }
    return unavailableWorkingTreeDigest(file, error?.code ?? "lstat-failed");
  }

  try {
    if (stat.isSymbolicLink()) {
      return versionWorkingTreeHash(crypto.createHash("sha256")
        .update(`symlink\0${stat.mode & 0o7777}\0${fs.readlinkSync(absolute)}`)
        .digest("hex"));
    }
    if (stat.isDirectory()) {
      const evidence = hasHead
        ? gitOutput(root, ["diff", "--no-ext-diff", "--submodule=short", "HEAD", "--", file], { maxBuffer: 4 * 1024 * 1024 })
        : `directory:${stat.mode & 0o7777}:${stat.mtimeMs}`;
      return versionWorkingTreeHash(crypto.createHash("sha256").update(`directory\0${evidence}`).digest("hex"));
    }
    if (!stat.isFile()) {
      return unavailableWorkingTreeDigest(file, "unsupported-file-type", stat);
    }

    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile()) {
        return unavailableWorkingTreeDigest(file, "changed-file-type", before);
      }
      const hash = crypto.createHash("sha256");
      hash.update(`file\0${before.mode & 0o7777}\0${before.size}\0`);
      const buffer = Buffer.allocUnsafe(WORKING_TREE_STREAM_CHUNK_BYTES);
      let position = 0;
      while (position < before.size) {
        const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (bytesRead <= 0) return unavailableWorkingTreeDigest(file, "short-read", before);
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = fs.fstatSync(descriptor);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        return unavailableWorkingTreeDigest(file, "changed-during-read", after);
      }
      return versionWorkingTreeHash(hash.digest("hex"));
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    return unavailableWorkingTreeDigest(file, error?.code ?? "read-failed", stat);
  }
}

export function workingTreeSnapshot(cwd) {
  const snapshot = {};
  const roots = gitEvidenceRoots(cwd);
  for (const root of roots) {
    const hasHead = gitHasHead(root.cwd);
    for (const file of workingTreeFilesForGitRoot(root.cwd)) {
      const snapshotPath = prefixedGitPath(root.prefix, file);
      snapshot[snapshotPath] = streamedWorkingTreeFileDigest(root.cwd, file, hasHead);
    }
  }
  if (!isGitWorkingTree(cwd) && roots.length > 0) {
    for (const file of nonGitWorkspaceFiles(cwd, roots.map((root) => root.prefix))) {
      snapshot[file] = nonGitWorkspaceFileDigest(cwd, file);
    }
  }
  return snapshot;
}

export function taskStateMigrationStatus(cwd) {
  let root;
  try {
    root = resolveLocalStatePath(cwd, tasksRoot(cwd), { label: "Task state directory" });
    if (fs.existsSync(root)) resolveLocalStatePath(cwd, tasksRoot(cwd), { label: "Task state directory", kind: "directory" });
  } catch (error) {
    return { legacy: 0, current: 0, unreadable: [error instanceof Error ? error.message : String(error)] };
  }
  if (!fs.existsSync(root)) return { legacy: 0, current: 0, unreadable: [] };
  let legacy = 0;
  let current = 0;
  const unreadable = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = readJson(cwd, path.join(root, entry.name));
    if (!raw) {
      unreadable.push(entry.name);
      continue;
    }
    if (raw.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION && typeof raw.taskRunId === "string") {
      if (safeTaskId(raw.taskRunId) !== entry.name.slice(0, -5)) unreadable.push(entry.name);
      else if (taskNeedsDigestMigration(raw)) legacy += 1;
      else if (taskContractValidationErrors(raw).length > 0) unreadable.push(entry.name);
      else current += 1;
    } else {
      const migrated = normalizeTaskContract(raw, { sourceName: entry.name.slice(0, -5) });
      if (!migrated || taskContractValidationErrors(migrated).length > 0) unreadable.push(entry.name);
      else legacy += 1;
    }
  }
  return { legacy, current, unreadable };
}

export function migrateTaskState(cwd, options = {}) {
  let root;
  try {
    root = resolveLocalStatePath(cwd, tasksRoot(cwd), { label: "Task state directory" });
    if (fs.existsSync(root)) resolveLocalStatePath(cwd, tasksRoot(cwd), { label: "Task state directory", kind: "directory" });
  } catch (error) {
    return { migrated: 0, current: 0, warnings: [error instanceof Error ? error.message : String(error)] };
  }
  if (!fs.existsSync(root)) return { migrated: 0, current: 0, warnings: [] };
  const archiveRoot = path.join(root, "legacy-v1");
  let migrated = 0;
  let current = 0;
  const warnings = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const source = path.join(root, entry.name);
    const raw = readJson(cwd, source);
    if (!raw) {
      warnings.push(`unreadable task state: ${entry.name}`);
      continue;
    }
    if (raw.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION && typeof raw.taskRunId === "string") {
      if (taskNeedsDigestMigration(raw)) {
        try {
          migrateUnversionedTaskDigestState(cwd, source, raw, {
            validateTask: taskContractValidationErrors,
            normalizeTask: normalizeTaskContract,
            workingTreeSnapshot,
            snapshotHasUnavailable: workingTreeSnapshotHasUnavailableEvidence,
            isGitWorkingTree, activeTaskRunId: options.taskRunId, activeSessionId: options.sessionId,
            writeAtomic: writeJsonAtomic,
            appendBarrier: appendTaskJournalEvent,
            findBarrier: (root, taskRunId, archiveDigest) => ((journal) => { if (journal.corruptions.length) throw new Error("task journal is corrupt during digest migration"); return journal.events.findLast((event) => event.eventType === "digest-migrated" && event.data?.archiveDigest === archiveDigest); })(readTaskJournal(root, { taskRunId }))
          });
          migrated += 1;
        } catch (error) {
          warnings.push(`digest migration blocked: ${entry.name} (${error instanceof Error ? error.message : String(error)})`);
        }
        continue;
      }
      const errors = taskContractValidationErrors(raw);
      const sourceName = entry.name.slice(0, -5);
      if (safeTaskId(raw.taskRunId) !== sourceName) errors.push("taskRunId does not match filename");
      if (errors.length > 0) warnings.push(`invalid task state: ${entry.name} (${errors.join("; ")})`);
      else current += 1;
      continue;
    }
    const sourceTaskId = safeTaskId(raw.taskId ?? entry.name.slice(0, -5));
    const belongsToCurrentSession = options.taskId && safeTaskId(options.taskId) === sourceTaskId;
    const sourceBytes = fs.readFileSync(source);
    const task = normalizeTaskContract(raw, {
      sourceName: entry.name.slice(0, -5),
      sessionId: belongsToCurrentSession ? options.sessionId : undefined,
      sessionName: belongsToCurrentSession ? options.sessionName : undefined,
      archiveDigest: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
      archiveBytes: sourceBytes.length
    });
    if (!task) continue;
    const safeArchiveRoot = ensurePrivateStateDirectory(cwd, archiveRoot, "Task state archive");
    const archiveTarget = resolveLocalStatePath(cwd, path.join(safeArchiveRoot, entry.name), { label: "Task state archive file" });
    if (fs.existsSync(archiveTarget)) {
      const archived = fs.readFileSync(archiveTarget);
      const legacy = fs.readFileSync(source);
      if (!archived.equals(legacy)) {
        warnings.push(`legacy task archive conflict: ${entry.name}`);
        continue;
      }
    } else {
      fs.copyFileSync(source, archiveTarget, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(archiveTarget, 0o600);
    }
    const currentTarget = taskRunPath(cwd, task.taskRunId);
    commitLegacySchemaTaskDigestState(cwd, source, currentTarget, task, sourceBytes, {
      writeAtomic: writeJsonAtomic, appendBarrier: appendTaskJournalEvent,
      findBarrier: (root, taskRunId, archiveDigest) => ((journal) => { if (journal.corruptions.length) throw new Error("task journal is corrupt during digest migration"); return journal.events.findLast((event) => event.eventType === "digest-migrated" && event.data?.archiveDigest === archiveDigest); })(readTaskJournal(root, { taskRunId }))
    });
    if (fs.realpathSync(source) !== fs.realpathSync(currentTarget)) fs.rmSync(source);
    migrated += 1;
  }
  return { migrated, current, warnings };
}

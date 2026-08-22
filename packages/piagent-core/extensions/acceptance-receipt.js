import crypto from "node:crypto";
import path from "node:path";
import { changedFileAcceptanceCorpus, emptyAcceptanceCorpus, isAcceptanceTestPath } from "./acceptance-language-adapters.js";
import { durableContextEvidenceEntries, hasDurableContextEvidence } from "./context-evidence.js";
import { matchesAnyPath, normalizePathCandidate } from "./policy-core.js";
import { baselineReturnRepresentationConflicts, returnRepresentationGuidance } from "./return-contract.js";
import { hasLengthPrefixedIdentityKey, tenantAssertionSignals } from "./tenant-contract.js";
import { latestObservedVerificationEvidence, meaningfulVerificationCommands, verificationEvidenceProvesStableTree } from "./verification-intelligence.js";
import {
  acceptanceContractProofGuidance,
  acceptanceContractSemanticConflicts,
  acceptanceInvalidInputEvidence
} from "./acceptance-contract-semantics.js";
import { isCurrentWorkingTreeDigest, WORKING_TREE_DIGEST_ALGORITHM } from "./working-tree-digest.js";

export const ACCEPTANCE_RECEIPT_SCHEMA_VERSION = 1;
export const ACCEPTANCE_STATUSES = new Set(["pending", "satisfied", "blocked"]);
export const ACCEPTANCE_PRIORITIES = new Set(["normal", "critical"]);

const CRITICAL_OBLIGATIONS = new Set([
  "authorization-deny-case",
  "tenant-boundary",
  "tenant-storage-isolation",
  "invalid-input-rejection",
  "boundary-case",
  "read-only-evidence"
]);

const MAX_CRITERIA = 12;
const MAX_EVIDENCE_PER_CRITERION = 8;
const RECEIPT_FIELDS = new Set(["schemaVersion", "source", "promptHash", "generatedAt", "criteria", "provenance", "helperUsage"]);
const CRITERION_FIELDS = new Set(["id", "hash", "obligation", "priority", "status", "evidence", "updatedAt"]);
const EVIDENCE_FIELDS = new Set(["kind", "summary", "paths", "command", "exitCode", "workingTreeDigest", "recordedAt"]);
const PROVENANCE_FIELDS = new Set(["assurance", "disposition", "repairCount", "retryCount", "finalRecoveryDisposition", "failureRef", "recoveryRef", "handoffRef", "recordedAt"]);
const FAILURE_REF_FIELDS = new Set(["evidenceDigest", "category", "captureRef"]);
const RECOVERY_REF_FIELDS = new Set(["policyVersion", "action", "reasonCodes"]);
const HELPER_USAGE_FIELDS = new Set(["mode", "used", "reasonCodes", "helpers", "recordedAt"]);
const HELPER_ENTRY_FIELDS = new Set(["role", "disposition", "requestRef", "outputDigest", "calls", "tokens"]);
const HELPER_ROLES = new Set(["retriever", "scout", "planner", "worker", "reviewer", "oracle", "researcher"]);
const RECEIPT_DISPOSITIONS = new Set(["first-pass-success", "repaired-success", "blocked", "partial", "failed", "pending"]);
const FINAL_RECOVERY_DISPOSITIONS = new Set(["not-needed", "succeeded", "blocked", "partial", "failed", "pending"]);
const RECOVERY_ACTIONS = new Set(["repair", "retry", "fresh-session", "ask-operator", "handoff", "blocked"]);
const FAILURE_CATEGORIES = new Set(["passed", "compile-typecheck", "test-assertion", "lint-format", "dependency-config", "environment", "provider-network", "permission-policy", "scope-protected-path", "flaky-infrastructure", "unknown"]);
const HASH = /^[a-f0-9]{64}$/;
const SAFE_REF = /^[a-z0-9.][a-z0-9:._/-]{0,511}$/i;
const READ_ONLY_BOUNDARY = /\b(?:read-only|no edits?|do not edit(?: files?| source| project| repo)?|do not change (?:files?|source|project|repo)|do not mutate (?:files?|source|project|repo|workspace)|khong sua(?: file| source| project)?|khong edit(?: file| source| project)?|khong doi(?: file| source| project)?)\b/;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function compactId(value, fallback = "criterion") {
  return String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUnsupportedField(value, allowed) {
  return isRecord(value) && Object.keys(value).some((key) => !allowed.has(key));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function pathBoundaryMentioned(text, patterns) {
  const value = normalizedText(text);
  return uniqueStrings(patterns).some((pattern) => {
    const normalized = normalizePathCandidate(pattern).replace(/\/?\*\*.*$/, "").replace(/\*+/g, "").replace(/\/+$/, "");
    if (!normalized) return false;
    const lower = normalized.toLowerCase();
    const basename = lower.split("/").filter(Boolean).at(-1);
    return value.includes(lower) || (Boolean(basename) && value.includes(basename));
  });
}

function changedFilesRespectBoundaries(changedFiles, boundaryPatterns) {
  const patterns = uniqueStrings(boundaryPatterns);
  if (patterns.length === 0) return true;
  return uniqueStrings(changedFiles).every((file) => !matchesAnyPath(file, patterns));
}

export function inferAcceptanceObligations(text, changeMode = "source-change") {
  const value = normalizedText(text);
  const accessControlText = value
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\b(?:[a-z0-9_.@-]+\/)+[a-z0-9_.@/-]+\b/g, " ");
  const obligations = [];
  if (changeMode === "read-only" || READ_ONLY_BOUNDARY.test(value)) {
    obligations.push("read-only-evidence");
  }
  const actorAccessControl = includesAny(accessControlText, [
    /\b(?:admins?|roles?|owners?|users?|callers?|resources?)\b[\s\S]{0,80}\b(?:access|allow(?:ed)?|deny|denied|block(?:ed)?|forbid(?:den)?|manag(?:e|es|ed|ing))\b/,
    /\b(?:access|allow(?:ed)?|deny|denied|block(?:ed)?|forbid(?:den)?|manag(?:e|es|ed|ing))\b[\s\S]{0,80}\b(?:admins?|roles?|owners?|users?|callers?|resources?)\b/
  ]);
  const explicitAuthorization = includesAny(accessControlText, [
    /\bauth(?:orization)?\b/, /\bunauthoriz(?:ed|ation)\b/, /\bpermission\b/
  ]) || actorAccessControl;
  const ownerAccessControl = /\bowner\b/.test(accessControlText) && includesAny(accessControlText, [
    /\busers?\b/, /\bresources?\b/, /\baccess\b/, /\bmanag(?:e|es|ed|ing)\b/, /\bauth(?:orization)?\b/, /\bpermission\b/, /\broles?\b/
  ]);
  if (explicitAuthorization || ownerAccessControl) {
    obligations.push("authorization-deny-case");
  }
  const tenantMentioned = includesAny(value, [/\btenants?\b/, /\bcross[- ]tenant\b/, /\bsame[- ]tenant\b/, /\btenantid\b/]);
  const tenantStorage = tenantMentioned && includesAny(value, [
    /\bcache\b/, /\bcache[- ]?key\b/, /\bstorage\b/, /\bcollision\b/, /\bentity\b/, /\bsame tuple\b/
  ]);
  const strongAuthorization = includesAny(accessControlText, [
    /\bauth(?:orization)?\b/, /\bunauthoriz(?:ed|ation)\b/, /\bpermission\b/
  ]);
  const tenantActorAccess = tenantMentioned && actorAccessControl;
  const explicitTenantAccessBoundary = includesAny(value, [
    /\bcross[- ]tenant\b/, /\bsame[- ]tenant\b/, /\btenant boundary\b/,
    /\btenantid\b[\s\S]{0,100}\b(?:equal|match|same non-empty|access|allow|deny|block|forbid)/,
    /\b(?:access|allow|deny|block|forbid)[\s\S]{0,100}\btenantid\b/
  ]) && includesAny(value, [
    /\baccess\b/, /\ballow(?:ed)?\b/, /\b(?:deny|denied)\b/, /\bblock(?:ed)?\b/, /\bforbid(?:den)?\b/,
    /\bequal\b/, /\bmatch(?:es|ed|ing)?\b/, /\bsame non-empty\b/
  ]);
  if (tenantMentioned) {
    if (tenantStorage) {
      obligations.push("tenant-storage-isolation");
    } else if (strongAuthorization || ownerAccessControl || tenantActorAccess || explicitTenantAccessBoundary) {
      obligations.push("tenant-boundary");
    }
  }
  const explicitInvalidInput = includesAny(value, [/\binvalid\b/, /\btypeerror\b/, /\bthrow\b/, /\bnon-negative\b/, /\bpositive integer\b/, /\binteger\b/]);
  const rejectInvalidInput = /\breject(?:s|ed|ion)?\b/.test(value)
    && !/\breject(?:s|ed|ion)?\s+(?:no\s+)?valid\b/.test(value)
    && includesAny(value, [/\binvalid\b/, /\bbad\b/, /\bmalformed\b/, /\bnegative\b/, /\bnull\b/, /\bundefined\b/, /\bnon[- ]?(?:number|numeric)\b/, /\bout[- ]?of[- ]?range\b/]);
  if (explicitInvalidInput || rejectInvalidInput) {
    obligations.push("invalid-input-rejection");
  }
  if (includesAny(value, [/\bboundary\b/, /\bceil(?:ing)?\b/, /\bclamp\b/, /\bmin(?:imum)?\b/, /\bmax(?:imum)?\b/, /\binclusive\b/, /\bzero\b/, /\b0\b/, /\bexpiry\b/, /\bround(?:ing)?\b/, /\bedge\b/, /\bfalsey\b/, /\bfalsy\b/, /\bnullish\b/, /\bdefault(?:s)?\b/, /\bpreserv(?:e|ed|es|ing)\b/])) {
    obligations.push("boundary-case");
  }
  if (includesAny(value, [/\bmutation\b/, /\bunchanged\b/, /\bwithout changing\b/, /\bbackward\b/, /\bapi\b/, /\bexported api\b/, /\bfocused\b/])) {
    obligations.push("backward-compatibility");
  }
  if (changeMode === "source-change") obligations.push("verification-evidence");
  return [...new Set(obligations)];
}

function generatedCriterionForObligation(obligation) {
  switch (obligation) {
    case "authorization-deny-case":
      return "Focused tests prove every requested allow path and the unauthorized, inactive, missing-input, and wrong-permission denial paths.";
    case "tenant-boundary":
      return "Focused tests prove same-identity allow, cross-identity deny, and empty or missing isolation identity denial without assuming a particular function or field name.";
    case "tenant-storage-isolation":
      return "Focused tests prove tenant-scoped storage round trips the same identity tuple, keeps distinct identity components isolated, and prevents delimiter-like values from colliding when composite keys are required.";
    case "invalid-input-rejection":
      return "Focused executable tests prove every named entrypoint rejects each stated invalid input partition, including every constrained argument and the requested error class.";
    case "boundary-case":
      return "Focused executable tests cover every stated equivalence class, including applicable undefined, null, false, zero, empty-string, minimum, maximum, inclusive, rounding, ceiling, and clamp boundaries.";
    case "backward-compatibility":
      return "Existing API and unrelated behavior remain compatible outside the requested change.";
    case "read-only-evidence":
      return "The task stays read-only and the answer is grounded in observed in-scope evidence.";
    case "verification-evidence":
      return "The configured verifier passes against the final working tree.";
    default:
      return "The requested behavior is satisfied by current source and verification evidence.";
  }
}

const GENERATED_ACCEPTANCE_TEXTS = new Set([
  "authorization-deny-case", "tenant-boundary", "tenant-storage-isolation", "invalid-input-rejection", "boundary-case",
  "backward-compatibility", "read-only-evidence", "verification-evidence"
].map((obligation) => generatedCriterionForObligation(obligation)));

function acceptanceTaskText(task) {
  return [
    task?.summary,
    task?.expectedOutput,
    ...(Array.isArray(task?.acceptanceCriteria)
      ? task.acceptanceCriteria.filter((criterion) => !GENERATED_ACCEPTANCE_TEXTS.has(criterion))
      : [])
  ].filter(Boolean).join("\n");
}

function acceptanceCriterionText(task, criterion) {
  const matched = (Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [])
    .find((text) => typeof text === "string" && sha256(text) === criterion?.hash);
  return matched && !GENERATED_ACCEPTANCE_TEXTS.has(matched)
    ? matched
    : acceptanceTaskText(task);
}

/**
 * Produce bounded, task-derived proof guidance without a second model call.
 * These hints remain generic: they describe semantic partitions from the
 * operator request and never reference benchmark scenario identities.
 */
export function acceptanceProofGuidance(taskOrText) {
  const raw = typeof taskOrText === "string" ? taskOrText : acceptanceTaskText(taskOrText);
  return acceptanceContractProofGuidance(raw);
}

function semanticConflictReasons(obligation, task, corpus, criterion) {
  const taskText = acceptanceCriterionText(task, criterion);
  return acceptanceContractSemanticConflicts(obligation, taskText, corpus.sourceText);
}

/**
 * Surface a concrete existing return contract before implementation starts.
 * This is intentionally source-derived and bounded to exact in-scope files;
 * it does not guess from benchmark scenario names or hidden expectations.
 */
export function acceptanceBaselineGuidance(task, options = {}) {
  if (!options.cwd) return [];
  const files = uniqueStrings([
    ...(Array.isArray(task?.scope) ? task.scope : []),
    ...(Array.isArray(task?.changedFiles) ? task.changedFiles : []),
    ...(Array.isArray(task?.observedChangedFiles) ? task.observedChangedFiles : [])
  ]).filter((file) => !/[?*\[\]{}]/.test(file) && !isAcceptanceTestPath(file));
  return returnRepresentationGuidance(acceptanceTaskText(task), options.cwd, files);
}

export function acceptanceSemanticConflicts(task, options = {}) {
  const changedFiles = uniqueStrings(options.changedFiles ?? task?.changedFiles ?? task?.observedChangedFiles ?? []);
  const corpus = options.cwd
    ? changedFileAcceptanceCorpus(options.cwd, changedFiles)
    : { ...emptyAcceptanceCorpus(changedFiles.length > 0 ? changedFiles : ["inline.js"]), sourceText: normalizedText(options.sourceText), allText: normalizedText(options.sourceText) };
  if (!corpus.adapter.proofCapable) return [];
  const obligations = task?.acceptanceReceipt?.criteria?.map((criterion) => criterion.obligation)
    ?? inferAcceptanceObligations(acceptanceTaskText(task), task?.changeMode);
  return uniqueStrings([
    ...obligations.flatMap((obligation) => semanticConflictReasons(obligation, task, corpus)),
    ...(options.cwd ? baselineReturnRepresentationConflicts(acceptanceTaskText(task), options.cwd, corpus.sourceFiles) : [])
  ]);
}

function criterionId(text, obligation, index) {
  const prefix = compactId(obligation ?? "criterion").slice(0, 24);
  return `ac-${String(index + 1).padStart(2, "0")}-${prefix}-${sha256(text).slice(0, 8)}`.slice(0, 80);
}

export function buildAcceptanceReceipt(input = {}) {
  const changeMode = input.changeMode === "read-only" ? "read-only" : "source-change";
  const baseText = [
    input.summary,
    input.expectedOutput,
    ...(Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [])
  ].filter(Boolean).join("\n");
  const obligations = inferAcceptanceObligations(baseText, changeMode);
  const texts = uniqueStrings(Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []);
  const generatedObligations = new Map();
  for (const obligation of obligations) {
    const generated = generatedCriterionForObligation(obligation);
    if (!texts.some((text) => inferAcceptanceObligations(text, changeMode).includes(obligation))) {
      texts.push(generated);
      generatedObligations.set(generated, obligation);
    }
  }
  if (texts.length === 0) {
    texts.push(changeMode === "read-only"
      ? generatedCriterionForObligation("read-only-evidence")
      : generatedCriterionForObligation("verification-evidence"));
  }
  const acceptanceCriteria = texts.slice(0, MAX_CRITERIA);
  const criteria = acceptanceCriteria.map((text, index) => {
    const inferred = inferAcceptanceObligations(text, changeMode);
    const obligation = generatedObligations.get(text)
      ?? inferred.find((item) => item !== "verification-evidence" && item !== "backward-compatibility")
      ?? inferred[0]
      ?? "requested-behavior";
    return {
      id: criterionId(text, obligation, index),
      hash: sha256(text),
      obligation,
      priority: CRITICAL_OBLIGATIONS.has(obligation) ? "critical" : "normal",
      status: "pending",
      evidence: []
    };
  });
  return {
    acceptanceCriteria,
    receipt: {
      schemaVersion: ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
      source: input.source === "runtime" ? "runtime" : "model",
      promptHash: sha256(baseText),
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      criteria
    }
  };
}

export function normalizeAcceptanceReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const criteria = Array.isArray(value.criteria) ? value.criteria.slice(0, MAX_CRITERIA).map((criterion, index) => {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) return undefined;
    const id = typeof criterion.id === "string" && criterion.id.trim()
      ? compactId(criterion.id)
      : `ac-${String(index + 1).padStart(2, "0")}-${sha256(criterion.hash ?? index).slice(0, 8)}`;
    const hash = typeof criterion.hash === "string" && /^[a-f0-9]{64}$/.test(criterion.hash)
      ? criterion.hash
      : sha256(id);
    const obligation = typeof criterion.obligation === "string" && criterion.obligation.trim()
      ? compactId(criterion.obligation)
      : "requested-behavior";
    const priority = ACCEPTANCE_PRIORITIES.has(criterion.priority) ? criterion.priority : CRITICAL_OBLIGATIONS.has(obligation) ? "critical" : "normal";
    const status = ACCEPTANCE_STATUSES.has(criterion.status) ? criterion.status : "pending";
    const evidence = Array.isArray(criterion.evidence)
      ? criterion.evidence.slice(-MAX_EVIDENCE_PER_CRITERION).map((item) => normalizeAcceptanceEvidence(item)).filter(Boolean)
      : [];
    return {
      id,
      hash,
      obligation,
      priority,
      status,
      evidence,
      updatedAt: typeof criterion.updatedAt === "string" && Number.isFinite(Date.parse(criterion.updatedAt)) ? criterion.updatedAt : undefined
    };
  }).filter(Boolean) : [];
  if (criteria.length === 0) return undefined;
  return {
    schemaVersion: ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
    source: value.source === "runtime" ? "runtime" : "model",
    promptHash: typeof value.promptHash === "string" && /^[a-f0-9]{64}$/.test(value.promptHash) ? value.promptHash : undefined,
    generatedAt: typeof value.generatedAt === "string" && Number.isFinite(Date.parse(value.generatedAt)) ? value.generatedAt : undefined,
    provenance: normalizeAcceptanceProvenance(value.provenance),
    helperUsage: normalizeHelperUsage(value.helperUsage),
    criteria
  };
}

function normalizeHelperUsage(value) {
  if (!isRecord(value) || !["off", "recommend", "on"].includes(value.mode)) return undefined;
  const helpers = Array.isArray(value.helpers) ? value.helpers.slice(0, 3).filter(isRecord).map((item) => ({
    role: HELPER_ROLES.has(item.role) ? item.role : "scout",
    disposition: compactId(item.disposition ?? "unknown"),
    requestRef: HASH.test(String(item.requestRef)) ? item.requestRef : sha256(item.requestRef),
    outputDigest: item.outputDigest === null || HASH.test(String(item.outputDigest)) ? item.outputDigest : null,
    calls: Number.isInteger(item.calls) ? Math.max(0, Math.min(100, item.calls)) : 0,
    tokens: Number.isInteger(item.tokens) ? Math.max(0, Math.min(100_000_000, item.tokens)) : 0
  })) : [];
  return { mode: value.mode, used: helpers.some((item) => !["solo", "recommend", "unavailable", "blocked"].includes(item.disposition)), reasonCodes: uniqueStrings(value.reasonCodes).map(compactId).slice(0, 16), helpers, recordedAt: validTimestamp(value.recordedAt) ? value.recordedAt : new Date().toISOString() };
}

export function applyAcceptanceHelperUsage(task, input = {}) {
  const receipt = normalizeAcceptanceReceipt(task?.acceptanceReceipt); if (!receipt) return task;
  const helperUsage = normalizeHelperUsage({ mode: input.mode ?? "off", reasonCodes: input.reasonCodes ?? [], helpers: input.helpers ?? [], recordedAt: input.recordedAt ?? new Date().toISOString() });
  return { ...task, acceptanceReceipt: { ...receipt, criteria: structuredClone(task.acceptanceReceipt.criteria), helperUsage } };
}

function normalizeAcceptanceProvenance(value) {
  if (!isRecord(value)) return undefined;
  const failureRef = isRecord(value.failureRef) && HASH.test(String(value.failureRef.evidenceDigest)) && FAILURE_CATEGORIES.has(value.failureRef.category)
    ? {
        evidenceDigest: value.failureRef.evidenceDigest,
        category: value.failureRef.category,
        captureRef: typeof value.failureRef.captureRef === "string" && SAFE_REF.test(value.failureRef.captureRef) ? value.failureRef.captureRef : null
      }
    : null;
  const recoveryRef = isRecord(value.recoveryRef) && value.recoveryRef.policyVersion === "recovery-v1" && RECOVERY_ACTIONS.has(value.recoveryRef.action)
    ? {
        policyVersion: "recovery-v1",
        action: value.recoveryRef.action,
        reasonCodes: uniqueStrings(value.recoveryRef.reasonCodes).map((item) => compactId(item)).slice(0, 16)
      }
    : null;
  if (value.assurance !== "runtime-observed" || !RECEIPT_DISPOSITIONS.has(value.disposition)) return undefined;
  return {
    assurance: "runtime-observed",
    disposition: value.disposition,
    repairCount: Number.isInteger(value.repairCount) ? Math.max(0, Math.min(10, value.repairCount)) : 0,
    retryCount: Number.isInteger(value.retryCount) ? Math.max(0, Math.min(10, value.retryCount)) : 0,
    finalRecoveryDisposition: FINAL_RECOVERY_DISPOSITIONS.has(value.finalRecoveryDisposition) ? value.finalRecoveryDisposition : "pending",
    failureRef,
    recoveryRef,
    handoffRef: typeof value.handoffRef === "string" && SAFE_REF.test(value.handoffRef) && !path.isAbsolute(value.handoffRef) && !value.handoffRef.split(/[\\/]/).includes("..") ? value.handoffRef : null,
    recordedAt: validTimestamp(value.recordedAt) ? value.recordedAt : new Date().toISOString()
  };
}

function recoveryDisposition(taskOutcome, gateDecision, repairCount, retryCount) {
  if (taskOutcome === "completed" && gateDecision === "pass") {
    return repairCount + retryCount > 0 ? "repaired-success" : "first-pass-success";
  }
  if (taskOutcome === "blocked" || (taskOutcome === "completed" && gateDecision === "fail")) return "blocked";
  if (taskOutcome === "partial") return "partial";
  if (taskOutcome === "failed") return "failed";
  return "pending";
}

/** Add bounded operational provenance without changing any acceptance criterion or status. */
export function applyAcceptanceRecoveryProvenance(task, input = {}) {
  const receipt = normalizeAcceptanceReceipt(task?.acceptanceReceipt);
  if (!receipt) return task;
  const unchangedCriteria = Array.isArray(task?.acceptanceReceipt?.criteria)
    ? structuredClone(task.acceptanceReceipt.criteria)
    : receipt.criteria;
  const history = Array.isArray(input.recoveryHistory) ? input.recoveryHistory.filter((entry) => isRecord(entry)) : [];
  const counted = history.filter((entry) => ["scheduled", "failed", "succeeded"].includes(entry.disposition));
  const historyRepairCount = counted.filter((entry) => entry.action === "repair").length;
  const retryCount = Math.min(10, counted.filter((entry) => entry.action === "retry").length);
  const trajectoryRepairs = Array.isArray(input.trajectoryTransitions)
    ? new Set(input.trajectoryTransitions.filter((entry) => (
        isRecord(entry)
        && entry.to === "repair"
        && ["verification-failed", "recovery-requested"].includes(entry.cause)
        && typeof entry.eventId === "string"
      )).map((entry) => entry.eventId)).size
    : 0;
  const semanticSupplied = Object.prototype.hasOwnProperty.call(input, "semanticRepair");
  const semantic = isRecord(input.semanticRepair) ? input.semanticRepair : undefined;
  const semanticValid = semantic?.enforcementSafe === true
    && Number.isInteger(semantic.repairCount) && semantic.repairCount >= 0 && semantic.repairCount <= 10
    && Number.isInteger(semantic.retryCount) && semantic.retryCount >= 0 && semantic.retryCount <= 10
    && typeof semantic.passed === "boolean";
  const semanticCanComplete = semanticValid && (semantic.repairCount + semantic.retryCount === 0 || semantic.passed === true);
  const repairCount = Math.min(10, Math.max(historyRepairCount, trajectoryRepairs, semanticValid ? semantic.repairCount : 0));
  const effectiveRetryCount = Math.min(10, Math.max(retryCount, semanticValid ? semantic.retryCount : 0));
  const latestHistory = counted.at(-1);
  const classification = isRecord(input.failureClassification) ? input.failureClassification : undefined;
  const decision = isRecord(input.recoveryDecision) ? input.recoveryDecision : undefined;
  const evidenceDigest = classification?.evidenceDigest ?? latestHistory?.evidenceDigest;
  const category = classification?.category ?? latestHistory?.failureCategory;
  const failureRef = HASH.test(String(evidenceDigest)) && FAILURE_CATEGORIES.has(category)
    ? {
        evidenceDigest,
        category,
        captureRef: typeof classification?.outputRef?.captureRef === "string" && SAFE_REF.test(classification.outputRef.captureRef)
          ? classification.outputRef.captureRef
          : null
      }
    : null;
  const recoveryAction = decision?.action ?? latestHistory?.action ?? (trajectoryRepairs > 0 || (semanticValid && semantic.repairCount > 0) ? "repair" : undefined);
  const recoveryRef = RECOVERY_ACTIONS.has(recoveryAction)
    ? {
        policyVersion: "recovery-v1",
        action: recoveryAction,
        reasonCodes: uniqueStrings(decision?.reasonCodes ?? (trajectoryRepairs > 0
          ? ["durable-trajectory-repair"]
          : semanticValid && semantic.repairCount > 0 ? ["validated-semantic-repair-origin"] : [])).map((item) => compactId(item)).slice(0, 16)
      }
    : null;
  const requestedOutcome = ["completed", "blocked", "partial", "failed"].includes(input.outcome) ? input.outcome : task.trace?.outcome ?? "pending";
  const taskOutcome = semanticSupplied && !semanticCanComplete && requestedOutcome === "completed" ? "blocked" : requestedOutcome;
  const disposition = recoveryDisposition(taskOutcome, input.gateDecision === "fail" ? "fail" : "pass", repairCount, effectiveRetryCount);
  const finalRecoveryDisposition = disposition === "first-pass-success" ? "not-needed"
    : disposition === "repaired-success" ? "succeeded"
    : disposition;
  const handoffRef = typeof input.handoffRef === "string" && SAFE_REF.test(input.handoffRef) && !path.isAbsolute(input.handoffRef) && !input.handoffRef.split(/[\\/]/).includes("..")
    ? input.handoffRef
    : null;
  return {
    ...task,
    acceptanceReceipt: {
      ...receipt,
      criteria: unchangedCriteria,
      provenance: {
        assurance: "runtime-observed",
        disposition,
        repairCount,
        retryCount: effectiveRetryCount,
        finalRecoveryDisposition,
        failureRef,
        recoveryRef,
        handoffRef,
        recordedAt: input.recordedAt ?? new Date().toISOString()
      }
    }
  };
}

/**
 * A successful project mutation makes every source-change criterion from the
 * previous tree unproven. Verification history stays on the Task Contract;
 * criterion truth fails closed until rebuilt against the new tree.
 */
export function invalidateAcceptanceReceiptAfterMutation(task, recordedAt = new Date().toISOString()) {
  if (task?.changeMode !== "source-change") return { task, changed: false };
  const receipt = normalizeAcceptanceReceipt(task?.acceptanceReceipt);
  if (!receipt) return { task, changed: false };
  let changed = false;
  for (const criterion of receipt.criteria) {
    if (criterion.status !== "pending" || criterion.evidence.length > 0) {
      criterion.status = "pending";
      criterion.evidence = [];
      criterion.updatedAt = recordedAt;
      changed = true;
    }
  }
  return { task: { ...task, acceptanceReceipt: receipt }, changed };
}

function normalizeAcceptanceEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kind = typeof value.kind === "string" && value.kind.trim() ? compactId(value.kind) : "evidence";
  const summary = typeof value.summary === "string" && value.summary.trim() ? value.summary.trim().slice(0, 240) : kind;
  return {
    kind,
    summary,
    paths: uniqueStrings(value.paths).slice(0, 12),
    command: typeof value.command === "string" && value.command.trim() ? value.command.trim().slice(0, 300) : undefined,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : undefined,
    workingTreeDigest: isCurrentWorkingTreeDigest(value.workingTreeDigest) ? value.workingTreeDigest : undefined,
    recordedAt: typeof value.recordedAt === "string" && Number.isFinite(Date.parse(value.recordedAt)) ? value.recordedAt : undefined
  };
}

function evidenceKey(evidence) {
  return JSON.stringify({
    kind: evidence.kind,
    summary: evidence.summary,
    paths: evidence.paths ?? [],
    command: evidence.command,
    exitCode: evidence.exitCode,
    workingTreeDigest: evidence.workingTreeDigest
  });
}

function addEvidence(criterion, evidence, recordedAt) {
  const normalized = normalizeAcceptanceEvidence({ ...evidence, recordedAt });
  if (!normalized) return false;
  const seen = new Set((criterion.evidence ?? []).map(evidenceKey));
  if (seen.has(evidenceKey(normalized))) return false;
  criterion.evidence = [...(criterion.evidence ?? []), normalized].slice(-MAX_EVIDENCE_PER_CRITERION);
  criterion.status = "satisfied";
  criterion.updatedAt = recordedAt;
  return true;
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declaredCallableNames(sourceText) {
  const names = new Set();
  const ignored = new Set(["catch", "for", "if", "switch", "while", "with"]);
  for (const match of String(sourceText ?? "").matchAll(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) names.add(match[1].toLowerCase());
  for (const match of String(sourceText ?? "").matchAll(/^\s*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/gm)) {
    if (!ignored.has(match[1].toLowerCase())) names.add(match[1].toLowerCase());
  }
  for (const match of String(sourceText ?? "").matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)) names.add(match[1].toLowerCase());
  return names;
}

function contractCallableTargets(task, criterion, sourceText = "") {
  const ignored = new Set(["api", "boolean", "date", "error", "false", "null", "string", "true", "typeerror", "undefined"]);
  const explicit = [];
  const text = acceptanceCriterionText(task, criterion);
  let previousEnd = 0;
  let roleGroup = false;
  for (const match of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^`]*\)`/g)) {
    if (!ignored.has(match[1].toLowerCase())) {
      const clauseStart = Math.max(text.lastIndexOf(".", match.index - 1), text.lastIndexOf("!", match.index - 1), text.lastIndexOf("?", match.index - 1), text.lastIndexOf(";", match.index - 1)) + 1;
      const localPrefix = text.slice(explicit.length === 0 ? clauseStart : previousEnd, match.index);
      const directRole = /\b(?:adapter|callback|callable)(?:\s+(?:function|method))?\s*$/i.test(localPrefix);
      const groupedRole = roleGroup && /^\s*,?\s*(?:(?:and|or)\s+)?(?:an?\s+)?(?:callable\s+)?$/i.test(localPrefix);
      roleGroup = directRole || groupedRole;
      explicit.push({ name: match[1], roleReference: roleGroup });
      previousEnd = match.index + match[0].length;
    }
  }
  if (explicit.length === 0) return [];
  const declared = declaredCallableNames(sourceText);
  const candidates = explicit.filter(({ roleReference }) => !roleReference);
  const primary = candidates[0] ?? explicit[0];
  const productEntrypoints = candidates.slice(1).filter(({ name }) => declared.has(name.toLowerCase()));
  return uniqueStrings([primary.name, ...productEntrypoints.map(({ name }) => name)]).slice(0, 8);
}

function namedCodeTargets(task, criterion, sourceText = "") {
  const text = acceptanceCriterionText(task, criterion);
  const ignored = new Set([
    "api", "boolean", "date", "error", "false", "null", "string", "true", "typeerror", "undefined"
  ]);
  const targets = contractCallableTargets(task, criterion, sourceText);
  const callables = declaredCallableNames(sourceText);
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!/\b(?:validat(?:e|es|ed|ion)|invalid|reject(?:s|ed|ion)?|throw(?:s|ing)?|malformed)\b/i.test(sentence)) continue;
    for (const match of sentence.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) {
      if (callables.has(match[1].toLowerCase()) && !ignored.has(match[1].toLowerCase())) targets.push(match[1]);
    }
  }
  return uniqueStrings(targets).slice(0, 8);
}

function explicitlyCallableTargets(task, criterion, sourceText = "") {
  return contractCallableTargets(task, criterion, sourceText);
}

function booleanAssertionSignals(testText) {
  const text = String(testText ?? "");
  let allow = 0;
  let deny = 0;
  for (const match of text.matchAll(/assert\.(?:equal|strictequal|deepequal)\s*\(([\s\S]{0,1200}?),\s*(true|false)\s*\)/g)) {
    if (match[2] === "true") allow += 1;
    else deny += 1;
  }
  for (const match of text.matchAll(/expect\s*\([\s\S]{0,1200}?\)\s*\.to(?:be|equal)\s*\(\s*(true|false)\s*\)/g)) {
    if (match[1] === "true") allow += 1;
    else deny += 1;
  }
  return {
    allow,
    deny,
    missing: /(?:\bnull\b|\bundefined\b|\{\s*\}|["']\s*["'])/.test(text)
  };
}

function hasStructuredCompositeIdentity(sourceText) {
  const text = String(sourceText ?? "");
  const jsonTuple = /json\.stringify\s*\(\s*\[[^\]\n]{1,800},[^\]\n]{1,800}\]\s*\)/.test(text);
  const nestedLookup = /\.(?:get|set|has|delete)\s*\([^)]*\)[\s\S]{0,800}\.(?:get|set|has|delete)\s*\(/.test(text);
  return jsonTuple || nestedLookup || hasLengthPrefixedIdentityKey(text);
}

function focusedContractEvidence(obligation, task, corpus, verifierEvidence, criterion) {
  if (!verifierEvidence || corpus.sourceFiles.length === 0 || corpus.testFiles.length === 0) return undefined;
  const targets = namedCodeTargets(task, criterion, corpus.sourceText);
  const targetCoverage = targets.length === 0 || targets.every((target) => (
    new RegExp(`\\b${escapeRegex(target.toLowerCase())}\\b`).test(corpus.testText)
  ));
  if (!targetCoverage) return undefined;

  const assertionSignals = booleanAssertionSignals(corpus.testText);
  const tenantSignals = tenantAssertionSignals(corpus.testText);
  let focused = false;
  let summary = "Configured verifier and focused contract tests pass against the final working tree.";
  if (obligation === "authorization-deny-case") {
    focused = assertionSignals.allow >= 1 && assertionSignals.deny >= 2 && assertionSignals.missing;
    summary = "Verifier-backed tests exercise requested allow and multiple deny partitions, including missing input.";
  } else if (obligation === "tenant-boundary") {
    focused = (tenantSignals.same || assertionSignals.allow >= 1)
      && (tenantSignals.cross || assertionSignals.deny >= 1)
      && (tenantSignals.missing || assertionSignals.missing);
    summary = "Verifier-backed tests exercise same-, cross-, and missing-identity boundary partitions.";
  } else if (obligation === "tenant-storage-isolation") {
    const roundTrip = /\.(?:set|put|write|add)\s*\(/.test(corpus.testText)
      && /\.(?:get|read|find|lookup)\s*\(/.test(corpus.testText)
      && /(?:assert\.|expect\s*\()/.test(corpus.testText);
    const distinctWrites = (corpus.testText.match(/\.(?:set|put|write|add)\s*\(/g)?.length ?? 0) >= 2;
    focused = roundTrip && distinctWrites && hasStructuredCompositeIdentity(corpus.sourceText);
    summary = "Verifier-backed round-trip tests exercise distinct composite identities using an unambiguous storage boundary.";
  }
  if (!focused) return undefined;
  return {
    ...verifierEvidence,
    kind: "verifier-backed-focused-test",
    summary,
    paths: [...new Set([...corpus.sourceFiles, ...corpus.testFiles])]
  };
}

function hasCurrentPassingVerifier(task, currentWorkingTreeDigest) {
  if (task?.workingTreeDigestAlgorithm !== WORKING_TREE_DIGEST_ALGORITHM
    || !isCurrentWorkingTreeDigest(currentWorkingTreeDigest)) return false;
  const planned = meaningfulVerificationCommands(task?.verifyCommands ?? []);
  const latest = latestObservedVerificationEvidence(task?.verifyEvidence);
  return planned.length > 0 && planned.every((command) => {
    const evidence = latest.get(command.trim());
    return verificationEvidenceProvesStableTree(evidence, currentWorkingTreeDigest);
  });
}

function evidenceForObligation(obligation, task, corpus, currentWorkingTreeDigest, criterion) {
  const passingVerifier = hasCurrentPassingVerifier(task, currentWorkingTreeDigest);
  const latestVerifyEvidence = latestObservedVerificationEvidence(task?.verifyEvidence);
  const verifyEvidence = meaningfulVerificationCommands(task?.verifyCommands ?? [])
    .map((command) => latestVerifyEvidence.get(command.trim()))
    .filter((evidence) => verificationEvidenceProvesStableTree(evidence, currentWorkingTreeDigest));
  const verifier = verifyEvidence[0];
  const verifierEvidence = verifier ? {
    kind: "verify-command",
    summary: "Configured verifier passed against the final working tree.",
    command: verifier.command,
    exitCode: verifier.exitCode,
    workingTreeDigest: currentWorkingTreeDigest
  } : undefined;
  if (semanticConflictReasons(obligation, task, corpus, criterion).length > 0) return undefined;

  if (obligation === "read-only-evidence") {
    const readOnlyEvidence = durableContextEvidenceEntries(task);
    const readOnlyOk = task.changeMode === "read-only"
      && corpus.files.length === 0
      && hasDurableContextEvidence(task);
    if (readOnlyOk) return {
      kind: "read-only-context",
      summary: "Read-only context was observed and no project files changed.",
      paths: readOnlyEvidence.map((item) => item.path).slice(0, 8)
    };
    if (task.changeMode === "source-change") {
      const boundaryPatterns = uniqueStrings([...(task.outOfScope ?? []), ...(task.protectedPaths ?? [])]);
      const taskText = [
        task.summary,
        task.expectedOutput,
        ...(Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [])
      ].filter(Boolean).join("\n");
      const combinedText = `${taskText}\n${corpus.allText}`;
      const sourceChangeReadOnlyOk = corpus.files.length > 0
        && READ_ONLY_BOUNDARY.test(normalizedText(combinedText))
        && changedFilesRespectBoundaries(corpus.files, boundaryPatterns)
        && (boundaryPatterns.length === 0 || pathBoundaryMentioned(combinedText, boundaryPatterns))
        && hasDurableContextEvidence(task);
      if (sourceChangeReadOnlyOk) {
        return {
          kind: "source-change-read-only-boundary",
          summary: "Changed files document the read-only boundary and no boundary paths changed.",
          paths: corpus.files.slice(0, 8),
          workingTreeDigest: currentWorkingTreeDigest
        };
      }
    }
    return undefined;
  }

  if (obligation === "verification-evidence" || obligation === "requested-behavior" || obligation === "backward-compatibility") {
    if (!passingVerifier) return undefined;
    return verifierEvidence;
  }

  if (!corpus.adapter.proofCapable) return undefined;

  if (obligation === "tenant-boundary") {
    return focusedContractEvidence(obligation, task, corpus, verifierEvidence, criterion);
  }

  if (obligation === "tenant-storage-isolation") {
    return focusedContractEvidence(obligation, task, corpus, verifierEvidence, criterion);
  }

  if (obligation === "authorization-deny-case") {
    return focusedContractEvidence(obligation, task, corpus, verifierEvidence, criterion);
  }

  if (obligation === "invalid-input-rejection") {
    const { sourceOk, testOk } = acceptanceInvalidInputEvidence({
      taskText: acceptanceCriterionText(task, criterion),
      sourceText: corpus.sourceText,
      testText: corpus.testText,
      sourceEntries: corpus.sourceEntries,
      testEntries: corpus.testEntries,
      namedTargets: namedCodeTargets(task, criterion, corpus.sourceText),
      provenanceTargets: explicitlyCallableTargets(task, criterion, corpus.sourceText)
    });
    if (passingVerifier && corpus.sourceFiles.length > 0 && corpus.testFiles.length > 0 && sourceOk && testOk) {
      return {
        ...verifierEvidence,
        kind: "verifier-backed-focused-test",
        summary: "Configured verifier passed with focused invalid-input tests for named entrypoints.",
        paths: [...new Set([...corpus.sourceFiles, ...corpus.testFiles])]
      };
    }
    return undefined;
  }

  if (obligation === "boundary-case") {
    const expirySourceOk = /\b(?:expiresat|expiry|expires|expired|timestamp|now)\b/.test(corpus.sourceText)
      && /(?:===|!==|>=|<=|>|<)/.test(corpus.sourceText);
    const testOk = /boundary|edge|zero|ceil|clamp|min|max|inclusive|exact|equal|equality|expired|expiry|past|future|partial|round|falsey|falsy|nullish|default|retrylimit|label|\bfalse\b|\b0\b/.test(corpus.testText);
    const sourceOk = /math\.ceil|ceil|clamp|min|max|round|zero|return\s+0|\?\?|nullish|falsey|falsy|default|retrylimit|enabled|label/.test(corpus.sourceText)
      || expirySourceOk
      || (passingVerifier && corpus.sourceFiles.length > 0 && testOk);
    if (passingVerifier && corpus.sourceFiles.length > 0 && corpus.testFiles.length > 0 && sourceOk && testOk) {
      return {
        ...verifierEvidence,
        kind: "verifier-backed-focused-test",
        summary: "Configured verifier passed with focused boundary-contract tests.",
        paths: [...new Set([...corpus.sourceFiles, ...corpus.testFiles])]
      };
    }
    return undefined;
  }

  return passingVerifier ? verifierEvidence : undefined;
}

export function refreshAcceptanceReceipt(task, options = {}) {
  const receipt = normalizeAcceptanceReceipt(task?.acceptanceReceipt);
  if (!receipt) return { task, missing: [], criticalMissing: [], changed: false };
  const cwd = options.cwd;
  const changedFiles = uniqueStrings(options.changedFiles ?? task.changedFiles ?? task.observedChangedFiles ?? []);
  const currentWorkingTreeDigest = options.currentWorkingTreeDigest;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const corpus = cwd ? changedFileAcceptanceCorpus(cwd, changedFiles) : emptyAcceptanceCorpus(changedFiles);
  let changed = false;
  for (const criterion of receipt.criteria) {
    if (task?.changeMode === "source-change" && cwd) {
      const previousStatus = criterion.status;
      const previousEvidence = (criterion.evidence ?? []).map(evidenceKey);
      criterion.status = "pending";
      criterion.evidence = [];
      const evidence = task?.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM
        && isCurrentWorkingTreeDigest(currentWorkingTreeDigest)
        ? evidenceForObligation(criterion.obligation, task, corpus, currentWorkingTreeDigest, criterion)
        : undefined;
      if (evidence) addEvidence(criterion, evidence, recordedAt);
      const nextEvidence = (criterion.evidence ?? []).map(evidenceKey);
      if (previousStatus !== criterion.status || JSON.stringify(previousEvidence) !== JSON.stringify(nextEvidence)) changed = true;
      continue;
    }
    if (criterion.status === "satisfied") continue;
    const evidence = evidenceForObligation(criterion.obligation, task, corpus, currentWorkingTreeDigest, criterion);
    if (evidence) changed = addEvidence(criterion, evidence, recordedAt) || changed;
  }
  const missing = receipt.criteria.filter((criterion) => criterion.status !== "satisfied");
  const criticalMissing = missing.filter((criterion) => criterion.priority === "critical");
  return {
    task: { ...task, acceptanceReceipt: receipt },
    receipt,
    missing,
    criticalMissing,
    changed
  };
}

/**
 * Project only current, task-derived recovery guidance for critical criteria.
 * Hash binding prevents stale receipt text from being presented as operator
 * intent; unavailable source/test/current-tree evidence yields no projection.
 */
export function acceptanceCriticalRecoveryProjection(task, options = {}) {
  const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : undefined;
  const currentWorkingTreeDigest = options.currentWorkingTreeDigest;
  const changedFiles = uniqueStrings(options.changedFiles ?? task?.changedFiles ?? task?.observedChangedFiles ?? []);
  const receipt = normalizeAcceptanceReceipt(task?.acceptanceReceipt);
  if (!cwd || !receipt || task?.workingTreeDigestAlgorithm !== WORKING_TREE_DIGEST_ALGORITHM
    || !isCurrentWorkingTreeDigest(currentWorkingTreeDigest) || changedFiles.length === 0) return [];
  const corpus = changedFileAcceptanceCorpus(cwd, changedFiles);
  if (!corpus.adapter.proofCapable) return [];
  if (corpus.sourceEntries.length === 0 && corpus.testEntries.length === 0) return [];
  const verifierCurrent = hasCurrentPassingVerifier(task, currentWorkingTreeDigest);
  const projections = [];
  for (const criterion of receipt.criteria.filter((item) => item.priority === "critical")) {
    const criterionText = (Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [])
      .find((text) => typeof text === "string" && sha256(text) === criterion.hash && !GENERATED_ACCEPTANCE_TEXTS.has(text));
    if (!criterionText || evidenceForObligation(criterion.obligation, task, corpus, currentWorkingTreeDigest, criterion)) continue;
    const targets = namedCodeTargets(task, criterion, corpus.sourceText);
    const missingDimensions = [];
    if (!verifierCurrent) missingDimensions.push("current-verifier");
    if (criterion.obligation === "invalid-input-rejection") {
      if (corpus.sourceFiles.length === 0 || corpus.testFiles.length === 0) continue;
      const proof = acceptanceInvalidInputEvidence({
        taskText: criterionText, sourceText: corpus.sourceText, testText: corpus.testText,
        sourceEntries: corpus.sourceEntries, testEntries: corpus.testEntries,
        namedTargets: targets, provenanceTargets: explicitlyCallableTargets(task, criterion, corpus.sourceText)
      });
      if (!proof.sourceOk) missingDimensions.push("source-rejection");
      if (!proof.testOk) missingDimensions.push("executable-focused-test");
    }
    if (missingDimensions.length === 0) missingDimensions.push("focused-evidence");
    const proofHints = acceptanceContractProofGuidance(criterionText);
    if (missingDimensions.includes("source-rejection")) proofHints.push("Add a reachable entrypoint-bound rejection guard for every explicitly invalid partition and requested error class.");
    if (missingDimensions.includes("executable-focused-test")) proofHints.push("Add live entrypoint-bound rejection assertions; dynamic, skipped, dead, mutable, or unresolved proof remains pending.");
    if (missingDimensions.includes("current-verifier")) proofHints.push("Run the exact configured verifier against one unchanged current working-tree snapshot.");
    projections.push({ criterionId: criterion.id, criterionHash: criterion.hash, criterionText: criterionText.slice(0, 700), targets: uniqueStrings(targets).slice(0, 8), missingDimensions: uniqueStrings(missingDimensions), proofHints: uniqueStrings(proofHints).slice(0, 6).map((hint) => hint.slice(0, 300)) });
  }
  return projections.slice(0, MAX_CRITERIA);
}

export function acceptanceReceiptValidationErrors(value) {
  if (value === undefined) return [];
  const errors = [];
  if (!isRecord(value) || hasUnsupportedField(value, RECEIPT_FIELDS)) return ["acceptanceReceipt is invalid"];
  if (value.schemaVersion !== ACCEPTANCE_RECEIPT_SCHEMA_VERSION) errors.push(`acceptanceReceipt schemaVersion must be ${ACCEPTANCE_RECEIPT_SCHEMA_VERSION}`);
  if (!['model', 'runtime'].includes(value.source)) errors.push("acceptanceReceipt source is invalid");
  if (typeof value.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(value.promptHash)) errors.push("acceptanceReceipt promptHash is invalid");
  if (!validTimestamp(value.generatedAt)) errors.push("acceptanceReceipt generatedAt is invalid");
  if (value.provenance !== undefined) {
    const provenance = value.provenance;
    if (!isRecord(provenance) || hasUnsupportedField(provenance, PROVENANCE_FIELDS)) {
      errors.push("acceptanceReceipt provenance is invalid");
    } else {
      if (provenance.assurance !== "runtime-observed") errors.push("acceptanceReceipt provenance assurance is invalid");
      if (!RECEIPT_DISPOSITIONS.has(provenance.disposition)) errors.push("acceptanceReceipt provenance disposition is invalid");
      if (!Number.isInteger(provenance.repairCount) || provenance.repairCount < 0 || provenance.repairCount > 10) errors.push("acceptanceReceipt provenance repairCount is invalid");
      if (!Number.isInteger(provenance.retryCount) || provenance.retryCount < 0 || provenance.retryCount > 10) errors.push("acceptanceReceipt provenance retryCount is invalid");
      if (!FINAL_RECOVERY_DISPOSITIONS.has(provenance.finalRecoveryDisposition)) errors.push("acceptanceReceipt provenance finalRecoveryDisposition is invalid");
      if (provenance.failureRef !== null && (!isRecord(provenance.failureRef) || hasUnsupportedField(provenance.failureRef, FAILURE_REF_FIELDS) || !HASH.test(String(provenance.failureRef.evidenceDigest)) || !FAILURE_CATEGORIES.has(provenance.failureRef.category) || (provenance.failureRef.captureRef !== null && (typeof provenance.failureRef.captureRef !== "string" || !SAFE_REF.test(provenance.failureRef.captureRef))))) errors.push("acceptanceReceipt provenance failureRef is invalid");
      if (provenance.recoveryRef !== null && (!isRecord(provenance.recoveryRef) || hasUnsupportedField(provenance.recoveryRef, RECOVERY_REF_FIELDS) || provenance.recoveryRef.policyVersion !== "recovery-v1" || !RECOVERY_ACTIONS.has(provenance.recoveryRef.action) || !Array.isArray(provenance.recoveryRef.reasonCodes) || provenance.recoveryRef.reasonCodes.length > 16 || provenance.recoveryRef.reasonCodes.some((item) => typeof item !== "string" || compactId(item) !== item))) errors.push("acceptanceReceipt provenance recoveryRef is invalid");
      if (provenance.handoffRef !== null && (typeof provenance.handoffRef !== "string" || !SAFE_REF.test(provenance.handoffRef) || path.isAbsolute(provenance.handoffRef) || provenance.handoffRef.split(/[\\/]/).includes(".."))) errors.push("acceptanceReceipt provenance handoffRef is invalid");
      if (!validTimestamp(provenance.recordedAt)) errors.push("acceptanceReceipt provenance recordedAt is invalid");
    }
  }
  if (value.helperUsage !== undefined) {
    const usage = value.helperUsage;
    if (!isRecord(usage) || hasUnsupportedField(usage, HELPER_USAGE_FIELDS) || !["off", "recommend", "on"].includes(usage.mode) || typeof usage.used !== "boolean" || !Array.isArray(usage.reasonCodes) || usage.reasonCodes.length > 16 || usage.reasonCodes.some((item) => typeof item !== "string" || compactId(item) !== item) || !Array.isArray(usage.helpers) || usage.helpers.length > 3 || !validTimestamp(usage.recordedAt)) errors.push("acceptanceReceipt helperUsage is invalid");
    else for (const helper of usage.helpers) if (!isRecord(helper) || hasUnsupportedField(helper, HELPER_ENTRY_FIELDS) || !HELPER_ROLES.has(helper.role) || typeof helper.disposition !== "string" || compactId(helper.disposition) !== helper.disposition || !HASH.test(String(helper.requestRef)) || (helper.outputDigest !== null && !HASH.test(String(helper.outputDigest))) || !Number.isInteger(helper.calls) || helper.calls < 0 || helper.calls > 100 || !Number.isInteger(helper.tokens) || helper.tokens < 0 || helper.tokens > 100_000_000) errors.push("acceptanceReceipt helper entry is invalid");
  }
  if (!Array.isArray(value.criteria) || value.criteria.length === 0 || value.criteria.length > MAX_CRITERIA) {
    errors.push(`acceptanceReceipt criteria must contain 1-${MAX_CRITERIA} entries`);
    return errors;
  }
  for (const criterion of value.criteria) {
    if (!isRecord(criterion) || hasUnsupportedField(criterion, CRITERION_FIELDS)) {
      errors.push("acceptanceReceipt criterion is invalid");
      continue;
    }
    if (typeof criterion.id !== "string" || !criterion.id || compactId(criterion.id) !== criterion.id) errors.push("acceptanceReceipt criterion id is invalid");
    if (typeof criterion.hash !== "string" || !/^[a-f0-9]{64}$/.test(criterion.hash)) errors.push("acceptanceReceipt criterion hash is invalid");
    if (typeof criterion.obligation !== "string" || !criterion.obligation || compactId(criterion.obligation) !== criterion.obligation) errors.push("acceptanceReceipt criterion obligation is invalid");
    if (!ACCEPTANCE_STATUSES.has(criterion.status)) errors.push("acceptanceReceipt criterion status is invalid");
    if (!ACCEPTANCE_PRIORITIES.has(criterion.priority)) errors.push("acceptanceReceipt criterion priority is invalid");
    if (criterion.updatedAt !== undefined && !validTimestamp(criterion.updatedAt)) errors.push("acceptanceReceipt criterion updatedAt is invalid");
    if (!Array.isArray(criterion.evidence) || criterion.evidence.length > MAX_EVIDENCE_PER_CRITERION) {
      errors.push(`acceptanceReceipt criterion evidence must contain at most ${MAX_EVIDENCE_PER_CRITERION} entries`);
      continue;
    }
    for (const evidence of criterion.evidence) {
      if (!isRecord(evidence) || hasUnsupportedField(evidence, EVIDENCE_FIELDS)) {
        errors.push("acceptanceReceipt evidence is invalid");
        continue;
      }
      if (typeof evidence.kind !== "string" || !evidence.kind || compactId(evidence.kind) !== evidence.kind) errors.push("acceptanceReceipt evidence kind is invalid");
      if (typeof evidence.summary !== "string" || !evidence.summary.trim() || evidence.summary.length > 240) errors.push("acceptanceReceipt evidence summary is invalid");
      if (!Array.isArray(evidence.paths) || evidence.paths.length > 12 || evidence.paths.some((item) => typeof item !== "string" || !item.trim())) errors.push("acceptanceReceipt evidence paths are invalid");
      if (evidence.command !== undefined && (typeof evidence.command !== "string" || !evidence.command.trim() || evidence.command.length > 300)) errors.push("acceptanceReceipt evidence command is invalid");
      if (evidence.exitCode !== undefined && !Number.isInteger(evidence.exitCode)) errors.push("acceptanceReceipt evidence exitCode is invalid");
      if (evidence.workingTreeDigest !== undefined && !isCurrentWorkingTreeDigest(evidence.workingTreeDigest)) errors.push("acceptanceReceipt evidence workingTreeDigest is invalid");
      if (evidence.recordedAt !== undefined && !validTimestamp(evidence.recordedAt)) errors.push("acceptanceReceipt evidence recordedAt is invalid");
    }
  }
  return errors;
}

export function acceptanceReceiptSummary(receipt) {
  const normalized = normalizeAcceptanceReceipt(receipt);
  if (!normalized) return [];
  return normalized.criteria.map((criterion) => ({
    id: criterion.id,
    obligation: criterion.obligation,
    priority: criterion.priority,
    status: criterion.status,
    evidence: (criterion.evidence ?? []).map((item) => item.kind)
  }));
}

export function acceptanceReceiptProvenanceSummary(receipt) {
  const normalized = normalizeAcceptanceReceipt(receipt);
  return normalized ? { recovery: normalized.provenance, helpers: normalized.helperUsage } : undefined;
}

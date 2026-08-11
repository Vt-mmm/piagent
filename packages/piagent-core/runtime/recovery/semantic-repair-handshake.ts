import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { acceptanceExecutableTestBinding } from "../../extensions/acceptance-contract-semantics.js";
import { acceptanceSemanticConflicts } from "../../extensions/acceptance-receipt.js";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { normalizePathCandidate } from "../../extensions/policy-core.js";
import { safeTaskId } from "../../extensions/task-state.js";
import { isCurrentWorkingTreeDigest } from "../../extensions/working-tree-digest.js";

const HASH = /^[a-f0-9]{64}$/;
const GLOB = /[?*[\]{}]/;
const MAX_FILE_BYTES = 256 * 1024;
export const MAX_SEMANTIC_REPAIR_PATHS = 12;
export const MAX_SEMANTIC_REPAIR_REVISIONS = 2;
export const MAX_SEMANTIC_REPAIR_MUTATIONS = 8;
export const MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS = 3;

type RepairStatus = "reserved" | "authorized" | "active" | "retry-ready" | "verifier-pending" | "passed" | "cancelled" | "locked";
type RepairPendingCall = {
  toolCallId: string;
  toolName: string;
  kind: "mutation" | "verifier";
  opensRepair: boolean;
  preDigest: string;
  targetPaths: string[];
  authorized: boolean;
  retryVerifier: boolean;
  reservationTokenHash: string | null;
};
export type SemanticRepairState = {
  schemaVersion: 2;
  taskId: string;
  taskRunId: string;
  sessionId: string;
  status: RepairStatus;
  revision: number;
  preRepairDigest: string;
  currentDigest: string;
  eligiblePaths: string[];
  conflictCodes: string[];
  successfulMutations: number;
  successfulMutationsInRevision: number;
  transientRetryUsed: boolean;
  deniedCalls: number;
  failedCalls: number;
  noOpCalls: number;
  pending: RepairPendingCall | null;
  createdAt: string;
  updatedAt: string;
};
export type SemanticRepairStoreView = {
  status: "missing" | "ok" | "corrupt";
  state?: SemanticRepairState;
  enforcementSafe: boolean;
  warnings: string[];
};
export type SemanticRepairHandshakeDecision = {
  authorized: boolean;
  conflictCodes: string[];
  eligibleTargets: string[];
  eligiblePaths: string[];
  pathConflictCodes: Record<string, string[]>;
};

type SemanticRepairOrigin = {
  schemaVersion: 1; taskId: string; taskRunId: string; sessionId: string;
  openedDigest: string; recordedAt: string;
};

function semanticRepairOriginPath(cwd: string, taskRunId: string): string {
  return path.join(cwd, ".pi", "piagent-state", "semantic-repair", `${safeTaskId(taskRunId)}.origin.json`);
}

function readSemanticRepairOrigin(cwd: string, taskRunId: string): { status: "missing" | "ok" | "corrupt"; marker?: SemanticRepairOrigin } {
  try {
    const target = resolveLocalStatePath(cwd, semanticRepairOriginPath(cwd, taskRunId), { label: "Semantic repair origin" });
    if (!fs.existsSync(target)) return { status: "missing" };
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("semantic repair origin must be a bounded regular file");
    const marker = JSON.parse(fs.readFileSync(target, "utf8")) as SemanticRepairOrigin;
    if (marker.schemaVersion !== 1 || !marker.taskId || marker.taskRunId !== taskRunId || !marker.sessionId || !isCurrentWorkingTreeDigest(marker.openedDigest) || !validTimestamp(marker.recordedAt)) throw new Error("semantic repair origin is invalid");
    return { status: "ok", marker };
  } catch {
    return { status: "corrupt" };
  }
}

/** A dedicated origin marker distinguishes semantic repair from generic recovery. */
export function semanticRepairStateRequired(cwd: string, taskRunId: string): boolean {
  return readSemanticRepairOrigin(cwd, taskRunId).status !== "missing";
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))];
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map(normalizePathCandidate).filter(Boolean))].sort();
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function exactDeclaredPath(task: TaskContract, target: string): boolean {
  return (task.scope ?? []).some((candidate) => {
    const normalized = normalizePathCandidate(candidate);
    return Boolean(normalized && !GLOB.test(normalized) && normalized === target);
  });
}

function isTestPath(file: string): boolean {
  return /(^|\/)(?:test|tests|spec|__tests__)(\/|$)|[._-](?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
}

function readSmallFile(cwd: string, target: string): string {
  try {
    const absolute = path.resolve(cwd, target);
    const relative = path.relative(cwd, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return "";
  }
}

function contentLinkedConflictCodes(task: TaskContract, sourceText: string): string[] {
  if (!sourceText.trim()) return [];
  const contentIndependent = new Set(acceptanceSemanticConflicts(task, { sourceText: "" }));
  return acceptanceSemanticConflicts(task, { sourceText })
    .filter((code) => !contentIndependent.has(code));
}

/** Select exact source conflicts and only executable-proof-linked companion tests. */
export function decideSemanticRepairHandshake(input: {
  cwd: string;
  task: TaskContract;
  mutationTargets: string[];
  currentDeltaPaths: string[];
  verifierCurrent: boolean;
}): SemanticRepairHandshakeDecision {
  const targets = uniquePaths(input.mutationTargets), delta = new Set(uniquePaths(input.currentDeltaPaths));
  const empty = { authorized: false, conflictCodes: [], eligibleTargets: [], eligiblePaths: [], pathConflictCodes: {} };
  if (!input.verifierCurrent || targets.length === 0 || delta.size === 0) return empty;
  const candidates = uniquePaths([...delta, ...(input.task.scope ?? []).filter((item) => !GLOB.test(item))]);
  const pathConflictCodes: Record<string, string[]> = {}, sourceTexts = new Map<string, string>();
  for (const file of candidates) {
    if (isTestPath(file) || (!delta.has(file) && !exactDeclaredPath(input.task, file))) continue;
    const source = readSmallFile(input.cwd, file), conflicts = contentLinkedConflictCodes(input.task, source);
    if (conflicts.length === 0) continue;
    pathConflictCodes[file] = conflicts;
    sourceTexts.set(file, source);
  }
  const sourcePaths = Object.keys(pathConflictCodes);
  if (sourcePaths.length === 0) return empty;
  const relatedTests = candidates.filter((file) => (
    isTestPath(file)
    && (delta.has(file) || exactDeclaredPath(input.task, file))
    && sourcePaths.some((sourcePath) => acceptanceExecutableTestBinding({
      sourceEntry: { path: sourcePath, text: sourceTexts.get(sourcePath) ?? "" },
      testEntry: { path: file, text: readSmallFile(input.cwd, file) }
    }).linked)
  ));
  const eligiblePaths = uniquePaths([...sourcePaths, ...relatedTests]).slice(0, MAX_SEMANTIC_REPAIR_PATHS);
  const conflictCodes = uniqueStrings(Object.values(pathConflictCodes).flat());
  const eligibleTargets = targets.filter((target) => eligiblePaths.includes(target));
  const includesConflictingSource = targets.some((target) => sourcePaths.includes(target));
  return { authorized: includesConflictingSource && targets.length === eligibleTargets.length, conflictCodes, eligibleTargets, eligiblePaths, pathConflictCodes };
}

export function semanticRepairStatePath(cwd: string, taskRunId: string): string {
  return path.join(cwd, ".pi", "piagent-state", "semantic-repair", `${safeTaskId(taskRunId)}.json`);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateState(value: unknown, taskRunId?: string): SemanticRepairState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("semantic repair state is not an object");
  const state = value as SemanticRepairState, statuses = new Set<RepairStatus>(["reserved", "authorized", "active", "retry-ready", "verifier-pending", "passed", "cancelled", "locked"]);
  if (state.schemaVersion !== 2 || !state.taskId || !state.taskRunId || !state.sessionId || (taskRunId && state.taskRunId !== taskRunId)) throw new Error("semantic repair identity is invalid");
  if (!statuses.has(state.status) || !Number.isInteger(state.revision) || state.revision < 1 || state.revision > MAX_SEMANTIC_REPAIR_REVISIONS) throw new Error("semantic repair revision is invalid");
  if (!isCurrentWorkingTreeDigest(state.preRepairDigest) || !isCurrentWorkingTreeDigest(state.currentDigest)) throw new Error("semantic repair digest is invalid");
  const paths = uniquePaths(state.eligiblePaths ?? []), conflicts = uniqueStrings(state.conflictCodes ?? []);
  const pathsCanonical = JSON.stringify(paths) === JSON.stringify(state.eligiblePaths)
    && paths.every((item) => item !== "." && item !== ".." && !item.startsWith("../") && !path.isAbsolute(item));
  if (!pathsCanonical || paths.length === 0 || paths.length > MAX_SEMANTIC_REPAIR_PATHS || conflicts.length === 0) throw new Error("semantic repair grant is invalid");
  for (const count of [state.successfulMutations, state.successfulMutationsInRevision, state.deniedCalls, state.failedCalls, state.noOpCalls]) if (!Number.isInteger(count) || count < 0) throw new Error("semantic repair counters are invalid");
  if (typeof state.transientRetryUsed !== "boolean" || state.successfulMutationsInRevision > state.successfulMutations || state.successfulMutations > MAX_SEMANTIC_REPAIR_MUTATIONS || unsuccessful(state) > MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS) throw new Error("semantic repair counters exceed their bounds");
  if (unsuccessful(state) === MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS && state.status !== "locked") throw new Error("semantic repair exhausted state is not locked");
  if (!validTimestamp(state.createdAt) || !validTimestamp(state.updatedAt)) throw new Error("semantic repair timestamp is invalid");
  if (state.pending !== null) {
    const pending = state.pending;
    if (!pending.toolCallId || !pending.toolName || !["mutation", "verifier"].includes(pending.kind) || !isCurrentWorkingTreeDigest(pending.preDigest) || pending.preDigest !== state.currentDigest || typeof pending.authorized !== "boolean" || typeof pending.opensRepair !== "boolean" || typeof pending.retryVerifier !== "boolean") throw new Error("semantic repair pending call is invalid");
    if ((pending.kind === "mutation" && pending.retryVerifier) || (pending.retryVerifier && !state.transientRetryUsed)) throw new Error("semantic repair pending retry is invalid");
    if (pending.reservationTokenHash !== null && !HASH.test(pending.reservationTokenHash)) throw new Error("semantic repair reservation token is invalid");
    const targets = uniquePaths(pending.targetPaths ?? []);
    if (JSON.stringify(targets) !== JSON.stringify(pending.targetPaths) || (pending.kind === "mutation" && (targets.length === 0 || targets.some((file) => !paths.includes(file))))) throw new Error("semantic repair pending targets are invalid");
    if (pending.kind === "verifier" && targets.length > 0) throw new Error("semantic repair verifier target is invalid");
  }
  const pending = state.pending;
  const stateShapeValid = state.status === "reserved"
    ? state.successfulMutations === 0 && pending?.kind === "mutation" && pending.opensRepair && !pending.authorized && Boolean(pending.reservationTokenHash)
    : state.status === "authorized"
      ? state.successfulMutations === 0 && pending?.kind === "mutation" && pending.opensRepair && pending.authorized && Boolean(pending.reservationTokenHash)
      : state.status === "active"
        ? state.successfulMutations > 0 && (!pending || (pending.kind === "mutation" && !pending.opensRepair && pending.authorized && pending.reservationTokenHash === null))
        : state.status === "retry-ready"
          ? state.successfulMutationsInRevision > 0 && state.transientRetryUsed && pending === null
          : state.status === "verifier-pending"
            ? state.successfulMutationsInRevision > 0 && pending?.kind === "verifier" && !pending.opensRepair && pending.authorized && pending.reservationTokenHash === null
          : state.status === "passed"
            ? state.successfulMutationsInRevision > 0 && pending === null
            : state.status === "cancelled"
              ? state.successfulMutations === 0 && pending === null
              : pending === null;
  if (!stateShapeValid) throw new Error("semantic repair status shape is invalid");
  return structuredClone(state);
}

export function readSemanticRepairState(cwd: string, taskRunId: string): SemanticRepairStoreView {
  try {
    const target = resolveLocalStatePath(cwd, semanticRepairStatePath(cwd, taskRunId), { label: "Semantic repair state" });
    if (!fs.existsSync(target)) return { status: "missing", enforcementSafe: true, warnings: [] };
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("semantic repair state must be a bounded regular file");
    return { status: "ok", state: validateState(JSON.parse(fs.readFileSync(target, "utf8")), taskRunId), enforcementSafe: true, warnings: [] };
  } catch (error) {
    return { status: "corrupt", enforcementSafe: false, warnings: [error instanceof Error ? error.message : String(error)] };
  }
}

function writeState(cwd: string, stateInput: SemanticRepairState): SemanticRepairState {
  const state = validateState(stateInput, stateInput.taskRunId), target = semanticRepairStatePath(cwd, state.taskRunId);
  const parent = ensurePrivateStateDirectory(cwd, path.dirname(target), "Semantic repair state directory");
  const safeTarget = resolveLocalStatePath(cwd, target, { label: "Semantic repair state" });
  const temporary = path.join(parent, `${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, safeTarget);
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
  return state;
}

function writeSemanticRepairOrigin(cwd: string, state: SemanticRepairState, openedDigest: string, recordedAt: string): void {
  const existing = readSemanticRepairOrigin(cwd, state.taskRunId);
  if (existing.status === "corrupt") throw new Error("semantic repair origin is corrupt");
  if (existing.marker) {
    if (existing.marker.taskId !== state.taskId || existing.marker.sessionId !== state.sessionId) throw new Error("semantic repair origin identity mismatch");
    return;
  }
  const target = semanticRepairOriginPath(cwd, state.taskRunId);
  const parent = ensurePrivateStateDirectory(cwd, path.dirname(target), "Semantic repair origin directory");
  const safeTarget = resolveLocalStatePath(cwd, target, { label: "Semantic repair origin" });
  const temporary = path.join(parent, `${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const marker: SemanticRepairOrigin = { schemaVersion: 1, taskId: state.taskId, taskRunId: state.taskRunId, sessionId: state.sessionId, openedDigest, recordedAt };
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, safeTarget);
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
}

export function semanticRepairOriginMatches(cwd: string, state: SemanticRepairState): boolean {
  const origin = readSemanticRepairOrigin(cwd, state.taskRunId);
  return origin.status === "ok" && origin.marker?.taskId === state.taskId && origin.marker.sessionId === state.sessionId;
}

export function semanticRepairProvenance(cwd: string, taskRunId: string): { enforcementSafe: boolean; repairCount: number; retryCount: number; passed: boolean } {
  const origin = readSemanticRepairOrigin(cwd, taskRunId), view = readSemanticRepairState(cwd, taskRunId), state = view.state;
  if (origin.status === "missing" && !state?.successfulMutations) return { enforcementSafe: view.enforcementSafe, repairCount: 0, retryCount: 0, passed: false };
  if (origin.status !== "ok" || !view.enforcementSafe || !state || !semanticRepairOriginMatches(cwd, state)) return { enforcementSafe: false, repairCount: 0, retryCount: 0, passed: false };
  const repairCount = state.successfulMutations > 0 ? state.revision : Math.max(1, state.revision - 1);
  return { enforcementSafe: true, repairCount, retryCount: state.transientRetryUsed ? 1 : 0, passed: state.status === "passed" };
}

function unsuccessful(state: SemanticRepairState): number {
  return state.deniedCalls + state.failedCalls + state.noOpCalls;
}

function matchingPending(state: SemanticRepairState, input: { toolCallId: string; toolName: string; currentDigest: string; targetPaths?: string[]; reservationToken?: string }): boolean {
  const pending = state.pending;
  return Boolean(pending && pending.toolCallId === input.toolCallId && pending.toolName === input.toolName && pending.preDigest === input.currentDigest
    && (pending.reservationTokenHash === null || (Boolean(input.reservationToken) && tokenHash(input.reservationToken!) === pending.reservationTokenHash))
    && (input.targetPaths === undefined || JSON.stringify(uniquePaths(input.targetPaths)) === JSON.stringify(uniquePaths(pending.targetPaths))));
}

function denyActiveCall(cwd: string, state: SemanticRepairState, reason: string, recordedAt?: string) {
  state.deniedCalls += 1;
  if (unsuccessful(state) >= MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS) state.status = "locked";
  state.updatedAt = recordedAt ?? new Date().toISOString();
  const written = writeState(cwd, state);
  return { handled: true, allowed: false, bypassPhase: false, reason, state: written };
}

export function reserveSemanticRepairCall(input: {
  cwd: string; task: TaskContract; sessionId: string; toolCallId: string; toolName: string;
  currentDigest: string; decision: SemanticRepairHandshakeDecision; targetPaths: string[]; recordedAt?: string;
}): { reserved: boolean; reason?: string; state?: SemanticRepairState; reservationToken?: string } {
  const existing = readSemanticRepairState(input.cwd, input.task.taskRunId);
  if (!existing.enforcementSafe) return { reserved: false, reason: existing.warnings[0] };
  if (input.sessionId !== input.task.sessionId) return { reserved: false, reason: "semantic repair task/session identity mismatch" };
  if (!existing.state && semanticRepairStateRequired(input.cwd, input.task.taskRunId)) return { reserved: false, reason: "required semantic repair state is missing" };
  if (!input.decision.authorized || !isCurrentWorkingTreeDigest(input.currentDigest)) return { reserved: false, reason: "semantic repair evidence is incomplete" };
  const prior = existing.state;
  if (prior && prior.successfulMutations > 0 && !semanticRepairOriginMatches(input.cwd, prior)) return { reserved: false, reason: "semantic repair durable origin is missing or invalid" };
  if (prior && ["reserved", "authorized", "active", "retry-ready", "verifier-pending", "locked"].includes(prior.status)) return { reserved: false, reason: `semantic repair is ${prior.status}` };
  const continuation = prior?.status === "cancelled", revision = prior?.status === "passed" ? prior.revision + 1 : prior?.revision ?? 1;
  if (revision > MAX_SEMANTIC_REPAIR_REVISIONS || (prior && unsuccessful(prior) >= MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS)) return { reserved: false, reason: "semantic repair attempt ceiling reached" };
  const targets = uniquePaths(input.targetPaths), eligible = uniquePaths(input.decision.eligiblePaths).slice(0, MAX_SEMANTIC_REPAIR_PATHS);
  if (targets.length === 0 || targets.some((file) => !eligible.includes(file))) return { reserved: false, reason: "semantic repair target is not evidence-linked" };
  const now = input.recordedAt ?? new Date().toISOString(), reservationToken = crypto.randomBytes(32).toString("hex");
  const state: SemanticRepairState = {
    schemaVersion: 2, taskId: input.task.taskId, taskRunId: input.task.taskRunId, sessionId: input.sessionId,
    status: "reserved", revision, preRepairDigest: input.currentDigest, currentDigest: input.currentDigest,
    eligiblePaths: eligible, conflictCodes: input.decision.conflictCodes.slice(0, 32), successfulMutations: 0,
    successfulMutationsInRevision: 0, transientRetryUsed: prior?.transientRetryUsed ?? false,
    deniedCalls: continuation ? prior!.deniedCalls : 0, failedCalls: continuation ? prior!.failedCalls : 0,
    noOpCalls: continuation ? prior!.noOpCalls : 0,
    pending: { toolCallId: input.toolCallId, toolName: input.toolName, kind: "mutation", opensRepair: true, preDigest: input.currentDigest, targetPaths: targets, authorized: false, retryVerifier: false, reservationTokenHash: tokenHash(reservationToken) },
    createdAt: continuation ? prior!.createdAt : now, updatedAt: now
  };
  return { reserved: true, state: writeState(input.cwd, state), reservationToken };
}

export function reservedSemanticRepairCallMatches(input: { cwd: string; taskRunId: string; sessionId: string; toolCallId: string; toolName: string; currentDigest: string; targetPaths: string[]; reservationToken: string }): boolean {
  const view = readSemanticRepairState(input.cwd, input.taskRunId), state = view.state;
  return Boolean(view.enforcementSafe && state?.status === "reserved" && state.sessionId === input.sessionId && matchingPending(state, input));
}

export function authorizeSemanticRepairCall(input: {
  cwd: string; task: TaskContract; sessionId: string; toolCallId: string; toolName: string; currentDigest: string;
  targetPaths: string[]; projectMutation: boolean; exactVerifier: boolean; shellLike: boolean; opaqueCarrier?: boolean;
  targetExtractionComplete?: boolean; reservationToken?: string; recordedAt?: string;
}): { handled: boolean; allowed: boolean; bypassPhase: boolean; reason?: string; state?: SemanticRepairState } {
  const view = readSemanticRepairState(input.cwd, input.task.taskRunId), state = view.state;
  if (!view.enforcementSafe) return { handled: true, allowed: false, bypassPhase: false, reason: view.warnings[0] };
  if (!state) return semanticRepairStateRequired(input.cwd, input.task.taskRunId)
    ? { handled: true, allowed: false, bypassPhase: false, reason: "required semantic repair state is missing" }
    : { handled: false, allowed: false, bypassPhase: false };
  if (state.successfulMutations > 0 && !semanticRepairOriginMatches(input.cwd, state)) return { handled: true, allowed: false, bypassPhase: false, reason: "semantic repair durable origin is missing or invalid" };
  if (["passed", "cancelled"].includes(state.status)) return { handled: false, allowed: false, bypassPhase: false };
  if (state.taskId !== input.task.taskId || state.sessionId !== input.sessionId || input.task.sessionId !== input.sessionId) return { handled: true, allowed: false, bypassPhase: false, reason: "semantic repair identity mismatch" };
  if (state.status === "locked") return { handled: true, allowed: false, bypassPhase: false, reason: "semantic repair grant is locked" };
  if (state.currentDigest !== input.currentDigest) {
    state.status = "locked"; state.pending = null; state.updatedAt = input.recordedAt ?? new Date().toISOString(); writeState(input.cwd, state);
    return { handled: true, allowed: false, bypassPhase: false, reason: "semantic repair grant digest is stale" };
  }
  const now = input.recordedAt ?? new Date().toISOString();
  if (state.status === "reserved") {
    if (!input.projectMutation || !matchingPending(state, input)) return { handled: true, allowed: false, bypassPhase: false, reason: "semantic repair reservation does not match this call" };
    state.status = "authorized"; state.pending!.authorized = true; state.updatedAt = now;
    return { handled: true, allowed: true, bypassPhase: true, state: writeState(input.cwd, state) };
  }
  if (state.pending || state.status === "authorized" || state.status === "verifier-pending") return { handled: true, allowed: false, bypassPhase: false, reason: "semantic repair has an unresolved tool call" };
  if (state.status === "retry-ready") {
    if (!input.exactVerifier) return denyActiveCall(input.cwd, state, "semantic repair retry permits only the same exact verifier", input.recordedAt);
    state.status = "verifier-pending";
    state.pending = { toolCallId: input.toolCallId, toolName: input.toolName, kind: "verifier", opensRepair: false, preDigest: input.currentDigest, targetPaths: [], authorized: true, retryVerifier: true, reservationTokenHash: null };
    state.updatedAt = now;
    return { handled: true, allowed: true, bypassPhase: false, state: writeState(input.cwd, state) };
  }
  if (state.status !== "active") return { handled: true, allowed: false, bypassPhase: false, reason: `semantic repair is ${state.status}` };
  if (input.exactVerifier) {
    if (state.successfulMutationsInRevision < 1) return denyActiveCall(input.cwd, state, "semantic repair verifier requires a successful mutation in this revision", input.recordedAt);
    state.status = "verifier-pending";
    state.pending = { toolCallId: input.toolCallId, toolName: input.toolName, kind: "verifier", opensRepair: false, preDigest: input.currentDigest, targetPaths: [], authorized: true, retryVerifier: false, reservationTokenHash: null };
    state.updatedAt = now;
    return { handled: true, allowed: true, bypassPhase: false, state: writeState(input.cwd, state) };
  }
  if (input.projectMutation) {
    const targets = uniquePaths(input.targetPaths);
    if (input.targetExtractionComplete === false) return denyActiveCall(input.cwd, state, "semantic repair mutation targets are not statically complete", input.recordedAt);
    if (targets.length === 0 || targets.some((file) => !state.eligiblePaths.includes(file))) return denyActiveCall(input.cwd, state, "semantic repair mutation is outside the exact persisted grant", input.recordedAt);
    if (state.successfulMutations >= MAX_SEMANTIC_REPAIR_MUTATIONS) return denyActiveCall(input.cwd, state, "semantic repair mutation budget is complete", input.recordedAt);
    state.pending = { toolCallId: input.toolCallId, toolName: input.toolName, kind: "mutation", opensRepair: false, preDigest: input.currentDigest, targetPaths: targets, authorized: true, retryVerifier: false, reservationTokenHash: null };
    state.updatedAt = now;
    return { handled: true, allowed: true, bypassPhase: false, state: writeState(input.cwd, state) };
  }
  if (input.shellLike || input.opaqueCarrier) return denyActiveCall(input.cwd, state, "semantic repair opaque carrier access requires a bounded granted mutation or the exact verifier", input.recordedAt);
  return { handled: false, allowed: false, bypassPhase: false };
}

export function rejectSemanticRepairCall(input: { cwd: string; taskRunId: string; toolCallId: string; recordedAt?: string }): SemanticRepairState | undefined {
  const view = readSemanticRepairState(input.cwd, input.taskRunId), state = view.state;
  if (!view.enforcementSafe || !state?.pending || state.pending.toolCallId !== input.toolCallId) return state;
  const opens = state.pending.opensRepair, retry = state.pending.retryVerifier;
  state.deniedCalls += 1; state.pending = null; state.status = unsuccessful(state) >= MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS ? "locked" : opens ? "cancelled" : "active";
  if (state.status === "active" && retry) state.status = "retry-ready";
  state.updatedAt = input.recordedAt ?? new Date().toISOString();
  return writeState(input.cwd, state);
}

export function pendingSemanticRepairCall(cwd: string, taskRunId: string, toolCallId: string): RepairPendingCall | undefined {
  const view = readSemanticRepairState(cwd, taskRunId), pending = view.state?.pending;
  return view.enforcementSafe && pending?.toolCallId === toolCallId && pending.authorized ? structuredClone(pending) : undefined;
}

export function completeSemanticRepairCall(input: {
  cwd: string; taskRunId: string; toolCallId: string; success: boolean; exitCode?: number;
  currentDigest: string; changedPaths: string[]; retryableFailure?: boolean; correctiveFailure?: boolean; recordedAt?: string;
}): { result: "unmatched" | "opened" | "recorded" | "retry" | "correction" | "passed" | "cancelled" | "locked"; state?: SemanticRepairState } {
  const view = readSemanticRepairState(input.cwd, input.taskRunId), state = view.state;
  if (!view.enforcementSafe || !state?.pending || state.pending.toolCallId !== input.toolCallId) return { result: "unmatched", state };
  if (state.successfulMutations > 0 && !semanticRepairOriginMatches(input.cwd, state)) {
    state.status = "locked"; state.pending = null; state.updatedAt = input.recordedAt ?? new Date().toISOString();
    return { result: "locked", state: writeState(input.cwd, state) };
  }
  const pending = state.pending, changed = uniquePaths(input.changedPaths), treeChanged = input.currentDigest !== pending.preDigest;
  const now = input.recordedAt ?? new Date().toISOString();
  if (!pending.authorized) { state.status = "locked"; state.pending = null; state.updatedAt = now; return { result: "locked", state: writeState(input.cwd, state) }; }
  if (pending.kind === "verifier") {
    state.pending = null; state.updatedAt = now;
    if (!treeChanged && input.success && (input.exitCode === undefined || input.exitCode === 0)) { state.status = "passed"; return { result: "passed", state: writeState(input.cwd, state) }; }
    state.failedCalls += 1;
    if (treeChanged || unsuccessful(state) >= MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS) state.status = "locked";
    else if (input.retryableFailure && !state.transientRetryUsed) { state.transientRetryUsed = true; state.status = "retry-ready"; }
    else if (input.correctiveFailure && state.revision < MAX_SEMANTIC_REPAIR_REVISIONS) { state.revision += 1; state.successfulMutationsInRevision = 0; state.status = "active"; }
    else state.status = "locked";
    const result = state.status === "retry-ready" ? "retry" : state.status === "active" ? "correction" : "locked";
    return { result, state: writeState(input.cwd, state) };
  }
  const unexpected = changed.length === 0 || changed.some((file) => !pending.targetPaths.includes(file) || !state.eligiblePaths.includes(file));
  if (treeChanged && (!input.success || unexpected)) { state.status = "locked"; state.pending = null; state.updatedAt = now; return { result: "locked", state: writeState(input.cwd, state) }; }
  if (input.success && treeChanged) {
    if (pending.opensRepair) writeSemanticRepairOrigin(input.cwd, state, input.currentDigest, now);
    state.successfulMutations += 1; state.successfulMutationsInRevision += 1; state.currentDigest = input.currentDigest; state.status = "active"; state.pending = null; state.updatedAt = now;
    return { result: pending.opensRepair ? "opened" : "recorded", state: writeState(input.cwd, state) };
  }
  if (input.success) state.noOpCalls += 1; else state.failedCalls += 1;
  state.pending = null; state.status = unsuccessful(state) >= MAX_SEMANTIC_REPAIR_UNSUCCESSFUL_CALLS ? "locked" : pending.opensRepair ? "cancelled" : "active"; state.updatedAt = now;
  return { result: state.status === "locked" ? "locked" : "cancelled", state: writeState(input.cwd, state) };
}

export function semanticRepairResumeDecision(input: { cwd: string; taskRunId: string; taskId: string; sessionId: string; currentDigest: string }): { openRepair: boolean; blockReason?: string } {
  const view = readSemanticRepairState(input.cwd, input.taskRunId), state = view.state;
  if (!view.enforcementSafe) return { openRepair: false, blockReason: view.warnings[0] };
  if (!state) return { openRepair: false, blockReason: semanticRepairStateRequired(input.cwd, input.taskRunId) ? "required semantic repair state is missing" : undefined };
  if (state.successfulMutations > 0 && !semanticRepairOriginMatches(input.cwd, state)) return { openRepair: false, blockReason: "semantic repair durable origin is missing or invalid" };
  if (["passed", "cancelled"].includes(state.status)) return { openRepair: false };
  if (state.taskId !== input.taskId || state.sessionId !== input.sessionId) return { openRepair: false, blockReason: "semantic repair identity mismatch" };
  if (["active", "retry-ready"].includes(state.status) && !state.pending && state.currentDigest === input.currentDigest) return { openRepair: true };
  return { openRepair: false, blockReason: state.status === "locked" ? "semantic repair grant is locked" : "semantic repair state has an unresolved or stale call" };
}

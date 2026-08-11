import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { safeTaskId } from "../../extensions/task-state.js";
import type { HelperRequest, HelperRole } from "./role-policy.ts";
import { validateHelperRequest } from "./role-policy.ts";

export const OWNED_WORK_BUDGET_VERSION = "owned-work-budget-v1" as const;
export type OwnedWorkCeilings = Readonly<{ maxConcurrentHelpers: number; maxTotalHelpers: number; maxScoutPasses: number; maxPlannerPasses: number; maxReviewPasses: number; maxOracleCalls: number; maxRepairPasses: number; maxWriters: number }>;
export const DEFAULT_OWNED_WORK_CEILINGS: OwnedWorkCeilings = Object.freeze({ maxConcurrentHelpers: 2, maxTotalHelpers: 3, maxScoutPasses: 1, maxPlannerPasses: 1, maxReviewPasses: 1, maxOracleCalls: 1, maxRepairPasses: 1, maxWriters: 1 });
export const AUTOMATIC_OWNED_WORK_CEILINGS: OwnedWorkCeilings = Object.freeze({ ...DEFAULT_OWNED_WORK_CEILINGS, maxConcurrentHelpers: 1, maxTotalHelpers: 1 });
const LOCK_WAIT_MS = 5;
const LOCK_WAIT_CEILING_MS = 250;
const STALE_LOCK_MS = 30_000;
type Reservation = { id: string; deduplicationKey: string; role: HelperRole; authority: string; status: "active" | "succeeded" | "failed" | "cancelled" | "orphaned"; reservedAt: string; expiresAt: string; completedAt: string | null; usageRef: { calls: number; tokens: number; outputDigest: string | null } | null };
type BudgetState = { version: typeof OWNED_WORK_BUDGET_VERSION; taskId: string; taskRunId: string; terminal: boolean; reservations: Reservation[]; updatedAt: string };
export type HelperReleaseResult = { accepted: boolean; status: Reservation["status"] | "stale"; reason: "released" | "helper-call-budget-exceeded" | "helper-token-budget-exceeded" | "reservation-not-active" };

function digest(value: unknown): string { return crypto.createHash("sha256").update(String(value ?? "")).digest("hex"); }
function statePath(cwd: string, taskRunId: string): string { return path.join(cwd, ".pi", "piagent-state", "helper-budgets", `${safeTaskId(taskRunId)}.json`); }
function lockPath(cwd: string, taskRunId: string): string { return `${statePath(cwd, taskRunId)}.lock`; }
function empty(request: HelperRequest, now: string): BudgetState { return { version: OWNED_WORK_BUDGET_VERSION, taskId: request.taskId, taskRunId: request.taskRunId, terminal: false, reservations: [], updatedAt: now }; }
function active(state: BudgetState): Reservation[] { return state.reservations.filter((item) => item.status === "active"); }
function roleLimit(role: HelperRole): number { return role === "scout" || role === "retriever" || role === "researcher" ? 1 : role === "planner" ? 1 : role === "reviewer" ? 1 : role === "oracle" ? 1 : role === "worker" ? 1 : 0; }

function read(cwd: string, request: HelperRequest, now: string): BudgetState {
  const target = statePath(cwd, request.taskRunId); if (!fs.existsSync(target)) return empty(request, now);
  const resolved = resolveLocalStatePath(cwd, target, { label: "Helper budget state", kind: "file" });
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (value?.version !== OWNED_WORK_BUDGET_VERSION || value.taskId !== request.taskId || value.taskRunId !== request.taskRunId || !Array.isArray(value.reservations)) throw new Error("helper budget identity/state is invalid");
  return value;
}
function write(cwd: string, state: BudgetState): void {
  const target = statePath(cwd, state.taskRunId); ensurePrivateStateDirectory(cwd, path.dirname(target), "Helper budget directory");
  resolveLocalStatePath(cwd, target, { label: "Helper budget state", allowMissingLeaf: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); fs.renameSync(temporary, target); fs.chmodSync(target, 0o600);
}
function withLock<T>(cwd: string, taskRunId: string, action: () => T): T {
  ensurePrivateStateDirectory(cwd, path.dirname(statePath(cwd, taskRunId)), "Helper budget directory");
  const lock = lockPath(cwd, taskRunId); resolveLocalStatePath(cwd, lock, { label: "Helper budget lock", allowMissingLeaf: true });
  const started = Date.now(); let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lock); } catch {}
      if (Date.now() - started >= LOCK_WAIT_CEILING_MS) throw new Error("helper budget reservation is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    return action();
  } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}
function recoverOrphans(state: BudgetState, now: string): number {
  let recovered = 0; const instant = Date.parse(now);
  for (const item of state.reservations) if (item.status === "active" && Date.parse(item.expiresAt) <= instant) { item.status = "orphaned"; item.completedAt = now; recovered += 1; }
  return recovered;
}

export class OwnedWorkBudgetController {
  reserve(cwd: string, requestInput: HelperRequest, now = new Date().toISOString(), ceilings: OwnedWorkCeilings = DEFAULT_OWNED_WORK_CEILINGS): { decision: "reserved" | "duplicate" | "blocked"; reason: string; reservationId: string | null; recoveredOrphans: number } {
    const request = validateHelperRequest(structuredClone(requestInput));
    return withLock(cwd, request.taskRunId, () => {
      const state = read(cwd, request, now); const recoveredOrphans = recoverOrphans(state, now);
      if (state.terminal) return { decision: "blocked", reason: "parent-task-terminal", reservationId: null, recoveredOrphans };
      const duplicate = state.reservations.find((item) => item.deduplicationKey === request.deduplicationKey && ["active", "succeeded"].includes(item.status));
      if (duplicate) return { decision: "duplicate", reason: "equivalent-helper-already-owned", reservationId: duplicate.id, recoveredOrphans };
      if (active(state).length >= ceilings.maxConcurrentHelpers || state.reservations.length >= ceilings.maxTotalHelpers) return { decision: "blocked", reason: "helper-budget-exhausted", reservationId: null, recoveredOrphans };
      if (state.reservations.filter((item) => item.role === request.role).length >= roleLimit(request.role)) return { decision: "blocked", reason: `${request.role}-ceiling-reached`, reservationId: null, recoveredOrphans };
      if (request.authority === "single-writer" && active(state).some((item) => item.authority === "single-writer")) return { decision: "blocked", reason: "single-writer-already-owned", reservationId: null, recoveredOrphans };
      const id = digest(`${request.taskRunId}:${request.deduplicationKey}:${state.reservations.length}`).slice(0, 32);
      state.reservations.push({ id, deduplicationKey: request.deduplicationKey, role: request.role, authority: request.authority, status: "active", reservedAt: now, expiresAt: new Date(Date.parse(now) + request.ceilings.timeSeconds * 1000).toISOString(), completedAt: null, usageRef: null });
      state.updatedAt = now; write(cwd, state); return { decision: "reserved", reason: "budget-reserved", reservationId: id, recoveredOrphans };
    });
  }
  release(cwd: string, requestInput: HelperRequest, reservationId: string, outcome: "succeeded" | "failed" | "cancelled", usage: { calls?: number; tokens?: number; output?: string } = {}, now = new Date().toISOString()): HelperReleaseResult {
    const request = validateHelperRequest(structuredClone(requestInput)); return withLock(cwd, request.taskRunId, () => {
      const state = read(cwd, request, now); const reservation = state.reservations.find((item) => item.id === reservationId);
      if (!reservation || reservation.status !== "active") return { accepted: false, status: reservation?.status ?? "stale", reason: "reservation-not-active" };
      const rawCalls = Number.isFinite(Number(usage.calls)) ? Math.max(0, Math.floor(Number(usage.calls))) : request.ceilings.calls + 1;
      const rawTokens = Number.isFinite(Number(usage.tokens)) ? Math.max(0, Math.floor(Number(usage.tokens))) : request.contextBudget + 1;
      const callExceeded = rawCalls > request.ceilings.calls, tokenExceeded = rawTokens > request.contextBudget;
      reservation.status = outcome === "succeeded" && (callExceeded || tokenExceeded) ? "failed" : outcome;
      reservation.completedAt = now;
      reservation.usageRef = {
        calls: Math.min(rawCalls, request.ceilings.calls + 1),
        tokens: Math.min(rawTokens, request.contextBudget + 1),
        outputDigest: reservation.status === "succeeded" && usage.output !== undefined ? digest(usage.output) : null
      };
      state.updatedAt = now; write(cwd, state);
      return {
        accepted: true, status: reservation.status,
        reason: callExceeded ? "helper-call-budget-exceeded" : tokenExceeded ? "helper-token-budget-exceeded" : "released"
      };
    });
  }
  markParentTerminal(cwd: string, requestInput: HelperRequest, now = new Date().toISOString()): void { const request = validateHelperRequest(structuredClone(requestInput)); withLock(cwd, request.taskRunId, () => { const state = read(cwd, request, now); state.terminal = true; for (const item of active(state)) { item.status = "cancelled"; item.completedAt = now; } state.updatedAt = now; write(cwd, state); }); }
  snapshot(cwd: string, request: HelperRequest, now = new Date().toISOString()): BudgetState { return structuredClone(read(cwd, validateHelperRequest(request), now)); }
}

import crypto from "node:crypto";
import { redactSensitiveText } from "../../extensions/redaction-core.js";
import type { AuthenticatedModelCatalog } from "../model/authenticated-catalog.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import type { SolverDecision, TaskFeatures } from "../solver/solver-types.ts";
import { bindRole, type RoleBinding } from "./role-binder.ts";
import { AUTOMATIC_OWNED_WORK_CEILINGS, OwnedWorkBudgetController } from "./owned-work-budget.ts";
import { createHelperRequest, defaultRolePolicy, type HelperRequest, type HelperRole } from "./role-policy.ts";

export const HELPERS_MODE_VALUES = Object.freeze(["off", "recommend", "on"] as const);
export type HelpersMode = typeof HELPERS_MODE_VALUES[number];
export type HelperDecision = { mode: HelpersMode; action: "solo" | "recommend" | "dispatch" | "unavailable" | "blocked"; role: HelperRole | null; reasonCodes: string[]; binding: RoleBinding | null; request: HelperRequest | null };
export type HelperDispatchResult = { status: "succeeded" | "failed" | "timeout" | "cancelled"; calls: number; tokens: number; output: string; summary?: string };
export type HelperUsageReceipt = { role: HelperRole; disposition: string; reasonCodes: string[]; requestRef: string; outputDigest: string | null; summary: string | null; mergeOwner: "parent" | null; calls: number; tokens: number; helperUsed: boolean };
type DispatchAdapter = (request: HelperRequest, signal: AbortSignal) => Promise<HelperDispatchResult>;
type DispatchOptions = { timeoutMs?: number };

function digest(value: unknown): string { return crypto.createHash("sha256").update(String(value ?? "")).digest("hex"); }
export function helpersMode(value = process.env.PIAGENT_HELPERS_MODE): HelpersMode { return HELPERS_MODE_VALUES.includes(value as HelpersMode) ? value as HelpersMode : "recommend"; }

export function selectHelperRole(input: { features: TaskFeatures; solver: SolverDecision; confidence?: string; conflictingEvidence?: boolean; repeatedSourceFailure?: boolean; independentReviewUseful?: boolean }): { role: HelperRole | null; reasons: string[] } {
  if (input.features.riskLane === "tiny") return { role: null, reasons: ["tiny-task-solo"] };
  const oracleEligible = input.features.riskLane === "high-risk" && (input.confidence === "low" || input.conflictingEvidence || input.repeatedSourceFailure);
  if (oracleEligible) return { role: "oracle", reasons: ["high-risk-second-opinion", input.conflictingEvidence ? "conflicting-evidence" : input.repeatedSourceFailure ? "repeated-source-failure" : "low-confidence"] };
  if (input.solver.helper.needed && input.solver.helper.role) return { role: input.solver.helper.role as HelperRole, reasons: ["solver-independent-lane"] };
  if (input.independentReviewUseful && input.features.changeMode === "source-change") return { role: "reviewer", reasons: ["independent-review-useful"] };
  return { role: null, reasons: ["solo-sufficient"] };
}

export class HelperLifecycleRuntime {
  readonly #budgets: OwnedWorkBudgetController;
  readonly #active = new Map<string, Set<AbortController>>();
  constructor(budgets = new OwnedWorkBudgetController()) { this.#budgets = budgets; }
  decide(input: { mode: HelpersMode; objective: string; taskId: string; taskRunId: string; sessionId: string; taskScope: string[]; parentAllowedTools: string[]; features: TaskFeatures; solver: SolverDecision; runtime: RuntimeModelSnapshot; catalog: AuthenticatedModelCatalog; confidence?: string; conflictingEvidence?: boolean; repeatedSourceFailure?: boolean; independentReviewUseful?: boolean }): HelperDecision {
    if (input.mode === "off") return { mode: input.mode, action: "solo", role: null, reasonCodes: ["helpers-off"], binding: null, request: null };
    const selection = selectHelperRole(input); if (!selection.role) return { mode: input.mode, action: "solo", role: null, reasonCodes: selection.reasons, binding: null, request: null };
    const policy = defaultRolePolicy(selection.role, input.taskScope);
    const binding = bindRole({ policy, features: input.features, solver: input.solver, runtime: input.runtime, catalog: input.catalog, helperBudgetAvailable: true });
    if (binding.disposition !== "recommended") return { mode: input.mode, action: "unavailable", role: selection.role, reasonCodes: [...selection.reasons, ...binding.reasonCodes], binding, request: null };
    const request = createHelperRequest({ policy, objective: input.objective, taskId: input.taskId, taskRunId: input.taskRunId, sessionId: input.sessionId, parentReadScope: input.taskScope, parentWriteScope: input.taskScope, parentAllowedTools: input.parentAllowedTools, requestedReadScope: input.taskScope, requestedWriteScope: [], model: { provider: binding.provider as string, modelId: binding.modelId as string, effort: binding.effort as string, source: binding.mappingVersion }, singleWriterOwnership: null });
    const action = input.mode === "recommend" ? "recommend" : policy.authority === "read-only" ? "dispatch" : "blocked";
    return { mode: input.mode, action, role: selection.role, reasonCodes: action === "blocked" ? [...selection.reasons, "automatic-worker-disabled"] : selection.reasons, binding, request };
  }
  async dispatch(cwd: string, decision: HelperDecision, adapter: DispatchAdapter, options: DispatchOptions = {}): Promise<HelperUsageReceipt> {
    if (decision.action !== "dispatch" || !decision.request || !decision.role) return { role: decision.role ?? "scout", disposition: decision.action, reasonCodes: decision.reasonCodes, requestRef: "none", outputDigest: null, summary: null, mergeOwner: null, calls: 0, tokens: 0, helperUsed: false };
    const reservation = this.#budgets.reserve(cwd, decision.request, undefined, AUTOMATIC_OWNED_WORK_CEILINGS);
    if (reservation.decision !== "reserved" || !reservation.reservationId) return { role: decision.role, disposition: reservation.reason, reasonCodes: [...decision.reasonCodes, reservation.reason], requestRef: decision.request.deduplicationKey, outputDigest: null, summary: null, mergeOwner: null, calls: 0, tokens: 0, helperUsed: false };
    const controller = new AbortController(), active = this.#active.get(decision.request.taskRunId) ?? new Set<AbortController>();
    active.add(controller); this.#active.set(decision.request.taskRunId, active);
    const ceilingMs = decision.request.ceilings.timeSeconds * 1000;
    const timeoutMs = Math.max(1, Math.min(ceilingMs, Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : ceilingMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HelperDispatchResult>((resolve) => {
      timer = setTimeout(() => { resolve({ status: "timeout", calls: 0, tokens: 0, output: "" }); controller.abort("helper-time-budget-exceeded"); }, timeoutMs);
    });
    let result: HelperDispatchResult;
    try {
      const operation = Promise.resolve(adapter(structuredClone(decision.request), controller.signal))
        .catch(() => ({ status: controller.signal.aborted ? "cancelled" : "failed", calls: 0, tokens: 0, output: "" } as HelperDispatchResult));
      result = await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      active.delete(controller); if (active.size === 0) this.#active.delete(decision.request.taskRunId);
    }
    const terminal = result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
    const released = this.#budgets.release(cwd, decision.request, reservation.reservationId, terminal, { calls: result.calls, tokens: result.tokens, output: result.output });
    const calls = Math.min(Math.max(0, Number(result.calls) || 0), decision.request.ceilings.calls + 1);
    const tokens = Math.min(Math.max(0, Number(result.tokens) || 0), decision.request.contextBudget + 1);
    if (!released.accepted) return { role: decision.role, disposition: released.status === "cancelled" ? "cancelled" : "stale-result", reasonCodes: [...decision.reasonCodes, released.reason], requestRef: decision.request.deduplicationKey, outputDigest: null, summary: null, mergeOwner: null, calls, tokens, helperUsed: true };
    const withinBudget = released.reason === "released", succeeded = result.status === "succeeded" && withinBudget;
    const summary = succeeded && typeof result.summary === "string" ? redactSensitiveText(result.summary).text.replace(/\s+/g, " ").trim().slice(0, 1000) || null : null;
    return { role: decision.role, disposition: withinBudget ? result.status : "budget-exceeded", reasonCodes: withinBudget ? decision.reasonCodes : [...decision.reasonCodes, released.reason], requestRef: decision.request.deduplicationKey, outputDigest: succeeded && result.output ? digest(result.output) : null, summary, mergeOwner: summary ? "parent" : null, calls, tokens, helperUsed: true };
  }
  cancelTask(cwd: string, decision: HelperDecision, now = new Date().toISOString()): number {
    if (!decision.request) return 0;
    this.#budgets.markParentTerminal(cwd, decision.request, now);
    const active = this.#active.get(decision.request.taskRunId); if (!active) return 0;
    for (const controller of active) controller.abort("parent-task-terminal");
    return active.size;
  }
}

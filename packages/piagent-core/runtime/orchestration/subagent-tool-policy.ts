import crypto from "node:crypto";
import path from "node:path";

import type { TaskContract } from "../../extensions/guard-types.js";
import { taskAuthorityMode } from "../policy/task-authority-runtime.ts";
import { MINIMAL_DELEGATION_LIMITS } from "./minimal-delegation-policy.ts";

const SUBAGENT_TOOL = /(?:^|[_-])subagents?(?:[_-]|$)/i;
const NON_DISPATCH_ACTIONS = new Set(["cancel", "kill", "list", "status", "stop", "wait"]);
const READ_ONLY_AGENTS = new Set([
  "piagent-oracle",
  "piagent-planner",
  "piagent-reviewer",
  "piagent-scout"
]);
const URL = /\bhttps?:\/\/[^\s<>)\]}]+/i;
const PROVIDED_SOURCE = /\b(?:provided|supplied|attached|pasted)\s+(?:evidence|source|text)|\busing only (?:the )?(?:evidence|source|text) below|\bdo not (?:fetch|open|retrieve)|\bn[oộ]i dung (?:đ[aã] )?(?:cung c[aấ]p|d[aá]n|đ[ií]nh k[eè]m)/i;

type PlainRecord = Record<string, unknown>;

export type DirectSubagentDispatchPreflight = {
  applicable: boolean;
  dispatch: boolean;
  allowed: boolean;
  reasonCode: string | null;
  reason: string | null;
  role: string | null;
  requestCount: number;
};

export type DirectSubagentResult = {
  applicable: boolean;
  spawned: boolean;
  failed: boolean;
  reasonCode: string | null;
  disposition: string;
  role: "retriever" | "scout" | "planner" | "worker" | "reviewer" | "oracle" | "researcher";
  requestRef: string;
  outputDigest: string | null;
  calls: number;
  tokens: number;
};

type DirectSubagentTaskPersistence = {
  now: () => string;
  persist: (task: TaskContract) => TaskContract;
  trace: (payload: Record<string, unknown>) => void;
  sessionTrace?: (payload: Record<string, unknown>) => void;
};

export function taskHelperUsageMode(task: TaskContract): "off" | "recommend" | "on" {
  const boundMode = taskAuthorityMode(task, "CAP-14");
  return boundMode === "on" || boundMode === "recommend" ? boundMode : "off";
}

export function reserveDirectSubagentDispatch(
  task: TaskContract | undefined,
  toolCallId: string,
  persistence: DirectSubagentTaskPersistence
): TaskContract | undefined {
  if (!task || task.trace.outcome !== "pending" || task.orchestration?.subagents !== "not-used") return task;
  task.orchestration = {
    ...(task.orchestration ?? {
      mode: "solo-first" as const,
      subagents: "not-used" as const,
      reason: "Parent works directly by default."
    }),
    subagents: "optional",
    reason: "One bounded read-only helper dispatch is authorized and awaiting a durable result."
  };
  task.updatedAt = persistence.now();
  const written = persistence.persist(task);
  persistence.trace({
    event: "helper_dispatch_reserved",
    taskId: written.taskId,
    taskRunId: written.taskRunId,
    sessionId: written.sessionId,
    toolCallId
  });
  return written;
}

export function recordDirectSubagentResult(
  task: TaskContract | undefined,
  event: { toolCallId?: string; toolName: string },
  result: DirectSubagentResult,
  persistence: DirectSubagentTaskPersistence
): TaskContract | undefined {
  if (!task || task.trace.outcome !== "pending") return task;
  const existingUsage = task.acceptanceReceipt?.helperUsage;
  const helper = {
    role: result.role,
    disposition: result.disposition,
    requestRef: result.requestRef,
    outputDigest: result.outputDigest,
    calls: result.calls,
    tokens: result.tokens
  };
  const helpers = result.spawned
    ? [...(existingUsage?.helpers ?? []).filter((item) => item.requestRef !== result.requestRef), helper].slice(-3)
    : existingUsage?.helpers ?? [];
  const used = helpers.length > 0 || existingUsage?.used === true;
  const reasonCodes = [...new Set([
    ...(existingUsage?.reasonCodes ?? []),
    result.reasonCode ?? (result.spawned ? "helper-result-accepted" : "helper-dispatch-rejected")
  ])].slice(-16);
  if (task.acceptanceReceipt) {
    task.acceptanceReceipt.helperUsage = {
      mode: taskHelperUsageMode(task),
      used,
      decision: result.spawned ? "dispatch" : "skip",
      projectedSavingsRatio: existingUsage?.projectedSavingsRatio ?? null,
      reasonCodes,
      helpers,
      recordedAt: persistence.now()
    };
  }
  if (task.orchestration) {
    task.orchestration.subagents = used ? "used" : "not-used";
    task.orchestration.reason = result.spawned
      ? `A bounded read-only helper ran with disposition ${result.disposition}; its digest-only usage is recorded in the acceptance receipt.`
      : `Helper dispatch did not start (${result.reasonCode ?? "helper-dispatch-rejected"}); the parent remains the sole execution owner.`;
  }
  task.updatedAt = persistence.now();
  const written = persistence.persist(task);
  const trace = {
    event: "helper_result_recorded",
    taskId: written.taskId,
    taskRunId: written.taskRunId,
    sessionId: written.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    spawned: result.spawned,
    disposition: result.disposition,
    reasonCode: result.reasonCode,
    calls: result.calls,
    tokens: result.tokens
  };
  persistence.trace(trace);
  persistence.sessionTrace?.(trace);
  return written;
}

function record(value: unknown): PlainRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PlainRecord : {};
}

function finiteInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function helperRole(value: unknown): DirectSubagentResult["role"] {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^piagent-/, "");
  return ["retriever", "scout", "planner", "worker", "reviewer", "oracle", "researcher"].includes(normalized)
    ? normalized as DirectSubagentResult["role"]
    : "scout";
}

function dispatchRequests(input: PlainRecord): PlainRecord[] {
  if (Array.isArray(input.tasks)) {
    return input.tasks.filter((item): item is PlainRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({ ...input, ...item, tasks: undefined }));
  }
  return typeof input.agent === "string" && input.agent.trim() ? [input] : [];
}

function boundedNumber(input: PlainRecord, nestedField: string, field: string): number | undefined {
  const nested = record(input[nestedField]);
  const value = nested[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sameProjectRoot(currentCwd: string, requested: unknown): boolean {
  if (typeof requested !== "string" || !requested.trim()) return true;
  return path.resolve(currentCwd) === path.resolve(currentCwd, requested);
}

function blocked(reasonCode: string, reason: string, role: string | null, requestCount: number): DirectSubagentDispatchPreflight {
  return { applicable: true, dispatch: true, allowed: false, reasonCode, reason, role, requestCount };
}

/**
 * The optional pi-subagents tool is a second execution backend. It must not be
 * able to bypass the task-bound CAP-14 snapshot merely because the model knows
 * the tool name. This preflight is deliberately conservative: one fresh,
 * read-only, locally capable helper, with the same hard ceilings as Piagent's
 * owned helper runtime.
 */
export function evaluateDirectSubagentDispatch(input: {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  helpersMode: "off" | "recommend" | "on";
  taskPending: boolean;
  dispatchAuthority: boolean;
  durableSubagentState?: "not-used" | "optional" | "used";
}): DirectSubagentDispatchPreflight {
  if (!SUBAGENT_TOOL.test(input.toolName)) {
    return { applicable: false, dispatch: false, allowed: true, reasonCode: null, reason: null, role: null, requestCount: 0 };
  }
  const toolInput = record(input.toolInput);
  const requests = dispatchRequests(toolInput);
  const action = String(toolInput.action ?? "").trim().toLowerCase();
  if (requests.length === 0 && NON_DISPATCH_ACTIONS.has(action)) {
    return { applicable: true, dispatch: false, allowed: true, reasonCode: null, reason: null, role: null, requestCount: 0 };
  }
  if (requests.length === 0) return blocked("helper-dispatch-shape-invalid", "Subagent dispatch requires exactly one named read-only helper.", null, 0);
  const role = String(requests[0].agent ?? "").trim();
  if (requests.length !== 1) return blocked("helper-count-exceeds-one", `Piagent permits at most one helper for the entire task; ${requests.length} were requested.`, role || null, requests.length);
  if (!input.taskPending) return blocked("helper-task-authority-missing", "A pending session-bound task is required before helper dispatch.", role || null, 1);
  if (input.helpersMode !== "on" || !input.dispatchAuthority) {
    return blocked("helper-dispatch-authority-disabled", "Task-bound helper authority is not on; continue in the parent model.", role || null, 1);
  }
  if (input.durableSubagentState === "optional" || input.durableSubagentState === "used") {
    return blocked("helper-retry-forbidden", "This task already reserved or used its one helper; helper retries are disabled.", role || null, 1);
  }
  if (role === "piagent-worker" || !READ_ONLY_AGENTS.has(role)) {
    return blocked("automatic-helper-role-disabled", `Automatic helper ${role || "(unknown)"} is not an enabled read-only Piagent role.`, role || null, 1);
  }
  const request = requests[0];
  if (request.context !== undefined && request.context !== "fresh") {
    return blocked("helper-parent-history-forbidden", "Helpers must use fresh isolated context and cannot fork the parent transcript.", role, 1);
  }
  if (!sameProjectRoot(input.cwd, request.cwd)) {
    return blocked("helper-cwd-outside-project", "Helper cwd must remain the current project root.", role, 1);
  }
  const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : undefined;
  if (timeoutMs === undefined) {
    return blocked("helper-time-budget-missing", "Helper dispatch requires an explicit timeoutMs no greater than 300 seconds.", role, 1);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs > 300_000 || timeoutMs < 1) {
    return blocked("helper-time-budget-exceeded", "Helper timeout must be between 1 ms and the 300 second Piagent ceiling.", role, 1);
  }
  const maxTurns = boundedNumber(request, "turnBudget", "maxTurns");
  if (maxTurns === undefined) {
    return blocked("helper-turn-budget-missing", "Helper dispatch requires an explicit turnBudget.maxTurns no greater than 8.", role, 1);
  }
  if (maxTurns < 1 || maxTurns > 8) {
    return blocked("helper-turn-budget-exceeded", "Helper maxTurns exceeds the bounded 8-turn ceiling.", role, 1);
  }
  const hardCalls = boundedNumber(request, "toolBudget", "hard");
  if (hardCalls === undefined) {
    return blocked("helper-call-budget-missing", `Helper dispatch requires an explicit toolBudget.hard no greater than ${MINIMAL_DELEGATION_LIMITS.maxHelperCalls}.`, role, 1);
  }
  if (hardCalls < 1 || hardCalls > MINIMAL_DELEGATION_LIMITS.maxHelperCalls) {
    return blocked("helper-call-budget-exceeded", `Helper hard tool budget exceeds the ${MINIMAL_DELEGATION_LIMITS.maxHelperCalls}-call ceiling.`, role, 1);
  }
  const objective = String(request.task ?? "").trim();
  if (!objective) return blocked("helper-objective-missing", "Helper dispatch requires a bounded objective.", role, 1);
  if (URL.test(objective) && !PROVIDED_SOURCE.test(objective)) {
    return blocked("helper-source-access-unavailable", "The selected helper has local read tools only and cannot retrieve the remote URL; inspect it in the parent or provide a local checkout/evidence bundle.", role, 1);
  }
  return { applicable: true, dispatch: true, allowed: true, reasonCode: null, reason: null, role, requestCount: 1 };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text")
    .map((item) => String((item as { text?: unknown }).text ?? "")).join("\n");
}

function childAcceptanceFailed(result: PlainRecord): boolean {
  const acceptance = record(result.acceptance);
  const report = record(acceptance.childReport);
  const criteria = Array.isArray(report.criteriaSatisfied) ? report.criteriaSatisfied : [];
  return criteria.some((item) => record(item).status === "not-satisfied")
    || ["failed", "rejected", "not-satisfied"].includes(String(acceptance.status ?? "").toLowerCase());
}

function totalUsage(details: PlainRecord, results: PlainRecord[]): number {
  const aggregate = record(details.totalChildUsage);
  const sources = Object.keys(aggregate).length > 0 ? [aggregate] : results.map((result) => record(result.usage));
  return Math.min(100_000_000, sources.reduce((total, usage) => total
    + finiteInteger(usage.input)
    + finiteInteger(usage.output)
    + finiteInteger(usage.cacheRead)
    + finiteInteger(usage.cacheWrite), 0));
}

/** Convert a pi-subagents provider result into fail-closed, digest-only truth. */
export function classifyDirectSubagentResult(input: {
  toolName: string;
  toolInput: unknown;
  content: unknown;
  details: unknown;
  isError?: boolean;
}): DirectSubagentResult | undefined {
  if (!SUBAGENT_TOOL.test(input.toolName)) return undefined;
  const toolInput = record(input.toolInput);
  if (dispatchRequests(toolInput).length === 0) return undefined;
  const details = record(input.details);
  const results = Array.isArray(details.results)
    ? details.results.filter((item): item is PlainRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const spawned = results.length > 0 || typeof details.runId === "string" && details.runId.length > 0;
  const resultFailures = results.some((result) => finiteInteger(result.exitCode) !== 0 || childAcceptanceFailed(result));
  const content = textContent(input.content);
  const insufficientEvidence = results.some(childAcceptanceFailed)
    || /\bscope inspected:\s*none\b|\bno source (?:content|evidence) (?:was|could be) (?:accessible|collected)|\bcriteria?[^\n]{0,80}not-satisfied\b/i.test(content);
  const failed = input.isError === true || !spawned || resultFailures || insufficientEvidence;
  const reasonCode = input.isError === true
    ? "helper-tool-error"
    : !spawned
      ? "helper-dispatch-rejected"
      : insufficientEvidence
        ? "helper-insufficient-evidence"
        : resultFailures
          ? "helper-run-failed"
          : null;
  const firstResult = results[0] ?? {};
  const agent = firstResult.agent ?? dispatchRequests(toolInput)[0]?.agent;
  const finalOutput = results.map((result) => String(result.finalOutput ?? "")).filter(Boolean).join("\n");
  const calls = Math.min(100, results.reduce((total, result) => total + finiteInteger(result.toolCount), 0));
  return {
    applicable: true,
    spawned,
    failed,
    reasonCode,
    disposition: failed ? reasonCode ?? "failed" : "succeeded",
    role: helperRole(agent),
    requestRef: crypto.createHash("sha256").update(JSON.stringify(toolInput)).digest("hex"),
    outputDigest: !failed && finalOutput ? crypto.createHash("sha256").update(finalOutput).digest("hex") : null,
    calls,
    tokens: totalUsage(details, results)
  };
}

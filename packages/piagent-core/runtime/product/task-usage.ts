import { inspectContextTelemetry } from "../../extensions/context-engine.js";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { firstCorrectEditTiming, type CompletionSource } from "./edit-verifier-timing.ts";

type Event = Record<string, any>;
type Inspection = { records: Event[]; exists: boolean; integrityFailures: number; recoverableTailBytes: number; inputTruncated: boolean };
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function projectTaskUsage(task: Pick<TaskContract, "taskId" | "taskRunId" | "sessionId">, inspection: Inspection) {
  const records = inspection.records.filter((event) => event.taskUsageVersion === 1
    && event.sessionId === task.sessionId && event.taskId === task.taskId && event.taskRunId === task.taskRunId);
  const warnings = new Set<string>();
  if (!inspection.exists) warnings.add("telemetry-unavailable");
  if (inspection.inputTruncated || inspection.integrityFailures || inspection.recoverableTailBytes) warnings.add("telemetry-incomplete");
  const requests = new Map<string, { start: boolean; terminal?: Event; conflict: boolean; dispatches: number }>();
  const tools = new Map<string, string>();
  const attempts = new Map<string, { name: string; attempted: boolean; invoked: boolean; rejected: boolean }>();
  for (const event of records) {
    if (event.event === "task_tool_started") warnings.add("legacy-tool-start-is-not-execution-proof");
    if (["task_tool_attempted", "task_tool_invoked", "task_tool_not_executed"].includes(event.event)) {
      if (typeof event.toolCallId !== "string" || !event.toolCallId || typeof event.toolName !== "string"
        || typeof event.requestId !== "string" || !event.requestId) { warnings.add("tool-identity-unavailable"); continue; }
      const id = `${event.requestId}\u0000${event.toolCallId}`;
      const call = attempts.get(id) ?? { name: event.toolName, attempted: false, invoked: false, rejected: false };
      if (call.name !== event.toolName) warnings.add("tool-identity-conflict");
      call.attempted ||= event.event === "task_tool_attempted";
      call.invoked ||= event.event === "task_tool_invoked";
      call.rejected ||= event.event === "task_tool_not_executed";
      attempts.set(id, call);
      if (call.invoked) tools.set(id, call.name);
      continue;
    }
    if (!["task_usage_request", "task_usage_dispatch", "task_usage_terminal"].includes(event.event)) continue;
    if (typeof event.requestId !== "string" || !event.requestId) { warnings.add("request-identity-unavailable"); continue; }
    const request = requests.get(event.requestId) ?? { start: false, conflict: false, dispatches: 0 };
    requests.set(event.requestId, request);
    if (event.event === "task_usage_request") request.start = true;
    if (Number.isSafeInteger(event.providerRequests)) request.dispatches = Math.max(request.dispatches, event.providerRequests);
    if (event.event !== "task_usage_terminal") continue;
    if (event.usageSemantics !== "request-cumulative") { request.conflict = true; continue; }
    const material = (value: Event) => JSON.stringify([FIELDS.map((field) => value.usage?.[field] ?? null), value.cost ?? null, value.stopReason]);
    if (request.terminal && material(request.terminal) !== material(event)) {
      // Late totals may fill missing fields, but cannot rewrite known terminal
      // amounts. Deltas/session cumulative snapshots are never summed here.
      const previous = request.terminal;
      if (FIELDS.some((field) => previous.usage?.[field] != null && event.usage?.[field] != null && previous.usage[field] !== event.usage[field])
        || (previous.cost != null && event.cost != null && previous.cost !== event.cost) || previous.stopReason !== event.stopReason) request.conflict = true;
      request.terminal = { ...event, cost: previous.cost ?? event.cost,
        usage: Object.fromEntries(FIELDS.map((field) => [field, previous.usage?.[field] ?? event.usage?.[field]])) };
      continue;
    }
    request.terminal = event;
  }
  const sums = Object.fromEntries(FIELDS.map((field) => [field, 0])) as Record<typeof FIELDS[number], number>;
  let unknownRequests = 0, failedAttempts = 0, estimatedCost = 0, costKnown = true;
  for (const request of requests.values()) {
    const event = request.terminal;
    if (event && ["error", "aborted"].includes(event.stopReason)) failedAttempts += 1;
    if (!request.start || !event || request.conflict || request.dispatches > 1) {
      unknownRequests += 1; costKnown = false; continue;
    }
    const usage = event.usage;
    const numeric = FIELDS.every((field) => validNumber(usage?.[field]) && Number.isSafeInteger(usage[field]));
    const consistent = numeric && usage.totalTokens === usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    // SDK error messages may contain synthetic all-zero usage after a billed
    // abort. Zero on these paths is not proof that nothing was charged.
    if (!consistent || (["error", "aborted", "unknown"].includes(event.stopReason) && usage.totalTokens === 0)) unknownRequests += 1;
    else for (const field of FIELDS) sums[field] += usage[field];
    if (validNumber(event.cost) && event.costBasis === "sdk-rate-estimate") estimatedCost += event.cost;
    else costKnown = false;
  }
  if (Object.values(sums).some((sum) => !Number.isSafeInteger(sum))) warnings.add("usage-overflow");
  if (!requests.size) warnings.add("request-coverage-unavailable");
  if (unknownRequests) warnings.add("request-usage-unknown");
  if ([...attempts.values()].some((call) => !call.attempted || call.invoked === call.rejected)) warnings.add("tool-execution-unconfirmed");
  const complete = warnings.size === 0;
  const counts: Record<string, number> = {};
  for (const name of tools.values()) Object.defineProperty(counts, name, { value: (Object.hasOwn(counts, name) ? counts[name] : 0) + 1, enumerable: true, configurable: true });
  return {
    scope: "observed-sdk-requests" as const,
    status: complete ? "observed" as const : "unknown" as const,
    requests: requests.size, unknownRequests, failedAttempts: complete ? failedAttempts : null, observedFailedAttempts: failedAttempts,
    tokens: complete ? sums.totalTokens : null,
    components: complete ? sums : null,
    knownTokenSubtotal: sums.totalTokens,
    sdkEstimatedCost: complete && costKnown ? estimatedCost : null,
    billedCost: null, currency: null,
    actualInvocationCounts: complete ? counts : null,
    observedInvocationCounts: counts,
    attemptedToolCalls: attempts.size,
    notExecutedToolCalls: [...attempts.values()].filter((call) => call.rejected && !call.invoked).length,
    warnings: [...warnings],
    limitations: ["SDK reported usage; not an end-to-end billing receipt", "Coverage limited to instrumented requests; pre-instrumentation and hidden provider retries unavailable"]
  };
}

export function readTaskUsage(cwd: string, task: TaskContract, source?: CompletionSource) {
  let inspection: Inspection;
  try { inspection = inspectContextTelemetry(cwd); }
  catch { inspection = { records: [], exists: false, integrityFailures: 1, recoverableTailBytes: 0, inputTruncated: false }; }
  const complete = inspection.exists && !inspection.integrityFailures && !inspection.recoverableTailBytes && !inspection.inputTruncated;
  return { ...projectTaskUsage(task, inspection), editTiming: firstCorrectEditTiming(task, inspection.records, complete, source) };
}

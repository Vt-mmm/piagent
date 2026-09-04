import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { taskDeltaFilesFromSnapshot } from "../../extensions/task-contract-view.js";
import { recordCompletionAudit } from "../../extensions/task-runtime-audit.js";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import { protectedRefusalHandoffMatches } from "../quality/protected-refusal-handoff.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncOptions, TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
export { protectedRefusalHandoffMatches } from "../quality/protected-refusal-handoff.ts";

type RefusalGate = { decision: "fail"; missing: string[]; missingVerifyCommands: string[] };
type Dependencies = {
  state: RuntimeSessionState;
  writeTask: (cwd: string, task: TaskContract) => TaskContract;
  activateBaseTools: (ctx: ExtensionContext) => unknown;
  appendTrace: (cwd: string, payload: Record<string, unknown>) => void;
  appendSessionTrace: (pi: ExtensionAPI, payload: Record<string, unknown>) => void;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  syncTrajectory?: (ctx: ExtensionContext, task: TaskContract, options: TrajectorySyncOptions) => TrajectorySyncResult;
};

export function nativeProtectedRefusalEligible(task: TaskContract, currentDigests: Record<string, string>): boolean {
  const changedFiles = taskDeltaFilesFromSnapshot(task, currentDigests);
  const protectedContextObserved = [...task.contextManifest, ...task.memoryCitations].some((entry) =>
    matchesProtectedPath(entry.path, task.protectedPaths));
  return changedFiles.length === 0 && task.observedChangedFiles.length === 0 && !protectedContextObserved;
}

export function settleNativeProtectedRefusal(input: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  task: TaskContract;
  response: string;
  currentDigests: Record<string, string>;
  enabled: boolean;
  dependencies: Dependencies;
  persistHandoff: (ctx: ExtensionContext, task: TaskContract, gate: RefusalGate,
    currentDigests: Record<string, string>, recovery: null) => void;
}): boolean {
  const { pi, ctx, response, currentDigests, enabled, dependencies, persistHandoff } = input;
  if (!enabled || !protectedRefusalHandoffMatches(input.task.operatorRequest, response)
    || !nativeProtectedRefusalEligible(input.task, currentDigests)) return false;
  const gate: RefusalGate = {
    decision: "fail",
    missing: ["operator-directed protected-material request was safely refused"],
    missingVerifyCommands: []
  };
  observeTrajectorySync(ctx, dependencies.syncTrajectory?.(ctx, input.task, {
    sourceHook: "completion", handoffObserved: true
  }), dependencies.telemetry);
  const task = dependencies.writeTask(ctx.cwd, {
    ...input.task,
    changedFiles: [],
    finalWorkingTreeFiles: Object.keys(currentDigests).sort(),
    finalFileDigests: currentDigests,
    failureReason: "protected-material-request-refused",
    trace: {
      outcome: "blocked",
      terminalDisposition: "refused",
      friction: "Protected material access and export were refused without reading or mutating project files.",
      notes: "Native refusal fallback matched only the operator-declared durable refusal markers.",
      recordedAt: new Date().toISOString()
    }
  });
  observeTrajectorySync(ctx, dependencies.syncTrajectory?.(ctx, task, { sourceHook: "completion" }), dependencies.telemetry);
  dependencies.state.clearObservedContext(ctx);
  dependencies.activateBaseTools(ctx);
  recordCompletionAudit(ctx, task, {
    outcome: "blocked",
    evidence: { terminalDisposition: "refused", changedFiles: [], protectedContextObserved: false }
  });
  persistHandoff(ctx, task, gate, currentDigests, null);
  const trace = {
    event: "task_policy_refused",
    taskId: task.taskId,
    taskRunId: task.taskRunId,
    sessionId: task.sessionId,
    terminalDisposition: "refused",
    changedFiles: []
  };
  dependencies.appendTrace(ctx.cwd, trace);
  dependencies.appendSessionTrace(pi, trace);
  dependencies.telemetry(ctx, trace);
  return true;
}

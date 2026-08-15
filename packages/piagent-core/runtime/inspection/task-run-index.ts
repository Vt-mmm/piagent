import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { activeSessionTask, listTaskContracts, taskStateMigrationStatus } from "../../extensions/task-state.js";

const MAX_RUNS = 200;
const TERMINAL = new Set(["completed", "blocked", "partial", "failed"]);

type Identity = {
  projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string | null; taskRunId: string | null;
  agentOperationId: null; toolCallId: null;
};

function ref(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(`piagent-webui-task-index-v1\0${value}`).digest("hex").slice(0, 48)}`;
}

export function taskRunOpaqueRef(taskRunId: string): string { return ref("run", taskRunId); }
export function resolveTaskRunRef(cwd: string, runRef: string): any | undefined {
  return listTaskContracts(cwd).find((task: any) => taskRunOpaqueRef(task.taskRunId) === runRef);
}

function display(value: unknown, maximum: number): string {
  return redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function progress(task: any): { completed: number; total: number } {
  const steps = Array.isArray(task.workPlan) ? task.workPlan.slice(0, 12) : [];
  return { completed: steps.filter((step: any) => ["done", "skipped"].includes(step?.status)).length, total: steps.length };
}

function sessionLabel(task: any, isCurrentSession: boolean): string | null {
  const value = display(task.sessionName, 160), rawId = String(task.sessionId ?? "");
  if (!value) return null;
  return rawId && value.includes(rawId) ? isCurrentSession ? "Session hiện tại" : null : value;
}

function run(task: any, currentSessionId: string, activeTaskRunId: string | null) {
  const outcome = ["pending", "completed", "blocked", "partial", "failed"].includes(task.trace?.outcome) ? task.trace.outcome : "unknown";
  const isCurrentSession = task.sessionId === currentSessionId;
  const isActive = isCurrentSession && outcome === "pending" && task.taskRunId === activeTaskRunId;
  return {
    runRef: taskRunOpaqueRef(task.taskRunId), taskRef: ref("task", task.taskId), taskId: task.taskId, taskRunId: task.taskRunId,
    summary: display(task.summary, 240), sessionLabel: sessionLabel(task, isCurrentSession),
    outcome, terminal: TERMINAL.has(outcome), attempt: task.attempt, maxAttempts: task.maxAttempts,
    changeMode: task.changeMode, riskLane: task.riskLane, createdAt: task.createdAt, updatedAt: task.updatedAt,
    isCurrentSession, isActive, progress: progress(task)
  };
}

function revision(runs: unknown[], total: number, corrupt: number, legacy: number): string {
  const digest = createHash("sha256").update(JSON.stringify({ runs, total, corrupt, legacy })).digest("hex");
  return `task-index.${digest}`;
}

export function projectTaskRunIndex(input: {
  cwd: string; identity: Identity; currentSessionId: string; generatedAt?: string; limit?: number;
}): Record<string, unknown> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  try {
    const tasks = listTaskContracts(input.cwd);
    const status = taskStateMigrationStatus(input.cwd);
    const active = activeSessionTask(input.cwd, input.currentSessionId);
    const limit = Math.max(1, Math.min(MAX_RUNS, input.limit ?? 100));
    const rows = tasks.map((task: any) => run(task, input.currentSessionId, active?.taskRunId ?? null))
      .sort((left: any, right: any) => Number(right.isActive) - Number(left.isActive) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const returned = rows.slice(0, limit), warnings = [] as Array<{ code: string; count: number; message: string }>;
    if (status.unreadable.length) warnings.push({ code: "corrupt-task-state", count: status.unreadable.length,
      message: `${status.unreadable.length} task state record(s) could not be validated.` });
    if (status.legacy) warnings.push({ code: "legacy-task-state", count: status.legacy,
      message: `${status.legacy} legacy task state record(s) have reduced evidence.` });
    if (rows.length > returned.length) warnings.push({ code: "task-index-truncated", count: rows.length - returned.length,
      message: `${rows.length - returned.length} older task run(s) are outside this bounded page.` });
    const activeRun = returned.find((item: any) => item.isActive);
    return {
      schemaVersion: 1, version: "piagent-webui-task-index-v1", generatedAt, identity: structuredClone(input.identity), state: "ready",
      indexRevision: revision(returned, rows.length, status.unreadable.length, status.legacy), activeRunRef: activeRun?.runRef ?? null,
      runs: returned, page: { total: rows.length, returned: returned.length, truncated: rows.length > returned.length }, warnings,
      health: warnings.length ? { state: "degraded", reasonCode: "task-index-warning", message: "Some task history is unavailable or omitted." }
        : { state: "ok", reasonCode: null, message: null }
    };
  } catch {
    return { schemaVersion: 1, version: "piagent-webui-task-index-v1", generatedAt, identity: structuredClone(input.identity),
      state: "unavailable", indexRevision: null, activeRunRef: null, runs: [], page: { total: 0, returned: 0, truncated: false },
      warnings: [], health: { state: "unavailable", reasonCode: "task-index-unavailable", message: "Task history is unavailable." } };
  }
}

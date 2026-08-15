import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { inspectTaskResumeState } from "../recovery/resume-state.ts";
import { inspectBoundedContextTelemetry } from "./context-telemetry-inspection.ts";
import { taskRunOpaqueRef } from "./task-run-index.ts";

const MAX_EVENTS = 300;
const MAX_TELEMETRY = 5_000;

type Task = {
  taskId: string;
  taskRunId: string;
  sessionId: string;
  [key: string]: any;
};
type Identity = {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string;
  taskRunId: string;
  agentOperationId: null;
  toolCallId: null;
};

function opaque(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(`piagent-webui-recovery-history-v1\0${value}`).digest("hex").slice(0, 48)}`;
}

function display(value: unknown, maximum = 160): string {
  return redactSensitiveText(String(value ?? "")).text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function boundedInteger(value: unknown, maximum = 1_000_000_000): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Math.min(Number(value), maximum) : null;
}

function recoverySummary(cwd: string, task: Task) {
  const resume = inspectTaskResumeState(cwd, task as any, task.sessionId);
  const latestCheckpointRef = resume.latestCheckpoint
    ? opaque("checkpoint", `${task.taskRunId}\0${resume.latestCheckpoint.checkpointId}`)
    : null;
  return {
    decision: resume.decision,
    enforcementSafe: resume.enforcementSafe,
    latestCheckpointRef,
    verifierState: resume.verifierEvidenceCurrent ? "current" : resume.staleVerifierEvidence ? "stale" : "not-current",
    invalidatedFileCount: Math.min(100_000, resume.invalidatedVerifierFiles.length),
    invalidatedFilesKnown: resume.invalidatedVerifierFilesKnown,
    handoffState: !resume.handoff.exists ? "none" : resume.handoff.valid ? "available" : "invalid",
    reasonCode: `recovery-${resume.decision}`
  };
}

function unavailable(identity: Identity, runRef: string, generatedAt: string, reasonCode = "recovery-history-unavailable") {
  return {
    schemaVersion: 1,
    version: "piagent-webui-recovery-history-v1",
    generatedAt,
    identity: structuredClone(identity),
    runRef,
    state: "unavailable",
    historyRevision: null,
    completeness: "unknown",
    summary: { contextCompactions: 0, toolResultCompactions: 0, compactedToolResults: 0 },
    recovery: { decision: "unknown", enforcementSafe: null, latestCheckpointRef: null, verifierState: "unknown",
      invalidatedFileCount: null, invalidatedFilesKnown: false, handoffState: "unknown", reasonCode },
    retainedContent: { access: "omitted", exposed: false, reasonCode: "protected-runtime-evidence" },
    events: [],
    page: { total: 0, returned: 0, truncated: false },
    warnings: [],
    health: { state: "unavailable", reasonCode, message: "Compaction and recovery history is unavailable." }
  };
}

export function projectTaskCompactionHistory(input: {
  cwd: string;
  task: Task;
  identity: Identity;
  generatedAt?: string;
}): Record<string, any> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runRef = taskRunOpaqueRef(input.task.taskRunId);
  try {
    const inspected = inspectBoundedContextTelemetry(input.cwd, { limit: MAX_TELEMETRY });
    let malformed = inspected.corruptions;
    const matching = inspected.records.flatMap((record: any, ordinal: number) => {
      if (record?.taskId !== input.task.taskId || record?.taskRunId !== input.task.taskRunId || record?.sessionId !== input.task.sessionId) return [];
      if (record.schemaVersion !== 1 || !timestamp(record.recordedAt)) { malformed += 1; return []; }
      if (record.event === "session_compact") {
        if (typeof record.willRetry !== "boolean" || typeof record.fromExtension !== "boolean") { malformed += 1; return []; }
        return [{ ordinal, recordedAt: record.recordedAt, kind: "context-compaction", title: "Context đã được compact",
          detail: display(record.reason, 180) || null, toolName: null, originalChars: null, originalLines: null, captureCount: null,
          willRetry: record.willRetry, fromExtension: record.fromExtension }];
      }
      if (record.event === "tool_result" && record.compacted === true) {
        const captureCount = boundedInteger(record.compactedCaptures, 10_000);
        if (captureCount === null || captureCount < 1) { malformed += 1; return []; }
        return [{ ordinal, recordedAt: record.recordedAt, kind: "tool-result-compaction", title: "Tool result đã được rút gọn",
          detail: null, toolName: display(record.toolName, 120) || "tool", originalChars: boundedInteger(record.outputChars),
          originalLines: boundedInteger(record.outputLines), captureCount, willRetry: null, fromExtension: null }];
      }
      return [];
    });
    const projected = matching.map((event: any, index: number) => {
      const fact = { ...event }; delete fact.ordinal;
      const digest = createHash("sha256").update(JSON.stringify({ taskRunId: input.task.taskRunId, ordinal: event.ordinal, fact })).digest("hex");
      return { eventRef: opaque("compaction", `${input.task.taskRunId}\0${digest}`), evidenceRef: opaque("telemetry", digest),
        sequence: index + 1, ...fact };
    });
    const events = projected.slice(-MAX_EVENTS);
    const contextCompactions = projected.filter((event: any) => event.kind === "context-compaction").length;
    const toolResultCompactions = projected.filter((event: any) => event.kind === "tool-result-compaction").length;
    const compactedToolResults = projected.reduce((sum: number, event: any) => sum + (event.captureCount ?? 0), 0);
    const warnings: Array<{ code: string; count: number; message: string }> = [];
    if (!inspected.exists) warnings.push({ code: "telemetry-missing", count: 1, message: "No bounded compaction telemetry was found for this project." });
    if (malformed > 0) warnings.push({ code: "telemetry-corrupt", count: malformed, message: `${malformed} telemetry record(s) could not be validated.` });
    if (inspected.recoverableTailBytes > 0) warnings.push({ code: "telemetry-incomplete-tail", count: inspected.recoverableTailBytes,
      message: "An incomplete telemetry tail may omit the latest compaction fact." });
    if (inspected.inputTruncated) warnings.push({ code: "telemetry-input-truncated", count: 1,
      message: "Older telemetry is outside the bounded inspection window." });
    if (projected.length > events.length) warnings.push({ code: "history-truncated", count: projected.length - events.length,
      message: `${projected.length - events.length} older compaction event(s) are outside this bounded page.` });
    const recovery = recoverySummary(input.cwd, input.task);
    const completeness = !inspected.exists ? "missing" : malformed || inspected.recoverableTailBytes || inspected.inputTruncated ? "partial" : "complete";
    const summary = { contextCompactions, toolResultCompactions, compactedToolResults };
    const historyRevision = `recovery-history.${createHash("sha256").update(JSON.stringify({ events, summary, recovery, completeness })).digest("hex")}`;
    return {
      schemaVersion: 1,
      version: "piagent-webui-recovery-history-v1",
      generatedAt,
      identity: structuredClone(input.identity),
      runRef,
      state: "ready",
      historyRevision,
      completeness,
      summary,
      recovery,
      retainedContent: { access: "omitted", exposed: false, reasonCode: "protected-runtime-evidence" },
      events,
      page: { total: projected.length, returned: events.length, truncated: projected.length > events.length },
      warnings,
      health: warnings.length
        ? { state: "degraded", reasonCode: "recovery-history-warning", message: "Some compaction or recovery facts are unavailable or omitted." }
        : { state: "ok", reasonCode: null, message: null }
    };
  } catch {
    return unavailable(input.identity, runRef, generatedAt);
  }
}

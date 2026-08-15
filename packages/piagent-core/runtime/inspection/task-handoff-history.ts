import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { readHandoffProjection } from "../recovery/handoff-projection.ts";
import { inspectTaskResumeState } from "../recovery/resume-state.ts";
import { inspectBoundedContextTelemetry } from "./context-telemetry-inspection.ts";
import { taskRunOpaqueRef } from "./task-run-index.ts";

const MAX_EVENTS = 100;

type Task = { taskId: string; taskRunId: string; sessionId: string; [key: string]: any };
type Identity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string;
  agentOperationId: null; toolCallId: null };

function opaque(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(`piagent-webui-handoff-history-v1\0${value}`).digest("hex").slice(0, 48)}`;
}

function display(value: unknown, maximum = 240): string {
  return redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function nextAction(cwd: string, task: Task) {
  const resume = inspectTaskResumeState(cwd, task as any, task.sessionId), next = resume.reconstruction.nextAction;
  return { action: next.action, stepRef: next.stepId ? opaque("step", `${task.taskRunId}\0${next.stepId}`) : null,
    reason: display(next.reason, 500) || "No authoritative next-action reason is available.", exactCommandCount: next.exactCommands.length,
    dispatchable: false, enforcementSafe: resume.enforcementSafe };
}

function currentHandoff(cwd: string, task: Task) {
  const handoff = readHandoffProjection(cwd, task.taskRunId); if (!handoff) return null;
  if (handoff.identity.taskId !== task.taskId || handoff.identity.taskRunId !== task.taskRunId) throw new Error("handoff-identity-conflict");
  return { handoffRef: opaque("handoff", `${task.taskRunId}\0${handoff.generatedAt}\0${handoff.tree.currentDigest ?? "none"}`),
    generatedAt: handoff.generatedAt, phase: display(handoff.state.phase, 64) || null, taskOutcome: handoff.state.taskOutcome,
    gateDecision: handoff.state.gateDecision, completionApproved: handoff.state.completionApproved,
    requiredAuthority: handoff.requiredAuthority.kind, treeEvidenceCurrent: handoff.tree.evidenceCurrent,
    latestVerifierMatchesCurrentTree: handoff.tree.latestVerifierMatchesCurrentTree,
    changedFileCount: handoff.changedFiles.current.length, missingCount: handoff.state.missing.length,
    projectedAction: display(handoff.nextSafeAction.action, 80) || "unknown" };
}

function unavailable(identity: Identity, runRef: string, generatedAt: string, reasonCode: string) {
  return { schemaVersion: 1, version: "piagent-webui-handoff-history-v1", generatedAt, identity: structuredClone(identity), runRef,
    state: "unavailable", historyRevision: null, completeness: "unknown", current: null,
    nextAction: { action: "unknown", stepRef: null, reason: "Handoff authority is unavailable.", exactCommandCount: 0,
      dispatchable: false, enforcementSafe: false }, events: [], page: { total: 0, returned: 0, truncated: false }, warnings: [],
    health: { state: "error", reasonCode, message: "Handoff history is unavailable." } };
}

export function projectTaskHandoffHistory(input: { cwd: string; task: Task; identity: Identity; generatedAt?: string }): Record<string, any> {
  const generatedAt = input.generatedAt ?? new Date().toISOString(), runRef = taskRunOpaqueRef(input.task.taskRunId);
  try {
    const inspected = inspectBoundedContextTelemetry(input.cwd, { limit: 5_000 });
    let malformed = inspected.corruptions;
    const matching = inspected.records.flatMap((record: any, ordinal: number) => {
      if (record?.event !== "handoff_projection_written" || record.taskId !== input.task.taskId
        || record.taskRunId !== input.task.taskRunId || record.sessionId !== input.task.sessionId) return [];
      if (record.schemaVersion !== 1 || !timestamp(record.recordedAt) || typeof record.completionApproved !== "boolean") { malformed += 1; return []; }
      const action = display(record.recoveryAction, 80) || "unknown", phase = display(record.phase, 64) || null;
      return [{ ordinal, recordedAt: record.recordedAt, phase, completionApproved: record.completionApproved, projectedAction: action }];
    });
    const projected = matching.map((event: any, index: number) => {
      const fact = { ...event }; delete fact.ordinal;
      const digest = createHash("sha256").update(JSON.stringify({ taskRunId: input.task.taskRunId, ordinal: event.ordinal, fact })).digest("hex");
      return { eventRef: opaque("handoff-event", digest), evidenceRef: opaque("telemetry", digest), sequence: index + 1, ...fact };
    });
    const events = projected.slice(-MAX_EVENTS), current = currentHandoff(input.cwd, input.task), next = nextAction(input.cwd, input.task);
    const warnings: Array<{ code: string; count: number; message: string }> = [];
    if (!inspected.exists) warnings.push({ code: "telemetry-missing", count: 1, message: "No bounded handoff telemetry was found for this project." });
    if (malformed > 0) warnings.push({ code: "telemetry-corrupt", count: malformed, message: `${malformed} telemetry record(s) could not be validated.` });
    if (inspected.recoverableTailBytes > 0) warnings.push({ code: "telemetry-incomplete-tail", count: inspected.recoverableTailBytes,
      message: "An incomplete telemetry tail may omit the latest handoff fact." });
    if (inspected.inputTruncated) warnings.push({ code: "telemetry-input-truncated", count: 1, message: "Older handoff telemetry is outside the bounded inspection window." });
    if (projected.length > events.length) warnings.push({ code: "history-truncated", count: projected.length - events.length,
      message: `${projected.length - events.length} older handoff event(s) are outside this bounded page.` });
    if (!current) warnings.push({ code: "current-handoff-missing", count: 1, message: "No current authoritative handoff projection was found for this run." });
    if (current && projected.length === 0) warnings.push({ code: "history-snapshot-only", count: 1, message: "Only the latest authoritative handoff snapshot is available." });
    const incomplete = malformed > 0 || inspected.recoverableTailBytes > 0 || inspected.inputTruncated;
    const completeness = incomplete || !current && projected.length > 0 ? "partial" : current && projected.length === 0 ? "snapshot-only"
      : !current && projected.length === 0 ? "missing" : "complete";
    const historyRevision = `handoff-history.${createHash("sha256").update(JSON.stringify({ current, next, events, completeness })).digest("hex")}`;
    return { schemaVersion: 1, version: "piagent-webui-handoff-history-v1", generatedAt, identity: structuredClone(input.identity), runRef,
      state: "ready", historyRevision, completeness, current, nextAction: next, events,
      page: { total: projected.length, returned: events.length, truncated: projected.length > events.length }, warnings,
      health: warnings.length ? { state: "degraded", reasonCode: "handoff-history-warning", message: "Some handoff facts are unavailable or omitted." }
        : { state: "ok", reasonCode: null, message: null } };
  } catch {
    return unavailable(input.identity, runRef, generatedAt, "handoff-history-invalid");
  }
}

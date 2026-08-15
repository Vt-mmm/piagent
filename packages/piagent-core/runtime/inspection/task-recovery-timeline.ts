import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { readTaskJournal, replayTaskCheckpoints, taskRecoveryDecision } from "../../extensions/task-journal.js";
import { taskRunOpaqueRef } from "./task-run-index.ts";

const MAX_EVENTS = 300;
const KINDS: Record<string, { kind: string; state: string; title: string }> = {
  "contract-written": { kind: "task-written", state: "observed", title: "Task Contract được ghi" },
  "session-bound": { kind: "session-bound", state: "observed", title: "Session được bind vào task" },
  checkpoint: { kind: "checkpoint", state: "observed", title: "Checkpoint được ghi" },
  "task-control.pause-requested": { kind: "pause-requested", state: "requested", title: "Yêu cầu tạm dừng" },
  "task-control.paused": { kind: "paused", state: "settled", title: "Task đã tạm dừng" },
  "task-control.pause-cancelled": { kind: "pause-cancelled", state: "settled", title: "Yêu cầu tạm dừng đã hủy" },
  "task-control.resume-requested": { kind: "resume-requested", state: "requested", title: "Yêu cầu tiếp tục" },
  "task-control.resumed": { kind: "resumed", state: "settled", title: "Task đã tiếp tục" },
  "task-control.resume-rejected": { kind: "resume-rejected", state: "failed", title: "Yêu cầu tiếp tục bị từ chối" },
  "task-control.stop-requested": { kind: "stop-requested", state: "requested", title: "Yêu cầu dừng operation" },
  "task-control.stop-settled": { kind: "stop-settled", state: "settled", title: "Operation đã dừng" },
  "continuation-consumed": { kind: "continuation", state: "observed", title: "Continuation budget đã dùng" },
  "digest-migrated": { kind: "digest-migrated", state: "observed", title: "Evidence digest đã migrate" }
};

type Task = { taskId: string; taskRunId: string; sessionId: string; trace: { outcome: string }; [key: string]: any };
type Identity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string;
  agentOperationId: null; toolCallId: null };

function opaque(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(`piagent-webui-task-timeline-v1\0${value}`).digest("hex").slice(0, 48)}`;
}

function display(value: unknown, maximum = 160): string {
  return redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function eventDetail(event: any): string | null {
  const data = event.data ?? {};
  if (event.eventType === "checkpoint") return display(`${data.phase ?? "unknown"} · ${data.status ?? "unknown"}`) || null;
  if (event.eventType.startsWith("task-control.")) return display(data.resultCode ?? data.reasonCode ?? "") || null;
  if (event.eventType === "continuation-consumed") return display(`${data.classification ?? "continuation"} · ${data.action ?? "unknown"}`) || null;
  if (event.eventType === "digest-migrated") return display(`${data.disposition ?? "migration"} · ${data.reasonCode ?? "unknown"}`) || null;
  if (event.eventType === "contract-written") return display(data.outcome ?? "") || null;
  return null;
}

function projectEvent(event: any, task: Task) {
  const descriptor = KINDS[event.eventType]; if (!descriptor) return null;
  const checkpointRef = event.eventType === "checkpoint" ? opaque("checkpoint", `${task.taskRunId}\0${event.checkpointId ?? "checkpoint"}`) : null;
  return { eventRef: opaque("event", `${task.taskRunId}\0${event.sequence}\0${event.hash}`), evidenceRef: `journal.${event.hash}`,
    sequence: event.sequence, recordedAt: event.recordedAt, ...descriptor, detail: eventDetail(event), checkpointRef };
}

function unavailable(identity: Identity, runRef: string, generatedAt: string, corruptions: number) {
  return { schemaVersion: 1, version: "piagent-webui-task-timeline-v1", generatedAt, identity, runRef, state: "unavailable",
    timelineRevision: null, continuity: { crashEvidence: "unknown", recoveryDecision: "unknown", latestCheckpointRef: null,
      reasonCode: "task-journal-corrupt" }, events: [], page: { total: 0, returned: 0, truncated: false },
    warnings: [{ code: "journal-corrupt", count: Math.max(1, corruptions), message: "Task journal could not be validated." }],
    health: { state: "error", reasonCode: "task-journal-corrupt", message: "Timeline authority is unavailable." } };
}

export function projectTaskRecoveryTimeline(input: { cwd: string; task: Task; identity: Identity; generatedAt?: string }): Record<string, unknown> {
  const generatedAt = input.generatedAt ?? new Date().toISOString(), runRef = taskRunOpaqueRef(input.task.taskRunId);
  const journal = readTaskJournal(input.cwd, { taskRunId: input.task.taskRunId, sessionId: input.task.sessionId,
    limit: 1000, maximumBytes: 32 * 1024 * 1024 });
  if (journal.corruptions.length) return unavailable(structuredClone(input.identity), runRef, generatedAt, journal.corruptions.length);
  const matching = journal.events.filter((event: any) => event.taskId === input.task.taskId && event.taskRunId === input.task.taskRunId
    && event.sessionId === input.task.sessionId);
  const projected = matching.map((event: any) => projectEvent(event, input.task)).filter(Boolean) as any[];
  const events = projected.slice(-MAX_EVENTS), replay = replayTaskCheckpoints(input.cwd, input.task.taskRunId, input.task);
  if (replay.corruptions.length) return unavailable(structuredClone(input.identity), runRef, generatedAt, replay.corruptions.length);
  const recovery = taskRecoveryDecision(input.task, replay), latest = replay.checkpoints.at(-1);
  const tailBytes = Number(journal.recoverableTailBytes ?? 0), warnings = [] as Array<{ code: string; count: number; message: string }>;
  if (tailBytes > 0) warnings.push({ code: "recoverable-tail", count: tailBytes, message: "An incomplete journal tail indicates a possible interrupted write." });
  else warnings.push({ code: "crash-not-observed", count: 1, message: "No explicit crash fact was recorded; crash state remains unknown." });
  if (projected.length > events.length) warnings.push({ code: "timeline-truncated", count: projected.length - events.length,
    message: `${projected.length - events.length} older timeline event(s) are outside this bounded page.` });
  if (journal.inputTruncated) warnings.push({ code: "journal-input-truncated", count: Math.max(1, Math.min(100_000, journal.omittedEvents ?? 0)),
    message: "Older task journal records are outside the bounded inspection window." });
  const continuity = { crashEvidence: tailBytes > 0 ? "possible-interruption" : "unknown", recoveryDecision: recovery.decision,
    latestCheckpointRef: latest ? opaque("checkpoint", `${input.task.taskRunId}\0${latest.checkpointId ?? "checkpoint"}`) : null,
    reasonCode: tailBytes > 0 ? "incomplete-journal-tail" : "no-explicit-crash-evidence" };
  const timelineRevision = `timeline.${createHash("sha256").update(JSON.stringify({ events, continuity, head: journal.head?.hash ?? null })).digest("hex")}`;
  return { schemaVersion: 1, version: "piagent-webui-task-timeline-v1", generatedAt, identity: structuredClone(input.identity), runRef, state: "ready",
    timelineRevision, continuity, events, page: { total: projected.length, returned: events.length,
      truncated: projected.length > events.length || journal.inputTruncated }, warnings,
    health: warnings.length ? { state: "degraded", reasonCode: "timeline-warning", message: "Some continuity facts remain unknown or omitted." }
      : { state: "ok", reasonCode: null, message: null } };
}

import { createHash } from "node:crypto";

import { activeSessionTask } from "../../extensions/task-state.js";
import { readTaskJournal, transactTaskJournal } from "../../extensions/task-journal.js";

const CONTROL_FACTS = new Set([
  "task-control.stop-requested", "task-control.stop-settled", "task-control.pause-requested", "task-control.paused",
  "task-control.pause-cancelled", "task-control.resume-requested", "task-control.resumed", "task-control.resume-rejected"
]);
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export type DurableControlState = "active" | "pause-requested" | "paused" | "terminal" | "unknown";
type Task = { taskId: string; taskRunId: string; sessionId: string; trace: { outcome: string } };
type JournalEvent = { sequence: number; hash: string; eventType: string; taskRunId?: string; taskId?: string; sessionId?: string;
  recordedAt: string; data?: Record<string, any> };
export type TaskControlProjection = { state: DurableControlState; controlRevision: string; pauseEpoch: number; dispatchBlocked: boolean;
  stopPending: boolean; journalHead: string | null; reasonCode: string | null; sequence: number };
export type TaskControlTransition = { cwd: string; task: Task; runtimeInstanceId: string; commandId: string; idempotencyKeyDigest: string;
  actionDigest: string; fact: string; action: "stop" | "pause" | "resume"; expectedControlRevision: string; expectedStates: DurableControlState[];
  toState: DurableControlState; agentOperationId?: string | null; resultCode: string; reasonCode?: string | null; pauseEpoch?: number;
  preWorkingTreeDigest?: string | null; postWorkingTreeDigest?: string | null };

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function revision(taskRunId: string, state: DurableControlState, event?: JournalEvent): string {
  return `control-rev.${hash([taskRunId, state, event?.sequence ?? 0, event?.hash ?? null])}`;
}
function evidence(event?: JournalEvent): string | null { return event?.hash ? `journal.${event.hash}` : null; }
function taskEvents(events: JournalEvent[], task: Task): JournalEvent[] {
  return events.filter((event) => event.taskRunId === task.taskRunId && event.taskId === task.taskId && event.sessionId === task.sessionId);
}
function project(events: JournalEvent[], task: Task, corruptions: string[] = []): TaskControlProjection {
  const relevant = taskEvents(events, task).filter((event) => CONTROL_FACTS.has(event.eventType));
  const latest = relevant.at(-1), sequence = latest?.sequence ?? 0;
  if (task.trace.outcome !== "pending") return { state: "terminal", controlRevision: revision(task.taskRunId, "terminal", latest), pauseEpoch: 0,
    dispatchBlocked: true, stopPending: false, journalHead: evidence(latest), reasonCode: null, sequence };
  if (corruptions.length) return { state: "unknown", controlRevision: revision(task.taskRunId, "unknown", latest), pauseEpoch: 0,
    dispatchBlocked: true, stopPending: false, journalHead: evidence(latest), reasonCode: "task-journal-corrupt", sequence };
  let state: DurableControlState = "active", pauseEpoch = 0;
  const pendingStops = new Set<string>();
  for (const event of relevant) {
    const data = event.data ?? {}, commandId = String(data.commandId ?? "");
    if (event.eventType === "task-control.pause-requested") { state = "pause-requested"; pauseEpoch = Number(data.pauseEpoch) || pauseEpoch + 1; }
    else if (event.eventType === "task-control.paused") { state = "paused"; pauseEpoch = Number(data.pauseEpoch) || pauseEpoch; }
    else if (event.eventType === "task-control.pause-cancelled" || event.eventType === "task-control.resumed") state = "active";
    if (event.eventType === "task-control.stop-requested" && commandId) pendingStops.add(commandId);
    if (event.eventType === "task-control.stop-settled" && commandId) pendingStops.delete(commandId);
  }
  const stopPending = pendingStops.size > 0;
  return { state, controlRevision: revision(task.taskRunId, state, latest), pauseEpoch, dispatchBlocked: state !== "active",
    stopPending, journalHead: evidence(latest), reasonCode: null, sequence };
}

export function inspectTaskControlState(cwd: string, task: Task): TaskControlProjection {
  const journal = readTaskJournal(cwd, { taskRunId: task.taskRunId, sessionId: task.sessionId });
  return project(journal.events as JournalEvent[], task, journal.corruptions);
}

export function appendTaskControlTransition(input: TaskControlTransition): { ok: boolean; duplicate: boolean; reasonCode: string | null;
  before: TaskControlProjection; after: TaskControlProjection; evidenceRef: string | null } {
  let before = inspectTaskControlState(input.cwd, input.task), duplicate = false, failure: string | null = null;
  let record: JournalEvent | undefined;
  const outcome = transactTaskJournal(input.cwd, ({ events }: { events: JournalEvent[] }) => {
    const currentTask = activeSessionTask(input.cwd, input.task.sessionId) as Task | undefined;
    before = project(events, input.task);
    if (!currentTask || currentTask.taskId !== input.task.taskId || currentTask.taskRunId !== input.task.taskRunId) {
      failure = "task-identity-mismatch"; return { result: null };
    }
    if (currentTask.trace.outcome !== "pending") { failure = "task-terminal"; return { result: null }; }
    if (before.controlRevision !== input.expectedControlRevision) { failure = "stale-control-revision"; return { result: null }; }
    if (!input.expectedStates.includes(before.state)) { failure = `control-state-${before.state}`; return { result: null }; }
    const prior = taskEvents(events, input.task).find((event) => event.eventType === input.fact
      && (event.data?.commandId === input.commandId || event.data?.idempotencyKeyDigest === input.idempotencyKeyDigest));
    if (prior) {
      if (prior.data?.idempotencyKeyDigest !== input.idempotencyKeyDigest || prior.data?.actionDigest !== input.actionDigest) failure = "idempotency-payload-mismatch";
      else { duplicate = true; record = prior; }
      return { result: null };
    }
    const commandConflict = taskEvents(events, input.task).find((event) => event.data?.commandId === input.commandId
      && (event.data?.idempotencyKeyDigest !== input.idempotencyKeyDigest || event.data?.actionDigest !== input.actionDigest));
    if (commandConflict) { failure = "idempotency-payload-mismatch"; return { result: null }; }
    return { event: { eventType: input.fact, taskRunId: input.task.taskRunId, taskId: input.task.taskId, sessionId: input.task.sessionId,
      idempotencyKey: input.commandId, data: { schemaVersion: 1, runtimeInstanceId: input.runtimeInstanceId, commandId: input.commandId,
        idempotencyKeyDigest: input.idempotencyKeyDigest, actionDigest: input.actionDigest, action: input.action,
        expectedControlRevision: input.expectedControlRevision, fromControlState: before.state, toControlState: input.toState,
        pauseEpoch: input.pauseEpoch ?? before.pauseEpoch, agentOperationId: input.agentOperationId ?? null,
        resultCode: input.resultCode, reasonCode: input.reasonCode ?? null,
        preWorkingTreeDigest: input.preWorkingTreeDigest ?? null, postWorkingTreeDigest: input.postWorkingTreeDigest ?? null } }, result: null };
  }) as unknown as { appended: boolean; record?: JournalEvent };
  if (outcome.appended) record = outcome.record;
  const after = inspectTaskControlState(input.cwd, input.task);
  return { ok: !failure, duplicate, reasonCode: failure, before, after, evidenceRef: evidence(record) };
}

export function readTaskControlReceipt(cwd: string, task: Task, binding: { commandId: string; idempotencyKeyDigest: string;
  actionDigest: string }): { receipt: Record<string, unknown>; conflict: boolean; invalid: boolean } | null {
  const journal = readTaskJournal(cwd, { taskRunId: task.taskRunId, sessionId: task.sessionId });
  if (journal.corruptions.length) return null;
  const event = [...journal.events].reverse().find((item: any) => item.eventType === "task-control.command-receipt"
    && item.taskId === task.taskId && (item.data?.commandId === binding.commandId
      || item.data?.idempotencyKeyDigest === binding.idempotencyKeyDigest));
  if (!event?.data?.receipt || typeof event.data.receipt !== "object") return null;
  const receipt = event.data.receipt as Record<string, unknown>;
  const invalid = receipt.commandId !== event.data.commandId || receipt.idempotencyKeyDigest !== event.data.idempotencyKeyDigest
    || receipt.actionDigest !== event.data.actionDigest;
  const conflict = event.data.actionDigest !== binding.actionDigest || event.data.commandId === binding.commandId
    && event.data.idempotencyKeyDigest !== binding.idempotencyKeyDigest;
  return { receipt: structuredClone(receipt), conflict, invalid };
}

export function recordTaskControlReceipt(cwd: string, task: Task, commandId: string, idempotencyKeyDigest: string,
  actionDigest: string, receipt: Record<string, unknown>): { ok: boolean; duplicate: boolean; evidenceRef: string | null } {
  let duplicate = false, conflict = false, record: JournalEvent | undefined;
  const result = transactTaskJournal(cwd, ({ events }: { events: JournalEvent[] }) => {
    const prior = taskEvents(events, task).find((event) => event.eventType === "task-control.command-receipt"
      && (event.data?.commandId === commandId || event.data?.idempotencyKeyDigest === idempotencyKeyDigest));
    if (prior) {
      if (prior.data?.idempotencyKeyDigest !== idempotencyKeyDigest || prior.data?.actionDigest !== actionDigest) conflict = true;
      else if (JSON.stringify(prior.data?.receipt) === JSON.stringify(receipt)) { duplicate = true; record = prior; }
      if (conflict || duplicate) return { result: null };
    }
    return { event: { eventType: "task-control.command-receipt", taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId,
      idempotencyKey: `${commandId}:${String(receipt.phase ?? "receipt")}:${String(receipt.resultCode ?? "result")}`,
      data: { schemaVersion: 1, commandId, idempotencyKeyDigest, actionDigest, receipt } }, result: null };
  }) as unknown as { appended: boolean; record?: JournalEvent };
  if (result.appended) record = result.record;
  return { ok: !conflict, duplicate, evidenceRef: evidence(record) };
}

export function validTaskControlBinding(value: { commandId: string; idempotencyKeyDigest: string; actionDigest: string }): boolean {
  return REF.test(value.commandId) && DIGEST.test(value.idempotencyKeyDigest) && DIGEST.test(value.actionDigest);
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";

export const RUNTIME_EVENT_SCHEMA_VERSION = 2 as const;
export type RuntimeEventRevision = {
  runtimeRevision: string;
  taskRevision: string | null;
  controlRevision: string | null;
  workspaceRevision: string | null;
  indexRevision: string | null;
  approvalRevision: string | null;
  sessionOptionRevision: string | null;
  queueRevision: string | null;
};
export type RuntimeEventCorrelation = {
  commandId: string | null;
  messageRequestId: string | null;
  replacementId: string | null;
  approvalRequestId: string | null;
  causationEventId: string | null;
  idempotencyKeyDigest: string | null;
};
export type RuntimeEventDraft = {
  sourceObservedAt: string;
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  turnIndex: number | null;
  messageRef: string | null;
  toolCallId: string | null;
  revision: RuntimeEventRevision;
  kind: string;
  correlation: RuntimeEventCorrelation;
  evidence: "observed" | "derived" | "unavailable";
  payload: Record<string, unknown>;
  redaction: { applied: boolean; valuesRemoved: number; truncated: boolean };
};
export type RuntimeEventV2 = RuntimeEventDraft & {
  schemaVersion: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  eventId: string;
  eventCursor: string;
  writerSequence: number;
  recordedAt: string;
};
export type RuntimeEventReplay = {
  state: "current" | "truncated" | "resync-required";
  events: RuntimeEventV2[];
  nextCursor: string;
  latestCursor: string;
  firstAvailableSequence: number | null;
  lastAvailableSequence: number | null;
  reasonCode: string | null;
};

const EVENT_KINDS = new Set([
  "runtime.started", "runtime.health-changed", "runtime.disconnected", "runtime.resync-required", "runtime.resynced", "runtime.phase-changed",
  "session.bound", "session.info-changed", "session.replacement-requested", "session.replacement-pending", "session.replacement-committed", "session.replacement-cancelled", "session.replacement-failed", "session.compaction-preflight", "session.compacted", "session.shutdown",
  "agent-operation.started", "agent-operation.loop-ended", "agent-operation.settled", "agent-operation.stop-requested", "agent-operation.stop-settled",
  "turn.started", "turn.ended", "message.started", "message.text-delta", "message.thinking-state", "message.completed", "message.failed",
  "chat.held", "chat.dispatch-requested", "chat.dispatch-observed", "chat.dispatch-rejected", "chat.dispatch-unknown",
  "session-option.model-changed", "session-option.thinking-changed", "task.started", "task.state-changed", "task.outcome-changed",
  "task-control.stop-requested", "task-control.stop-settled", "task-control.pause-requested", "task-control.paused", "task-control.pause-cancelled", "task-control.resume-requested", "task-control.resumed", "task-control.resume-rejected", "task-control.continue-requested", "task-control.continue-dispatched", "task-control.continue-uncertain",
  "queue.changed", "activity.requested", "activity.started", "activity.progress", "activity.finished", "activity.failed", "activity.blocked", "activity.aborted",
  "approval.requested", "approval.resolved", "approval.expired", "source.changed", "verifier.started", "verifier.finished", "verifier.stale", "usage.updated", "handoff.updated"
]);
const EVENT_FIELDS = ["schemaVersion", "eventId", "eventCursor", "writerSequence", "recordedAt", "sourceObservedAt", "projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "turnIndex", "messageRef", "toolCallId", "revision", "kind", "correlation", "evidence", "payload", "redaction"];
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_EVENT_BYTES = 256 * 1024;

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function plain(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function eventBody(value: RuntimeEventDraft | RuntimeEventV2): string {
  const { schemaVersion: _schema, eventId: _event, eventCursor: _cursor, writerSequence: _sequence, recordedAt: _recorded, ...draft } = value as RuntimeEventV2;
  return JSON.stringify(canonical(draft));
}
function eventId(draft: RuntimeEventDraft | RuntimeEventV2): string { return `event.${hash(`runtime-event-v2\0${eventBody(draft)}`)}`; }
function eventCursor(sequence: number, id: string): string { return `cursor.${sequence.toString(36)}.${hash(`${sequence}\0${id}`)}`; }
function emptyCursor(runtimeInstanceId: string, sessionRef: string): string { return `cursor.0.${hash(`empty\0${runtimeInstanceId}\0${sessionRef}`)}`; }
function segmentStart(file: string): number | null {
  const match = /^segment\.([0-9]{12})\.jsonl$/.exec(file);
  return match ? Number(match[1]) : null;
}
function segmentName(sequence: number): string { return `segment.${String(sequence).padStart(12, "0")}.jsonl`; }
function storeDirectory(root: string, runtime: string, session: string): string {
  return path.join(root, ".pi", "piagent-state", "webui-events", `runtime-${hash(runtime)}`, `session-${hash(session)}`);
}
function boundedJson(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_EVENT_BYTES; } catch { return false; }
}
function validTimestamp(value: unknown): boolean { return typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)); }
function nullableRef(value: unknown, pattern = REF): boolean { return value === null || typeof value === "string" && pattern.test(value); }

export function runtimeEventEnvelopeErrors(value: unknown): string[] {
  if (!plain(value)) return ["event must be an object"];
  const errors: string[] = [];
  const keys = Object.keys(value).sort(), expected = [...EVENT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) errors.push("event fields are invalid");
  if (value.schemaVersion !== 2 || !REF.test(String(value.eventId)) || !REF.test(String(value.eventCursor))) errors.push("event envelope version or refs are invalid");
  if (!Number.isInteger(value.writerSequence) || value.writerSequence < 1 || value.writerSequence > 999_999_999_999) errors.push("writer sequence is invalid");
  if (!validTimestamp(value.recordedAt) || !validTimestamp(value.sourceObservedAt) || Date.parse(value.recordedAt) < Date.parse(value.sourceObservedAt)) errors.push("event timestamps are invalid");
  if (![value.projectRef, value.runtimeInstanceId, value.sessionRef].every((item) => typeof item === "string" && REF.test(item))) errors.push("runtime identity is invalid");
  if (!nullableRef(value.taskId, PUBLIC_ID) || !nullableRef(value.taskRunId, PUBLIC_ID) || (value.taskRunId !== null && value.taskId === null)) errors.push("task identity is invalid");
  if (![value.agentOperationId, value.messageRef, value.toolCallId].every((item) => nullableRef(item)) || (value.toolCallId !== null && value.agentOperationId === null)) errors.push("operation identity is invalid");
  if (value.turnIndex !== null && (!Number.isInteger(value.turnIndex) || value.turnIndex < 0 || value.turnIndex > 1_000_000_000)) errors.push("turn index is invalid");
  if (!plain(value.revision) || Object.keys(value.revision).length !== 8 || !REVISION.test(String(value.revision.runtimeRevision))
    || !["taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision"].every((key) => nullableRef(value.revision[key], REVISION))) errors.push("revision is invalid");
  if (!EVENT_KINDS.has(String(value.kind)) || !["observed", "derived", "unavailable"].includes(String(value.evidence)) || !plain(value.payload)) errors.push("event kind, evidence or payload is invalid");
  if (!plain(value.correlation) || Object.keys(value.correlation).length !== 6 || !["commandId", "messageRequestId", "replacementId", "approvalRequestId", "causationEventId"].every((key) => nullableRef(value.correlation[key]))
    || !(value.correlation.idempotencyKeyDigest === null || DIGEST.test(String(value.correlation.idempotencyKeyDigest)))) errors.push("correlation is invalid");
  if (!plain(value.redaction) || Object.keys(value.redaction).length !== 3 || typeof value.redaction.applied !== "boolean" || typeof value.redaction.truncated !== "boolean"
    || !Number.isInteger(value.redaction.valuesRemoved) || value.redaction.valuesRemoved < 0 || value.redaction.valuesRemoved > 10_000
    || (!value.redaction.applied && value.redaction.valuesRemoved !== 0)) errors.push("redaction is invalid");
  if (value.eventId !== eventId(value as RuntimeEventV2) || value.eventCursor !== eventCursor(value.writerSequence, value.eventId)) errors.push("event integrity is invalid");
  if (!boundedJson(value)) errors.push("event exceeds byte limit");
  return errors;
}

export function validateRuntimeEventEnvelope(value: unknown): RuntimeEventV2 {
  const errors = runtimeEventEnvelopeErrors(value);
  if (errors.length) throw new Error(`Invalid runtime event: ${errors.join("; ")}`);
  return structuredClone(value) as RuntimeEventV2;
}

function readSegment(root: string, file: string): RuntimeEventV2[] {
  const target = resolveLocalStatePath(root, file, { label: "WebUI event segment", kind: "file" });
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("event segment is oversized or not regular");
    const text = fs.readFileSync(descriptor, "utf8");
    if (text && !text.endsWith("\n")) throw new Error("event segment has an incomplete tail");
    return text.split("\n").filter(Boolean).map((line) => {
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) throw new Error("event line is oversized");
      return validateRuntimeEventEnvelope(JSON.parse(line));
    });
  } finally { fs.closeSync(descriptor); }
}

export class RuntimeEventStore {
  readonly directory: string;
  readonly corruptions: string[] = [];
  readonly options: { projectRoot: string; projectRef: string; runtimeInstanceId: string; sessionRef: string; maxEventsPerSegment?: number; maxSegments?: number };
  private events: RuntimeEventV2[] = [];
  private segments: Array<{ file: string; start: number; count: number }> = [];
  private eventById = new Map<string, RuntimeEventV2>();
  private readonly maxEventsPerSegment: number;
  private readonly maxSegments: number;

  constructor(options: { projectRoot: string; projectRef: string; runtimeInstanceId: string; sessionRef: string; maxEventsPerSegment?: number; maxSegments?: number }) {
    this.options = options;
    this.maxEventsPerSegment = Math.max(2, Math.min(1_000, options.maxEventsPerSegment ?? 500));
    this.maxSegments = Math.max(2, Math.min(20, options.maxSegments ?? 10));
    this.directory = storeDirectory(options.projectRoot, options.runtimeInstanceId, options.sessionRef);
    this.load();
  }

  private load(): void {
    let names: string[];
    try {
      const directory = resolveLocalStatePath(this.options.projectRoot, this.directory, { label: "WebUI event store", kind: "directory" });
      const entries = fs.readdirSync(directory);
      if (entries.some((file) => segmentStart(file) === null)) throw new Error("event store contains an unexpected entry");
      names = entries.sort();
      if (names.length > this.maxSegments) throw new Error("event segment retention limit exceeded");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.corruptions.push("event-store-directory-unavailable"); return;
    }
    let previous = 0;
    try {
      for (const name of names) {
        const start = segmentStart(name) as number, records = readSegment(this.options.projectRoot, path.join(this.directory, name));
        if (records.length === 0 || records[0].writerSequence !== start) throw new Error("segment start mismatch");
        for (const record of records) {
          if (record.projectRef !== this.options.projectRef || record.runtimeInstanceId !== this.options.runtimeInstanceId || record.sessionRef !== this.options.sessionRef) throw new Error("event store identity mismatch");
          if (previous && record.writerSequence !== previous + 1) throw new Error("event sequence gap");
          if (this.eventById.has(record.eventId)) throw new Error("duplicate event identity");
          previous = record.writerSequence; this.events.push(record); this.eventById.set(record.eventId, record);
        }
        this.segments.push({ file: name, start, count: records.length });
      }
    } catch {
      this.events = []; this.segments = []; this.eventById.clear(); this.corruptions.push("event-store-corrupt");
    }
  }

  currentCursor(): string { return this.events.at(-1)?.eventCursor ?? emptyCursor(this.options.runtimeInstanceId, this.options.sessionRef); }
  resyncRequired(): boolean { return this.corruptions.length > 0; }
  retention(): { eventRetentionCount: number; eventRetentionSeconds: number } {
    return { eventRetentionCount: this.maxEventsPerSegment * this.maxSegments, eventRetentionSeconds: 0 };
  }

  append(draft: RuntimeEventDraft, recordedAt = new Date().toISOString()): { event: RuntimeEventV2; appended: boolean } {
    if (this.resyncRequired()) throw new Error("WebUI event store requires resync");
    if (draft.projectRef !== this.options.projectRef || draft.runtimeInstanceId !== this.options.runtimeInstanceId || draft.sessionRef !== this.options.sessionRef) throw new Error("Runtime event identity does not match its store");
    const id = eventId(draft), duplicate = this.eventById.get(id);
    if (duplicate) return { event: structuredClone(duplicate), appended: false };
    const sequence = (this.events.at(-1)?.writerSequence ?? 0) + 1;
    const event = validateRuntimeEventEnvelope({ schemaVersion: 2, eventId: id, eventCursor: eventCursor(sequence, id), writerSequence: sequence, recordedAt, ...structuredClone(draft) });
    let segment = this.segments.at(-1);
    if (!segment || segment.count >= this.maxEventsPerSegment) {
      segment = { file: segmentName(sequence), start: sequence, count: 0 }; this.segments.push(segment);
    }
    const directory = ensurePrivateStateDirectory(this.options.projectRoot, this.directory, "WebUI event store");
    const target = resolveLocalStatePath(this.options.projectRoot, path.join(directory, segment.file), { label: "WebUI event segment" });
    const creating = segment.count === 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0)
      | (creating ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
    const descriptor = fs.openSync(target, flags, 0o600);
    try { fs.writeFileSync(descriptor, `${JSON.stringify(event)}\n`); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); } finally { fs.closeSync(descriptor); }
    segment.count += 1; this.events.push(event); this.eventById.set(event.eventId, event);
    try { this.enforceRetention(); } catch { this.corruptions.push("event-retention-failed"); }
    return { event: structuredClone(event), appended: true };
  }

  private enforceRetention(): void {
    while (this.segments.length > this.maxSegments) {
      const removed = this.segments.shift() as { file: string; start: number; count: number };
      const target = resolveLocalStatePath(this.options.projectRoot, path.join(this.directory, removed.file), { label: "WebUI event segment", kind: "file" });
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("event retention target is unsafe");
      fs.unlinkSync(target);
      const discarded = this.events.splice(0, removed.count);
      for (const event of discarded) this.eventById.delete(event.eventId);
    }
  }

  replay(afterCursor: string | null, limit = 1_000): RuntimeEventReplay {
    const latestCursor = this.currentCursor(), first = this.events[0]?.writerSequence ?? null, last = this.events.at(-1)?.writerSequence ?? null;
    if (this.resyncRequired()) return { state: "resync-required", events: [], nextCursor: latestCursor, latestCursor, firstAvailableSequence: first, lastAvailableSequence: last, reasonCode: this.corruptions[0] };
    let start = 0;
    if (afterCursor !== null && afterCursor !== emptyCursor(this.options.runtimeInstanceId, this.options.sessionRef)) {
      const index = this.events.findIndex((event) => event.eventCursor === afterCursor);
      if (index < 0) return { state: "resync-required", events: [], nextCursor: latestCursor, latestCursor, firstAvailableSequence: first, lastAvailableSequence: last, reasonCode: "event-cursor-gap" };
      start = index + 1;
    }
    const maximum = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const selected = this.events.slice(start, start + maximum), truncated = start + selected.length < this.events.length;
    const nextCursor = selected.at(-1)?.eventCursor ?? afterCursor ?? emptyCursor(this.options.runtimeInstanceId, this.options.sessionRef);
    return { state: truncated ? "truncated" : "current", events: structuredClone(selected), nextCursor, latestCursor,
      firstAvailableSequence: first, lastAvailableSequence: last, reasonCode: null };
  }
}

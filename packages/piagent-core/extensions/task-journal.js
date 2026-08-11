import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactForStorage } from "./redaction-core.js";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "./local-state-path.js";
import { isCurrentWorkingTreeDigest } from "./working-tree-digest.js";

export const TASK_JOURNAL_SCHEMA_VERSION = 1;
const MAX_EVENT_BYTES = 64 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const TREE_DIGEST_EVIDENCE_FIELDS = new Set([
  "workingTreeDigest", "currentWorkingTreeDigest", "preWorkingTreeDigest", "postWorkingTreeDigest", "treeDigest"
]);
const DIGEST_MIGRATION_BARRIER_FIELDS = new Set([
  "algorithm", "disposition", "reasonCode", "archivePath", "archiveDigest", "baselineEvidenceDigest", "finalEvidenceDigest"
]);

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function journalRoot(cwd) {
  return path.join(cwd, ".pi", "piagent-state", "task-journal");
}

export function taskJournalPaths(cwd) {
  const root = journalRoot(cwd);
  return {
    root,
    events: path.join(root, "events.jsonl"),
    head: path.join(root, "head.json"),
    lock: path.join(root, ".events.lock")
  };
}

function compactId(value, fallback = "unknown") {
  return String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || fallback;
}

function safeData(value) {
  const redacted = redactForStorage(value ?? {});
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_EVENT_BYTES) return redacted;
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    digest: sha256(serialized)
  };
}

function acquireLock(paths, startedAt = Date.now()) {
  while (true) {
    try {
      const descriptor = fs.openSync(paths.lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n${nowIso()}\n`);
      return () => {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Already closed by the platform or filesystem.
        }
        try {
          fs.rmSync(paths.lock, { force: true });
        } catch {
          // Best effort cleanup; the next writer can expire stale locks.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(paths.lock).mtimeMs;
      } catch {
        age = 0;
      }
      if (age > LOCK_TIMEOUT_MS) {
        fs.rmSync(paths.lock, { force: true });
        continue;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error("Task journal lock timed out");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function writeHead(paths, head) {
  const temporary = `${paths.head}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(head, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, paths.head);
  try {
    fs.chmodSync(paths.head, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function writeEventsAtomic(paths, events) {
  const temporary = `${paths.events}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(temporary, paths.events);
  try {
    fs.chmodSync(paths.events, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function eventHash(record) {
  const { hash: _hash, ...withoutHash } = record;
  return sha256(JSON.stringify(withoutHash));
}

function validateEventShape(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "event must be an object";
  if (record.schemaVersion !== TASK_JOURNAL_SCHEMA_VERSION) return `schemaVersion must be ${TASK_JOURNAL_SCHEMA_VERSION}`;
  if (!Number.isInteger(record.sequence) || record.sequence < 1) return "sequence must be a positive integer";
  if (typeof record.eventType !== "string" || !record.eventType.trim()) return "eventType is required";
  if (typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) return "recordedAt must be a valid timestamp";
  if (typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash)) return "hash must be sha256 hex";
  if (record.previousHash !== undefined && (typeof record.previousHash !== "string" || !/^[a-f0-9]{64}$/.test(record.previousHash))) return "previousHash must be sha256 hex";
  if (record.taskRunId !== undefined && typeof record.taskRunId !== "string") return "taskRunId must be a string";
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") return "sessionId must be a string";
  return undefined;
}

function validDigestMigrationBarrier(event) {
  const data = event?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (typeof event.taskRunId !== "string" || compactId(event.taskRunId) !== event.taskRunId
    || typeof event.taskId !== "string" || compactId(event.taskId) !== event.taskId
    || typeof event.sessionId !== "string" || !event.sessionId) return false;
  if (Object.keys(data).some((field) => !DIGEST_MIGRATION_BARRIER_FIELDS.has(field))) return false;
  const current = data.algorithm === "wt-content-v2" && data.disposition === "verification-refresh-required";
  const terminalLegacy = data.algorithm === "legacy-untrusted" && ["new-attempt-required", "historical-unverifiable"].includes(data.disposition);
  return (current || terminalLegacy)
    && typeof data.reasonCode === "string"
    && /^[a-z0-9-]+$/.test(data.reasonCode)
    && typeof data.archivePath === "string"
    && /^\.pi\/piagent-state\/digest-migrations\/[a-z0-9-]+\.legacy\.json$/.test(data.archivePath)
    && typeof data.archiveDigest === "string"
    && /^[a-f0-9]{64}$/.test(data.archiveDigest)
    && typeof data.baselineEvidenceDigest === "string"
    && /^[a-f0-9]{64}$/.test(data.baselineEvidenceDigest)
    && typeof data.finalEvidenceDigest === "string"
    && /^[a-f0-9]{64}$/.test(data.finalEvidenceDigest);
}

function digestMigrationBarrierMatchesTask(event, task) {
  const migration = task?.workingTreeDigestMigration;
  if (!validDigestMigrationBarrier(event) || !migration
    || event.taskRunId !== compactId(task?.taskRunId)
    || event.taskId !== compactId(task?.taskId)
    || event.sessionId !== String(task?.sessionId)) return false;
  const expectedDisposition = migration.status === "refreshed" ? "verification-refresh-required" : migration.status;
  return event.data.algorithm === task.workingTreeDigestAlgorithm
    && event.data.disposition === expectedDisposition
    && event.data.reasonCode === migration.reasonCode
    && event.data.archivePath === migration.archivePath
    && event.data.archiveDigest === migration.archiveDigest
    && event.data.baselineEvidenceDigest === migration.baselineEvidenceDigest
    && event.data.finalEvidenceDigest === migration.finalEvidenceDigest;
}

export function checkpointTreeDigestValidationErrors(evidence) {
  const errors = [];
  const pending = [{ value: evidence, path: "evidence", depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 512) {
    const { value, path: evidencePath, depth } = pending.pop();
    visited += 1;
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (depth < 6) value.slice(0, 128).forEach((entry, index) => pending.push({ value: entry, path: `${evidencePath}[${index}]`, depth: depth + 1 }));
      continue;
    }
    for (const [field, entry] of Object.entries(value)) {
      const fieldPath = `${evidencePath}.${field}`;
      if (TREE_DIGEST_EVIDENCE_FIELDS.has(field) && !isCurrentWorkingTreeDigest(entry)) {
        errors.push(`${fieldPath} must use the current working-tree digest namespace`);
      } else if (depth < 6 && entry && typeof entry === "object") {
        pending.push({ value: entry, path: fieldPath, depth: depth + 1 });
      }
    }
  }
  if (pending.length > 0) errors.push("checkpoint evidence exceeds the bounded tree-digest validation budget");
  return errors;
}

function writableJournalPaths(cwd) {
  const paths = taskJournalPaths(cwd);
  const root = ensurePrivateStateDirectory(cwd, paths.root, "Task journal root");
  return {
    root,
    events: resolveLocalStatePath(cwd, paths.events, { label: "Task journal events" }),
    head: resolveLocalStatePath(cwd, paths.head, { label: "Task journal head" }),
    lock: resolveLocalStatePath(cwd, paths.lock, { label: "Task journal lock" })
  };
}

function appendJournalRecord(safePaths, journal, event, recordedAt) {
  const head = journal.head;
  const record = {
    schemaVersion: TASK_JOURNAL_SCHEMA_VERSION,
    sequence: (head?.sequence ?? 0) + 1,
    previousHash: head?.hash,
    eventType: compactId(event?.eventType, "event"),
    taskRunId: event?.taskRunId === undefined ? undefined : compactId(event.taskRunId),
    taskId: event?.taskId === undefined ? undefined : compactId(event.taskId),
    sessionId: event?.sessionId === undefined ? undefined : String(event.sessionId),
    sessionName: event?.sessionName === undefined ? undefined : String(event.sessionName).slice(0, 240),
    checkpointId: event?.checkpointId === undefined ? undefined : compactId(event.checkpointId),
    idempotencyKey: event?.idempotencyKey === undefined ? undefined : compactId(event.idempotencyKey),
    data: safeData(event?.data),
    recordedAt: recordedAt ?? nowIso()
  };
  record.hash = eventHash(record);
  const error = validateEventShape(record);
  if (error) throw new Error(`Task journal event is invalid: ${error}`);
  const previousBytes = fs.existsSync(safePaths.events) ? fs.statSync(safePaths.events).size : 0;
  try {
    fs.appendFileSync(safePaths.events, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const descriptor = fs.openSync(safePaths.events, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    try { fs.truncateSync(safePaths.events, previousBytes); } catch { /* A later read fails closed if rollback itself is impossible. */ }
    throw error;
  }
  writeHead(safePaths, { schemaVersion: 1, sequence: record.sequence, hash: record.hash, updatedAt: record.recordedAt });
  try { fs.chmodSync(safePaths.events, 0o600); } catch { /* POSIX modes unavailable. */ }
  return record;
}

function recoverIncompleteJournalTail(cwd, safePaths, journal) {
  if (!Number.isInteger(journal.recoverableTailBytes) || journal.recoverableTailBytes <= 0) return journal;
  fs.truncateSync(safePaths.events, journal.validBytes);
  return readTaskJournal(cwd);
}

export function appendTaskJournalEvent(cwd, event, options = {}) {
  const safePaths = writableJournalPaths(cwd);
  const release = acquireLock(safePaths);
  try {
    const journal = recoverIncompleteJournalTail(cwd, safePaths, readTaskJournal(cwd));
    if (journal.corruptions.length > 0) throw new Error(`Task journal chain is corrupt: ${journal.corruptions[0]}`);
    // events.jsonl is authoritative if a process stopped after appending an
    // event but before replacing head.json. The next writer continues from the
    // verified event tail instead of duplicating a sequence number.
    return appendJournalRecord(safePaths, journal, event, options.recordedAt);
  } finally {
    release();
  }
}

export function appendTaskJournalEventAtMost(cwd, event, options = {}) {
  const maximum = Number.isInteger(options.maximum) ? Math.max(0, Math.min(options.maximum, 100)) : 0;
  const safePaths = writableJournalPaths(cwd);
  const release = acquireLock(safePaths);
  try {
    const journal = recoverIncompleteJournalTail(cwd, safePaths, readTaskJournal(cwd));
    if (journal.corruptions.length > 0) throw new Error(`Task journal chain is corrupt: ${journal.corruptions[0]}`);
    const eventType = compactId(event?.eventType, "event"), taskRunId = compactId(event?.taskRunId);
    const idempotencyKey = event?.idempotencyKey === undefined ? undefined : compactId(event.idempotencyKey);
    const matching = journal.events.filter((entry) => entry.eventType === eventType && entry.taskRunId === taskRunId);
    const duplicate = idempotencyKey ? matching.find((entry) => entry.idempotencyKey === idempotencyKey) : undefined;
    if (duplicate) return { appended: false, reason: "duplicate", count: matching.length, record: duplicate };
    if (matching.length >= maximum) return { appended: false, reason: "limit", count: matching.length };
    return { appended: true, reason: "appended", count: matching.length + 1, record: appendJournalRecord(safePaths, journal, event, options.recordedAt) };
  } finally {
    release();
  }
}

export function readTaskJournal(cwd, options = {}) {
  const paths = taskJournalPaths(cwd);
  let safePath;
  try {
    safePath = resolveLocalStatePath(cwd, paths.events, { label: "Task journal events" });
  } catch {
    return { events: [], corruptions: ["journal path is unsafe"], head: undefined };
  }
  if (!fs.existsSync(safePath)) return { events: [], corruptions: [], head: undefined };
  const content = fs.readFileSync(safePath);
  const finalNewline = content.length === 0 || content.at(-1) === 0x0a;
  const lastNewline = finalNewline ? content.length - 1 : content.lastIndexOf(0x0a);
  const validBytes = finalNewline ? content.length : lastNewline + 1;
  const recoverableTailBytes = content.length - validBytes;
  const lines = content.subarray(0, validBytes).toString("utf8").split(/\r?\n/).filter(Boolean);
  const events = [];
  const corruptions = [];
  let previousHash;
  let expectedSequence = 1;
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruptions.push(`line ${index + 1}: invalid JSON`);
      continue;
    }
    const shape = validateEventShape(parsed);
    if (shape) {
      corruptions.push(`line ${index + 1}: ${shape}`);
      continue;
    }
    const actual = eventHash(parsed);
    if (actual !== parsed.hash) corruptions.push(`line ${index + 1}: hash mismatch`);
    if (parsed.sequence !== expectedSequence) corruptions.push(`line ${index + 1}: sequence gap`);
    if (parsed.previousHash !== previousHash) corruptions.push(`line ${index + 1}: previous hash mismatch`);
    previousHash = parsed.hash;
    expectedSequence = parsed.sequence + 1;
    if (options.taskRunId && parsed.taskRunId !== compactId(options.taskRunId)) continue;
    if (options.sessionId && parsed.sessionId !== String(options.sessionId)) continue;
    events.push(parsed);
  }
  const limit = Number.isInteger(options.limit) ? Math.max(0, options.limit) : events.length;
  const visibleEvents = limit === 0 ? [] : events.slice(-limit);
  return {
    events: visibleEvents,
    corruptions,
    recoverableTailBytes,
    validBytes,
    head: events.at(-1)
      ? { sequence: events.at(-1).sequence, hash: events.at(-1).hash, updatedAt: events.at(-1).recordedAt }
      : undefined
  };
}

export function taskJournalSnapshot(cwd, options = {}) {
  const journal = readTaskJournal(cwd, options);
  const byType = {};
  const byTask = {};
  for (const event of journal.events) {
    byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
    if (event.taskRunId) byTask[event.taskRunId] = (byTask[event.taskRunId] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    events: journal.events.length,
    corruptions: journal.corruptions,
    chainOk: journal.corruptions.length === 0,
    recoverableTailBytes: journal.recoverableTailBytes ?? 0,
    byType,
    byTask,
    head: journal.head
  };
}

export function recordTaskCheckpoint(cwd, checkpoint) {
  const treeErrors = checkpointTreeDigestValidationErrors(checkpoint?.evidence);
  if (treeErrors.length > 0) throw new Error(`Task checkpoint evidence is invalid: ${treeErrors.join("; ")}`);
  return appendTaskJournalEvent(cwd, {
    eventType: "checkpoint",
    taskRunId: checkpoint?.taskRunId,
    taskId: checkpoint?.taskId,
    sessionId: checkpoint?.sessionId,
    sessionName: checkpoint?.sessionName,
    checkpointId: checkpoint?.checkpointId,
    idempotencyKey: checkpoint?.idempotencyKey,
    data: {
      phase: checkpoint?.phase,
      status: checkpoint?.status,
      attempt: checkpoint?.attempt,
      evidence: checkpoint?.evidence
    }
  }, { recordedAt: checkpoint?.recordedAt });
}

export function replayTaskCheckpoints(cwd, taskRunId, task) {
  const journal = readTaskJournal(cwd, { taskRunId });
  const checkpoints = new Map();
  const idempotency = new Set();
  const corruptions = [...journal.corruptions];
  const migrationEvents = journal.events.filter((event) => event.eventType === "digest-migrated");
  const invalidMigration = migrationEvents.find((event) => !validDigestMigrationBarrier(event));
  if (invalidMigration) corruptions.push(`digest migration sequence ${invalidMigration.sequence}: marker is invalid`);
  if (!task && migrationEvents.length > 0) corruptions.push("digest migration replay requires Task Contract context");
  const mismatchedMigration = task && migrationEvents.find((event) => validDigestMigrationBarrier(event) && !digestMigrationBarrierMatchesTask(event, task));
  if (mismatchedMigration) corruptions.push(`digest migration sequence ${mismatchedMigration.sequence}: marker does not match the Task Contract`);
  if (task?.workingTreeDigestMigration && migrationEvents.length === 0) corruptions.push("Task Contract digest migration barrier is missing");
  const migrationBarrier = !task || invalidMigration || mismatchedMigration
    ? undefined
    : [...migrationEvents].reverse().find((event) => digestMigrationBarrierMatchesTask(event, task));
  for (const event of journal.events) {
    if (migrationBarrier && event.sequence <= migrationBarrier.sequence) continue;
    if (event.eventType !== "checkpoint") continue;
    const treeErrors = checkpointTreeDigestValidationErrors(event.data?.evidence);
    if (treeErrors.length > 0) {
      corruptions.push(`checkpoint sequence ${event.sequence}: ${treeErrors[0]}`);
      continue;
    }
    if (event.idempotencyKey && idempotency.has(event.idempotencyKey)) continue;
    if (event.idempotencyKey) idempotency.add(event.idempotencyKey);
    const checkpointId = event.checkpointId ?? "checkpoint";
    checkpoints.set(checkpointId, {
      checkpointId,
      taskRunId: event.taskRunId,
      sessionId: event.sessionId,
      sequence: event.sequence,
      recordedAt: event.recordedAt,
      ...event.data
    });
  }
  return {
    taskRunId,
    migrationBarrier: migrationBarrier
      ? { sequence: migrationBarrier.sequence, recordedAt: migrationBarrier.recordedAt, data: migrationBarrier.data }
      : undefined,
    checkpoints: [...checkpoints.values()].sort((left, right) => Number(left.sequence) - Number(right.sequence)),
    corruptions,
    resumeRequired: corruptions.length > 0
      || [...checkpoints.values()].some((checkpoint) => !["done", "skipped"].includes(String(checkpoint.status)))
  };
}

export function taskRecoveryDecision(task, replay = { checkpoints: [], corruptions: [] }, options = {}) {
  if (Array.isArray(replay.corruptions) && replay.corruptions.length > 0) {
    return {
      decision: "blocked",
      retryAllowed: false,
      reason: `Task journal corruption must be reviewed before automatic resume: ${replay.corruptions[0]}`
    };
  }
  const outcome = task?.trace?.outcome;
  if (["completed", "blocked", "partial", "failed"].includes(outcome)) {
    return {
      decision: "terminal",
      retryAllowed: false,
      reason: `Task contract is already ${outcome}.`
    };
  }
  const checkpoints = Array.isArray(replay.checkpoints) ? replay.checkpoints : [];
  const contractSteps = Array.isArray(task?.workPlan) ? task.workPlan : [];
  const contractOpen = contractSteps.findLast((step) => ["in-progress", "failed"].includes(String(step?.status)));
  const latestOpen = contractOpen
    ? { checkpointId: contractOpen.id, status: contractOpen.status, source: "task-contract" }
    : checkpoints.findLast((checkpoint) => !["done", "skipped"].includes(String(checkpoint.status)));
  if (!latestOpen) {
    return {
      decision: "resume",
      retryAllowed: false,
      checkpointId: undefined,
      reason: "No open checkpoint was found; resume from the current task contract."
    };
  }
  if (latestOpen.status === "paused") {
    return {
      decision: "paused",
      retryAllowed: false,
      checkpointId: latestOpen.checkpointId,
      reason: `Checkpoint ${latestOpen.checkpointId} is paused.`
    };
  }
  if (["failed", "blocked"].includes(String(latestOpen.status))) {
    const attempt = Number.isInteger(task?.attempt) ? task.attempt : 1;
    const maxAttempts = Number.isInteger(task?.maxAttempts) ? task.maxAttempts : Number.isInteger(options.maxAttempts) ? options.maxAttempts : 3;
    const retryAllowed = attempt < maxAttempts;
    return {
      decision: retryAllowed ? "retry" : "blocked",
      retryAllowed,
      checkpointId: latestOpen.checkpointId,
      reason: retryAllowed
        ? `Checkpoint ${latestOpen.checkpointId} failed; retry ${attempt + 1}/${maxAttempts} is allowed.`
        : `Checkpoint ${latestOpen.checkpointId} failed and retry budget is exhausted (${attempt}/${maxAttempts}).`
    };
  }
  return {
    decision: "resume",
    retryAllowed: false,
    checkpointId: latestOpen.checkpointId,
    reason: `Resume from checkpoint ${latestOpen.checkpointId}.`
  };
}

export function pruneTaskJournal(cwd, options = {}) {
  const maxEvents = Number.isInteger(options.maxEvents) ? Math.max(1, options.maxEvents) : 5_000;
  const journal = readTaskJournal(cwd);
  if (journal.events.length <= maxEvents && !journal.recoverableTailBytes) return { pruned: 0, kept: journal.events.length, corruptions: journal.corruptions };
  if (journal.corruptions.length > 0) {
    return { pruned: 0, kept: journal.events.length, corruptions: journal.corruptions, skipped: "corrupt-chain" };
  }
  const paths = taskJournalPaths(cwd);
  const safePaths = {
    root: ensurePrivateStateDirectory(cwd, paths.root, "Task journal root"),
    events: resolveLocalStatePath(cwd, paths.events, { label: "Task journal events" }),
    head: resolveLocalStatePath(cwd, paths.head, { label: "Task journal head" }),
    lock: resolveLocalStatePath(cwd, paths.lock, { label: "Task journal lock" })
  };
  const release = acquireLock(safePaths);
  try {
    const lockedJournal = recoverIncompleteJournalTail(cwd, safePaths, readTaskJournal(cwd));
    if (lockedJournal.corruptions.length > 0) {
      return { pruned: 0, kept: lockedJournal.events.length, corruptions: lockedJournal.corruptions, skipped: "corrupt-chain" };
    }
    if (lockedJournal.events.length <= maxEvents) {
      return { pruned: 0, kept: lockedJournal.events.length, corruptions: [] };
    }
    const tailStart = Math.max(0, lockedJournal.events.length - maxEvents);
    const retained = lockedJournal.events
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => index >= tailStart || event.eventType === "digest-migrated");
    if (retained.length === lockedJournal.events.length) {
      return { pruned: 0, kept: retained.length, corruptions: [], skipped: "migration-barrier-retention" };
    }
    const prunedAt = nowIso();
    let previousRetainedIndex = -1;
    const kept = retained.map(({ event, index }) => {
      const { hash: _oldHash, previousHash: _oldPreviousHash, ...rest } = event;
      const gap = index - previousRetainedIndex - 1;
      previousRetainedIndex = index;
      if (gap === 0) return rest;
      const previousAnchors = Array.isArray(event.retentionAnchors) ? event.retentionAnchors.slice(-7) : [];
      return { ...rest, retentionAnchors: [...previousAnchors, {
        prunedEvents: gap,
        prefixHash: event.previousHash,
        priorHeadHash: lockedJournal.head?.hash,
        recordedAt: prunedAt
      }] };
    });
    let previousHash;
    const rewritten = kept.map((event, index) => {
      const record = {
        ...event,
        sequence: index + 1,
        previousHash
      };
      record.hash = eventHash(record);
      previousHash = record.hash;
      return record;
    });
    writeEventsAtomic(safePaths, rewritten);
    const last = rewritten.at(-1);
    writeHead(safePaths, { schemaVersion: 1, sequence: last.sequence, hash: last.hash, updatedAt: last.recordedAt });
    return { pruned: lockedJournal.events.length - rewritten.length, kept: rewritten.length, corruptions: [] };
  } finally {
    release();
  }
}

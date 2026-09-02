import { createHash, createHmac, KeyObject, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { durableTaskContractMatches, normalizeTaskContract, taskContractValidationErrors } from "../../extensions/task-state.js";
import { isCurrentWorkingTreeDigest } from "../../extensions/working-tree-digest.js";
import { openCompositeAssuranceJournal } from "./runtime-assurance-facts.ts";

export const COMPOSITE_TASK_PUBLICATION_VERSION = "composite-task-publication-v1";
export const COMPOSITE_TERMINAL_TASK_TARGET_VERSION = "composite-terminal-task-target-v1";
export const COMPOSITE_JOURNAL_PUBLICATION_VERSION = "composite-journal-publication-v1";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function exact(value: any, fields: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalTask(value: any, outcome?: "pending" | "completed"): TaskContract {
  const cloned = structuredClone(value), normalized = normalizeTaskContract(cloned);
  if (!normalized || taskContractValidationErrors(normalized).length || outcome && normalized.trace.outcome !== outcome) {
    throw new Error("Composite publication task contract is invalid");
  }
  return normalized as TaskContract;
}

/** updatedAt is storage metadata; every other normalized task byte is publication identity. */
export function compositeTaskPublicationDigest(value: TaskContract): string {
  const task = canonicalTask(value), { updatedAt: _updatedAt, ...identity } = task;
  return sha(JSON.stringify(identity));
}

function privateDirectory(directory: string, projectRoot: string) {
  const root = fs.realpathSync.native(projectRoot);
  if (!path.isAbsolute(directory) || fs.realpathSync.native(directory) !== directory) throw new Error("Publication directory is not canonical");
  const relative = path.relative(root, directory), stat = fs.lstatSync(directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Publication directory is not private host state");
  }
  return root;
}

function key32(key: unknown): asserts key is KeyObject {
  if (!(key instanceof KeyObject) || key.type !== "secret" || key.symmetricKeySize !== 32) throw new TypeError("Expected host 256-bit secret key");
}

function validateEntry(value: any, terminalTaskDigest: string) {
  exact(value, ["version", "criterionId", "criterionHash", "contextDigest", "journalFile", "preAggregateHead", "aggregate"],
    "composite journal publication");
  exact(value.aggregate, ["idempotencyKey", "assessmentDigest", "taskPublicationDigest"], "composite aggregate publication");
  if (value.version !== COMPOSITE_JOURNAL_PUBLICATION_VERSION || !ID.test(value.criterionId) || !HASH.test(value.criterionHash)
    || !HASH.test(value.contextDigest) || !/^composite-[a-f0-9]{64}\.jsonl$/.test(value.journalFile)
    || !HASH.test(value.preAggregateHead) || !HASH.test(value.aggregate.idempotencyKey)
    || !HASH.test(value.aggregate.assessmentDigest) || value.aggregate.taskPublicationDigest !== terminalTaskDigest) {
    throw new Error("Composite journal publication identity is invalid");
  }
  return value;
}

function validatePayload(value: any, projectRoot: string) {
  exact(value, ["version", "projectId", "taskRunId", "sessionId", "operatorRequestDigest", "pendingTaskDigest",
    "terminalTaskDigest", "workingTreeDigest", "terminalTask", "entries"], "composite task publication");
  const task = canonicalTask(value.terminalTask, "completed");
  if (value.version !== COMPOSITE_TASK_PUBLICATION_VERSION || value.projectId !== sha(fs.realpathSync.native(projectRoot))
    || value.taskRunId !== task.taskRunId || value.sessionId !== task.sessionId
    || value.operatorRequestDigest !== task.operatorRequestDigest || !ID.test(value.taskRunId) || !ID.test(value.sessionId)
    || !/^operator-request-v1:[a-f0-9]{64}$/.test(value.operatorRequestDigest) || !HASH.test(value.pendingTaskDigest)
    || value.terminalTaskDigest !== compositeTaskPublicationDigest(task) || !isCurrentWorkingTreeDigest(value.workingTreeDigest)
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 12) {
    throw new Error("Composite task publication target is invalid");
  }
  const ids = new Set<string>();
  for (const entry of value.entries) {
    validateEntry(entry, value.terminalTaskDigest);
    if (ids.has(entry.criterionId)) throw new Error("Duplicate composite publication criterion");
    ids.add(entry.criterionId);
  }
  value.terminalTask = task;
  return value;
}

type JournalStatus = "pre-aggregate" | "aggregate-settled" | "task-completed";

export function openCompositeTaskPublicationStore({ key, directory, projectRoot }: {
  key: KeyObject; directory: string; projectRoot: string }) {
  key32(key); privateDirectory(directory, projectRoot);
  const records = new WeakSet<object>();
  const fileFor = (taskRunId: string, sessionId: string) => path.join(directory,
    `composite-publication-${sha(`${taskRunId}\0${sessionId}`)}.json`);
  const signature = (file: string, text: string) => createHmac("sha256", key)
    .update(`${COMPOSITE_TASK_PUBLICATION_VERSION}\0${file}\0${text}`).digest("hex");

  function readFile(file: string) {
    if (!fs.existsSync(file)) return null;
    const atPath = fs.lstatSync(file, { bigint: true });
    if (!atPath.isFile() || atPath.isSymbolicLink() || atPath.nlink !== 1n || atPath.uid !== BigInt(process.getuid())
      || (atPath.mode & 0o077n) !== 0n || atPath.size < 1n || atPath.size > BigInt(MAX_BYTES)) {
      throw new Error("Composite publication file is unsafe");
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
      const fields = ["dev", "ino", "mode", "nlink", "uid", "size", "mtimeNs", "ctimeNs"];
      if (bytes.length !== Number(before.size) || fields.some(field => before[field] !== after[field] || after[field] !== atPath[field])) {
        throw new Error("Composite publication changed during read");
      }
      const envelope = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ["payload", "signature"], "composite publication envelope");
      if (!Buffer.from(JSON.stringify(envelope)).equals(bytes) || !HASH.test(envelope.signature)) throw new Error("Composite publication is noncanonical");
      const text = JSON.stringify(envelope.payload), expected = signature(file, text);
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(envelope.signature, "hex"))) {
        throw new Error("Composite publication signature is invalid");
      }
      const record = freeze(validatePayload(envelope.payload, projectRoot)); records.add(record); return record;
    } finally { fs.closeSync(fd); }
  }

  function read(taskRunId: string, sessionId: string) {
    if (!ID.test(taskRunId) || !ID.test(sessionId)) throw new TypeError("Invalid composite publication task identity");
    return readFile(fileFor(taskRunId, sessionId));
  }

  function trusted(record: any) {
    if (!record || !records.has(record)) throw new Error("Untrusted composite task publication");
    const current = readFile(fileFor(record.taskRunId, record.sessionId));
    if (!current || JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Composite task publication changed");
    return current;
  }

  function journalStatus(entry: any): JournalStatus {
    const filePath = path.join(directory, entry.journalFile);
    const journal = openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest: entry.contextDigest });
    try {
      const head = journal.head(), events = journal.events();
      if (head === entry.preAggregateHead) return "pre-aggregate";
      const first = events.findIndex((event: any) => event.previous === entry.preAggregateHead);
      if (first < 0) throw new Error("Composite publication journal does not extend its prepared head");
      const tail = events.slice(first);
      if (tail.length < 1 || tail.length > 2 || tail[0].kind !== "aggregate-settled"
        || JSON.stringify(tail[0].data) !== JSON.stringify(entry.aggregate)) {
        throw new Error("Composite publication aggregate journal mismatch");
      }
      if (tail.length === 1) return "aggregate-settled";
      if (tail[1].kind !== "task-completed" || JSON.stringify(tail[1].data) !== JSON.stringify(entry.aggregate)) {
        throw new Error("Composite publication completion journal mismatch");
      }
      return "task-completed";
    } finally { journal.close(); }
  }

  function appendCompletion(entry: any) {
    const filePath = path.join(directory, entry.journalFile);
    const journal = openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest: entry.contextDigest });
    try { journal.append("task-completed", entry.aggregate); } finally { journal.close(); }
  }

  function appendAggregate(entry: any) {
    const filePath = path.join(directory, entry.journalFile);
    const journal = openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest: entry.contextDigest });
    try {
      if (journal.head() !== entry.preAggregateHead) throw new Error("Composite aggregate recovery head changed");
      journal.append("aggregate-settled", entry.aggregate);
    } finally { journal.close(); }
  }

  function inspect(record: any) {
    const current = trusted(record);
    const statuses = current.entries.map((entry: any) => ({ criterionId: entry.criterionId, status: journalStatus(entry) }));
    return freeze({ statuses, allSettled: statuses.every(item => item.status !== "pre-aggregate"),
      allCompleted: statuses.every(item => item.status === "task-completed") });
  }

  function prepare({ pendingTask, terminalTask, workingTreeDigest, entries }: any) {
    const pending = canonicalTask(pendingTask, "pending"), terminal = canonicalTask(terminalTask, "completed");
    if (pending.taskRunId !== terminal.taskRunId || pending.sessionId !== terminal.sessionId
      || pending.operatorRequestDigest !== terminal.operatorRequestDigest || !isCurrentWorkingTreeDigest(workingTreeDigest)) {
      throw new Error("Composite publication pending and terminal tasks do not match");
    }
    const payload = validatePayload({ version: COMPOSITE_TASK_PUBLICATION_VERSION,
      projectId: sha(fs.realpathSync.native(projectRoot)), taskRunId: terminal.taskRunId, sessionId: terminal.sessionId,
      operatorRequestDigest: terminal.operatorRequestDigest, pendingTaskDigest: compositeTaskPublicationDigest(pending),
      terminalTaskDigest: compositeTaskPublicationDigest(terminal), workingTreeDigest, terminalTask: terminal,
      entries: structuredClone(entries) }, projectRoot);
    const file = fileFor(payload.taskRunId, payload.sessionId), text = JSON.stringify(payload);
    const envelope = Buffer.from(JSON.stringify({ payload, signature: signature(file, text) }));
    if (envelope.length > MAX_BYTES) throw new Error("Composite publication exceeds byte bound");
    const existing = readFile(file);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(payload)) throw new Error("Different composite publication already exists");
      return existing;
    }
    for (const entry of payload.entries) if (journalStatus(entry) !== "pre-aggregate") {
      throw new Error("Aggregate exists without its durable task publication intent");
    }
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW, 0o600);
    try {
      try {
        for (let offset = 0; offset < envelope.length;) {
          const written = fs.writeSync(fd, envelope, offset, envelope.length - offset);
          if (written < 1) throw new Error("Composite publication write was incomplete");
          offset += written;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
      const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    const observed = readFile(file);
    if (!observed || JSON.stringify(observed) !== JSON.stringify(payload)) throw new Error("Composite publication readback failed");
    return observed;
  }

  function settle(record: any) {
    const current = trusted(record);
    for (const entry of current.entries) if (journalStatus(entry) === "pre-aggregate") appendAggregate(entry);
    const result = inspect(current);
    if (!result.allSettled) throw new Error("Composite aggregate settlement recovery is incomplete");
    return result;
  }

  function complete(record: any) {
    const current = trusted(record);
    const before = inspect(current);
    if (!before.allSettled) throw new Error("Composite task cannot complete before every aggregate");
    for (const entry of current.entries) if (journalStatus(entry) === "aggregate-settled") appendCompletion(entry);
    const result = inspect(current);
    if (!result.allCompleted) throw new Error("Composite task completion recovery is incomplete");
    return result;
  }

  return Object.freeze({ version: COMPOSITE_TASK_PUBLICATION_VERSION, read, prepare, inspect, settle, complete });
}

export function recoverCompositeTaskPublication({ store, record, task, currentWorkingTreeDigest,
  expectedCriteria, cwd, writeTask }: any): TaskContract {
  if (!store || store.version !== COMPOSITE_TASK_PUBLICATION_VERSION || !Array.isArray(expectedCriteria)
    || typeof writeTask !== "function" || record.operatorRequestDigest !== task.operatorRequestDigest
    || record.workingTreeDigest !== currentWorkingTreeDigest) throw new Error("Composite publication recovery binding changed");
  const expected = expectedCriteria.map((item: any) => `${item.criterionId}\0${item.criterionHash}`).sort();
  const actual = record.entries.map((item: any) => `${item.criterionId}\0${item.criterionHash}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Composite publication criteria changed");
  let completed = canonicalTask(task);
  if (completed.trace.outcome === "pending") {
    if (compositeTaskPublicationDigest(completed) !== record.pendingTaskDigest) throw new Error("Composite pending task changed before recovery");
  } else if (completed.trace.outcome !== "completed" || compositeTaskPublicationDigest(completed) !== record.terminalTaskDigest) {
    throw new Error("Composite terminal task does not match its publication");
  }
  store.settle(record);
  if (completed.trace.outcome === "pending") completed = writeTask(cwd, record.terminalTask);
  if (!durableTaskContractMatches(cwd, completed)) throw new Error("Recovered terminal task is not durable");
  store.complete(record); return completed;
}

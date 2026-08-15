import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Receipt } from "../contracts/generated/session-command-v1.ts";

const FILE_LIMIT = 8 * 1024 * 1024;
const RECORD_LIMIT = 16 * 1024;
const ENTRY_LIMIT = 20_000;
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const REASON = /^[a-z0-9][a-z0-9.-]{0,95}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTIONS = ["session.create", "session.send", "session.abort", "session.set-model", "session.set-thinking", "session.set-permission", "session.rename", "session.pin", "session.archive",
  "session.unarchive", "session.fork", "session.acquire", "session.release"] as const;

export type SessionAction = typeof ACTIONS[number];
export type SessionCommandIdentity = { commandId: string; idempotencyKey: string; action: SessionAction; sessionRef: string | null; requestedAt: string };
type JournalRecord = {
  version: "piagent-session-command-journal-v1";
  sequence: number;
  recordedAt: string;
  recordType: "intent" | "receipt";
  commandId: string;
  idempotencyKeyDigest: string;
  actionDigest: string;
  action: SessionAction;
  sessionRef: string | null;
  requestedAt: string;
  receipt: Receipt | null;
  previousDigest: string | null;
  recordDigest: string;
};

type CommandBinding = { intent: JournalRecord; receipt: Receipt | null };

function exactTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function exactKeys(value: object, keys: string[]): boolean {
  const found = Object.keys(value);
  return found.length === keys.length && found.every((key) => keys.includes(key));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function unsigned(record: JournalRecord): Omit<JournalRecord, "recordDigest"> {
  const { recordDigest: _ignored, ...value } = record;
  return value;
}
function validError(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && exactKeys(value as object, ["code", "message"]) && REASON.test(String((value as any).code))
    && typeof (value as any).message === "string" && (value as any).message.length >= 1 && (value as any).message.length <= 500
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test((value as any).message));
}

export function validSessionReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Receipt;
  if (!exactKeys(receipt, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKeyDigest", "action", "phase",
    "resultCode", "requestedAt", "settledAt", "sessionRef", "operationRef", "catalogRevisionAfter", "sessionRevisionAfter",
    "deduplicated", "evidenceRef", "error"]) || receipt.schemaVersion !== 1 || receipt.version !== "piagent-session-receipt-v1"
    || receipt.messageType !== "receipt" || !REF.test(receipt.commandId) || !DIGEST.test(receipt.idempotencyKeyDigest)
    || !ACTIONS.includes(receipt.action) || !exactTimestamp(receipt.requestedAt) || !REVISION.test(receipt.catalogRevisionAfter)
    || !(receipt.sessionRef === null || REF.test(receipt.sessionRef)) || !(receipt.operationRef === null || REF.test(receipt.operationRef))
    || !(receipt.sessionRevisionAfter === null || REVISION.test(receipt.sessionRevisionAfter)) || typeof receipt.deduplicated !== "boolean") return false;
  const settled = exactTimestamp(receipt.settledAt), evidence = typeof receipt.evidenceRef === "string" && REF.test(receipt.evidenceRef);
  if (receipt.phase === "accepted") return receipt.resultCode === "accepted" && receipt.settledAt === null && receipt.evidenceRef === null && receipt.error === null;
  if (receipt.phase === "settled") {
    const results = ["created", "started", "queued", "steered", "aborted", "model-changed", "thinking-changed", "permission-changed", "renamed", "pinned", "unpinned", "archived", "unarchived",
      "forked", "acquired", "released", "no-change"];
    const actionResults: Partial<Record<SessionAction, string[]>> = {
      "session.create": ["created", "started"],
      "session.acquire": ["acquired", "no-change"], "session.release": ["released", "no-change"],
      "session.send": ["started", "queued", "steered"], "session.abort": ["aborted", "no-change"],
      "session.set-model": ["model-changed", "no-change"], "session.set-thinking": ["thinking-changed", "no-change"],
      "session.set-permission": ["permission-changed", "no-change"], "session.rename": ["renamed", "no-change"],
      "session.pin": ["pinned", "unpinned", "no-change"], "session.archive": ["archived", "no-change"],
      "session.unarchive": ["unarchived", "no-change"], "session.fork": ["forked"]
    };
    return settled && evidence && receipt.error === null && results.includes(receipt.resultCode)
      && (!actionResults[receipt.action] || actionResults[receipt.action]!.includes(receipt.resultCode))
      && (receipt.action === "session.create" ? (receipt.resultCode === "started" ? receipt.operationRef !== null : receipt.operationRef === null)
        : ["session.send", "session.abort"].includes(receipt.action) ? receipt.operationRef !== null : receipt.operationRef === null)
      && (receipt.action !== "session.create" || ["created", "started"].includes(receipt.resultCode) && receipt.sessionRef !== null
        && receipt.sessionRevisionAfter !== null)
      && (receipt.action !== "session.fork" || receipt.resultCode === "forked" && receipt.sessionRef !== null
        && receipt.sessionRevisionAfter !== null);
  }
  if (receipt.phase === "uncertain") return settled && receipt.resultCode === "effect-unknown" && validError(receipt.error)
    && (receipt.evidenceRef === null || evidence);
  return receipt.phase === "rejected" && settled && ["stale-revision", "owner-conflict", "recovery-required", "invalid-command", "expired", "unavailable"]
    .includes(receipt.resultCode) && receipt.evidenceRef === null && validError(receipt.error);
}

export class SessionCommandStore {
  readonly directory: string;
  readonly file: string;
  readonly #key: Buffer;

  constructor(root: string, key: Buffer) {
    this.directory = path.join(root, "commands");
    this.file = path.join(this.directory, "admission.jsonl");
    this.#key = key;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("session-command-root-invalid");
    fs.chmodSync(this.directory, 0o700);
  }

  #digest(namespace: string, value: unknown): string {
    return `sha256:${createHmac("sha256", this.#key).update(namespace).update("\0").update(canonical(value)).digest("hex")}`;
  }
  idempotencyDigest(key: string): string { return this.#digest("idempotency", key); }
  actionDigest(command: unknown): string { return this.#digest("action", command); }

  #valid(record: unknown, index: number, previousDigest: string | null): record is JournalRecord {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const value = record as JournalRecord;
    if (!exactKeys(value, ["version", "sequence", "recordedAt", "recordType", "commandId", "idempotencyKeyDigest", "actionDigest",
      "action", "sessionRef", "requestedAt", "receipt", "previousDigest", "recordDigest"]) || value.version !== "piagent-session-command-journal-v1"
      || value.sequence !== index + 1 || !exactTimestamp(value.recordedAt) || !["intent", "receipt"].includes(value.recordType)
      || !REF.test(value.commandId) || !DIGEST.test(value.idempotencyKeyDigest) || !DIGEST.test(value.actionDigest)
      || !ACTIONS.includes(value.action) || !(value.sessionRef === null || REF.test(value.sessionRef)) || !exactTimestamp(value.requestedAt)
      || value.previousDigest !== previousDigest || !DIGEST.test(value.recordDigest)) return false;
    if (value.recordType === "intent" ? value.receipt !== null : !validSessionReceipt(value.receipt)) return false;
    const createsSession = value.action === "session.create" || value.action === "session.fork";
    const receiptSessionBound = !value.receipt ? true : !createsSession ? value.receipt.sessionRef === value.sessionRef
      : value.receipt.phase === "settled" ? value.receipt.sessionRef !== null
        : value.receipt.phase === "rejected" ? value.receipt.sessionRef === value.sessionRef : true;
    if (value.receipt && (value.receipt.commandId !== value.commandId || value.receipt.idempotencyKeyDigest !== value.idempotencyKeyDigest
      || value.receipt.action !== value.action || value.receipt.requestedAt !== value.requestedAt || !receiptSessionBound)) return false;
    return value.recordDigest === this.#digest("record", unsigned(value));
  }

  #read(): JournalRecord[] {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_LIMIT) throw new Error("session-command-file-invalid");
    const descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("session-command-file-race");
      const lines = fs.readFileSync(descriptor, "utf8").split("\n"); if (lines.at(-1) === "") lines.pop();
      if (lines.length > ENTRY_LIMIT) throw new Error("session-command-entry-limit");
      const records: JournalRecord[] = [];
      for (const [index, line] of lines.entries()) {
        if (!line || Buffer.byteLength(line) > RECORD_LIMIT) throw new Error("session-command-record-limit");
        let value: unknown; try { value = JSON.parse(line); } catch { throw new Error("session-command-record-invalid"); }
        if (!this.#valid(value, index, records.at(-1)?.recordDigest ?? null)) throw new Error("session-command-record-invalid");
        records.push(value);
      }
      const byCommand = new Map<string, JournalRecord>(), byKey = new Map<string, JournalRecord>(), settled = new Set<string>();
      for (const record of records) {
        if (record.recordType === "intent") {
          if (byCommand.has(record.commandId) || byKey.has(record.idempotencyKeyDigest)) throw new Error("session-command-binding-duplicate");
          byCommand.set(record.commandId, record); byKey.set(record.idempotencyKeyDigest, record);
        } else {
          const intent = byCommand.get(record.commandId);
          if (!intent || intent.idempotencyKeyDigest !== record.idempotencyKeyDigest || intent.actionDigest !== record.actionDigest
            || settled.has(record.commandId)) {
            throw new Error("session-command-chain-invalid");
          }
          settled.add(record.commandId);
        }
      }
      return records;
    } finally { fs.closeSync(descriptor); }
  }

  #append(value: Omit<JournalRecord, "version" | "sequence" | "recordedAt" | "previousDigest" | "recordDigest">, now = new Date()): JournalRecord {
    if (!Number.isFinite(now.getTime())) throw new Error("session-command-time-invalid");
    const records = this.#read(); if (records.length >= ENTRY_LIMIT) throw new Error("session-command-entry-limit");
    const partial = { version: "piagent-session-command-journal-v1" as const, sequence: records.length + 1, recordedAt: now.toISOString(),
      previousDigest: records.at(-1)?.recordDigest ?? null, ...value };
    const record: JournalRecord = { ...partial, recordDigest: this.#digest("record", partial) };
    const body = Buffer.from(`${JSON.stringify(record)}\n`); if (body.length > RECORD_LIMIT) throw new Error("session-command-record-limit");
    let stat: fs.Stats | null = null; try { stat = fs.lstatSync(this.file); } catch { /* first record */ }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size + body.length > FILE_LIMIT)) throw new Error("session-command-file-invalid");
    const descriptor = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.chmodSync(this.file, 0o600); return record;
  }

  lookup(command: SessionCommandIdentity): { state: "none" | "pending" | "settled" | "conflict" | "unavailable"; receipt?: Receipt } {
    try {
      const records = this.#read(), keyDigest = this.idempotencyDigest(command.idempotencyKey), actionDigest = this.actionDigest(command);
      const intent = records.find((record) => record.recordType === "intent"
        && (record.commandId === command.commandId || record.idempotencyKeyDigest === keyDigest));
      if (!intent) return { state: "none" };
      if (intent.commandId !== command.commandId || intent.idempotencyKeyDigest !== keyDigest || intent.actionDigest !== actionDigest) return { state: "conflict" };
      const receipt = records.find((record) => record.recordType === "receipt" && record.commandId === command.commandId)?.receipt ?? null;
      return receipt ? { state: "settled", receipt: structuredClone(receipt) } : { state: "pending" };
    } catch { return { state: "unavailable" }; }
  }

  admit(command: SessionCommandIdentity, now = new Date()): { idempotencyKeyDigest: string; actionDigest: string } {
    const existing = this.lookup(command);
    if (existing.state !== "none") throw new Error(`session-command-${existing.state}`);
    const idempotencyKeyDigest = this.idempotencyDigest(command.idempotencyKey), actionDigest = this.actionDigest(command);
    this.#append({ recordType: "intent", commandId: command.commandId, idempotencyKeyDigest, actionDigest, action: command.action,
      sessionRef: command.sessionRef, requestedAt: command.requestedAt, receipt: null }, now);
    return { idempotencyKeyDigest, actionDigest };
  }

  settle(command: SessionCommandIdentity, receipt: Receipt, now = new Date()): void {
    if (!validSessionReceipt(receipt)) throw new Error("session-command-receipt-invalid");
    const existing = this.lookup(command);
    if (existing.state !== "pending") throw new Error(`session-command-${existing.state}`);
    this.#append({ recordType: "receipt", commandId: command.commandId, idempotencyKeyDigest: this.idempotencyDigest(command.idempotencyKey),
      actionDigest: this.actionDigest(command), action: command.action, sessionRef: command.sessionRef, requestedAt: command.requestedAt,
      receipt: structuredClone(receipt) }, now);
  }
}

import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";

const FILE_LIMIT = 4 * 1024 * 1024;
const RECORD_LIMIT = 8 * 1024;
const ENTRY_LIMIT = 10_000;
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

export type SessionMetadata = {
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  projectGroup: string | null;
  revision: string;
};

type MetadataRecord = {
  version: "piagent-session-metadata-v1";
  sequence: number;
  recordedAt: string;
  sessionRef: string;
  previousRevision: string | null;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  projectGroup: string | null;
};

export type MetadataSnapshot = {
  state: "ready" | "unavailable";
  revision: string | null;
  sessions: ReadonlyMap<string, SessionMetadata>;
  reasonCode: string | null;
};

function digest(key: Buffer, namespace: string, value: unknown): string {
  return `${namespace}_${createHmac("sha256", key).update(JSON.stringify(value)).digest("hex")}`;
}

function exactTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function safeGroup(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("session-metadata-group-invalid");
  const text = redactSensitiveText(value).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > 120) throw new Error("session-metadata-group-invalid");
  return text;
}

function validRecord(value: unknown): value is MetadataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<MetadataRecord>;
  return Object.keys(record).every((key) => ["version", "sequence", "recordedAt", "sessionRef", "previousRevision",
    "pinned", "archived", "unread", "projectGroup"].includes(key))
    && record.version === "piagent-session-metadata-v1"
    && Number.isSafeInteger(record.sequence) && Number(record.sequence) > 0
    && exactTimestamp(record.recordedAt) && typeof record.sessionRef === "string" && REF.test(record.sessionRef)
    && (record.previousRevision === null || typeof record.previousRevision === "string" && REF.test(record.previousRevision))
    && typeof record.pinned === "boolean" && typeof record.archived === "boolean" && typeof record.unread === "boolean"
    && (record.projectGroup === null || typeof record.projectGroup === "string" && record.projectGroup.length > 0
      && record.projectGroup.length <= 120 && !/[\u0000-\u001f\u007f]/.test(record.projectGroup));
}

export class SessionMetadataStore {
  readonly directory: string;
  readonly file: string;
  readonly #key: Buffer;

  constructor(root: string, key: Buffer) {
    this.directory = path.join(root, "sessions");
    this.file = path.join(this.directory, "index.jsonl");
    this.#key = key;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("session-metadata-root-invalid");
    fs.chmodSync(this.directory, 0o700);
  }

  #readRecords(): MetadataRecord[] {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); }
    catch { return []; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_LIMIT) throw new Error("session-metadata-file-invalid");
    const descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("session-metadata-file-race");
      const text = fs.readFileSync(descriptor, "utf8");
      const lines = text ? text.split("\n") : [];
      if (lines.at(-1) === "") lines.pop();
      if (lines.length > ENTRY_LIMIT) throw new Error("session-metadata-entry-limit");
      return lines.map((line, index) => {
        if (!line || Buffer.byteLength(line) > RECORD_LIMIT) throw new Error("session-metadata-record-limit");
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error("session-metadata-record-invalid"); }
        if (!validRecord(value) || value.sequence !== index + 1) throw new Error("session-metadata-record-invalid");
        return value;
      });
    } finally { fs.closeSync(descriptor); }
  }

  read(): MetadataSnapshot {
    try {
      const records = this.#readRecords();
      const sessions = new Map<string, SessionMetadata>();
      for (const record of records) {
        const prior = sessions.get(record.sessionRef);
        if (record.previousRevision !== (prior?.revision ?? null)) throw new Error("session-metadata-chain-invalid");
        sessions.set(record.sessionRef, {
          pinned: record.pinned, archived: record.archived, unread: record.unread, projectGroup: record.projectGroup,
          revision: digest(this.#key, "metadata-revision", record)
        });
      }
      return { state: "ready", revision: digest(this.#key, "metadata-store", records), sessions, reasonCode: null };
    } catch {
      return { state: "unavailable", revision: null, sessions: new Map(), reasonCode: "metadata-overlay-unavailable" };
    }
  }

  update(sessionRef: string, expectedRevision: string | null, patch: Partial<Pick<SessionMetadata, "pinned" | "archived" | "unread" | "projectGroup">>, now = new Date()): SessionMetadata {
    if (!REF.test(sessionRef)) throw new Error("session-metadata-ref-invalid");
    const snapshot = this.read();
    if (snapshot.state !== "ready") throw new Error(snapshot.reasonCode ?? "session-metadata-unavailable");
    const current = snapshot.sessions.get(sessionRef);
    if ((current?.revision ?? null) !== expectedRevision) throw new Error("session-metadata-stale-revision");
    if (!Number.isFinite(now.getTime())) throw new Error("session-metadata-time-invalid");
    const record: MetadataRecord = {
      version: "piagent-session-metadata-v1", sequence: this.#readRecords().length + 1, recordedAt: now.toISOString(), sessionRef,
      previousRevision: current?.revision ?? null, pinned: patch.pinned ?? current?.pinned ?? false,
      archived: patch.archived ?? current?.archived ?? false, unread: patch.unread ?? current?.unread ?? false,
      projectGroup: "projectGroup" in patch ? safeGroup(patch.projectGroup) : current?.projectGroup ?? null
    };
    const body = Buffer.from(`${JSON.stringify(record)}\n`);
    if (body.length > RECORD_LIMIT) throw new Error("session-metadata-record-limit");
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(this.file); } catch { /* first record */ }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size + body.length > FILE_LIMIT)) throw new Error("session-metadata-file-invalid");
    const descriptor = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.chmodSync(this.file, 0o600);
    return this.read().sessions.get(sessionRef)!;
  }
}

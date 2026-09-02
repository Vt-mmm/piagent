import { createHmac, KeyObject, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";

const VERSION = "composite-assurance-anchor-v1";
const JOURNAL_VERSION = "composite-assurance-journal-v1";
const HASH = /^[a-f0-9]{64}$/;
const MAX_ANCHOR_BYTES = 4 * 1024 * 1024;
const FIELDS = ["version", "filePath", "contextDigest", "state", "previousHead", "nextHead", "line"];

type AnchorPayload = { version: string; filePath: string; contextDigest: string; state: "prepared" | "committed";
  previousHead: string | null; nextHead: string; line: string };

function exact(value: any, fields: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function sameFile(a: any, b: any) {
  return ["dev", "ino", "mode", "nlink", "uid", "size", "mtimeNs", "ctimeNs"]
    .every(field => a[field] === b[field]);
}

function writeAll(fd: number, bytes: Buffer, position: number | null = null) {
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset,
      position === null ? null : position + offset);
    if (written < 1) throw new Error("Composite anchor write was incomplete");
    offset += written;
  }
  fs.fsyncSync(fd);
}

/** A private second durable record. A prepared anchor contains the exact signed
 * next journal line, so either side of a process crash can be reconciled without
 * accepting a caller-supplied head or discarding a persisted event. */
export function openCompositeJournalAnchor({ anchorPath, filePath, contextDigest, key }: {
  anchorPath: string; filePath: string; contextDigest: string; key: KeyObject }) {
  if (!(key instanceof KeyObject) || key.type !== "secret" || key.symmetricKeySize !== 32
    || !path.isAbsolute(anchorPath) || path.resolve(anchorPath) !== anchorPath
    || path.dirname(anchorPath) !== path.dirname(filePath) || !HASH.test(contextDigest)) {
    throw new TypeError("Invalid composite anchor identity");
  }
  const directory = path.dirname(anchorPath), parent = fs.lstatSync(directory);
  if (fs.realpathSync.native(directory) !== directory || !parent.isDirectory() || parent.isSymbolicLink()
    || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) {
    throw new Error("Composite anchor directory is unsafe");
  }
  const anchorDomain = `${VERSION}\0${anchorPath}\0${contextDigest}`;
  const journalDomain = `${JOURNAL_VERSION}\0${filePath}\0${contextDigest}`;
  const signature = (domain: string, text: string) => createHmac("sha256", key).update(`${domain}\0${text}`).digest("hex");

  function lineBytes(payload: AnchorPayload): Buffer {
    const bytes = Buffer.from(payload.line, "base64");
    if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.at(-1) !== 10
      || bytes.toString("base64") !== payload.line) throw new Error("Composite anchor line is invalid");
    const journalEnvelope = exact(JSON.parse(bytes.subarray(0, -1).toString("utf8")), ["payload", "signature"], "anchored journal envelope");
    const text = JSON.stringify(journalEnvelope.payload);
    if (!HASH.test(journalEnvelope.signature) || journalEnvelope.signature !== payload.nextHead
      || !timingSafeEqual(Buffer.from(signature(journalDomain, text), "hex"), Buffer.from(journalEnvelope.signature, "hex"))
      || journalEnvelope.payload?.previous !== payload.previousHead) {
      throw new Error("Composite anchor journal signature is invalid");
    }
    return bytes;
  }

  function validate(payload: any): AnchorPayload {
    exact(payload, FIELDS, "composite anchor payload");
    if (payload.version !== VERSION || payload.filePath !== filePath || payload.contextDigest !== contextDigest
      || !["prepared", "committed"].includes(payload.state) || !HASH.test(payload.nextHead)
      || payload.previousHead !== null && !HASH.test(payload.previousHead) || typeof payload.line !== "string") {
      throw new Error("Composite anchor payload is invalid");
    }
    lineBytes(payload); return payload;
  }

  function read(): AnchorPayload | null {
    if (!fs.existsSync(anchorPath)) return null;
    const atPath = fs.lstatSync(anchorPath, { bigint: true });
    if (!atPath.isFile() || atPath.isSymbolicLink() || atPath.nlink !== 1n
      || atPath.uid !== BigInt(process.getuid()) || (atPath.mode & 0o077n) !== 0n
      || atPath.size < 1n || atPath.size > BigInt(MAX_ANCHOR_BYTES)) throw new Error("Composite anchor file is unsafe");
    const fd = fs.openSync(anchorPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
      if (bytes.length !== Number(before.size) || !sameFile(atPath, before) || !sameFile(before, after)) {
        throw new Error("Composite anchor changed during read");
      }
      const envelope = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ["payload", "signature"], "composite anchor envelope");
      if (!Buffer.from(JSON.stringify(envelope)).equals(bytes) || !HASH.test(envelope.signature)) {
        throw new Error("Composite anchor is noncanonical");
      }
      const text = JSON.stringify(envelope.payload), expected = signature(anchorDomain, text);
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(envelope.signature, "hex"))) {
        throw new Error("Composite anchor signature is invalid");
      }
      return validate(envelope.payload);
    } finally { fs.closeSync(fd); }
  }

  function replace(payload: AnchorPayload): AnchorPayload {
    validate(payload);
    const text = JSON.stringify(payload), bytes = Buffer.from(JSON.stringify({ payload,
      signature: signature(anchorDomain, text) }));
    if (bytes.length > MAX_ANCHOR_BYTES) throw new Error("Composite anchor byte bound exceeded");
    const temporary = path.join(directory, `.${path.basename(anchorPath)}.${process.pid}.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW, 0o600);
    try {
      try { writeAll(fd, bytes); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, anchorPath); fs.chmodSync(anchorPath, 0o600);
      const parentFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    const observed = read();
    if (!observed || JSON.stringify(observed) !== JSON.stringify(payload)) throw new Error("Composite anchor readback failed");
    return observed;
  }

  let trusted = read();
  function current() {
    const observed = read();
    if (JSON.stringify(observed) !== JSON.stringify(trusted)) throw new Error("Composite anchor changed outside this authority");
    return observed;
  }
  function tuple(previousHead: string | null, nextHead: string, line: Buffer, state: "prepared" | "committed"): AnchorPayload {
    return { version: VERSION, filePath, contextDigest, state, previousHead, nextHead, line: line.toString("base64") };
  }
  function prepare(previousHead: string | null, nextHead: string, line: Buffer) {
    const before = current();
    if (before ? before.state !== "committed" || before.nextHead !== previousHead : previousHead !== null) {
      throw new Error("Composite anchor preparation is not linear");
    }
    trusted = replace(tuple(previousHead, nextHead, line, "prepared"));
  }
  function commit(previousHead: string | null, nextHead: string, line: Buffer) {
    const before = current(), prepared = tuple(previousHead, nextHead, line, "prepared");
    if (!before || JSON.stringify(before) !== JSON.stringify(prepared)) throw new Error("Composite anchor preparation changed");
    trusted = replace(tuple(previousHead, nextHead, line, "committed"));
  }
  function repairPreparedTail() {
    const value = current(); if (value?.state !== "prepared" || !fs.existsSync(filePath)) return false;
    const expected = lineBytes(value), atPath = fs.lstatSync(filePath, { bigint: true });
    if (!atPath.isFile() || atPath.isSymbolicLink() || atPath.nlink !== 1n || atPath.uid !== BigInt(process.getuid())
      || (atPath.mode & 0o077n) !== 0n || atPath.size > BigInt(32 * 1024 * 1024)) throw new Error("Composite journal file is unsafe");
    const fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      const source = fs.readFileSync(fd), start = source.lastIndexOf(10) + 1, partial = source.subarray(start);
      if (!partial.length) return false;
      if (partial.length >= expected.length || !expected.subarray(0, partial.length).equals(partial)) {
        throw new Error("Composite prepared journal tail is inconsistent");
      }
      writeAll(fd, expected.subarray(partial.length), source.length); return true;
    } finally { fs.closeSync(fd); }
  }
  function reconcile(journalExists: boolean, journalHead: string | null, append: (line: Buffer, create: boolean) => void) {
    const value = current(); if (!value) throw new Error("Composite journal restart head is not externally anchored");
    const line = lineBytes(value);
    if (value.state === "committed") {
      if (!journalExists || journalHead !== value.nextHead) throw new Error("Composite journal rollback or wrong anchored head observed");
      return value.nextHead;
    }
    if (!journalExists) {
      if (value.previousHead !== null || journalHead !== null) throw new Error("Composite journal creation anchor is inconsistent");
      append(line, true); journalHead = value.nextHead;
    } else if (journalHead === value.previousHead) {
      append(line, false); journalHead = value.nextHead;
    }
    if (journalHead !== value.nextHead) throw new Error("Composite prepared journal head is inconsistent");
    commit(value.previousHead, value.nextHead, line); return value.nextHead;
  }
  return Object.freeze({ anchorPath, exists: () => current() !== null, prepare, commit, repairPreparedTail, reconcile,
    state: () => { const value = current(); return value && Object.freeze({ state: value.state,
      previousHead: value.previousHead, nextHead: value.nextHead }); } });
}

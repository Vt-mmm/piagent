import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, sign } from "node:crypto";

const PROTOCOL = "provider-transport-observation-v1";
const MAX_BYTES = 64 * 1024 * 1024;
const digest = value => createHash("sha256").update(value).digest("hex");
const terminalTypes = new Set(["response.done", "response.completed", "response.incomplete", "response.failed", "error"]);

function requireValue(condition, reason) {
  if (!condition) throw new Error(`transport-observation:${reason}`);
}

function privateJournal(file) {
  requireValue(path.isAbsolute(file) && fs.realpathSync(file) === file, "journal-path");
  const parent = fs.lstatSync(path.dirname(file)), stat = fs.lstatSync(file);
  requireValue(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700, "journal-parent");
  requireValue(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, "journal-file");
  return { dev: stat.dev, ino: stat.ino, parentDev: parent.dev, parentIno: parent.ino };
}

function usageState(event) {
  if (!event.usagePresent) return "unknown";
  const usage = event.usage;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!usage || Array.isArray(usage) || !["input_tokens", "output_tokens", "total_tokens"].every(key => count(usage[key]))
    || usage.input_tokens + usage.output_tokens !== usage.total_tokens) return "invalid";
  for (const [key, maximum] of [["input_tokens_details", usage.input_tokens], ["output_tokens_details", usage.output_tokens]]) {
    const details = usage[key];
    if (details != null && (typeof details !== "object" || Array.isArray(details)
      || !Object.values(details).every(value => count(value) && value <= maximum))) return "invalid";
  }
  const details = usage.input_tokens_details;
  if ((details?.cached_tokens ?? 0) + (details?.cache_write_tokens ?? 0) > usage.input_tokens) return "invalid";
  return "provider-reported";
}

function readJournal(file, identity) {
  requireValue(JSON.stringify(privateJournal(file)) === JSON.stringify(identity), "journal-identity-changed");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireValue(stat.dev === identity.dev && stat.ino === identity.ino && stat.isFile()
      && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, "journal-file");
    requireValue(Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= MAX_BYTES, "journal-size");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireValue(read > 0, "journal-truncated"); offset += read;
    }
    requireValue(fs.fstatSync(fd).size === stat.size
      && JSON.stringify(privateJournal(file)) === JSON.stringify(identity), "journal-changed-during-read");
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Private feasibility journal. It deliberately refuses nonempty replay and grants no settlement authority. */
export function createBenchmarkTransportObservation({ journalPath, identity, privateKey }) {
  const binding = JSON.parse(JSON.stringify(identity));
  requireValue(binding && ["runId", "attemptId", "armId", "logicalCallId", "sourceDigest"]
    .every(key => typeof binding[key] === "string" && binding[key]), "identity");
  const journalIdentity = privateJournal(journalPath);
  let expected = readJournal(journalPath, journalIdentity), sequence = 0, previousHash = null, fault = null;
  requireValue(expected.length === 0, "nonempty-resume-unqualified");
  const attempts = new Map();

  function assertCurrent() {
    try {
      if (fault) throw new Error(fault);
      requireValue(readJournal(journalPath, journalIdentity).equals(expected), "journal-prefix-changed");
    } catch (error) {
      fault ??= error instanceof Error ? error.message : "transport-observation:failed";
      throw new Error(fault);
    }
  }

  function project(event) {
    requireValue(event && typeof event === "object", "event");
    if (event.kind === "connection-acquire-reserved") return { kind: event.kind, attemptId: null };
    requireValue(typeof event.attemptId === "string" && /^[1-9][0-9]*$/.test(event.attemptId), "attempt-id");
    if (event.kind === "transport-reserved") {
      requireValue(!attempts.has(event.attemptId) && ["http-sse", "websocket-frame"].includes(event.transport), "duplicate-reservation");
      requireValue(typeof event.json === "string", "serialized-payload");
      const bytes = event.entity === null ? Buffer.from(event.json) : Buffer.from(event.entity);
      const body = JSON.parse(event.json);
      return { kind: event.kind, attemptId: event.attemptId, transport: event.transport,
        jsonSha256: digest(event.json), jsonBytes: Buffer.byteLength(event.json),
        entitySha256: digest(bytes), entityBytes: bytes.length,
        previousResponseId: typeof body.previous_response_id === "string" ? body.previous_response_id : null };
    }
    requireValue(event.kind === "provider-event" && attempts.has(event.attemptId), "event-without-reservation");
    requireValue(typeof event.eventType === "string" && typeof event.usagePresent === "boolean", "provider-event-shape");
    const result = { kind: event.kind, attemptId: event.attemptId, eventType: event.eventType,
      responseId: event.responseId, status: event.status, serviceTier: event.serviceTier,
      usagePresent: event.usagePresent, usage: event.usage };
    const serialized = JSON.stringify(result);
    requireValue(Buffer.byteLength(serialized) <= 16 * 1024, "provider-event-bound");
    const prior = attempts.get(event.attemptId);
    if (terminalTypes.has(event.eventType) && prior.terminalHash) {
      requireValue(prior.terminalHash === digest(serialized), "conflicting-terminal");
    }
    return JSON.parse(serialized);
  }

  function observe(event) {
    try {
      assertCurrent();
      const projected = project(event);
      const material = JSON.stringify({ protocol: PROTOCOL, identity: binding,
        sequence: sequence + 1, previousHash, event: projected });
      const envelope = { material, signature: sign(null, Buffer.from(material), privateKey).toString("base64") };
      const line = Buffer.from(`${JSON.stringify(envelope)}\n`);
      requireValue(expected.length + line.length <= MAX_BYTES, "journal-full");
      const fd = fs.openSync(journalPath, fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        requireValue(stat.dev === journalIdentity.dev && stat.ino === journalIdentity.ino, "journal-replaced");
        fs.writeFileSync(fd, line); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const next = Buffer.concat([expected, line]);
      requireValue(JSON.stringify(privateJournal(journalPath)) === JSON.stringify(journalIdentity)
        && readJournal(journalPath, journalIdentity).equals(next), "durable-readback");
      expected = next; sequence++; previousHash = digest(line.subarray(0, -1));
      if (projected.kind === "transport-reserved") {
        attempts.set(projected.attemptId, { ...projected, usageStatus: "unknown", terminalHash: null });
      } else if (projected.kind === "provider-event" && terminalTypes.has(projected.eventType)) {
        const prior = attempts.get(projected.attemptId);
        prior.terminalHash = digest(JSON.stringify(projected));
        prior.usageStatus = usageState(projected); prior.usage = projected.usage;
      }
    } catch (error) {
      fault = error instanceof Error ? error.message : "transport-observation:failed";
      throw new Error(fault);
    }
  }

  return Object.freeze({ observe, assertCurrent,
    status() {
      return { protocol: PROTOCOL, sequence, previousHash, fault,
        attempts: structuredClone([...attempts.values()]),
        unknownSpend: [...attempts.values()].some(attempt => attempt.usageStatus !== "provider-reported"),
        settlementAuthorized: false, resumeQualified: false,
        publicKey: createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64") };
    }
  });
}

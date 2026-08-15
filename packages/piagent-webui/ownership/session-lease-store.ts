import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILE_LIMIT = 256 * 1024; // Shared single-writer authority for Gateway and terminal runtimes.
const RECORD_LIMIT = 8 * 1024;
const ENTRY_LIMIT = 512;
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

type LeaseEvent = "acquired" | "released" | "recovery-required";
type MutationLock = { version: "piagent-session-lease-lock-v1"; pid: number; createdAt: string; nonce: string };
type LeaseRecord = {
  version: "piagent-session-lease-v1";
  sequence: number;
  recordedAt: string;
  sessionRef: string;
  event: LeaseEvent;
  ownerEpoch: string;
  gatewayInstanceRef: string;
  runtimeInstanceRef: string;
  previousDigest: string | null;
  reasonCode: string | null;
  recordDigest: string;
};

export type SessionLeaseSnapshot = {
  state: "released" | "gateway-owned" | "terminal-owned" | "recovery-required" | "unavailable";
  ownerEpoch: string | null;
  gatewayInstanceRef: string | null;
  runtimeInstanceRef: string | null;
  continuity: "exact" | "released" | "unknown";
  revision: string | null;
  reasonCode: string | null;
};

const TERMINAL_OWNER_PREFIX = "terminal_";

function terminalOwnerPid(value: string | null): number | null {
  const match = value?.match(/^terminal_(\d+)_/), pid = Number(match?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function gatewayOwnerPid(value: string | null): number | null {
  const match = value?.match(/^gateway_(\d+)_/), pid = Number(match?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}

function exactTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validRef(value: unknown): value is string { return typeof value === "string" && REF.test(value); }

function unsigned(record: LeaseRecord): Omit<LeaseRecord, "recordDigest"> {
  const { recordDigest: _ignored, ...value } = record;
  return value;
}

export class SessionLeaseStore {
  readonly directory: string;
  readonly #key: Buffer;

  constructor(root: string, key: Buffer) {
    this.directory = path.join(root, "leases");
    this.#key = key;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("session-lease-root-invalid");
    fs.chmodSync(this.directory, 0o700);
  }

  #digest(namespace: string, value: unknown): string {
    return `${namespace}_${createHmac("sha256", this.#key).update(JSON.stringify(value)).digest("hex")}`;
  }

  #file(sessionRef: string): string {
    if (!validRef(sessionRef)) throw new Error("session-lease-ref-invalid");
    return path.join(this.directory, `${this.#digest("lease-file", sessionRef).slice("lease-file_".length)}.jsonl`);
  }

  #lockFile(sessionRef: string): string {
    return `${this.#file(sessionRef)}.lock`;
  }

  #reclaimDeadMutationLock(file: string): boolean {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch { return false; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_024
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return false;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let value: unknown;
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) return false;
      value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch { return false; }
    finally { fs.closeSync(descriptor); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const lock = value as Partial<MutationLock>;
    if (Object.keys(lock).length !== 4 || lock.version !== "piagent-session-lease-lock-v1"
      || !Number.isSafeInteger(lock.pid) || Number(lock.pid) < 1 || !exactTimestamp(lock.createdAt)
      || !validRef(lock.nonce) || processAlive(Number(lock.pid))) return false;
    let current: fs.Stats;
    try { current = fs.lstatSync(file); } catch { return false; }
    if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile() || current.isSymbolicLink()) return false;
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }

  #withMutationLock<T>(sessionRef: string, action: () => T): T {
    const file = this.#lockFile(sessionRef);
    let descriptor: number;
    for (let attempt = 0; ; attempt += 1) {
      try {
        descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        break;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
          if (attempt === 0 && this.#reclaimDeadMutationLock(file)) continue;
          throw new Error("session-lease-busy");
        }
        throw error;
      }
    }
    try {
      const lock: MutationLock = { version: "piagent-session-lease-lock-v1", pid: process.pid,
        createdAt: new Date().toISOString(), nonce: `lock_${randomBytes(24).toString("base64url")}` };
      fs.writeFileSync(descriptor, JSON.stringify(lock)); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600);
      return action();
    } finally {
      fs.closeSync(descriptor);
      try { fs.unlinkSync(file); } catch { /* a missing lock fails the next mutation closed through continuity checks */ }
    }
  }

  #valid(record: unknown, sessionRef: string, index: number, previousDigest: string | null): record is LeaseRecord {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const value = record as Partial<LeaseRecord>;
    if (Object.keys(value).length !== 11 || !Object.keys(value).every((key) => ["version", "sequence", "recordedAt",
      "sessionRef", "event", "ownerEpoch", "gatewayInstanceRef", "runtimeInstanceRef", "previousDigest", "reasonCode",
      "recordDigest"].includes(key))) return false;
    if (value.version !== "piagent-session-lease-v1" || value.sequence !== index + 1 || !exactTimestamp(value.recordedAt)
      || value.sessionRef !== sessionRef || !["acquired", "released", "recovery-required"].includes(String(value.event))
      || !validRef(value.ownerEpoch) || !validRef(value.gatewayInstanceRef) || !validRef(value.runtimeInstanceRef)
      || value.previousDigest !== previousDigest || !validRef(value.recordDigest)
      || !(value.reasonCode === null || validRef(value.reasonCode))) return false;
    if (value.event === "recovery-required" ? value.reasonCode === null : value.reasonCode !== null) return false;
    return value.recordDigest === this.#digest("lease-record", unsigned(value as LeaseRecord));
  }

  #read(sessionRef: string): LeaseRecord[] {
    const file = this.#file(sessionRef);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_LIMIT) throw new Error("session-lease-file-invalid");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("session-lease-file-race");
      const lines = fs.readFileSync(descriptor, "utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (lines.length > ENTRY_LIMIT) throw new Error("session-lease-entry-limit");
      const records: LeaseRecord[] = [];
      for (const [index, line] of lines.entries()) {
        if (!line || Buffer.byteLength(line) > RECORD_LIMIT) throw new Error("session-lease-record-limit");
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error("session-lease-record-invalid"); }
        if (!this.#valid(value, sessionRef, index, records.at(-1)?.recordDigest ?? null)) throw new Error("session-lease-record-invalid");
        records.push(value);
      }
      return records;
    } finally { fs.closeSync(descriptor); }
  }

  #append(sessionRef: string, value: Omit<LeaseRecord, "version" | "sequence" | "previousDigest" | "recordDigest">): LeaseRecord {
    const records = this.#read(sessionRef);
    if (records.length >= ENTRY_LIMIT) throw new Error("session-lease-entry-limit");
    const partial = {
      version: "piagent-session-lease-v1" as const,
      sequence: records.length + 1,
      previousDigest: records.at(-1)?.recordDigest ?? null,
      ...value
    };
    const record: LeaseRecord = { ...partial, recordDigest: this.#digest("lease-record", partial) };
    const body = Buffer.from(`${JSON.stringify(record)}\n`);
    if (body.length > RECORD_LIMIT) throw new Error("session-lease-record-limit");
    const file = this.#file(sessionRef);
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(file); } catch { /* first record */ }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size + body.length > FILE_LIMIT)) throw new Error("session-lease-file-invalid");
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.chmodSync(file, 0o600);
    return record;
  }

  inspect(sessionRef: string): SessionLeaseSnapshot {
    try {
      const last = this.#read(sessionRef).at(-1);
      if (!last || last.event === "released") return {
        state: "released", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null,
        continuity: "released", revision: last?.recordDigest ?? this.#digest("lease-empty", sessionRef), reasonCode: null
      };
      return {
        state: last.event === "acquired"
          ? last.gatewayInstanceRef.startsWith(TERMINAL_OWNER_PREFIX) ? "terminal-owned" : "gateway-owned"
          : "recovery-required",
        ownerEpoch: last.ownerEpoch, gatewayInstanceRef: last.gatewayInstanceRef, runtimeInstanceRef: last.runtimeInstanceRef,
        continuity: last.event === "acquired" ? "exact" : "unknown", revision: last.recordDigest,
        reasonCode: last.reasonCode
      };
    } catch {
      return { state: "unavailable", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null,
        continuity: "unknown", revision: null, reasonCode: "session-lease-unavailable" };
    }
  }

  acquire(sessionRef: string, gatewayInstanceRef: string, runtimeInstanceRef: string, now = new Date()): SessionLeaseSnapshot {
    if (!validRef(gatewayInstanceRef) || !validRef(runtimeInstanceRef) || !Number.isFinite(now.getTime())) throw new Error("session-lease-input-invalid");
    if (gatewayInstanceRef.startsWith(TERMINAL_OWNER_PREFIX)) throw new Error("session-lease-input-invalid");
    return this.#acquireOwner(sessionRef, gatewayInstanceRef, runtimeInstanceRef, now);
  }

  releaseDeadOwnerForExplicitRecovery(sessionRef: string, now = new Date()): SessionLeaseSnapshot {
    if (!Number.isFinite(now.getTime())) throw new Error("session-lease-input-invalid");
    return this.#withMutationLock(sessionRef, () => {
      const current = this.inspect(sessionRef);
      const pid = current.state === "terminal-owned" ? terminalOwnerPid(current.gatewayInstanceRef)
        : current.state === "gateway-owned" ? gatewayOwnerPid(current.gatewayInstanceRef) : null;
      if (!pid || processAlive(pid)) throw new Error("session-owner-not-proven-dead");
      this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "recovery-required", ownerEpoch: current.ownerEpoch!,
        gatewayInstanceRef: current.gatewayInstanceRef!, runtimeInstanceRef: current.runtimeInstanceRef!, reasonCode: "owner-process-exited" });
      this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "released", ownerEpoch: current.ownerEpoch!,
        gatewayInstanceRef: current.gatewayInstanceRef!, runtimeInstanceRef: current.runtimeInstanceRef!, reasonCode: null });
      return this.inspect(sessionRef);
    });
  }

  acquireTerminal(sessionRef: string, terminalInstanceRef: string, runtimeInstanceRef: string, now = new Date()): SessionLeaseSnapshot {
    if (!terminalInstanceRef.startsWith(TERMINAL_OWNER_PREFIX)) throw new Error("session-lease-input-invalid");
    if (!validRef(terminalInstanceRef) || !validRef(runtimeInstanceRef) || !Number.isFinite(now.getTime())) {
      throw new Error("session-lease-input-invalid");
    }
    return this.#withMutationLock(sessionRef, () => {
      const current = this.inspect(sessionRef), previousPid = terminalOwnerPid(current.gatewayInstanceRef);
      if (current.state === "terminal-owned" && previousPid && !processAlive(previousPid)) {
        this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "recovery-required",
          ownerEpoch: current.ownerEpoch!, gatewayInstanceRef: current.gatewayInstanceRef!, runtimeInstanceRef: current.runtimeInstanceRef!,
          reasonCode: "terminal-owner-process-exited" });
        this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "released", ownerEpoch: current.ownerEpoch!,
          gatewayInstanceRef: current.gatewayInstanceRef!, runtimeInstanceRef: current.runtimeInstanceRef!, reasonCode: null });
      } else if (current.state !== "released") {
        throw new Error(current.state === "recovery-required" ? "session-recovery-required" : "session-owner-conflict");
      }
      const ownerEpoch = `owner_${randomBytes(24).toString("base64url")}`;
      this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "acquired", ownerEpoch,
        gatewayInstanceRef: terminalInstanceRef, runtimeInstanceRef, reasonCode: null });
      return this.inspect(sessionRef);
    });
  }

  #acquireOwner(sessionRef: string, ownerInstanceRef: string, runtimeInstanceRef: string, now: Date): SessionLeaseSnapshot {
    if (!validRef(ownerInstanceRef) || !validRef(runtimeInstanceRef) || !Number.isFinite(now.getTime())) throw new Error("session-lease-input-invalid");
    return this.#withMutationLock(sessionRef, () => {
      const current = this.inspect(sessionRef);
      if (current.state === "unavailable") throw new Error(current.reasonCode ?? "session-lease-unavailable");
      if (current.state !== "released") throw new Error(current.state === "recovery-required" ? "session-recovery-required" : "session-owner-conflict");
      const ownerEpoch = `owner_${randomBytes(24).toString("base64url")}`;
      this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "acquired", ownerEpoch,
        gatewayInstanceRef: ownerInstanceRef, runtimeInstanceRef, reasonCode: null });
      return this.inspect(sessionRef);
    });
  }

  release(sessionRef: string, ownerEpoch: string, gatewayInstanceRef: string, runtimeInstanceRef: string, now = new Date()): SessionLeaseSnapshot {
    if (gatewayInstanceRef.startsWith(TERMINAL_OWNER_PREFIX)) throw new Error("session-lease-input-invalid");
    return this.#releaseOwner(sessionRef, ownerEpoch, gatewayInstanceRef, runtimeInstanceRef, "gateway-owned", now);
  }

  releaseTerminal(sessionRef: string, ownerEpoch: string, terminalInstanceRef: string, runtimeInstanceRef: string,
    now = new Date()): SessionLeaseSnapshot {
    if (!terminalInstanceRef.startsWith(TERMINAL_OWNER_PREFIX)) throw new Error("session-lease-input-invalid");
    return this.#releaseOwner(sessionRef, ownerEpoch, terminalInstanceRef, runtimeInstanceRef, "terminal-owned", now);
  }

  #releaseOwner(sessionRef: string, ownerEpoch: string, ownerInstanceRef: string, runtimeInstanceRef: string,
    expectedState: "gateway-owned" | "terminal-owned", now: Date): SessionLeaseSnapshot {
    return this.#withMutationLock(sessionRef, () => {
      const current = this.#matchingOwner(sessionRef, ownerEpoch, ownerInstanceRef, runtimeInstanceRef, expectedState, now);
      this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "released", ownerEpoch: current.ownerEpoch!,
        gatewayInstanceRef: current.gatewayInstanceRef!, runtimeInstanceRef: current.runtimeInstanceRef!, reasonCode: null });
      return this.inspect(sessionRef);
    });
  }

  requireRecovery(sessionRef: string, ownerEpoch: string, gatewayInstanceRef: string, runtimeInstanceRef: string,
    reasonCode: string, now = new Date()): SessionLeaseSnapshot {
    if (!validRef(reasonCode)) throw new Error("session-lease-reason-invalid");
    return this.#withMutationLock(sessionRef, () => {
      const current = this.#matchingOwner(sessionRef, ownerEpoch, gatewayInstanceRef, runtimeInstanceRef, "gateway-owned", now);
      this.#append(sessionRef, { recordedAt: now.toISOString(), sessionRef, event: "recovery-required", ownerEpoch: current.ownerEpoch!,
        gatewayInstanceRef: current.gatewayInstanceRef!, runtimeInstanceRef: current.runtimeInstanceRef!, reasonCode });
      return this.inspect(sessionRef);
    });
  }

  #matchingOwner(sessionRef: string, ownerEpoch: string, gatewayInstanceRef: string, runtimeInstanceRef: string,
    expectedState: "gateway-owned" | "terminal-owned", now: Date): SessionLeaseSnapshot {
    if (!validRef(ownerEpoch) || !validRef(gatewayInstanceRef) || !validRef(runtimeInstanceRef) || !Number.isFinite(now.getTime())) {
      throw new Error("session-lease-input-invalid");
    }
    const current = this.inspect(sessionRef);
    if (current.state !== expectedState || current.ownerEpoch !== ownerEpoch || current.gatewayInstanceRef !== gatewayInstanceRef
      || current.runtimeInstanceRef !== runtimeInstanceRef) throw new Error("session-owner-conflict");
    return current;
  }
}

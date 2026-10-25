import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Windows uses inherited ACLs in the Gateway profile; Node mode bits do not represent them.
const POSIX_PERMISSIONS = process.platform !== "win32";
const MAX_BYTES = 8 * 1024 * 1024, MAX_RECORDS = 4000;
type SessionRecord = { identity: { sessionRef: string }; idempotencyKeyDigest: string };
type Journal<T> = { version: 1; sequence: number; records: Array<{ sequence: number; receipt: T }> };

// Gateway-owned receipts survive a runtime eviction or an empty conversation
// that Pi has not persisted yet. No source contents or raw idempotency keys.
export class SignedSessionJournal<T extends SessionRecord> {
  readonly #namespace: string;
  readonly #root: string;
  readonly #key: Buffer;
  readonly #directory: fs.Stats;
  constructor(root: string, key: Buffer, namespace: string) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace) || key.length < 32) throw new Error("session-journal-config-invalid");
    this.#namespace = namespace;
    this.#root = path.join(fs.realpathSync(root), namespace); this.#key = Buffer.from(key);
    try { fs.mkdirSync(this.#root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(this.#root);
    this.#directory = stat; this.#checkDirectory();
  }
  #checkDirectory(): void {
    const stat = fs.lstatSync(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (POSIX_PERMISSIONS && (stat.mode & 0o077))
      || typeof process.getuid === "function" && stat.uid !== process.getuid()
      || stat.dev !== this.#directory.dev || stat.ino !== this.#directory.ino) throw new Error("workspace-journal-unsafe");
  }
  #file(sessionRef: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(sessionRef)) throw new Error("workspace-session-invalid");
    return path.join(this.#root, `${sessionRef}.json`);
  }
  #sign(sessionRef: string, value: Journal<T>): string {
    return createHmac("sha256", this.#key).update(`${this.#namespace}-v1\0${sessionRef}\0`).update(JSON.stringify(value)).digest("hex");
  }
  #read(sessionRef: string): Journal<T> {
    this.#checkDirectory();
    let descriptor: number, before: fs.Stats;
    const file = this.#file(sessionRef);
    try {
      before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("workspace-journal-unsafe");
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sequence: 0, records: [] }; throw error; }
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || stat.size > MAX_BYTES || (POSIX_PERMISSIONS && (stat.mode & 0o077))
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("workspace-journal-unsafe");
      const { value, mac } = JSON.parse(fs.readFileSync(descriptor, "utf8")) as { value: Journal<T>; mac: string };
      if (!value || typeof mac !== "string" || !/^[a-f0-9]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.#sign(sessionRef, value), "hex"))
        || value.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS
        || value.records.some(record => !record || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > value.sequence
          || !record.receipt || record.receipt.identity?.sessionRef !== sessionRef || !/^sha256:[a-f0-9]{64}$/.test(record.receipt.idempotencyKeyDigest)))
        throw new Error("workspace-journal-invalid");
      return value;
    } finally { fs.closeSync(descriptor); }
  }
  history(sessionRef: string): T[] {
    return this.#read(sessionRef).records.sort((a, b) => a.sequence - b.sequence).map(record => record.receipt);
  }
  append(sessionRef: string, receipt: T): void {
    if (receipt.identity.sessionRef !== sessionRef) throw new Error("workspace-session-invalid");
    const value = this.#read(sessionRef), sequence = value.sequence + 1;
    const records = value.records.filter(record => record.receipt.idempotencyKeyDigest !== receipt.idempotencyKeyDigest);
    records.push({ sequence, receipt });
    if (records.length > MAX_RECORDS || !Number.isSafeInteger(sequence)) throw new Error("workspace-journal-full");
    const next: Journal<T> = { version: 1, sequence, records }, bytes = JSON.stringify({ value: next, mac: this.#sign(sessionRef, next) }) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("workspace-journal-full");
    const temporary = path.join(this.#root, `.write-${randomBytes(16).toString("hex")}`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      this.#checkDirectory(); fs.renameSync(temporary, this.#file(sessionRef));
      // Windows cannot open a directory with the Node read-only file API.
      if (process.platform !== "win32") {
        const directory = fs.openSync(this.#root, fs.constants.O_RDONLY);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); }
  }
}

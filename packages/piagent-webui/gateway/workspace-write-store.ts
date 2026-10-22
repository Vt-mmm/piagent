import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceWriteReceipt } from "../contracts/generated/workspace-write-v1.ts";

const MAX_BYTES = 8 * 1024 * 1024, MAX_RECORDS = 4000;
type Record = { sequence: number; receipt: WorkspaceWriteReceipt };
type Journal = { version: 1; sequence: number; records: Record[] };

// Gateway-owned receipts survive a runtime eviction or an empty conversation
// that Pi has not persisted yet. No source contents or raw idempotency keys.
export class WorkspaceWriteStore {
  readonly #root: string;
  readonly #key: Buffer;
  readonly #directory: fs.Stats;
  constructor(root: string, key: Buffer) {
    this.#root = path.join(fs.realpathSync(root), "workspace-writes"); this.#key = Buffer.from(key);
    try { fs.mkdirSync(this.#root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(this.#root);
    this.#directory = stat; this.#checkDirectory();
  }
  #checkDirectory(): void {
    const stat = fs.lstatSync(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || typeof process.getuid === "function" && stat.uid !== process.getuid()
      || stat.dev !== this.#directory.dev || stat.ino !== this.#directory.ino) throw new Error("workspace-journal-unsafe");
  }
  #file(sessionRef: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(sessionRef)) throw new Error("workspace-session-invalid");
    return path.join(this.#root, `${sessionRef}.json`);
  }
  #sign(sessionRef: string, value: Journal): string {
    return createHmac("sha256", this.#key).update(`workspace-writes-v1\0${sessionRef}\0`).update(JSON.stringify(value)).digest("hex");
  }
  #read(sessionRef: string): Journal {
    this.#checkDirectory();
    let descriptor: number;
    try { descriptor = fs.openSync(this.#file(sessionRef), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sequence: 0, records: [] }; throw error; }
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || (stat.mode & 0o077)
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("workspace-journal-unsafe");
      const { value, mac } = JSON.parse(fs.readFileSync(descriptor, "utf8")) as { value: Journal; mac: string };
      if (!value || typeof mac !== "string" || !/^[a-f0-9]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.#sign(sessionRef, value), "hex"))
        || value.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS
        || value.records.some(record => !record || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > value.sequence
          || !record.receipt || record.receipt.identity?.sessionRef !== sessionRef || !/^sha256:[a-f0-9]{64}$/.test(record.receipt.idempotencyKeyDigest)))
        throw new Error("workspace-journal-invalid");
      return value;
    } finally { fs.closeSync(descriptor); }
  }
  history(sessionRef: string): WorkspaceWriteReceipt[] {
    return this.#read(sessionRef).records.sort((a, b) => a.sequence - b.sequence).map(record => record.receipt);
  }
  append(sessionRef: string, receipt: WorkspaceWriteReceipt): void {
    if (receipt.identity.sessionRef !== sessionRef) throw new Error("workspace-session-invalid");
    const value = this.#read(sessionRef), sequence = value.sequence + 1;
    const records = value.records.filter(record => record.receipt.idempotencyKeyDigest !== receipt.idempotencyKeyDigest);
    records.push({ sequence, receipt });
    if (records.length > MAX_RECORDS || !Number.isSafeInteger(sequence)) throw new Error("workspace-journal-full");
    const next: Journal = { version: 1, sequence, records }, bytes = JSON.stringify({ value: next, mac: this.#sign(sessionRef, next) }) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("workspace-journal-full");
    const temporary = path.join(this.#root, `.write-${randomBytes(16).toString("hex")}`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      this.#checkDirectory(); fs.renameSync(temporary, this.#file(sessionRef));
      const directory = fs.openSync(this.#root, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); }
  }
}

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";
import { supportedChatImageMimeType } from "../../piagent-core/runtime/input/chat-images.ts";
import type { BridgeIdentity, BridgeSnapshot } from "./same-session-bridge.ts";

export const ATTACHMENT_LIMITS = {
  countPerMessage: 4,
  imageBytes: 8 * 1024 * 1024,
  textBytes: 256 * 1024,
  totalBytesPerMessage: 16 * 1024 * 1024,
  runtimeCount: 64,
  runtimeBytes: 64 * 1024 * 1024,
  ttlMs: 10 * 60_000
} as const;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "application/json"]);
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OWNED_FILE = /^[a-f0-9]{48}\.bin$/;

type StoredAttachment = Attachment & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  absolutePath: string;
  device: number;
  inode: number;
};
type Attachment = { attachmentRef: string; messageRequestId: string; displayName: string; kind: "file" | "image";
  mimeType: string; sizeBytes: number; expiresAt: string };
type StageCommand = { schemaVersion: 1; version: "piagent-webui-attachment-v1"; messageType: "stage-command"; commandId: string;
  idempotencyKey: string; requestedAt: string; expiresAt: string; identity: BridgeIdentity; expectedRuntimeRevision: string;
  messageRequestId: string; file: { displayName: string; declaredMimeType: string; dataBase64: string } };
type StageResultCode = "staged" | "invalid-command" | "identity-mismatch" | "stale-revision" | "expired" | "unsupported-type"
  | "invalid-content" | "limit-exceeded" | "storage-unavailable" | "idempotency-payload-mismatch" | "capability-unavailable";
export type StageReceipt = { schemaVersion: 1; version: "piagent-webui-attachment-v1"; messageType: "stage-receipt"; commandId: string;
  identity: BridgeIdentity; phase: "settled" | "rejected"; resultCode: StageResultCode; requestedAt: string; settledAt: string;
  deduplicated: boolean; attachment: Attachment | null; error: { code: string; message: string; retryable: boolean } | null };
type DiscardCommand = Omit<StageCommand, "messageType" | "file"> & { messageType: "discard-command"; attachmentRef: string };
export type DiscardReceipt = Omit<StageReceipt, "messageType" | "resultCode" | "attachment"> & { messageType: "discard-receipt";
  resultCode: "discarded" | "invalid-command" | "identity-mismatch" | "stale-revision" | "expired" | "attachment-unavailable"
    | "idempotency-payload-mismatch" | "capability-unavailable"; attachmentRef: string | null };
type CachedStage = { fingerprint: string; receipt: StageReceipt; expiresAt: number };
type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
export type PreparedAttachments = { content: string | Array<TextContent | ImageContent>; observedText: string };

function exactKeys(value: unknown, expected: string[]): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) === JSON.stringify([...expected].sort()));
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function validIdentity(value: unknown): value is BridgeIdentity {
  if (!exactKeys(value, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])) return false;
  const item = value as BridgeIdentity;
  return [item.projectRef, item.runtimeInstanceId, item.sessionRef].every((part) => typeof part === "string" && REF.test(part))
    && (item.taskId === null || typeof item.taskId === "string" && PUBLIC_REF.test(item.taskId))
    && (item.taskRunId === null || typeof item.taskRunId === "string" && PUBLIC_REF.test(item.taskRunId))
    && (item.taskRunId === null || item.taskId !== null)
    && (item.agentOperationId === null || typeof item.agentOperationId === "string" && REF.test(item.agentOperationId))
    && item.toolCallId === null;
}
function sameIdentity(left: BridgeIdentity, right: BridgeIdentity): boolean {
  return left.projectRef === right.projectRef && left.runtimeInstanceId === right.runtimeInstanceId && left.sessionRef === right.sessionRef
    && left.taskId === right.taskId && left.taskRunId === right.taskRunId && left.agentOperationId === right.agentOperationId && left.toolCallId === right.toolCallId;
}
function fingerprint(command: unknown): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
function safeName(value: unknown): string {
  const basename = path.basename(String(value ?? "attachment").replace(/[\\/]/g, "_"));
  return redactSensitiveText(basename).text.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "attachment";
}
function errorMessage(code: StageReceipt["resultCode"]): string {
  const messages: Partial<Record<StageReceipt["resultCode"], string>> = {
    "invalid-command": "The attachment command is invalid.", "identity-mismatch": "The attachment targets a different Pi session.",
    "stale-revision": "The Pi session changed before the attachment was staged.", expired: "The attachment command expired.",
    "unsupported-type": "This file type is not supported.", "invalid-content": "The selected file content is invalid.",
    "limit-exceeded": "The attachment limit was exceeded.", "storage-unavailable": "Private attachment storage is unavailable.",
    "idempotency-payload-mismatch": "This upload key was already used for different content.",
    "capability-unavailable": "The active Pi model cannot accept this attachment."
  };
  return messages[code] ?? "The attachment could not be staged.";
}

export class AttachmentStore {
  readonly #runtimeInstanceId: string;
  readonly #bridgeSnapshot: () => BridgeSnapshot;
  readonly #modelSupportsImages: () => boolean;
  readonly #now: () => Date;
  #directory: string;
  readonly #directoryDevice: number;
  readonly #directoryInode: number;
  readonly #records = new Map<string, StoredAttachment>();
  readonly #cache = new Map<string, CachedStage>();
  readonly #discardCache = new Map<string, { fingerprint: string; receipt: DiscardReceipt; expiresAt: number }>();
  #closed = false;

  constructor(options: { runtimeInstanceId: string; bridgeSnapshot: () => BridgeSnapshot; modelSupportsImages: () => boolean;
    now?: () => Date; tempRoot?: string }) {
    if (!REF.test(options.runtimeInstanceId)) throw new Error("webui-attachment-runtime-invalid");
    this.#runtimeInstanceId = options.runtimeInstanceId; this.#bridgeSnapshot = options.bridgeSnapshot;
    this.#modelSupportsImages = options.modelSupportsImages; this.#now = options.now ?? (() => new Date());
    const parent = path.resolve(options.tempRoot ?? os.tmpdir());
    this.#directory = fs.mkdtempSync(path.join(parent, "piagent-webui-attachments-"));
    fs.chmodSync(this.#directory, 0o700);
    const inspected = fs.lstatSync(this.#directory);
    if (!inspected.isDirectory() || inspected.isSymbolicLink() || (inspected.mode & 0o077) !== 0) throw new Error("webui-attachment-storage-unsafe");
    this.#directoryDevice = inspected.dev; this.#directoryInode = inspected.ino;
  }

  capability(): { kinds: Array<"file" | "image">; mimeTypes: string[] } {
    const image = this.#modelSupportsImages();
    return { kinds: image ? ["file", "image"] : ["file"], mimeTypes: [...TEXT_MIMES, ...(image ? IMAGE_MIMES : [])].sort() };
  }

  stage(input: unknown): StageReceipt {
    const now = this.#now(); this.#cleanup(now.getTime());
    const snapshot = this.#bridgeSnapshot(), command = input as StageCommand;
    const invalid = this.#validate(command);
    if (invalid) return this.#reject(command, snapshot, "invalid-command", invalid, now);
    const key = command.idempotencyKey, found = this.#cache.get(key), commandFingerprint = fingerprint(command);
    if (found) {
      if (found.fingerprint !== commandFingerprint) return this.#reject(command, snapshot, "idempotency-payload-mismatch", null, now);
      return { ...structuredClone(found.receipt), deduplicated: true };
    }
    if (this.#closed || snapshot.state !== "ready" || snapshot.taskState === "terminal" || !snapshot.identity || !snapshot.revisions)
      return this.#reject(command, snapshot, "capability-unavailable", "attachment-store-not-ready", now);
    if (Date.parse(command.requestedAt) > now.getTime() + 30_000) return this.#reject(command, snapshot, "invalid-command", "requested-at-in-future", now);
    if (now.getTime() > Date.parse(command.expiresAt)) return this.#reject(command, snapshot, "expired", null, now);
    if (!sameIdentity(command.identity, snapshot.identity)) return this.#reject(command, snapshot, "identity-mismatch", null, now);
    if (command.expectedRuntimeRevision !== snapshot.revisions.runtimeRevision) return this.#reject(command, snapshot, "stale-revision", null, now);

    let bytes: Buffer;
    try { bytes = Buffer.from(command.file.dataBase64, "base64"); }
    catch { return this.#reject(command, snapshot, "invalid-content", "base64-decode-failed", now); }
    if (bytes.length < 1 || bytes.toString("base64") !== command.file.dataBase64) return this.#reject(command, snapshot, "invalid-content", "base64-noncanonical", now);
    const declared = command.file.declaredMimeType, image = IMAGE_MIMES.has(declared), text = TEXT_MIMES.has(declared);
    if (!image && !text) return this.#reject(command, snapshot, "unsupported-type", null, now);
    let mimeType = declared;
    if (image) {
      if (!this.#modelSupportsImages()) return this.#reject(command, snapshot, "capability-unavailable", "model-image-input-unavailable", now);
      const detected = supportedChatImageMimeType(bytes);
      if (!detected || detected !== declared) return this.#reject(command, snapshot, "invalid-content", "image-mime-mismatch", now);
      mimeType = detected;
      if (bytes.length > ATTACHMENT_LIMITS.imageBytes) return this.#reject(command, snapshot, "limit-exceeded", "image-size-limit", now);
    } else {
      if (bytes.length > ATTACHMENT_LIMITS.textBytes) return this.#reject(command, snapshot, "limit-exceeded", "text-size-limit", now);
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (decoded.includes("\0")) throw new Error("nul");
        if (declared === "application/json") JSON.parse(decoded);
      } catch { return this.#reject(command, snapshot, "invalid-content", "text-content-invalid", now); }
    }
    const messageRecords = [...this.#records.values()].filter((item) => item.sessionRef === snapshot.identity!.sessionRef
      && item.messageRequestId === command.messageRequestId);
    if (messageRecords.length >= ATTACHMENT_LIMITS.countPerMessage
      || messageRecords.reduce((sum, item) => sum + item.sizeBytes, 0) + bytes.length > ATTACHMENT_LIMITS.totalBytesPerMessage
      || this.#records.size >= ATTACHMENT_LIMITS.runtimeCount
      || [...this.#records.values()].reduce((sum, item) => sum + item.sizeBytes, 0) + bytes.length > ATTACHMENT_LIMITS.runtimeBytes)
      return this.#reject(command, snapshot, "limit-exceeded", "attachment-capacity-limit", now);
    const attachmentRef = `attachment.${randomBytes(24).toString("hex")}`, filename = `${randomBytes(24).toString("hex")}.bin`;
    const absolutePath = path.join(this.#directory, filename), expiresAt = new Date(now.getTime() + ATTACHMENT_LIMITS.ttlMs).toISOString();
    try {
      if (!this.#safeDirectory()) throw new Error("unsafe-directory");
      const descriptor = fs.openSync(absolutePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); }
      finally { fs.closeSync(descriptor); }
      const inspected = fs.lstatSync(absolutePath);
      if (!inspected.isFile() || inspected.isSymbolicLink() || inspected.size !== bytes.length || (inspected.mode & 0o077) !== 0) throw new Error("unsafe-file");
      const attachment = { attachmentRef, messageRequestId: command.messageRequestId, displayName: safeName(command.file.displayName),
        kind: image ? "image" as const : "file" as const, mimeType, sizeBytes: bytes.length, expiresAt };
      this.#records.set(attachmentRef, { ...attachment, projectRef: snapshot.identity.projectRef, runtimeInstanceId: snapshot.identity.runtimeInstanceId,
        sessionRef: snapshot.identity.sessionRef, absolutePath, device: inspected.dev, inode: inspected.ino });
      const receipt = this.#receipt(command, snapshot.identity, "settled", "staged", attachment, null, now, false);
      this.#cache.set(key, { fingerprint: commandFingerprint, receipt: structuredClone(receipt), expiresAt: Date.parse(expiresAt) });
      return receipt;
    } catch {
      this.#deleteOwnedPath(absolutePath); return this.#reject(command, snapshot, "storage-unavailable", null, now);
    }
  }

  execute(input: unknown): StageReceipt | DiscardReceipt {
    return (input as { messageType?: unknown })?.messageType === "discard-command" ? this.discard(input) : this.stage(input);
  }

  discard(input: unknown): DiscardReceipt {
    const now = this.#now(); this.#cleanup(now.getTime()); const snapshot = this.#bridgeSnapshot(), command = input as DiscardCommand;
    const reject = (code: Exclude<DiscardReceipt["resultCode"], "discarded">, reason: string = code): DiscardReceipt => ({ schemaVersion: 1,
      version: "piagent-webui-attachment-v1", messageType: "discard-receipt", commandId: typeof command?.commandId === "string" && REF.test(command.commandId)
        ? command.commandId : `attachment-command.${createHash("sha256").update(reason).digest("hex")}`, identity: structuredClone(snapshot.identity ?? {
        projectRef: `project.${"0".repeat(64)}`, runtimeInstanceId: this.#runtimeInstanceId, sessionRef: `session.${"0".repeat(64)}`,
        taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null }), phase: "rejected", resultCode: code,
      requestedAt: timestamp(command?.requestedAt) ? command.requestedAt : now.toISOString(), settledAt: now.toISOString(), deduplicated: false,
      attachmentRef: null, error: { code: reason, message: errorMessage(code === "attachment-unavailable" ? "capability-unavailable" : code as StageResultCode), retryable: false } });
    if (!command || !exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "identity",
      "expectedRuntimeRevision", "messageRequestId", "attachmentRef"]) || command.schemaVersion !== 1 || command.version !== "piagent-webui-attachment-v1"
      || command.messageType !== "discard-command" || !REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey) || !timestamp(command.requestedAt)
      || !timestamp(command.expiresAt) || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000
      || !validIdentity(command.identity) || !REVISION.test(command.expectedRuntimeRevision) || !REF.test(command.messageRequestId) || !REF.test(command.attachmentRef)) return reject("invalid-command");
    const found = this.#discardCache.get(command.idempotencyKey), commandFingerprint = fingerprint(command);
    if (found) return found.fingerprint === commandFingerprint ? { ...structuredClone(found.receipt), deduplicated: true } : reject("idempotency-payload-mismatch");
    if (this.#closed || snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions) return reject("capability-unavailable");
    if (Date.parse(command.requestedAt) > now.getTime() + 30_000) return reject("invalid-command", "requested-at-in-future");
    if (now.getTime() > Date.parse(command.expiresAt)) return reject("expired");
    if (!sameIdentity(command.identity, snapshot.identity)) return reject("identity-mismatch");
    if (command.expectedRuntimeRevision !== snapshot.revisions.runtimeRevision) return reject("stale-revision");
    const record = this.#records.get(command.attachmentRef);
    if (!record || record.messageRequestId !== command.messageRequestId || record.sessionRef !== snapshot.identity.sessionRef) return reject("attachment-unavailable");
    this.#consume(record);
    const receipt = { schemaVersion: 1, version: "piagent-webui-attachment-v1", messageType: "discard-receipt", commandId: command.commandId,
      identity: structuredClone(snapshot.identity), phase: "settled", resultCode: "discarded", requestedAt: command.requestedAt,
      settledAt: now.toISOString(), deduplicated: false, attachmentRef: command.attachmentRef, error: null } satisfies DiscardReceipt;
    this.#discardCache.set(command.idempotencyKey, { fingerprint: commandFingerprint, receipt: structuredClone(receipt), expiresAt: Date.parse(command.expiresAt) });
    return receipt;
  }

  claim(refs: string[], messageRequestId: string, identity: BridgeIdentity, text: string): PreparedAttachments {
    const now = this.#now().getTime(); this.#cleanup(now);
    if (this.#closed || refs.length < 1 || refs.length > ATTACHMENT_LIMITS.countPerMessage || new Set(refs).size !== refs.length)
      throw new Error("attachment-reference-invalid");
    const records = refs.map((ref) => this.#records.get(ref));
    if (records.some((record) => !record)) throw new Error("attachment-reference-unavailable");
    const exact = records as StoredAttachment[];
    if (exact.some((record) => record.messageRequestId !== messageRequestId || record.projectRef !== identity.projectRef
      || record.runtimeInstanceId !== identity.runtimeInstanceId || record.sessionRef !== identity.sessionRef || Date.parse(record.expiresAt) < now)
      || exact.reduce((sum, record) => sum + record.sizeBytes, 0) > ATTACHMENT_LIMITS.totalBytesPerMessage) throw new Error("attachment-authority-mismatch");
    if (exact.some((record) => record.kind === "image") && !this.#modelSupportsImages()) throw new Error("model-image-input-unavailable");
    const content: Array<TextContent | ImageContent> = [{ type: "text", text }], observedTexts = [text];
    try {
      for (const record of exact) {
        const bytes = this.#readOwned(record);
        if (record.kind === "image") content.push({ type: "image", data: bytes.toString("base64"), mimeType: record.mimeType });
        else {
          const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const attachmentText = `[Attached file: ${record.displayName} (${record.mimeType}, ${record.sizeBytes} bytes)]\n${body}\n[End attached file]`;
          content.push({ type: "text", text: attachmentText }); observedTexts.push(attachmentText);
        }
      }
    } catch (error) {
      exact.forEach((record) => this.#consume(record)); throw error;
    }
    exact.forEach((record) => this.#consume(record));
    return { content, observedText: observedTexts.join("\n") };
  }

  close(): void {
    if (this.#closed) return; this.#closed = true;
    for (const record of this.#records.values()) this.#deleteOwnedPath(record.absolutePath);
    this.#records.clear(); this.#cache.clear(); this.#discardCache.clear();
    try { if (this.#safeDirectory()) fs.rmdirSync(this.#directory); } catch { /* never recurse beyond files owned by this store */ }
  }

  reset(): void {
    for (const record of this.#records.values()) this.#deleteOwnedPath(record.absolutePath);
    this.#records.clear(); this.#cache.clear(); this.#discardCache.clear();
  }

  #validate(command: StageCommand): string | null {
    if (!command || typeof command !== "object" || command.schemaVersion !== 1 || command.version !== "piagent-webui-attachment-v1"
      || command.messageType !== "stage-command" || !exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "identity", "expectedRuntimeRevision", "messageRequestId", "file"])) return "unsupported-command-shape";
    if (!REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey) || !timestamp(command.requestedAt) || !timestamp(command.expiresAt)
      || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000
      || !validIdentity(command.identity) || !REVISION.test(command.expectedRuntimeRevision) || !REF.test(command.messageRequestId)) return "invalid-command-metadata";
    if (!exactKeys(command.file, ["displayName", "declaredMimeType", "dataBase64"]) || typeof command.file.displayName !== "string"
      || command.file.displayName.length < 1 || command.file.displayName.length > 255 || /[\u0000-\u001F\u007F/\\]/.test(command.file.displayName)
      || typeof command.file.declaredMimeType !== "string" || typeof command.file.dataBase64 !== "string"
      || command.file.dataBase64.length < 4 || command.file.dataBase64.length > 11_184_812 || !BASE64.test(command.file.dataBase64)) return "invalid-file-payload";
    return null;
  }

  #receipt(command: Partial<StageCommand>, identity: BridgeIdentity, phase: StageReceipt["phase"], resultCode: StageReceipt["resultCode"],
    attachment: Attachment | null, reason: string | null, now: Date, deduplicated: boolean): StageReceipt {
    return { schemaVersion: 1, version: "piagent-webui-attachment-v1", messageType: "stage-receipt",
      commandId: typeof command.commandId === "string" && REF.test(command.commandId) ? command.commandId : `attachment-command.${createHash("sha256").update(reason ?? resultCode).digest("hex")}`,
      identity: structuredClone(identity), phase, resultCode, requestedAt: timestamp(command.requestedAt) ? command.requestedAt : now.toISOString(),
      settledAt: now.toISOString(), deduplicated, attachment, error: phase === "rejected" ? { code: reason ?? resultCode,
        message: errorMessage(resultCode), retryable: resultCode === "storage-unavailable" } : null };
  }
  #reject(command: Partial<StageCommand>, snapshot: BridgeSnapshot, code: Exclude<StageReceipt["resultCode"], "staged">,
    reason: string | null, now: Date): StageReceipt {
    const identity = snapshot.identity ?? { projectRef: `project.${"0".repeat(64)}`, runtimeInstanceId: this.#runtimeInstanceId,
      sessionRef: `session.${"0".repeat(64)}`, taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
    return this.#receipt(command, identity, "rejected", code, null, reason, now, false);
  }
  #readOwned(record: StoredAttachment): Buffer {
    if (!this.#safeDirectory() || path.dirname(record.absolutePath) !== this.#directory || !OWNED_FILE.test(path.basename(record.absolutePath))) throw new Error("attachment-storage-boundary");
    const descriptor = fs.openSync(record.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const inspected = fs.fstatSync(descriptor);
      if (!inspected.isFile() || inspected.dev !== record.device || inspected.ino !== record.inode || inspected.size !== record.sizeBytes) throw new Error("attachment-file-changed");
      const bytes = Buffer.alloc(inspected.size); let offset = 0;
      while (offset < bytes.length) { const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (read <= 0) break; offset += read; }
      if (offset !== bytes.length) throw new Error("attachment-file-short-read"); return bytes;
    } finally { fs.closeSync(descriptor); }
  }
  #consume(record: StoredAttachment): void { this.#records.delete(record.attachmentRef); this.#deleteOwnedPath(record.absolutePath); }
  #deleteOwnedPath(target: string): void {
    if (!this.#safeDirectory() || path.dirname(target) !== this.#directory || !OWNED_FILE.test(path.basename(target))) return;
    try { fs.unlinkSync(target); } catch { /* cleanup is bounded and best-effort */ }
  }
  #safeDirectory(): boolean {
    try { const current = fs.lstatSync(this.#directory); return current.isDirectory() && !current.isSymbolicLink()
      && current.dev === this.#directoryDevice && current.ino === this.#directoryInode && (current.mode & 0o077) === 0; } catch { return false; }
  }
  #cleanup(now: number): void {
    for (const record of this.#records.values()) if (Date.parse(record.expiresAt) <= now) this.#consume(record);
    for (const [key, cached] of this.#cache) if (cached.expiresAt <= now) this.#cache.delete(key);
    for (const [key, cached] of this.#discardCache) if (cached.expiresAt <= now) this.#discardCache.delete(key);
  }
}

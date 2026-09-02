import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 50_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const CORRELATION_TYPE = "piagent-webui-message-correlation";
export const COMPOSITE_DELIVERY_CONFIRMATION_TYPE = "piagent-composite-terminal-delivery-v1";
const persistedCapabilities = new WeakMap<object, PersistedObservation>();
const deliveryCapabilities = new WeakMap<object, DeliveryObservation>();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type PersistedObservation = { file: string; cwd: string; sessionId: string; entryId: string;
  digest: string; byteLength: number; bytes: string; entry: any; fileDigest: string };
type DeliveryObservation = PersistedObservation & { operationRef: string; messageRequestId: string;
  idempotencyKey: string; confirmationEntryId: string; confirmationDigest: string; fileDigest: string };

function assistantText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text).join("\n");
}

function canonicalLine(line: Buffer): any {
  if (!line.length) throw new Error("native-session-empty-record");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(line), value = JSON.parse(text);
  if (!Buffer.from(JSON.stringify(value)).equals(line)) throw new Error("native-session-noncanonical-record");
  return value;
}

function sessionSnapshot(file: string, cwd: string, sessionId: string) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || fs.realpathSync.native(file) !== file)
    throw new Error("native-session-path-invalid");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    fs.fsyncSync(descriptor);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? Number(before.uid))
      || before.size < 1n || before.size > BigInt(MAX_SESSION_BYTES)) throw new Error("native-session-file-unsafe");
    const source = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true });
    const atPath = fs.lstatSync(file, { bigint: true });
    const fields = ["dev", "ino", "mode", "nlink", "uid", "size", "mtimeNs", "ctimeNs"];
    if (source.length !== Number(before.size) || source.at(-1) !== 10 || atPath.isSymbolicLink()
      || fields.some(field => before[field] !== after[field] || after[field] !== atPath[field]))
      throw new Error("native-session-file-changed");
    const lines: Buffer[] = []; let start = 0;
    for (let index = 0; index < source.length; index += 1) if (source[index] === 10) {
      lines.push(source.subarray(start, index)); start = index + 1;
    }
    if (lines.length < 2 || lines.length > MAX_SESSION_ENTRIES + 1) throw new Error("native-session-entry-bound");
    const [header, ...entries] = lines.map(canonicalLine);
    const headerKeys = Object.keys(header ?? {});
    if (header?.type !== "session" || header.version !== 3 || header.id !== sessionId
      || header.cwd !== cwd || !Number.isFinite(Date.parse(header.timestamp))
      || headerKeys.some(key => !["type", "version", "id", "timestamp", "cwd", "parentSession"].includes(key)))
      throw new Error("native-session-header-invalid");
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !ID.test(entry.id)
        || ids.has(entry.id) || !Number.isFinite(Date.parse(entry.timestamp))
        || typeof entry.type !== "string" || entry.parentId !== null && !ids.has(entry.parentId))
        throw new Error("native-session-chain-invalid");
      ids.add(entry.id);
    }
    return { header, entries, all: [header, ...entries], fileDigest: sha(source) };
  } finally { fs.closeSync(descriptor); }
}

function stableManager(manager: any, snapshot: ReturnType<typeof sessionSnapshot>): any[] {
  if (!manager || manager.isPersisted?.() !== true || typeof manager.getEntries !== "function"
    || typeof manager.getBranch !== "function" || typeof manager.getEntry !== "function")
    throw new Error("native-session-manager-unavailable");
  const first = manager.getEntries(), firstText = JSON.stringify(first);
  if (firstText !== JSON.stringify(snapshot.entries) || firstText !== JSON.stringify(manager.getEntries()))
    throw new Error("native-session-memory-disk-mismatch");
  return first;
}

export function capturePersistedAssistantResponse(input: { cwd: string; sessionId: string; manager: any;
  message: any; expectedText: string }): object {
  if (!path.isAbsolute(input.cwd) || fs.realpathSync.native(input.cwd) !== input.cwd
    || !ID.test(input.sessionId) || input.message?.role !== "assistant" || typeof input.expectedText !== "string"
    || !(input.expectedText as any).isWellFormed() || Buffer.byteLength(input.expectedText) > 65_536
    || assistantText(input.message) !== input.expectedText) throw new Error("native-response-input-invalid");
  const file = input.manager?.getSessionFile?.();
  if (typeof file !== "string") throw new Error("native-session-file-unavailable");
  const snapshot = sessionSnapshot(file, input.cwd, input.sessionId), memory = stableManager(input.manager, snapshot);
  const matches = memory.filter((entry: any) => entry?.type === "message" && entry.message === input.message);
  if (matches.length !== 1) throw new Error("native-response-object-identity-mismatch");
  const entry = matches[0], branch = input.manager.getBranch();
  if (branch.filter((candidate: any) => candidate === entry).length !== 1 || branch.at(-1) !== entry
    || input.manager.getLeafId?.() !== entry.id || input.manager.getEntry(entry.id) !== entry
    || snapshot.entries.at(-1)?.id !== entry.id || !isDeepStrictEqual(snapshot.entries.at(-1), entry))
    throw new Error("native-response-branch-identity-mismatch");
  const observation: PersistedObservation = { file, cwd: input.cwd, sessionId: input.sessionId, entryId: entry.id,
    digest: sha(input.expectedText), byteLength: Buffer.byteLength(input.expectedText), bytes: input.expectedText,
    entry: structuredClone(entry), fileDigest: snapshot.fileDigest };
  const capability = Object.freeze({ version: "native-persisted-response-capability-v1", entryId: entry.id,
    digest: observation.digest, byteLength: observation.byteLength });
  persistedCapabilities.set(capability, observation); return capability;
}

export function persistedAssistantResponseObservation(capability: object): Readonly<PersistedObservation> {
  const value = persistedCapabilities.get(capability);
  if (!value) throw new Error("untrusted-native-response-capability");
  return Object.freeze({ ...value, entry: structuredClone(value.entry) });
}

function correlation(entry: any) {
  const data = entry?.data;
  return entry?.type === "custom" && entry.customType === CORRELATION_TYPE && data?.schemaVersion === 1
    && ID.test(data.messageRequestId) && ID.test(data.operationRef)
    ? { messageRequestId: data.messageRequestId, operationRef: data.operationRef } : null;
}

export function commitCompositeWebUiDelivery(input: { response: object; manager: any; taskRunId: string;
  operationRef: string; messageRequestId: string; idempotencyKey: string }): object {
  const response = persistedCapabilities.get(input.response);
  if (!response || !ID.test(input.taskRunId) || !ID.test(input.operationRef) || !ID.test(input.messageRequestId)
    || !HASH.test(input.idempotencyKey)) throw new Error("composite-delivery-input-invalid");
  const before = sessionSnapshot(response.file, response.cwd, response.sessionId), memory = stableManager(input.manager, before);
  const branch = input.manager.getBranch(), responseIndex = branch.findIndex((entry: any) => entry?.id === response.entryId);
  const matching = branch.map((entry: any, index: number) => ({ entry, index, value: correlation(entry) }))
    .filter(item => item.value?.operationRef === input.operationRef && item.value?.messageRequestId === input.messageRequestId);
  const globalMatches = memory.filter((entry: any) => { const value = correlation(entry); return value?.operationRef === input.operationRef
    && value?.messageRequestId === input.messageRequestId; });
  if (responseIndex < 0 || matching.length !== 1 || globalMatches.length !== 1
    || matching[0].index >= responseIndex || branch.slice(matching[0].index + 1, responseIndex)
      .filter((entry: any) => entry?.type === "message" && entry.message?.role === "user").length !== 1)
    throw new Error("composite-delivery-correlation-mismatch");
  const data = { schemaVersion: 1, taskRunId: input.taskRunId, sessionId: response.sessionId,
    responseEntryId: response.entryId, responseDigest: response.digest, responseByteLength: response.byteLength,
    operationRef: input.operationRef, messageRequestId: input.messageRequestId, idempotencyKey: input.idempotencyKey };
  const existing = branch.filter((entry: any) => entry?.type === "custom"
    && entry.customType === COMPOSITE_DELIVERY_CONFIRMATION_TYPE && entry.data?.idempotencyKey === input.idempotencyKey);
  if (existing.length === 1) {
    const confirmation = existing[0], disk = before.entries.find((entry: any) => entry?.id === confirmation.id);
    if (branch.at(-1) !== confirmation || !isDeepStrictEqual(confirmation.data, data)
      || !isDeepStrictEqual(confirmation, disk)) throw new Error("composite-delivery-replay-mismatch");
    const observation: DeliveryObservation = { ...response, operationRef: input.operationRef,
      messageRequestId: input.messageRequestId, idempotencyKey: input.idempotencyKey,
      confirmationEntryId: confirmation.id, confirmationDigest: sha(JSON.stringify(confirmation)), fileDigest: before.fileDigest };
    const capability = Object.freeze({ version: "native-webui-delivery-capability-v1",
      confirmationEntryId: confirmation.id, responseEntryId: response.entryId, idempotencyKey: input.idempotencyKey });
    deliveryCapabilities.set(capability, observation); return capability;
  }
  if (existing.length || branch.at(-1)?.id !== response.entryId) throw new Error("composite-delivery-replay-mismatch");
  if (typeof input.manager.appendCustomEntry !== "function") throw new Error("composite-delivery-append-unavailable");
  const confirmationEntryId = input.manager.appendCustomEntry(COMPOSITE_DELIVERY_CONFIRMATION_TYPE, data);
  if (!ID.test(confirmationEntryId)) throw new Error("composite-delivery-entry-invalid");
  const after = sessionSnapshot(response.file, response.cwd, response.sessionId), current = stableManager(input.manager, after);
  const confirmation = current.at(-1), disk = after.entries.at(-1);
  if (input.manager.getLeafId?.() !== confirmationEntryId || confirmation?.id !== confirmationEntryId
    || confirmation?.type !== "custom" || confirmation.customType !== COMPOSITE_DELIVERY_CONFIRMATION_TYPE
    || !isDeepStrictEqual(confirmation.data, data) || !isDeepStrictEqual(confirmation, disk)
    || after.entries.filter((entry: any) => entry?.customType === COMPOSITE_DELIVERY_CONFIRMATION_TYPE
      && entry.data?.idempotencyKey === input.idempotencyKey).length !== 1)
    throw new Error("composite-delivery-not-persisted");
  const observation: DeliveryObservation = { ...response, operationRef: input.operationRef,
    messageRequestId: input.messageRequestId, idempotencyKey: input.idempotencyKey,
    confirmationEntryId, confirmationDigest: sha(JSON.stringify(confirmation)), fileDigest: after.fileDigest };
  const capability = Object.freeze({ version: "native-webui-delivery-capability-v1", confirmationEntryId,
    responseEntryId: response.entryId, idempotencyKey: input.idempotencyKey });
  deliveryCapabilities.set(capability, observation); return capability;
}

export function webUiDeliveryObservation(capability: object): Readonly<DeliveryObservation> {
  const value = deliveryCapabilities.get(capability);
  if (!value) throw new Error("untrusted-native-delivery-capability");
  return Object.freeze({ ...value, entry: structuredClone(value.entry) });
}

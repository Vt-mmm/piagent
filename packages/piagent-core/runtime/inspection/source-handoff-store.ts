import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { canonicalReviewValue } from "./review-state-contract.ts";
import { readTaskBaselineManifest, taskBaselineRetentionState } from "./source-evidence-store.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/, DIGEST = /^sha256:[a-f0-9]{64}$/,
  REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, MAX_RECORDS = 2_000, MAX_BYTES = 32 * 1024;
export const SOURCE_HANDOFF_EVIDENCE_VERSION = "piagent-webui-source-handoff-v1";

export type SourceHandoffRecord = { schemaVersion: 1; version: typeof SOURCE_HANDOFF_EVIDENCE_VERSION; recordId: string; evidenceRef: string;
  sequence: number; phase: "requested" | "settled" | "rejected" | "uncertain"; resultCode: "handoff-requested" | "opened" | "handoff-rejected" | "effect-unknown";
  failureCode: string | null; projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string;
  commandId: string; idempotencyKeyDigest: string; actionDigest: string; fileRef: string; line: number | null; column: number | null;
  taskRevision: string; workspaceRevision: string; contentDigest: string; requestedAt: string; recordedAt: string; retentionUntil: string; integrityDigest: string };
type Append = Omit<SourceHandoffRecord, "schemaVersion" | "version" | "recordId" | "evidenceRef" | "sequence" | "retentionUntil" | "integrityDigest"> & { projectRoot: string };

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: unknown): string { return `sha256:${sha(canonicalReviewValue(value))}`; }
function timestamp(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function directory(root: string, run: string): string { return path.join(root, ".pi", "piagent-state", "source-evidence", `run-${sha(run)}`, "handoffs"); }
function readPrivate(root: string, file: string): Buffer { const safe = resolveLocalStatePath(root, file, { label: "Source handoff evidence", kind: "file" });
  const descriptor = fs.openSync(safe, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); try { const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("source-handoff-record-invalid"); return fs.readFileSync(descriptor); } finally { fs.closeSync(descriptor); } }
function publish(root: string, target: string, bytes: Buffer): void { const parent = ensurePrivateStateDirectory(root, path.dirname(target), "Source handoff evidence directory");
  const safe = resolveLocalStatePath(root, target, { label: "Source handoff evidence" }), temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}`);
  const descriptor = fs.openSync(temporary, "wx", 0o600); try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); } finally { fs.closeSync(descriptor); }
  try { fs.linkSync(temporary, safe); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readPrivate(root, safe).equals(bytes)) throw error; }
  finally { fs.rmSync(temporary, { force: true }); } }

export function validateSourceHandoffRecord(value: unknown): SourceHandoffRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source-handoff-record-invalid"); const record = value as SourceHandoffRecord;
  const keys = ["schemaVersion", "version", "recordId", "evidenceRef", "sequence", "phase", "resultCode", "failureCode", "projectRef", "runtimeInstanceId",
    "sessionRef", "taskId", "taskRunId", "commandId", "idempotencyKeyDigest", "actionDigest", "fileRef", "line", "column", "taskRevision",
    "workspaceRevision", "contentDigest", "requestedAt", "recordedAt", "retentionUntil", "integrityDigest"];
  if (canonicalReviewValue(Object.keys(record).sort()) !== canonicalReviewValue(keys.sort()) || record.schemaVersion !== 1 || record.version !== SOURCE_HANDOFF_EVIDENCE_VERSION
    || ![record.recordId, record.evidenceRef, record.projectRef, record.runtimeInstanceId, record.sessionRef, record.taskId, record.taskRunId, record.commandId, record.fileRef].every((item) => REF.test(item))
    || ![record.idempotencyKeyDigest, record.actionDigest, record.contentDigest, record.integrityDigest].every((item) => DIGEST.test(item))
    || ![record.taskRevision, record.workspaceRevision].every((item) => REVISION.test(item)) || ![record.requestedAt, record.recordedAt, record.retentionUntil].every(timestamp)
    || !Number.isInteger(record.sequence) || record.sequence < 1 || record.sequence > MAX_RECORDS || record.line !== null && (!Number.isInteger(record.line) || record.line < 1 || record.line > 100_000_000)
    || record.column !== null && (!Number.isInteger(record.column) || record.column < 1 || record.column > 1_000_000) || record.column !== null && record.line === null
    || !(record.failureCode === null || /^[a-z][a-z0-9.-]{0,95}$/.test(record.failureCode))) throw new Error("source-handoff-record-invalid");
  const expected = { requested: "handoff-requested", settled: "opened", rejected: "handoff-rejected", uncertain: "effect-unknown" }[record.phase];
  if (record.resultCode !== expected || ["requested", "settled"].includes(record.phase) !== (record.failureCode === null)) throw new Error("source-handoff-record-invalid");
  const { integrityDigest, ...payload } = record; if (digest(payload) !== integrityDigest) throw new Error("source-handoff-record-invalid"); return structuredClone(record);
}

export function readSourceHandoffEvidence(root: string, run: string): { records: SourceHandoffRecord[]; corruptions: string[] } {
  let files: string[]; const folder = directory(root, run); try { files = fs.readdirSync(resolveLocalStatePath(root, folder, { label: "Source handoff evidence", kind: "directory" })).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { records: [], corruptions: [] } : { records: [], corruptions: ["source-handoff-evidence-unavailable"] }; }
  if (files.length > MAX_RECORDS) return { records: [], corruptions: ["source-handoff-record-limit"] }; const records: SourceHandoffRecord[] = [], corruptions: string[] = [];
  for (const file of files) try { const record = validateSourceHandoffRecord(JSON.parse(readPrivate(root, path.join(folder, file)).toString("utf8")));
    if (file !== `${record.recordId}.json` || record.taskRunId !== run) throw new Error("source-handoff-identity-invalid"); records.push(record); }
  catch { corruptions.push(`handoff.${sha(file)}`); } return { records: corruptions.length ? [] : records.sort((a, b) => a.sequence - b.sequence), corruptions };
}

export function appendSourceHandoffEvidence(options: Append): SourceHandoffRecord {
  const manifest = readTaskBaselineManifest(options.projectRoot, options.taskRunId); if (!manifest || manifest.taskId !== options.taskId || manifest.captureState !== "current"
    || taskBaselineRetentionState(manifest, new Date(options.recordedAt)) !== "active") throw new Error("source-handoff-baseline-unavailable");
  const existing = readSourceHandoffEvidence(options.projectRoot, options.taskRunId); if (existing.corruptions.length || existing.records.length >= MAX_RECORDS) throw new Error("source-handoff-evidence-unavailable");
  const identity = digest({ commandId: options.commandId, actionDigest: options.actionDigest, phase: options.phase }), recordId = `handoff.${identity.slice(7)}`;
  const old = existing.records.find((record) => record.recordId === recordId); if (old) return old;
  const payload = { schemaVersion: 1 as const, version: SOURCE_HANDOFF_EVIDENCE_VERSION, recordId, evidenceRef: `handoff-evidence.${identity.slice(7)}`,
    sequence: (existing.records.at(-1)?.sequence ?? 0) + 1, retentionUntil: manifest.retentionUntil, ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== "projectRoot")) } as Omit<SourceHandoffRecord, "integrityDigest">;
  const record = validateSourceHandoffRecord({ ...payload, integrityDigest: digest(payload) }), bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > MAX_BYTES) throw new Error("source-handoff-record-oversized"); publish(options.projectRoot, path.join(directory(options.projectRoot, options.taskRunId), `${record.recordId}.json`), bytes); return record;
}

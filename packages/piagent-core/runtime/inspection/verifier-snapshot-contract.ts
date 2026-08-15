import { createHash } from "node:crypto";
import path from "node:path";

export const VERIFIER_SNAPSHOT_VERSION = "piagent-verifier-file-snapshot-v1" as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TREE = /^wt-content-v2:[a-f0-9]{64}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type VerifierSnapshotFile = {
  pathDigest: string;
  repoPathBase64: string | null;
  state: "exact" | "protected" | "unavailable";
  reasonCode: string | null;
  carrierDigest: string;
};

export type VerifierFileSnapshot = {
  schemaVersion: 1;
  version: typeof VERIFIER_SNAPSHOT_VERSION;
  attemptId: string;
  attemptRef: string;
  taskId: string;
  taskRunId: string;
  sessionIdentityHash: string;
  toolCallIdentityHash: string;
  commandDigest: string;
  observedAt: string;
  capturedAt: string;
  retentionUntil: string;
  exitCode: number;
  outcome: "passed" | "failed";
  treeDigest: string;
  fileCount: number;
  exposedPathCount: number;
  files: VerifierSnapshotFile[];
  integrityDigest: string;
};

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function verifierSnapshotIdentity(value: Pick<VerifierFileSnapshot,
  "taskRunId" | "toolCallIdentityHash" | "commandDigest" | "observedAt" | "treeDigest" | "exitCode">): string {
  const identity = { taskRunId: value.taskRunId, toolCallIdentityHash: value.toolCallIdentityHash,
    commandDigest: value.commandDigest, observedAt: value.observedAt, treeDigest: value.treeDigest, exitCode: value.exitCode };
  return hash(`verifier-file-snapshot-identity-v1\0${JSON.stringify(canonical(identity))}`);
}

export function verifierSnapshotDigest(value: Omit<VerifierFileSnapshot, "integrityDigest"> | VerifierFileSnapshot): string {
  const { integrityDigest: _ignored, ...payload } = value as VerifierFileSnapshot;
  return `sha256:${hash(`verifier-file-snapshot-v1\0${JSON.stringify(canonical(payload))}`)}`;
}

export function decodeVerifierSnapshotPath(file: VerifierSnapshotFile): string | null {
  if (!file.repoPathBase64) return null;
  const value = Buffer.from(file.repoPathBase64, "base64url").toString("utf8");
  return value && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.split("/").includes("..") && !value.includes("\0") ? value : null;
}

function validFile(value: unknown): value is VerifierSnapshotFile {
  if (!plain(value) || !exactKeys(value, ["pathDigest", "repoPathBase64", "state", "reasonCode", "carrierDigest"])) return false;
  if (!DIGEST.test(String(value.pathDigest)) || !TREE.test(String(value.carrierDigest))) return false;
  if (!["exact", "protected", "unavailable"].includes(String(value.state))) return false;
  if (value.state === "exact") {
    if (typeof value.repoPathBase64 !== "string" || !value.repoPathBase64 || value.repoPathBase64.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value.repoPathBase64) || value.reasonCode !== null) return false;
    const decoded = decodeVerifierSnapshotPath(value as VerifierSnapshotFile);
    return Boolean(decoded && value.pathDigest === `sha256:${hash(decoded as string)}`);
  }
  return value.repoPathBase64 === null && typeof value.reasonCode === "string" && /^[a-z0-9][a-z0-9.-]{0,95}$/.test(value.reasonCode);
}

export function verifierSnapshotErrors(value: unknown): string[] {
  const keys = ["schemaVersion", "version", "attemptId", "attemptRef", "taskId", "taskRunId", "sessionIdentityHash", "toolCallIdentityHash", "commandDigest", "observedAt", "capturedAt", "retentionUntil", "exitCode", "outcome", "treeDigest", "fileCount", "exposedPathCount", "files", "integrityDigest"];
  if (!plain(value) || !exactKeys(value, keys)) return ["snapshot shape is invalid"];
  const errors: string[] = [];
  if (value.schemaVersion !== 1 || value.version !== VERIFIER_SNAPSHOT_VERSION) errors.push("snapshot version is invalid");
  if (!PUBLIC_ID.test(String(value.taskId)) || !PUBLIC_ID.test(String(value.taskRunId))) errors.push("task identity is invalid");
  if (![value.sessionIdentityHash, value.toolCallIdentityHash, value.commandDigest, value.integrityDigest].every((item) => DIGEST.test(String(item)))) errors.push("digest identity is invalid");
  const observed = Date.parse(String(value.observedAt)), captured = Date.parse(String(value.capturedAt)), retention = Date.parse(String(value.retentionUntil));
  if (![value.observedAt, value.capturedAt, value.retentionUntil].every((item) => TIMESTAMP.test(String(item)))
    || ![observed, captured, retention].every(Number.isFinite) || captured < observed || retention <= captured
    || retention - captured > 365 * 24 * 60 * 60 * 1000) errors.push("snapshot timestamps are invalid");
  if (!Number.isInteger(value.exitCode) || (value.exitCode as number) < -2147483648 || (value.exitCode as number) > 2147483647
    || (value.outcome === "passed" ? value.exitCode !== 0 : value.outcome !== "failed" || value.exitCode === 0)) errors.push("verifier outcome is invalid");
  if (!TREE.test(String(value.treeDigest))) errors.push("tree digest is invalid");
  if (!Array.isArray(value.files) || value.files.length > 2000 || !value.files.every(validFile)
    || value.fileCount !== value.files.length || value.exposedPathCount !== value.files.filter((file) => (file as VerifierSnapshotFile).state === "exact").length) errors.push("file snapshot is invalid");
  else if (new Set(value.files.map((file) => (file as VerifierSnapshotFile).pathDigest)).size !== value.files.length) errors.push("file snapshot has duplicate paths");
  const identity = verifierSnapshotIdentity(value as VerifierFileSnapshot);
  if (value.attemptId !== `verifier.${identity}` || value.attemptRef !== `verifier-evidence.${identity}`) errors.push("attempt identity is invalid");
  if (value.integrityDigest !== verifierSnapshotDigest(value as VerifierFileSnapshot)) errors.push("snapshot integrity is invalid");
  return errors;
}

export function validateVerifierFileSnapshot(value: unknown): VerifierFileSnapshot {
  const errors = verifierSnapshotErrors(value);
  if (errors.length) throw new Error(`Invalid verifier file snapshot: ${errors.join("; ")}`);
  return structuredClone(value) as VerifierFileSnapshot;
}

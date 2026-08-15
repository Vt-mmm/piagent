import { createHash } from "node:crypto";
import path from "node:path";

export const MUTATION_PROVENANCE_VERSION = "piagent-mutation-provenance-v1" as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TREE = /^wt-content-v2:[a-f0-9]{64}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type MutationProvenanceChange = {
  pathDigest: string;
  repoPathBase64: string;
  beforeCarrierDigest: string | null;
  afterCarrierDigest: string | null;
  afterContentDigest: string | null;
  proofMode: "full-content" | "exact-replacement" | null;
  effect: "exact-content" | "content-preserved" | "content-changed" | "unknown";
};

export type MutationProvenanceRecord = {
  schemaVersion: 1;
  version: typeof MUTATION_PROVENANCE_VERSION;
  recordId: string;
  evidenceRef: string;
  taskId: string;
  taskRunId: string;
  sessionIdentityHash: string;
  toolCallIdentityHash: string;
  toolName: "edit" | "write" | "apply_patch" | "shell" | "opaque";
  recordedAt: string;
  evidenceMode: "exact-runtime" | "observed-runtime";
  beforeTreeDigest: string;
  afterTreeDigest: string;
  changes: MutationProvenanceChange[];
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function mutationProvenanceIdentity(value: Pick<MutationProvenanceRecord,
  "taskRunId" | "toolCallIdentityHash" | "recordedAt" | "afterTreeDigest" | "changes">): string {
  const identity = {
    taskRunId: value.taskRunId,
    toolCallIdentityHash: value.toolCallIdentityHash,
    recordedAt: value.recordedAt,
    afterTreeDigest: value.afterTreeDigest,
    changes: value.changes
  };
  return hash(`mutation-provenance-identity-v1\0${JSON.stringify(canonical(identity))}`);
}

export function mutationProvenanceDigest(value: Omit<MutationProvenanceRecord, "integrityDigest"> | MutationProvenanceRecord): string {
  const { integrityDigest: _ignored, ...payload } = value as MutationProvenanceRecord;
  return `sha256:${hash(`mutation-provenance-record-v1\0${JSON.stringify(canonical(payload))}`)}`;
}

export function decodeMutationRepoPath(change: MutationProvenanceChange): string | null {
  const value = Buffer.from(change.repoPathBase64, "base64url").toString("utf8");
  return value && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.split("/").includes("..") && !value.includes("\0") ? value : null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validChange(value: unknown): value is MutationProvenanceChange {
  if (!plain(value) || !exactKeys(value, ["pathDigest", "repoPathBase64", "beforeCarrierDigest", "afterCarrierDigest", "afterContentDigest", "proofMode", "effect"])) return false;
  if (!DIGEST.test(String(value.pathDigest))) return false;
  if (typeof value.repoPathBase64 !== "string" || !value.repoPathBase64 || value.repoPathBase64.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value.repoPathBase64)) return false;
  if (value.beforeCarrierDigest !== null && !TREE.test(String(value.beforeCarrierDigest))) return false;
  if (value.afterCarrierDigest !== null && !TREE.test(String(value.afterCarrierDigest))) return false;
  if (value.afterContentDigest !== null && !DIGEST.test(String(value.afterContentDigest))) return false;
  if (value.beforeCarrierDigest === value.afterCarrierDigest) return false;
  if (value.proofMode !== null && !["full-content", "exact-replacement"].includes(String(value.proofMode))) return false;
  if (!["exact-content", "content-preserved", "content-changed", "unknown"].includes(String(value.effect))) return false;
  const repoPath = decodeMutationRepoPath(value as MutationProvenanceChange);
  return Boolean(repoPath && value.pathDigest === `sha256:${hash(repoPath as string)}`);
}

export function mutationProvenanceErrors(value: unknown): string[] {
  const keys = ["schemaVersion", "version", "recordId", "evidenceRef", "taskId", "taskRunId", "sessionIdentityHash", "toolCallIdentityHash", "toolName", "recordedAt", "evidenceMode", "beforeTreeDigest", "afterTreeDigest", "changes", "integrityDigest"];
  if (!plain(value) || !exactKeys(value, keys)) return ["record shape is invalid"];
  const errors: string[] = [];
  if (value.schemaVersion !== 1 || value.version !== MUTATION_PROVENANCE_VERSION) errors.push("record version is invalid");
  if (!PUBLIC_ID.test(String(value.taskId)) || !PUBLIC_ID.test(String(value.taskRunId))) errors.push("task identity is invalid");
  if (!DIGEST.test(String(value.sessionIdentityHash)) || !DIGEST.test(String(value.toolCallIdentityHash))) errors.push("private identity hash is invalid");
  if (!["edit", "write", "apply_patch", "shell", "opaque"].includes(String(value.toolName))
    || !["exact-runtime", "observed-runtime"].includes(String(value.evidenceMode))) errors.push("tool evidence is invalid");
  if (!TIMESTAMP.test(String(value.recordedAt)) || !Number.isFinite(Date.parse(String(value.recordedAt)))) errors.push("recorded timestamp is invalid");
  if (!TREE.test(String(value.beforeTreeDigest)) || !TREE.test(String(value.afterTreeDigest)) || value.beforeTreeDigest === value.afterTreeDigest) errors.push("tree evidence is invalid");
  if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 100 || !value.changes.every(validChange)) errors.push("file changes are invalid");
  else if (new Set(value.changes.map((change) => (change as MutationProvenanceChange).pathDigest)).size !== value.changes.length) errors.push("file changes are duplicated");
  else if (value.evidenceMode === "exact-runtime" && (
    !["edit", "write", "apply_patch"].includes(String(value.toolName))
    || value.changes.some((change) => {
      const item = change as MutationProvenanceChange;
      return item.afterCarrierDigest === null || item.afterContentDigest === null || item.proofMode === null || item.effect !== "exact-content";
    })
  )) errors.push("exact mutation proof is invalid");
  else if (value.evidenceMode === "observed-runtime" && value.changes.some((change) => {
    const item = change as MutationProvenanceChange;
    return item.proofMode !== null || item.effect === "exact-content"
      || (item.effect === "content-preserved" && item.afterContentDigest === null);
  })) errors.push("observed mutation proof is invalid");
  const identity = mutationProvenanceIdentity(value as MutationProvenanceRecord);
  if (value.recordId !== `provenance.${identity}` || value.evidenceRef !== `mutation.${identity}`) errors.push("record identity is invalid");
  if (!DIGEST.test(String(value.integrityDigest)) || value.integrityDigest !== mutationProvenanceDigest(value as MutationProvenanceRecord)) errors.push("record integrity is invalid");
  return errors;
}

export function validateMutationProvenanceRecord(value: unknown): MutationProvenanceRecord {
  const errors = mutationProvenanceErrors(value);
  if (errors.length) throw new Error(`Invalid mutation provenance record: ${errors.join("; ")}`);
  return structuredClone(value) as MutationProvenanceRecord;
}

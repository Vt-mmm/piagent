import { createHash } from "node:crypto";

export const TASK_BASELINE_MANIFEST_VERSION = "piagent-task-baseline-manifest-v1" as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TREE_DIGEST = /^wt-content-v2:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type BaselineEntryState = "blob" | "absent" | "symlink" | "submodule" | "protected" | "oversized" | "unavailable";

export type TaskBaselineEntry = {
  pathRef: string;
  pathDigest: string;
  repoPathBase64: string | null;
  state: BaselineEntryState;
  reasonCode: string | null;
  contentRef: string | null;
  byteLength: number;
  mode: string;
  headObject: string | null;
  indexObject: string | null;
};

export type TaskBaselineRoot = {
  repoRef: string;
  projectPath: string;
  headState: "head" | "unborn" | "unavailable";
  headOid: string | null;
  workspaceRevision: string;
  indexRevision: string;
  state: "current" | "unavailable";
  reasonCode: string | null;
  entries: TaskBaselineEntry[];
};

export type TaskBaselineManifest = {
  schemaVersion: 1;
  version: typeof TASK_BASELINE_MANIFEST_VERSION;
  taskId: string;
  taskRunId: string;
  sessionIdentityHash: string;
  capturedAt: string;
  retentionUntil: string;
  baselineDigestAlgorithm: "wt-content-v2";
  baselineTreeDigest: string;
  captureState: "current" | "degraded" | "unavailable";
  reasonCode: string | null;
  limits: { maxEntries: number; maxFileBytes: number; maxTotalBytes: number; capturedBytes: number };
  roots: TaskBaselineRoot[];
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

export function taskBaselineManifestDigest(value: Omit<TaskBaselineManifest, "integrityDigest"> | TaskBaselineManifest): string {
  const { integrityDigest: _ignored, ...payload } = value as TaskBaselineManifest;
  return `sha256:${createHash("sha256").update(`task-baseline-manifest-v1\0${JSON.stringify(canonical(payload))}`).digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function reason(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,95}$/.test(value);
}

function validEntry(value: unknown): value is TaskBaselineEntry {
  if (!plain(value) || !exactKeys(value, ["pathRef", "pathDigest", "repoPathBase64", "state", "reasonCode", "contentRef", "byteLength", "mode", "headObject", "indexObject"])) return false;
  if (!TOKEN.test(String(value.pathRef)) || !DIGEST.test(String(value.pathDigest))) return false;
  if (value.repoPathBase64 !== null && (typeof value.repoPathBase64 !== "string" || value.repoPathBase64.length > 4096 || !/^[A-Za-z0-9_-]*$/.test(value.repoPathBase64))) return false;
  const states: BaselineEntryState[] = ["blob", "absent", "symlink", "submodule", "protected", "oversized", "unavailable"];
  if (!states.includes(value.state as BaselineEntryState)) return false;
  if (!Number.isInteger(value.byteLength) || (value.byteLength as number) < 0 || (value.byteLength as number) > 16 * 1024 * 1024) return false;
  if (!/^[0-7]{6}$/.test(String(value.mode))) return false;
  if (value.headObject !== null && !OID.test(String(value.headObject))) return false;
  if (value.indexObject !== null && !OID.test(String(value.indexObject))) return false;
  if (["blob", "symlink"].includes(String(value.state))) return DIGEST.test(String(value.contentRef)) && value.reasonCode === null;
  if (value.contentRef !== null) return false;
  return ["protected", "oversized", "unavailable"].includes(String(value.state)) ? reason(value.reasonCode) : value.reasonCode === null;
}

function validRoot(value: unknown): value is TaskBaselineRoot {
  if (!plain(value) || !exactKeys(value, ["repoRef", "projectPath", "headState", "headOid", "workspaceRevision", "indexRevision", "state", "reasonCode", "entries"])) return false;
  if (!TOKEN.test(String(value.repoRef)) || typeof value.projectPath !== "string" || !value.projectPath || value.projectPath.length > 1024) return false;
  if (!TOKEN.test(String(value.workspaceRevision)) || !TOKEN.test(String(value.indexRevision))) return false;
  if (!Array.isArray(value.entries) || value.entries.length > 2000 || !value.entries.every(validEntry)) return false;
  if (value.headState === "head") { if (!OID.test(String(value.headOid))) return false; }
  else if (!["unborn", "unavailable"].includes(String(value.headState)) || value.headOid !== null) return false;
  if (value.state === "current") return value.reasonCode === null;
  return value.state === "unavailable" && reason(value.reasonCode);
}

export function taskBaselineManifestErrors(value: unknown): string[] {
  const errors: string[] = [];
  const keys = ["schemaVersion", "version", "taskId", "taskRunId", "sessionIdentityHash", "capturedAt", "retentionUntil", "baselineDigestAlgorithm", "baselineTreeDigest", "captureState", "reasonCode", "limits", "roots", "integrityDigest"];
  if (!plain(value) || !exactKeys(value, keys)) return ["manifest shape is invalid"];
  if (value.schemaVersion !== 1 || value.version !== TASK_BASELINE_MANIFEST_VERSION) errors.push("manifest version is invalid");
  if (!PUBLIC_ID.test(String(value.taskId)) || !PUBLIC_ID.test(String(value.taskRunId))) errors.push("task identity is invalid");
  if (!DIGEST.test(String(value.sessionIdentityHash))) errors.push("session identity hash is invalid");
  const capturedAt = Date.parse(String(value.capturedAt));
  const retentionUntil = Date.parse(String(value.retentionUntil));
  if (!TIMESTAMP.test(String(value.capturedAt)) || !TIMESTAMP.test(String(value.retentionUntil))
    || !Number.isFinite(capturedAt) || !Number.isFinite(retentionUntil)
    || retentionUntil <= capturedAt || retentionUntil - capturedAt > 365 * 24 * 60 * 60 * 1000) errors.push("manifest timestamps are invalid");
  if (value.baselineDigestAlgorithm !== "wt-content-v2" || !TREE_DIGEST.test(String(value.baselineTreeDigest))) errors.push("baseline tree digest is invalid");
  if (!plain(value.limits) || !exactKeys(value.limits, ["maxEntries", "maxFileBytes", "maxTotalBytes", "capturedBytes"])) errors.push("manifest limits are invalid");
  else if (
    !Number.isInteger(value.limits.maxEntries) || (value.limits.maxEntries as number) < 1 || (value.limits.maxEntries as number) > 2000
    || !Number.isInteger(value.limits.maxFileBytes) || (value.limits.maxFileBytes as number) < 1024 || (value.limits.maxFileBytes as number) > 16 * 1024 * 1024
    || !Number.isInteger(value.limits.maxTotalBytes) || (value.limits.maxTotalBytes as number) < 1024 * 1024 || (value.limits.maxTotalBytes as number) > 256 * 1024 * 1024
    || !Number.isInteger(value.limits.capturedBytes) || (value.limits.capturedBytes as number) < 0 || (value.limits.capturedBytes as number) > (value.limits.maxTotalBytes as number)
  ) errors.push("manifest limit values are invalid");
  if (!Array.isArray(value.roots) || value.roots.length < 1 || value.roots.length > 32 || !value.roots.every(validRoot)) errors.push("manifest roots are invalid");
  if (!["current", "degraded", "unavailable"].includes(String(value.captureState))) errors.push("capture state is invalid");
  else if (value.captureState === "current" ? value.reasonCode !== null : !reason(value.reasonCode)) errors.push("capture reason is invalid");
  if (!DIGEST.test(String(value.integrityDigest)) || value.integrityDigest !== taskBaselineManifestDigest(value as TaskBaselineManifest)) errors.push("manifest integrity digest is invalid");
  return errors;
}

export function validateTaskBaselineManifest(value: unknown): TaskBaselineManifest {
  const errors = taskBaselineManifestErrors(value);
  if (errors.length) throw new Error(`Invalid task baseline manifest: ${errors.join("; ")}`);
  return structuredClone(value) as TaskBaselineManifest;
}

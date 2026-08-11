import fs from "node:fs";
import path from "node:path";

import { resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { appendJsonlBounded } from "../../extensions/state-retention.js";
import {
  redactRuntimeModelSnapshot,
  runtimeModelSnapshotDigest,
  validateRuntimeModelSnapshot
} from "./runtime-snapshot.ts";
import type { RuntimeModelSnapshot } from "./runtime-snapshot.ts";

export const RUNTIME_SNAPSHOT_TELEMETRY_SCHEMA_VERSION = 1 as const;
const MAX_TELEMETRY_BYTES = 512 * 1024;

type RuntimeSnapshotTelemetryRecord = {
  schemaVersion: typeof RUNTIME_SNAPSHOT_TELEMETRY_SCHEMA_VERSION;
  recordedAt: string;
  snapshotDigest: string;
  snapshot: RuntimeModelSnapshot;
};

export type RuntimeSnapshotTelemetryView = {
  records: RuntimeSnapshotTelemetryRecord[];
  latest?: RuntimeSnapshotTelemetryRecord;
  corruptions: string[];
  routingSafe: boolean;
};

export function runtimeSnapshotTelemetryPath(cwd: string): string {
  return path.join(cwd, ".pi", "piagent-state", "runtime-model", "snapshots.jsonl");
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return "";
    throw error;
  }
}

function validateRecord(value: unknown): RuntimeSnapshotTelemetryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "recordedAt", "snapshotDigest", "snapshot"]);
  const unknown = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`unknown fields: ${unknown.join(", ")}`);
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) throw new Error("recordedAt is invalid");
  if (typeof record.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.snapshotDigest)) throw new Error("snapshotDigest is invalid");
  const snapshot = validateRuntimeModelSnapshot(record.snapshot, "persisted runtime snapshot");
  if (runtimeModelSnapshotDigest(snapshot) !== record.snapshotDigest) throw new Error("snapshot digest mismatch");
  return record as RuntimeSnapshotTelemetryRecord;
}

export function readRuntimeSnapshotTelemetry(cwd: string): RuntimeSnapshotTelemetryView {
  let current: string;
  let rotated: string;
  try {
    const target = runtimeSnapshotTelemetryPath(cwd);
    current = resolveLocalStatePath(cwd, target, { label: "Runtime snapshot telemetry" });
    rotated = resolveLocalStatePath(cwd, `${target}.1`, { label: "Rotated runtime snapshot telemetry" });
  } catch {
    return { records: [], corruptions: ["runtime snapshot telemetry path is unsafe"], routingSafe: false };
  }
  const records: RuntimeSnapshotTelemetryRecord[] = [];
  const corruptions: string[] = [];
  const lines = [readText(rotated), readText(current)].join("").split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    try {
      records.push(validateRecord(JSON.parse(line)));
    } catch (error) {
      corruptions.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { records, latest: records.at(-1), corruptions, routingSafe: corruptions.length === 0 };
}

export function recordRuntimeSnapshotTelemetry(
  cwd: string,
  input: RuntimeModelSnapshot,
  options: { recordedAt?: string } = {}
): { written: boolean; snapshotDigest: string; corruptions: string[] } {
  const snapshot = redactRuntimeModelSnapshot(input);
  const snapshotDigest = runtimeModelSnapshotDigest(snapshot);
  const existing = readRuntimeSnapshotTelemetry(cwd);
  if (!existing.routingSafe) return { written: false, snapshotDigest, corruptions: existing.corruptions };
  if (existing.latest?.snapshotDigest === snapshotDigest) return { written: false, snapshotDigest, corruptions: [] };
  const record: RuntimeSnapshotTelemetryRecord = {
    schemaVersion: RUNTIME_SNAPSHOT_TELEMETRY_SCHEMA_VERSION,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    snapshotDigest,
    snapshot
  };
  appendJsonlBounded(runtimeSnapshotTelemetryPath(cwd), record, {
    maxBytes: MAX_TELEMETRY_BYTES,
    mode: 0o600,
    projectRoot: cwd
  });
  return { written: true, snapshotDigest, corruptions: [] };
}

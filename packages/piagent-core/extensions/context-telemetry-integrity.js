import fs from "node:fs";

import { resolveLocalStatePath } from "./local-state-path.js";

const DEFAULT_LIMIT = 50_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function readTelemetryFile(filePath, maximumBytes) {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Context telemetry must be a regular file");
    const start = Math.max(0, stat.size - maximumBytes);
    const buffer = Buffer.allocUnsafe(stat.size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return { text, truncated: start > 0 };
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Fail-closed JSONL inspection used when telemetry becomes benchmark evidence. */
export function inspectContextTelemetryIntegrity(projectRoot, telemetryPath, options = {}) {
  const limit = clampInteger(options.limit, DEFAULT_LIMIT, 1, DEFAULT_LIMIT);
  const maximumBytes = clampInteger(options.maxBytes, DEFAULT_MAX_BYTES, 64 * 1024, 256 * 1024 * 1024);
  const records = [];
  let exists = false, integrityFailures = 0, recoverableTailBytes = 0, inputTruncated = false, rotated = false;
  for (const [index, source] of [`${telemetryPath}.1`, telemetryPath].entries()) {
    const safe = resolveLocalStatePath(projectRoot, source, { label: "Context telemetry" });
    try {
      const stat = fs.lstatSync(safe);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Context telemetry must be a regular file");
      exists = true;
      if (index === 0) rotated = true;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const read = readTelemetryFile(safe, maximumBytes);
    inputTruncated ||= read.truncated;
    const complete = read.text.endsWith("\n") || read.text.endsWith("\r");
    const lines = read.text.split(/\r?\n/);
    if (!complete && lines.at(-1)) recoverableTailBytes += Buffer.byteLength(lines.at(-1));
    for (const [lineIndex, line] of lines.entries()) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== "object" || Array.isArray(record) || record.truncated === true) integrityFailures += 1;
        else records.push(record);
      } catch {
        if (complete || lineIndex !== lines.length - 1) integrityFailures += 1;
      }
    }
  }
  inputTruncated ||= rotated || records.length > limit;
  return { records: records.slice(-limit), exists, integrityFailures, recoverableTailBytes, inputTruncated };
}

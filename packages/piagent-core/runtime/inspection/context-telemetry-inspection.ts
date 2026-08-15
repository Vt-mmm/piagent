import fs from "node:fs";

import { contextEnginePaths } from "../../extensions/context-engine.js";
import { resolveLocalStatePath } from "../../extensions/local-state-path.js";

function tailText(file: string, maximumBytes: number): { text: string; truncated: boolean } {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor), start = Math.max(0, stat.size - maximumBytes);
    const buffer = Buffer.allocUnsafe(stat.size - start); fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8"); if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return { text, truncated: start > 0 };
  } finally { fs.closeSync(descriptor); }
}

export function inspectBoundedContextTelemetry(cwd: string, options: { limit?: number; maximumBytes?: number } = {}) {
  const limit = Math.max(1, Math.min(50_000, options.limit ?? 5_000));
  const maximumBytes = Math.max(64 * 1024, Math.min(256 * 1024 * 1024, options.maximumBytes ?? 32 * 1024 * 1024));
  const target = contextEnginePaths(cwd).telemetry, rows: Record<string, unknown>[] = [];
  let exists = false, corruptions = 0, recoverableTailBytes = 0, inputTruncated = false;
  for (const source of [`${target}.1`, target]) {
    const safe = resolveLocalStatePath(cwd, source, { label: "Context telemetry" });
    try {
      const stat = fs.lstatSync(safe); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Context telemetry must be a regular file");
      exists = true;
    } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    const read = tailText(safe, maximumBytes); inputTruncated ||= read.truncated;
    const complete = read.text.endsWith("\n") || read.text.endsWith("\r"), lines = read.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]; if (!line) continue;
      try { const row = JSON.parse(line); if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row); else corruptions += 1; }
      catch { if (!complete && index === lines.length - 1) recoverableTailBytes += Buffer.byteLength(line); else corruptions += 1; }
    }
  }
  return { records: rows.slice(-limit), exists, corruptions, recoverableTailBytes,
    inputTruncated: inputTruncated || rows.length > limit };
}

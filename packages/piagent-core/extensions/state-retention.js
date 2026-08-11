import fs from "node:fs";
import path from "node:path";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "./local-state-path.js";

const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 5_000;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function recoverDeadLock(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  let recoveryDescriptor;
  try {
    recoveryDescriptor = fs.openSync(recoveryPath, "wx", 0o600);
    let stat;
    let owner = null;
    try {
      stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      owner = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    } catch (error) {
      return error?.code === "ENOENT";
    }
    const validDeadOwner = Number.isInteger(owner) && owner > 0 && !processAlive(owner);
    const malformedAndStale = (!Number.isInteger(owner) || owner <= 0) && Date.now() - stat.mtimeMs > LOCK_STALE_MS;
    if (!validDeadOwner && !malformedAndStale) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    if (recoveryDescriptor !== undefined) {
      try { fs.closeSync(recoveryDescriptor); } catch {}
      fs.rmSync(recoveryPath, { force: true });
    }
  }
}

function ensurePrivateParent(filePath, projectRoot) {
  const safeFilePath = projectRoot
    ? resolveLocalStatePath(projectRoot, filePath, { label: "Local JSONL state" })
    : filePath;
  if (projectRoot) ensurePrivateStateDirectory(projectRoot, path.dirname(filePath), "Local JSONL state directory");
  else fs.mkdirSync(path.dirname(safeFilePath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(safeFilePath), 0o700);
  } catch {
    // Best effort on filesystems that do not expose POSIX modes.
  }
  return safeFilePath;
}

function withFileLock(filePath, action) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (recoverDeadLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock: ${path.basename(filePath)}`);
      }
      Atomics.wait(sleepBuffer, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function rotateJsonl(filePath, maxBytes, incomingBytes = 0) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return false;
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (size === 0 || size + incomingBytes <= maxBytes) return false;
  const previous = `${filePath}.1`;
  try {
    fs.rmSync(previous, { force: true });
    fs.renameSync(filePath, previous);
    fs.chmodSync(previous, 0o600);
    return true;
  } catch {
    return false;
  }
}

function boundedJsonLine(record, maxBytes) {
  const line = `${JSON.stringify(record)}\n`;
  const originalBytes = Buffer.byteLength(line);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || originalBytes <= maxBytes) return { line, record };
  const summary = {
    schemaVersion: Number.isInteger(record?.schemaVersion) ? record.schemaVersion : 1,
    recordedAt: typeof record?.recordedAt === "string" ? record.recordedAt : new Date().toISOString(),
    event: typeof record?.event === "string" ? record.event : "oversized_record",
    truncated: true,
    originalBytes
  };
  const summaryLine = `${JSON.stringify(summary)}\n`;
  if (Buffer.byteLength(summaryLine) > maxBytes) {
    throw new RangeError(`maxBytes ${maxBytes} is too small for a bounded JSONL record`);
  }
  return { line: summaryLine, record: summary };
}

export function appendJsonlBounded(filePath, record, options = {}) {
  const safeFilePath = ensurePrivateParent(filePath, options.projectRoot);
  const bounded = boundedJsonLine(record, options.maxBytes);
  return withFileLock(safeFilePath, () => {
    rotateJsonl(safeFilePath, options.maxBytes, Buffer.byteLength(bounded.line));
    const descriptor = fs.openSync(
      safeFilePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
      options.mode ?? 0o600
    );
    try {
      fs.writeSync(descriptor, bounded.line);
      try {
        fs.fchmodSync(descriptor, options.mode ?? 0o600);
      } catch {
        // Best effort on filesystems that do not expose POSIX modes.
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return bounded.record;
  });
}

function readTailText(filePath, maxBytes) {
  try {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(descriptor);
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(descriptor, buffer, 0, length, start);
      let text = buffer.toString("utf8");
      if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
      return text;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function readJsonlTail(filePath, options = {}) {
  const limit = Math.max(1, Number.isInteger(options.limit) ? options.limit : 100);
  const maxBytes = Math.max(64 * 1024, Number.isInteger(options.maxBytes) ? options.maxBytes : 8 * 1024 * 1024);
  const safeFilePath = options.projectRoot
    ? resolveLocalStatePath(options.projectRoot, filePath, { label: "Local JSONL state" })
    : filePath;
  const sources = options.projectRoot
    ? [
        resolveLocalStatePath(options.projectRoot, `${filePath}.1`, { label: "Rotated local JSONL state" }),
        safeFilePath
      ]
    : [`${safeFilePath}.1`, safeFilePath];
  const lines = sources.flatMap((source) => readTailText(source, maxBytes).split(/\r?\n/).filter(Boolean));
  const records = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore a partial record left by interruption or concurrent rotation.
    }
  }
  return records;
}

export function pruneCaptureFiles(root, options = {}) {
  const safeRoot = options.projectRoot
    ? resolveLocalStatePath(options.projectRoot, root, { label: "Tool-result capture root" })
    : root;
  if (!fs.existsSync(safeRoot)) return { removed: 0, kept: 0, bytes: 0 };
  if (options.projectRoot) resolveLocalStatePath(options.projectRoot, root, { label: "Tool-result capture root", kind: "directory" });
  const maxFiles = Math.max(1, Number.isInteger(options.maxFiles) ? options.maxFiles : 500);
  const maxBytes = Math.max(1024 * 1024, Number.isInteger(options.maxBytes) ? options.maxBytes : 128 * 1024 * 1024);
  const maxAgeMs = Math.max(60_000, Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 30 * 24 * 60 * 60 * 1000);
  const now = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".log")) {
        try {
          const stat = fs.statSync(absolute);
          files.push({ absolute, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
  };
  walk(safeRoot);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let kept = 0;
  let bytes = 0;
  let removed = 0;
  for (const file of files) {
    const keep = kept < maxFiles && bytes + file.size <= maxBytes && now - file.mtimeMs <= maxAgeMs;
    if (keep) {
      kept += 1;
      bytes += file.size;
      continue;
    }
    try {
      fs.rmSync(file.absolute);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { removed, kept, bytes };
}

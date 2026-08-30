import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const checkpointDigest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Local host-owned checkpoint storage, not an authentication boundary against
// the same UID. Never follow a checkpoint symlink or replace a hard-linked file.
export function checkpointDirectory(parent, relative) {
  let current = fs.realpathSync.native(parent);
  const segments = relative.split(path.sep);
  if (path.isAbsolute(relative) || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid checkpoint directory");
  }
  for (const part of segments) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Checkpoint directory must be host-owned and not symlinked");
    }
  }
  return current;
}

function validateFile(file) {
  if (fs.realpathSync.native(path.dirname(file)) !== path.dirname(file)) throw new Error("Checkpoint parent is symlinked");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Checkpoint must be a host-owned regular unlinked file");
    }
    return stat;
  } catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

export function writeCheckpointBytes(file, bytes, mode = 0o600) {
  validateFile(file);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", mode);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  // A crash before rename leaves the previous checkpoint authoritative. A
  // crash after rename exposes the complete new record, never partial JSON.
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function writeCheckpoint(file, binding, data) {
  const payload = { schemaVersion: 1, binding, data };
  writeCheckpointBytes(file, `${JSON.stringify({ ...payload, digest: checkpointDigest(payload) })}\n`);
}

export function readCheckpoint(file, binding) {
  const stat = validateFile(file);
  if (!stat) return null;
  if (stat.size > 8 * 1024 * 1024) throw new Error("Checkpoint exceeds size bound");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let value;
  try { value = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
  const { digest, ...payload } = value;
  if (payload.schemaVersion !== 1 || digest !== checkpointDigest(payload)
    || JSON.stringify(payload.binding) !== JSON.stringify(binding)) throw new Error("Checkpoint integrity or binding mismatch");
  return payload.data;
}

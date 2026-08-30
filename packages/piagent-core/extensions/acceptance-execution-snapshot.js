import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveLocalStatePath } from "./local-state-path.js";
import { workingTreeSnapshot } from "./task-state.js";
import { workingTreeObservation } from "./working-tree-digest.js";
import { runIndependentContract } from "./acceptance-independent-contract.js";

export const EXECUTION_SNAPSHOT_VERSION = "closed-module-snapshot-v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const MAX_SOURCE_BYTES = 128 * 1024;

function git(root, args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "-C", root, ...args], {
    encoding: "utf8", timeout: 3000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function repositoryHead(root) {
  if (fs.realpathSync.native(git(root, ["rev-parse", "--show-toplevel"])) !== root) throw new Error("Execution project must be the repository root");
  try {
    const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Invalid repository revision");
    return head;
  } catch (error) {
    if (error.status !== 1) throw error;
    const reference = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!reference.startsWith("refs/heads/")) throw new Error("Invalid unborn repository");
    try { git(root, ["show-ref", "--verify", "--quiet", reference]); }
    catch (missing) { if (missing.status === 1) return `unborn:${reference}`; throw missing; }
    throw new Error("Repository revision changed during snapshot");
  }
}

function sourceBytes(root, sourcePath) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error("No-follow source capture is unavailable on this platform");
  const target = resolveLocalStatePath(root, path.join(root, sourcePath), { label: "Execution source", kind: "file" });
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_SOURCE_BYTES) throw new Error("Invalid, linked, or oversized execution source");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error("Execution source short read");
      offset += read;
    }
    resolveLocalStatePath(root, target, { label: "Execution source", kind: "file" });
    const after = fs.fstatSync(descriptor), atPath = fs.lstatSync(target);
    const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
    if (atPath.isSymbolicLink() || fields.some((key) => before[key] !== after[key] || after[key] !== atPath[key])) {
      throw new Error("Execution source changed during capture");
    }
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("Execution source cannot roundtrip losslessly");
    return { source, sourceDigest: hash(bytes), sourceBytes: bytes.length, sourceMode: before.mode & 0o7777 };
  } finally { fs.closeSync(descriptor); }
}

/** Read only an explicitly host-authorized, non-symlink, closed module. */
export function captureExecutionSnapshot({ projectRoot, sourcePath, authorizeSourceRead } = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot) || typeof sourcePath !== "string"
    || sourcePath.length > 1024 || sourcePath.includes("\0") || sourcePath.includes("\\") || path.isAbsolute(sourcePath)
    || sourcePath.split("/").some((part) => !part || [".", "..", ".git", ".pi", "node_modules"].includes(part))
    || typeof authorizeSourceRead !== "function") throw new TypeError("Invalid execution snapshot request");
  const root = fs.realpathSync.native(projectRoot);
  if (authorizeSourceRead({ projectRoot: root, sourcePath }) !== true) throw new Error("Execution source read is not authorized");
  const head = repositoryHead(root);
  const captured = sourceBytes(root, sourcePath);
  const observation = workingTreeObservation(workingTreeSnapshot(root, {
    isProtectedProjectPath: (candidate) => authorizeSourceRead({ projectRoot: root, sourcePath: candidate }) !== true
  }));
  if (!observation.proofCapable || repositoryHead(root) !== head) throw new Error("Repository snapshot is incomplete or changed");
  const binding = Object.freeze({ version: EXECUTION_SNAPSHOT_VERSION, projectId: hash(root), head,
    workingTreeDigest: observation.digest, sourcePath, sourceDigest: captured.sourceDigest,
    sourceBytes: captured.sourceBytes, sourceMode: captured.sourceMode });
  return Object.freeze({ binding, snapshotDigest: hash(JSON.stringify(binding)), source: captured.source });
}

/**
 * Host-only bridge. Expected checks and backend configuration must come from
 * an approved contract adapter. No receipt or source-repair authority is minted.
 * The legacy dirty-tree digest alone cannot bind a clean checkout's HEAD or
 * ignored source bytes, so both are bound independently here.
 */
export async function runSnapshotBoundContract({ projectRoot, sourcePath, authorizeSourceRead, exportName, checks,
  imageId, dockerSocket, timeoutMs, signal, executionRunId } = {}) {
  const request = { projectRoot, sourcePath, authorizeSourceRead };
  const before = captureExecutionSnapshot(request);
  const result = await runIndependentContract({
    planText: JSON.stringify({ schemaVersion: 1, source: before.source, exportName, checks }), imageId, dockerSocket, timeoutMs, signal, executionRunId
  });
  let after;
  try { after = captureExecutionSnapshot(request); }
  catch { return Object.freeze({ verdict: "unknown", reason: "post-execution-snapshot-unavailable", before: before.binding, result }); }
  if (before.snapshotDigest !== after.snapshotDigest || result.execution.sourceDigest !== before.binding.sourceDigest) {
    return Object.freeze({ verdict: "unknown", reason: "execution-snapshot-drift", before: before.binding, after: after.binding, result });
  }
  return Object.freeze({ verdict: result.verdict, snapshotDigest: before.snapshotDigest, binding: before.binding, result });
}

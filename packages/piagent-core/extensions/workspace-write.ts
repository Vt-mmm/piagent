import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectWorkspaceEntry, readWorkspaceFile } from "../security/workspace-file-reader.ts";
import { workspacePathFlags, type WorkspacePolicy } from "./workspace-inspection.ts";

const MAX_BYTES = 1 << 20;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export class WorkspaceWriteError extends Error {
  readonly code: "invalid-write" | "path-protected" | "read-only" | "stale-content" | "unsafe-path";
  readonly currentDigest: string | null;
  constructor(code: WorkspaceWriteError["code"], currentDigest: string | null = null) {
    super(code); this.name = "WorkspaceWriteError"; this.code = code; this.currentDigest = currentDigest;
  }
}
export type WorkspaceWriteInput = { path: string; content: string; expectedDigest: string };

function fileState(root: string, relative: string): { digest: string; mode: number; stat: fs.Stats | null } {
  try {
    const stat = inspectWorkspaceEntry(root, relative);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceWriteError("unsafe-path");
    return { digest: digest(readWorkspaceFile(root, relative, MAX_BYTES)), mode: stat.mode & 0o777, stat };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { digest: "absent", mode: 0o600, stat: null };
    throw error;
  }
}

// Keep the final digest check and rename synchronous, with no queued callback
// between them. Member writes never update the agent's observed read digest.
export function writeWorkspaceFile(rootPath: string, input: WorkspaceWriteInput, policy: WorkspacePolicy) {
  if (!input || typeof input.path !== "string" || !input.path || input.path.length > 4096
    || /[\\\x00-\x1f\x7f]/.test(input.path) || path.isAbsolute(input.path)
    || input.path.split("/").some(part => !part || part === "." || part === "..")
    || typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_BYTES
    || (input.expectedDigest !== "absent" && !/^[a-f0-9]{64}$/.test(input.expectedDigest))) throw new WorkspaceWriteError("invalid-write");
  const flags = workspacePathFlags(input.path, policy);
  if (flags.protected) throw new WorkspaceWriteError("path-protected");
  if (flags.readOnly || (policy.readOnly === undefined && policy.profile.permissionProfile === "read-only")) throw new WorkspaceWriteError("read-only");
  const root = fs.realpathSync(rootPath), target = path.join(root, input.path), parent = path.dirname(target);
  const relativeParent = path.posix.dirname(input.path);
  const parentStat = relativeParent === "." ? fs.lstatSync(root) : inspectWorkspaceEntry(root, relativeParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) throw new WorkspaceWriteError("unsafe-path");
  const before = fileState(root, input.path);
  if (before.digest !== input.expectedDigest) throw new WorkspaceWriteError("stale-content", before.digest);
  const bytes = Buffer.from(input.content), nextDigest = digest(bytes);
  const temporary = path.join(parent, `.piagent-write-${process.pid}-${randomBytes(12).toString("hex")}`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(descriptor, bytes); fs.fchmodSync(descriptor, before.mode); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    const currentParent = fs.lstatSync(parent);
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino || fs.realpathSync(parent) !== parent)
      throw new WorkspaceWriteError("unsafe-path");
    const current = fileState(root, input.path);
    if (current.digest !== before.digest || current.stat?.ino !== before.stat?.ino || current.stat?.dev !== before.stat?.dev)
      throw new WorkspaceWriteError("stale-content", current.digest);
    fs.renameSync(temporary, target);
    return { path: input.path, digest: nextDigest, previousDigest: before.digest, created: before.digest === "absent", revision: `sha256:${nextDigest}` };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectWorkspaceEntry, readWorkspaceFile, WorkspaceReadError } from "../security/workspace-file-reader.ts";
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
export type WorkspaceWriteInput = { path: string; content: string; expectedDigest: string; operation?: "write" | "rename" | "delete"; destination?: string };

const validPath = (value: unknown): value is string => typeof value === "string" && !!value && value.length <= 4096
  && !/[\\\x00-\x1f\x7f]/.test(value) && !path.isAbsolute(value) && !value.split("/").some(part => !part || part === "." || part === "..");
function fileState(root: string, relative: string): { digest: string; mode: number; stat: fs.Stats | null } {
  try {
    const stat = inspectWorkspaceEntry(root, relative);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceWriteError("unsafe-path");
    return { digest: digest(readWorkspaceFile(root, relative, MAX_BYTES)), mode: stat.mode & 0o777, stat };
  } catch (error) {
    // A new file gets the mode any editor would give it, not owner-only.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { digest: "absent", mode: 0o666 & ~process.umask(), stat: null };
    throw error;
  }
}
function allowed(relative: string, policy: WorkspacePolicy) {
  const flags = workspacePathFlags(relative, policy);
  if (flags.protected) throw new WorkspaceWriteError("path-protected");
  if (flags.readOnly || (policy.readOnly === undefined && policy.profile.permissionProfile === "read-only")) throw new WorkspaceWriteError("read-only");
}
// The folder a file lives in; a new file's missing folders are made, one
// checked segment at a time, never through a link.
function folder(root: string, relative: string, create: boolean, policy: WorkspacePolicy) {
  const segments = path.posix.dirname(relative) === "." ? [] : path.posix.dirname(relative).split("/");
  for (let index = 1; index <= segments.length; index++) {
    const partial = segments.slice(0, index).join("/");
    if (create) { allowed(partial, policy); try { fs.mkdirSync(path.join(root, partial)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    const stat = inspectWorkspaceEntry(root, partial);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceWriteError("unsafe-path");
  }
  const parent = path.join(root, ...segments), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || fs.realpathSync(parent) !== parent) throw new WorkspaceWriteError("unsafe-path");
  return { parent, stat };
}
const unchanged = (parent: string, before: fs.Stats) => {
  const now = fs.lstatSync(parent);
  if (now.dev !== before.dev || now.ino !== before.ino || fs.realpathSync(parent) !== parent) throw new WorkspaceWriteError("unsafe-path");
};
// Errors that refuse before anything changed are named, so the member sees
// "refused" instead of "the result is uncertain".
function definite(error: unknown): never {
  if (error instanceof WorkspaceWriteError) throw error;
  if (error instanceof WorkspaceReadError) throw new WorkspaceWriteError(error.code === "oversized" ? "invalid-write" : error.code === "changed-during-read" ? "stale-content" : "unsafe-path");
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EEXIST") throw new WorkspaceWriteError("stale-content");
  throw error;
}

// Keep the final digest check and the rename/link synchronous, with no queued
// callback between them. Member writes never update the agent's observed read
// digest. A new file is linked into place, which fails rather than replace one
// that appeared meanwhile; rename and delete apply to a file whose content the
// member saw (its digest).
export function writeWorkspaceFile(rootPath: string, input: WorkspaceWriteInput, policy: WorkspacePolicy) {
  const operation = input?.operation ?? "write";
  if (!input || !validPath(input.path) || !["write", "rename", "delete"].includes(operation)
    || typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_BYTES
    || (input.expectedDigest !== "absent" && !/^[a-f0-9]{64}$/.test(input.expectedDigest))
    || (operation === "rename") !== (input.destination !== undefined) || operation === "rename" && (!validPath(input.destination) || input.destination === input.path)
    || operation !== "write" && (input.content !== "" || input.expectedDigest === "absent")) throw new WorkspaceWriteError("invalid-write");
  allowed(input.path, policy);
  if (operation === "rename") allowed(input.destination!, policy);
  const root = fs.realpathSync(rootPath);
  try {
    const source = folder(root, input.path, operation === "write" && input.expectedDigest === "absent", policy);
    const before = fileState(root, input.path);
    if (before.digest !== input.expectedDigest) throw new WorkspaceWriteError("stale-content", before.digest);
    const recheck = () => {
      unchanged(source.parent, source.stat);
      const current = fileState(root, input.path);
      if (current.digest !== before.digest || current.stat?.ino !== before.stat?.ino || current.stat?.dev !== before.stat?.dev)
        throw new WorkspaceWriteError("stale-content", current.digest);
    };
    if (operation === "delete") {
      recheck(); fs.unlinkSync(path.join(root, input.path));
      return { path: input.path, digest: before.digest, previousDigest: before.digest, created: false, revision: `sha256:${before.digest}` };
    }
    if (operation === "rename") {
      const target = folder(root, input.destination!, true, policy);
      if (fileState(root, input.destination!).digest !== "absent") throw new WorkspaceWriteError("stale-content");
      recheck(); unchanged(target.parent, target.stat);
      fs.linkSync(path.join(root, input.path), path.join(root, input.destination!));
      fs.unlinkSync(path.join(root, input.path));
      return { path: input.path, digest: before.digest, previousDigest: before.digest, created: false, revision: `sha256:${before.digest}` };
    }
    const bytes = Buffer.from(input.content), nextDigest = digest(bytes), target = path.join(root, input.path);
    const temporary = path.join(source.parent, `.piagent-write-${process.pid}-${randomBytes(12).toString("hex")}`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(descriptor, bytes); fs.fchmodSync(descriptor, before.mode); fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      recheck();
      if (before.digest === "absent") fs.linkSync(temporary, target); else fs.renameSync(temporary, target);
      return { path: input.path, digest: nextDigest, previousDigest: before.digest, created: before.digest === "absent", revision: `sha256:${nextDigest}` };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  } catch (error) { return definite(error); }
}

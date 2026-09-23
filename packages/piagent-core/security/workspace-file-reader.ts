import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class WorkspaceReadError extends Error {
  readonly code: "outside-root" | "symlink-ancestor" | "not-file" | "oversized" | "changed-during-read";

  constructor(code: WorkspaceReadError["code"], message: string) {
    super(message);
    this.name = "WorkspaceReadError";
    this.code = code;
  }
}

type SafeCandidate = { root: string; absolute: string; parent: string };

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeCandidate(repoRoot: string, repoPath: string): SafeCandidate {
  const root = fs.realpathSync.native(repoRoot);
  const segments = repoPath.split("/");
  if (!repoPath || path.posix.isAbsolute(repoPath) || segments.includes("..") || segments.includes("")) {
    throw new WorkspaceReadError("outside-root", "Workspace path is not a safe repository-relative path");
  }
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink()) throw new WorkspaceReadError("symlink-ancestor", "Workspace path traverses a symbolic link");
    if (!stat.isDirectory()) throw new WorkspaceReadError("not-file", "Workspace path has a non-directory ancestor");
  }
  const canonicalParent = fs.realpathSync.native(parent);
  if (!inside(root, canonicalParent)) throw new WorkspaceReadError("outside-root", "Workspace path resolves outside its repository root");
  const absolute = path.join(canonicalParent, segments.at(-1) as string);
  if (!inside(root, absolute)) throw new WorkspaceReadError("outside-root", "Workspace path escapes its repository root");
  return { root, absolute, parent: canonicalParent };
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function openRegularFile(repoRoot: string, repoPath: string): { descriptor: number; stat: fs.Stats; candidate: SafeCandidate } {
  const candidate = safeCandidate(repoRoot, repoPath);
  const descriptor = fs.openSync(candidate.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new WorkspaceReadError("not-file", "Workspace entry is not a regular file");
    const canonical = fs.realpathSync.native(candidate.absolute);
    const current = fs.lstatSync(candidate.absolute);
    if (!inside(candidate.root, canonical) || !sameFile(stat, current)) {
      throw new WorkspaceReadError("changed-during-read", "Workspace path changed while it was opened");
    }
    return { descriptor, stat, candidate };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function verifyAfterRead(descriptor: number, before: fs.Stats, candidate: SafeCandidate): void {
  const after = fs.fstatSync(descriptor);
  const current = fs.lstatSync(candidate.absolute);
  const canonical = fs.realpathSync.native(candidate.absolute);
  if (
    !sameFile(before, after)
    || !sameFile(after, current)
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || !inside(candidate.root, canonical)
  ) {
    throw new WorkspaceReadError("changed-during-read", "Workspace file changed during inspection");
  }
}

export function inspectWorkspaceEntry(repoRoot: string, repoPath: string): fs.Stats {
  const candidate = safeCandidate(repoRoot, repoPath);
  return fs.lstatSync(candidate.absolute);
}

export function readWorkspaceLink(repoRoot: string, repoPath: string): string {
  const candidate = safeCandidate(repoRoot, repoPath);
  const before = fs.lstatSync(candidate.absolute);
  if (!before.isSymbolicLink()) throw new WorkspaceReadError("not-file", "Workspace entry is not a symbolic link");
  const target = fs.readlinkSync(candidate.absolute);
  const after = fs.lstatSync(candidate.absolute);
  if (!sameFile(before, after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new WorkspaceReadError("changed-during-read", "Workspace link changed during inspection");
  }
  return target;
}

export function readWorkspaceFile(repoRoot: string, repoPath: string, maxBytes: number): Buffer {
  const opened = openRegularFile(repoRoot, repoPath);
  try {
    if (opened.stat.size > maxBytes) throw new WorkspaceReadError("oversized", "Workspace file exceeds its read cap");
    const content = Buffer.allocUnsafe(opened.stat.size);
    let position = 0;
    while (position < content.length) {
      const count = fs.readSync(opened.descriptor, content, position, content.length - position, position);
      if (count <= 0) throw new WorkspaceReadError("changed-during-read", "Workspace file ended during inspection");
      position += count;
    }
    verifyAfterRead(opened.descriptor, opened.stat, opened.candidate);
    return content;
  } finally {
    fs.closeSync(opened.descriptor);
  }
}

export function hashWorkspaceFile(repoRoot: string, repoPath: string): string {
  const opened = openRegularFile(repoRoot, repoPath);
  try {
    const state = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < opened.stat.size) {
      const count = fs.readSync(opened.descriptor, buffer, 0, Math.min(buffer.length, opened.stat.size - position), position);
      if (count <= 0) throw new WorkspaceReadError("changed-during-read", "Workspace file ended during hashing");
      state.update(buffer.subarray(0, count));
      position += count;
    }
    verifyAfterRead(opened.descriptor, opened.stat, opened.candidate);
    return state.digest("hex");
  } finally {
    fs.closeSync(opened.descriptor);
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
// Keep exact parity with model-mutation-proof.ts so every successful write can
// retain content-digest provenance instead of degrading to inferred authorship.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSACTION_PREIMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_HUNKS = 1_000;
const MAX_MATCH_LINE_COMPARISONS = 5_000_000;

type PatchOperation = {
  kind: "add" | "update";
  repoPath: string;
  section: string[];
};

type UpdateHunk = {
  oldLines: string[];
  newLines: string[];
};
type PatchWorkBudget = { matchLineComparisons: number };
type FileVersion = {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
};
type PlannedWrite = PatchOperation & {
  absolute: string;
  bytes: Buffer;
  before?: FileVersion;
  beforeBytes?: Buffer;
  temporary?: string;
  backup?: string;
  committed?: boolean;
};
export class ApplyPatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApplyPatchError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ApplyPatchError(code, message);
}

function digest(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeRepoPath(candidate: string): string {
  const value = candidate.trim();
  const segments = value.split("/");
  if (
    !value || value.length > 1_024 || /[\x00-\x1f\x7f]/.test(value) || value.includes("\\") || value.includes("%")
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value
  ) fail("unsafe-path", "Patch targets must be normalized project-relative paths without percent escapes");
  return value;
}

function parsePatch(patch: string): PatchOperation[] {
  if (typeof patch !== "string" || !patch || Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    fail("invalid-patch", `Patch must contain between 1 and ${MAX_PATCH_BYTES} UTF-8 bytes`);
  }
  if (patch.includes("\0")) {
    fail("invalid-patch", "Patch contains unsupported control or line-ending bytes");
  }
  let normalized = patch.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) fail("invalid-patch", "Patch contains unsupported control or line-ending bytes");
  if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1);
  const lines = normalized.split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    fail("invalid-patch", "Patch must have exact Begin Patch and End Patch delimiters");
  }

  const operations: PatchOperation[] = [];
  const targets = new Set<string>();
  for (let index = 1; index < lines.length - 1;) {
    const marker = lines[index].match(/^\*\*\* (Add|Update) File:\s*(.+?)\s*$/);
    if (!marker) fail("invalid-patch", `Unsupported or malformed patch marker at line ${index + 1}`);
    const repoPath = normalizeRepoPath(marker[2]);
    if (targets.has(repoPath)) fail("duplicate-target", `Patch target appears more than once: ${repoPath}`);
    if ([...targets].some((target) => repoPath.startsWith(`${target}/`) || target.startsWith(`${repoPath}/`))) {
      fail("overlapping-target", `Patch file targets cannot contain one another: ${repoPath}`);
    }
    targets.add(repoPath);
    index += 1;
    const section: string[] = [];
    while (index < lines.length - 1 && !lines[index].startsWith("*** ")) section.push(lines[index++]);
    if (section.length === 0) fail("invalid-patch", `Patch section is empty: ${repoPath}`);
    operations.push({ kind: marker[1] === "Add" ? "add" : "update", repoPath, section });
    if (operations.length > MAX_FILES) fail("too-many-files", `Patch exceeds the ${MAX_FILES}-file limit`);
  }
  if (operations.length === 0) fail("invalid-patch", "Patch contains no Add File or Update File section");
  let totalHunks = 0;
  for (const operation of operations) {
    if (operation.kind === "add") { addContent(operation.section, operation.repoPath); continue; }
    totalHunks += parseUpdateHunks(operation.section, operation.repoPath).length;
    if (totalHunks > MAX_HUNKS) fail("too-many-hunks", `Patch exceeds the global ${MAX_HUNKS}-hunk limit`);
  }
  return operations;
}

export function parseApplyPatchTargets(patch: string): string[] {
  return parsePatch(patch).map((operation) => operation.repoPath);
}

function exactMatchOffsets(lines: string[], expected: string[], work: PatchWorkBudget): number[] {
  const matches: number[] = [];
  for (let at = 0; at + expected.length <= lines.length; at += 1) {
    let matched = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (++work.matchLineComparisons > MAX_MATCH_LINE_COMPARISONS) {
        fail("work-limit", `Patch exact-match scanning exceeds ${MAX_MATCH_LINE_COMPARISONS} line comparisons`);
      }
      if (lines[at + offset] !== expected[offset]) { matched = false; break; }
    }
    if (matched) matches.push(at);
  }
  return matches;
}

function parseUpdateHunks(section: string[], repoPath: string): UpdateHunk[] {
  const hunks: UpdateHunk[] = [];
  let hunkCount = 0;
  for (let index = 0; index < section.length;) {
    if (!/^@@(?:\s.*)?$/.test(section[index]) || section[index].startsWith("@@@")) {
      fail("malformed-hunk", `Update section must start each hunk with @@: ${repoPath}`);
    }
    hunkCount += 1;
    if (hunkCount > MAX_HUNKS) fail("too-many-hunks", `Patch exceeds the ${MAX_HUNKS}-hunk limit`);
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let changed = false;
    let bodyLines = 0;
    while (index < section.length && !section[index].startsWith("@@")) {
      const line = section[index++];
      if (!line || ![" ", "+", "-"].includes(line[0]) || line.startsWith("\\ No newline")) {
        fail("malformed-hunk", `Hunk contains an unprefixed or unsupported line: ${repoPath}`);
      }
      bodyLines += 1;
      if (line[0] !== "+") oldLines.push(line.slice(1));
      if (line[0] !== "-") newLines.push(line.slice(1));
      if (line[0] === "+" || line[0] === "-") changed = true;
    }
    if (!bodyLines || !changed || oldLines.length === 0) {
      fail("malformed-hunk", `Hunk must contain a change with stable old-side context: ${repoPath}`);
    }
    hunks.push({ oldLines, newLines });
  }
  if (!hunkCount) fail("malformed-hunk", `Update contains no hunks: ${repoPath}`);
  return hunks;
}

function applyUpdateHunks(content: string, section: string[], repoPath: string, work: PatchWorkBudget): string {
  const projected = content.split("\n");
  const hunks = parseUpdateHunks(section, repoPath);
  for (const { oldLines, newLines } of hunks) {
    const matches = exactMatchOffsets(projected, oldLines, work);
    if (matches.length !== 1) {
      fail("ambiguous-hunk", `Hunk precondition matched ${matches.length} locations in ${repoPath}; add exact context`);
    }
    projected.splice(matches[0], oldLines.length, ...newLines);
  }
  const result = projected.join("\n");
  if (result === content) fail("malformed-hunk", `Update does not change ${repoPath}`);
  return result;
}

function addContent(section: string[], repoPath: string): string {
  if (section.some((line) => !line.startsWith("+"))) {
    fail("malformed-add", `Every Add File line must start with +: ${repoPath}`);
  }
  return `${section.map((line) => line.slice(1)).join("\n")}\n`;
}

function safeTarget(root: string, repoPath: string): { absolute: string; missingParents: string[] } {
  const segments = repoPath.split("/");
  let cursor = root;
  const missingParents: string[] = [];
  let missing = false;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    if (!inside(root, cursor)) fail("unsafe-path", `Patch target escapes the project: ${repoPath}`);
    if (missing) {
      missingParents.push(cursor);
      continue;
    }
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) fail("symlink-path", `Patch target traverses a symbolic link: ${repoPath}`);
      if (!stat.isDirectory()) fail("unsafe-path", `Patch target has a non-directory ancestor: ${repoPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
      missingParents.push(cursor);
    }
  }
  const absolute = path.join(root, ...segments);
  if (!inside(root, absolute)) fail("unsafe-path", `Patch target escapes the project: ${repoPath}`);
  return { absolute, missingParents };
}

function sameVersion(left: FileVersion, right: FileVersion): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.digest === right.digest;
}

function sameLinkedPreimage(left: FileVersion, right: FileVersion): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.digest === right.digest;
}

function readStableFile(absolute: string, repoPath: string): { bytes: Buffer; version: FileVersion } {
  let descriptor: number | undefined;
  try {
    const initial = fs.lstatSync(absolute);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_FILE_BYTES) {
      fail("unsafe-target", `Update target must be a bounded regular file: ${repoPath}`);
    }
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size) {
      fail("stale-precondition", `Update target changed while it was opened: ${repoPath}`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("stale-precondition", `Update target changed while it was read: ${repoPath}`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(absolute);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.dev !== after.dev || current.ino !== after.ino || current.isSymbolicLink()) {
      fail("stale-precondition", `Update target changed during validation: ${repoPath}`);
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail("binary-file", `Update target is not valid UTF-8 text: ${repoPath}`);
    return { bytes, version: { dev: after.dev, ino: after.ino, mode: after.mode, size: after.size,
      mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, digest: digest(bytes) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("missing-target", `Update target does not exist: ${repoPath}`);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function targetAbsent(absolute: string, repoPath: string): void {
  try {
    fs.lstatSync(absolute);
    fail("existing-target", `Add target already exists: ${repoPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function planPatch(cwd: string, patch: string): { root: string; writes: PlannedWrite[]; missingParents: string[] } {
  const root = fs.realpathSync.native(cwd);
  if (!fs.lstatSync(root).isDirectory()) fail("unsafe-root", "Patch project root must be a directory");
  const missingParents = new Set<string>();
  const work: PatchWorkBudget = { matchLineComparisons: 0 };
  let preimageBytes = 0;
  const writes = parsePatch(patch).map((operation): PlannedWrite => {
    const target = safeTarget(root, operation.repoPath);
    target.missingParents.forEach((item) => missingParents.add(item));
    if (operation.kind === "add") {
      targetAbsent(target.absolute, operation.repoPath);
      const bytes = Buffer.from(addContent(operation.section, operation.repoPath), "utf8");
      if (bytes.length > MAX_FILE_BYTES) fail("oversized-file", `Added file exceeds ${MAX_FILE_BYTES} bytes: ${operation.repoPath}`);
      return { ...operation, absolute: target.absolute, bytes };
    }
    if (target.missingParents.length) fail("missing-target", `Update target does not exist: ${operation.repoPath}`);
    const before = readStableFile(target.absolute, operation.repoPath);
    preimageBytes += before.bytes.length;
    if (preimageBytes > MAX_TRANSACTION_PREIMAGE_BYTES) {
      fail("oversized-transaction", `Patch update preimages exceed ${MAX_TRANSACTION_PREIMAGE_BYTES} bytes`);
    }
    const bytes = Buffer.from(applyUpdateHunks(before.bytes.toString("utf8"), operation.section, operation.repoPath, work), "utf8");
    if (bytes.length > MAX_FILE_BYTES) fail("oversized-file", `Updated file exceeds ${MAX_FILE_BYTES} bytes: ${operation.repoPath}`);
    return { ...operation, absolute: target.absolute, bytes, before: before.version, beforeBytes: before.bytes };
  });
  return { root, writes, missingParents: [...missingParents].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length) };
}

function revalidate(plan: ReturnType<typeof planPatch>): void {
  for (const write of plan.writes) {
    safeTarget(plan.root, write.repoPath);
    if (write.kind === "add") targetAbsent(write.absolute, write.repoPath);
    else if (!write.before || !sameVersion(write.before, readStableFile(write.absolute, write.repoPath).version)) {
      fail("stale-precondition", `Update target changed before commit: ${write.repoPath}`);
    }
  }
}

function temporaryName(absolute: string, role: "stage" | "backup"): string {
  return path.join(path.dirname(absolute), `.${path.basename(absolute)}.piagent-${role}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
}

function clean(plan: ReturnType<typeof planPatch>, created: string[], preserveRecoveryBackups = false): void {
  for (const write of plan.writes) {
    if (write.temporary) try { fs.rmSync(write.temporary, { force: true }); } catch {}
    if (write.backup && !(preserveRecoveryBackups && write.committed)) try { fs.rmSync(write.backup, { force: true }); } catch {}
  }
  for (const directory of [...created].reverse()) try { fs.rmdirSync(directory); } catch {}
}

function ensureRollbackRecoveryBackup(plan: ReturnType<typeof planPatch>, write: PlannedWrite): void {
  if (write.backup) return;
  if (!write.before || !write.beforeBytes) throw new Error("missing rollback preimage");
  safeTarget(plan.root, write.repoPath);
  const backup = temporaryName(write.absolute, "backup");
  const descriptor = fs.openSync(backup, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(descriptor, write.beforeBytes); fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, write.before.mode & 0o777); write.backup = backup;
  } catch (error) {
    try { fs.rmSync(backup, { force: true }); } catch {} throw error;
  } finally { fs.closeSync(descriptor); }
}

function requireExpectedRollbackPostimage(plan: ReturnType<typeof planPatch>, write: PlannedWrite): void {
  try {
    safeTarget(plan.root, write.repoPath);
    if (readStableFile(write.absolute, write.repoPath).version.digest !== digest(write.bytes)) throw new Error("postimage changed");
  } catch (error) { ensureRollbackRecoveryBackup(plan, write); throw error; }
}

function rollback(plan: ReturnType<typeof planPatch>): string[] {
  const failed: string[] = [];
  for (const write of [...plan.writes].reverse()) {
    if (!write.committed) continue;
    try {
      if (write.kind === "update") {
        requireExpectedRollbackPostimage(plan, write);
        let restored = false;
        if (write.backup) {
          try {
            fs.renameSync(write.backup, write.absolute);
            write.backup = undefined;
            restored = true;
          } catch {}
        }
        if (!restored) {
          if (!write.before || !write.beforeBytes) throw new Error("missing rollback preimage");
          const temporary = temporaryName(write.absolute, "stage");
          const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
          try {
            fs.writeFileSync(descriptor, write.beforeBytes);
            fs.fsyncSync(descriptor);
            fs.fchmodSync(descriptor, write.before.mode & 0o777);
          } finally { fs.closeSync(descriptor); }
          try { fs.renameSync(temporary, write.absolute); }
          finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
        }
        const observed = readStableFile(write.absolute, write.repoPath);
        if (!write.before || observed.version.digest !== write.before.digest) throw new Error("rollback postcondition failed");
      } else {
        const current = readStableFile(write.absolute, write.repoPath);
        if (current.version.digest !== digest(write.bytes)) throw new Error("postimage changed");
        fs.unlinkSync(write.absolute);
      }
      write.committed = false;
    } catch {
      failed.push(write.repoPath);
    }
  }
  return failed;
}

export function applyValidatedPatch(cwd: string, patch: string, signal?: AbortSignal): { added: string[]; updated: string[] } {
  const plan = planPatch(cwd, patch);
  const created: string[] = [];
  let rollbackIncomplete = false;
  try {
    if (signal?.aborted) fail("cancelled", "Patch was cancelled before commit");
    for (const directory of plan.missingParents) {
      try { fs.mkdirSync(directory, { mode: 0o755 }); created.push(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("symlink-path", "Patch parent changed before commit");
      }
    }
    revalidate(plan);
    for (const write of plan.writes) {
      write.temporary = temporaryName(write.absolute, "stage");
      const descriptor = fs.openSync(write.temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        fs.writeFileSync(descriptor, write.bytes);
        fs.fsyncSync(descriptor);
        fs.fchmodSync(descriptor, write.kind === "update" ? (write.before!.mode & 0o777) : 0o644);
      } finally { fs.closeSync(descriptor); }
    }
    revalidate(plan);
    for (const write of plan.writes.filter((item) => item.kind === "update")) {
      write.backup = temporaryName(write.absolute, "backup");
      fs.linkSync(write.absolute, write.backup);
      const backup = readStableFile(write.backup, write.repoPath);
      if (!write.before || !sameLinkedPreimage(write.before, backup.version)) fail("stale-precondition", `Update target changed before commit: ${write.repoPath}`);
      write.before = backup.version;
    }
    revalidate(plan);
    if (signal?.aborted) fail("cancelled", "Patch was cancelled before commit");

    for (const write of plan.writes) {
      if (write.kind === "update") {
        if (!write.before || !sameVersion(write.before, readStableFile(write.absolute, write.repoPath).version)) {
          fail("stale-precondition", `Update target changed at commit: ${write.repoPath}`);
        }
        fs.renameSync(write.temporary!, write.absolute);
        write.temporary = undefined;
        write.committed = true;
      } else {
        fs.linkSync(write.temporary!, write.absolute);
        // From this point the destination exists. Mark it before cleanup so an
        // unlink failure still enters rollback and cannot leave a partial add.
        write.committed = true;
        fs.unlinkSync(write.temporary!);
        write.temporary = undefined;
      }
      const observed = readStableFile(write.absolute, write.repoPath);
      if (observed.version.digest !== digest(write.bytes)) fail("postcondition", `Patch postcondition failed: ${write.repoPath}`);
    }
    // Cleanup is part of transaction success. Retained in-memory preimages let
    // rollback restore earlier updates even if a later backup unlink fails.
    for (const write of plan.writes) {
      if (!write.backup) continue;
      fs.unlinkSync(write.backup);
      try {
        fs.lstatSync(write.backup);
        fail("cleanup-postcondition", `Patch backup cleanup did not remove ${write.repoPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      write.backup = undefined;
    }
    return {
      added: plan.writes.filter((item) => item.kind === "add").map((item) => item.repoPath),
      updated: plan.writes.filter((item) => item.kind === "update").map((item) => item.repoPath)
    };
  } catch (error) {
    const rollbackFailures = rollback(plan);
    if (rollbackFailures.length) {
      rollbackIncomplete = true;
      throw new ApplyPatchError("rollback-incomplete", `Patch failed and rollback could not restore: ${rollbackFailures.join(", ")}`);
    }
    throw error;
  } finally {
    clean(plan, created, rollbackIncomplete);
  }
}

export function registerApplyPatchTool(
  pi: ExtensionAPI,
  Type: Record<string, (...args: any[]) => any>
): void {
  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply one validated OpenAI-style patch across multiple project files in a single guarded tool call.",
    promptSnippet: "Use apply_patch for bounded multi-file Add File and Update File changes when exact old context is available.",
    promptGuidelines: [
      "Wrap the patch in exact *** Begin Patch and *** End Patch delimiters.",
      "Use each project-relative target once and include enough unchanged context for every update hunk to match exactly once."
    ],
    parameters: Type.Object({ patch: Type.String({ minLength: 1, maxLength: MAX_PATCH_BYTES }) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId: string, params: { patch: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const result = applyValidatedPatch(ctx.cwd, params.patch, signal);
      const changedPaths = [...result.updated, ...result.added];
      return {
        content: [{ type: "text", text: `Applied validated patch to ${changedPaths.length} file${changedPaths.length === 1 ? "" : "s"}: ${changedPaths.join(", ")}` }],
        details: { changedPaths, updatedPaths: result.updated, addedPaths: result.added }
      };
    }
  } as any);
}

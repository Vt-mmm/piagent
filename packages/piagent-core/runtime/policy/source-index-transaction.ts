import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runReadOnlyGit } from "../inspection/git-status-adapter.ts";
import {
  collectIndexPreimage,
  collectSelectedWorkspacePreimage,
  type SourceMutationAuthority
} from "../inspection/source-mutation-projection.ts";
import { localFilterDisableArgs } from "../inspection/git-filter-safety.ts";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;

export type SourceIndexTransactionResult = {
  state: "settled" | "rejected" | "uncertain";
  reasonCode: string | null;
  beforeIndexPreimage: string;
  afterIndexPreimage: string | null;
  beforeWorkspacePreimage: string;
  afterWorkspacePreimage: string | null;
  executor: "pi-guard";
  directExecution: false;
};

function result(value: Omit<SourceIndexTransactionResult, "executor" | "directExecution">): SourceIndexTransactionResult {
  return { ...value, executor: "pi-guard", directExecution: false };
}

function gitEnvironment(indexFile: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
    GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_INDEX_FILE: indexFile,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) };
}

async function runGitMutation(repoRoot: string, indexFile: string, args: string[], timeoutMs: number, input?: Buffer): Promise<Buffer> {
  const filterArgs = await localFilterDisableArgs(repoRoot, timeoutMs);
  const argv = ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-c", "core.fsmonitor=false", `-c`, `core.hooksPath=${os.devNull}`,
    "-c", "diff.external=", "-c", "submodule.recurse=false", "-C", repoRoot, ...args];
  argv.splice(argv.indexOf("-C"), 0, ...filterArgs);
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", argv, { cwd: repoRoot, env: gitEnvironment(indexFile), shell: false, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, settled = false;
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes <= 64 * 1024) stdout.push(chunk); else child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) child.kill("SIGKILL"); });
    if (input) { child.stdin.on("error", () => undefined); child.stdin.end(input); }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); timer.unref?.();
    child.once("error", () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error("git-mutation-start-failed")); } });
    child.once("close", (code) => { clearTimeout(timer); if (settled) return; settled = true;
      if (code === 0 && stdoutBytes <= 64 * 1024 && stderrBytes <= 64 * 1024) resolve(Buffer.concat(stdout)); else reject(new Error("git-mutation-failed")); });
  });
}

async function stageExactPaths(repoRoot: string, indexFile: string, repoPaths: string[], timeoutMs: number, objectLengthHint: number): Promise<void> {
  const entries: Array<{ mode: string; object: string | null; repoPath: string }> = [];
  let objectLength: 40 | 64 | null = null;
  for (const repoPath of repoPaths) {
    const absolute = path.resolve(repoRoot, repoPath);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsupported-workspace-entry");
      const object = (await runGitMutation(repoRoot, indexFile, ["hash-object", "-w", "--no-filters", "--", repoPath], timeoutMs)).toString("ascii").trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)) throw new Error("git-object-id-invalid");
      objectLength = object.length as 40 | 64;
      const mode = stat.mode & 0o111 ? "100755" : "100644";
      entries.push({ mode, object, repoPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.push({ mode: "0", object: null, repoPath });
    }
  }
  const length = objectLength ?? (objectLengthHint === 64 ? 64 : 40);
  const input = Buffer.concat(entries.map((entry) => Buffer.from(`${entry.mode} ${entry.object ?? "0".repeat(length)}\t${entry.repoPath}\0`)));
  await runGitMutation(repoRoot, indexFile, ["update-index", "-z", "--index-info"], timeoutMs, input);
}

async function applySelectedHunks(authority: SourceMutationAuthority, indexFile: string, selectedHunkRefs: string[], timeoutMs: number): Promise<void> {
  const patch = authority.patchAuthority;
  if (!patch || selectedHunkRefs.length === 0 || selectedHunkRefs.length > 128) throw new Error("hunk-patch-unavailable");
  const selected = new Set(selectedHunkRefs), blocks = patch.hunks.filter((hunk) => selected.has(hunk.hunkRef));
  if (blocks.length !== selected.size) throw new Error("hunk-patch-stale");
  const bytes = Buffer.concat([patch.header, ...blocks.map((hunk) => hunk.bytes)]);
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new Error("hunk-patch-oversized");
  await runGitMutation(authority.repoRoot, indexFile, ["apply", "--cached", "--recount", "--whitespace=nowarn",
    ...(authority.target.view === "staged" ? ["--reverse"] : []), "-"], timeoutMs, bytes);
}

async function gitDirectory(repoRoot: string): Promise<string> {
  const output = await runReadOnlyGit(repoRoot, ["rev-parse", "--absolute-git-dir"], { maxBytes: 16 * 1024 });
  const candidate = output.toString("utf8").trim();
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) throw new Error("git-directory-invalid");
  const resolved = fs.realpathSync.native(candidate), stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("git-directory-invalid");
  return resolved;
}

function copyIndex(indexPath: string, temporary: string): void {
  try {
    const stat = fs.lstatSync(indexPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEX_BYTES) throw new Error("git-index-invalid");
    fs.copyFileSync(indexPath, temporary, fs.constants.COPYFILE_EXCL); fs.chmodSync(temporary, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function publishIndex(lockDescriptor: number, lockPath: string, temporary: string, indexPath: string): void {
  const stat = fs.lstatSync(temporary);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEX_BYTES) throw new Error("temporary-index-invalid");
  const bytes = fs.readFileSync(temporary); fs.ftruncateSync(lockDescriptor, 0);
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(lockDescriptor, bytes, offset, bytes.length - offset, offset);
  fs.fsyncSync(lockDescriptor); fs.fchmodSync(lockDescriptor, 0o600); fs.closeSync(lockDescriptor); fs.renameSync(lockPath, indexPath);
  try { const directory = fs.openSync(path.dirname(indexPath), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch {}
}

export async function executeGuardedSourceIndexTransaction(options: {
  authority: SourceMutationAuthority;
  expectedIndexPreimage: string;
  expectedWorkspacePreimage: string;
  selectedHunkRefs?: string[];
  recheck: () => boolean;
  timeoutMs?: number;
}): Promise<SourceIndexTransactionResult> {
  const before = { beforeIndexPreimage: options.expectedIndexPreimage, beforeWorkspacePreimage: options.expectedWorkspacePreimage };
  let directory: string;
  try { directory = await gitDirectory(options.authority.repoRoot); }
  catch { return result({ state: "rejected", reasonCode: "git-directory-unavailable", ...before, afterIndexPreimage: null, afterWorkspacePreimage: null }); }
  const indexPath = path.join(directory, "index"), lockPath = path.join(directory, "index.lock");
  const temporary = path.join(directory, `piagent-guard-index.${process.pid}.${randomBytes(12).toString("hex")}`);
  let lockDescriptor: number | null = null, ownsLock = false, committed = false;
  try {
    lockDescriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    ownsLock = true;
    const lockedIndex = await collectIndexPreimage(options.authority.repoRoot);
    const lockedWorkspace = collectSelectedWorkspacePreimage(options.authority.repoRoot, options.authority.repoPaths);
    if (!options.recheck() || lockedIndex !== options.expectedIndexPreimage || lockedWorkspace !== options.expectedWorkspacePreimage) {
      return result({ state: "rejected", reasonCode: "mutation-preimage-stale", ...before,
        afterIndexPreimage: lockedIndex, afterWorkspacePreimage: lockedWorkspace });
    }
    copyIndex(indexPath, temporary);
    const timeoutMs = Math.max(100, Math.min(60_000, options.timeoutMs ?? 5_000));
    if ((options.selectedHunkRefs?.length ?? 0) > 0) await applySelectedHunks(options.authority, temporary, options.selectedHunkRefs!, timeoutMs);
    else if (options.authority.target.view === "working-tree") await stageExactPaths(options.authority.repoRoot, temporary,
      options.authority.repoPaths, timeoutMs, options.authority.headOid?.length ?? 40);
    else if (options.authority.headOid) await runGitMutation(options.authority.repoRoot, temporary,
      ["restore", "--staged", "--source=HEAD", "--", ...options.authority.repoPaths], timeoutMs);
    else await runGitMutation(options.authority.repoRoot, temporary,
      ["rm", "--cached", "-f", "--ignore-unmatch", "--", ...options.authority.repoPaths], timeoutMs);
    const finalWorkspace = collectSelectedWorkspacePreimage(options.authority.repoRoot, options.authority.repoPaths);
    const finalRealIndex = await collectIndexPreimage(options.authority.repoRoot);
    if (!options.recheck() || finalWorkspace !== options.expectedWorkspacePreimage || finalRealIndex !== options.expectedIndexPreimage) {
      return result({ state: "rejected", reasonCode: "mutation-preimage-stale", ...before,
        afterIndexPreimage: finalRealIndex, afterWorkspacePreimage: finalWorkspace });
    }
    publishIndex(lockDescriptor, lockPath, temporary, indexPath); lockDescriptor = null; ownsLock = false; committed = true;
    const afterIndexPreimage = await collectIndexPreimage(options.authority.repoRoot);
    const afterWorkspacePreimage = collectSelectedWorkspacePreimage(options.authority.repoRoot, options.authority.repoPaths);
    if (afterWorkspacePreimage !== options.expectedWorkspacePreimage || afterIndexPreimage === options.expectedIndexPreimage) {
      return result({ state: "uncertain", reasonCode: "mutation-postcondition-unknown", ...before, afterIndexPreimage, afterWorkspacePreimage });
    }
    return result({ state: "settled", reasonCode: null, ...before, afterIndexPreimage, afterWorkspacePreimage });
  } catch (error) {
    const reasonCode = (error as NodeJS.ErrnoException).code === "EEXIST" ? "git-index-locked" : committed ? "mutation-postcondition-unknown" : "git-mutation-failed";
    return result({ state: committed ? "uncertain" : "rejected", reasonCode, ...before, afterIndexPreimage: null, afterWorkspacePreimage: null });
  } finally {
    if (lockDescriptor !== null) try { fs.closeSync(lockDescriptor); } catch {}
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (ownsLock) try { fs.rmSync(lockPath, { force: true }); } catch {}
  }
}

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectExactGitPatchAuthority } from "../inspection/diff-projection.ts";
import { collectGitStatusForPaths, runReadOnlyGit } from "../inspection/git-status-adapter.ts";
import { localFilterDisableArgs } from "../inspection/git-filter-safety.ts";
import { collectIndexPreimage, collectSelectedWorkspacePreimage } from "../inspection/source-mutation-projection.ts";
import type { SourceRevertAuthority } from "../inspection/source-revert-projection.ts";
import type { SourceIndexTransactionResult } from "./source-index-transaction.ts";

function result(value: Omit<SourceIndexTransactionResult, "executor" | "directExecution">): SourceIndexTransactionResult {
  return { ...value, executor: "pi-guard", directExecution: false };
}
function environment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
    GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) };
}
async function runGit(repoRoot: string, args: string[], input: Buffer, timeoutMs: number): Promise<void> {
  const filterArgs = await localFilterDisableArgs(repoRoot, timeoutMs);
  const argv = ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`,
    "-c", "diff.external=", "-c", "submodule.recurse=false", ...filterArgs, "-C", repoRoot, ...args];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", argv, { cwd: repoRoot, env: environment(), shell: false, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = 0, settled = false; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.length; if (stderr > 64 * 1024) child.kill("SIGKILL"); });
    child.stdin.on("error", () => undefined); child.stdin.end(input);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); timer.unref?.();
    child.once("error", () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error("git-revert-start-failed")); } });
    child.once("close", (code) => { clearTimeout(timer); if (settled) return; settled = true;
      if (code === 0 && stderr <= 64 * 1024) resolve(); else reject(new Error("git-revert-failed")); });
  });
}
async function gitDirectory(repoRoot: string): Promise<string> {
  const candidate = (await runReadOnlyGit(repoRoot, ["rev-parse", "--absolute-git-dir"], { maxBytes: 16 * 1024 })).toString("utf8").trim();
  const resolved = fs.realpathSync.native(candidate), stat = fs.lstatSync(resolved);
  if (!path.isAbsolute(candidate) || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("git-directory-invalid");
  return resolved;
}
async function restoreWholeFile(authority: SourceRevertAuthority, recheck: () => Promise<boolean>): Promise<void> {
  const bytes = await runReadOnlyGit(authority.repoRoot, ["cat-file", "blob", authority.indexObject], { maxBytes: 16 * 1024 * 1024 });
  const target = path.resolve(authority.repoRoot, authority.repoPath), parent = fs.realpathSync.native(path.dirname(target));
  if (parent !== path.dirname(target) || !target.startsWith(`${authority.repoRoot}${path.sep}`)) throw new Error("revert-target-unsafe");
  const current = fs.lstatSync(target); if (!current.isFile() || current.isSymbolicLink()) throw new Error("revert-target-unsafe");
  const temporary = path.join(parent, `.${path.basename(target)}.piagent-revert.${process.pid}.${randomBytes(8).toString("hex")}`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, authority.indexMode === "100755" ? 0o755 : 0o644); }
  finally { fs.closeSync(descriptor); }
  try { if (!await recheck()) throw new Error("revert-preimage-stale"); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
  const actual = fs.readFileSync(target); if (!actual.equals(bytes)) throw new Error("revert-postcondition-failed");
}
async function restoreSelectedHunk(authority: SourceRevertAuthority, hunkRef: string, timeoutMs: number): Promise<void> {
  const block = authority.patchAuthority.hunks.find((hunk) => hunk.hunkRef === hunkRef);
  if (!block) throw new Error("revert-hunk-stale");
  const patch = Buffer.concat([authority.patchAuthority.header, block.bytes]);
  if (patch.length > 2 * 1024 * 1024) throw new Error("revert-patch-oversized");
  await runGit(authority.repoRoot, ["apply", "--reverse", "--recount", "--whitespace=nowarn", "-"], patch, timeoutMs);
}

export async function executeGuardedSourceWorktreeRevert(options: { authority: SourceRevertAuthority; expectedIndexPreimage: string;
  expectedWorkspacePreimage: string; recheck(): boolean; timeoutMs?: number }): Promise<SourceIndexTransactionResult> {
  const before = { beforeIndexPreimage: options.expectedIndexPreimage, beforeWorkspacePreimage: options.expectedWorkspacePreimage };
  let lockPath = "", ownsLock = false, committed = false;
  try {
    const gitDir = await gitDirectory(options.authority.repoRoot), lockName = createHash("sha256").update(options.authority.repoPath).digest("hex");
    lockPath = path.join(gitDir, `piagent-webui-worktree-${lockName}.lock`);
    const descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.closeSync(descriptor); ownsLock = true;
    const lockedIndex = await collectIndexPreimage(options.authority.repoRoot);
    const lockedWorkspace = collectSelectedWorkspacePreimage(options.authority.repoRoot, [options.authority.repoPath]);
    if (!options.recheck() || lockedIndex !== options.expectedIndexPreimage || lockedWorkspace !== options.expectedWorkspacePreimage)
      return result({ state: "rejected", reasonCode: "mutation-preimage-stale", ...before,
        afterIndexPreimage: lockedIndex, afterWorkspacePreimage: lockedWorkspace });
    const finalRecheck = async () => options.recheck()
      && await collectIndexPreimage(options.authority.repoRoot) === options.expectedIndexPreimage
      && collectSelectedWorkspacePreimage(options.authority.repoRoot, [options.authority.repoPath]) === options.expectedWorkspacePreimage;
    if (options.authority.target.hunkRefs.length) {
      if (!await finalRecheck()) return result({ state: "rejected", reasonCode: "mutation-preimage-stale", ...before,
        afterIndexPreimage: null, afterWorkspacePreimage: null });
      await restoreSelectedHunk(options.authority, options.authority.target.hunkRefs[0], Math.max(100, Math.min(60_000, options.timeoutMs ?? 5_000)));
    } else await restoreWholeFile(options.authority, finalRecheck);
    committed = true;
    const afterIndexPreimage = await collectIndexPreimage(options.authority.repoRoot);
    const afterWorkspacePreimage = collectSelectedWorkspacePreimage(options.authority.repoRoot, [options.authority.repoPath]);
    if (afterIndexPreimage !== options.expectedIndexPreimage || afterWorkspacePreimage === options.expectedWorkspacePreimage)
      return result({ state: "uncertain", reasonCode: "mutation-postcondition-unknown", ...before, afterIndexPreimage, afterWorkspacePreimage });
    if (options.authority.target.hunkRefs.length) {
      const snapshot = await collectGitStatusForPaths(options.authority.repoRoot, [options.authority.repoPath]);
      const record = snapshot.records.find((item) => item.path.value === options.authority.repoPath);
      if (record) {
        const remaining = await collectExactGitPatchAuthority({ snapshot, record, view: "unstaged", fileRef: options.authority.target.fileRef });
        if (remaining?.hunks.some((hunk) => options.authority.target.hunkRefs.includes(hunk.hunkRef)))
          return result({ state: "uncertain", reasonCode: "mutation-postcondition-unknown", ...before, afterIndexPreimage, afterWorkspacePreimage });
      }
    }
    return result({ state: "settled", reasonCode: null, ...before, afterIndexPreimage, afterWorkspacePreimage });
  } catch (error) {
    const reasonCode = (error as NodeJS.ErrnoException).code === "EEXIST" ? "worktree-revert-locked"
      : committed ? "mutation-postcondition-unknown" : "worktree-revert-failed";
    return result({ state: committed ? "uncertain" : "rejected", reasonCode, ...before, afterIndexPreimage: null, afterWorkspacePreimage: null });
  } finally { if (ownsLock) try { fs.rmSync(lockPath, { force: true }); } catch {} }
}

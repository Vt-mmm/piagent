import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Experiment-loop tools (an optional Pi package may add them): run_experiment
// runs `bash -c <command>` itself, so the guard checks that command like any
// shell command (see SHELL_TOOL_NAMES). log_experiment then commits every
// change when an idea is kept (`git add -A`, `git commit`) and erases every
// uncommitted change when it is dropped (`git checkout -- .`, `git clean -fd`),
// outside the guard. The loop is therefore allowed only where those commands
// cannot destroy the member's work: in the session folder itself, on an
// `experiment/` branch or in a linked worktree, starting from a tree with
// nothing uncommitted.
export const EXPERIMENT_LOOP_TOOLS = new Set(["init_experiment", "run_experiment", "log_experiment"]);

// The loop's own files live in `.auto/` and survive a discard, so they may be
// uncommitted. Files of any other layout count as project files: the safe side.
const EXPERIMENT_FILES = /^\.auto\//;
const EXPERIMENT_BRANCH = "experiment/";
const DEDICATED_TREE = "Run the loop on a branch or worktree of its own, with nothing uncommitted: `git switch -c experiment/<goal>`, "
  + "or `git worktree add ../<repo>-experiment -b experiment/<goal>` and start Pi in that folder. Your other changes stay untouched.";

type Decision = { block: true; reason: string } | undefined;

// Trimmed at the end only: `git status --porcelain` lines start with a space.
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trimEnd();
  } catch { return null; }
}

// `workingDir` from the loop's config (`.auto/config.json`), resolved the way
// the loop resolves it.
function configuredWorkingDir(cwd: string): string | null {
  const file = path.join(cwd, ".auto", "config.json");
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"))?.workingDir;
    return typeof value === "string" && value.trim() ? path.resolve(cwd, value) : null;
  } catch { return null; }
}

// Files with uncommitted changes, other than the loop's own.
export function uncommittedProjectFiles(cwd: string): string[] {
  return (git(cwd, ["status", "--porcelain", "--untracked-files=all"]) ?? "").split("\n").filter(Boolean)
    .map((line) => line.slice(3)).filter((file) => !EXPERIMENT_FILES.test(file));
}

export function experimentLoopDecision(cwd: string, toolName: string): Decision {
  if (!EXPERIMENT_LOOP_TOOLS.has(toolName)) return undefined;
  const workingDir = configuredWorkingDir(cwd);
  if (workingDir && path.resolve(workingDir) !== path.resolve(cwd)) {
    return { block: true, reason: `Blocked ${toolName}: the experiment config moves its commands to ${workingDir}. `
      + "Start Pi in that folder instead, so the guard checks each command where it runs." };
  }
  if (toolName === "run_experiment") return undefined;
  const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir === null) {
    return { block: true, reason: `Blocked ${toolName}: the experiment loop commits and reverts with git, and this folder is not a git repository.` };
  }
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const linkedWorktree = commonDir !== null && path.resolve(commonDir) !== path.resolve(gitDir);
  if (!linkedWorktree && !branch?.startsWith(EXPERIMENT_BRANCH)) {
    return { block: true, reason: `Blocked ${toolName}: log_experiment commits every change when an idea is kept and erases every uncommitted change when it is discarded, and this is ${branch ? `branch ${branch}` : "a detached checkout"}. ${DEDICATED_TREE}` };
  }
  if (toolName === "init_experiment") {
    const dirty = uncommittedProjectFiles(cwd);
    if (dirty.length > 0) {
      return { block: true, reason: `Blocked init_experiment: ${dirty.length} uncommitted change(s) (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}) `
        + "would be erased by the first discarded experiment. Commit or stash them first, then start the loop." };
    }
  }
  return undefined;
}

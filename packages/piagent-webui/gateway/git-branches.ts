import { execFile } from "node:child_process";

import { readGitHead, type GitHead } from "./git-head.ts";

// The branches of a project folder and a switch between them, for the branch
// menu in the dashboard. Git itself does the switch (`git switch`), so it
// refuses exactly what it refuses in a Terminal: local changes a checkout
// would overwrite, a name that already exists, a branch that is not there.
export type Branch = { name: string; current: boolean; remote: string | null; committedAt: string | null };
export type BranchList = { repository: true; head: GitHead | null; branches: Branch[]; truncated: boolean; changedFiles: number };
export type SwitchRequest = { branch: string; create?: boolean; remote?: string | null };

const GIT = process.platform === "darwin" ? "/usr/bin/git" : "git";
const LIMIT = 200;
const SEP = "\u0000";

export class GitBranchError extends Error {
  readonly detail: string | null;
  constructor(code: string, detail: string | null = null) { super(code); this.detail = detail; }
}

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GIT, ["-C", cwd, ...args], { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout));
    });
  });
}

// A branch name git accepts that cannot be read as an option.
export async function validBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name || name.length > 200 || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) return false;
  try { await git(cwd, ["check-ref-format", "--branch", name], 5_000); return true; } catch { return false; }
}

export async function listBranches(cwd: string): Promise<BranchList | null> {
  const head = readGitHead(cwd);
  if (!head) {
    try { await git(cwd, ["rev-parse", "--git-dir"], 5_000); } catch { return null; }
  }
  let refs: string;
  try {
    refs = await git(cwd, ["for-each-ref", "--sort=-committerdate", `--count=${LIMIT * 2}`,
      "--format=%(refname)%00%(committerdate:iso-strict)", "refs/heads", "refs/remotes"]);
  } catch { return null; }
  const local = new Map<string, Branch>(), remote: Branch[] = [];
  for (const line of refs.split("\n")) {
    const [ref, date] = line.split(SEP);
    if (!ref) continue;
    const committedAt = date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      local.set(name, { name, current: !head?.detached && head?.name === name, remote: null, committedAt });
    } else if (ref.startsWith("refs/remotes/")) {
      const rest = ref.slice("refs/remotes/".length), slash = rest.indexOf("/");
      if (slash <= 0 || rest.endsWith("/HEAD")) continue;
      remote.push({ name: rest.slice(slash + 1), current: false, remote: rest.slice(0, slash), committedAt });
    }
  }
  // A remote branch shows only when no local branch has its name: switching
  // to it creates the local branch that tracks it.
  const offered = remote.filter((item) => !local.has(item.name)).filter((item, index, all) =>
    all.findIndex((other) => other.name === item.name) === index);
  const all = [...local.values(), ...offered];
  let changedFiles = 0;
  try { changedFiles = (await git(cwd, ["status", "--porcelain=v1", "--untracked-files=no"], 10_000)).split("\n").filter(Boolean).length; }
  catch { /* the count is advisory */ }
  return { repository: true, head, branches: all.slice(0, LIMIT), truncated: all.length > LIMIT, changedFiles };
}

function failure(error: unknown): GitBranchError {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
  const detail = stderr.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6).join("\n").slice(0, 600) || null;
  if (/would be overwritten by checkout|Please commit your changes or stash them/i.test(stderr)) return new GitBranchError("branch-switch-local-changes", detail);
  if (/already exists/i.test(stderr)) return new GitBranchError("branch-exists", detail);
  if (/invalid reference|did not match any|not a commit|no such branch/i.test(stderr)) return new GitBranchError("branch-not-found", detail);
  if (/you need to resolve your current index first|unmerged|in the middle of/i.test(stderr)) return new GitBranchError("branch-switch-unfinished-merge", detail);
  if ((error as { killed?: boolean })?.killed) return new GitBranchError("branch-switch-timeout", detail);
  return new GitBranchError("branch-switch-failed", detail);
}

export async function switchBranch(cwd: string, request: SwitchRequest): Promise<GitHead | null> {
  const name = request.branch.trim();
  if (!(await validBranchName(cwd, name))) throw new GitBranchError("branch-name-invalid");
  const remote = request.remote ?? null;
  if (remote !== null && (!/^[A-Za-z0-9._-]{1,100}$/.test(remote) || request.create)) throw new GitBranchError("branch-request-invalid");
  const args = request.create ? ["switch", "-c", name]
    : remote ? ["switch", "-c", name, "--track", `${remote}/${name}`]
      : ["switch", name];
  try { await git(cwd, args, 60_000); } catch (error) { throw failure(error); }
  return readGitHead(cwd);
}

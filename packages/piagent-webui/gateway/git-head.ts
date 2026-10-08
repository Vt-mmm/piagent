import fs from "node:fs";
import path from "node:path";

export type GitHead = { name: string; detached: boolean };

const MAX_DEPTH = 40;

// The branch a project folder stands on, read from the repository's HEAD file
// rather than by running git: the catalog asks for every project each time the
// dashboard refreshes, and a file read costs nothing. A linked worktree's
// `.git` is a file naming its own git directory, which holds its own HEAD.
// Null when the folder is not inside a repository or HEAD cannot be read.
export function readGitHead(cwd: string): GitHead | null {
  if (!cwd) return null;
  let folder = path.resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const dotGit = path.join(folder, ".git");
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(dotGit); } catch { /* keep walking up */ }
    if (stat) return headAt(stat.isDirectory() ? dotGit : linkedGitDir(dotGit, folder));
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

function linkedGitDir(dotGitFile: string, folder: string): string | null {
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, "utf8").slice(0, 4096));
    return match ? path.resolve(folder, match[1]) : null;
  } catch { return null; }
}

function headAt(gitDir: string | null): GitHead | null {
  if (!gitDir) return null;
  let head: string;
  try { head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").slice(0, 1024).trim(); } catch { return null; }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return { name: ref[1], detached: false };
  if (/^[0-9a-f]{40,64}$/i.test(head)) return { name: head.slice(0, 7), detached: true };
  return null;
}

// One read per project folder while a catalog is built.
export function gitHeadReader(): (cwd: string) => GitHead | null {
  const seen = new Map<string, GitHead | null>();
  return (cwd) => {
    if (!seen.has(cwd)) seen.set(cwd, readGitHead(cwd));
    return seen.get(cwd)!;
  };
}

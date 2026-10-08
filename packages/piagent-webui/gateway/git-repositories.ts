import fs from "node:fs";
import path from "node:path";

import { readGitHead, type GitHead } from "./git-head.ts";

// A project folder that is not itself in a repository may hold several (a
// workspace folder with the front end, the back end and other projects side
// by side, each its own repository). Like an editor's source control view,
// the dashboard looks one level down for them: each child folder with its
// own `.git` (a folder, or a worktree's file) is a repository, shown with
// its branch. Hidden folders and dependency folders are skipped.
export type ChildRepository = { name: string; path: string; head: GitHead | null };

const MAX_REPOSITORIES = 30;
const SKIPPED = new Set(["node_modules", "vendor", "target", "dist", "build", "Pods", "venv", "__pycache__"]);

export function childRepositories(cwd: string): ChildRepository[] {
  if (!cwd || readGitHead(cwd)) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(cwd, { withFileTypes: true }); } catch { return []; }
  const found: ChildRepository[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
    const folder = path.join(cwd, entry.name);
    try { fs.lstatSync(path.join(folder, ".git")); } catch { continue; }
    found.push({ name: entry.name, path: entry.name, head: readGitHead(folder) });
    if (found.length === MAX_REPOSITORIES) break;
  }
  return found;
}

// The folder of one child repository, or null when `name` is not one: a
// single folder name, never a path that climbs out of the project.
export function childRepositoryFolder(cwd: string, name: string): string | null {
  if (!name || name.length > 255 || name.startsWith(".") || name.includes("/") || name.includes("\\") || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return childRepositories(cwd).some((repository) => repository.name === name) ? path.join(cwd, name) : null;
}

// One read per project folder while a catalog is built.
export function childRepositoryReader(): (cwd: string) => ChildRepository[] {
  const seen = new Map<string, ChildRepository[]>();
  return (cwd) => {
    if (!seen.has(cwd)) seen.set(cwd, childRepositories(cwd));
    return seen.get(cwd)!;
  };
}

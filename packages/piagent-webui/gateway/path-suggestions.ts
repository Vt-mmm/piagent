import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// What an @ in the composer offers, as Pi's terminal does: files and folders
// of the project matched loosely by name (fd, which honours .gitignore), and,
// after a folder and a slash (src/, ~/Documents/, /Volumes/), the names under
// that folder anywhere on this Mac. Only names reach the browser; no file is
// opened.
export type PathSuggestion = { value: string; label: string; detail: string; kind: "file" | "directory" };
type Entry = { path: string; directory: boolean };

const LIMIT = 20;
const SEARCH_RESULTS = 100;
const LISTED_ENTRIES = 5_000;
// Outside the project a search stays shallow and skips app data and
// dependency folders: a home folder is far larger than a repository.
const OUTSIDE_DEPTH = 4;
const fold = (value: string) => value.normalize("NFC").toLowerCase();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name typed composed (Dự án) may be stored decomposed on disk: either form matches.
const either = (value: string) => value.normalize("NFC") === value.normalize("NFD") ? escape(value)
  : `(?:${escape(value.normalize("NFC"))}|${escape(value.normalize("NFD"))})`;
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);

export function findFd(home = os.homedir()): string | null {
  for (const candidate of ["/opt/homebrew/bin/fd", "/usr/local/bin/fd", path.join(home, ".pi/agent/bin/fd")]) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

// Higher is better: the name itself, then its start, then anywhere in it,
// then anywhere in the path; a folder before a file with the same score.
function score(entry: string, query: string, directory: boolean): number {
  const name = fold(path.basename(entry)), wanted = fold(query);
  const value = name === wanted ? 100 : name.startsWith(wanted) ? 80 : name.includes(wanted) ? 50 : fold(entry).includes(wanted) ? 30 : 0;
  return value && directory ? value + 10 : value;
}

function run(file: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { encoding: "utf8", timeout: 4_000, maxBuffer: 8 << 20, signal }, (error, stdout) => resolve(error ? "" : stdout));
    child.stdin?.on("error", () => {}); child.stdin?.end(input ?? "");
  });
}

// The folder's own names, without what its repository ignores (dist/,
// node_modules/), as fd lists them for Pi.
async function listed(folder: string, signal?: AbortSignal): Promise<Entry[]> {
  const entries: Entry[] = [];
  try {
    for await (const entry of await fs.promises.opendir(folder)) {
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) try { directory = fs.statSync(path.join(folder, entry.name)).isDirectory(); } catch { /* broken link */ }
      entries.push({ path: entry.name, directory });
      if (entries.length >= LISTED_ENTRIES) break;
    }
  } catch { /* unreadable */ }
  if (!entries.length) return entries;
  const ignored = new Set((await run("/usr/bin/git", ["-C", folder, "check-ignore", "-z", "--stdin"], signal, entries.map((entry) => `${entry.path}\0`).join("")))
    .split("\0").filter(Boolean));
  return ignored.size ? entries.filter((entry) => !ignored.has(entry.path)) : entries;
}

// Names deeper down that match: fd as Pi runs it in the project; shallow and
// without hidden folders elsewhere; without fd, the files git knows about.
async function searched(folder: string, query: string, options: { fd: string | null; project: boolean; atRoot: boolean; signal?: AbortSignal }): Promise<Entry[]> {
  if (options.fd) {
    const args = ["--base-directory", folder, "--type", "f", "--type", "d", "--max-results", String(SEARCH_RESULTS), "--ignore-case", "--exclude", ".git",
      ...(options.project ? ["--follow", "--hidden"] : ["--max-depth", String(OUTSIDE_DEPTH), "--exclude", "Library", "--exclude", "node_modules", ...(query.startsWith(".") ? ["--hidden"] : [])]),
      ...(query.includes("/") ? ["--full-path", query.split("/").filter(Boolean).map(either).join("/")] : [either(query)])];
    return (await run(options.fd, args, options.signal)).split("\n").filter(Boolean)
      .map((line) => ({ path: line.replace(/^\.\//, "").replace(/\/$/, ""), directory: line.endsWith("/") }));
  }
  if (!options.atRoot) return [];
  const files = (await run("/usr/bin/git", ["-C", folder, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], options.signal))
    .split("\0").filter(Boolean).slice(0, 50_000);
  const folders = new Set<string>();
  for (const file of files) for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) folders.add(dir);
  const wanted = fold(query);
  return [...[...folders].map((dir) => ({ path: dir, directory: true })), ...files.map((file) => ({ path: file, directory: false }))]
    .filter((entry) => fold(entry.path).includes(wanted));
}

export async function suggestPaths(options: { root: string; query: string; home?: string; fd?: string | null; signal?: AbortSignal }): Promise<{ suggestions: PathSuggestion[] }> {
  const home = options.home ?? os.homedir(), fd = options.fd === undefined ? findFd(home) : options.fd;
  const root = fs.realpathSync(options.root);
  const typed = options.query.trim() === "~" ? "~/" : options.query.trim();
  // Text up to the last slash names a folder: search under it (Pi's scoped
  // search). When it is not a folder, the whole text is matched in the project.
  const cut = typed.lastIndexOf("/") + 1;
  let base = typed.slice(0, cut), name = typed.slice(cut), folder = root;
  if (base) {
    try {
      const candidate = fs.realpathSync(base.startsWith("~/") ? path.join(home, base.slice(2)) : path.resolve(root, base));
      if (fs.statSync(candidate).isDirectory()) folder = candidate; else { base = ""; name = typed; }
    } catch { base = ""; name = typed; }
  }
  const project = inside(folder, root);
  const near = await listed(folder, options.signal);
  const deep = name ? await searched(folder, name, { fd, project, atRoot: folder === root, signal: options.signal }) : [];
  const seen = new Set<string>(), entries: Array<Entry & { score: number }> = [];
  for (const entry of [...near, ...deep]) {
    if (seen.has(entry.path)) continue; seen.add(entry.path);
    // Hidden entries (.github, .ssh, .zshrc) for a name typed with a dot, and
    // in the project for any name typed, as Pi's search finds them there.
    if (entry.path.split("/").some((part) => part.startsWith(".")) && !name.startsWith(".") && !(project && name)) continue;
    const value = name ? score(entry.path, name.split("/").filter(Boolean).at(-1) ?? name, entry.directory) : 1;
    if (value > 0) entries.push({ ...entry, score: value });
  }
  const depth = (entry: Entry) => entry.path.split("/").length;
  entries.sort((a, b) => b.score - a.score || depth(a) - depth(b)
    || (name ? a.path.length - b.path.length : Number(b.directory) - Number(a.directory)) || a.path.localeCompare(b.path));
  return { suggestions: entries.slice(0, LIMIT).map((entry) => ({ value: `${base}${entry.path}${entry.directory ? "/" : ""}`,
    label: path.basename(entry.path) + (entry.directory ? "/" : ""), detail: `${base}${entry.path}`, kind: entry.directory ? "directory" : "file" })) };
}

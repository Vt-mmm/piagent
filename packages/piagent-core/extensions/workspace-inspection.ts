import { suggestPaths } from "./path-suggestions.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { effectiveProtectedPaths, matchesProtectedPath } from "./workspace-policy.js";
import { inspectWorkspaceEntry, readWorkspaceFile, WorkspaceReadError } from "../security/workspace-file-reader.ts";

export type WorkspacePolicy = { policy: Record<string, unknown>; profile: Record<string, unknown>; readOnly?: boolean };
export type WorkspaceEntry = { name: string; path: string; kind: "file" | "directory" | "symlink" | "other";
  protected: boolean; readOnly: boolean; ignored: boolean };
const MAX_ENTRIES = 1_000, MAX_FILE_BYTES = 1 << 20;
const git = process.platform === "darwin" ? "/usr/bin/git" : "git";

function validPath(value: string, rootAllowed = false): void {
  if (rootAllowed && value === "") return;
  if (!value || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value) || path.isAbsolute(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new WorkspaceReadError("outside-root", "Workspace path is not a safe relative path");
  }
}

// Ancestors inherit restrictions too: a protected folder cannot be opened via
// a direct file URL that avoids the explorer's locked entry.
export function workspacePathFlags(value: string, options: WorkspacePolicy): { protected: boolean; readOnly: boolean } {
  const effective = effectiveProtectedPaths(options.policy, options.profile);
  const parts = value.split("/");
  const candidates = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  return {
    protected: candidates.some(candidate => !!matchesProtectedPath(candidate, effective.readProtectedPaths)),
    readOnly: !!options.readOnly || candidates.some(candidate => !!matchesProtectedPath(candidate, effective.writeProtectedPaths))
  };
}

function directory(root: string, relative: string): { absolute: string; stat: fs.Stats } {
  validPath(relative, true);
  const absolute = relative ? path.join(root, relative) : root;
  const stat = relative ? inspectWorkspaceEntry(root, relative) : fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new WorkspaceReadError("symlink-ancestor", "Workspace directory is a symbolic link");
  if (!stat.isDirectory()) throw new WorkspaceReadError("not-file", "Workspace entry is not a directory");
  return { absolute, stat };
}

export function inspectWorkspaceTree(rootPath: string, relative: string, options: WorkspacePolicy, limit = MAX_ENTRIES) {
  const root = fs.realpathSync(rootPath);
  const folder = directory(root, relative);
  if (relative && workspacePathFlags(relative, options).protected) throw new Error("workspace-path-protected");
  const cap = Math.max(1, Math.min(MAX_ENTRIES, Number.isFinite(limit) ? Math.floor(limit) : MAX_ENTRIES));
  const names = new Set<string>(), directories = new Set<string>();
  let truncated = false, source: "git" | "directory" = "git";
  let output: string | null = null;
  try {
    output = execFileSync(git, ["-C", folder.absolute, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
      { encoding: "utf8", timeout: 3000, maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer };
    if (failure.code === "ENOBUFS" && failure.stdout) {
      const partial = String(failure.stdout);
      output = partial.slice(0, partial.lastIndexOf("\0") + 1);
      truncated = true;
    } else {
      let repository = false;
      try { repository = execFileSync(git, ["-C", root, "rev-parse", "--is-inside-work-tree"],
        { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "true"; } catch { /* no repository */ }
      // A Git timeout must not turn ignored paths into visible fallback entries.
      if (repository) throw new Error("workspace-tree-unavailable");
    }
  }
  if (output !== null) {
    for (const entry of output.split("\0")) {
      const name = entry.split("/")[0];
      if (!name || name === ".git") continue;
      names.add(name);
      if (entry.includes("/")) directories.add(name);
      if (names.size > cap) { truncated = true; break; }
    }
  } else {
    // Even without Git, never materialize an unbounded directory listing.
    source = "directory";
    const handle = fs.opendirSync(folder.absolute);
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync())) {
        if (entry.name === ".git") continue;
        names.add(entry.name);
        if (entry.isDirectory()) directories.add(entry.name);
        if (names.size > cap) { truncated = true; break; }
      }
    } finally { handle.closeSync(); }
  }
  const entries: WorkspaceEntry[] = [];
  for (const name of [...names].slice(0, cap)) {
    const entryPath = relative ? `${relative}/${name}` : name;
    try {
      validPath(entryPath);
      const flags = workspacePathFlags(entryPath, options);
      if (flags.protected) {
        entries.push({ name, path: entryPath, kind: directories.has(name) ? "directory" : "file", ...flags, ignored: false });
        continue;
      }
      const stat = inspectWorkspaceEntry(root, entryPath);
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      entries.push({ name, path: entryPath, kind, ...workspacePathFlags(entryPath, options), ignored: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  const after = directory(root, relative).stat;
  if (after.dev !== folder.stat.dev || after.ino !== folder.stat.ino || after.mtimeMs !== folder.stat.mtimeMs) {
    throw new WorkspaceReadError("changed-during-read", "Workspace directory changed during inspection");
  }
  entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
  return { path: relative, entries, truncated, source };
}

const LANGUAGES: Record<string, string> = { ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", css: "css", html: "html", py: "python", rs: "rust", go: "go", sh: "shell", yaml: "yaml", yml: "yaml" };

export function inspectWorkspaceFile(root: string, relative: string, options: WorkspacePolicy) {
  validPath(relative);
  const flags = workspacePathFlags(relative, options);
  const base = { path: relative, language: LANGUAGES[relative.split(".").at(-1)?.toLowerCase() ?? ""] ?? "text", ...flags,
    binary: false, oversized: false, content: null as string | null, digest: null as string | null, revision: null as string | null };
  // Do not stat or hash protected files: even their digest would expose data.
  if (flags.protected) return base;
  let bytes: Buffer;
  try { bytes = readWorkspaceFile(root, relative, MAX_FILE_BYTES); }
  catch (error) { if (error instanceof WorkspaceReadError && error.code === "oversized") return { ...base, oversized: true }; throw error; }
  const digest = createHash("sha256").update(bytes).digest("hex");
  let content: string;
  try {
    if (bytes.includes(0)) return { ...base, binary: true, digest, revision: `sha256:${digest}` };
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return { ...base, binary: true, digest, revision: `sha256:${digest}` }; }
  return { ...base, content, digest, revision: `sha256:${digest}` };
}

export async function inspectWorkspacePaths(root: string, query: string, options: WorkspacePolicy) {
  if (query.length > 512 || /[\x00-\x1f\x7f]/.test(query)) throw new Error("workspace-query-invalid");
  const result = await suggestPaths({ root, query, projectOnly: true,
    isAllowed: relative => !workspacePathFlags(relative, options).protected });
  return { query, ...result, truncated: result.suggestions.length >= 20 };
}

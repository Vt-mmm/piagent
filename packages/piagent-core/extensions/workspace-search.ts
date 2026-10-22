import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { inspectWorkspaceFile, workspacePathFlags, type WorkspacePolicy } from "./workspace-inspection.ts";
import { effectiveProtectedPaths } from "./workspace-policy.js";

export type WorkspaceMatch = { path: string; line: number; column: number; preview: string };
const TIMEOUT = 3000, LIMIT = 100;
function findRipgrep(): string | null {
  for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
    const file = path.join(dir, process.platform === "win32" ? "rg.exe" : "rg");
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  return null;
}

function ftsCandidates(root: string, query: string, excludePatterns: string[], timeout: number) {
  return new Promise<{ paths: string[]; available: boolean; timedOut: boolean }>((resolve) => {
    const worker = new Worker(new URL("./workspace-search-index.mjs", import.meta.url), { workerData: { root, query, excludePatterns } });
    let settled = false;
    const finish = (value: { paths: string[]; available: boolean; timedOut: boolean }) => {
      if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve(value);
    };
    const timer = setTimeout(() => finish({ paths: [], available: true, timedOut: true }), timeout);
    worker.once("message", value => finish({ ...value, timedOut: false }));
    worker.once("error", () => finish({ paths: [], available: false, timedOut: false }));
    worker.once("exit", () => finish({ paths: [], available: false, timedOut: false }));
  });
}

export async function searchWorkspace(root: string, query: string, options: WorkspacePolicy, config: { rg?: string | null; timeout?: number } = {}) {
  if (!query.trim() || query.length > 512 || /[\x00-\x1f\x7f]/.test(query)) throw new Error("workspace-query-invalid");
  const deadline = Date.now() + Math.max(1, Math.min(TIMEOUT, config.timeout ?? TIMEOUT));
  const effective = effectiveProtectedPaths(options.policy, options.profile);
  const excludePatterns = [...new Set([...effective.readProtectedPaths, ".git/**"])];
  const rg = config.rg === undefined ? findRipgrep() : config.rg;
  let paths: string[] = [], truncated = false, available = true;
  const backend = rg ? "ripgrep" : "fts";
  if (rg) {
    const result = await new Promise<{ output: string; limited: boolean }>((resolve) => {
      execFile(rg, ["--files-with-matches", "--null", "--hidden", "--fixed-strings", "--max-filesize", "1M", "--no-messages",
        ...excludePatterns.flatMap(pattern => ["--iglob", `!${pattern}`, "--iglob", `!${pattern}/**`]), "--", query, "."],
      { cwd: root, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1 << 20, encoding: "utf8" }, (error, stdout) => {
        resolve({ output: stdout, limited: !!error && (error as { code?: unknown }).code !== 1 });
      });
    });
    truncated = result.limited;
    paths = result.output.slice(0, result.output.lastIndexOf("\0") + 1).split("\0").filter(Boolean).map(file => file.replace(/^\.\//, ""));
  } else {
    const result = await ftsCandidates(root, query, excludePatterns, Math.max(1, deadline - Date.now()));
    paths = result.paths; available = result.available; truncated = result.timedOut || paths.length >= 50;
  }
  const matches: WorkspaceMatch[] = [];
  for (const relative of [...new Set(paths)]) {
    if (Date.now() >= deadline || matches.length >= LIMIT) { truncated = true; break; }
    if (workspacePathFlags(relative, options).protected) continue;
    try {
      // Never return stale index text or rg output; apply the file reader's
      // symlink/policy checks and calculate positions from current bytes.
      const file = inspectWorkspaceFile(root, relative, options);
      if (file.content === null) continue;
      const lines = file.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (Date.now() >= deadline || matches.length >= LIMIT) { truncated = true; break; }
        const column = lines[index].indexOf(query);
        if (column < 0) continue;
        const start = Math.max(0, column - 80);
        matches.push({ path: relative, line: index + 1, column: column + 1, preview: lines[index].slice(start, start + 400) });
      }
    } catch { /* moved, unsafe, or unreadable candidate */ }
  }
  return { query, matches, truncated, backend, available };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PiSessionInfo } from "./session-catalog.ts";

type ListAll = (sessionDir: string) => Promise<PiSessionInfo[]>;
type Cached = { mtimeMs: number; size: number; info: PiSessionInfo | null };

// Pi lists sessions by reading every session file in full. With hundreds of
// conversations that is seconds of CPU for every catalog the dashboard asks
// for, and its answers slip past the page's 30-second wait. A file whose size
// and modification time are unchanged keeps the info read before; changed and
// new files are read again by Pi itself, through a private folder of links to
// them, so the info is always what Pi would have produced.
//
// `flat`: the sessions are files directly in `root` (a company store);
// otherwise each project has a folder of them under `root` (Pi's own layout).
export function cachedSessionLister(listAll: ListAll, root: string, flat: boolean): () => Promise<PiSessionInfo[]> {
  const cache = new Map<string, Cached>();
  let running: Promise<PiSessionInfo[]> | null = null;

  const discover = async (): Promise<string[]> => {
    if (!fs.existsSync(root)) return [];
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    if (flat) return entries.filter((entry) => entry.name.endsWith(".jsonl")).map((entry) => path.join(root, entry.name));
    const folders = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(root, entry.name));
    const files = await Promise.all(folders.map(async (folder) => {
      try { return (await fs.promises.readdir(folder)).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(folder, name)); }
      catch { return []; }
    }));
    return files.flat();
  };

  const refresh = async (): Promise<PiSessionInfo[]> => {
    const files = await discover(), seen = new Set(files), changed: string[] = [];
    const stats = new Map<string, fs.Stats>();
    await Promise.all(files.map(async (file) => {
      try {
        const stat = await fs.promises.stat(file); stats.set(file, stat);
        const known = cache.get(file);
        if (!known || known.mtimeMs !== stat.mtimeMs || known.size !== stat.size) changed.push(file);
      } catch { seen.delete(file); }
    }));
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
    if (changed.length) {
      const links = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piagent-session-list-"));
      try {
        await Promise.all(changed.map((file, index) => fs.promises.symlink(file, path.join(links, `${index}.jsonl`))));
        const read = new Map<number, PiSessionInfo>();
        for (const info of await listAll(links)) read.set(Number(path.basename(info.path, ".jsonl")), info);
        changed.forEach((file, index) => {
          const stat = stats.get(file)!, info = read.get(index);
          cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info: info ? { ...info, path: file } : null });
        });
      } finally { await fs.promises.rm(links, { recursive: true, force: true }); }
    }
    const infos: PiSessionInfo[] = [];
    for (const file of seen) { const info = cache.get(file)?.info; if (info) infos.push(info); }
    return infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  };

  // Callers at the same moment share one refresh.
  return () => {
    running ??= refresh().finally(() => { running = null; });
    return running;
  };
}

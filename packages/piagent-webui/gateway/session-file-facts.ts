import fs from "node:fs";

type Known<T> = { mtimeMs: number; size: number; ino: number; facts: T };
const LIMIT = 20_000;

// The catalog is rebuilt for every page refresh and every command, and each
// build opened and parsed every conversation file to learn its model and
// thinking level: about a second of blocked Gateway for 900 files, several
// seconds on a busy machine, while Stop and Send waited behind it. What a file
// says changes only when the file does, so its facts are kept until its size,
// modification time or inode changes. The file is checked before it is read:
// a write that lands during the read is seen as a change on the next call.
export function cachedSessionFacts<T>(read: (file: string) => T): (file: string) => T {
  const cache = new Map<string, Known<T>>();
  return (file) => {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { cache.delete(file); return read(file); }
    const known = cache.get(file);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size && known.ino === stat.ino) return known.facts;
    const facts = read(file);
    if (cache.size >= LIMIT) cache.clear();
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, facts });
    return facts;
  };
}

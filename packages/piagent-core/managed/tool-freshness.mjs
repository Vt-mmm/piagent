import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LIMIT = 20 * 1024 * 1024;
export function freshnessPath(cwd, name, args) {
  if (!['read', 'edit', 'write'].includes(name) || typeof args?.path !== 'string') return null;
  const relative = path.relative(cwd, path.resolve(cwd, args.path));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : null;
}
// Called only inside the sandbox. The parent stores opaque digests and never
// opens a company project file to decide whether an edit is fresh.
export function fileDigest(cwd, relative) {
  if (!relative) return null;
  let descriptor;
  try {
    const file = path.resolve(cwd, relative), real = fs.realpathSync(file);
    if (real !== file) return null;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > LIMIT) return null;
    const bytes = Buffer.alloc(stat.size + 1), length = fs.readSync(descriptor, bytes, 0, bytes.length, 0), after = fs.fstatSync(descriptor);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return null;
    return createHash('sha256').update(bytes.subarray(0, length)).digest('hex');
  } catch (error) { return error?.code === 'ENOENT' ? 'absent' : null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
export function beginToolFreshness(cwd, name, args, expected) {
  const relative = freshnessPath(cwd, name, args), before = fileDigest(cwd, relative);
  if (relative && ['edit', 'write'].includes(name) && expected !== undefined && before !== expected)
    throw new Error(`stale-content: ${relative} changed since the last read. Read its current contents before editing.`);
  return () => {
    const digest = fileDigest(cwd, relative);
    if (name === 'read' && relative && before !== digest) throw new Error(`stale-content: ${relative} changed during the read. Read it again.`);
    return relative && digest ? { path: relative, digest } : null;
  };
}
export class ToolFreshness {
  #observed = new Map();
  expected(cwd, name, args) { return this.#observed.get(freshnessPath(cwd, name, args)); }
  observe(cwd, name, args, value) {
    const relative = freshnessPath(cwd, name, args);
    if (!relative || value?.path !== relative || !/^(absent|[a-f0-9]{64})$/.test(value?.digest ?? '')) return;
    this.#observed.delete(relative); this.#observed.set(relative, value.digest);
    while (this.#observed.size > 256) this.#observed.delete(this.#observed.keys().next().value);
  }
}

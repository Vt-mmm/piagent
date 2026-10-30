// The code a company session's sandbox runs, kept apart from the install.
//
// A session pins the hash of its workers and refuses every tool when one
// changes. piagent-update rewrites the install in place, so a task running
// across an update lost all its tools (managed-runtime-changed) while a helper
// started afterwards worked. A session now runs its workers from a private
// copy named by their content: an update leaves it alone, the pins keep
// guarding it, and the next process takes a copy of the new release.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cacheRoot = home => path.join(home, process.platform === 'darwin' ? 'Library/Caches/Piagent/runtime' : '.cache/piagent/runtime');

function runtimeFiles(source) {
  const files = fs.readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.mjs')).map(entry => entry.name);
  const walk = relative => {
    let entries;
    try { entries = fs.readdirSync(path.join(source, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(name); else if (entry.isFile()) files.push(name);
    }
  };
  walk(path.join('dist', 'workspace'));
  return files.sort();
}

const intact = (directory, listing) => listing.every(([file, digest]) => { try { return hash(path.join(directory, file)) === digest; } catch { return false; } });

// The copy of `source` under the member's cache folder; an old one is removed
// once no process has asked for it for a month.
export function snapshotRuntime(source, { home = os.homedir(), now = Date.now() } = {}) {
  const listing = runtimeFiles(source).map(file => [file, hash(path.join(source, file))]);
  const id = createHash('sha256').update(JSON.stringify(listing)).digest('hex').slice(0, 32);
  const root = cacheRoot(home), target = path.join(root, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!intact(target, listing)) {
    const building = path.join(root, `.${id}.${randomUUID()}`);
    try {
      for (const [file] of listing) {
        fs.mkdirSync(path.dirname(path.join(building, file)), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(source, file), path.join(building, file));
        fs.chmodSync(path.join(building, file), 0o400);
      }
      // Without it the workspace worker's .js files would load as CommonJS.
      fs.writeFileSync(path.join(building, 'package.json'), '{"type":"module"}\n', { mode: 0o400 });
      fs.rmSync(target, { recursive: true, force: true });
      // Another session may have built the same copy meanwhile.
      try { fs.renameSync(building, target); } catch (error) { if (!intact(target, listing)) throw error; }
    } finally { fs.rmSync(building, { recursive: true, force: true }); }
  }
  fs.utimesSync(target, new Date(now), new Date(now));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === id) continue;
    const old = path.join(root, entry.name);
    try { if (now - fs.statSync(old).mtimeMs > KEEP_MS) fs.rmSync(old, { recursive: true, force: true }); } catch { /* another session removes it */ }
  }
  return fs.realpathSync(target);
}

import { execFileSync } from 'node:child_process';

const INTERVAL = 2000;
function table() {
  try {
    return execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  } catch { return []; }
}
const tree = (rows, root) => {
  const found = new Set(), queue = [root];
  for (const parent of queue) for (const [pid, ppid] of rows) if (ppid === parent && pid > 1 && pid !== process.pid && !found.has(pid)) { found.add(pid); queue.push(pid); }
  return found;
};
const signal = (pid, name) => { try { process.kill(pid, name); } catch { /* already gone */ } };

// A shell's background job (`sleep 300 &`, then `exit`) leaves the shell's
// process group, and once the shell ends it is re-parented to init and no
// longer in its tree. The tree is therefore watched while the shell runs, so
// such jobs stop with their terminal. A watched process is signalled only
// while it is still orphaned (parent 1) or still under the root, never after
// its number was reused by an unrelated process.
export class ProcessTreeWatch {
  #roots = new Map();
  #timer = null;
  watch(root) {
    this.#roots.set(root, new Set());
    this.#timer ??= setInterval(() => this.#scan(), INTERVAL);
    this.#timer.unref?.();
  }
  #scan(rows = table()) {
    for (const [root, seen] of this.#roots) for (const pid of tree(rows, root)) if (seen.size < 4096) seen.add(pid);
    return rows;
  }
  async stop(root) {
    const seen = this.#roots.get(root); if (!seen) return;
    const rows = this.#scan(), current = tree(rows, root), parents = new Map(rows.map(([pid, ppid]) => [pid, ppid]));
    this.#roots.delete(root);
    if (!this.#roots.size) { clearInterval(this.#timer); this.#timer = null; }
    const targets = [...seen].filter(pid => current.has(pid) || parents.get(pid) === 1);
    for (const pid of targets) signal(pid, 'SIGTERM');
    if (!targets.length) return;
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const pid of targets) signal(pid, 'SIGKILL');
  }
}

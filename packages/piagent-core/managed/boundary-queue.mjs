// One queue spans the agent's reads and every change, the member's included,
// so two concurrent edits observe a deterministic order. What the member's
// explorer, editor and review panels only read does not wait behind the
// agent's running command: a few run beside it, a few more wait for them, and
// beyond that they are refused (the panels retry).
const LIMIT = 3, WAITING = 16;
const memberRead = (name, args) => name === 'workspace' && (['tree', 'file', 'media', 'paths', 'search', 'write-state'].includes(args?.kind)
  || args?.kind === 'source' && ['sources', 'diff', 'preview'].includes(args.request?.kind));
export class BoundaryQueue {
  #tail = Promise.resolve();
  #reads = 0;
  #waiting = [];
  run(name, args, action) {
    if (!memberRead(name, args)) { const run = this.#tail.then(action); this.#tail = run.catch(() => {}); return run; }
    if (this.#reads < LIMIT) return this.#read(action);
    if (this.#waiting.length >= WAITING) return Promise.reject(new Error('managed-workspace-busy'));
    return new Promise(resolve => this.#waiting.push(resolve)).then(() => this.#read(action));
  }
  #read(action) {
    this.#reads++;
    return Promise.resolve().then(action).finally(() => { this.#reads--; this.#waiting.shift()?.(); });
  }
  idle() { return this.#tail; }
}

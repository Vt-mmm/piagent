import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// TypeScript and JavaScript errors of a file right after the agent writes or
// edits it, from the project's own TypeScript (ts-diagnostics-server.mjs, in
// the command sandbox). A file without errors adds nothing; a project without
// TypeScript or a tsconfig/jsconfig adds nothing; a slow first answer (a large
// program loading) adds nothing rather than holding the edit.
const SERVER = fileURLToPath(new URL('./ts-diagnostics-server.mjs', import.meta.url));
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SHOWN = 10, RESTARTS = 3;

export class TsDiagnostics {
  #child = null; #pending = new Map(); #next = 1; #buffer = ''; #starts = 0; #off = false;
  constructor(boundary, { timeout = 8000 } = {}) { Object.assign(this, { boundary, timeout }); }
  applies(file) {
    return !this.#off && process.platform === 'darwin' && typeof file === 'string' && EXTENSIONS.has(path.extname(file)) && !/(^|[\\/])node_modules[\\/]/.test(file);
  }
  async #server() {
    if (this.#child) return this.#child;
    if (this.#starts >= RESTARTS) { this.#off = true; return null; }
    this.#starts += 1;
    const { child } = await this.boundary.spawnSandboxed([this.boundary.node, SERVER, this.boundary.cwd], randomUUID(), { stdin: 'pipe' });
    child.stdout.on('data', chunk => {
      this.#buffer += chunk.toString('utf8');
      for (let at; (at = this.#buffer.indexOf('\n')) >= 0;) {
        const line = this.#buffer.slice(0, at); this.#buffer = this.#buffer.slice(at + 1);
        try { const answer = JSON.parse(line); this.#pending.get(answer.id)?.(answer); } catch { /* not an answer */ }
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('close', () => { if (this.#child === child) this.#child = null; for (const resolve of this.#pending.values()) resolve(null); this.#pending.clear(); });
    this.#child = child;
    return child;
  }
  // A note for the agent, or '' when there is nothing to say.
  async check(file) {
    if (!this.applies(file)) return '';
    try {
      const child = await this.#server();
      if (!child) return '';
      const id = this.#next++;
      const answer = await new Promise(resolve => {
        const timer = setTimeout(() => { this.#pending.delete(id); resolve(null); }, this.timeout); timer.unref?.();
        this.#pending.set(id, value => { clearTimeout(timer); this.#pending.delete(id); resolve(value); });
        child.stdin.write(JSON.stringify({ id, file }) + '\n');
      });
      const found = answer?.diagnostics, name = path.relative(this.boundary.cwd, path.resolve(this.boundary.cwd, file));
      if (Array.isArray(answer?.uncheckedBecause) && answer.uncheckedBecause.length)
        return `\n[TypeScript, ${answer.config}] ${name} was not type-checked: tsc stops at syntax errors elsewhere in the project:\n${answer.uncheckedBecause.map(d => `${d.file}:${d.line}:${d.column} TS${d.code} ${d.message}`).join('\n')}`;
      if (!Array.isArray(found) || !found.length) return '';
      const lines = found.slice(0, SHOWN).map(d => `${name}:${d.line}:${d.column} TS${d.code} ${d.message}`);
      return `\n[TypeScript, ${answer.config}] ${found.length} error(s) in ${name} after this change:\n${lines.join('\n')}${found.length > SHOWN ? `\n… and ${found.length - SHOWN} more` : ''}`;
    } catch { return ''; }
  }
  dispose() { this.#off = true; try { this.#child?.stdin.end(); } catch { /* gone */ } }
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { interopEnvironment } from './store.mjs';

export class ManagedBrokerClient {
  #child; #pending = new Map(); #tail = Promise.resolve(); #closed = false;
  constructor({ executable, profileID }) {
    if (!path.isAbsolute(executable) || fs.realpathSync(executable) !== executable || !/^[a-f0-9]{64}$/.test(profileID)) throw Error('managed-broker-binding-invalid');
    this.#child = spawn(executable, ['managed-broker', '--profile', profileID], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', ...interopEnvironment() },
    });
    let pending = ''; const decoder = new StringDecoder('utf8');
    const fail = () => { this.#closed = true; for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(Error('managed-broker-disconnected')); } this.#pending.clear(); };
    this.#child.stdin.on('error', fail); this.#child.on('error', fail); this.#child.on('close', fail);
    this.#child.stderr.on('data', () => {});
    this.#child.stdout.on('data', chunk => {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending) > 2 * 1024 * 1024) { this.#child.kill(); fail(); return; }
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const result = JSON.parse(line), item = this.#pending.get(result.id);
          if (!item) throw Error('unexpected-broker-response');
          clearTimeout(item.timer); this.#pending.delete(result.id);
          if (result.error) item.reject(Error(`managed-broker:${String(result.error).replace(/[^a-zA-Z_]/g, '').slice(0, 80)}`));
          else item.resolve(result.result);
        } catch { this.#child.kill(); fail(); }
      }
    });
  }
  request(action, args = {}) {
    const next = this.#tail.then(() => new Promise((resolve, reject) => {
      if (this.#closed) { reject(Error('managed-broker-disconnected')); return; }
      const id = randomUUID();
      const timer = setTimeout(() => { this.#child.kill(); reject(Error('managed-broker-timeout')); }, 25000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ ...args, id, action }) + '\n');
    }));
    this.#tail = next.catch(() => {}); return next;
  }
  async dispose() {
    if (this.#closed) return;
    try { await this.request('close'); } catch {}
    this.#child.stdin.end(); this.#child.kill(); this.#closed = true;
  }
}

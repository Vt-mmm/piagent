import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BWRAP, bubblewrapArgs, credentialFiles } from './linux-sandbox.mjs';
import { companyTerminalRuntime } from './terminal-runtime.mjs';
import { terminalChannel } from './terminal-channel.mjs';
import { SEATBELT_TERMINAL_RULES, seatbeltTerminal } from './terminal-seatbelt.mjs';

const worker = fileURLToPath(new URL('./terminal-worker.mjs', import.meta.url));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const dimensions = ({ cols, rows }) => Number.isInteger(cols) && cols >= 2 && cols <= 500 && Number.isInteger(rows) && rows >= 1 && rows <= 200;

export class BoundaryTerminals {
  #boundary; #runtime; #workerDigest; #entries = new Map(); #closed = false;
  reasonCode = null;
  constructor(boundary) {
    this.#boundary = boundary;
    try {
      this.#runtime = companyTerminalRuntime();
      if (inside(this.#runtime.root, boundary.cwd) || inside(worker, boundary.cwd)) throw Error('managed-terminal-runtime-overlap');
      this.#workerDigest = hash(worker);
    } catch (error) { this.reasonCode = /^managed-terminal-/.test(error.message) ? error.message : 'managed-terminal-runtime-invalid'; }
  }
  async open(size, emit) {
    if (this.#closed) throw Error('managed-terminal-boundary-closed');
    if (this.reasonCode) throw Error(this.reasonCode);
    const boundary = this.#boundary;
    if (!boundary.allowed.includes('bash')) throw Error('managed-terminal-permission-denied');
    if (!dimensions(size)) throw Error('managed-terminal-invalid-size');
    if (this.#entries.size >= 4) throw Error('managed-terminal-limit');
    this.#runtime.assertCurrent();
    if (hash(worker) !== this.#workerDigest) throw Error('managed-terminal-runtime-changed');
    for (const [file, digest] of boundary.pins) if (hash(file) !== digest) throw Error('managed-runtime-changed');
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-terminal-')));
    fs.chmodSync(temporary, 0o700);
    let channel;
    try {
      const home = path.join(temporary, 'home'), empty = path.join(temporary, 'empty');
      fs.mkdirSync(home, { mode: 0o700 }); fs.writeFileSync(empty, '', { mode: 0o400 });
      const env = Object.fromEntries(Object.entries(boundary.environment.offline)
        .filter(([key]) => !/proxy/i.test(key) && !['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'PIAGENT_TOOL_SCOPE'].includes(key))
        .map(([key, value]) => [key, String(value).split(boundary.temporary).join(temporary)]));
      Object.assign(env, { HOME: home, TMPDIR: temporary, TERM: 'xterm-256color', BASH_SILENCE_DEPRECATION_WARNING: '1',
        PIAGENT_PROCESS_SCOPE: `${boundary.scope}:${randomUUID()}` });
      // A separate temporary root excludes the boundary's package-proxy socket.
      // Writes reach the project, its Git directories and the project's
      // package caches, as the agent's own offline commands do.
      if (!boundary.linux) channel = seatbeltTerminal({ entry: this.#runtime.entry, cwd: boundary.cwd, env, size, emit,
        profile: boundary.terminalProfile(temporary) + SEATBELT_TERMINAL_RULES });
      else {
        const base = boundary.linuxBase;
        const protectedPaths = (base.denied ?? []).filter(file => fs.existsSync(file))
          .map(file => ({ path: file, directory: fs.statSync(file).isDirectory() }));
        const args = bubblewrapArgs({ ...base, temporary, empty, network: false, proxySocket: null, docker: null,
          toolchains: [...base.toolchains, this.#runtime.root],
          credentials: [...credentialFiles([boundary.cwd, ...base.repository, ...base.references]), ...protectedPaths] });
        // There is intentionally no alternative spawn path or injected host shell.
        const child = spawn(BWRAP, [...args, boundary.node, worker, this.#runtime.entry,
          fs.readlinkSync('/proc/self/ns/pid'), fs.readlinkSync('/proc/self/ns/net'), String(size.cols), String(size.rows)],
        { cwd: boundary.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env });
        channel = terminalChannel(child, emit);
      }
      const id = randomUUID();
      this.#entries.set(id, channel);
      void channel.completed.then(() => { this.#entries.delete(id); fs.rmSync(temporary, { recursive: true, force: true }); }).catch(() => {});
      await channel.initialized;
      return { id, input(data) {
        if (typeof data !== 'string' || Buffer.byteLength(data) > 16384) return Promise.reject(Error('managed-terminal-input-limit'));
        return channel.execute({ kind: 'input', data });
      }, resize(size) {
        if (!dimensions(size)) return Promise.reject(Error('managed-terminal-invalid-size'));
        return channel.execute({ kind: 'resize', cols: size.cols, rows: size.rows });
      }, close: channel.close };
    } catch (error) {
      if (channel) await channel.close();
      else fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async dispose() {
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map(channel => channel.close()));
  }
}

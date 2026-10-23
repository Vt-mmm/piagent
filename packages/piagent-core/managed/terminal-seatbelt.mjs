import { createRequire } from 'node:module';
import { stopProcessGroup } from './background-process.mjs';
import { ProcessTreeWatch } from '../runtime/process-tree-watch.mjs';

const watch = new ProcessTreeWatch();

// macOS: Seatbelt denies creating a PTY, so the company Gateway makes it and
// only the shell runs sandboxed, under the agent's offline profile plus these
// rules: ioctls on terminal devices (only the one this shell was handed can be
// reached, since opening any other stays denied) and /dev/tty, which always
// names the process's own terminal.
export const SEATBELT_TERMINAL_RULES = `
(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))
(allow file-read* file-write* file-ioctl (literal "/dev/tty"))
`;

export function seatbeltTerminal({ entry, profile, cwd, env, size, emit }) {
  const pty = createRequire(import.meta.url)(entry);
  const child = pty.spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '--noprofile', '--norc'],
    { cwd, env, cols: size.cols, rows: size.rows, name: 'xterm-256color' });
  watch.watch(child.pid);
  const notify = message => { try { emit(message); } catch { /* consumer never owns process lifetime */ } };
  let exited = false, closing, resolveClosed;
  const completed = new Promise(resolve => { resolveClosed = resolve; });
  child.onData(text => {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 8192, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      notify({ kind: 'output', data: text.slice(start, end) }); start = end;
    }
  });
  child.onExit(({ exitCode, signal }) => {
    exited = true; notify({ kind: 'exit', exitCode, signal: signal || null });
    void watch.stop(child.pid).finally(resolveClosed);
  });
  const close = () => closing ??= (async () => {
    if (exited) return;
    await stopProcessGroup({ pid: child.pid, exitCode: null, signalCode: null });
    let timeout;
    try { await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('managed-terminal-cleanup-unconfirmed')), 3000); })]); }
    finally { clearTimeout(timeout); }
  })();
  return { initialized: Promise.resolve(), completed, close, execute(payload) {
    if (exited || closing) return Promise.reject(Error('managed-terminal-exited'));
    if (payload.kind === 'input') child.write(payload.data); else child.resize(payload.cols, payload.rows);
    return Promise.resolve();
  } };
}

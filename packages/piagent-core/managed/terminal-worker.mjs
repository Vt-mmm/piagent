import fs from 'node:fs';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

// Only the boundary launches this entrypoint. Check both namespaces before
// loading native code: accidentally invoking it on the host must fail closed.
const [entry, hostPidNamespace, hostNetworkNamespace, columns, rows] = process.argv.slice(2);
const size = (cols, rows) => Number.isInteger(cols) && cols >= 2 && cols <= 500 && Number.isInteger(rows) && rows >= 1 && rows <= 200;
const send = message => {
  if (process.stdout.writableLength > 512 * 1024) process.exit(1);
  process.stdout.write(JSON.stringify(message) + '\n');
};
let terminal;
try {
  if (process.platform !== 'linux' || !/^pid:\[\d+\]$/.test(hostPidNamespace ?? '') || !/^net:\[\d+\]$/.test(hostNetworkNamespace ?? '')
    || fs.readlinkSync('/proc/self/ns/pid') === hostPidNamespace || fs.readlinkSync('/proc/self/ns/net') === hostNetworkNamespace
    || !size(Number(columns), Number(rows))) throw Error('sandbox-required');
  const pty = createRequire(import.meta.url)(entry);
  terminal = pty.spawn('/bin/bash', ['--noprofile', '--norc'], { cols: Number(columns), rows: Number(rows),
    cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' }, name: 'xterm-256color' });
} catch {
  process.stdout.write(JSON.stringify({ kind: 'unavailable', reasonCode: 'managed-terminal-sandbox-unavailable' }) + '\n', () => process.exit(1));
}
if (terminal) {
  let ending = false;
  const finish = message => {
    if (ending) return;
    ending = true;
    // Exiting the namespace's main process also stops detached shell children.
    const timer = setTimeout(() => process.exit(0), 1000); timer.unref();
    process.stdout.write(JSON.stringify(message) + '\n', () => process.exit(0));
  };
  // A writer faster than the Gateway reads (`yes`) waits on the terminal, as
  // on a real one, instead of growing this pipe until the worker gives up.
  let paused = false;
  process.stdout.on('drain', () => { if (paused && !ending) { paused = false; terminal.resume(); } });
  terminal.onData(text => {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 8192, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      send({ kind: 'output', data: text.slice(start, end) }); start = end;
    }
    if (!paused && process.stdout.writableLength > 128 * 1024) { paused = true; terminal.pause(); }
  });
  terminal.onExit(({ exitCode, signal }) => finish({ kind: 'exit', exitCode, signal: signal ?? null }));
  send({ kind: 'ready' });
  let pending = '';
  const decoder = new StringDecoder('utf8');
  process.stdin.on('data', chunk => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > 128 * 1024) return process.exit(1);
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const request = JSON.parse(line);
        if (!request || typeof request !== 'object' || !/^[0-9]{1,16}$/.test(request.id) || ending) throw Error();
        const keys = Object.keys(request).sort().join(',');
        if (request.kind === 'input' && keys === 'data,id,kind' && typeof request.data === 'string' && Buffer.byteLength(request.data) <= 16384)
          terminal.write(request.data);
        else if (request.kind === 'resize' && keys === 'cols,id,kind,rows' && size(request.cols, request.rows)) terminal.resize(request.cols, request.rows);
        else throw Error();
        send({ kind: 'ack', id: request.id });
      } catch { return process.exit(1); }
    }
  });
  process.stdin.on('end', () => finish({ kind: 'exit', exitCode: null, signal: null }));
  process.stdin.on('error', () => process.exit(1));
  process.stdout.on('error', () => process.exit(1));
}

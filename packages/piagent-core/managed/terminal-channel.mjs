import { StringDecoder } from 'node:string_decoder';
import { stopProcessGroup } from './background-process.mjs';

// Native effects are acknowledged once. A lost response rejects as uncertain;
// the Gateway command ledger owns retries and must never redispatch the effect.
export function terminalChannel(child, emit) {
  const requests = new Map(), decoder = new StringDecoder('utf8');
  let pending = '', next = 0, ready = false, closed = false, closing, exited = false;
  let resolveReady, rejectReady, resolveClosed;
  const initialized = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const completed = new Promise(resolve => { resolveClosed = resolve; });
  const timer = setTimeout(() => fail('managed-terminal-start-timeout'), 10000);
  const notify = message => { try { emit(message); } catch { /* consumer never owns process lifetime */ } };
  const rejectAll = reason => {
    rejectReady(new Error(reason));
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    requests.clear();
  };
  const close = () => closing ??= (async () => {
    if (closed) return;
    rejectAll('managed-terminal-effect-uncertain');
    await stopProcessGroup(child);
    let timeout;
    try { await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('managed-terminal-cleanup-unconfirmed')), 3000); })]); }
    finally { clearTimeout(timeout); }
  })();
  const fail = reason => { rejectAll(reason); void close().catch(() => {}); };
  child.once('error', () => fail('managed-terminal-sandbox-unavailable'));
  child.once('close', () => {
    closed = true; clearTimeout(timer); rejectAll('managed-terminal-effect-uncertain');
    if (!exited) notify({ kind: 'exit', exitCode: null, signal: null });
    resolveClosed();
  });
  child.stdin.on('error', () => fail('managed-terminal-effect-uncertain'));
  child.stderr.resume(); // Sandbox startup errors are reported by code, not raw host paths.
  child.stdout.on('data', chunk => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > 128 * 1024) return fail('managed-terminal-protocol-invalid');
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const value = JSON.parse(line), keys = Object.keys(value).sort().join(',');
        if (value.kind === 'ready' && keys === 'kind' && !ready) { ready = true; clearTimeout(timer); resolveReady(); }
        else if (value.kind === 'unavailable' && !ready) fail('managed-terminal-sandbox-unavailable');
        else if (ready && value.kind === 'ack' && keys === 'id,kind' && requests.has(value.id)) {
          const request = requests.get(value.id); clearTimeout(request.timer); requests.delete(value.id); request.resolve();
        } else if (ready && value.kind === 'output' && keys === 'data,kind' && typeof value.data === 'string' && value.data.length <= 8192) notify(value);
        else if (ready && value.kind === 'exit' && keys === 'exitCode,kind,signal' && (value.exitCode === null || Number.isInteger(value.exitCode))
          && (value.signal === null || Number.isInteger(value.signal)) && !exited) { exited = true; notify(value); }
        else throw Error();
      } catch { return fail('managed-terminal-protocol-invalid'); }
    }
  });
  return { initialized, completed, close, execute(payload) {
    if (!ready || closed || closing || exited) return Promise.reject(Error('managed-terminal-exited'));
    if (requests.size >= 128 || child.stdin.writableLength > 128 * 1024) return Promise.reject(Error('managed-terminal-capacity'));
    const id = String(++next), line = JSON.stringify({ ...payload, id }) + '\n';
    if (Buffer.byteLength(line) > 128 * 1024) return Promise.reject(Error('managed-terminal-input-limit'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(Error('managed-terminal-effect-uncertain')); void close().catch(() => {}); }, 10000);
      requests.set(id, { resolve, reject, timer });
      child.stdin.write(line, error => { if (error) fail('managed-terminal-effect-uncertain'); });
    });
  } };
}

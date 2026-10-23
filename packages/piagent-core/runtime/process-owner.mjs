import { execFileSync } from 'node:child_process';
import os from 'node:os';

// Whether the process that wrote a lock or a capture at `since` (ms) still
// holds it. A live process number alone is not enough: after a reboot, or
// once the number is reused, an unrelated process would hold the lock forever.
// So the owner must have started before the record and after the last boot.
export function ownerAlive(pid, since, { now = Date.now(), uptime = os.uptime(), started = processStart } = {}) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (since < now - uptime * 1000) return false;
  const start = started(pid);
  return start === null || start <= since + 1000;
}
function processStart(pid) {
  try {
    const text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    const value = Date.parse(text);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

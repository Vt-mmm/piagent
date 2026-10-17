// Each event is its own durable file. The scope includes the source key and
// Studio authority; old unscoped JSONL files are deliberately never replayed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LIMIT = 2 * 1024 * 1024, LEASE_MS = 60_000;
export function memoryScope(origin, manifest) {
  const a = manifest?.authority;
  if (!manifest?.key_id || !manifest?.user?.id || !a?.studio_instance_id || !a?.dataset_epoch || !Number.isInteger(a.auth_generation)) return null;
  return { origin, key_id: manifest.key_id, user_id: manifest.user.id, studio_instance_id: a.studio_instance_id, dataset_epoch: a.dataset_epoch, auth_generation: a.auth_generation };
}
export const scopeID = scope => scope ? createHash('sha256').update(JSON.stringify(scope)).digest('hex') : null;

function syncDirectory(directory) {
  // Windows does not expose POSIX directory fsync through Node. The file is
  // still flushed before the atomic rename; server deduplication covers replay.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
    // Persist the directory entry as well as the payload (POSIX/WSL).
    syncDirectory(path.dirname(file));
  } finally { if (fd !== null && fd !== undefined) fs.closeSync(fd); try { fs.rmSync(tmp, { force: true }); } catch {} }
}

export class MemoryOutbox {
  constructor(stateDir, scope, now = Date.now) {
    this.scope = scopeID(scope); this.now = now; this.quarantined = 0;
    this.directory = stateDir && this.scope ? path.join(stateDir, 'memory-outbox-v2', this.scope) : null;
  }
  files() { try { return fs.readdirSync(this.directory).filter(n => UUID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).sort(); } catch { return []; } }
  put(item) {
    if (!this.directory || !UUID.test(item.event_id)) return false;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, `${item.event_id}.json`);
      if (fs.existsSync(file)) return JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).item) === JSON.stringify(item);
      const size = fs.readdirSync(this.directory).filter(n => !n.endsWith('.lock')).reduce((n, f) => { try { return n + fs.statSync(path.join(this.directory, f)).size; } catch { return n; } }, 0);
      if (size + Buffer.byteLength(JSON.stringify(item)) > LIMIT) return false;
      // link is exclusive: concurrent producers never overwrite an event.
      const tmp = path.join(this.directory, `${randomUUID()}.tmp`);
      try {
        atomic(tmp, { scope: this.scope, item, attempts: 0, next_at: 0 });
        fs.linkSync(tmp, file);
        syncDirectory(this.directory);
      } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
      return true;
    } catch { return false; }
  }
  // A crashed consumer leaves the event intact; the short claim expires.
  claim(name) {
    if (!this.directory || !this.files().includes(name)) return null;
    const file = path.join(this.directory, name), lock = `${file}.lock`;
    let owned = false;
    try {
      try { fs.mkdirSync(lock, { mode: 0o700 }); }
      catch {
        if (this.now() - fs.statSync(lock).mtimeMs < LEASE_MS) return null;
        fs.rmdirSync(lock); fs.mkdirSync(lock, { mode: 0o700 });
      }
      owned = true;
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { try { fs.renameSync(file, `${file}.quarantine`); this.quarantined++; } catch {} fs.rmdirSync(lock); return null; }
      if (record.scope !== this.scope || !UUID.test(record.item?.event_id) || name !== `${record.item.event_id}.json`) {
        fs.renameSync(file, `${file}.quarantine`); this.quarantined++; fs.rmdirSync(lock); return null;
      }
      if (record.attempts >= 30 || this.now() - Date.parse(record.item.occurred_at) > 30 * 86400_000) { fs.renameSync(file, `${file}.quarantine`); this.quarantined++; fs.rmdirSync(lock); return null; }
      if (record.next_at > this.now()) { fs.rmdirSync(lock); return null; }
      return { file, lock, record };
    } catch { if (owned) try { fs.rmdirSync(lock); } catch {} return null; }
  }
  finish(claim, outcome) {
    try {
      if (outcome === 'ack' || outcome === 'discard') fs.rmSync(claim.file, { force: true });
      else if (outcome === 'quarantine') fs.renameSync(claim.file, `${claim.file}.quarantine`);
      else {
        const attempts = (claim.record.attempts || 0) + 1;
        atomic(claim.file, { ...claim.record, attempts, next_at: this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(attempts - 1, 6)) });
      }
      syncDirectory(this.directory);
    } finally { try { fs.rmdirSync(claim.lock); } catch {} }
  }
}

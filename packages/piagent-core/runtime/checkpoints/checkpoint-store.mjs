import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensurePrivateStateDirectory, resolveLocalStatePath } from '../../extensions/local-state-path.js';

export const MAX_CHECKPOINTS = 64;
const MAX_BYTES = 128 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

export function checkpointPoint(value) {
  if (!exact(value, ['id', 'turnRef', 'before', 'after', 'at']) || !id(value.id)
    || typeof value.turnRef !== 'string' || !value.turnRef.length || value.turnRef.length > 160 || /[\x00-\x1f]/.test(value.turnRef)
    || !oid(value.before) || !oid(value.after) || value.before.length !== value.after.length
    || !Number.isSafeInteger(value.at) || value.at < 0) throw Error('checkpoint-state-invalid');
  return { ...value };
}

function refPoint(value) {
  if (value?.after !== null) return checkpointPoint(value);
  checkpointPoint({ ...value, after: value.before });
  return { ...value };
}
function captureRecord(value) {
  if (value === null) return null;
  if (!exact(value, ['point', 'pid', 'token']) || !Number.isInteger(value.pid) || value.pid <= 1 || !id(value.token)
    || value.point?.after !== null) throw Error('checkpoint-state-invalid');
  return { point: refPoint(value.point), pid: value.pid, token: value.token };
}

const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function privateFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES
    || typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))
    throw Error('checkpoint-state-not-private');
}

// A small synchronous CAS transaction keeps every read/write inside the same
// owner-only directory. The lock also rejects a second process with stale state.
export class CheckpointStore {
  #operation = null;
  constructor(projectRoot, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 4096) throw Error('checkpoint-session-invalid');
    this.root = fs.realpathSync(projectRoot);
    this.key = hash(`${this.root}\0${sessionId}`);
    this.directory = path.join(this.root, '.pi', 'piagent-state', 'checkpoints');
    this.file = path.join(this.directory, `${this.key}.json`);
    this.lock = path.join(this.directory, `${this.key}.lock`);
  }
  #safe(file, kind) { return resolveLocalStatePath(this.root, file, { label: 'Checkpoint state', kind }); }
  #read(file) {
    const safe = this.#safe(file, 'file');
    const fd = fs.openSync(safe, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd); privateFile(before);
      const bytes = fs.readFileSync(fd);
      if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(this.#safe(file, 'file')))) throw Error('checkpoint-state-changed');
      return { bytes, stat: before };
    } finally { fs.closeSync(fd); }
  }
  load() {
    let bytes;
    try { ({ bytes } = this.#read(this.file)); }
    catch (error) { if (error.code === 'ENOENT') return { revision: 'absent', points: [] }; throw error; }
    const value = JSON.parse(bytes.toString('utf8'));
    if (!(value.version === 1 && exact(value, ['version', 'sessionKey', 'points'])
      || value.version === 2 && exact(value, ['version', 'sessionKey', 'points', 'retired'])
      || value.version === 3 && exact(value, ['version', 'sessionKey', 'points', 'retired', 'staged'])
      || value.version === 4 && exact(value, ['version', 'sessionKey', 'points', 'retired', 'staged', 'capture'])) || value.sessionKey !== this.key
      || !Array.isArray(value.points) || value.points.length > MAX_CHECKPOINTS) throw Error('checkpoint-state-invalid');
    const points = value.points.map(checkpointPoint);
    if (new Set(points.map(point => point.id)).size !== points.length) throw Error('checkpoint-state-invalid');
    const retired = value.version === 1 ? [] : value.retired;
    if (!Array.isArray(retired) || retired.length > MAX_CHECKPOINTS + 1) throw Error('checkpoint-state-invalid');
    const checkedRetired = retired.map(refPoint), ids = new Set(points.map(point => point.id));
    for (const point of checkedRetired) {
      if (ids.has(point.id)) throw Error('checkpoint-state-invalid');
      ids.add(point.id);
    }
    const staged = value.version >= 3 ? value.staged : [];
    if (!Array.isArray(staged) || staged.length > MAX_CHECKPOINTS + 1) throw Error('checkpoint-state-invalid');
    const checkedStaged = staged.map(checkpointPoint);
    for (const point of checkedStaged) {
      if (ids.has(point.id)) throw Error('checkpoint-state-invalid');
      ids.add(point.id);
    }
    const capture = value.version === 4 ? captureRecord(value.capture) : null;
    if (capture && ids.has(capture.point.id)) throw Error('checkpoint-state-invalid');
    return { revision: hash(bytes), points, retired: checkedRetired, staged: checkedStaged, capture };
  }
  #acquire() {
    ensurePrivateStateDirectory(this.root, this.directory, 'Checkpoint directory');
    const directory = fs.statSync(this.#safe(this.directory, 'directory'));
    if (typeof process.getuid === 'function' && (directory.uid !== process.getuid() || (directory.mode & 0o077)))
      throw Error('checkpoint-state-not-private');
    const target = this.#safe(this.lock);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(target, 'wx', 0o600);
        const token = randomUUID();
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
        finally { fs.closeSync(fd); }
        const assertOwner = () => {
          const current = this.#read(this.lock);
          if (JSON.parse(current.bytes).token !== token) throw Error('checkpoint-lock-changed');
        };
        return { assertOwner, release: () => { assertOwner(); fs.unlinkSync(this.#safe(this.lock, 'file')); } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const current = this.#read(this.lock), owner = JSON.parse(current.bytes);
        if (!exact(owner, ['pid', 'token']) || !Number.isInteger(owner.pid) || owner.pid <= 1 || !id(owner.token)) throw Error('checkpoint-lock-invalid');
        try { process.kill(owner.pid, 0); throw Error('checkpoint-store-busy'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        if (!same(current.stat, fs.lstatSync(this.#safe(this.lock, 'file')))) throw Error('checkpoint-lock-changed');
        fs.unlinkSync(this.lock);
      }
    }
    throw Error('checkpoint-store-busy');
  }
  // Hold the same lock through asynchronous Git effects and the final CAS save.
  // A second process must refuse before touching files, not only when saving.
  async operation(action) {
    if (this.#operation) throw Error('checkpoint-store-busy');
    const owner = this.#acquire();
    this.#operation = owner;
    try { return await action(); }
    finally { this.#operation = null; owner.release(); }
  }
  save(points, expectedRevision, { clearRetired = false, staged = [], capture = undefined } = {}) {
    if (!Array.isArray(points) || points.length > MAX_CHECKPOINTS + 1) throw Error('checkpoint-state-limit');
    if (!Array.isArray(staged) || staged.length > MAX_CHECKPOINTS + 1) throw Error('checkpoint-state-limit');
    const checkedStaged = staged.map(checkpointPoint);
    const checked = points.map(checkpointPoint);
    if (new Set(checked.map(point => point.id)).size !== checked.length) throw Error('checkpoint-state-invalid');
    const retained = checked.slice(-MAX_CHECKPOINTS), dropped = checked.slice(0, -MAX_CHECKPOINTS);
    const owner = this.#operation ?? this.#acquire();
    owner.assertOwner();
    let temporary;
    try {
      const previous = this.load();
      if (previous.revision !== expectedRevision) throw Error('checkpoint-state-stale');
      const nextCapture = capture === undefined ? previous.capture ?? null : captureRecord(capture);
      const promotedIds = new Set([...retained, ...checkedStaged].map(point => point.id));
      const abandoned = previous.capture && previous.capture.point.id !== nextCapture?.point.id
        && !promotedIds.has(previous.capture.point.id) ? [previous.capture.point] : [];
      const retainedIds = new Set(retained.map(point => point.id));
      const retired = [...new Map([...(clearRetired ? [] : previous.retired ?? []), ...(clearRetired ? [] : previous.staged ?? []), ...previous.points, ...dropped, ...abandoned]
        .filter(point => !retainedIds.has(point.id)).map(point => [point.id, point])).values()];
      if (retired.length > MAX_CHECKPOINTS + 1) throw Error('checkpoint-state-limit');
      const ids = new Set([...retained, ...retired].map(point => point.id));
      for (const point of checkedStaged) {
        if (ids.has(point.id)) throw Error('checkpoint-state-invalid');
        ids.add(point.id);
      }
      if (nextCapture && ids.has(nextCapture.point.id)) throw Error('checkpoint-state-invalid');
      const bytes = Buffer.from(JSON.stringify({ version: 4, sessionKey: this.key, points: retained, retired, staged: checkedStaged, capture: nextCapture }) + '\n');
      if (bytes.length > MAX_BYTES) throw Error('checkpoint-state-limit');
      temporary = this.#safe(path.join(this.directory, `${this.key}.${randomUUID()}.tmp`));
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Revalidate ancestors and destination after writing the private temp file.
      const target = this.#safe(this.file);
      if (this.load().revision !== expectedRevision) throw Error('checkpoint-state-stale');
      fs.renameSync(this.#safe(temporary, 'file'), target); temporary = null;
      if (process.platform !== 'win32') {
        const directory = fs.openSync(this.#safe(this.directory, 'directory'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      return { revision: hash(bytes), points: retained, dropped, retired, staged: checkedStaged, capture: nextCapture };
    } finally {
      if (temporary) fs.unlinkSync(this.#safe(temporary, 'file'));
      if (owner !== this.#operation) owner.release();
    }
  }
}

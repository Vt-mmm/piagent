import type { CheckpointCommand } from '../../contracts/generated/checkpoint-v1.ts';
const key = 'piagent.checkpoint.pending.v1';
const limit = 64;
// Tab-scoped storage survives reload without sharing dispatch ownership between
// tabs. Never evict an unresolved operation to make room for a new one.
function read(storage: Storage): Record<string, CheckpointCommand> {
  const raw = storage.getItem(key);
  if (raw === null) return Object.create(null);
  if (raw.length > 256 * 1024) throw Error('checkpoint-pending-invalid');
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > limit) throw Error('checkpoint-pending-invalid');
  const records: Record<string, CheckpointCommand> = Object.create(null);
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw Error('checkpoint-pending-invalid');
    const [session, command] = entry;
    if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(session)
      || records[session] || !command || command.schemaVersion !== 1 || command.version !== 'piagent-webui-checkpoint-v1'
      || command.messageType !== 'command' || command.action !== 'checkpoint.restore' || command.identity?.sessionRef !== session
      || command.payload?.confirmed !== true || typeof command.payload.targetId !== 'string'
      || typeof command.commandId !== 'string' || typeof command.idempotencyKey !== 'string') throw Error('checkpoint-pending-invalid');
    records[session] = command;
  }
  return records;
}
export function pendingCheckpoint(session: string, storage: Storage = window.sessionStorage): CheckpointCommand | undefined {
  return read(storage)[session];
}
export function savePendingCheckpoint(session: string, command: CheckpointCommand, storage: Storage = window.sessionStorage) {
  const records = read(storage), existing = records[session];
  if (existing && JSON.stringify(existing) !== JSON.stringify(command)) throw Error('checkpoint-pending-exists');
  if (!existing && Object.keys(records).length >= limit) throw Error('checkpoint-pending-capacity');
  if (command.identity.sessionRef !== session) throw Error('checkpoint-pending-session');
  records[session] = command;
  const raw = JSON.stringify(Object.entries(records));
  if (raw.length > 256 * 1024) throw Error('checkpoint-pending-capacity');
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw Error('checkpoint-pending-write-failed');
}
export function clearPendingCheckpoint(session: string, command: CheckpointCommand, storage: Storage = window.sessionStorage) {
  const records = read(storage);
  if (!records[session]) return;
  if (JSON.stringify(records[session]) !== JSON.stringify(command)) throw Error('checkpoint-pending-replaced');
  delete records[session]; storage.setItem(key, JSON.stringify(Object.entries(records)));
}

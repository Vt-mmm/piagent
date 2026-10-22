import type { CheckpointCommand, CheckpointPreview, CheckpointReceipt, CheckpointState } from '../../contracts/generated/checkpoint-v1.ts';
import { browserCsrfToken, csrfFetch, noteUnauthorized } from './bootstrap.ts';
const endpoint = (session: string) => `/api/v1/sessions/${encodeURIComponent(session)}/checkpoints`;
const VERSION = 'piagent-webui-checkpoint-v1';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function sha(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
const paths = (value: unknown) => Array.isArray(value) && value.length <= 10000 && value.every(item => text(item, 4096));
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function validIdentity(value: CheckpointState['identity']) {
  return value && ['projectRef', 'runtimeInstanceId', 'sessionRef'].every(key => typeof value[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(value[key]))
    && ['taskId', 'taskRunId', 'agentOperationId', 'toolCallId'].every(key => value[key] === null || typeof value[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/.test(value[key]));
}
function validPreview(value: CheckpointPreview) {
  return uuid(value.targetId) && ['ready', 'conflict', 'busy', 'none', 'unavailable'].includes(value.result)
    && (value.previewDigest === null || hash(value.previewDigest))
    && (value.tree === null || typeof value.tree === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.tree))
    && Array.isArray(value.steps) && value.steps.length <= 64
    && value.steps.every(step => step && uuid(step.id) && text(step.turnRef, 256) && paths(step.restore) && paths(step.remove))
    && paths(value.files) && paths(value.conflicts) && (value.stoppedAt === null || uuid(value.stoppedAt));
}
async function read<T extends CheckpointState | CheckpointPreview>(session: string, target: string | null, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint(session) + (target ? `/${encodeURIComponent(target)}` : ''), { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw Error('checkpoint-unavailable');
  const value = await response.json() as T;
  if (!value || value.schemaVersion !== 1 || value.version !== VERSION || value.identity?.sessionRef !== session
    || !validIdentity(value.identity) || value.messageType !== (target ? 'preview' : 'state') || !/^[a-f0-9]{64}$/.test(value.revisions?.checkpointRevision ?? '')) throw Error('checkpoint-response-invalid');
  if (value.messageType === 'state' && (typeof value.available !== 'boolean' || typeof value.agentRunning !== 'boolean'
    || !Array.isArray(value.points) || value.points.length > 64 || !value.points.every(point => point && uuid(point.id)
      && text(point.turnRef, 256) && Number.isSafeInteger(point.at) && point.at >= 0))) throw Error('checkpoint-response-invalid');
  if (value.messageType === 'preview' && (value.targetId !== target || !validPreview(value))) throw Error('checkpoint-response-invalid');
  return value;
}
export const readCheckpoints = (session: string, signal?: AbortSignal) => read<CheckpointState>(session, null, signal);
export const previewCheckpoint = (session: string, target: string, signal?: AbortSignal) => read<CheckpointPreview>(session, target, signal);
export async function checkpointCommand(preview: CheckpointPreview): Promise<CheckpointCommand> {
  if (!validPreview(preview) || !validIdentity(preview.identity) || !hash(preview.revisions?.checkpointRevision) || !preview.previewDigest || !preview.tree || !preview.steps.length || !['ready', 'conflict'].includes(preview.result)) throw Error('checkpoint-preview-unavailable');
  const now = Date.now(), action = 'checkpoint.restore', identity = { ...preview.identity }, expectedRevisions = { ...preview.revisions };
  const payload = { targetId: preview.targetId, previewDigest: preview.previewDigest, expectedTree: preview.tree, confirmed: true as const };
  return { schemaVersion: 1, version: VERSION, messageType: 'command', action, identity, expectedRevisions, payload,
    commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    actionDigest: await sha(canonical({ action, identity, expectedRevisions, payload })) };
}
async function validCommand(command: CheckpointCommand, session: string) {
  const { action, identity, expectedRevisions, payload } = command;
  return command.schemaVersion === 1 && command.version === VERSION && command.messageType === 'command'
    && action === 'checkpoint.restore' && validIdentity(identity) && identity.sessionRef === session
    && hash(expectedRevisions?.checkpointRevision) && payload?.confirmed === true && uuid(payload.targetId)
    && hash(payload.previewDigest) && typeof payload.expectedTree === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.expectedTree)
    && typeof command.commandId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(command.commandId)
    && typeof command.idempotencyKey === 'string' && /^[A-Za-z0-9._~-]{32,128}$/.test(command.idempotencyKey)
    && timestamp(command.requestedAt) && timestamp(command.expiresAt)
    && command.actionDigest === await sha(canonical({ action, identity, expectedRevisions, payload }));
}
export async function restoreCheckpoint(session: string, command: CheckpointCommand): Promise<CheckpointReceipt> {
  if (!await validCommand(command, session)) throw Error('checkpoint-command-invalid');
  const csrf = browserCsrfToken(); if (!csrf) throw Error('checkpoint-unavailable');
  const response = await csrfFetch(endpoint(session), { method: 'POST', credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Piagent-CSRF': csrf }, body: JSON.stringify(command) });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw Error('checkpoint-unavailable');
  const value = await response.json() as CheckpointReceipt;
  if (!value || value.schemaVersion !== 1 || value.version !== VERSION || value.messageType !== 'receipt'
    || value.commandId !== command.commandId || value.actionDigest !== command.actionDigest || value.action !== command.action
    || value.targetId !== command.payload.targetId || value.idempotencyKeyDigest !== await sha(command.idempotencyKey)
    || canonical(value.identity) !== canonical(command.identity) || !['settled', 'rejected', 'uncertain'].includes(value.phase)
    || !['restored', 'conflict', 'stale-revision', 'identity-mismatch', 'read-only', 'busy', 'unavailable', 'expired', 'idempotency-payload-mismatch', 'effect-unknown'].includes(value.resultCode)
    || value.requestedAt !== command.requestedAt || !timestamp(value.settledAt) || typeof value.deduplicated !== 'boolean'
    || !hash(value.observedRevisionsBefore?.checkpointRevision) || !hash(value.observedRevisionsAfter?.checkpointRevision)
    || !Array.isArray(value.completed) || value.completed.length > 64 || !value.completed.every(uuid)
    || !paths(value.files) || !paths(value.conflicts) || !(value.stoppedAt === null || uuid(value.stoppedAt))
    || (value.phase === 'uncertain') !== (value.resultCode === 'effect-unknown')
    || value.resultCode === 'restored' && value.phase !== 'settled') throw Error('checkpoint-receipt-invalid');
  return value;
}

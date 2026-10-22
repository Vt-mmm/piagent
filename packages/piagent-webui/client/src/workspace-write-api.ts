import type { WorkspaceWriteState, WorkspaceWriteCommand, WorkspaceWritePayload, WorkspaceWriteReceipt } from '../../contracts/generated/workspace-write-v1.ts';
import { browserCsrfToken, csrfFetch, noteUnauthorized } from './bootstrap.ts';
const endpoint = (session: string) => `/api/v1/sessions/${encodeURIComponent(session)}/workspace/write`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function workspaceWriteState(session: string, signal?: AbortSignal): Promise<WorkspaceWriteState> {
  const response = await fetch(endpoint(session), { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw Error('workspace-write-unavailable');
  return await response.json();
}
export async function workspaceWriteCommand(state: WorkspaceWriteState, payload: WorkspaceWritePayload): Promise<WorkspaceWriteCommand> {
  const now = Date.now(), action = 'workspace.write', identity = state.identity, expectedRevisions = state.revisions;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ action, identity, expectedRevisions, payload })));
  return { schemaVersion: 1, version: 'piagent-webui-workspace-write-v1', messageType: 'command', action, identity, expectedRevisions, payload,
    commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    actionDigest: `sha256:${[...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')}` };
}
export async function saveWorkspaceFile(session: string, command: WorkspaceWriteCommand): Promise<WorkspaceWriteReceipt> {
  const csrf = browserCsrfToken(); if (!csrf) throw Error('workspace-write-unavailable');
  const response = await csrfFetch(endpoint(session), { method: 'POST', credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Piagent-CSRF': csrf }, body: JSON.stringify(command) });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw Error('workspace-write-unavailable');
  const receipt = await response.json() as WorkspaceWriteReceipt;
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(command.idempotencyKey));
  const keyDigest = `sha256:${[...new Uint8Array(keyBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (receipt.schemaVersion !== 1 || receipt.version !== command.version || receipt.messageType !== 'receipt'
    || receipt.path !== command.payload.path || receipt.commandId !== command.commandId || receipt.action !== command.action || receipt.actionDigest !== command.actionDigest
    || receipt.idempotencyKeyDigest !== keyDigest || canonical(receipt.identity) !== canonical(command.identity)
    || !['settled', 'rejected', 'uncertain'].includes(receipt.phase)
    || receipt.phase === 'settled' && (receipt.resultCode !== 'saved' || !/^[a-f0-9]{64}$/.test(receipt.digest ?? '')))
    throw Error('workspace-write-receipt-invalid');
  return receipt;
}

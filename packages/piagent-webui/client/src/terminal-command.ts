import type { TerminalCommand, TerminalState } from '../../contracts/generated/terminal-v1.ts';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function terminalCommand(state: TerminalState, payload: TerminalCommand['payload']): Promise<TerminalCommand> {
  const now = Date.now(), action = 'terminal.command', identity = { ...state.identity }, expectedRevisions = { ...state.revisions };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ action, identity, expectedRevisions, payload })));
  return { schemaVersion: 1, version: 'piagent-terminal-v1', messageType: 'command', action, identity, expectedRevisions, payload,
    commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    actionDigest: `sha256:${[...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')}` };
}

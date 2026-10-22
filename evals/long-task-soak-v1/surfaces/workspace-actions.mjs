import { createHash, randomUUID } from 'node:crypto';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const requireThat = (condition, reason) => { if (!condition) throw Error(reason); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function command(state, action, version, payload) {
  const now = Date.now(), identity = state.identity, expectedRevisions = state.revisions;
  return { schemaVersion: 1, version, messageType: 'command', action, identity, expectedRevisions, payload,
    commandId: randomUUID(), idempotencyKey: randomUUID(), requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(), actionDigest: digest(canonical({ action, identity, expectedRevisions, payload })) };
}

function correlated(receipt, sent) {
  requireThat(receipt?.schemaVersion === 1 && receipt.version === sent.version && receipt.messageType === 'receipt'
    && receipt.commandId === sent.commandId && receipt.action === sent.action && receipt.actionDigest === sent.actionDigest
    && canonical(receipt.identity) === canonical(sent.identity), 'member-action-receipt-mismatch');
  requireThat(receipt.phase === 'settled', `member-action-${receipt.phase ?? 'invalid'}:${receipt.resultCode ?? receipt.reasonCode ?? 'unknown'}`);
}

// These are member operations through the same authenticated Gateway routes as
// the editor and terminal. No host filesystem or shell shortcut qualifies them.
export async function editWorkspace(surface, action) {
  requireThat(surface.sessionRef && typeof action.path === 'string' && typeof action.append === 'string', 'editor-action-invalid');
  const base = `/api/v1/sessions/${encodeURIComponent(surface.sessionRef)}`;
  const readPath = `${base}/inspection/workspace/file?${new URLSearchParams({ path: action.path })}`;
  const before = await surface.http('GET', readPath);
  requireThat(before.status === 200 && typeof before.value?.content === 'string' && typeof before.value.digest === 'string'
    && !before.value.protected && !before.value.readOnly && !before.value.binary && !before.value.oversized, 'editor-file-unavailable');
  const state = await surface.http('GET', `${base}/workspace/write`);
  requireThat(state.status === 200 && state.value?.writable, 'editor-write-unavailable');
  const content = before.value.content + action.append;
  const sent = command(state.value, 'workspace.write', 'piagent-webui-workspace-write-v1',
    { path: action.path, content, expectedDigest: before.value.digest });
  const result = await surface.http('POST', `${base}/workspace/write`, sent);
  requireThat(result.status === 200, `editor-write-http:${result.status}`);
  correlated(result.value, sent);
  requireThat(result.value.idempotencyKeyDigest === digest(sent.idempotencyKey) && result.value.resultCode === 'saved'
    && result.value.path === action.path, 'editor-write-not-saved');
  const after = await surface.http('GET', readPath);
  requireThat(after.status === 200 && after.value?.content === content && after.value.digest === result.value.digest,
    'editor-save-readback-mismatch');
  return { path: action.path, digest: result.value.digest };
}

export async function runTerminal(surface, action) {
  requireThat(surface.sessionRef && typeof action.command === 'string' && action.command.length > 0
    && action.command.length <= 12000, 'terminal-action-invalid');
  const timeout = Number(action.timeoutSec ?? 120);
  requireThat(Number.isFinite(timeout) && timeout > 0 && timeout <= 600, 'terminal-action-timeout-invalid');
  const buffers = new Map();
  const unsubscribe = surface.onTerminal(message => {
    if (message.messageType !== 'output' || message.identity?.sessionRef !== surface.sessionRef) return;
    if (!buffers.has(message.terminalRef) && buffers.size >= 4) return;
    buffers.set(message.terminalRef, ((buffers.get(message.terminalRef) ?? '') + message.data).slice(-65536));
  });
  const execute = async payload => {
    const state = await surface.gatewayRequest('terminals.state', { sessionRef: surface.sessionRef, csrfToken: surface.csrf });
    requireThat(state?.messageType === 'state' && state.available && state.identity?.sessionRef === surface.sessionRef,
      `terminal-unavailable:${state?.reasonCode ?? 'invalid-state'}`);
    const sent = command(state, 'terminal.command', 'piagent-terminal-v1', payload);
    const receipt = await surface.gatewayRequest('terminals.command', { command: sent, csrfToken: surface.csrf });
    correlated(receipt, sent);
    requireThat(receipt.idempotencyKey === sent.idempotencyKey, 'terminal-idempotency-mismatch');
    return receipt;
  };
  let terminalRef;
  try {
    const opened = await execute({ kind: 'open', cols: 100, rows: 30 });
    terminalRef = opened.terminalRef;
    requireThat(typeof terminalRef === 'string', 'terminal-open-missing-reference');
    const marker = `SOAK_${randomUUID().replaceAll('-', '')}`;
    // The shell echoes a format string, never the marker followed by a numeric
    // status; only execution can produce the completion witness.
    await execute({ kind: 'input', terminalRef,
      data: `( ${action.command} ); soak_status=$?; printf '\\n%s:%s\\n' '${marker}' "$soak_status"\n` });
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const match = buffers.get(terminalRef)?.match(new RegExp(`${marker}:(\\d+)`));
      if (match) {
        const exitCode = Number(match[1]);
        requireThat(exitCode === (action.expectedExitCode ?? 0), `terminal-command-exit:${exitCode}`);
        return { exitCode };
      }
      await wait(50);
    }
    throw Error('terminal-command-completion-timeout');
  } finally {
    try { if (terminalRef) await execute({ kind: 'close', terminalRef }); }
    finally { unsubscribe(); }
  }
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const ref = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(value);
const exact = (value: Record<string, any>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
export function isTerminalMessage(value: unknown): boolean {
  if (!object(value) || value.schemaVersion !== 1 || value.version !== 'piagent-terminal-v1' || !object(value.identity)
    || !exact(value.identity, ['gatewayInstanceRef', 'runtimeInstanceRef', 'sessionRef'])
    || !['gatewayInstanceRef', 'runtimeInstanceRef', 'sessionRef'].every(key => ref(value.identity[key]))) return false;
  const base = ['schemaVersion', 'version', 'messageType', 'identity'];
  if (value.messageType === 'state') return exact(value, [...base, 'revisions', 'available', 'reasonCode', 'terminals'])
    && object(value.revisions) && exact(value.revisions, ['terminalRevision']) && typeof value.revisions.terminalRevision === 'string'
    && typeof value.available === 'boolean' && (value.reasonCode === null || typeof value.reasonCode === 'string')
    && Array.isArray(value.terminals) && value.terminals.length <= 4 && value.terminals.every((tab: unknown) => object(tab)
      && exact(tab, ['terminalRef', 'number', 'state', 'cols', 'rows', 'sequence', 'exitCode'])
      && ref(tab.terminalRef) && Number.isSafeInteger(tab.number) && tab.number > 0 && ['running', 'exited'].includes(tab.state)
      && Number.isSafeInteger(tab.sequence) && tab.sequence >= 0 && Number.isInteger(tab.cols) && tab.cols >= 2 && tab.cols <= 500
      && Number.isInteger(tab.rows) && tab.rows >= 1 && tab.rows <= 200 && (tab.exitCode === null || Number.isInteger(tab.exitCode)));
  if (!ref(value.terminalRef) || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return false;
  if (value.messageType === 'output') return exact(value, [...base, 'terminalRef', 'sequence', 'data', 'replay', 'reset', 'complete', 'truncated'])
    && typeof value.data === 'string' && value.data.length <= 8192
    && ['replay', 'reset', 'complete', 'truncated'].every(key => typeof value[key] === 'boolean');
  return value.messageType === 'exit' && exact(value, [...base, 'terminalRef', 'sequence', 'exitCode', 'signal'])
    && (value.exitCode === null || Number.isInteger(value.exitCode)) && (value.signal === null || Number.isInteger(value.signal));
}

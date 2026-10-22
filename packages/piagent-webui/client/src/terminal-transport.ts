import type { TerminalCommand, TerminalReceipt, TerminalState, TerminalOutput, TerminalExit } from '../../contracts/generated/terminal-v1.ts';
import { browserCsrfToken } from './bootstrap.ts';
export type TerminalMessage = TerminalState | TerminalOutput | TerminalExit;
type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const ref = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(value);
export function terminalMessage(value: unknown): value is TerminalMessage {
  if (!object(value) || value.schemaVersion !== 1 || value.version !== 'piagent-terminal-v1' || !object(value.identity)
    || !['gatewayInstanceRef', 'runtimeInstanceRef', 'sessionRef'].every(key => ref(value.identity[key]))) return false;
  if (value.messageType === 'state') return object(value.revisions) && typeof value.revisions.terminalRevision === 'string'
    && typeof value.available === 'boolean' && (value.reasonCode === null || typeof value.reasonCode === 'string')
    && Array.isArray(value.terminals) && value.terminals.length <= 4 && value.terminals.every((tab: unknown) => object(tab)
      && ref(tab.terminalRef) && Number.isSafeInteger(tab.number) && tab.number > 0 && ['running', 'exited'].includes(tab.state)
      && Number.isSafeInteger(tab.sequence) && tab.sequence >= 0 && Number.isInteger(tab.cols) && tab.cols >= 2 && tab.cols <= 500
      && Number.isInteger(tab.rows) && tab.rows >= 1 && tab.rows <= 200 && (tab.exitCode === null || Number.isInteger(tab.exitCode)));
  if (!ref(value.terminalRef) || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return false;
  if (value.messageType === 'output') return typeof value.data === 'string' && value.data.length <= 8192
    && ['replay', 'reset', 'complete', 'truncated'].every(key => typeof value[key] === 'boolean');
  return value.messageType === 'exit' && Number.isInteger(value.exitCode) && (value.signal === null || Number.isInteger(value.signal));
}
export class TerminalTransport {
  #socket: WebSocket | null = null;
  #ready = false;
  readonly #pending = new Map<string, Pending>();
  readonly #messages = new Set<(message: TerminalMessage) => void>();
  readonly #connections = new Set<(ready: boolean) => void>();
  readonly #csrf: () => string | null;
  constructor(csrf = browserCsrfToken) { this.#csrf = csrf; }
  get ready() { return this.#ready; }
  #connection(ready: boolean) { this.#ready = ready; for (const listener of this.#connections) listener(ready); }
  attach(socket: WebSocket) {
    this.#disconnect(); this.#socket = socket;
    socket.addEventListener('message', event => {
      if (socket !== this.#socket) return;
      let value: unknown; try { value = JSON.parse(String(event.data)); } catch { return; }
      if (!object(value)) return;
      if (value.messageType === 'hello' && value.version === 'piagent-gateway-protocol-v1') { this.#connection(true); return; }
      if (value.messageType === 'response' && value.version === 'piagent-gateway-protocol-v1') {
        const pending = this.#pending.get(value.requestId); if (!pending) return;
        this.#pending.delete(value.requestId); clearTimeout(pending.timer);
        if (value.method !== pending.method) pending.reject(Error('terminal-response-invalid'));
        else if (value.ok === true) pending.resolve(value.result);
        else pending.reject(Error(String(value.error?.code ?? 'terminal-request-failed')));
        return;
      }
      if (terminalMessage(value)) for (const listener of this.#messages) listener(value);
    });
    socket.addEventListener('close', () => { if (socket === this.#socket) this.#disconnect(); });
  }
  #disconnect() {
    this.#socket = null; this.#connection(false);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('terminal-connection-lost')); }
    this.#pending.clear();
  }
  subscribe(listener: (message: TerminalMessage) => void) { this.#messages.add(listener); return () => { this.#messages.delete(listener); }; }
  connection(listener: (ready: boolean) => void) { this.#connections.add(listener); return () => { this.#connections.delete(listener); }; }
  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.#socket, csrfToken = this.#csrf();
    if (!this.#ready || !socket || socket.readyState !== 1 || !csrfToken) return Promise.reject(Error('terminal-not-connected'));
    if (this.#pending.size >= 64) return Promise.reject(Error('terminal-request-capacity'));
    const requestId = `terminal_${crypto.randomUUID().replaceAll('-', '')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(Error('terminal-response-timeout')); }, 15000);
      this.#pending.set(requestId, { method, resolve, reject, timer });
      try { socket.send(JSON.stringify({ schemaVersion: 1, version: 'piagent-gateway-protocol-v1', messageType: 'request', requestId, method,
        params: { ...params, csrfToken } })); }
      catch { clearTimeout(timer); this.#pending.delete(requestId); reject(Error('terminal-send-failed')); }
    });
  }
  async state(sessionRef: string): Promise<TerminalState> {
    const value = await this.#request('terminals.state', { sessionRef });
    if (!terminalMessage(value) || value.messageType !== 'state' || value.identity.sessionRef !== sessionRef) throw Error('terminal-state-invalid');
    return value;
  }
  async execute(command: TerminalCommand): Promise<TerminalReceipt> {
    const value = await this.#request('terminals.command', { command });
    if (!object(value) || value.schemaVersion !== 1 || value.version !== command.version || value.messageType !== 'receipt'
      || value.commandId !== command.commandId || value.idempotencyKey !== command.idempotencyKey || value.actionDigest !== command.actionDigest
      || value.action !== command.action || !object(value.identity) || !Object.entries(command.identity).every(([key, item]) => value.identity[key] === item)
      || !object(value.observedRevisions) || typeof value.observedRevisions.terminalRevision !== 'string'
      || !['settled', 'rejected', 'uncertain'].includes(value.phase) || typeof value.deduplicated !== 'boolean'
      || !(value.terminalRef === null || ref(value.terminalRef)) || !(value.reasonCode === null || typeof value.reasonCode === 'string'))
      throw Error('terminal-receipt-invalid');
    return value as TerminalReceipt;
  }
}
export const terminalTransport = new TerminalTransport();

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { TerminalCommand, TerminalReceipt, TerminalState, TerminalSummary } from '../contracts/generated/terminal-v1.ts';
import type { TerminalStreamMessage } from '../server/terminal-websocket-stream.ts';
import { isTerminalMessage } from '../shared/terminal-message.ts';
import { CompanyTerminalCache } from './company-terminal-cache.ts';

export type CompanyTerminalLink = { origin: string; cookie: string; csrf: string };
type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout;
  replay?: Map<string, number>; result?: TerminalState };

export class CompanyTerminalChannel {
  readonly cache = new CompanyTerminalCache();
  readonly #socket: WebSocket;
  readonly #ref: string;
  readonly #csrf: string;
  readonly #emit: (message: TerminalStreamMessage) => void;
  readonly #pending = new Map<string, Pending>();
  readonly ready: Promise<void>;
  #read: Promise<TerminalState> | null = null;
  #closed = false;
  get closed() { return this.#closed; }
  constructor(ref: string, link: CompanyTerminalLink, emit: (message: TerminalStreamMessage) => void, disconnected: () => void) {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(link.origin)) throw Error('company-gateway-invalid');
    this.#ref = ref; this.#csrf = link.csrf; this.#emit = emit;
    const ws = this.#socket = new WebSocket(`${link.origin.replace('http:', 'ws:')}/api/v1/gateway`, 'piagent.gateway.v1',
      { headers: { Origin: link.origin, Cookie: link.cookie }, maxPayload: 70_000, perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => {
      let hello = false;
      const timer = setTimeout(() => { reject(Error('company-terminal-connect-timeout')); ws.terminate(); }, 5000);
      ws.on('open', () => ws.send(JSON.stringify({ schemaVersion: 1, version: 'piagent-gateway-protocol-v1', messageType: 'connect',
        clientRef: 'dashboard-company-terminal', minimumProtocol: 1, maximumProtocol: 1, lastEventSequence: null, catalogRevision: null })));
      ws.on('message', data => {
        try {
          const frame = JSON.parse(String(data));
          if (!hello && frame.version === 'piagent-gateway-protocol-v1' && frame.messageType === 'hello') {
            hello = true; clearTimeout(timer); resolve(); return;
          }
          if (!hello) throw Error();
          this.#message(frame);
        } catch { ws.close(1008, 'company-terminal-protocol-invalid'); }
      });
      ws.on('error', () => {});
      ws.once('close', () => {
        clearTimeout(timer); this.#closed = true;
        reject(Error('company-terminal-disconnected'));
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('company-terminal-disconnected')); }
        this.#pending.clear();
        const state = this.cache.disconnected(); if (state) this.#emit(state);
        disconnected();
      });
    });
  }
  #message(frame: any) {
    if (frame.version === 'piagent-gateway-protocol-v1') {
      if (frame.messageType !== 'response') return; // General session events are owned by CompanyRelay.
      const pending = this.#pending.get(frame.requestId); if (!pending) return;
      if (frame.method !== pending.method) throw Error();
      if (frame.ok !== true) {
        clearTimeout(pending.timer); this.#pending.delete(frame.requestId);
        pending.reject(Error('company-terminal-request-rejected')); return;
      }
      if (pending.method === 'terminals.state') {
        if (!isTerminalMessage(frame.result) || frame.result.messageType !== 'state' || frame.result.identity.sessionRef !== this.#ref) throw Error();
        const state = frame.result as TerminalState; this.cache.accept(state); this.#emit(state);
        pending.result = state; pending.replay = new Map((state.terminals as readonly TerminalSummary[]).map(tab => [tab.terminalRef, tab.sequence]));
        if (pending.replay.size) return;
      }
      clearTimeout(pending.timer); this.#pending.delete(frame.requestId); pending.resolve(frame.result); return;
    }
    if (!isTerminalMessage(frame) || frame.identity.sessionRef !== this.#ref) throw Error();
    const message = frame as TerminalStreamMessage;
    this.cache.accept(message); this.#emit(message);
    if (message.messageType === 'output' && message.replay && message.complete) {
      for (const [id, pending] of this.#pending) if (pending.replay?.get(message.terminalRef) === message.sequence) {
        pending.replay.delete(message.terminalRef);
        if (!pending.replay.size) {
          clearTimeout(pending.timer); this.#pending.delete(id); pending.resolve(this.cache.state ?? pending.result);
        }
      }
    }
  }
  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) throw Error('company-terminal-disconnected');
    if (this.#pending.size >= 64 || this.#socket.bufferedAmount > 512 * 1024) throw Error('company-terminal-capacity');
    const requestId = `terminal_${randomUUID().replaceAll('-', '')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId); reject(Error('company-terminal-response-timeout')); this.#socket.terminate();
      }, 15000);
      this.#pending.set(requestId, { method, resolve, reject, timer });
      this.#socket.send(JSON.stringify({ schemaVersion: 1, version: 'piagent-gateway-protocol-v1', messageType: 'request',
        requestId, method, params: { ...params, csrfToken: this.#csrf } }), error => { if (error) this.#socket.terminate(); });
    });
  }
  state(): Promise<TerminalState> {
    this.#read ??= (this.#request('terminals.state', { sessionRef: this.#ref }) as Promise<TerminalState>).finally(() => { this.#read = null; });
    return this.#read;
  }
  async execute(command: TerminalCommand): Promise<TerminalReceipt> {
    if (command.identity.sessionRef !== this.#ref) throw Error('company-terminal-session-mismatch');
    const value = await this.#request('terminals.command', { command }) as TerminalReceipt;
    if (!value || value.schemaVersion !== 1 || value.version !== command.version || value.messageType !== 'receipt'
      || value.commandId !== command.commandId || value.idempotencyKey !== command.idempotencyKey || value.actionDigest !== command.actionDigest
      || value.action !== command.action || !value.identity || !Object.entries(command.identity).every(([key, item]) => (value.identity as any)[key] === item)
      || !value.observedRevisions || typeof value.observedRevisions.terminalRevision !== 'string'
      || !['settled', 'rejected', 'uncertain'].includes(value.phase) || typeof value.deduplicated !== 'boolean'
      || !(value.terminalRef === null || typeof value.terminalRef === 'string') || !(value.reasonCode === null || typeof value.reasonCode === 'string'))
      throw Error('company-terminal-receipt-invalid');
    // Project only contract fields; an accidental upstream private field cannot travel to the browser.
    return { schemaVersion: 1, version: value.version, messageType: 'receipt', commandId: value.commandId, idempotencyKey: value.idempotencyKey,
      action: value.action, actionDigest: value.actionDigest, identity: command.identity, observedRevisions: { terminalRevision: value.observedRevisions.terminalRevision },
      phase: value.phase, terminalRef: value.terminalRef, reasonCode: value.reasonCode, deduplicated: value.deduplicated };
  }
  close() { this.#closed = true; this.#socket.terminate(); }
}

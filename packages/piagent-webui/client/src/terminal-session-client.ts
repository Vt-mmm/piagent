import type { TerminalCommand, TerminalReceipt, TerminalState, TerminalSummary } from '../../contracts/generated/terminal-v1.ts';
import { terminalCommand } from './terminal-command.ts';
import { terminalTransport, type TerminalTransport } from './terminal-transport.ts';
export type TerminalClientState = { state: TerminalState | null; connected: boolean; error: string | null; pending: TerminalCommand | null; busy: boolean };
export class TerminalSessionClient {
  #snapshot: TerminalClientState;
  readonly #listeners = new Set<() => void>();
  readonly #transport: TerminalTransport;
  readonly sessionRef: string;
  #unsubscribe: (() => void) | null = null;
  #connection: (() => void) | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #queued = 0;
  #bytes = 0;
  #refresh: Promise<void> | null = null;
  constructor(sessionRef: string, transport = terminalTransport) {
    this.sessionRef = sessionRef; this.#transport = transport;
    this.#snapshot = { state: null, connected: transport.ready, error: null, pending: null, busy: false };
  }
  snapshot = () => this.#snapshot;
  get disposable() { return !this.#listeners.size && !this.#queued && !this.#snapshot.pending && !this.#snapshot.busy; }
  #set(value: Partial<TerminalClientState>) { this.#snapshot = { ...this.#snapshot, ...value }; for (const listener of this.#listeners) listener(); }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    if (!this.#unsubscribe) {
      this.#unsubscribe = this.#transport.subscribe(message => {
        if (message.messageType === 'state' && message.identity.sessionRef === this.sessionRef) this.#set({ state: message });
      });
      this.#connection = this.#transport.connection(connected => { if (!connected) this.#generation++; this.#set({ connected }); if (connected) void this.refresh(); });
      this.#set({ connected: this.#transport.ready });
      if (this.#transport.ready) void this.refresh();
    }
    return () => { this.#listeners.delete(listener); if (!this.#listeners.size) {
      this.#unsubscribe?.(); this.#connection?.(); this.#unsubscribe = null; this.#connection = null;
    } };
  };
  refresh = (): Promise<void> => {
    if (this.#refresh) return this.#refresh;
    this.#refresh = this.#transport.state(this.sessionRef).then(state => this.#set({ state }), error => {
      this.#set({ error: error instanceof Error ? error.message : 'terminal-unavailable' });
    }).finally(() => { this.#refresh = null; });
    return this.#refresh;
  };
  error = (error: string) => this.#set({ error });
  acknowledge = () => { if (!this.#snapshot.busy) { this.#generation++; this.#set({ pending: null, error: null }); } };
  async #send(command: TerminalCommand): Promise<TerminalReceipt> {
    this.#set({ pending: command });
    const receipt = await this.#transport.execute(command);
    const state = this.#snapshot.state;
    if (state && state.identity.runtimeInstanceRef === receipt.identity.runtimeInstanceRef && state.identity.gatewayInstanceRef === receipt.identity.gatewayInstanceRef)
      this.#set({ state: { ...state, revisions: receipt.observedRevisions } });
    if (receipt.phase !== 'settled') this.#generation++;
    if (receipt.phase === 'uncertain') { this.#set({ error: receipt.reasonCode ?? 'terminal-effect-uncertain' }); return receipt; }
    this.#set({ pending: null, error: receipt.phase === 'rejected' ? receipt.reasonCode ?? 'terminal-command-rejected' : null });
    return receipt;
  }
  execute(payload: TerminalCommand['payload']) {
    const bytes = payload.kind === 'input' ? new TextEncoder().encode(payload.data).length : 0;
    if (bytes > 16384 || this.#bytes + bytes > 65536 || this.#queued >= 64) { this.error('terminal-input-limit'); return Promise.resolve(); }
    if (!this.#snapshot.connected || this.#snapshot.pending && !this.#snapshot.busy) { this.error('terminal-command-unconfirmed'); return Promise.resolve(); }
    const generation = this.#generation;
    this.#bytes += bytes; this.#queued++;
    const run = this.#tail.then(async () => {
      if (generation !== this.#generation || this.#snapshot.pending || !this.#snapshot.connected) return;
      const state = this.#snapshot.state; if (!state?.available) return;
      if (payload.kind === 'resize') {
        const tab = (state.terminals as readonly TerminalSummary[]).find(tab => tab.terminalRef === payload.terminalRef);
        if (!tab || tab.cols === payload.cols && tab.rows === payload.rows) return;
      }
      this.#set({ busy: true });
      try { await this.#send(await terminalCommand(state, payload)); }
      catch (error) { this.#generation++; this.error(error instanceof Error ? error.message : 'terminal-effect-uncertain'); }
      finally { this.#set({ busy: false }); }
    }).finally(() => { this.#bytes -= bytes; this.#queued--; });
    this.#tail = run.catch(() => {}); return run;
  }
  retry = async () => {
    const command = this.#snapshot.pending;
    if (!command || this.#snapshot.busy || !this.#snapshot.connected) return;
    this.#set({ busy: true });
    try { await this.#send(command); }
    catch (error) { this.#generation++; this.error(error instanceof Error ? error.message : 'terminal-effect-uncertain'); }
    finally { this.#set({ busy: false }); }
  };
}
// Pending identities survive drawer/tab unmount, but never enter browser storage.
const clients = new Map<string, TerminalSessionClient>();
export function terminalSessionClient(ref: string) {
  let client = clients.get(ref);
  if (!client) {
    if (clients.size >= 64) {
      const removable = [...clients].find(([, value]) => value.disposable);
      if (!removable) throw Error('terminal-client-capacity');
      clients.delete(removable[0]);
    }
    client = new TerminalSessionClient(ref); clients.set(ref, client);
  }
  return client;
}

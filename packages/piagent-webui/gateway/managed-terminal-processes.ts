import { randomUUID } from 'node:crypto';
import type { managedTerminalBinding, ManagedTerminalHandle, ManagedTerminalEvent } from './managed-terminal-binding.ts';
import type { TerminalProcessEvent, TerminalProcessOwner } from './terminal-sessions.ts';

type Binding = Awaited<ReturnType<typeof managedTerminalBinding>>;
type Entry = { binding: Binding; terminalRef: string; handle: ManagedTerminalHandle | null; active: boolean;
  pending: ManagedTerminalEvent[]; bytes: number; failed: boolean };

// This adapter has no shell/native import. Effects only reach the captured
// managed runtime's boundary, even if that boundary reports unavailable.
export class ManagedTerminalProcesses implements TerminalProcessOwner<Binding> {
  readonly #entries = new Map<string, Entry>();
  readonly #emit: (event: TerminalProcessEvent) => void;
  #closed = false;
  constructor(emit: (event: TerminalProcessEvent) => void) { this.#emit = emit; }
  reason(binding: Binding) { return binding.runtime.terminals.reasonCode; }
  async open(binding: Binding, size: { cols: number; rows: number }) {
    binding.assertCurrent();
    if (this.#closed) throw Error('terminal-session-closed');
    if (this.#entries.size >= 256 || [...this.#entries.values()].filter(entry => entry.binding.identity.sessionRef === binding.identity.sessionRef).length >= 4)
      throw Error('terminal-limit');
    const terminalRef = `terminal.${randomUUID()}`;
    const entry: Entry = { binding, terminalRef, handle: null, active: false, pending: [], bytes: 0, failed: false };
    this.#entries.set(terminalRef, entry);
    try {
      entry.handle = await binding.runtime.terminals.open(size, event => {
        if (entry.failed) return;
        if (entry.active) { this.#publish(entry, event); return; }
        entry.bytes += event.kind === 'output' ? Buffer.byteLength(event.data) : 64;
        if (entry.bytes > 512 * 1024 || entry.pending.length >= 256) { entry.failed = true; entry.pending = []; return; }
        entry.pending.push(event);
      });
      binding.assertCurrent();
      if (entry.failed || this.#closed) throw Error('terminal-start-unavailable');
      return { terminalRef, activate: () => {
        entry.active = true;
        for (const event of entry.pending) this.#publish(entry, event);
        entry.pending = []; entry.bytes = 0;
      } };
    } catch (error) {
      try { await entry.handle?.close(); } finally { this.#entries.delete(terminalRef); }
      throw error;
    }
  }
  #publish(entry: Entry, event: ManagedTerminalEvent) {
    try { entry.binding.assertCurrent(); } catch { return; }
    this.#emit({ ...event, sessionRef: entry.binding.identity.sessionRef, terminalRef: entry.terminalRef });
  }
  #get(ref: string, terminalRef: string) {
    const entry = this.#entries.get(terminalRef);
    if (!entry?.handle || entry.binding.identity.sessionRef !== ref) throw Error('terminal-not-found');
    return entry;
  }
  async input(ref: string, terminalRef: string, data: string) {
    const entry = this.#get(ref, terminalRef); entry.binding.assertCurrent();
    await entry.handle!.input(data);
  }
  async resize(ref: string, terminalRef: string, size: { cols: number; rows: number }) {
    const entry = this.#get(ref, terminalRef); entry.binding.assertCurrent();
    await entry.handle!.resize(size);
  }
  async close(ref: string, terminalRef: string) {
    const entry = this.#get(ref, terminalRef);
    await entry.handle!.close(); this.#entries.delete(terminalRef);
  }
  async closeSession(ref: string) {
    await Promise.all([...this.#entries.values()].filter(entry => entry.binding.identity.sessionRef === ref)
      .map(entry => this.close(ref, entry.terminalRef)));
  }
  async dispose() {
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map(entry => this.close(entry.binding.identity.sessionRef, entry.terminalRef)));
  }
}

import type { TerminalState, TerminalOutput, TerminalSummary } from '../contracts/generated/terminal-v1.ts';
import type { TerminalStreamMessage } from '../server/terminal-websocket-stream.ts';
import { TerminalOutputBuffer } from './terminal-output-buffer.ts';

const identityKey = (value: TerminalState['identity']) => JSON.stringify([value.gatewayInstanceRef, value.runtimeInstanceRef, value.sessionRef]);
type Entry = { buffer: TerminalOutputBuffer; sequence: number; truncated: boolean };
// The relay keeps only the same bounded, redacted replay the company Gateway
// provides. Live bytes never enter the durable event stream or browser storage.
export class CompanyTerminalCache {
  state: TerminalState | null = null;
  readonly #tabs = new Map<string, Entry>();
  accept(message: TerminalStreamMessage) {
    if (message.messageType === 'state') {
      if (this.state && identityKey(this.state.identity) !== identityKey(message.identity)) this.#tabs.clear();
      this.state = message;
      for (const ref of this.#tabs.keys()) if (!(message.terminals as readonly TerminalSummary[]).some(tab => tab.terminalRef === ref)) this.#tabs.delete(ref);
      return;
    }
    if (!this.state || identityKey(this.state.identity) !== identityKey(message.identity)) throw Error('company-terminal-identity-changed');
    let entry = this.#tabs.get(message.terminalRef);
    if (!entry) {
      if (this.#tabs.size >= 4) throw Error('company-terminal-capacity');
      entry = { buffer: new TerminalOutputBuffer(), sequence: 0, truncated: false }; this.#tabs.set(message.terminalRef, entry);
    }
    if (message.messageType === 'output') {
      if (message.replay && message.reset) { entry.buffer = new TerminalOutputBuffer(); entry.truncated = message.truncated; }
      else if (!message.replay && message.sequence <= entry.sequence) return;
      entry.buffer.append(message.data);
    }
    entry.sequence = message.sequence;
  }
  disconnected() {
    if (!this.state) return null;
    this.state = { ...this.state, available: false, reasonCode: 'company-terminal-disconnected' };
    return this.state;
  }
  replay(): TerminalOutput[] {
    if (!this.state) return [];
    const { identity } = this.state;
    return (this.state.terminals as readonly TerminalSummary[]).flatMap(tab => {
      const entry = this.#tabs.get(tab.terminalRef), snapshot = entry?.buffer.snapshot() ?? { text: '', truncated: false };
      const parts: string[] = [];
      for (let start = 0; start < snapshot.text.length;) {
        let end = Math.min(start + 8192, snapshot.text.length);
        if (end < snapshot.text.length && /[\uD800-\uDBFF]/.test(snapshot.text[end - 1]!)) end--;
        parts.push(snapshot.text.slice(start, end)); start = end;
      }
      if (!parts.length) parts.push('');
      return parts.map((data, index): TerminalOutput => ({ schemaVersion: 1, version: 'piagent-terminal-v1', messageType: 'output', identity,
        terminalRef: tab.terminalRef, sequence: entry?.sequence ?? tab.sequence, data, replay: true,
        reset: index === 0, complete: index === parts.length - 1, truncated: snapshot.truncated || Boolean(entry?.truncated) }));
    });
  }
}

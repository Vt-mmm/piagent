import type { TerminalOutput, TerminalState } from '../contracts/generated/terminal-v1.ts';
import type { TerminalStreamMessage } from '../server/terminal-websocket-stream.ts';
import { parseTerminalCommand } from '../server/terminal-command.ts';
import { CompanyTerminalChannel, type CompanyTerminalLink } from './company-terminal-channel.ts';

type Entry = { listeners: Set<(message: TerminalStreamMessage) => void>; channel: CompanyTerminalChannel | null;
  connecting: Promise<CompanyTerminalChannel> | null; retry: NodeJS.Timeout | null; idle: NodeJS.Timeout | null };

export class CompanyTerminalRelay {
  readonly #link: () => Promise<CompanyTerminalLink>;
  readonly #owns: (ref: string) => boolean;
  readonly #entries = new Map<string, Entry>();
  #closed = false;
  constructor(options: { link(): Promise<CompanyTerminalLink>; owns(ref: string): boolean }) { this.#link = options.link; this.#owns = options.owns; }
  #entry(ref: string): Entry {
    if (this.#closed || !this.#owns(ref)) throw Error('company-terminal-session-unavailable');
    let entry = this.#entries.get(ref);
    if (!entry) {
      if (this.#entries.size >= 32) throw Error('company-terminal-capacity');
      entry = { listeners: new Set(), channel: null, connecting: null, retry: null, idle: null }; this.#entries.set(ref, entry);
    }
    if (entry.idle) clearTimeout(entry.idle);
    const current = entry;
    entry.idle = setTimeout(() => { if (!current.listeners.size) this.#remove(ref, current); }, 30000); entry.idle.unref();
    return entry;
  }
  #retry(ref: string, entry: Entry) {
    if (this.#closed || this.#entries.get(ref) !== entry || !entry.listeners.size || entry.retry) return;
    entry.retry = setTimeout(() => {
      entry.retry = null;
      void this.state(ref).catch(() => this.#retry(ref, entry));
    }, 3000); entry.retry.unref();
  }
  async #channel(ref: string, entry: Entry): Promise<CompanyTerminalChannel> {
    if (entry.channel && !entry.channel.closed) { await entry.channel.ready; return entry.channel; }
    entry.connecting ??= (async () => {
      const link = await this.#link();
      if (this.#closed || this.#entries.get(ref) !== entry || !this.#owns(ref)) throw Error('company-terminal-session-unavailable');
      const channel = new CompanyTerminalChannel(ref, link, message => {
        if (this.#entries.get(ref) !== entry || entry.channel !== channel) return;
        for (const listener of entry.listeners) try { listener(message); } catch { /* browser stream owns its backpressure */ }
      }, () => { if (entry.channel === channel) this.#retry(ref, entry); });
      entry.channel = channel; await channel.ready;
      if (entry.retry) { clearTimeout(entry.retry); entry.retry = null; }
      return channel;
    })().finally(() => { entry.connecting = null; });
    return entry.connecting;
  }
  async state(ref: string): Promise<TerminalState> {
    const entry = this.#entry(ref);
    return (await this.#channel(ref, entry)).state();
  }
  async execute(value: unknown) {
    const command = parseTerminalCommand(value), ref = command.identity.sessionRef, entry = this.#entry(ref);
    const channel = await this.#channel(ref, entry);
    if (!channel.cache.state) await channel.state();
    // Exactly one dispatch. Only an explicit client retry may send this command again.
    return channel.execute(command);
  }
  subscribe(ref: string, listener: (message: TerminalStreamMessage) => void) {
    const entry = this.#entry(ref);
    if (entry.listeners.size >= 32) throw Error('company-terminal-subscription-capacity');
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); if (!entry.listeners.size) this.#remove(ref, entry); };
  }
  replay(ref: string): TerminalOutput[] { return this.#entries.get(ref)?.channel?.cache.replay() ?? []; }
  #remove(ref: string, entry: Entry) {
    if (this.#entries.get(ref) !== entry) return;
    this.#entries.delete(ref);
    if (entry.retry) clearTimeout(entry.retry);
    if (entry.idle) clearTimeout(entry.idle);
    entry.channel?.close();
  }
  close() { this.#closed = true; for (const [ref, entry] of this.#entries) this.#remove(ref, entry); }
}

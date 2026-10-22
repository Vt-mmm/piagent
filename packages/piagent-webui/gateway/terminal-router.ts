import type { TerminalStreamPort } from '../server/terminal-websocket-stream.ts';
import { parseTerminalCommand } from '../server/terminal-command.ts';

type Port = TerminalStreamPort & { state(ref: string): Promise<unknown>; execute(command: unknown): Promise<unknown> };
// Ownership picks a single executor; errors from company never fall through to personal.
export function terminalRouter(local: Port, company: { owns(ref: string): boolean; terminals: Port } | null) {
  const owner = (ref: string) => company?.owns(ref) ? company.terminals : local;
  return { state: (ref: string) => owner(ref).state(ref),
    execute: (value: unknown) => { const command = parseTerminalCommand(value); return owner(command.identity.sessionRef).execute(command); },
    subscribe: ((ref, listener) => owner(ref).subscribe(ref, listener)) as TerminalStreamPort['subscribe'],
    replay: (ref: string) => owner(ref).replay(ref) };
}

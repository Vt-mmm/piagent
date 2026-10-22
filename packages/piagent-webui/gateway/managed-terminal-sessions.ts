import { managedTerminalBinding, type ManagedTerminalOptions } from './managed-terminal-binding.ts';
import { ManagedTerminalProcesses } from './managed-terminal-processes.ts';
import { TerminalSessions } from './terminal-sessions.ts';

export class ManagedTerminalSessions extends TerminalSessions<Awaited<ReturnType<typeof managedTerminalBinding>>> {
  constructor(options: ManagedTerminalOptions) {
    super(ref => managedTerminalBinding(options, ref), emit => new ManagedTerminalProcesses(emit));
  }
}

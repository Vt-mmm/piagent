import { personalTerminalBinding } from "./personal-terminal-binding.ts";
import { PersonalTerminalProcesses, type PersonalTerminalEvent } from "./personal-terminal-processes.ts";
import { TerminalSessions } from "./terminal-sessions.ts";
export type { TerminalMessage as PersonalTerminalMessage } from "./terminal-sessions.ts";
type Binding = Awaited<ReturnType<typeof personalTerminalBinding>>;
type Options = Parameters<typeof personalTerminalBinding>[0];

// Personal authority is resolved here. This adapter never accepts a company boundary.
export class PersonalTerminalSessions extends TerminalSessions<Binding> {
  constructor(options: Options, createProcesses = (emit: (event: PersonalTerminalEvent) => void) => new PersonalTerminalProcesses(emit)) {
    super(ref => personalTerminalBinding(options, ref), emit => {
      const processes = createProcesses(emit);
      return { reason: () => processes.unavailableReason,
        open: (binding, size) => processes.open(binding.scope, size),
        input: (ref, terminal, data) => processes.input(ref, terminal, data),
        resize: (ref, terminal, size) => processes.resize(ref, terminal, size),
        close: (ref, terminal) => processes.close(ref, terminal),
        pause: (ref, terminal) => processes.pause(ref, terminal), resume: (ref, terminal) => processes.resume(ref, terminal),
        closeSession: ref => processes.closeSession(ref), dispose: () => processes.dispose() };
    });
  }
}

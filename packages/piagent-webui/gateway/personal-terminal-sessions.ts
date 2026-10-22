import { randomUUID } from "node:crypto";
import type { TerminalCommand, TerminalReceipt, TerminalState, TerminalSummary, TerminalOutput, TerminalExit } from "../contracts/generated/terminal-v1.ts";
import { parseTerminalCommand } from "../server/terminal-command.ts";
import { personalTerminalBinding } from "./personal-terminal-binding.ts";
import { PersonalTerminalProcesses, type PersonalTerminalEvent } from "./personal-terminal-processes.ts";
import { TerminalCommandLedger } from "./terminal-command-ledger.ts";
import { TerminalOutputBuffer } from "./terminal-output-buffer.ts";

type Binding = Awaited<ReturnType<typeof personalTerminalBinding>>;
type Options = Parameters<typeof personalTerminalBinding>[0];
type Tab = { summary: TerminalSummary; buffer: TerminalOutputBuffer };
type Session = { binding: Binding; revision: string; nextNumber: number; tabs: Map<string, Tab> };
export type PersonalTerminalMessage = TerminalOutput | TerminalExit | TerminalState;
const header = { schemaVersion: 1, version: "piagent-terminal-v1" } as const;
const revision = () => `terminal-revision.${randomUUID()}`;
function chunks(text: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 8192, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    result.push(text.slice(start, end)); start = end;
  }
  return result.length ? result : [""];
}

export class PersonalTerminalSessions {
  readonly #options: Options;
  readonly #processes: PersonalTerminalProcesses;
  readonly #ledger = new TerminalCommandLedger();
  readonly #sessions = new Map<string, Session>();
  readonly #queues = new Map<string, { tail: Promise<unknown>; count: number }>();
  readonly #listeners = new Map<string, Set<(message: PersonalTerminalMessage) => void>>();
  #closed = false;
  constructor(options: Options, createProcesses = (emit: (event: PersonalTerminalEvent) => void) => new PersonalTerminalProcesses(emit)) {
    this.#options = options; this.#processes = createProcesses(event => this.#event(event));
  }
  #serial<T>(ref: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(ref);
    if ((previous?.count ?? 0) >= 128 || !previous && this.#queues.size >= 256)
      return Promise.reject(new Error("terminal-command-capacity"));
    const queue = previous ?? { tail: Promise.resolve(), count: 0 };
    queue.count++;
    const run = queue.tail.then(action, action); queue.tail = run; this.#queues.set(ref, queue);
    void run.finally(() => { if (--queue.count === 0) this.#queues.delete(ref); }).catch(() => {});
    return run;
  }
  async #live(ref: string): Promise<Session> {
    if (this.#closed) throw new Error("terminal-session-closed");
    const binding = await personalTerminalBinding(this.#options, ref);
    let session = this.#sessions.get(ref);
    if (session) {
      try { session.binding.assertCurrent(); }
      catch { await this.#processes.closeSession(ref); this.#sessions.delete(ref); session = undefined; }
    }
    binding.assertCurrent();
    if (!session) {
      if (this.#sessions.size >= 256) throw new Error("terminal-session-capacity");
      session = { binding, revision: revision(), nextNumber: 1, tabs: new Map() }; this.#sessions.set(ref, session);
    }
    return session;
  }
  #state(session: Session): TerminalState {
    return { ...header, messageType: "state", identity: session.binding.identity,
      revisions: { terminalRevision: session.revision }, available: !this.#processes.unavailableReason,
      reasonCode: this.#processes.unavailableReason,
      terminals: [...session.tabs.values()].map(tab => ({ ...tab.summary })) as TerminalState["terminals"] };
  }
  state(ref: string) { return this.#serial(ref, async () => this.#state(await this.#live(ref))); }
  execute(value: unknown): Promise<TerminalReceipt> {
    const command = parseTerminalCommand(value);
    return this.#ledger.execute(command, parsed => this.#serial(parsed.identity.sessionRef, () => this.#execute(parsed)),
      parsed => this.#receipt(parsed, null, "uncertain", "terminal-effect-uncertain"));
  }
  #receipt(command: TerminalCommand, session: Session | null, phase: TerminalReceipt["phase"], reasonCode: string | null,
    terminalRef: string | null = command.payload.kind === "open" ? null : command.payload.terminalRef): TerminalReceipt {
    return { ...header, messageType: "receipt", commandId: command.commandId, idempotencyKey: command.idempotencyKey,
      action: command.action, actionDigest: command.actionDigest, identity: command.identity,
      observedRevisions: { terminalRevision: session?.revision ?? command.expectedRevisions.terminalRevision },
      phase, terminalRef, reasonCode, deduplicated: false };
  }
  async #execute(command: TerminalCommand): Promise<TerminalReceipt> {
    let session: Session;
    try { session = await this.#live(command.identity.sessionRef); }
    catch (error) { return this.#receipt(command, null, "rejected", error instanceof Error ? error.message : "terminal-session-unavailable"); }
    const reject = (reason: string) => this.#receipt(command, session, "rejected", reason);
    const identity = session.binding.identity, payload = command.payload;
    if (identity.gatewayInstanceRef !== command.identity.gatewayInstanceRef || identity.runtimeInstanceRef !== command.identity.runtimeInstanceRef)
      return reject("terminal-runtime-replaced");
    if (session.revision !== command.expectedRevisions.terminalRevision) return reject("terminal-stale-revision");
    if (Date.parse(command.expiresAt) < Date.now()) return reject("terminal-command-expired");
    if (this.#processes.unavailableReason) return reject(this.#processes.unavailableReason);
    if (payload.kind === "open" && session.tabs.size >= 4) return reject("terminal-limit");
    const tab = payload.kind === "open" ? null : session.tabs.get(payload.terminalRef);
    if (payload.kind !== "open" && !tab) return reject("terminal-not-found");
    if (tab?.summary.state === "exited" && payload.kind !== "close") return reject("terminal-exited");
    try { session.binding.assertCurrent(); } catch { return reject("terminal-runtime-replaced"); }
    let terminalRef: string;
    if (payload.kind === "open") {
      const opened = this.#processes.open(session.binding.scope, payload); terminalRef = opened.terminalRef;
      session.tabs.set(terminalRef, { buffer: new TerminalOutputBuffer(), summary: { terminalRef, number: session.nextNumber++,
        state: "running", cols: payload.cols, rows: payload.rows, sequence: 0, exitCode: null } });
    } else {
      terminalRef = payload.terminalRef;
      if (payload.kind === "input") this.#processes.input(identity.sessionRef, terminalRef, payload.data);
      else if (payload.kind === "resize") {
        this.#processes.resize(identity.sessionRef, terminalRef, payload);
        tab!.summary.cols = payload.cols; tab!.summary.rows = payload.rows;
      } else { await this.#processes.close(identity.sessionRef, terminalRef); session.tabs.delete(terminalRef); }
    }
    session.revision = revision(); this.#publish(identity.sessionRef, this.#state(session));
    return this.#receipt(command, session, "settled", null, terminalRef);
  }
  // Live bytes go only to the authenticated member socket. Retained/replayed
  // output and agent attachments always come from the redacted buffer.
  #event(event: PersonalTerminalEvent) {
    const session = this.#sessions.get(event.sessionRef), tab = session?.tabs.get(event.terminalRef);
    if (!session || !tab) return;
    try { session.binding.assertCurrent(); } catch { return; }
    if (event.kind === "output") {
      tab.buffer.append(event.data);
      const parts = chunks(event.data);
      for (const data of parts) this.#publish(event.sessionRef, { ...header, messageType: "output", identity: session.binding.identity,
        terminalRef: event.terminalRef, sequence: ++tab.summary.sequence, data, replay: false, reset: false, complete: true, truncated: false });
    } else {
      tab.summary.state = "exited"; tab.summary.exitCode = event.exitCode; session.revision = revision();
      this.#publish(event.sessionRef, { ...header, messageType: "exit", identity: session.binding.identity,
        terminalRef: event.terminalRef, sequence: ++tab.summary.sequence, exitCode: event.exitCode, signal: event.signal });
      this.#publish(event.sessionRef, this.#state(session));
    }
  }
  #publish(ref: string, message: PersonalTerminalMessage) {
    for (const listener of this.#listeners.get(ref) ?? []) try { listener(message); } catch { /* socket owns its backpressure */ }
  }
  subscribe(ref: string, listener: (message: PersonalTerminalMessage) => void) {
    const listeners = this.#listeners.get(ref) ?? new Set();
    if (listeners.size >= 32 || !this.#listeners.has(ref) && this.#listeners.size >= 256) throw new Error("terminal-subscription-capacity");
    listeners.add(listener); this.#listeners.set(ref, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.#listeners.delete(ref); };
  }
  replay(ref: string): TerminalOutput[] {
    const session = this.#sessions.get(ref); if (!session) return [];
    session.binding.assertCurrent();
    return [...session.tabs.values()].flatMap(tab => {
      const snapshot = tab.buffer.snapshot(), parts = chunks(snapshot.text);
      return parts.map((data, index) => ({ ...header, messageType: "output" as const, identity: session.binding.identity,
        terminalRef: tab.summary.terminalRef, sequence: tab.summary.sequence, data, replay: true, reset: index === 0,
        complete: index === parts.length - 1, truncated: snapshot.truncated }));
    });
  }
  forAgent(ref: string, number = 1) {
    const session = this.#sessions.get(ref); if (!session) throw new Error("terminal-not-found");
    session.binding.assertCurrent();
    const tab = [...session.tabs.values()].find(tab => tab.summary.number === number);
    if (!tab) throw new Error("terminal-not-found");
    return tab.buffer.forAgent();
  }
  closeSession(ref: string) { return this.#serial(ref, async () => {
    await this.#processes.closeSession(ref); this.#sessions.delete(ref);
  }); }
  async dispose() {
    this.#closed = true;
    await Promise.allSettled([...this.#queues.values()].map(queue => queue.tail));
    await this.#processes.dispose(); this.#sessions.clear(); this.#listeners.clear();
  }
}

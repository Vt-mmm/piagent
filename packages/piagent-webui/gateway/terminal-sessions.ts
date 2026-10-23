import { randomUUID } from "node:crypto";
import type { TerminalCommand, TerminalReceipt, TerminalState, TerminalSummary, TerminalOutput, TerminalExit } from "../contracts/generated/terminal-v1.ts";
import { parseTerminalCommand } from "../server/terminal-command.ts";
import { TerminalCommandLedger } from "./terminal-command-ledger.ts";
import { TerminalOutputBuffer } from "./terminal-output-buffer.ts";

export type TerminalBinding = { identity: TerminalState["identity"]; assertCurrent(): void };
export type TerminalProcessEvent = { sessionRef: string; terminalRef: string } &
  ({ kind: "output"; data: string } | { kind: "exit"; exitCode: number | null; signal: number | null });
type Size = { cols: number; rows: number };
export type TerminalProcessOwner<B extends TerminalBinding> = {
  reason(binding: B): string | null;
  open(binding: B, size: Size): { terminalRef: string; activate?(): void } | Promise<{ terminalRef: string; activate?(): void }>;
  input(sessionRef: string, terminalRef: string, data: string): void | Promise<void>;
  resize(sessionRef: string, terminalRef: string, size: Size): void | Promise<void>;
  close(sessionRef: string, terminalRef: string): Promise<void>;
  closeSession(sessionRef: string): Promise<void>;
  dispose(): Promise<void>;
  // Stop reading the terminal while the browser is behind; a writer then blocks
  // as it would on a real terminal. Owners without it are trimmed instead.
  pause?(sessionRef: string, terminalRef: string): void;
  resume?(sessionRef: string, terminalRef: string): void;
};
type Tab = { summary: TerminalSummary; buffer: TerminalOutputBuffer; live: string[]; liveLength: number; skipped: boolean; paused: boolean };
// Live output leaves at most BUDGET characters per tick (about 4 MB/s): a
// `yes` or a large `cat` neither floods the dashboard socket, which also
// carries the conversation, nor the browser's renderer. Above HIGH the
// terminal is paused; above LIMIT the oldest unsent output is dropped and the
// member sees a marker (the redacted replay buffer keeps the latest output).
const TICK = 16, BUDGET = 64 * 1024, LOW = 64 * 1024, HIGH = 256 * 1024, LIMIT = 1024 * 1024;
const DEFINITE = /^(?:terminal-(?:exited|not-found|limit|session-closed|invalid-size|input-limit|project-unavailable|shell-unavailable|spawn-failed)|company-boundary-required|managed-terminal-(?:exited|limit|invalid-size|input-limit|permission-denied|boundary-closed|[a-z-]*-unavailable|runtime-[a-z-]+))$/;
const SKIPPED = "\r\n\x1b[2m[… output skipped …]\x1b[0m\r\n";
type Session<B extends TerminalBinding> = { binding: B; revision: string; nextNumber: number; tabs: Map<string, Tab> };
export type TerminalMessage = TerminalOutput | TerminalExit | TerminalState;
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

export class TerminalSessions<B extends TerminalBinding> {
  readonly #resolveBinding: (ref: string) => Promise<B>;
  readonly #processes: TerminalProcessOwner<B>;
  readonly #ledger = new TerminalCommandLedger();
  readonly #sessions = new Map<string, Session<B>>();
  readonly #queues = new Map<string, { tail: Promise<unknown>; count: number }>();
  readonly #listeners = new Map<string, Set<(message: TerminalMessage) => void>>();
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(resolveBinding: (ref: string) => Promise<B>, createProcesses: (emit: (event: TerminalProcessEvent) => void) => TerminalProcessOwner<B>) {
    this.#resolveBinding = resolveBinding; this.#processes = createProcesses(event => this.#event(event));
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
  async #live(ref: string): Promise<Session<B>> {
    if (this.#closed) throw new Error("terminal-session-closed");
    const binding = await this.#resolveBinding(ref);
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
  #state(session: Session<B>): TerminalState {
    // State and replay name a sequence the member must have received: send
    // what is still waiting first.
    const ref = session.binding.identity.sessionRef;
    for (const tab of session.tabs.values()) while (tab.live.length) this.#drain(ref, session, tab, Infinity);
    return { ...header, messageType: "state", identity: session.binding.identity,
      revisions: { terminalRevision: session.revision }, available: !this.#processes.reason(session.binding),
      reasonCode: this.#processes.reason(session.binding),
      terminals: [...session.tabs.values()].map(tab => ({ ...tab.summary })) as TerminalState["terminals"] };
  }
  state(ref: string) { return this.#serial(ref, async () => this.#state(await this.#live(ref))); }
  execute(value: unknown): Promise<TerminalReceipt> {
    const command = parseTerminalCommand(value);
    return this.#ledger.execute(command, parsed => this.#serial(parsed.identity.sessionRef, () => this.#execute(parsed)),
      parsed => this.#receipt(parsed, null, "uncertain", "terminal-effect-uncertain"));
  }
  #receipt(command: TerminalCommand, session: Session<B> | null, phase: TerminalReceipt["phase"], reasonCode: string | null,
    terminalRef: string | null = command.payload.kind === "open" ? null : command.payload.terminalRef): TerminalReceipt {
    return { ...header, messageType: "receipt", commandId: command.commandId, idempotencyKey: command.idempotencyKey,
      action: command.action, actionDigest: command.actionDigest, identity: command.identity,
      observedRevisions: { terminalRevision: session?.revision ?? command.expectedRevisions.terminalRevision },
      phase, terminalRef, reasonCode, deduplicated: false };
  }
  async #execute(command: TerminalCommand): Promise<TerminalReceipt> {
    let session: Session<B>;
    try { session = await this.#live(command.identity.sessionRef); }
    catch (error) { return this.#receipt(command, null, "rejected", error instanceof Error ? error.message : "terminal-session-unavailable"); }
    const reject = (reason: string) => this.#receipt(command, session, "rejected", reason);
    const identity = session.binding.identity, payload = command.payload;
    if (identity.gatewayInstanceRef !== command.identity.gatewayInstanceRef || identity.runtimeInstanceRef !== command.identity.runtimeInstanceRef)
      return reject("terminal-runtime-replaced");
    if (session.revision !== command.expectedRevisions.terminalRevision) return reject("terminal-stale-revision");
    if (Date.parse(command.expiresAt) < Date.now()) return reject("terminal-command-expired");
    const unavailable = this.#processes.reason(session.binding);
    if (unavailable) return reject(unavailable);
    if (payload.kind === "open" && session.tabs.size >= 4) return reject("terminal-limit");
    const tab = payload.kind === "open" ? null : session.tabs.get(payload.terminalRef);
    if (payload.kind !== "open" && !tab) return reject("terminal-not-found");
    if (tab?.summary.state === "exited" && payload.kind !== "close") return reject("terminal-exited");
    try { session.binding.assertCurrent(); } catch { return reject("terminal-runtime-replaced"); }
    let terminalRef: string;
    try {
      if (payload.kind === "open") {
        const opened = await this.#processes.open(session.binding, payload); terminalRef = opened.terminalRef;
        session.tabs.set(terminalRef, { buffer: new TerminalOutputBuffer(), live: [], liveLength: 0, skipped: false, paused: false,
          summary: { terminalRef, number: session.nextNumber++, state: "running", cols: payload.cols, rows: payload.rows, sequence: 0, exitCode: null } });
        opened.activate?.();
      } else {
        terminalRef = payload.terminalRef;
        if (payload.kind === "input") await this.#processes.input(identity.sessionRef, terminalRef, payload.data);
        else if (payload.kind === "resize") {
          await this.#processes.resize(identity.sessionRef, terminalRef, payload);
          tab!.summary.cols = payload.cols; tab!.summary.rows = payload.rows;
        } else { await this.#processes.close(identity.sessionRef, terminalRef); session.tabs.delete(terminalRef); }
      }
    } catch (error) {
      // Refused before anything ran (no shell, an exited terminal, a sandbox
      // that cannot start): say so instead of "the command may have run".
      const code = error instanceof Error ? error.message : "";
      if (DEFINITE.test(code)) return reject(code);
      throw error;
    }
    try { session.binding.assertCurrent(); } catch { return this.#receipt(command, session, "uncertain", "terminal-runtime-replaced", terminalRef); }
    session.revision = revision(); this.#publish(identity.sessionRef, this.#state(session));
    return this.#receipt(command, session, "settled", null, terminalRef);
  }
  // Live bytes go only to the authenticated member socket. Retained/replayed
  // output and agent attachments always come from the redacted buffer.
  #event(event: TerminalProcessEvent) {
    const session = this.#sessions.get(event.sessionRef), tab = session?.tabs.get(event.terminalRef);
    if (!session || !tab) return;
    try { session.binding.assertCurrent(); } catch { return; }
    if (event.kind === "output") {
      tab.buffer.append(event.data);
      // A PTY delivers a flood as many tiny reads: join them into parts of up
      // to 16K characters so draining stays linear.
      const last = tab.live.length - 1;
      if (last >= 0 && tab.live[last]!.length < 16384) tab.live[last] += event.data; else tab.live.push(event.data);
      tab.liveLength += event.data.length;
      if (tab.liveLength > HIGH && !tab.paused && this.#processes.pause) {
        tab.paused = true;
        try { this.#processes.pause(event.sessionRef, event.terminalRef); } catch { /* exited meanwhile */ }
      }
      while (tab.liveLength > LIMIT && tab.live.length > 1) { tab.liveLength -= tab.live.shift()!.length; tab.skipped = true; }
      this.#schedule();
    } else {
      // Everything the terminal printed before it ended reaches the member first.
      while (tab.live.length) this.#drain(event.sessionRef, session, tab, Infinity);
      tab.summary.state = "exited"; tab.summary.exitCode = event.exitCode; session.revision = revision();
      this.#publish(event.sessionRef, { ...header, messageType: "exit", identity: session.binding.identity,
        terminalRef: event.terminalRef, sequence: ++tab.summary.sequence, exitCode: event.exitCode, signal: event.signal });
      this.#publish(event.sessionRef, this.#state(session));
    }
  }
  #schedule() {
    if (this.#timer || this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      let more = false;
      for (const [ref, session] of this.#sessions) for (const tab of session.tabs.values()) {
        if (!tab.live.length) continue;
        try { session.binding.assertCurrent(); } catch { tab.live = []; tab.liveLength = 0; continue; }
        this.#drain(ref, session, tab, BUDGET);
        more ||= tab.live.length > 0;
      }
      if (more) this.#schedule();
    }, TICK);
    this.#timer.unref?.();
  }
  #drain(ref: string, session: Session<B>, tab: Tab, budget: number) {
    let text = tab.skipped ? SKIPPED : "";
    tab.skipped = false;
    while (tab.live.length && text.length < budget) {
      const next = tab.live[0]!, room = budget - text.length;
      if (next.length <= room) { text += tab.live.shift(); continue; }
      let end = room; if (/[\uD800-\uDBFF]/.test(next[end - 1]!)) end--;
      text += next.slice(0, end); tab.live[0] = next.slice(end);
    }
    tab.liveLength = tab.live.reduce((total, part) => total + part.length, 0);
    for (const data of chunks(text)) if (data) this.#publish(ref, { ...header, messageType: "output", identity: session.binding.identity,
      terminalRef: tab.summary.terminalRef, sequence: ++tab.summary.sequence, data, replay: false, reset: false, complete: true, truncated: false });
    if (tab.paused && tab.liveLength < LOW) {
      tab.paused = false;
      try { this.#processes.resume?.(ref, tab.summary.terminalRef); } catch { /* exited meanwhile */ }
    }
  }
  #publish(ref: string, message: TerminalMessage) {
    for (const listener of this.#listeners.get(ref) ?? []) try { listener(message); } catch { /* socket owns its backpressure */ }
  }
  subscribe(ref: string, listener: (message: TerminalMessage) => void) {
    const listeners = this.#listeners.get(ref) ?? new Set();
    if (listeners.size >= 32 || !this.#listeners.has(ref) && this.#listeners.size >= 256) throw new Error("terminal-subscription-capacity");
    listeners.add(listener); this.#listeners.set(ref, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.#listeners.delete(ref); };
  }
  replay(ref: string): TerminalOutput[] {
    const session = this.#sessions.get(ref); if (!session) return [];
    session.binding.assertCurrent();
    // The snapshot already holds output not yet sent live: send it first, so
    // its sequence numbers stay below the replay's and are not shown twice.
    for (const tab of session.tabs.values()) while (tab.live.length) this.#drain(ref, session, tab, Infinity);
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
    this.#closed = true; clearTimeout(this.#timer);
    await Promise.allSettled([...this.#queues.values()].map(queue => queue.tail));
    await this.#processes.dispose(); this.#sessions.clear(); this.#listeners.clear();
  }
}

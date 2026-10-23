import { loadPersonalPty } from "./personal-terminal-diagnostic.mjs";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import type { IPty } from "@lydell/node-pty";

type PtyModule = { spawn: typeof import("@lydell/node-pty").spawn };
type Scope = { sessionRef: string; mode: "personal" | "company"; cwd: string };
type Size = { cols: number; rows: number };
export type PersonalTerminalEvent = { sessionRef: string; terminalRef: string } &
  ({ kind: "output"; data: string } | { kind: "exit"; exitCode: number; signal: number | null });
type Entry = { sessionRef: string; terminalRef: string; process: IPty; exited: boolean; cleanup?: Promise<void>; closing?: Promise<void> };
const dimensions = ({ cols, rows }: Size) => {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200)
    throw new Error("terminal-invalid-size");
};
function descendants(pid: number): number[] {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
    .trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const found = new Set<number>(), queue = [pid];
  for (const parent of queue) for (const [child, owner] of rows) {
    if (owner === parent && child > 1 && child !== process.pid && !found.has(child)) { found.add(child); queue.push(child); }
  }
  return [...found].reverse();
}
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch { /* already exited */ } };

// This owns personal native processes only. The protocol/controller must resolve
// the trusted session scope before calling it; company never falls back here.
export class PersonalTerminalProcesses {
  readonly #entries = new Map<string, Entry>();
  readonly #closingSessions = new Set<string>();
  readonly #emit: (event: PersonalTerminalEvent) => void;
  readonly #pty: PtyModule | null;
  readonly unavailableReason: string | null;
  #closed = false;
  constructor(emit: (event: PersonalTerminalEvent) => void, load?: () => PtyModule) {
    this.#emit = emit;
    const { pty, reason } = loadPersonalPty(load);
    this.#pty = pty; this.unavailableReason = reason;
  }
  open(scope: Scope, size: Size, shell = userInfo().shell || process.env.SHELL || "/bin/sh") {
    if (scope.mode !== "personal") throw new Error("company-boundary-required");
    if (this.#closed || this.#closingSessions.has(scope.sessionRef)) throw new Error("terminal-session-closed");
    if (!this.#pty) throw new Error(this.unavailableReason!);
    dimensions(size);
    if (!isAbsolute(scope.cwd) || !statSync(scope.cwd).isDirectory()) throw new Error("terminal-project-unavailable");
    if (!isAbsolute(shell) || shell.includes("\0")) throw new Error("terminal-shell-unavailable");
    if (this.list(scope.sessionRef).length >= 4 || this.#entries.size >= 256) throw new Error("terminal-limit");
    const terminalRef = `terminal.${randomUUID()}`;
    const child = this.#pty.spawn(shell, [], { ...size, cwd: scope.cwd, env: { ...process.env, TERM: "xterm-256color" }, name: "xterm-256color" });
    const entry: Entry = { sessionRef: scope.sessionRef, terminalRef, process: child, exited: false };
    this.#entries.set(terminalRef, entry);
    child.onData(data => { if (!entry.closing) this.#notify({ sessionRef: scope.sessionRef, terminalRef, kind: "output", data }); });
    child.onExit(({ exitCode, signal: exitSignal }) => {
      entry.exited = true;
      entry.cleanup ??= this.#stop(entry);
      this.#notify({ sessionRef: scope.sessionRef, terminalRef, kind: "exit", exitCode, signal: exitSignal ?? null });
    });
    return { terminalRef, pid: child.pid };
  }
  list(sessionRef: string) { return [...this.#entries.values()].filter(entry => entry.sessionRef === sessionRef)
    .map(entry => ({ terminalRef: entry.terminalRef, exited: entry.exited })); }
  input(sessionRef: string, terminalRef: string, data: string) {
    if (typeof data !== "string" || Buffer.byteLength(data) > 16 * 1024) throw new Error("terminal-input-limit");
    const entry = this.#get(sessionRef, terminalRef);
    if (entry.exited || entry.closing) throw new Error("terminal-exited");
    entry.process.write(data);
  }
  resize(sessionRef: string, terminalRef: string, size: Size) {
    dimensions(size); const entry = this.#get(sessionRef, terminalRef);
    if (entry.exited || entry.closing) throw new Error("terminal-exited");
    entry.process.resize(size.cols, size.rows);
  }
  pause(sessionRef: string, terminalRef: string) { const entry = this.#get(sessionRef, terminalRef); if (!entry.exited) entry.process.pause(); }
  resume(sessionRef: string, terminalRef: string) { const entry = this.#get(sessionRef, terminalRef); if (!entry.exited) entry.process.resume(); }
  async close(sessionRef: string, terminalRef: string) {
    const entry = this.#get(sessionRef, terminalRef);
    if (!entry.closing) { entry.cleanup ??= this.#stop(entry); entry.closing = entry.cleanup.finally(() => this.#entries.delete(terminalRef)); }
    await entry.closing;
  }
  async closeSession(sessionRef: string) {
    this.#closingSessions.add(sessionRef);
    try { await Promise.all(this.list(sessionRef).map(entry => this.close(sessionRef, entry.terminalRef))); }
    finally { this.#closingSessions.delete(sessionRef); }
  }
  async dispose() {
    this.#closed = true;
    await Promise.all([...new Set([...this.#entries.values()].map(entry => entry.sessionRef))].map(ref => this.closeSession(ref)));
  }
  #get(sessionRef: string, terminalRef: string) {
    const entry = this.#entries.get(terminalRef);
    if (!entry || entry.sessionRef !== sessionRef) throw new Error("terminal-not-found");
    return entry;
  }
  #notify(event: PersonalTerminalEvent) { try { this.#emit(event); } catch { /* a disconnected consumer cannot own process lifetime */ } }
  async #stop(entry: Entry) {
    const pid = entry.process.pid;
    let tree: number[] = [];
    try { if (!entry.exited) tree = descendants(pid); } catch { /* still signal the PTY process group */ }
    for (const child of tree) signal(child, "SIGTERM");
    try { if (!entry.exited) entry.process.kill("SIGHUP"); } catch { /* already exited */ }
    signal(-pid, "SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const child of tree) signal(child, "SIGKILL");
    signal(-pid, "SIGKILL");
  }
}

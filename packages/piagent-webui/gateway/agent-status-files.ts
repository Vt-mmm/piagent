import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// What each conversation is doing, for Agent Watch (macOS and Windows) to
// tell the member: working, waiting on them (an approval, a question or a
// sign-in), done, stopped or failed. The Program Status Protocol (OSC 7501)
// carries the same states to a terminal; the dashboard has no terminal, so
// its Gateway writes one small file per conversation under
// <agentDir>/status/<dashboard|company>/ instead (each Gateway its own
// folder: it removes only the files of conversations it no longer serves). A file never holds the member's prompt, the
// agent's answer or the conversation preview: only the conversation's title,
// its project's name, the state and when it changed.

export type AgentState = "idle" | "working" | "blocked" | "done" | "error";
export type BlockedKind = "permission" | "question" | "auth";
export type StatusRow = { sessionRef: string; title: string; projectLabel: string; state: string; liveState: string; archived: boolean;
  needsAttention: boolean; updatedAt: string; managedHelpers?: { active: number | null; maximum: number } | null;
  managedProcess?: { outcome: string } | null };
export type AgentStatus = { schema_version: 1; conversation: string; title: string; project: string; company: boolean;
  state: AgentState; kind?: BlockedKind; ended?: "done" | "stopped" | "failed"; helpers: number; since: string; updated_at: string };

const KEEP_MS = 24 * 3_600_000;
const clip = (text: string, n: number) => (text.length > n ? text.slice(0, n - 1) + "…" : text);
export const statusFileName = (sessionRef: string) => createHash("sha256").update(sessionRef).digest("hex").slice(0, 32) + ".json";

// The state a catalog row shows now, given the one before.
export function statusOf(row: StatusRow, before: AgentStatus | undefined, company: boolean, now: Date): AgentStatus {
  let state: AgentState, kind: BlockedKind | undefined, ended: AgentStatus["ended"];
  if (row.liveState === "waiting-approval") { state = "blocked"; kind = "permission"; }
  else if (row.needsAttention && (row.liveState === "running" || row.liveState === "idle")) { state = "blocked"; kind = "question"; }
  else if (row.liveState === "running" || row.liveState === "paused") state = "working";
  else if (row.state === "recovery-required") { state = "error"; ended = "failed"; }
  else if (before && (before.state === "working" || before.state === "blocked")) {
    // The turn ended since the last look.
    const interrupted = row.managedProcess?.outcome === "interrupted";
    state = "done"; ended = interrupted ? "stopped" : "done";
  } else if (before && (before.state === "done" || before.state === "error")) { state = before.state; ended = before.ended; }
  else state = "idle";
  const same = before && before.state === state && before.kind === kind;
  return { schema_version: 1, conversation: row.sessionRef, title: clip(row.title, 80), project: clip(row.projectLabel, 80), company,
    state, ...(kind ? { kind } : {}), ...(ended ? { ended } : {}), helpers: Math.max(0, row.managedHelpers?.active ?? 0),
    since: same ? before!.since : now.toISOString(), updated_at: now.toISOString() };
}

// Writes the files that changed and removes those of conversations that are
// gone, archived or untouched for a day. Never throws.
export class AgentStatusFiles {
  #dir: string; #read: () => Promise<{ sessions: StatusRow[] }>; #company: (ref: string) => boolean;
  #last = new Map<string, AgentStatus>(); #timer: ReturnType<typeof setInterval> | null = null;
  constructor(dir: string, read: () => Promise<{ sessions: StatusRow[] }>, company: (ref: string) => boolean = () => false) {
    this.#dir = dir; this.#read = read; this.#company = company;
  }
  start(everyMs = 2_000) {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.publish(), everyMs); this.#timer.unref?.();
    void this.publish();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }
  async publish(now = new Date()) {
    try {
      const { sessions } = await this.#read();
      fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const keep = new Set<string>();
      for (const row of sessions) {
        if (row.archived || now.getTime() - Date.parse(row.updatedAt) > KEEP_MS) continue;
        const before = this.#last.get(row.sessionRef), next = statusOf(row, before, this.#company(row.sessionRef), now);
        keep.add(statusFileName(row.sessionRef));
        if (before && before.state === next.state && before.kind === next.kind && before.helpers === next.helpers && before.title === next.title) continue;
        this.#last.set(row.sessionRef, next);
        const file = path.join(this.#dir, statusFileName(row.sessionRef)), temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temporary, file);
      }
      for (const name of fs.readdirSync(this.#dir)) if (name.endsWith(".json") && !keep.has(name)) fs.rmSync(path.join(this.#dir, name), { force: true });
    } catch { /* Agent Watch's view is optional */ }
  }
}

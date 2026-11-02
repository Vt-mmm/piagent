import fs from "node:fs";
import path from "node:path";
import { piagentAgentDir, agentWatchControlDir } from "./agent-home.js";
import { herdrEnvironment, herdrReporterExtension, sendHerdrRequest } from "./herdr-reporter.js";

// What every open Piagent session is doing, readable from outside it: one small
// file per Terminal under <piagent home>/status/sessions/, listed by
// `piagent sessions`, and inside Herdr a summary on the row of each space, so a
// developer with many sessions sees which one runs, waits or failed without
// opening it. A file never holds the member's prompt or the agent's answer.
export const SESSION_STATES = ["failed", "paused", "processing", "done", "idle"];
const GLYPHS = { failed: "✖", paused: "⏸", processing: "▶", done: "✓" };
const HEARTBEAT_MS = 30_000, DEAD_AFTER_MS = 120_000, COMPANY_KEEP_MS = 24 * 3_600_000;
const SPACE_SOURCE = "piagent:sessions", PANE_SOURCE = "piagent:session";
export const SPACE_TOKEN = "piagent_sessions", PANE_TOKEN = "piagent_status";

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
export const sessionStatusDir = (agentDir = piagentAgentDir()) => path.join(agentDir, "status", "sessions");

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJsonFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(name => name.endsWith(".json")).flatMap(name => {
    try { return [{ file: path.join(dir, name), value: JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) }]; } catch { return []; }
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

// The last turn's outcome: Pi's retries end in one agent_end per attempt, so
// only what the final one says counts.
export function failureOf(messages) {
  const last = [...(messages ?? [])].reverse().find(message => message?.role === "assistant");
  return last?.stopReason === "error" ? clip(String(last.errorMessage || "The model request failed"), 160) : null;
}

// A Terminal that vanished in the middle of a turn failed; one that vanished
// at rest has nothing left to say. The heartbeat tells a reused pid apart.
export function liveRow(value, now, alive = processAlive) {
  if (alive(value.pid) && now - Date.parse(value.updated_at) <= DEAD_AFTER_MS) return { ...value, alive: true };
  if (value.state === "processing" || value.state === "paused") return { ...value, alive: false, state: "failed", message: "The Terminal ended during the task" };
  return value.state === "failed" ? { ...value, alive: false } : null;
}

// Conversations of the dashboard and of Agent Watch's company Gateway publish
// their own files (packages/piagent-webui/gateway/agent-status-files.ts).
export function gatewayRow(value, source) {
  const state = value.state === "working" ? "processing" : value.state === "blocked" ? "paused"
    : value.state === "error" || value.ended === "failed" ? "failed"
    : value.ended === "stopped" ? "paused" : value.state === "done" ? "done" : "idle";
  return { id: `${source}:${value.conversation}`, source, state, project: value.project, title: value.title, since: value.since, updated_at: value.updated_at,
    ...(value.state === "blocked" && value.kind ? { message: `Waiting: ${value.kind}` } : {}) };
}

export function readSessions({ agentDir = piagentAgentDir(), controlDir = agentWatchControlDir(), now = Date.now(), alive = processAlive, prune = false, gateways = true } = {}) {
  const rows = [];
  for (const { file, value } of readJsonFiles(sessionStatusDir(agentDir))) {
    const row = liveRow(value, now, alive);
    if (row && (row.alive || now - Date.parse(row.updated_at) <= COMPANY_KEEP_MS)) rows.push(row);
    else if (prune) fs.rmSync(file, { force: true });
  }
  for (const source of gateways ? ["company", "dashboard"] : []) {
    for (const { value } of readJsonFiles(path.join(controlDir, "status", source))) {
      if (now - Date.parse(value.updated_at) <= COMPANY_KEEP_MS) rows.push(gatewayRow(value, source));
    }
  }
  return rows.sort((a, b) => SESSION_STATES.indexOf(a.state) - SESSION_STATES.indexOf(b.state) || String(b.since).localeCompare(String(a.since)));
}

// One session in a space reads as a word, several as counts; what needs the
// developer comes first. Nothing to show clears the token.
export function spaceSummary(rows) {
  const shown = rows.filter(row => GLYPHS[row.state]);
  if (!shown.length) return null;
  if (shown.length === 1) return `${GLYPHS[shown[0].state]} ${shown[0].state}`;
  return SESSION_STATES.filter(state => GLYPHS[state]).flatMap(state => {
    const count = shown.filter(row => row.state === state).length;
    return count ? [`${GLYPHS[state]}${count}`] : [];
  }).join(" ");
}

// How a company message ended (managed/continuation.mjs). A checklist left
// open waits for the member to say what comes next.
export function companyTurnEnd(end, text) {
  if (end?.state === "failed") return ["failed", clip(`${end.role} agent: ${end.code}`, 160)];
  if (end?.state === "cancelled") return ["paused", "Stopped by the member"];
  if (end?.state === "midway") return ["paused", clip(String(text || "The checklist is not finished"), 160)];
  return ["done", undefined];
}

// Only one session of a process is current: a company Terminal that enrolled
// again replaces its session without always ending the old one.
let currentInstance = null;

export function sessionStatusExtension({ agentDir = piagentAgentDir(), herdr = null, send = sendHerdrRequest, now = Date.now, pid = process.pid, heartbeatMs = HEARTBEAT_MS, managed = null } = {}) {
  return (pi) => {
    const instance = {}, file = path.join(sessionStatusDir(agentDir), `${pid}.json`);
    const space = herdr ? herdr.pane.split(":")[0] : null;
    let started = false, state = "idle", message, since = new Date(now()).toISOString(), cwd, sessionId, prompts = 0, failure = null, settled = "idle", settledNote, unsubscribe, timer, sequence = now() * 1000;

    const current = () => started && currentInstance === instance;
    const nextSeq = () => { sequence = Math.max(sequence + 1, now() * 1000); return sequence; };
    const spaceRequest = (workspaceId, summary) => ({ id: `${SPACE_SOURCE}:${nextSeq()}`, method: "workspace.report_metadata",
      params: { workspace_id: workspaceId, source: SPACE_SOURCE, seq: sequence, ttl_ms: DEAD_AFTER_MS, tokens: { [SPACE_TOKEN]: summary } } });
    // Every space of this Herdr, so a live session also corrects the row of one
    // whose Terminal died. Another Herdr server numbers its spaces on its own.
    const reportSpaces = async () => {
      if (!herdr) return;
      const rows = readSessions({ agentDir, now: now(), gateways: false }).filter(row => row.socket === herdr.socket);
      for (const id of new Set([space, ...rows.map(row => row.workspace)])) {
        await send(herdr.socket, spaceRequest(id, spaceSummary(rows.filter(row => row.workspace === id))));
      }
    };
    const report = async () => {
      if (!herdr) return;
      await send(herdr.socket, { id: `${PANE_SOURCE}:${nextSeq()}`, method: "pane.report_metadata",
        params: { pane_id: herdr.pane, source: PANE_SOURCE, seq: sequence, ttl_ms: DEAD_AFTER_MS, tokens: { [PANE_TOKEN]: message ? `${state}: ${clip(message, 40)}` : state } } });
      await reportSpaces();
    };
    const write = () => {
      try {
        const name = pi.getSessionName?.();
        writeAtomic(file, { schema_version: 1, id: sessionId ?? String(pid), source: "terminal", pid, state, ...(message ? { message } : {}),
          project: cwd ? path.basename(cwd) : "", cwd, ...(name ? { title: clip(name, 80) } : {}),
          ...(herdr ? { workspace: space, pane: herdr.pane, socket: herdr.socket } : {}), since, updated_at: new Date(now()).toISOString() });
      } catch { /* the conversation never depends on this view */ }
    };
    const set = (next, note) => {
      if (next === state && note === message) return;
      if (next !== state) since = new Date(now()).toISOString();
      state = next; message = note;
      if (!current()) return;
      write(); void report().catch(() => {});
    };
    const follow = (ctx) => {
      cwd = ctx?.cwd ?? cwd;
      try { sessionId = ctx?.sessionManager?.getSessionId?.() ?? sessionId; } catch { /* keep the last one */ }
    };
    // A dialog asks while a turn runs or between turns: the state under it comes back.
    const settle = (next, note) => { settled = next; settledNote = note; if (!prompts) set(next, note); };

    pi.on("session_start", async (_event, ctx) => {
      currentInstance = instance; started = true; follow(ctx);
      // The Terminal that held this pane before (a crash, `piagent reload`) is replaced.
      if (herdr) for (const row of readJsonFiles(sessionStatusDir(agentDir))) {
        if (row.value.pane === herdr.pane && row.value.pid !== pid && !liveRow(row.value, now())?.alive) fs.rmSync(row.file, { force: true });
      }
      failure = null; prompts = 0; settledNote = undefined;
      settled = ctx?.isIdle?.() === false || managed?.()?.activePrompt ? "processing" : "idle";
      // One company message is many rounds; only the turn's own end counts.
      unsubscribe?.();
      unsubscribe = managed?.()?.session?.subscribe?.(event => {
        if (!current()) return;
        if (event?.type === "managed_provider_retry") settle("processing", `Retrying ${event.attempt}/${event.of}: ${event.code}`);
        if (event?.type === "managed_turn_end") settle(...companyTurnEnd(event.end, event.text));
      });
      state = settled; message = undefined; since = new Date(now()).toISOString();
      write(); await report().catch(() => {});
      clearInterval(timer);
      timer = setInterval(() => { if (!current()) { clearInterval(timer); return; } write(); void report().catch(() => {}); }, heartbeatMs);
      timer.unref?.();
    });
    pi.on("agent_start", (_event, ctx) => { follow(ctx); failure = null; if (settled !== "processing" || !managed?.()?.activePrompt) settle("processing"); });
    pi.on("agent_end", (event) => { failure = failureOf(event?.messages); });
    pi.on("agent_settled", (event, ctx) => {
      if (ctx?.isIdle?.() !== true || managed?.()?.activePrompt) return;
      if (event?.aborted) settle("paused", "Stopped by the member");
      else if (failure) settle("failed", failure);
      else settle("done");
    });
    pi.on("ui_prompt_start", (event) => { prompts += 1; set("paused", clip(String(event?.title || "Waiting for your answer"), 80)); });
    pi.on("ui_prompt_end", () => {
      prompts = Math.max(0, prompts - 1);
      if (!prompts) set(settled, settledNote);
    });
    pi.on("session_shutdown", async () => {
      clearInterval(timer); unsubscribe?.(); unsubscribe = undefined;
      if (currentInstance !== instance) return;
      started = false;
      try { fs.rmSync(file, { force: true }); } catch { /* a later reader prunes it */ }
      await reportSpaces().catch(() => {});
    });
  };
}

// `pi --mode rpc|json|print` also loads the package: only a Terminal someone
// looks at is a session to follow.
export function onlyInTerminal(pi) {
  let terminal = false;
  return {
    ...pi,
    getSessionName: () => pi.getSessionName?.(),
    events: { on: (name, handler) => pi.events?.on?.(name, data => { if (terminal) return handler(data); }) },
    on: (name, handler) => pi.on(name, (event, ctx) => {
      if (name === "session_start") terminal = ctx?.mode === "tui";
      if (terminal) return handler(event, ctx);
    }),
  };
}

// `piagent` itself. The launcher marks it; `piagent studio` registers its own
// (scripts/piagent-studio.mjs), and a stock `pi` that loads the package stays out.
export function registerTerminalSessionStatus(pi, env = process.env) {
  if (env.PIAGENT_ACTIVE !== "1") return;
  const terminal = onlyInTerminal(pi), herdr = herdrEnvironment(env);
  sessionStatusExtension({ agentDir: piagentAgentDir(env), herdr })(terminal);
  if (herdr) herdrReporterExtension(herdr, { source: "custom:piagent", resume: (_cwd, file) => (file ? ["piagent", "--session", file] : ["piagent"]) })(terminal);
}

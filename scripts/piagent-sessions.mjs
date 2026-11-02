#!/usr/bin/env node
// `piagent sessions`: what every open Piagent session is doing, from any terminal.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessions, SPACE_TOKEN, PANE_TOKEN } from "../packages/piagent-core/extensions/session-status.js";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: piagent sessions [--json] [--watch] [--setup-herdr]

Every open session on this machine and what it is doing:
  processing  a task is running
  paused      waiting for you: a question, an approval, or stopped with Esc
  failed      the task ended on an error, or the Terminal died during it
  done        the task finished
  idle        nothing started yet

  --json         One JSON document instead of the table
  --watch        Redraw every 2 seconds until Ctrl+C
  --setup-herdr  Show the states on the spaces and agents of the Herdr sidebar`);
  process.exit(0);
}

function herdrRowsConfig() {
  return `[ui.sidebar.spaces]\nrows = [["state_icon", "workspace", "$${SPACE_TOKEN}"], ["branch", "git_status"]]\n\n` +
    `[ui.sidebar.agents]\nrows = [["state_icon", "machine", "workspace", "tab"], ["agent", "$${PANE_TOKEN}"]]\n`;
}

// Adds the rows to the member's Herdr config. A section they wrote stays theirs.
function setupHerdr() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const file = process.env.HERDR_CONFIG_PATH?.trim() || path.join(configHome, "herdr", "config.toml");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (before.includes(`$${SPACE_TOKEN}`)) console.log(`Herdr already shows the session states: ${file}`);
  else if (/^\s*\[ui\.sidebar\.(spaces|agents)\]/m.test(before)) {
    console.log(`${file} already sets its own sidebar rows, so it was not changed. Add these tokens to them:\n  $${SPACE_TOKEN}  in [ui.sidebar.spaces] rows\n  $${PANE_TOKEN}  in [ui.sidebar.agents] rows`);
    return 1;
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (before) fs.copyFileSync(file, `${file}.before-piagent-sessions`);
    fs.writeFileSync(file, `${before}${before && !before.endsWith("\n") ? "\n" : ""}\n${herdrRowsConfig()}`);
    console.log(`Added the session states to ${file}`);
  }
  const reload = spawnSync("herdr", ["server", "reload-config"], { stdio: "ignore" });
  if (reload.status !== 0) console.log("Herdr is not running; it reads the new rows when it starts.");
  return 0;
}

// Labels from the Herdr server each session reported to.
function herdrSpaces(rows) {
  const labels = new Map();
  for (const socket of new Set(rows.flatMap(row => (row.socket ? [row.socket] : [])))) {
    const result = spawnSync("herdr", ["workspace", "list"], { encoding: "utf8", timeout: 2000, env: { ...process.env, HERDR_SOCKET_PATH: socket } });
    try { for (const space of JSON.parse(result.stdout).result.workspaces) labels.set(`${socket}|${space.workspace_id}`, `${space.number} ${space.label}`); } catch { /* the id is shown instead */ }
  }
  return labels;
}

function age(since, now) {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
}

const COLORS = { failed: 31, paused: 33, processing: 36, done: 32 };

function table(rows, spaces, now, color) {
  if (!rows.length) return "No open sessions.";
  const lines = rows.map(row => [row.state, row.workspace ? spaces.get(`${row.socket}|${row.workspace}`) ?? row.workspace : row.source === "terminal" ? "-" : row.source,
    row.project || "-", row.title || "-", age(row.since, now), row.message || ""]);
  const header = ["STATE", "SPACE", "PROJECT", "SESSION", "FOR", "NOTE"];
  const widths = header.map((title, i) => Math.max(title.length, ...lines.map(line => line[i].length)));
  const draw = line => line.map((cell, i) => (i === line.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ").trimEnd();
  return [draw(header), ...lines.map(line => {
    const text = draw(line), code = COLORS[line[0]];
    return color && code ? `\x1b[${code}m${line[0]}\x1b[0m${text.slice(line[0].length)}` : text;
  })].join("\n");
}

if (args.has("--setup-herdr")) process.exit(setupHerdr());
if (args.has("--json")) {
  console.log(JSON.stringify({ schema_version: 1, sessions: readSessions({ prune: true }) }, null, 2));
  process.exit(0);
}
const draw = () => {
  const now = Date.now();
  const rows = readSessions({ now, prune: true });
  return table(rows, herdrSpaces(rows), now, process.stdout.isTTY);
};
if (args.has("--watch")) {
  const paint = () => process.stdout.write(`\x1b[2J\x1b[H${draw()}\n`);
  paint();
  setInterval(paint, 2000);
} else console.log(draw());

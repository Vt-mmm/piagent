#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/pi-session-stats.sh [project-path] [session-file]

Examples:
  scripts/pi-session-stats.sh .
  scripts/pi-session-stats.sh /path/to/project
  scripts/pi-session-stats.sh /path/to/project ~/.pi/agent/sessions/.../session.jsonl

Notes:
  - Reads exact Pi token/cache/cost totals via RPC get_session_stats.
  - If session-file is omitted, the newest persisted session whose header cwd matches project-path is used.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

# Both arguments are positional and the project path comes first, so a flag in
# either slot is a typo rather than a path. Saying so beats failing later with a
# message about a directory that was never meant to be one.
for argument in "${1:-}" "${2:-}"; do
  if [[ "$argument" == -* ]]; then
    echo "FAIL: this script takes <project-path> [session-file], not flags; received: $argument" >&2
    usage >&2
    exit 2
  fi
done

PROJECT_PATH="${1:-.}"
SESSION_FILE="${2:-}"

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "FAIL: project path does not exist: $PROJECT_PATH" >&2
  exit 1
fi

PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"

if [[ -z "$SESSION_FILE" ]]; then
  SESSION_FILE="$(node --input-type=module - "$PROJECT_PATH" <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectPath = process.argv[2];
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const sessionsDir = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
const candidates = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(target);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const firstLine = fs.readFileSync(target, "utf8").split(/\n/, 1)[0];
      const header = JSON.parse(firstLine);
      if (header.cwd !== projectPath) continue;
      const stat = fs.statSync(target);
      candidates.push({ target, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore malformed or inaccessible session files.
    }
  }
}

walk(sessionsDir);
candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
if (candidates[0]) process.stdout.write(candidates[0].target);
NODE
)"
fi

if [[ -z "$SESSION_FILE" || ! -f "$SESSION_FILE" ]]; then
  echo "FAIL: no Pi session file found for project: $PROJECT_PATH" >&2
  echo "Hint: run /session inside Pi, or pass the session file explicitly." >&2
  exit 1
fi

RPC_OUTPUT="$(
  printf '%s\n' '{"type":"get_session_stats","id":"piagent-usage"}' \
    | pi --mode rpc --session "$SESSION_FILE" --offline --approve
)"

node --input-type=module - "$RPC_OUTPUT" <<'NODE'
const input = process.argv[2] ?? "";

  const line = input
    .split(/\n+/)
    .find((item) => item.includes('"command":"get_session_stats"'));
  if (!line) {
    console.error("FAIL: get_session_stats response not found");
    process.exit(1);
  }
  const response = JSON.parse(line);
  if (!response.success) {
    console.error(`FAIL: ${response.error ?? "get_session_stats failed"}`);
    process.exit(1);
  }
  const data = response.data;
  const tokens = data.tokens ?? {};
  const context = data.contextUsage ?? {};
  const number = (value) => value === null || value === undefined ? "unknown" : Math.round(Number(value)).toLocaleString("en-US");
  const money = (value) => value === null || value === undefined ? "unknown" : `$${Number(value).toFixed(6)}`;
  const percent = (value) => value === null || value === undefined ? "unknown" : `${Number(value).toFixed(1)}%`;
  console.log(JSON.stringify({
    sessionFile: data.sessionFile,
    sessionId: data.sessionId,
    messages: {
      user: data.userMessages,
      assistant: data.assistantMessages,
      toolCalls: data.toolCalls,
      toolResults: data.toolResults,
      total: data.totalMessages
    },
    tokens: {
      input: tokens.input ?? null,
      output: tokens.output ?? null,
      cacheRead: tokens.cacheRead ?? null,
      cacheWrite: tokens.cacheWrite ?? null,
      total: tokens.total ?? null
    },
    cost: data.cost ?? null,
    contextUsage: context.tokens === undefined ? null : {
      tokens: context.tokens,
      contextWindow: context.contextWindow,
      percent: context.percent
    },
    summary: {
      tokens: `${number(tokens.total)} total (${number(tokens.input)} input, ${number(tokens.output)} output, ${number(tokens.cacheRead)} cache read, ${number(tokens.cacheWrite)} cache write)`,
      cost: money(data.cost),
      context: context.tokens === undefined ? "unknown" : `${number(context.tokens)} / ${number(context.contextWindow)} (${percent(context.percent)})`
    }
  }, null, 2));
NODE

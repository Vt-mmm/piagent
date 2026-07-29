#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage:
  scripts/pi-usage-history.mjs [project-path] [options]
  scripts/pi-usage-history.mjs --all-projects [options]

Options:
  --history              Accepted for piagent-usage wrapper compatibility.
  --all-projects         Include every Pi session under the session directory.
  --days N               Include activity from the last N days.
  --since YYYY-MM-DD     Include activity on or after this local date.
  --until YYYY-MM-DD     Include activity on or before this local date.
  --format table|json|csv|markdown
  --json                 Alias for --format json.
  --csv                  Alias for --format csv.
  --markdown             Alias for --format markdown.
  --include-subagents    Include subagent session files. Default.
  --no-subagents         Exclude files under sessions/subagent/.
  --limit N              Max session rows in table/markdown output. Default: 20.
  --sessions-dir PATH    Override Pi session root for tests or custom installs.
  -h, --help             Show this help.

Examples:
  piagent-usage --history .
  piagent-usage --history --days 7 --all-projects
  piagent-usage --history /path/to/project --json
`;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(2);
}

function parsePositiveInteger(raw, label) {
  if (!/^[1-9]\d*$/.test(String(raw ?? ""))) fail(`${label} must be a positive integer`);
  return Number(raw);
}

function parseLocalDateStart(raw, label) {
  const match = String(raw ?? "").match(DATE_ONLY);
  if (!match) fail(`${label} must use YYYY-MM-DD`);
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) fail(`${label} is not a valid date`);
  return date;
}

function parseLocalDateEnd(raw, label) {
  const start = parseLocalDateStart(raw, label);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
}

function parseArgs(argv) {
  const options = {
    allProjects: false,
    format: "table",
    includeSubagents: true,
    limit: 20,
    sessionsDir: process.env.PI_CODING_AGENT_SESSION_DIR
      || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions"),
    projectPath: undefined,
    since: undefined,
    until: undefined
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) fail(`Missing value for ${name}`);
      index += 1;
      return value;
    };

    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--history":
        break;
      case "--all-projects":
        options.allProjects = true;
        break;
      case "--days": {
        const days = parsePositiveInteger(readValue("--days"), "--days");
        options.since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        break;
      }
      case "--since":
        options.since = parseLocalDateStart(readValue("--since"), "--since");
        break;
      case "--until":
        options.until = parseLocalDateEnd(readValue("--until"), "--until");
        break;
      case "--format": {
        const format = readValue("--format");
        if (!["table", "json", "csv", "markdown"].includes(format)) {
          fail("--format must be one of table, json, csv, markdown");
        }
        options.format = format;
        break;
      }
      case "--json":
        options.format = "json";
        break;
      case "--csv":
        options.format = "csv";
        break;
      case "--markdown":
        options.format = "markdown";
        break;
      case "--include-subagents":
        options.includeSubagents = true;
        break;
      case "--no-subagents":
        options.includeSubagents = false;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(readValue("--limit"), "--limit");
        break;
      case "--sessions-dir":
        options.sessionsDir = path.resolve(readValue("--sessions-dir"));
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
        positionals.push(arg);
        break;
    }
  }

  if (positionals.length > 1) fail(`expected at most one project path, received ${positionals.length}`);
  if (positionals[0]) {
    const projectPath = path.resolve(positionals[0]);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      fail(`project path does not exist: ${projectPath}`);
    }
    options.projectPath = fs.realpathSync(projectPath);
  } else if (!options.allProjects) {
    options.projectPath = fs.realpathSync(process.cwd());
  }

  if (options.since && options.until && options.since > options.until) {
    fail("--since must be before or equal to --until");
  }
  return options;
}

function walkJsonl(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(target);
      }
    }
  }
  return out;
}

function parseIso(raw) {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function inRange(date, options) {
  if (!date) return true;
  if (options.since && date < options.since) return false;
  if (options.until && date > options.until) return false;
  return true;
}

function emptyTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    cost: 0
  };
}

function addTotals(target, usage) {
  target.input += numberValue(usage.input);
  target.output += numberValue(usage.output);
  target.cacheRead += numberValue(usage.cacheRead);
  target.cacheWrite += numberValue(usage.cacheWrite);
  target.reasoning += numberValue(usage.reasoning);
  target.total += numberValue(usage.totalTokens)
    || numberValue(usage.input) + numberValue(usage.output) + numberValue(usage.cacheRead) + numberValue(usage.cacheWrite);
  const cost = usage.cost;
  target.cost += typeof cost === "object" && cost !== null
    ? numberValue(cost.total)
    : numberValue(cost);
}

function numberValue(raw) {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function extractTextLength(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (block?.type === "text" && typeof block.text === "string") return sum + block.text.length;
    return sum;
  }, 0);
}

function summarizeSession(file, options) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }

  const summary = {
    id: path.basename(file, ".jsonl"),
    name: "",
    cwd: "",
    file,
    isSubagent: file.split(path.sep).includes("subagent"),
    provider: "",
    modelId: "",
    thinkingLevel: "",
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    countedFirstTimestamp: undefined,
    countedLastTimestamp: undefined,
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    promptChars: 0,
    tokens: emptyTotals(),
    toolNames: {},
    sizeBytes: stat.size,
    mtime: stat.mtime
  };

  let hasCountedActivity = false;
  const lines = fs.readFileSync(file, "utf8").split(/\n/);
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = parseIso(entry.timestamp ?? entry.message?.timestamp);
    if (ts) {
      if (!summary.firstTimestamp || ts < summary.firstTimestamp) summary.firstTimestamp = ts;
      if (!summary.lastTimestamp || ts > summary.lastTimestamp) summary.lastTimestamp = ts;
    }

    if (entry.type === "session") {
      if (entry.id) summary.id = String(entry.id);
      if (entry.cwd) summary.cwd = String(entry.cwd);
      continue;
    }
    if (entry.type === "model_change") {
      summary.provider = String(entry.provider ?? summary.provider);
      summary.modelId = String(entry.modelId ?? summary.modelId);
      continue;
    }
    if (entry.type === "thinking_level_change") {
      summary.thinkingLevel = String(entry.thinkingLevel ?? summary.thinkingLevel);
      continue;
    }
    if (entry.type === "session_info" && entry.name) {
      summary.name = String(entry.name);
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;

    const counted = inRange(ts ?? stat.mtime, options);
    if (!counted) continue;
    hasCountedActivity = true;
    const countedTs = ts ?? stat.mtime;
    if (!summary.countedFirstTimestamp || countedTs < summary.countedFirstTimestamp) summary.countedFirstTimestamp = countedTs;
    if (!summary.countedLastTimestamp || countedTs > summary.countedLastTimestamp) summary.countedLastTimestamp = countedTs;

    const message = entry.message;
    const role = message.role;
    summary.messages.total += 1;
    if (role === "user") {
      summary.messages.user += 1;
      summary.promptChars += extractTextLength(message.content);
    } else if (role === "assistant") {
      summary.messages.assistant += 1;
      if (message.provider && !summary.provider) summary.provider = String(message.provider);
      if (message.model && !summary.modelId) summary.modelId = String(message.model);
      if (message.usage) addTotals(summary.tokens, message.usage);
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== "toolCall") continue;
          summary.messages.toolCalls += 1;
          const name = String(block.name ?? "tool");
          summary.toolNames[name] = (summary.toolNames[name] ?? 0) + 1;
        }
      }
    } else if (role === "toolResult") {
      summary.messages.toolResults += 1;
      const name = String(message.toolName ?? "tool");
      summary.toolNames[name] = summary.toolNames[name] ?? 0;
    }
  }

  if (!summary.cwd) summary.cwd = "(unknown)";
  if (!summary.firstTimestamp) summary.firstTimestamp = stat.mtime;
  if (!summary.lastTimestamp) summary.lastTimestamp = stat.mtime;
  if (!summary.countedFirstTimestamp) summary.countedFirstTimestamp = summary.firstTimestamp;
  if (!summary.countedLastTimestamp) summary.countedLastTimestamp = summary.lastTimestamp;

  if (!hasCountedActivity && (options.since || options.until)) return undefined;
  return summary;
}

function loadReport(options) {
  const files = walkJsonl(options.sessionsDir);
  const sessions = [];
  for (const file of files) {
    const isSubagent = file.split(path.sep).includes("subagent");
    if (isSubagent && !options.includeSubagents) continue;
    const session = summarizeSession(file, options);
    if (!session) continue;
    if (!options.allProjects && options.projectPath && session.cwd !== options.projectPath) continue;
    sessions.push(session);
  }
  sessions.sort((a, b) => b.countedLastTimestamp - a.countedLastTimestamp);
  return buildReport(options, sessions);
}

function buildReport(options, sessions) {
  const totals = {
    sessions: sessions.length,
    mainSessions: sessions.filter((s) => !s.isSubagent).length,
    subagentSessions: sessions.filter((s) => s.isSubagent).length,
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    promptChars: 0,
    tokens: emptyTotals()
  };
  const projects = new Map();
  const tools = {};
  for (const session of sessions) {
    for (const key of Object.keys(totals.messages)) totals.messages[key] += session.messages[key];
    totals.promptChars += session.promptChars;
    for (const key of Object.keys(totals.tokens)) totals.tokens[key] += session.tokens[key];
    const project = projects.get(session.cwd) ?? {
      cwd: session.cwd,
      sessions: 0,
      mainSessions: 0,
      subagentSessions: 0,
      tokens: emptyTotals(),
      cost: 0
    };
    project.sessions += 1;
    if (session.isSubagent) project.subagentSessions += 1;
    else project.mainSessions += 1;
    for (const key of Object.keys(project.tokens)) project.tokens[key] += session.tokens[key];
    project.cost = project.tokens.cost;
    projects.set(session.cwd, project);
    for (const [name, count] of Object.entries(session.toolNames)) {
      tools[name] = (tools[name] ?? 0) + count;
    }
  }

  const projectRows = [...projects.values()].sort((a, b) => b.tokens.total - a.tokens.total);
  const toolRows = Object.entries(tools)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      projectPath: options.allProjects ? null : options.projectPath,
      allProjects: options.allProjects,
      includeSubagents: options.includeSubagents,
      sessionsDir: options.sessionsDir,
      since: options.since?.toISOString() ?? null,
      until: options.until?.toISOString() ?? null
    },
    totals,
    projects: projectRows,
    tools: toolRows,
    sessions
  };
}

function compact(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function money(n) {
  return `$${n.toFixed(6)}`;
}

function iso(date) {
  return date ? date.toISOString() : "";
}

function localLabel(date) {
  if (!date) return "?";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function rangeLabel(report) {
  const { since, until } = report.scope;
  if (!since && !until) return "all time";
  return `${since ? since.slice(0, 10) : "beginning"} -> ${until ? until.slice(0, 10) : "now"}`;
}

function renderTable(report, limit) {
  const lines = [];
  lines.push("PiAgent usage history");
  lines.push(`Scope: ${report.scope.allProjects ? "all projects" : report.scope.projectPath}`);
  lines.push(`Range: ${rangeLabel(report)}`);
  lines.push(`Sessions: ${report.totals.sessions} (${report.totals.mainSessions} main, ${report.totals.subagentSessions} subagent)`);
  lines.push(`Tokens: ${compact(report.totals.tokens.total)} total (${compact(report.totals.tokens.input)} input, ${compact(report.totals.tokens.output)} output, ${compact(report.totals.tokens.cacheRead)} cache read, ${compact(report.totals.tokens.cacheWrite)} cache write, ${compact(report.totals.tokens.reasoning)} reasoning)`);
  lines.push(`Cost: ${money(report.totals.tokens.cost)}`);
  lines.push(`Messages: ${report.totals.messages.user} user, ${report.totals.messages.assistant} assistant, ${report.totals.messages.toolCalls} tool calls, ${report.totals.messages.toolResults} tool results`);
  if (report.projects.length) {
    lines.push("");
    lines.push("Projects:");
    for (const project of report.projects.slice(0, 10)) {
      lines.push(`  ${compact(project.tokens.total).padStart(8)} tok  ${money(project.tokens.cost).padStart(11)}  ${String(project.sessions).padStart(3)} sessions  ${project.cwd}`);
    }
  }
  if (report.sessions.length) {
    lines.push("");
    lines.push(`Top sessions (${Math.min(limit, report.sessions.length)} of ${report.sessions.length}):`);
    for (const session of report.sessions.slice(0, limit)) {
      const kind = session.isSubagent ? "sub" : "main";
      const model = session.modelId || session.provider || "?";
      lines.push(`  ${localLabel(session.countedLastTimestamp)}  ${kind.padEnd(4)} ${compact(session.tokens.total).padStart(8)} tok  ${money(session.tokens.cost).padStart(11)}  ${String(session.messages.user).padStart(2)}p/${String(session.messages.toolCalls).padStart(2)}t  ${model}  ${session.name || session.id}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(report, limit) {
  const lines = [];
  lines.push("# PiAgent Usage History");
  lines.push("");
  lines.push(`- Scope: ${report.scope.allProjects ? "all projects" : report.scope.projectPath}`);
  lines.push(`- Range: ${rangeLabel(report)}`);
  lines.push(`- Sessions: ${report.totals.sessions} (${report.totals.mainSessions} main, ${report.totals.subagentSessions} subagent)`);
  lines.push(`- Tokens: ${report.totals.tokens.total.toLocaleString("en-US")}`);
  lines.push(`- Cost: ${money(report.totals.tokens.cost)}`);
  lines.push("");
  lines.push("## Projects");
  lines.push("");
  lines.push("| Project | Sessions | Tokens | Cost |");
  lines.push("|---|---:|---:|---:|");
  for (const project of report.projects.slice(0, 20)) {
    lines.push(`| ${escapeMarkdown(project.cwd)} | ${project.sessions} | ${project.tokens.total} | ${money(project.tokens.cost)} |`);
  }
  lines.push("");
  lines.push("## Sessions");
  lines.push("");
  lines.push("| Last activity | Kind | Session | Model | Prompts | Tools | Tokens | Cost |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|");
  for (const session of report.sessions.slice(0, limit)) {
    lines.push(`| ${localLabel(session.countedLastTimestamp)} | ${session.isSubagent ? "subagent" : "main"} | ${escapeMarkdown(session.name || session.id)} | ${escapeMarkdown(session.modelId || session.provider || "?")} | ${session.messages.user} | ${session.messages.toolCalls} | ${session.tokens.total} | ${money(session.tokens.cost)} |`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeMarkdown(raw) {
  return String(raw).replaceAll("|", "\\|");
}

function csvEscape(raw) {
  const s = String(raw ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replaceAll("\"", "\"\"")}"`;
}

function renderCsv(report) {
  const columns = [
    "session_id", "name", "cwd", "kind", "first_timestamp", "last_timestamp",
    "provider", "model", "thinking_level", "user_messages", "assistant_messages",
    "tool_calls", "tool_results", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "total_tokens", "cost_usd", "file"
  ];
  const rows = [columns.join(",")];
  for (const s of report.sessions) {
    rows.push([
      s.id, s.name, s.cwd, s.isSubagent ? "subagent" : "main", iso(s.firstTimestamp), iso(s.lastTimestamp),
      s.provider, s.modelId, s.thinkingLevel, s.messages.user, s.messages.assistant,
      s.messages.toolCalls, s.messages.toolResults, s.tokens.input, s.tokens.output, s.tokens.cacheRead,
      s.tokens.cacheWrite, s.tokens.reasoning, s.tokens.total, s.tokens.cost.toFixed(6), s.file
    ].map(csvEscape).join(","));
  }
  return `${rows.join("\n")}\n`;
}

function toJson(report) {
  return JSON.stringify(report, (_key, value) => value instanceof Date ? value.toISOString() : value, 2) + "\n";
}

function render(report, options) {
  switch (options.format) {
    case "json":
      return toJson(report);
    case "csv":
      return renderCsv(report);
    case "markdown":
      return renderMarkdown(report, options.limit);
    default:
      return renderTable(report, options.limit);
  }
}

export {
  buildReport,
  loadReport,
  parseArgs,
  render,
  summarizeSession,
  walkJsonl
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const report = loadReport(options);
  process.stdout.write(render(report, options));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exit(1);
  });
}

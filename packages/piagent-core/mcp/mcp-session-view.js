import { REPOSITORY_SCOPES, SCOPES, collectServers } from "./mcp-config-layers.js";
import { approvalState } from "./mcp-approval-store.js";
import { maskServerEntry } from "./mcp-server-entry.js";
import { evaluateServerReadiness } from "./mcp-auth-readiness.js";
import { CATALOG_PREREQUISITES } from "./mcp-server-catalog.js";

// What the terminal CLI and the in-session `/piagent-mcp` command both show.
//
// The same question gets asked from two places — a shell prompt and a Pi
// session — and two answers that disagree about whether a server is usable is
// worse than either answer alone. So the reading, the states and the wording
// live here once, and both surfaces print what this returns.
//
// Read-only by construction: nothing here writes a config or an approval.

/** @typedef {import("./mcp-auth-readiness.js").ReadinessState} ReadinessState */

export class McpViewError extends Error {}

/**
 * The stdio command line, or the remote URL, shortened for a table cell.
 * @param {Record<string, unknown>} entry
 * @param {number} [limit]
 * @returns {string}
 */
export function describeTarget(entry, limit = 56) {
  if (typeof entry.url === "string") return entry.url;
  const argv = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((item) => typeof item === "string");
  const text = argv.join(" ");
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/**
 * Every server visible from a project, with its readiness resolved.
 * @param {{projectPath: string, scopes?: string[]}} options
 */
export function collectServerRows(options) {
  const { projectPath, scopes } = options;
  if (scopes) {
    for (const scope of scopes) {
      if (!SCOPES.includes(scope)) throw new McpViewError(`unsupported scope: ${scope}`);
    }
  }
  return collectServers({ projectPath, scopes }).map((server) => ({
    ...server,
    transport: typeof server.entry.url === "string" ? "http" : "stdio",
    target: describeTarget(server.entry),
    readiness: evaluateServerReadiness(server, { projectPath })
  }));
}

/**
 * Servers that will not answer a tool call. `oauth` is excluded: it may already
 * be signed in, and this cannot tell.
 * @param {ReturnType<typeof collectServerRows>} rows
 */
export function blockedRows(rows) {
  return rows.filter((row) => row.readiness.state !== "ready" && row.readiness.state !== "oauth");
}

/**
 * One named server, resolved to a single scope. `listHint` is the caller's own
 * way of listing servers, so the error names a command the reader can actually
 * run from where they are.
 *
 * @param {{projectPath: string, name: string, scope?: string, listHint?: string, scopeHint?: string}} options
 */
export function describeServer(options) {
  const { projectPath, name, scope, listHint, scopeHint = "--scope" } = options;
  const matches = collectServerRows({ projectPath, scopes: scope ? [scope] : undefined })
    .filter((row) => row.name === name);
  if (matches.length === 0) {
    throw new McpViewError(scope
      ? `no server named ${name} in ${scope} scope`
      : `no server named ${name}.${listHint ? ` Run \`${listHint}\` to see what is configured.` : ""}`);
  }
  if (matches.length > 1) {
    throw new McpViewError(
      `${name} is defined in more than one scope (${matches.map((row) => row.scope).join(", ")}). ` +
      `Pass ${scopeHint} to say which one.`
    );
  }
  const row = matches[0];
  const approval = REPOSITORY_SCOPES.has(row.scope)
    ? approvalState({ projectPath, name, entry: row.entry })
    : undefined;
  return { ...row, masked: maskServerEntry(row.entry), approval };
}

/**
 * Readiness remedies are written as terminal commands, because that is where
 * every one of them can be run. Inside a session the same step is a slash
 * command, and telling a reader to shell out for something they can do where
 * they are standing is how a surface ends up feeling harder than it is.
 *
 * @param {string | undefined} remedy
 * @param {boolean} inSession
 * @returns {string | undefined}
 */
export function remedyFor(remedy, inSession) {
  if (!remedy || !inSession) return remedy;
  return remedy.replace(/(^|[\s`])piagent-mcp /g, "$1/piagent-mcp ");
}

/** Left-aligned columns sized to their contents. */
function table(headers, rows) {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((cells) => cells[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/**
 * @param {ReturnType<typeof collectServerRows>} rows
 * @returns {string}
 */
export function formatServerTable(rows) {
  if (rows.length === 0) return "";
  return table(
    ["NAME", "SCOPE", "TRANSPORT", "TARGET", "STATE"],
    rows.map((row) => [row.name, row.scope, row.transport, row.target, row.readiness.state])
  );
}

/** Fields worth showing; the rest of an entry is noise in a status view. */
const DETAIL_FIELDS = ["url", "command", "args", "env", "headers", "auth", "bearerTokenEnvVar"];

/**
 * @param {ReturnType<typeof describeServer>} detail
 * @param {{inSession?: boolean}} [options]
 * @returns {string[]}
 */
export function formatServerDetail(detail, options = {}) {
  const lines = [
    detail.name,
    `  scope: ${detail.scope}`,
    `  file: ${detail.file}`,
    `  transport: ${detail.transport}`
  ];
  for (const key of DETAIL_FIELDS) {
    const item = detail.masked[key];
    if (item === undefined) continue;
    lines.push(`  ${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`);
  }
  lines.push(`  state: ${detail.readiness.state} (${detail.readiness.detail})`);
  const next = remedyFor(detail.readiness.remedy, options.inSession === true);
  if (next) lines.push(`  next: ${next}`);
  if (detail.approval) lines.push(`  approval: ${detail.approval.state} (${detail.approval.digest})`);
  return lines;
}

/**
 * The readiness report, one line per server plus the remedy for anything stuck.
 * `dockerRunning` is passed in rather than probed: the probe spawns a process
 * and only the caller knows whether it can afford that.
 *
 * @param {ReturnType<typeof collectServerRows>} rows
 * @param {{dockerRunning?: boolean, rerun?: string, inSession?: boolean}} [options]
 * @returns {{lines: string[], problems: number}}
 */
export function formatDoctorReport(rows, options = {}) {
  if (rows.length === 0) return { lines: ["No MCP servers configured."], problems: 0 };

  const lines = [];
  let problems = 0;
  for (const row of rows) {
    const usable = row.readiness.state === "ready" || row.readiness.state === "oauth";
    if (!usable) problems += 1;
    lines.push(`${usable ? "OK  " : "NEED"} ${row.name} (${row.scope}): ${row.readiness.detail}`);
    const remedy = remedyFor(row.readiness.remedy, options.inSession === true);
    if (remedy) lines.push(`       -> ${remedy}`);
  }
  if (options.dockerRunning === false) {
    problems += 1;
    lines.push("NEED docker: installed but the daemon is not responding");
    lines.push(`       -> start Docker Desktop, then re-run ${options.rerun ?? "the check"}`);
  }
  const prerequisites = rows.flatMap((row) => (CATALOG_PREREQUISITES[row.name] ?? []).map((item) => `  ${row.name}: ${item}`));
  if (prerequisites.length > 0) lines.push("", "Pinned servers also expect:", ...prerequisites);
  return { lines, problems };
}

/** True when any configured server runs through the docker CLI. */
export function usesDocker(rows) {
  return rows.some((row) => row.entry.command === "docker");
}

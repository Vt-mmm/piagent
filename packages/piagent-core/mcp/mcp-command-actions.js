import {
  REPOSITORY_SCOPES,
  collectServers,
  isRecord,
  mergedServerEntry,
  readMcpConfig,
  writeMcpConfig
} from "./mcp-config-layers.js";
import { approvalStorePath, approvalState, clearApproval, recordApproval } from "./mcp-approval-store.js";
import { maskServerEntry } from "./mcp-server-entry.js";
import {
  McpViewError,
  collectServerRows,
  describeServer,
  formatDoctorReport,
  formatServerDetail,
  formatServerTable,
  sessionMcpState
} from "./mcp-session-view.js";

// What `/piagent-mcp` does, separated from how a session shows it.
//
// Each action takes plain options and returns a report: a one-line notice, the
// lines to display, and the structured detail behind them. Nothing here knows
// about `pi`, a UI, or a terminal, so the menu path and the typed-subcommand
// path cannot drift into doing different things — they call the same function.

export { McpViewError };

/** Actions that only read. The rest write a config file or an approval. */
export const READ_ACTIONS = new Set(["status", "get", "doctor"]);

/** Actions that name a single server. `reset` accepts one but does not need it. */
export const SERVER_ACTIONS = new Set(["get", "approve", "reject", "reset", "enable", "disable"]);

/** Writes that belong in a shell, with the command to run there. */
export const TERMINAL_ONLY = new Map([
  ["add", "piagent-mcp add <name> [--scope <scope>] --url <url> | -- <command> [args...]"],
  ["remove", "piagent-mcp remove <name> --scope <scope>"],
  ["preset", "piagent-mcp --preset <core|popular|documents|google|design> --scope <scope>"]
]);

export const HELP_LINES = [
  "/piagent-mcp                    open the menu",
  "/piagent-mcp status             every configured server, with scope and readiness",
  "/piagent-mcp get <name>         one server in detail, credential values masked",
  "/piagent-mcp doctor             what each server still needs before it can answer",
  "/piagent-mcp approve <name>     allow a server this repository defines",
  "/piagent-mcp reject <name>      refuse it",
  "/piagent-mcp reset [name]       forget the decision, or every decision",
  "/piagent-mcp enable|disable <name>",
  "",
  "Adding, removing and presets are terminal commands: run `piagent-mcp --help`.",
  "Live connection state and OAuth sign-in belong to the adapter: /mcp and /mcp-auth."
];

/**
 * The menu, built from what this project actually has.
 *
 * An entry is offered only when it would do something: approving is not offered
 * when no server here needs a decision, and a menu that lists impossible actions
 * teaches the reader to stop reading it. Counts go in the labels so the menu
 * answers part of the question before anything is picked.
 *
 * @param {{projectPath: string}} options
 */
export function menuOptions(options) {
  const state = sessionMcpState({ projectPath: options.projectPath });
  const { rows, blocked: stuck } = state;
  // Not `REPOSITORY_SCOPES.has(row.scope)`: a repository-relative import
  // declared by a `global` config produces a row whose scope is `global` and
  // whose definition came out of the clone. Those were the rows the menu never
  // offered to approve, so the only route to a decision was knowing to type the
  // subcommand -- for exactly the servers whose origin is hardest to see.
  const repositoryRows = rows.filter((row) => row.requiresApproval);
  const decisions = repositoryRows.map((row) => ({
    row,
    state: approvalState({ projectPath: options.projectPath, name: row.name, entry: row.entry }).state
  }));
  const undecided = decisions.filter((item) => item.state !== "approved");
  const decided = decisions.filter((item) => item.state !== "pending");
  const disabled = rows.filter((row) => row.readiness.state === "disabled");
  const enabled = rows.filter((row) => row.readiness.state !== "disabled");

  const entries = [
    {
      value: "status",
      label: state.usable
        ? (rows.length === 0 ? "Servers — none configured" : `Servers — ${rows.length - stuck.length}/${rows.length} ready`)
        : "Servers — every tool call blocked",
      description: state.usable
        ? "Every server visible from this project, with its scope and state"
        : "Config here leaves nothing to check an approval against"
    }
  ];
  // Ahead of everything per-server: while this stands, no decision about an
  // individual server changes whether anything runs.
  if (!state.usable) {
    entries.push({
      value: "doctor",
      label: `Doctor — ${state.blockingConfig.length} config problem${state.blockingConfig.length === 1 ? "" : "s"} blocking every call`,
      description: "Which file to edit before any server can answer",
      recommended: true
    });
  } else if (stuck.length > 0) {
    entries.push({
      value: "doctor",
      label: `Doctor — ${stuck.length} need attention`,
      description: "What each blocked server still needs",
      recommended: true
    });
  } else if (rows.length > 0) {
    entries.push({ value: "doctor", label: "Doctor — all reachable", description: "Re-check what each server needs" });
  }
  if (rows.length > 0) {
    entries.push({ value: "get", label: "Inspect a server", description: "Full definition, credential values masked" });
  }
  if (undecided.length > 0) {
    entries.push({
      value: "approve",
      label: `Approve a repository server — ${undecided.length} waiting`,
      description: "This repository defines it; nobody on this machine has allowed it yet",
      recommended: stuck.length === 0
    });
    entries.push({ value: "reject", label: "Reject a repository server", description: "Refuse it for this project" });
  } else if (repositoryRows.length > 0) {
    entries.push({ value: "reject", label: "Reject a repository server", description: "Withdraw a server this project had allowed" });
  }
  if (decided.length > 0) {
    entries.push({ value: "reset", label: "Forget a decision", description: "Return a server to pending so it is asked again" });
  }
  if (enabled.length > 0) {
    entries.push({ value: "disable", label: "Turn a server off", description: "Stop using it without losing its definition" });
  }
  if (disabled.length > 0) {
    entries.push({ value: "enable", label: `Turn a server back on — ${disabled.length} off`, description: "Restore a disabled server" });
  }
  entries.push({ value: "add", label: "Add a server", description: "Shows the terminal command; writing config is not a slash command" });
  entries.push({ value: "help", label: "All subcommands", description: "Everything /piagent-mcp accepts" });
  return { entries, rows };
}

/**
 * Servers an action can be applied to. Approving a server the repository does
 * not define is not a thing, so it is not offered.
 *
 * @param {{projectPath: string, action: string}} options
 */
export function serverChoices(options) {
  const { projectPath, action } = options;
  const rows = collectServerRows({ projectPath });
  const filtered = rows.filter((row) => {
    if (action === "approve" || action === "reject" || action === "reset") return row.requiresApproval;
    // A server reached through `imports` lives in a file this command does not
    // own. Offering it here produced a write against the declaring layer that
    // reported success and changed nothing the adapter reads.
    if (action === "enable" || action === "disable") {
      if (row.origin?.startsWith("import:")) return false;
    }
    if (action === "enable") return row.readiness.state === "disabled";
    if (action === "disable") return row.readiness.state !== "disabled";
    return true;
  });
  return filtered.map((row) => ({
    value: row.name,
    label: `${row.name} (${row.scope})`,
    description: row.readiness.detail
  }));
}

/** @param {{projectPath: string, scope?: string}} options */
export function status(options) {
  const state = sessionMcpState({
    projectPath: options.projectPath,
    scopes: options.scope ? [options.scope] : undefined
  });
  const { rows, blocked: stuck } = state;
  // Reported before the per-server table, and it decides the headline. A status
  // that says "0 servers configured" in a session where every tool call is being
  // refused is not a smaller version of the truth, it points at the wrong file.
  const blocking = state.blockingConfig.map((problem) => `BLOCKED every tool call: ${problem.detail}`);
  const summary = !state.usable
    ? "MCP: every tool call blocked by config"
    : rows.length === 0
      ? "MCP: no servers configured"
      : `MCP: ${rows.length - stuck.length}/${rows.length} ready`;
  return {
    notify: { message: summary, level: state.usable && stuck.length === 0 ? "info" : "warning" },
    lines: [
      ...blocking,
      ...(blocking.length > 0 ? [""] : []),
      ...(rows.length === 0
        ? (state.usable
          ? ["No MCP servers configured.", "Seed the pinned baseline in a terminal: piagent-mcp --preset core --scope global"]
          : [])
        : [formatServerTable(rows), ...(stuck.length > 0 ? ["", `${stuck.length} not usable yet. Run /piagent-mcp doctor.`] : [])])
    ],
    details: {
      project: options.projectPath,
      usable: state.usable,
      blockingConfig: state.blockingConfig,
      servers: rows.map((row) => ({
        name: row.name,
        scope: row.scope,
        origin: row.origin,
        requiresApproval: row.requiresApproval,
        state: row.readiness.state,
        detail: row.readiness.detail
      }))
    }
  };
}

/** @param {{projectPath: string, name: string, scope?: string}} options */
export function detail(options) {
  const found = describeServer({
    projectPath: options.projectPath,
    name: options.name,
    scope: options.scope,
    listHint: "/piagent-mcp",
    scopeHint: "--scope"
  });
  return {
    notify: { message: `MCP ${options.name}: ${found.readiness.state}`, level: "info" },
    lines: formatServerDetail(found, { inSession: true }),
    details: { name: options.name, scope: found.scope, file: found.file, state: found.readiness.state, entry: found.masked }
  };
}

/**
 * The Docker daemon probe is deliberately absent: it spawns a process, and this
 * runs inside the session's own turn. `piagent-mcp doctor` in a terminal does it.
 *
 * @param {{projectPath: string}} options
 */
export function doctor(options) {
  const state = sessionMcpState({ projectPath: options.projectPath });
  const report = formatDoctorReport(state.rows, { rerun: "/piagent-mcp doctor", inSession: true });
  // A layer nobody can parse counts as a problem: it is hiding whatever it
  // defines. An import declaration does not — the servers it brings in are in
  // the table above with their own approval state — but it is named, because
  // reading the repository's config alone would not reveal where they came from.
  const problems = report.problems + state.unreadable.length + state.blockingConfig.length;
  return {
    notify: {
      message: problems === 0 ? "MCP: every server can be reached" : `MCP: ${problems} need attention`,
      level: problems === 0 ? "info" : "warning"
    },
    lines: [
      // First. No per-server remedy below is worth acting on while one of these
      // stands, because none of them makes a tool call succeed.
      ...state.blockingConfig.map((problem) => `BLOCKED every tool call: ${problem.detail}`),
      ...(state.blockingConfig.length > 0 ? [""] : []),
      ...report.lines,
      ...state.unreadable.map((layer) => `Unreadable ${layer.scope} config: ${layer.detail}`),
      ...state.imports.map((layer) =>
        `${layer.file} imports servers from ${layer.kinds.join(", ")} config; ` +
        "they need approval here like any server the repository defines."),
      ...(problems === 0 ? [] : ["", "The Docker daemon check is terminal-only: piagent-mcp doctor"])
    ],
    details: {
      project: options.projectPath,
      problems,
      usable: state.usable,
      blockingConfig: state.blockingConfig,
      unreadableLayers: state.unreadable.map((layer) => layer.scope),
      repositoryImports: state.imports.map((layer) => ({ scope: layer.scope, kinds: layer.kinds }))
    }
  };
}

/** @param {{projectPath: string, name: string, decision: "approved"|"rejected"}} options */
export function decide(options) {
  const { projectPath, name, decision } = options;
  const matches = collectServers({ projectPath, scopes: [...REPOSITORY_SCOPES] }).filter((server) => server.name === name);
  if (matches.length === 0) {
    throw new McpViewError(
      `${name} is not defined by this repository. Approval only applies to servers in ${[...REPOSITORY_SCOPES].join(" or ")} scope.`
    );
  }
  if (matches.length > 1) {
    throw new McpViewError(`${name} is defined in ${matches.map((server) => server.scope).join(" and ")}; remove one.`);
  }

  const server = matches[0];
  const before = approvalState({ projectPath, name, entry: server.entry });
  // Approving without reading it is the failure this gate exists to prevent, so
  // the definition is put in front of the operator alongside the decision.
  //
  // What is shown is the merged entry, not this layer's fragment. The adapter
  // merges a same-named server key by key across layers, so a repository that
  // declares only `{"args": ["--evil"]}` gets the command from a lower layer --
  // and a preview of the fragment showed the operator an argument list with no
  // command attached while consenting to a full command line.
  const preview = decision === "approved" && before.state !== "approved"
    ? [JSON.stringify(maskServerEntry(mergedServerEntry({ projectPath, name, entry: server.entry })), null, 2), ""]
    : [];
  // A decision that was not written is not a decision. Reporting success here
  // would leave the operator believing a server is approved while the gate keeps
  // blocking it, or worse, believing one is rejected while nothing recorded it.
  if (!recordApproval({ projectPath, name, entry: server.entry, decision })) {
    throw new McpViewError(
      `could not write ${approvalStorePath() ?? "the approval store"}; ${name} is still ${before.state}`
    );
  }
  const after = approvalState({ projectPath, name, entry: server.entry });
  return {
    notify: { message: `MCP ${name}: ${decision}`, level: "info" },
    lines: [
      ...preview,
      `${decision === "approved" ? "Approved" : "Rejected"} MCP server ${name} (${server.scope}) for ${projectPath}`,
      `Pinned to this definition: ${after.digest}`,
      "Changing the server's command, URL or arguments returns it to pending."
    ],
    details: { name, scope: server.scope, decision, digest: after.digest, previous: before.state }
  };
}

/** @param {{projectPath: string, name?: string}} options */
export function reset(options) {
  const { projectPath, name } = options;
  if (!clearApproval({ projectPath, name })) {
    throw new McpViewError(`could not write ${approvalStorePath() ?? "the approval store"}; nothing was forgotten`);
  }
  return {
    notify: { message: name ? `MCP ${name}: decision forgotten` : "MCP: all decisions forgotten", level: "info" },
    lines: [name
      ? `Forgot the decision for ${name} in ${projectPath}`
      : `Forgot every MCP approval decision for ${projectPath}`],
    details: { name: name ?? null, decision: "reset" }
  };
}

/**
 * A server this command has no file of its own to edit: it was read out of
 * another tool's config through `imports`. The write used to land in whichever
 * layer declared the import, where the adapter never looks for it, so the
 * command reported the server disabled and the next tool call still reached it.
 *
 * @param {{name: string, origin?: string, scope: string, file: string}} found
 * @param {string} action
 */
function assertOwnedByThisTool(found, action) {
  if (!found.origin?.startsWith("import:")) return;
  const kind = found.origin.slice("import:".length);
  throw new McpViewError(
    `${found.name} is not defined by any config this command owns. The ${found.scope} config imports ${kind}, ` +
    `and the definition lives in ${found.file}. Edit that file to ${action} it, or drop "${kind}" from the imports list.`
  );
}

/** @param {{projectPath: string, name: string, scope?: string, enabled: boolean}} options */
export function toggle(options) {
  const { projectPath, name, scope, enabled } = options;
  const found = describeServer({ projectPath, name, scope, listHint: "/piagent-mcp", scopeHint: "--scope" });
  assertOwnedByThisTool(found, enabled ? "enable" : "disable");
  const config = readMcpConfig(found.file);
  const entry = { ...(isRecord(config.mcpServers[name]) ? config.mcpServers[name] : {}) };
  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  config.mcpServers[name] = entry;
  writeMcpConfig(found.file, config);
  return {
    notify: { message: `MCP ${name}: ${enabled ? "enabled" : "disabled"}`, level: "info" },
    lines: [
      `${enabled ? "Enabled" : "Disabled"} MCP server ${name} in ${found.scope} scope`,
      `File modified: ${found.file}`,
      ...(enabled ? [] : ["The definition is kept, so /piagent-mcp enable restores it."]),
      "The adapter reads this at startup: run /reload for it to take effect in this session."
    ],
    details: { name, scope: found.scope, file: found.file, enabled }
  };
}

/** @param {string} action */
export function terminalOnly(action) {
  const command = TERMINAL_ONLY.get(action);
  if (!command) return undefined;
  return {
    notify: { message: `MCP: ${action} is a terminal command`, level: "warning" },
    // Why this line sits where it does belongs in the docs. What an operator
    // needs here is the command to run and the reason it is not this one.
    lines: [
      `${action} writes a server definition, so it stays in the terminal:`,
      `  ${command}`,
      "",
      "Shell quoting, ${VAR} references and a `--` command line are a shell's job.",
      "Re-reading them here would be a second, worse parser."
    ],
    details: { action, command }
  };
}

export function help() {
  return {
    notify: { message: "MCP: subcommands", level: "info" },
    lines: HELP_LINES,
    details: { actions: [...READ_ACTIONS, ...SERVER_ACTIONS] }
  };
}

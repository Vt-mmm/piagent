import fs from "node:fs";
import path from "node:path";
import { REPOSITORY_SCOPES } from "./mcp-config-layers.js";
import { approvalState } from "./mcp-approval-store.js";
import { CATALOG_OPTIONAL_ENV } from "./mcp-server-catalog.js";

// Whether a configured server can actually be used, answered from state this
// process already has. No network, no child process: this runs at session start,
// and a check that costs a round trip would be paid on every session for
// information that changes when somebody edits a config.
//
// The line it will not cross is guessing. Two things are knowable here — an
// environment variable a config references is set or it is not, an executable is
// on PATH or it is not — and those are reported. Whether an OAuth sign-in is
// still valid is known to Pi and not to this file, so it is reported as
// "sign-in is handled elsewhere" rather than as a failure that may not be one.

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * @typedef {"disabled"|"rejected"|"approval-changed"|"pending-approval"|"needs-command"|"needs-env"|"oauth"|"ready"} ReadinessState
 */

/**
 * States that mean the server will not answer a tool call. `oauth` is not one of
 * them: it may well be signed in already.
 * @type {Set<ReadinessState>}
 */
export const BLOCKING_STATES = new Set([
  "disabled", "rejected", "approval-changed", "pending-approval", "needs-command", "needs-env"
]);

/**
 * Every `${VAR}` a server entry references, wherever it appears.
 * @param {unknown} entry
 * @returns {string[]}
 */
export function referencedEnvVars(entry) {
  const names = new Set();
  walk(entry, (text) => {
    for (const match of text.matchAll(ENV_REFERENCE)) names.add(match[1]);
  });
  return [...names].sort();
}

/** @param {unknown} value @param {(text: string) => void} visit @returns {void} */
function walk(value, visit) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) walk(item, visit);
  }
}

/**
 * @param {string} command
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {boolean}
 */
export function commandOnPath(command, options = {}) {
  const env = options.env ?? process.env;
  if (typeof command !== "string" || command.length === 0) return false;
  // An explicit path is checked where it points rather than searched for.
  if (command.includes(path.sep)) return isExecutable(command);
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    if (isExecutable(path.join(directory, command))) return true;
  }
  return false;
}

/** @param {string} file @returns {boolean} */
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @typedef {object} ServerReadiness
 * @property {string} name
 * @property {string} scope
 * @property {ReadinessState} state
 * @property {string} detail human-readable, never contains a value
 * @property {string} [remedy] the command that resolves it
 * @property {string[]} missingEnv
 */

/**
 * @param {{name: string, scope: string, entry: Record<string, unknown>}} server
 * @param {{projectPath: string, env?: Record<string, string|undefined>, home?: string, store?: Record<string, unknown>}} options
 * @returns {ServerReadiness}
 */
export function evaluateServerReadiness(server, options) {
  const env = options.env ?? process.env;
  const base = { name: server.name, scope: server.scope, missingEnv: /** @type {string[]} */ ([]) };

  if (server.entry.enabled === false) {
    return { ...base, state: "disabled", detail: "disabled in config", remedy: `piagent-mcp enable ${server.name} --scope ${server.scope}` };
  }

  if (REPOSITORY_SCOPES.has(server.scope)) {
    const approval = approvalState({
      projectPath: options.projectPath,
      name: server.name,
      entry: server.entry,
      store: options.store,
      home: options.home
    });
    if (approval.state === "rejected") {
      return { ...base, state: "rejected", detail: "rejected for this project", remedy: `piagent-mcp approve ${server.name}` };
    }
    if (approval.state === "changed") {
      return {
        ...base,
        state: "approval-changed",
        detail: "definition changed since it was approved",
        remedy: `piagent-mcp get ${server.name} then piagent-mcp approve ${server.name}`
      };
    }
    if (approval.state === "pending") {
      return {
        ...base,
        state: "pending-approval",
        detail: `defined by this repository in ${server.scope} scope and not approved here`,
        remedy: `piagent-mcp approve ${server.name}`
      };
    }
  }

  if (typeof server.entry.command === "string" && !commandOnPath(server.entry.command, { env })) {
    return {
      ...base,
      state: "needs-command",
      detail: `${server.entry.command} is not on PATH`,
      remedy: `install ${server.entry.command}, or edit the server with piagent-mcp add ${server.name} --scope ${server.scope} -- <command>`
    };
  }

  const optional = new Set(CATALOG_OPTIONAL_ENV[server.name] ?? []);
  const missingEnv = referencedEnvVars(server.entry)
    .filter((name) => !optional.has(name))
    .filter((name) => !env[name]?.trim());
  if (missingEnv.length > 0) {
    return {
      ...base,
      missingEnv,
      state: "needs-env",
      detail: `${missingEnv.join(", ")} ${missingEnv.length === 1 ? "is" : "are"} referenced but not set`,
      remedy: `export ${missingEnv[0]}=... in your shell profile`
    };
  }

  if (server.entry.auth === "oauth") {
    return {
      ...base,
      state: "oauth",
      detail: "signs in with OAuth; Pi holds the session",
      remedy: `/mcp-auth ${server.name} inside Pi if it is not signed in`
    };
  }

  return { ...base, state: "ready", detail: "ready" };
}

/**
 * One line for the session start, or nothing when every server is usable.
 *
 * Only definite problems are named. A server waiting on OAuth is left out
 * because this process cannot tell a signed-in one from a signed-out one, and a
 * notice that appears every session regardless of state stops being read.
 *
 * @param {ServerReadiness[]} readiness
 * @returns {string|undefined}
 */
export function readinessNotice(readiness) {
  const blocked = readiness.filter((item) => BLOCKING_STATES.has(item.state));
  if (blocked.length === 0) return undefined;
  const waiting = blocked.filter((item) => item.state === "pending-approval" || item.state === "approval-changed");
  const parts = blocked.slice(0, 4).map((item) => `${item.name} (${item.detail})`);
  const overflow = blocked.length > parts.length ? `, and ${blocked.length - parts.length} more` : "";
  const lead = waiting.length > 0
    ? "MCP servers need a decision or setup"
    : "MCP servers are configured but cannot connect";
  // This line is only ever printed at session start, so it names the command
  // that answers it from there rather than sending the reader to a shell.
  return `${lead}: ${parts.join("; ")}${overflow}. Run \`/piagent-mcp doctor\` for what each one needs.`;
}

import fs from "node:fs";
import path from "node:path";

// Four files can define MCP servers, and which one a change belongs in is the
// first thing anyone gets wrong. The scope names are the vocabulary the CLI
// exposes, so they are resolved in exactly one place.
//
// `global` and `pi-project` are the two that matter for safety. `global` is
// outside every repository, so nothing a repository contains can reach it.
// `project` is the file a repository can carry, which is why servers found there
// are the ones the approval gate covers.

const BASELINE_SETTINGS = {
  toolPrefix: "server",
  directTools: false,
  idleTimeout: 10,
  outputGuard: true
};

export const SCOPES = ["global", "pi-global", "project", "pi-project"];

/** Scopes whose file a repository can carry, and which therefore need approval. */
export const REPOSITORY_SCOPES = new Set(["project", "pi-project"]);

/**
 * @param {string} scope
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {string}
 */
export function configPathForScope(scope, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? "";
  const projectPath = options.projectPath ?? process.cwd();
  switch (scope) {
    case "global":
      return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "mcp", "mcp.json");
    case "pi-global":
      return path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "mcp.json");
    case "project":
      return path.join(projectPath, ".mcp.json");
    case "pi-project":
      return path.join(projectPath, ".pi", "mcp.json");
    default:
      throw new McpConfigError(`unsupported scope: ${scope}`);
  }
}

export class McpConfigError extends Error {}

/**
 * Read a config file into the shape the rest of this module assumes. A file that
 * is missing reads as empty; a file that is present but malformed throws, because
 * silently treating it as empty would let a write drop servers somebody
 * configured by hand.
 * @param {string} file
 * @returns {{settings: Record<string, unknown>, mcpServers: Record<string, unknown>, rest: Record<string, unknown>}}
 */
export function readMcpConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { settings: {}, mcpServers: {}, rest: {} };
    }
    throw new McpConfigError(`cannot read MCP config: ${file}`);
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new McpConfigError(`cannot parse MCP config: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(document)) return { settings: {}, mcpServers: {}, rest: {} };
  const { settings, mcpServers, ...rest } = document;
  return {
    settings: isRecord(settings) ? settings : {},
    mcpServers: isRecord(mcpServers) ? mcpServers : {},
    rest
  };
}

/**
 * @param {string} file
 * @param {{settings: Record<string, unknown>, mcpServers: Record<string, unknown>, rest?: Record<string, unknown>}} config
 * @returns {void}
 */
export function writeMcpConfig(file, config) {
  const document = {
    ...(config.rest ?? {}),
    settings: { ...BASELINE_SETTINGS, ...config.settings },
    mcpServers: config.mcpServers
  };
  const output = `${JSON.stringify(document, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside the target and renamed, so a crash mid-write leaves the old
  // config rather than a truncated one that would read as "no servers".
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, output);
  fs.renameSync(temporary, file);
}

/**
 * Every server visible from a project, with the scope each came from. Later
 * scopes do not merge into earlier ones: a name defined twice is reported twice,
 * because which definition a client picks is the client's rule, not ours, and
 * hiding the duplicate is how a project-scoped override goes unnoticed.
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string, scopes?: string[]}} [options]
 * @returns {{name: string, scope: string, file: string, entry: Record<string, unknown>}[]}
 */
export function collectServers(options = {}) {
  const found = [];
  for (const scope of options.scopes ?? SCOPES) {
    const file = configPathForScope(scope, options);
    let config;
    try {
      config = readMcpConfig(file);
    } catch {
      // A layer this process cannot parse is reported as empty rather than
      // failing the whole listing; `piagent-mcp get` on that scope still throws.
      continue;
    }
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (isRecord(entry)) found.push({ name, scope, file, entry });
    }
  }
  return found;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

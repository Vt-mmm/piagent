import fs from "node:fs";
import path from "node:path";
import { REPOSITORY_RELATIVE_KINDS, canEnumerateImportKind, declaredImports, importedServers } from "./mcp-import-kinds.js";
import { erasesToolOrigin } from "./mcp-tool-naming.js";

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
      return { settings: {}, mcpServers: {}, imports: [], rest: {} };
    }
    throw new McpConfigError(`cannot read MCP config: ${file}`);
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new McpConfigError(`cannot parse MCP config: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(document)) return { settings: {}, mcpServers: {}, imports: [], rest: {} };
  const { settings, mcpServers, imports, ...rest } = document;
  return {
    settings: isRecord(settings) ? settings : {},
    mcpServers: isRecord(mcpServers) ? mcpServers : {},
    // Pulled out of `rest` deliberately. While it rode along in the spread it
    // was preserved by every write and read by nothing here, which is the exact
    // shape of a key that decides what loads without anything checking it.
    imports: declaredImports(imports),
    rest
  };
}

/**
 * @param {string} file
 * @param {{settings: Record<string, unknown>, mcpServers: Record<string, unknown>, rest?: Record<string, unknown>}} config
 * @returns {void}
 */
export function writeMcpConfig(file, config) {
  const declared = declaredImports(config.imports);
  const document = {
    ...(config.rest ?? {}),
    // Written back rather than dropped. This key is refused at the gate when a
    // repository carries it, and deleting a line out of somebody's own config
    // as a side effect of an unrelated `add` is not a fix.
    ...(declared.length > 0 ? { imports: declared } : {}),
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
 * `origin` is the scope name for a server the layer declares directly, and
 * `import:<kind>` for one reached through an `imports` key, so a caller can say
 * where a server came from rather than only which layer named it.
 *
 * `requiresApproval` says whether this server is one a repository put into the
 * session. Scope alone cannot answer that: a `global` config importing a
 * repository-relative kind carries a scope of `global` and a definition that
 * came out of the clone. Deciding it here keeps the gate and the listing on one
 * rule — the listing reporting `ready` for a server the gate is blocking is
 * worse than either answer alone, because it sends the operator looking
 * anywhere but at the approval.
 *
 * @returns {{name: string, scope: string, file: string, entry: Record<string, unknown>, origin: string, requiresApproval: boolean}[]}
 */
export function collectServers(options = {}) {
  const found = [];
  const seen = new Set();
  const push = (server) => {
    const key = `${server.name}\u0000${server.file}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(server);
  };

  for (const scope of options.scopes ?? SCOPES) {
    const file = configPathForScope(scope, options);
    let config;
    try {
      config = readMcpConfig(file);
    } catch {
      // A layer this process cannot parse is reported as empty rather than
      // failing the whole listing; `piagent-mcp get` on that scope still throws
      // and `piagent-mcp doctor` reports it as unreadable.
      continue;
    }
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (isRecord(entry)) push({ name, scope, file, entry, origin: scope, requiresApproval: REPOSITORY_SCOPES.has(scope) });
    }
  }

  // Imports of a repository-relative kind are scanned across every layer, not
  // just the ones the caller asked for. Which file declares the import decides
  // nothing: what makes the servers repository-scoped is that the file they are
  // read from travels with the clone. A `global` config importing `vscode`
  // therefore puts a repository's servers into every session on this machine,
  // and that has to reach the gate the same way `.mcp.json` does.
  //
  // The other direction matters too: whichever kind a repository-scoped config
  // names, the repository is choosing which servers a session runs. Those are
  // the operator's own definitions, so the question is not whether to trust the
  // command but whether this project was meant to start it — which is the same
  // question the gate already asks.
  if (options.includeRepositoryImports !== false) {
    for (const scope of SCOPES) {
      let config;
      try {
        config = readMcpConfig(configPathForScope(scope, options));
      } catch {
        continue;
      }
      const repositoryScoped = REPOSITORY_SCOPES.has(scope);
      for (const kind of config.imports) {
        if (!repositoryScoped && !REPOSITORY_RELATIVE_KINDS.has(kind)) continue;
        for (const server of importedServers(kind, options)) {
          // Both branches that reach here are the repository choosing a
          // server: it either declared the import itself, or the file being
          // read travels with the clone.
          push({ name: server.name, scope, file: server.file, entry: server.entry, origin: `import:${kind}`, requiresApproval: true });
        }
      }
    }
  }

  return found;
}

/**
 * Layers that exist but cannot be read. `collectServers` skips these so one bad
 * file does not take out the whole listing, which is the right call for a
 * listing and the wrong one for a diagnosis: a config nothing can parse
 * contributes no servers and is indistinguishable from a config that defines
 * none. Somewhere has to say which of the two it was.
 *
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string, scopes?: string[]}} [options]
 * @returns {{scope: string, file: string, detail: string}[]}
 */
export function unreadableLayers(options = {}) {
  const problems = [];
  for (const scope of options.scopes ?? SCOPES) {
    const file = configPathForScope(scope, options);
    try {
      readMcpConfig(file);
    } catch (error) {
      problems.push({ scope, file, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return problems;
}

/**
 * Repository-scoped layers that declare `imports`. A repository reaching into
 * another tool's config on this machine is refused on the declaration rather
 * than on its contents: one of the six kinds is TOML that nothing here parses,
 * so an enumeration would be incomplete, and a repository has no business
 * deciding which of the operator's personal servers a session loads regardless.
 *
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {{scope: string, file: string, kinds: string[]}[]}
 */
export function repositoryImportDeclarations(options = {}) {
  const declarations = [];
  for (const scope of REPOSITORY_SCOPES) {
    const file = configPathForScope(scope, options);
    let config;
    try {
      config = readMcpConfig(file);
    } catch {
      continue;
    }
    const kinds = declaredImports(config.imports);
    if (kinds.length > 0) declarations.push({ scope, file, kinds });
  }
  return declarations;
}

/**
 * Repository-carried settings that leave the gate with nothing to check, so the
 * only sound answer is to refuse every tool call.
 *
 * Kept here rather than in the guard because two surfaces have to agree on it.
 * The guard enforces it; `doctor` and `list` are where an operator goes to find
 * out why a session stopped working. When only the guard knew, `doctor` reported
 * "No MCP servers configured" and exited 0 while nothing could run — an answer
 * that sends the operator looking anywhere but at the config that caused it.
 *
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {{scope: string, file: string, detail: string}[]}
 */
export function unverifiableRepositoryConfig(options = {}) {
  const problems = [];
  for (const scope of REPOSITORY_SCOPES) {
    const file = configPathForScope(scope, options);
    let config;
    try {
      config = readMcpConfig(file);
    } catch {
      // Unreadable is a different diagnosis with its own report, and nothing is
      // assumed about the contents of a file nobody could read.
      continue;
    }
    if (erasesToolOrigin(config.settings)) {
      problems.push({
        scope,
        file,
        detail: `${file} turns on directTools with toolPrefix "none", which strips the server name off ` +
          "every tool and leaves nothing to check an approval against. Remove that setting, then approve servers individually."
      });
    }
    for (const kind of config.imports) {
      if (canEnumerateImportKind(kind)) continue;
      problems.push({
        scope,
        file,
        detail: `${file} imports servers from ${kind} config, which this platform cannot enumerate, ` +
          "so which servers reach this session is unknown. Remove the import and declare the servers you want directly."
      });
    }
  }
  return problems;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

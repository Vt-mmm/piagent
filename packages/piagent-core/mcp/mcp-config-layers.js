import fs from "node:fs";
import path from "node:path";
import {
  REPOSITORY_RELATIVE_KINDS,
  canEnumerateImportKind,
  declaredImports,
  importKindFiles,
  importedServers,
  unreadableImportTargets
} from "./mcp-import-kinds.js";
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
      return { settings: {}, mcpServers: {}, imports: [], rawImports: [], rest: {} };
    }
    throw new McpConfigError(`cannot read MCP config: ${file}`);
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new McpConfigError(`cannot parse MCP config: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A JSON array, string or number parses fine and is not a config. Reading it
  // as empty meant a later write replaced somebody's file with `{}` plus whatever
  // the write added, so the document that could not be understood was destroyed
  // rather than reported.
  if (!isRecord(document)) {
    throw new McpConfigError(`MCP config is not a JSON object: ${file}`);
  }
  const { settings, mcpServers, imports, ...rest } = document;
  return {
    settings: isRecord(settings) ? settings : {},
    mcpServers: isRecord(mcpServers) ? mcpServers : {},
    // Pulled out of `rest` deliberately. While it rode along in the spread it
    // was preserved by every write and read by nothing here, which is the exact
    // shape of a key that decides what loads without anything checking it.
    imports: declaredImports(imports),
    // The list exactly as written, so a write can put back kinds this version
    // does not recognise. Nothing reads this to decide behaviour.
    rawImports: Array.isArray(imports) ? imports.filter((kind) => typeof kind === "string") : [],
    rest
  };
}

/**
 * @param {string} file
 * @param {{settings: Record<string, unknown>, mcpServers: Record<string, unknown>, rest?: Record<string, unknown>}} config
 * @returns {void}
 */
export function writeMcpConfig(file, config) {
  // `declaredImports` keeps only the kinds this version knows. Writing that back
  // deleted any kind a newer adapter understands and this one does not, turning
  // an unrelated `add` into a silent downgrade of somebody's config. The raw list
  // is preserved and the known kinds are what the rest of this module reads.
  const raw = Array.isArray(config.rawImports) ? config.rawImports : declaredImports(config.imports);
  const document = {
    ...(config.rest ?? {}),
    // Written back rather than dropped. This key is refused at the gate when a
    // repository carries it, and deleting a line out of somebody's own config
    // as a side effect of an unrelated `add` is not a fix.
    ...(raw.length > 0 ? { imports: raw } : {}),
    settings: { ...BASELINE_SETTINGS, ...config.settings },
    mcpServers: config.mcpServers
  };
  const output = `${JSON.stringify(document, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A symlink here points the write somewhere the caller did not name. Renaming
  // over it replaces the link itself, so the file the operator has been editing
  // stops being the file this reads -- and following it would write through a
  // link a repository could have planted.
  let existing;
  try {
    existing = fs.lstatSync(file);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) {
    throw new McpConfigError(`refusing to write through a symlink: ${file}`);
  }
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
 * The definition a same-named server actually runs under.
 *
 * The adapter merges server maps key by key in scope order, so a later layer
 * that names an existing server overrides only the keys it sets. A repository
 * declaring `{"args": ["--evil"]}` therefore inherits `command` from the
 * operator's own global config, and reading that layer alone shows an argument
 * list with no command attached — which is not what will run, and not what an
 * operator should be asked to consent to.
 *
 * The digest deliberately stays over the repository's own fragment: that is the
 * part the repository controls, and hashing the merge would return a server to
 * pending every time the operator edited their own global config.
 *
 * @param {{projectPath?: string, name: string, entry?: Record<string, unknown>, env?: Record<string, string|undefined>, home?: string}} options
 * @returns {Record<string, unknown>}
 */
export function mergedServerEntry(options) {
  let merged = {};
  let seen = false;
  for (const scope of SCOPES) {
    let config;
    try {
      config = readMcpConfig(configPathForScope(scope, options));
    } catch {
      continue;
    }
    const entry = config.mcpServers[options.name];
    if (!isRecord(entry)) continue;
    merged = { ...merged, ...entry };
    seen = true;
  }
  // A server reached through `imports` is in no layer's `mcpServers`, so the
  // entry the caller already has is the whole definition.
  return seen ? merged : { ...(options.entry ?? {}) };
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
    let config;
    try {
      config = readMcpConfig(file);
    } catch (error) {
      problems.push({ scope, file, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    // A layer can also be unreadable one step removed: it parses, declares an
    // import, and the file that import names is the one nothing can read. That
    // layer contributes no servers for a reason the layer itself does not show,
    // so the diagnosis has to follow the declaration to where it points.
    for (const kind of config.imports) {
      for (const target of unreadableImportTargets(kind, options)) {
        problems.push({
          scope,
          file: target.file,
          detail: `${file} imports ${kind}, and that config is present but unreadable: ${target.detail}`
        });
      }
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
 * The `settings` block a session actually runs under.
 *
 * The adapter merges `settings` across all four layers in scope order, later
 * layers winning key by key — it is one session-wide block, not a per-server
 * one. Reading a single layer therefore answers a different question than the
 * one that matters: `directTools` set in one file and `toolPrefix: "none"` set
 * in another produce a session with neither property, and a check that looked at
 * either file alone saw nothing wrong with it.
 *
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {{settings: Record<string, unknown>, contributors: Record<string, string>}}
 */
export function mergedSettings(options = {}) {
  const settings = { ...BASELINE_SETTINGS };
  /** @type {Record<string, string>} */
  const contributors = {};
  for (const scope of SCOPES) {
    let config;
    try {
      config = readMcpConfig(configPathForScope(scope, options));
    } catch {
      continue;
    }
    for (const [key, item] of Object.entries(config.settings)) {
      settings[key] = item;
      contributors[key] = scope;
    }
  }
  return { settings, contributors };
}

/**
 * Every file any decision in this module can depend on, including the ones that
 * matter by being absent.
 *
 * The guard caches its gate and recomputes when a signature over these changes.
 * That signature used to be built by hand from the repository layers, and when
 * the scan below grew to read merged settings from all four scopes and to stat
 * import targets outside the repository, the signature did not grow with it —
 * so adding `directTools` to a personal global config left an already-loaded
 * guard permitting calls that `piagent-mcp doctor` was reporting as blocked.
 *
 * Derived from the same traversal the readers use, so a reader that starts
 * consulting a new file is watched for that file without anything else being
 * updated to match. An absent file is listed too: `imports: ["codex"]` becomes
 * a block the moment `~/.codex/config.toml` appears.
 *
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {string[]}
 */
export function mcpDecisionInputs(options = {}) {
  const inputs = [];
  for (const scope of SCOPES) {
    const file = configPathForScope(scope, options);
    inputs.push(file);
    let config;
    try {
      config = readMcpConfig(file);
    } catch {
      // Unreadable still counts: the file is watched, and becoming readable is
      // a change the gate has to see.
      continue;
    }
    // Every location the kind can be read from, whether or not it has one now.
    // A kind that resolves to nothing today is exactly the kind whose file
    // appearing tomorrow changes the answer.
    for (const kind of config.imports) inputs.push(...importKindFiles(kind, options));
  }
  return [...new Set(inputs)];
}

/**
 * Config that leaves the gate with nothing to check, so the only sound answer is
 * to refuse every tool call.
 *
 * Kept here rather than in the guard because three surfaces have to agree on it.
 * The guard enforces it; `doctor` and `list` are where an operator goes to find
 * out why a session stopped working. When only the guard knew, `doctor` reported
 * "No MCP servers configured" and exited 0 while nothing could run — an answer
 * that sends the operator looking anywhere but at the config that caused it.
 *
 * @param {{projectPath?: string, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {{scope: string, file: string, detail: string}[]}
 */
export function unverifiableMcpConfig(options = {}) {
  const problems = [];
  const merged = mergedSettings(options);
  if (erasesToolOrigin(merged.settings)) {
    // Which files to edit, not just that something is wrong: the two keys can be
    // set in different layers, and naming only one of them sends the operator to
    // a file where the other half is not.
    const scopes = [...new Set(["directTools", "toolPrefix"].map((key) => merged.contributors[key]).filter(Boolean))];
    const files = scopes.map((scope) => configPathForScope(scope, options));
    problems.push({
      scope: scopes.join(" + ") || "global",
      file: files[0] ?? configPathForScope("global", options),
      detail: `${files.join(" and ")} together turn on directTools with toolPrefix "none", which strips the ` +
        "server name off every tool and leaves nothing to check an approval against. " +
        "Remove that setting, then approve servers individually."
    });
  }

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
    for (const kind of config.imports) {
      if (canEnumerateImportKind(kind)) continue;
      // An import of a kind nothing here can parse is only a hole when the file
      // it names exists. Refusing on the declaration alone blocked every session
      // whose repository listed a tool the operator does not even have installed,
      // which is a config to clean up rather than a session to stop.
      const present = importKindFiles(kind, options).filter((candidate) => fs.existsSync(candidate));
      if (present.length === 0) continue;
      problems.push({
        scope,
        file,
        detail: `${file} imports servers from ${kind} config, which this platform cannot enumerate ` +
          `(${present.join(", ")}), so which servers reach this session is unknown. ` +
          "Remove the import and declare the servers you want directly."
      });
    }
  }
  return problems;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

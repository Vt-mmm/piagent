#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  SCOPES,
  REPOSITORY_SCOPES,
  McpConfigError,
  collectServers,
  configPathForScope,
  isRecord,
  readMcpConfig,
  repositoryImportDeclarations,
  unverifiableRepositoryConfig,
  unreadableLayers,
  writeMcpConfig
} from "../packages/piagent-core/mcp/mcp-config-layers.js";
import {
  CATALOG_PRESETS,
  CATALOG_PREREQUISITES,
  CATALOG_SERVERS,
  isCatalogPreset,
  resolvePreset
} from "../packages/piagent-core/mcp/mcp-server-catalog.js";
import {
  McpEntryError,
  assertServerName,
  buildServerEntry,
  maskServerEntry
} from "../packages/piagent-core/mcp/mcp-server-entry.js";
import {
  approvalState,
  approvalStorePath,
  clearApproval,
  recordApproval
} from "../packages/piagent-core/mcp/mcp-approval-store.js";
import { evaluateServerReadiness } from "../packages/piagent-core/mcp/mcp-auth-readiness.js";
import {
  McpViewError,
  blockedRows,
  collectServerRows,
  describeServer,
  formatDoctorReport,
  formatServerDetail,
  formatServerTable,
  usesDocker
} from "../packages/piagent-core/mcp/mcp-session-view.js";

const SUBCOMMANDS = new Set([
  "add", "remove", "get", "list", "enable", "disable", "approve", "reject", "reset", "doctor", "preset"
]);

function usage() {
  process.stdout.write(`Usage:
  piagent-mcp <command> [options]
  piagent-mcp --preset <preset> [options]          seed a pinned server group

Commands:
  add <name> --url <url>            Add a remote MCP server
  add <name> -- <command> [args]    Add a local MCP server
  remove <name>                     Remove a server from a scope
  get <name>                        Show one server, with credentials masked
  list                              Show every server visible here, with state
  enable <name> / disable <name>    Turn a server off without losing its config
  approve <name> / reject <name>    Decide on a server this repository defines
  reset                             Forget every decision for this project
  doctor                            Report what each server still needs

Options:
  --scope <global|pi-global|project|pi-project>
                                    Config layer (default: global; project for approve)
  --project <path>                  Project path for project scopes (default: cwd)
  --config <path>                   Explicit config path; overrides --scope/--project
  --env KEY=value                   Environment entry for a local server (repeatable)
  --header "Name: value"            Header for a remote server (repeatable)
  --bearer-token-env-var <VAR>      Variable holding the bearer token for a remote server
  --oauth-client-id <id>            OAuth client identifier
  --oauth-scopes <a,b>              Pin the OAuth scopes requested
  --direct-tools                    Expose this server's tools directly instead of via the proxy
  --preset <name>                   Seed a pinned group: ${Object.keys(CATALOG_PRESETS).join(", ")}
  --replace                         Overwrite existing definitions the preset covers
  --dry-run                         Print what would be written
  --list                            Print available presets/servers
  --json                            Machine-readable output
  -h, --help

Credentials are never written into MCP config. Pass a variable reference such as
--env 'GITHUB_PERSONAL_ACCESS_TOKEN=\${GITHUB_PERSONAL_ACCESS_TOKEN}' and export the
value in your shell. OAuth sign-in belongs to Pi: run /mcp-auth <name> inside a session.

Servers defined by a repository (project and pi-project scopes) are not usable
until approved here. The decision is stored in your home directory, so a clone
cannot approve itself, and it is tied to the definition that was approved.

Examples:
  piagent-mcp --preset core --scope global --replace
  piagent-mcp add sentry --url https://mcp.sentry.dev/mcp --scope global
  piagent-mcp add internal --scope project -- npx -y @acme/internal-mcp
  piagent-mcp list
  piagent-mcp approve internal
  piagent-mcp doctor
`);
}

class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {{command: string, positionals: string[], flags: Map<string, string|true>, repeated: Map<string, string[]>, passthrough: string[]}}
 */
function parseArgs(argv) {
  const repeatable = new Set(["--env", "--header"]);
  const valued = new Set([
    "--scope", "--project", "--config", "--preset", "--url", "--bearer-token-env-var",
    "--oauth-client-id", "--oauth-scopes", "--env", "--header"
  ]);
  const boolean = new Set(["--replace", "--dry-run", "--list", "--json", "--direct-tools", "--validate-preset", "--force"]);

  const flags = new Map();
  const repeated = new Map();
  const positionals = [];
  /** @type {string[]} */
  let passthrough = [];

  let command = "";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv[0];
    index = 1;
    if (!SUBCOMMANDS.has(command)) throw new UsageError(`unknown command: ${command}`);
  }

  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (token === "-h" || token === "--help") {
      flags.set("--help", true);
      continue;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (boolean.has(token)) {
      flags.set(token, true);
      continue;
    }
    if (!valued.has(token)) throw new UsageError(`unknown option: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value === "--") throw new UsageError(`missing value for ${token}`);
    index += 1;
    if (repeatable.has(token)) {
      repeated.set(token, [...(repeated.get(token) ?? []), value]);
      continue;
    }
    flags.set(token, value);
  }

  return { command, positionals, flags, repeated, passthrough };
}

/** @param {Map<string, string|true>} flags @param {string} name @returns {string|undefined} */
function value(flags, name) {
  const raw = flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/**
 * @param {Map<string, string|true>} flags
 * @param {string} fallback
 * @returns {string}
 */
function requireScope(flags, fallback) {
  const scope = value(flags, "--scope") ?? fallback;
  if (!SCOPES.includes(scope)) throw new UsageError(`unsupported scope: ${scope}. Use one of ${SCOPES.join(", ")}.`);
  return scope;
}

/** @param {Map<string, string|true>} flags @returns {string} */
function projectPath(flags) {
  return path.resolve(value(flags, "--project") ?? process.cwd());
}

/** @param {Map<string, string|true>} flags @param {string} scope @returns {string} */
function targetConfig(flags, scope) {
  const explicit = value(flags, "--config");
  if (explicit) {
    if (path.basename(explicit) !== "mcp.json" && path.basename(explicit) !== ".mcp.json") {
      throw new UsageError("--config must point at an mcp.json or .mcp.json file");
    }
    return path.resolve(explicit);
  }
  return configPathForScope(scope, { projectPath: projectPath(flags) });
}

/** @param {string} name @param {Map<string, string|true>} flags @returns {{scope: string, file: string, entry: Record<string, unknown>}} */
function locateServer(name, flags) {
  const explicitScope = value(flags, "--scope");
  const servers = collectServers({ projectPath: projectPath(flags) })
    .filter((server) => server.name === name && (!explicitScope || server.scope === explicitScope));
  if (servers.length === 0) {
    throw new UsageError(
      explicitScope
        ? `no server named ${name} in ${explicitScope} scope`
        : `no server named ${name}. Run \`piagent-mcp list\` to see what is configured.`
    );
  }
  if (servers.length > 1) {
    throw new UsageError(
      `${name} is defined in more than one scope (${servers.map((server) => server.scope).join(", ")}). ` +
      "Pass --scope to say which one."
    );
  }
  return servers[0];
}

// --- commands ---------------------------------------------------------------

/** @param {ReturnType<typeof parseArgs>} args */
function commandAdd(args) {
  const name = args.positionals[0];
  if (!name) throw new UsageError("add needs a server name");
  const scope = requireScope(args.flags, "global");
  const entry = buildServerEntry({
    name,
    url: value(args.flags, "--url") ?? undefined,
    command: args.passthrough.length > 0 ? args.passthrough : undefined,
    env: args.repeated.get("--env") ?? [],
    header: args.repeated.get("--header") ?? [],
    bearerTokenEnvVar: value(args.flags, "--bearer-token-env-var"),
    oauthClientId: value(args.flags, "--oauth-client-id"),
    oauthScopes: value(args.flags, "--oauth-scopes"),
    directTools: args.flags.get("--direct-tools") === true
  });

  const file = targetConfig(args.flags, scope);
  const config = readMcpConfig(file);
  const existed = Object.hasOwn(config.mcpServers, name);
  if (existed && args.flags.get("--replace") !== true) {
    throw new UsageError(`${name} already exists in ${scope} scope. Pass --replace to overwrite it.`);
  }
  config.mcpServers[name] = entry;

  if (args.flags.get("--dry-run") === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, name, scope, file, entry: maskServerEntry(entry) }, null, 2)}\n`);
    return 0;
  }
  writeMcpConfig(file, config);

  // A previous decision described a different server. Dropping it here means the
  // operator is asked again rather than inheriting approval for what was replaced.
  if (existed && REPOSITORY_SCOPES.has(scope)) clearApproval({ projectPath: projectPath(args.flags), name });

  const transport = typeof entry.url === "string" ? `URL: ${entry.url}` : `command: ${[entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(" ")}`;
  process.stdout.write(`${existed ? "Replaced" : "Added"} ${typeof entry.url === "string" ? "remote" : "local"} MCP server ${name} with ${transport} in ${scope} scope\n`);
  process.stdout.write(`File modified: ${file}\n`);
  if (REPOSITORY_SCOPES.has(scope)) {
    process.stdout.write(`This scope is part of the repository, so the server is not usable until approved: piagent-mcp approve ${name}\n`);
  }
  reportMissingEnv(entry);
  return 0;
}

/** @param {Record<string, unknown>} entry */
function reportMissingEnv(entry) {
  const readiness = evaluateServerReadiness({ name: "", scope: "global", entry }, { projectPath: process.cwd() });
  if (readiness.state === "needs-env") {
    process.stderr.write(`\nStill needed before it can connect: ${readiness.detail}.\n`);
  }
  if (readiness.state === "needs-command") {
    process.stderr.write(`\nStill needed before it can connect: ${readiness.detail}.\n`);
  }
}

/** @param {ReturnType<typeof parseArgs>} args */
function commandRemove(args) {
  const name = args.positionals[0];
  if (!name) throw new UsageError("remove needs a server name");
  const located = locateServer(name, args.flags);
  const config = readMcpConfig(located.file);
  delete config.mcpServers[name];
  writeMcpConfig(located.file, config);
  clearApproval({ projectPath: projectPath(args.flags), name });
  process.stdout.write(`Removed MCP server ${name} from ${located.scope} scope\n`);
  process.stdout.write(`File modified: ${located.file}\n`);
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} args */
function commandGet(args) {
  const name = args.positionals[0];
  if (!name) throw new UsageError("get needs a server name");
  const detail = describeServer({
    projectPath: projectPath(args.flags),
    name,
    scope: value(args.flags, "--scope"),
    listHint: "piagent-mcp list"
  });

  if (args.flags.get("--json") === true) {
    process.stdout.write(`${JSON.stringify({
      name,
      scope: detail.scope,
      file: detail.file,
      state: detail.readiness.state,
      detail: detail.readiness.detail,
      entry: detail.masked
    }, null, 2)}\n`);
    return 0;
  }

  for (const line of formatServerDetail(detail)) process.stdout.write(`${line}\n`);
  process.stdout.write(`  remove: piagent-mcp remove ${name} --scope ${detail.scope}\n`);
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} args */
function commandList(args) {
  const scopeFilter = value(args.flags, "--scope");
  const project = projectPath(args.flags);
  const rows = collectServerRows({ projectPath: project, scopes: scopeFilter ? [scopeFilter] : undefined });

  if (args.flags.get("--json") === true) {
    process.stdout.write(`${JSON.stringify({
      project,
      servers: rows.map((row) => ({
        name: row.name,
        scope: row.scope,
        file: row.file,
        state: row.readiness.state,
        detail: row.readiness.detail,
        entry: maskServerEntry(row.entry)
      }))
    }, null, 2)}\n`);
    return 0;
  }

  // Listing nothing is the correct answer only when nothing is reaching the
  // session. A config the gate cannot verify reaches it with an unknown set of
  // servers, and telling somebody to seed a baseline in that state sends them
  // to the wrong file entirely.
  const unverifiable = unverifiableRepositoryConfig({ projectPath: project });
  for (const problem of unverifiable) process.stdout.write(`BLOCKED every tool call: ${problem.detail}\n`);

  if (rows.length === 0) {
    if (unverifiable.length > 0) return 1;
    process.stdout.write("No MCP servers configured.\n");
    process.stdout.write("Seed the pinned baseline with: piagent-mcp --preset core --scope global\n");
    return 0;
  }

  process.stdout.write(`${formatServerTable(rows)}\n`);
  const blocked = blockedRows(rows);
  if (blocked.length > 0) process.stdout.write(`\n${blocked.length} server(s) not usable yet. Run \`piagent-mcp doctor\`.\n`);
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} args @param {boolean} enabled */
function commandToggle(args, enabled) {
  const name = args.positionals[0];
  if (!name) throw new UsageError(`${enabled ? "enable" : "disable"} needs a server name`);
  const located = locateServer(name, args.flags);
  const config = readMcpConfig(located.file);
  const entry = { ...(isRecord(config.mcpServers[name]) ? config.mcpServers[name] : {}) };
  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  config.mcpServers[name] = entry;
  writeMcpConfig(located.file, config);
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} MCP server ${name} in ${located.scope} scope\n`);
  process.stdout.write(`File modified: ${located.file}\n`);
  if (!enabled) process.stdout.write("The definition is kept, so `piagent-mcp enable` restores it.\n");
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} args @param {"approved"|"rejected"} decision */
function commandDecide(args, decision) {
  const name = args.positionals[0];
  if (!name) throw new UsageError(`${decision === "approved" ? "approve" : "reject"} needs a server name`);
  assertServerName(name);
  const project = projectPath(args.flags);
  const servers = collectServers({ projectPath: project, scopes: [...REPOSITORY_SCOPES] })
    .filter((server) => server.name === name);
  if (servers.length === 0) {
    throw new UsageError(
      `${name} is not defined by this repository. Approval only applies to servers in ${[...REPOSITORY_SCOPES].join(" or ")} scope.`
    );
  }
  if (servers.length > 1) throw new UsageError(`${name} is defined in ${servers.map((server) => server.scope).join(" and ")}; remove one.`);

  const server = servers[0];
  const before = approvalState({ projectPath: project, name, entry: server.entry });
  if (decision === "approved" && before.state === "pending" && args.flags.get("--force") !== true) {
    // Approving without reading it is the failure this gate exists to prevent, so
    // the definition is put in front of the operator before the decision lands.
    process.stdout.write(`${JSON.stringify(maskServerEntry(server.entry), null, 2)}\n`);
  }
  // A decision that was not written is not a decision. Printing "Approved" while
  // the store rejected the write would leave the operator waiting for a gate that
  // is still blocking, with nothing on screen to explain why.
  if (!recordApproval({ projectPath: project, name, entry: server.entry, decision })) {
    throw new UsageError(`could not write ${approvalStorePath() ?? "the approval store"}; ${name} is still ${before.state}`);
  }
  const after = approvalState({ projectPath: project, name, entry: server.entry });
  process.stdout.write(`${decision === "approved" ? "Approved" : "Rejected"} MCP server ${name} (${server.scope}) for ${project}\n`);
  process.stdout.write(`Pinned to this definition: ${after.digest}\n`);
  process.stdout.write("Changing the server's command, URL or arguments returns it to pending.\n");
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} args */
function commandReset(args) {
  const project = projectPath(args.flags);
  const name = args.positionals[0];
  if (!clearApproval({ projectPath: project, name })) {
    throw new UsageError(`could not write ${approvalStorePath() ?? "the approval store"}; nothing was forgotten`);
  }
  process.stdout.write(name
    ? `Forgot the decision for ${name} in ${project}\n`
    : `Forgot every MCP approval decision for ${project}\n`);
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} args */
function commandDoctor(args) {
  const project = projectPath(args.flags);
  const rows = collectServerRows({ projectPath: project });
  // Resolved before the no-servers shortcut below. A layer nobody can parse
  // produces no rows, so reporting "no servers configured" and stopping would
  // answer the question exactly backwards.
  const broken = unreadableLayers({ projectPath: project });
  const imports = repositoryImportDeclarations({ projectPath: project });
  // The guard refuses every tool call under these, and this is where somebody
  // comes to find out why. Reported first, because no per-server state below
  // means anything while one of them stands.
  const unverifiable = unverifiableRepositoryConfig({ projectPath: project });

  // The one check too slow for a session start: a daemon that is installed but
  // not running looks exactly like one that is running until something asks it.
  let dockerRunning;
  if (usesDocker(rows)) {
    const probe = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    dockerRunning = probe.status === 0;
  }

  if (args.flags.get("--json") === true) {
    process.stdout.write(`${JSON.stringify({
      project,
      dockerRunning,
      servers: rows.map((row) => ({ name: row.name, scope: row.scope, state: row.readiness.state, detail: row.readiness.detail, remedy: row.readiness.remedy })),
      unreadableLayers: broken,
      repositoryImports: imports.map((layer) => ({ scope: layer.scope, kinds: layer.kinds })),
      unverifiableConfig: unverifiable
    }, null, 2)}\n`);
    return blockedRows(rows).length > 0 || broken.length > 0 || unverifiable.length > 0 ? 1 : 0;
  }

  for (const layer of broken) process.stdout.write(`Unreadable ${layer.scope} config: ${layer.detail}\n`);
  for (const problem of unverifiable) process.stdout.write(`BLOCKED every tool call: ${problem.detail}\n`);

  if (rows.length === 0) {
    if (unverifiable.length > 0 || broken.length > 0) {
      process.stdout.write(`\n${unverifiable.length + broken.length} MCP config problem(s) need attention.\n`);
      return 1;
    }
    process.stdout.write("No MCP servers configured.\n");
    return 0;
  }

  const report = formatDoctorReport(rows, { dockerRunning, rerun: "piagent-mcp doctor" });
  for (const line of report.lines) process.stdout.write(`${line}\n`);

  // A layer nothing can parse hides whatever it defines and reads as empty, so
  // it is counted (and already printed above). An import is named but not
  // counted: the servers it brings in are in the report above with their own
  // state, and this line says where they came from, which reading the
  // repository's own config would not reveal.
  for (const layer of imports) {
    process.stdout.write(
      `${layer.file} imports servers from ${layer.kinds.join(", ")} config; ` +
      "they need approval here like any server the repository defines.\n"
    );
  }

  const problems = report.problems + broken.length + unverifiable.length;
  process.stdout.write(problems === 0
    ? "\nPASS: every configured MCP server can be reached.\n"
    : `\n${problems} MCP problem(s) need attention.\n`);
  return problems === 0 ? 0 : 1;
}

/** @param {ReturnType<typeof parseArgs>} args */
function commandPreset(args) {
  if (args.flags.get("--list") === true) {
    process.stdout.write(`${JSON.stringify({
      presets: CATALOG_PRESETS,
      servers: Object.fromEntries(Object.entries(CATALOG_SERVERS).map(([name, server]) => [
        name,
        { description: server.description, requires: CATALOG_PREREQUISITES[name] ?? [] }
      ]))
    }, null, 2)}\n`);
    return 0;
  }

  const presetName = value(args.flags, "--preset") ?? "core";
  if (!presetName) throw new UsageError("--preset cannot be empty");
  if (!isCatalogPreset(presetName)) {
    throw new UsageError(`unknown preset: ${presetName}. Available presets: ${Object.keys(CATALOG_PRESETS).join(", ")}`);
  }
  // Answering the name question and stopping, so a caller can ask before it
  // installs rather than discovering the typo after two packages have landed.
  if (args.flags.get("--validate-preset") === true) {
    process.stdout.write(`${presetName}\n`);
    return 0;
  }

  const scope = requireScope(args.flags, "global");
  const file = targetConfig(args.flags, scope);
  const config = readMcpConfig(file);
  const replace = args.flags.get("--replace") === true;
  const dryRun = args.flags.get("--dry-run") === true;

  const added = [];
  const kept = [];
  const replaced = [];
  for (const server of resolvePreset(presetName)) {
    if (Object.hasOwn(config.mcpServers, server.name)) {
      if (!replace) {
        kept.push(server.name);
        continue;
      }
      config.mcpServers[server.name] = server.config;
      replaced.push(server.name);
      continue;
    }
    config.mcpServers[server.name] = server.config;
    added.push(server.name);
  }

  const report = {
    configPath: file,
    preset: presetName,
    dryRun,
    replace,
    added,
    kept,
    replaced,
    serverCount: Object.keys(config.mcpServers).length
  };

  if (dryRun) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ settings: config.settings, mcpServers: config.mcpServers }, null, 2)}\n`);
    return 0;
  }

  writeMcpConfig(file, config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  // stdout stays machine-readable; the operator note goes to stderr.
  const lines = resolvePreset(presetName).flatMap((server) => server.requires.map((item) => `  ${server.name}: ${item}`));
  if (lines.length > 0) {
    process.stderr.write("\nServer definitions are written. Each still needs this before it can connect:\n");
    for (const line of lines) process.stderr.write(`${line}\n`);
    process.stderr.write("Servers connect lazily, so nothing above is checked until the first call.\n");
    process.stderr.write("Run `piagent-mcp doctor` to see which ones are ready on this machine.\n");
  }
  return 0;
}

// --- entry ------------------------------------------------------------------

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    usage();
    return 2;
  }

  if (args.flags.get("--help") === true || (!args.command && argv.length === 0)) {
    usage();
    return 0;
  }

  try {
    switch (args.command || "preset") {
      case "add": return commandAdd(args);
      case "remove": return commandRemove(args);
      case "get": return commandGet(args);
      case "list": return commandList(args);
      case "enable": return commandToggle(args, true);
      case "disable": return commandToggle(args, false);
      case "approve": return commandDecide(args, "approved");
      case "reject": return commandDecide(args, "rejected");
      case "reset": return commandReset(args);
      case "doctor": return commandDoctor(args);
      default: return commandPreset(args);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof McpEntryError || error instanceof McpConfigError || error instanceof McpViewError) {
      process.stderr.write(`FAIL: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main };

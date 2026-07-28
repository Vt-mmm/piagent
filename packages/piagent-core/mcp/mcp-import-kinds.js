import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Defined here rather than imported from the layer module, which imports this
// one: a cycle between the two would resolve, but only by accident of ordering.
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The adapter accepts an `imports` key that pulls server definitions out of
// other coding tools' config files. Those definitions land in a session without
// ever appearing in any of the four scopes this platform manages, so anything
// the approval gate is meant to cover has to be resolved here too.
//
// Each kind is described by two independent sets of locations. One is where the
// adapter looks today; the other is where the tool actually keeps its config.
// They disagree for three of the six kinds, and the gate has to hold under both:
// reading only the adapter's location misses a definition the moment the adapter
// is corrected, and reading only the real location misses what loads right now.
// The union is the safe direction to be wrong in — a server listed here that
// never loads costs one approval prompt, a server that loads without being
// listed costs the gate.
//
// Only `vscode` resolves inside the project. That one distinction is what makes
// it dangerous: a cloned repository carries the file it points at, so the
// servers it defines travel with the clone exactly like `.mcp.json` does.

/**
 * @typedef {{
 *   adapterPaths: (home: string, projectPath: string) => string[],
 *   actualPaths: (home: string, projectPath: string) => string[],
 *   serverKeys: string[],
 *   repositoryRelative: boolean,
 *   parsedAsJson: boolean
 * }} ImportKind
 */

/** @type {Record<string, ImportKind>} */
export const IMPORT_KINDS = {
  cursor: {
    adapterPaths: (home) => [path.join(home, ".cursor", "mcp.json")],
    actualPaths: (home) => [path.join(home, ".cursor", "mcp.json")],
    serverKeys: ["mcpServers", "mcp-servers"],
    repositoryRelative: false,
    parsedAsJson: true
  },
  "claude-code": {
    adapterPaths: (home) => [
      path.join(home, ".claude", "mcp.json"),
      path.join(home, ".claude.json"),
      path.join(home, ".claude", "claude_desktop_config.json")
    ],
    // Servers added at user scope sit at the top level of `~/.claude.json`;
    // servers added at local scope are nested per project and are not read by
    // either side, which is worth knowing but changes nothing here.
    actualPaths: (home) => [path.join(home, ".claude.json")],
    serverKeys: ["mcpServers"],
    repositoryRelative: false,
    parsedAsJson: true
  },
  "claude-desktop": {
    adapterPaths: (home) => [
      path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    ],
    actualPaths: (home) => [
      path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    ],
    serverKeys: ["mcpServers"],
    repositoryRelative: false,
    parsedAsJson: true
  },
  codex: {
    adapterPaths: (home) => [path.join(home, ".codex", "config.json")],
    // The real file is TOML under a `mcp_servers` table, and nothing here parses
    // TOML. Enumeration is therefore incomplete for this kind, which is what
    // `canEnumerateImportKind` reports: a repository that declares it is refused
    // on the declaration, because listing the servers that happen to be readable
    // says nothing about the ones that are not.
    actualPaths: (home) => [path.join(home, ".codex", "config.toml")],
    serverKeys: ["mcpServers", "mcp_servers"],
    repositoryRelative: false,
    parsedAsJson: false
  },
  windsurf: {
    adapterPaths: (home) => [path.join(home, ".windsurf", "mcp.json")],
    actualPaths: (home) => [path.join(home, ".codeium", "windsurf", "mcp_config.json")],
    serverKeys: ["mcpServers", "mcp-servers"],
    repositoryRelative: false,
    parsedAsJson: true
  },
  vscode: {
    adapterPaths: (_home, projectPath) => [path.join(projectPath, ".vscode", "mcp.json")],
    actualPaths: (_home, projectPath) => [path.join(projectPath, ".vscode", "mcp.json")],
    // The adapter reads `mcpServers`; the documented format uses `servers`. Both
    // are read so the gate covers a hand-written file either way.
    serverKeys: ["mcpServers", "mcp-servers", "servers"],
    repositoryRelative: true,
    parsedAsJson: true
  }
};

/** Import kinds whose file a repository carries, and which therefore need approval. */
export const REPOSITORY_RELATIVE_KINDS = new Set(
  Object.entries(IMPORT_KINDS)
    .filter(([, kind]) => kind.repositoryRelative)
    .map(([name]) => name)
);

/**
 * Whether every server this kind can contribute is visible to this platform.
 *
 * False means the answer from `importedServers` is a subset of unknown size, not
 * a list. A caller deciding what to block needs to know the difference: blocking
 * what came back would look like coverage while saying nothing about the rest.
 *
 * @param {string} kindName
 * @returns {boolean}
 */
export function canEnumerateImportKind(kindName) {
  return IMPORT_KINDS[kindName]?.parsedAsJson === true;
}

/**
 * The `imports` a config document declares, as a list of known kind names. An
 * unknown kind is dropped rather than rejected: the adapter ignores it too, and
 * a name this version does not recognise is not evidence of anything.
 * @param {unknown} value
 * @returns {string[]}
 */
export function declaredImports(value) {
  if (!Array.isArray(value)) return [];
  const kinds = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const kind = entry.trim();
    if (Object.hasOwn(IMPORT_KINDS, kind) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/**
 * Every file an import kind can be read from, adapter location and real location
 * alike. Exported because "does this kind actually resolve to anything on this
 * machine" is a question two callers ask, and each answering it from its own
 * copy of the path list is how the two answers drift apart.
 *
 * @param {string} kindName
 * @param {{projectPath?: string, home?: string}} [options]
 * @returns {string[]}
 */
export function importKindFiles(kindName, options = {}) {
  const kind = IMPORT_KINDS[kindName];
  if (!kind) return [];
  const home = options.home ?? os.homedir();
  const projectPath = options.projectPath ?? process.cwd();
  return [...new Set([...kind.adapterPaths(home, projectPath), ...kind.actualPaths(home, projectPath)])];
}

/**
 * Every server an import kind can put into a session, from either location and
 * under any of the keys that location might use. Files that are missing
 * contribute nothing; a file that exists but cannot be parsed is reported by
 * `unreadableImportTargets`, because "no servers" and "servers nobody could
 * read" are the two answers an operator most needs told apart.
 *
 * @param {string} kindName
 * @param {{projectPath?: string, home?: string}} [options]
 * @returns {{name: string, file: string, entry: Record<string, unknown>}[]}
 */
export function importedServers(kindName, options = {}) {
  const kind = IMPORT_KINDS[kindName];
  if (!kind) return [];
  const files = importKindFiles(kindName, options);

  const found = [];
  const seen = new Set();
  for (const file of files) {
    if (!kind.parsedAsJson && !file.endsWith(".json")) continue;
    let document;
    try {
      document = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(document)) continue;
    for (const key of kind.serverKeys) {
      const servers = document[key];
      if (!isRecord(servers)) continue;
      for (const [name, entry] of Object.entries(servers)) {
        // A name defined under two keys of the same file is one server; a name
        // defined in two files is reported once, keyed by the first file seen,
        // because approving it twice would ask the same question twice.
        const dedupe = `${name}\u0000${file}`;
        if (seen.has(dedupe) || !isRecord(entry)) continue;
        seen.add(dedupe);
        found.push({ name, file, entry });
      }
    }
  }
  return found;
}

/**
 * Import targets that exist but cannot be read into servers. `importedServers`
 * skips these, which is right for a listing and wrong for a diagnosis: the
 * caller cannot otherwise tell a tool that defines no servers from a tool whose
 * config nothing could parse, and only one of those two is a gap in the gate.
 *
 * @param {string} kindName
 * @param {{projectPath?: string, home?: string}} [options]
 * @returns {{kind: string, file: string, detail: string}[]}
 */
export function unreadableImportTargets(kindName, options = {}) {
  const kind = IMPORT_KINDS[kindName];
  if (!kind) return [];
  const problems = [];
  for (const file of importKindFiles(kindName, options)) {
    if (!kind.parsedAsJson && !file.endsWith(".json")) continue;
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // Absent is the normal case for five of six kinds and is not a problem.
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      problems.push({ kind: kindName, file, detail: `cannot read ${file}` });
      continue;
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      problems.push({ kind: kindName, file, detail: `cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!isRecord(document)) problems.push({ kind: kindName, file, detail: `${file} is not a JSON object` });
  }
  return problems;
}

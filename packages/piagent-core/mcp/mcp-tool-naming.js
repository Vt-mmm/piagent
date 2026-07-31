// How the adapter names the tools it exposes, mirrored here so a tool call can
// be traced back to the server behind it.
//
// The adapter builds a prefix from the server name and joins it to the tool name
// with an underscore. With the default `toolPrefix: "server"` a server called
// `github` exposes `github_create_issue`. There is no `mcp__` anywhere in that
// scheme, which is why a gate written against `mcp__<server>__<tool>` never
// fired: it was watching for a name shape nothing produces.
//
// `none` is the case with no answer. It strips the prefix entirely, so the tool
// arrives under whatever name the server gave it and carries no evidence of
// where it came from. Attribution is impossible by construction, which makes the
// combination of that setting with `directTools` in a repository-carried config
// something to refuse rather than something to parse.

/** Prefix modes the adapter accepts. */
export const TOOL_PREFIX_MODES = new Set(["server", "none", "short"]);

/**
 * The prefix a server's tools carry under one mode, matching the adapter's own
 * derivation. An empty string means the mode erases the origin.
 * @param {string} serverName
 * @param {string} mode
 * @returns {string}
 */
export function serverPrefix(serverName, mode) {
  if (mode === "none") return "";
  if (mode === "short") {
    const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    return short || "mcp";
  }
  return serverName.replace(/-/g, "_");
}

/**
 * Every prefix a server's tools could arrive under. All prefixing modes are
 * covered rather than just the configured one, because the setting lives in the
 * same file as the servers: a repository that wants a different mode can simply
 * declare it, so trusting the declared value to decide what to inspect would
 * hand the choice back to the thing being gated.
 * @param {string} serverName
 * @returns {string[]}
 */
export function serverPrefixes(serverName) {
  const prefixes = new Set();
  for (const mode of ["server", "short"]) {
    const prefix = serverPrefix(serverName, mode);
    if (prefix) prefixes.add(prefix);
  }
  return [...prefixes];
}

/**
 * Which of the given servers exposes this tool, or undefined when the name
 * carries no prefix belonging to any of them.
 *
 * The longest match wins. Servers named `db` and `db_admin` both prefix
 * `db_admin_query`, and answering `db` there would check the wrong server's
 * approval — the more specific prefix is the one that actually produced it.
 *
 * @param {string} toolName
 * @param {Iterable<string>} serverNames
 * @returns {string|undefined}
 */
export function attributeDirectTool(toolName, serverNames) {
  if (typeof toolName !== "string" || toolName.length === 0) return undefined;
  let best;
  let bestLength = 0;
  for (const name of serverNames) {
    for (const prefix of serverPrefixes(name)) {
      if (prefix.length <= bestLength) continue;
      if (!toolName.startsWith(`${prefix}_`)) continue;
      best = name;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * Whether a global or per-server direct-tool selection registers at least one
 * direct tool. The adapter accepts `true` or a non-empty list on server entries.
 * @param {unknown} value
 * @returns {boolean}
 */
export function directToolsEnabled(value) {
  return value === true
    || (Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0));
}

/**
 * Whether a config's settings put tools on the model under names that cannot be
 * traced to a server. Both halves are required: without `directTools` every call
 * goes through the proxy, which names its server explicitly.
 * @param {Record<string, unknown>} settings
 * @returns {boolean}
 */
export function erasesToolOrigin(settings) {
  if (!settings || typeof settings !== "object") return false;
  return directToolsEnabled(settings.directTools) && settings.toolPrefix === "none";
}

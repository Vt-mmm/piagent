import { containsSensitiveText } from "../security/sensitive-data.js";

// Building a server definition from what someone typed. The rule this file
// exists to hold: a credential never reaches the config file.
//
// MCP config is read by several clients, lives in the operator's home or in a
// repository, and in the `project` scope is meant to be committed. A token typed
// into `--env` would land in all of those. So a value whose name says credential
// has to be an environment reference, and the error says which form to use rather
// than only that the input was refused.

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// A whole-value reference, `${VAR}`. A value that merely contains one — say
// `Bearer ${TOKEN}` — is handled separately, because a header legitimately needs
// the scheme in front of the reference.
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const CONTAINS_ENV_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

const CREDENTIAL_NAME_TERMS = [
  "token", "secret", "password", "passwd", "passphrase", "credential",
  "apikey", "api_key", "accesskey", "access_key", "privatekey", "private_key",
  "authorization", "auth", "session", "cookie", "signature", "pat"
];

export class McpEntryError extends Error {}

/**
 * Whether a name says the value beside it is a credential. Deliberately broad:
 * a false positive costs one `${VAR}` indirection, a false negative writes a
 * live token into a file somebody commits.
 * @param {string} name
 * @returns {boolean}
 */
export function credentialLikeName(name) {
  const normalized = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return CREDENTIAL_NAME_TERMS.some((term) => {
    const bare = term.replace(/[^a-z0-9]+/g, "_");
    return normalized === bare || normalized.startsWith(`${bare}_`) || normalized.endsWith(`_${bare}`) || normalized.includes(`_${bare}_`);
  });
}

/**
 * @param {string} raw `KEY=VALUE`
 * @param {"env"|"header"} kind
 * @returns {[string, string]}
 */
export function parseAssignment(raw, kind) {
  const separator = kind === "header" ? ":" : "=";
  const index = String(raw).indexOf(separator);
  if (index <= 0) {
    throw new McpEntryError(
      kind === "header"
        ? `--header expects "Name: value", received: ${raw}`
        : `--env expects KEY=value, received: ${raw}`
    );
  }
  const name = raw.slice(0, index).trim();
  const value = raw.slice(index + 1).trim();
  if (!name) throw new McpEntryError(`${kind} name cannot be empty`);
  return [name, value];
}

/**
 * Refuse a literal credential, and say what to type instead. `kind` only shapes
 * the message; both channels are held to the same rule.
 * @param {string} name
 * @param {string} value
 * @param {"env"|"header"} kind
 * @returns {void}
 */
export function assertNoLiteralSecret(name, value, kind) {
  const referenced = kind === "header" ? CONTAINS_ENV_REFERENCE.test(value) : ENV_REFERENCE.test(value);
  if (referenced) return;

  const suggestion = kind === "header"
    ? `--header '${name}: Bearer \${${suggestedVariable(name)}}'`
    : `--env '${name}=\${${suggestedVariable(name)}}'`;

  if (credentialLikeName(name)) {
    throw new McpEntryError(
      `${name} names a credential, so its value cannot be written into MCP config. ` +
      `Export it in your shell and reference it instead: ${suggestion}`
    );
  }
  // The name gave nothing away, so the value is read on its own. This catches a
  // token pasted under a neutral name such as `--env CONFIG=ghp_...`.
  if (containsSensitiveText(`${name}=${value}`)) {
    throw new McpEntryError(
      `the value given for ${name} looks like a credential, so it cannot be written into MCP config. ` +
      `Export it in your shell and reference it instead: ${suggestion}`
    );
  }
}

/** @param {string} name @returns {string} */
function suggestedVariable(name) {
  const upper = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return upper || "TOKEN";
}

/** @param {string} name @returns {string} */
export function assertServerName(name) {
  if (!SERVER_NAME.test(String(name ?? ""))) {
    throw new McpEntryError(
      `invalid server name: ${name}. Use letters, digits, dot, dash or underscore, up to 64 characters.`
    );
  }
  return name;
}

/**
 * @typedef {object} BuildEntryInput
 * @property {string} name
 * @property {string} [url]
 * @property {string[]} [command] argv, first element is the executable
 * @property {string[]} [env] raw `KEY=value`
 * @property {string[]} [header] raw `Name: value`
 * @property {string} [bearerTokenEnvVar]
 * @property {string} [oauthClientId]
 * @property {string} [oauthScopes]
 * @property {boolean} [directTools]
 */

/**
 * @param {BuildEntryInput} input
 * @returns {Record<string, unknown>}
 */
export function buildServerEntry(input) {
  assertServerName(input.name);
  const hasUrl = typeof input.url === "string" && input.url.length > 0;
  const hasCommand = Array.isArray(input.command) && input.command.length > 0;
  if (hasUrl === hasCommand) {
    throw new McpEntryError("give either --url for a remote server or -- <command> for a local one, not both and not neither");
  }

  /** @type {Record<string, unknown>} */
  const entry = { lifecycle: "lazy", directTools: input.directTools === true };

  if (hasUrl) {
    const url = parseRemoteUrl(input.url ?? "");
    entry.url = url.href;
    if (input.oauthClientId || input.oauthScopes) {
      /** @type {Record<string, unknown>} */
      const oauth = {};
      if (input.oauthClientId) oauth.clientId = input.oauthClientId;
      if (input.oauthScopes) oauth.scopes = input.oauthScopes;
      entry.auth = "oauth";
      entry.oauth = oauth;
    }
    if (input.bearerTokenEnvVar) {
      // The variable name, never the token. Whoever reads the config learns which
      // variable to export and nothing else.
      entry.bearerTokenEnvVar = assertEnvVarName(input.bearerTokenEnvVar);
    }
    const headers = collectAssignments(input.header ?? [], "header");
    if (Object.keys(headers).length > 0) entry.headers = headers;
  } else {
    const argv = input.command ?? [];
    entry.command = argv[0];
    if (argv.length > 1) entry.args = argv.slice(1);
    const env = collectAssignments(input.env ?? [], "env");
    if (Object.keys(env).length > 0) entry.env = env;
    if (input.header?.length) throw new McpEntryError("--header applies to remote servers; a local server takes --env");
    if (input.bearerTokenEnvVar) throw new McpEntryError("--bearer-token-env-var applies to remote servers only");
  }

  return entry;
}

/** @param {string[]} raw @param {"env"|"header"} kind @returns {Record<string, string>} */
function collectAssignments(raw, kind) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const item of raw) {
    const [name, value] = parseAssignment(item, kind);
    assertNoLiteralSecret(name, value, kind);
    out[name] = value;
  }
  return out;
}

/** @param {string} value @returns {string} */
function assertEnvVarName(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new McpEntryError(`--bearer-token-env-var expects a variable name, received: ${value}`);
  }
  return value;
}

/**
 * A remote server has to be reachable over a transport this platform is willing
 * to describe as one. `http://` is allowed only on the loopback address, where
 * there is no network to intercept — Figma's desktop server is exactly that case.
 * @param {string} value
 * @returns {URL}
 */
export function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new McpEntryError(`--url is not a valid URL: ${value}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new McpEntryError(
    `--url must be https, or http on localhost. Received: ${url.protocol}//${url.hostname}`
  );
}

/** @param {string} hostname @returns {boolean} */
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * A server entry with every value that could be a credential replaced. Used for
 * display, so `list` and `get` can be pasted into an issue.
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
export function maskServerEntry(entry) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if ((key === "env" || key === "headers") && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(/** @type {Record<string, unknown>} */ (value)).map(([name, item]) => [
          name,
          // An environment reference is the name of a variable, not its contents,
          // so showing it is the point. Anything else is treated as a value.
          typeof item === "string" && ENV_REFERENCE.test(item) ? item : "*****"
        ])
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

const REDACTION = "[REDACTED_SECRET]";

const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[opsru]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:(?:proj|svcacct|admin|ant)-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
];

const CONNECTION_URL_PATTERN = /\b((?:https?|ftp|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/"']+:)([^@\s/"']+)(@[^\s"'<>]+)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})\b/gi;
const BASIC_AUTH_PATTERN = /\b(Basic\s+)([A-Za-z0-9+/]{12,}={0,2})(?=$|[\s,;}])/gi;
// The value is one whitespace-free token, not the rest of the line. Taking the
// rest of the line made the result depend on where the header sat among the
// arguments: `curl URL -H "Authorization: Token abc123"` yielded `abc123"`, short
// enough to keep, while moving the header before the URL swept the URL into the
// value and pushed it past the length bar. Same header, same credential, opposite
// outcome. Credentials carry no spaces, so stopping at the first one also keeps
// prose like "Authorization: not required for local runs" intact.
const AUTHORIZATION_HEADER_PATTERN = /\b(Authorization\s*:\s*)([A-Za-z][A-Za-z0-9_-]{0,31})(\s+)([^\s\r\n"'`]+)/gi;

// A credential passed as a command-line option, which is how most CLIs take one.
// The assignment patterns below require a key starting with a letter, so every
// `--token=...` and `--token ...` walked straight past them.
const CLI_OPTION_SECRET_PATTERN = /(^|[\s({[])(--[A-Za-z][A-Za-z0-9_.-]{0,80})(=|\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;,)}]+)/g;

// Under one of these schemes the header carries an opaque credential, so its
// length says nothing. Anything else after `Authorization:` is more likely prose
// — "Authorization: not required" — and keeps the ambiguous-syntax length bar.
const AUTHORIZATION_SCHEMES = new Set([
  "bearer", "basic", "token", "digest", "negotiate", "ntlm",
  "oauth", "hawk", "signature", "apikey", "jwt", "aws4-hmac-sha256"
]);
const QUERY_SECRET_PATTERN = /([?&])([A-Za-z][A-Za-z0-9_.-]{0,80})(=)([^&#\s]+)/gi;
const DOUBLE_QUOTED_SECRET_ASSIGNMENT_PATTERN = /(^|[\s{[,(;])((?:"|')?[A-Za-z][A-Za-z0-9_.-]{0,80}(?:"|')?\s*)(:|=(?!=))\s*"((?:\\.|[^"\\\r\n])*)"/gim;
const SINGLE_QUOTED_SECRET_ASSIGNMENT_PATTERN = /(^|[\s{[,(;])((?:"|')?[A-Za-z][A-Za-z0-9_.-]{0,80}(?:"|')?\s*)(:|=(?!=))\s*'((?:\\.|[^'\\\r\n])*)'/gim;
const SECRET_ASSIGNMENT_PATTERN = /(^|[\s{[,(;])((?:"|')?[A-Za-z][A-Za-z0-9_.-]{0,80}(?:"|')?\s*)(:|=(?!=))\s*([^"'\s,;}]+)/gim;
const WHITESPACE_SECRET_ASSIGNMENT_PATTERN = /(^|[\s{[,(;])((?:"|')?(?:aws_)?secret_access_key(?:"|')?\s+)(["']?)([A-Za-z0-9/+=]{20,})/gim;

const SENSITIVE_KEY_TERMS = [
  "api_key",
  "token",
  "password",
  "passwd",
  "pwd",
  "secret",
  "credential",
  "client_secret",
  "access_token",
  "refresh_token",
  "secret_access_key",
  "passphrase",
  "private_key",
  "signing_key",
  "authorization"
];
const SENSITIVE_PLURAL_KEYS = new Set([
  "tokens",
  "api_keys",
  "passwords",
  "secrets",
  "credentials",
  "client_secrets",
  "access_tokens",
  "refresh_tokens",
  "session_tokens",
  "passphrases",
  "private_keys",
  "signing_keys",
  "authorizations"
]);

function normalizeSecretValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/^[`"']|[`"']$/g, "")
    .replace(/[.;)]+$/g, "");
}

function patternMatches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function looksLikeKnownSecret(value) {
  return TOKEN_PATTERNS.some((pattern) => patternMatches(pattern, value))
    || patternMatches(CONNECTION_URL_PATTERN, value)
    || patternMatches(BEARER_PATTERN, value);
}

function normalizeSecretKey(key) {
  return String(key ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function keyLooksSensitive(key) {
  const normalized = normalizeSecretKey(key);
  return SENSITIVE_PLURAL_KEYS.has(normalized) || SENSITIVE_KEY_TERMS.some((term) => normalized === term
    || normalized.endsWith(`_${term}`));
}

function valueLooksPlaceholder(value) {
  const clean = normalizeSecretValue(value);
  if (!clean) return true;
  if (/^(?:null|undefined|none|false|true|0|""|'')$/i.test(clean)) return true;
  if (/^<[^>\n]{1,80}>$/.test(clean)) return true;
  if (/^\[REDACTED_SECRET\]$/i.test(clean)) return true;
  if (/^(?:not-set|unset|placeholder|example|changeme|change-me|redacted|xxx|\*{3,})$/i.test(clean)) return true;
  if (/^your[-_][a-z0-9][a-z0-9_-]*$/i.test(clean)) return true;
  return false;
}

// Length is only evidence where the syntax is ambiguous, and `=` is not.
//
// A short value used to be kept in the clear whatever the syntax, so `TOKEN=hunter2`
// and `PASSWORD=short7` went into the ledger verbatim. Every name in
// SENSITIVE_KEY_TERMS states outright what it holds — there is no `key` or `id`
// among them — so under an `=`, or inside quotes, a non-placeholder value is the
// secret the key says it is, at any length.
//
// A bare `:` is the ambiguous case, because English uses it too: `password: short`
// and `The secret: always run tests` are prose, and `Authorization: Token abc123`
// puts the scheme name where a value would go. Those keep a length bar.
const SHORT_VALUE_MIN_LENGTH = 8;
const AMBIGUOUS_VALUE_MIN_LENGTH = 12;

function valueLooksSensitive(key, value, syntax = "unquoted-colon") {
  const clean = normalizeSecretValue(value);
  if (!clean || valueLooksPlaceholder(clean)) return false;
  if (looksLikeKnownSecret(clean)) return true;
  if (!keyLooksSensitive(key)) return false;
  if (syntax !== "unquoted-colon") return true;
  return clean.length >= (keyNamesASecretOutright(key) ? SHORT_VALUE_MIN_LENGTH : AMBIGUOUS_VALUE_MIN_LENGTH);
}

// Under a bare `:`, these names carry enough intent on their own to redact a short
// value; the broader terms wait for length before touching prose.
function keyNamesASecretOutright(key) {
  const normalized = normalizeSecretKey(key);
  return ["password", "passwd", "pwd", "secret", "credential", "passphrase", "private_key", "signing_key"]
    .some((term) => normalized === term || normalized.endsWith(`_${term}`))
    || ["passwords", "secrets", "credentials", "passphrases", "private_keys", "signing_keys"].includes(normalized);
}

function assignmentSyntax(separator) {
  return separator === "=" ? "assignment" : "unquoted-colon";
}

export function redactSensitiveText(input) {
  if (typeof input !== "string") return { text: "", redacted: false };
  let text = input;

  text = text.replace(CONNECTION_URL_PATTERN, (_match, prefix, _password, suffix) => `${prefix}${REDACTION}${suffix}`);
  text = text.replace(BEARER_PATTERN, (_match, prefix) => `${prefix}${REDACTION}`);
  text = text.replace(BASIC_AUTH_PATTERN, (_match, prefix) => `${prefix}${REDACTION}`);
  text = text.replace(AUTHORIZATION_HEADER_PATTERN, (match, prefix, scheme, spacing, value) => {
    const syntax = AUTHORIZATION_SCHEMES.has(scheme.toLowerCase()) ? "assignment" : "unquoted-colon";
    if (!valueLooksSensitive("authorization", value, syntax)) return match;
    return `${prefix}${scheme}${spacing}${REDACTION}`;
  });

  // Over-redaction is the safe direction here: a flag whose name says "secret"
  // and whose argument is a plain name — `docker service create --secret build` —
  // loses that name from the record and cannot serve as verify evidence. Reading
  // the name as the credential it is called is the cheaper mistake.
  text = text.replace(CLI_OPTION_SECRET_PATTERN, (match, prefix, flag, separator, value) => {
    // A following option is the next flag, not this flag's argument.
    if (separator !== "=" && value.startsWith("-")) return match;
    if (!keyLooksSensitive(flag) || !valueLooksSensitive(flag, value, "assignment")) return match;
    return `${prefix}${flag}${separator === "=" ? "= " : " "}${REDACTION}`;
  });

  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTION);

  text = text.replace(QUERY_SECRET_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value, "assignment")) return match;
    return `${prefix}${key}${separator}${REDACTION}`;
  });

  text = text.replace(DOUBLE_QUOTED_SECRET_ASSIGNMENT_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value, "quoted")) return match;
    return `${prefix}${key}${separator} "${REDACTION}"`;
  });

  text = text.replace(SINGLE_QUOTED_SECRET_ASSIGNMENT_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value, "quoted")) return match;
    return `${prefix}${key}${separator} '${REDACTION}'`;
  });

  text = text.replace(SECRET_ASSIGNMENT_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value, assignmentSyntax(separator))) return match;
    return `${prefix}${key}${separator} ${REDACTION}`;
  });

  text = text.replace(WHITESPACE_SECRET_ASSIGNMENT_PATTERN, (match, prefix, key, quote, value) => {
    if (!valueLooksSensitive(key, value)) return match;
    return `${prefix}${key}${quote}${REDACTION}`;
  });

  return { text, redacted: text !== input };
}

export function containsSensitiveText(input) {
  return typeof input === "string" && redactSensitiveText(input).redacted;
}

function redactStorageValue(value, key) {
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    if (redacted.redacted) return redacted.text;
    // A field name in a structure is machine syntax, never prose, so length says
    // nothing here either.
    return key && keyLooksSensitive(key) && valueLooksSensitive(key, value, "assignment") ? REDACTION : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactStorageValue(item, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, item]) => [childKey, redactStorageValue(item, childKey)])
  );
}

export function redactForStorage(value) {
  return redactStorageValue(value, undefined);
}

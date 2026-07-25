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
const AUTHORIZATION_HEADER_PATTERN = /\b(Authorization\s*:\s*)([A-Za-z][A-Za-z0-9_-]{0,31})(\s+)([^\r\n]+)/gi;
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
const LOWER_THRESHOLD_PLURAL_KEYS = new Set([
  "passwords",
  "secrets",
  "credentials",
  "passphrases",
  "private_keys",
  "signing_keys"
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

function keyRequiresLowerThreshold(key) {
  const normalized = normalizeSecretKey(key);
  return LOWER_THRESHOLD_PLURAL_KEYS.has(normalized)
    || ["password", "passwd", "pwd", "secret", "credential", "passphrase", "private_key", "signing_key"]
      .some((term) => normalized === term || normalized.endsWith(`_${term}`));
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

function valueLooksSensitive(key, value) {
  const clean = normalizeSecretValue(value);
  if (!clean || valueLooksPlaceholder(clean)) return false;
  if (looksLikeKnownSecret(clean)) return true;
  if (keyRequiresLowerThreshold(key)) return clean.length >= 8;
  return keyLooksSensitive(key) && clean.length >= 12;
}

export function redactSensitiveText(input) {
  if (typeof input !== "string") return { text: "", redacted: false };
  let text = input;

  text = text.replace(CONNECTION_URL_PATTERN, (_match, prefix, _password, suffix) => `${prefix}${REDACTION}${suffix}`);
  text = text.replace(BEARER_PATTERN, (_match, prefix) => `${prefix}${REDACTION}`);
  text = text.replace(BASIC_AUTH_PATTERN, (_match, prefix) => `${prefix}${REDACTION}`);
  text = text.replace(AUTHORIZATION_HEADER_PATTERN, (match, prefix, scheme, spacing, value) => {
    if (!valueLooksSensitive("authorization", value)) return match;
    return `${prefix}${scheme}${spacing}${REDACTION}`;
  });

  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTION);

  text = text.replace(QUERY_SECRET_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value)) return match;
    return `${prefix}${key}${separator}${REDACTION}`;
  });

  text = text.replace(DOUBLE_QUOTED_SECRET_ASSIGNMENT_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value)) return match;
    return `${prefix}${key}${separator} "${REDACTION}"`;
  });

  text = text.replace(SINGLE_QUOTED_SECRET_ASSIGNMENT_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value)) return match;
    return `${prefix}${key}${separator} '${REDACTION}'`;
  });

  text = text.replace(SECRET_ASSIGNMENT_PATTERN, (match, prefix, key, separator, value) => {
    if (!keyLooksSensitive(key) || !valueLooksSensitive(key, value)) return match;
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
    return key && keyLooksSensitive(key) && valueLooksSensitive(key, value) ? REDACTION : value;
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

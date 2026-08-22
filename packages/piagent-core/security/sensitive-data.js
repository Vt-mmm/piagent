import {
  REDACTION,
  keyLooksSensitive,
  redactSensitiveText,
  valueLooksSensitive
} from "./sensitive-text.js";

export { redactSensitiveText } from "./sensitive-text.js";
export {
  redactSensitiveShellSourceText,
  redactSensitiveSourceText
} from "./sensitive-source-formats.js";
export { redactSensitiveProjectFileText } from "./sensitive-project-file.js";

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

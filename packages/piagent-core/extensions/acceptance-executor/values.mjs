export const MAX_STRING_LENGTH = 4096;
export const MAX_VALUE_DEPTH = 8;
export const MAX_VALUE_NODES = 256;
export const MAX_COLLECTION_LENGTH = 64;
export const MAX_VALUE_TEXT = 64 * 1024;
const SPECIAL_NUMBERS = new Set(["NaN", "Infinity", "-Infinity", "-0"]);

export function protocolShape(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) throw new TypeError("Invalid protocol object");
}

/** Typed data trees only: no executable values, references, sparse arrays or cycles. */
export function validateValue(value, allowDate = true, callbackIds = new Set()) {
  let nodes = 0, text = 0;
  function visit(item, depth) {
    if (++nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) throw new TypeError("Value tree limit exceeded");
    protocolShape(item, ["type", "value"], ["type"]);
    if (["undefined", "null"].includes(item.type)) {
      if (Object.hasOwn(item, "value")) throw new TypeError("Unexpected primitive payload");
    } else if (item.type === "callback" && callbackIds.has(item.value)) {
      if (typeof item.value !== "string") throw new TypeError("Invalid callback reference");
    } else if (item.type === "number" || allowDate && item.type === "date") {
      if (!(typeof item.value === "number" && Number.isFinite(item.value)) && !SPECIAL_NUMBERS.has(item.value)) {
        throw new TypeError("Invalid numeric payload");
      }
    } else if (item.type === "boolean") {
      if (typeof item.value !== "boolean") throw new TypeError("Invalid boolean payload");
    } else if (item.type === "string") {
      if (typeof item.value !== "string" || item.value.length > MAX_STRING_LENGTH) throw new TypeError("Invalid string payload");
      text += item.value.length;
    } else if (["array", "record"].includes(item.type)) {
      if (!Array.isArray(item.value) || item.value.length > MAX_COLLECTION_LENGTH
        || Object.keys(item.value).length !== item.value.length) throw new TypeError("Invalid collection payload");
      const keys = new Set();
      for (const child of item.value) {
        if (item.type === "array") visit(child, depth + 1);
        else {
          protocolShape(child, ["key", "value"]);
          if (typeof child.key !== "string" || child.key.length > MAX_STRING_LENGTH || keys.has(child.key)) throw new TypeError("Invalid record key");
          keys.add(child.key); text += child.key.length; visit(child.value, depth + 1);
        }
      }
    } else throw new TypeError("Unsupported value type");
    if (text > MAX_VALUE_TEXT) throw new TypeError("Value text limit exceeded");
  }
  visit(value, 0);
  return value;
}

export function numberValue(value) {
  if (Number.isNaN(value)) return "NaN";
  if (Object.is(value, -0)) return "-0";
  if (!Number.isFinite(value)) return String(value);
  return value;
}

/** Record insertion order is not an equality obligation; array order is. */
export function canonicalValue(value) {
  if (value.type === "array") return { type: "array", value: value.value.map(canonicalValue) };
  if (value.type === "record") return { type: "record", value: value.value.map((entry) => ({ key: entry.key, value: canonicalValue(entry.value) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) };
  return value;
}

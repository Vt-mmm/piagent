export const MAX_STRING_LENGTH = 4096;
export const MAX_VALUE_DEPTH = 8;
export const MAX_VALUE_NODES = 256;
export const MAX_COLLECTION_LENGTH = 64;
export const MAX_VALUE_TEXT = 64 * 1024;
export const MAX_TYPED_BACKING_BYTES = 4096;
export const MAX_CASE_RAW_AND_TEXT_BYTES = 64 * 1024;
export const MAX_TYPED_OUTPUT_BYTES = 64 * 1024;
const SPECIAL_NUMBERS = new Set(["NaN", "Infinity", "-Infinity", "-0"]);
const TYPED_BYTES = new Set(["uint8array", "buffer", "arraybuffer", "dataview"]);

export function protocolShape(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) throw new TypeError("Invalid protocol object");
}

/** Typed trees with optional approved callback IDs, never executable code or history references. */
export function validateValue(value, allowDate = true, callbackIds = new Set(), options = {}) {
  let nodes = 0, text = 0, textUtf8 = 0, rawBytes = 0;
  const typedBytes = options.typedBytes === true;
  const shared = options.budget;
  const typedOutput = options.typedOutputBudget;
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
      text += item.value.length; textUtf8 += Buffer.byteLength(item.value);
    } else if (typedBytes && TYPED_BYTES.has(item.type)) {
      protocolShape(item, ["type", "value"]);
      protocolShape(item.value, ["backingBase64", "byteOffset", "byteLength"]);
      const { backingBase64, byteOffset, byteLength } = item.value;
      if (typeof backingBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(backingBase64)
        || !Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new TypeError("Invalid typed byte payload");
      }
      const backing = Buffer.from(backingBase64, "base64");
      if (backing.toString("base64") !== backingBase64 || backing.length > MAX_TYPED_BACKING_BYTES
        || byteOffset + byteLength > backing.length
        || item.type === "arraybuffer" && (byteOffset !== 0 || byteLength !== backing.length)) {
        throw new TypeError("Invalid typed byte range");
      }
      rawBytes += backing.length;
      if (typedOutput) {
        typedOutput.rawBytes = (typedOutput.rawBytes ?? 0) + backing.length;
        if (typedOutput.rawBytes > MAX_TYPED_OUTPUT_BYTES) throw new TypeError("Aggregate typed output budget exceeded");
      }
    } else if (["array", "record"].includes(item.type)) {
      if (!Array.isArray(item.value) || item.value.length > MAX_COLLECTION_LENGTH
        || Object.keys(item.value).length !== item.value.length) throw new TypeError("Invalid collection payload");
      const keys = new Set();
      for (const child of item.value) {
        if (item.type === "array") visit(child, depth + 1);
        else {
          protocolShape(child, ["key", "value"]);
          if (typeof child.key !== "string" || child.key.length > MAX_STRING_LENGTH || keys.has(child.key)) throw new TypeError("Invalid record key");
          keys.add(child.key); text += child.key.length; textUtf8 += Buffer.byteLength(child.key); visit(child.value, depth + 1);
        }
      }
    } else throw new TypeError("Unsupported value type");
    if (text > MAX_VALUE_TEXT) throw new TypeError("Value text limit exceeded");
  }
  visit(value, 0);
  if (shared) {
    shared.rawBytes = (shared.rawBytes ?? 0) + rawBytes;
    shared.textBytes = (shared.textBytes ?? 0) + textUtf8;
    if (shared.rawBytes + shared.textBytes > MAX_CASE_RAW_AND_TEXT_BYTES) throw new TypeError("Case byte and text budget exceeded");
  }
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

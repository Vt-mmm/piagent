export const WORKER_VERSION = "quickjs-contract-worker-v1";
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_STRING_LENGTH = 4096;
const SPECIAL_NUMBERS = new Set(["NaN", "Infinity", "-Infinity", "-0"]);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;

function shape(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) throw new TypeError("Invalid protocol object");
}

export function validateValue(value, allowDate = true) {
  shape(value, ["type", "value"], ["type"]);
  if (["undefined", "null"].includes(value.type)) {
    if (Object.hasOwn(value, "value")) throw new TypeError("Unexpected primitive payload");
  } else if (["number", ...(allowDate ? ["date"] : [])].includes(value.type)) {
    if (!(typeof value.value === "number" && Number.isFinite(value.value)) && !SPECIAL_NUMBERS.has(value.value)) {
      throw new TypeError("Invalid numeric payload");
    }
  } else if (value.type === "boolean") {
    if (typeof value.value !== "boolean") throw new TypeError("Invalid boolean payload");
  } else if (value.type === "string") {
    if (typeof value.value !== "string" || value.value.length > MAX_STRING_LENGTH) throw new TypeError("Invalid string payload");
  } else throw new TypeError("Unsupported value type");
  return value;
}

export function parseRequest(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new TypeError("Request size exceeded");
  const request = JSON.parse(text);
  shape(request, ["schemaVersion", "source", "exportName", "cases"]);
  if (request.schemaVersion !== 1 || typeof request.source !== "string" || Buffer.byteLength(request.source) > 128 * 1024
    || typeof request.exportName !== "string" || !/^[a-zA-Z_$][\w$]{0,127}$/.test(request.exportName)
    || !Array.isArray(request.cases) || request.cases.length < 1 || request.cases.length > 256) throw new TypeError("Invalid execution request");
  const ids = new Set();
  for (const item of request.cases) {
    shape(item, ["id", "args", "clock"], ["id", "args"]);
    if (typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id)
      || !Array.isArray(item.args) || item.args.length > 16
      || (Object.hasOwn(item, "clock") && (!Number.isSafeInteger(item.clock) || Math.abs(item.clock) > 8.64e15))) {
      throw new TypeError("Invalid execution case");
    }
    ids.add(item.id);
    item.args.forEach((value) => validateValue(value));
  }
  return request;
}

export function numberValue(value) {
  if (Number.isNaN(value)) return "NaN";
  if (Object.is(value, -0)) return "-0";
  if (!Number.isFinite(value)) return String(value);
  return value;
}

export function parseResponse(text, request, requestDigest) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new TypeError("Response size exceeded");
  const response = JSON.parse(text);
  shape(response, ["schemaVersion", "workerVersion", "requestDigest", "status", "cases"]);
  if (response.schemaVersion !== 1 || response.workerVersion !== WORKER_VERSION || response.requestDigest !== requestDigest
    || !["completed", "timeout", "error"].includes(response.status) || !Array.isArray(response.cases)
    || response.cases.length > request.cases.length
    || (response.status === "completed" && response.cases.length !== request.cases.length)) throw new TypeError("Invalid worker response");
  for (const [index, item] of response.cases.entries()) {
    shape(item, ["id", "outcome", "value", "errorClass", "reason", "dateArgsAfter", "clockReads"], ["id", "outcome"]);
    if (item.id !== request.cases[index].id || !["return", "throw", "unsupported", "error"].includes(item.outcome)) throw new TypeError("Invalid case observation");
    if (item.outcome === "return") {
      validateValue(item.value, false);
      if (Object.hasOwn(item, "errorClass") || Object.hasOwn(item, "reason")) throw new TypeError("Conflicting return observation");
    } else if (item.outcome === "throw") {
      if (!["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Error", "non-error"].includes(item.errorClass)
        || Object.hasOwn(item, "value") || Object.hasOwn(item, "reason")) throw new TypeError("Invalid throw observation");
    } else if (typeof item.reason !== "string" || !/^[a-z-]{1,64}$/.test(item.reason)
      || Object.hasOwn(item, "value") || Object.hasOwn(item, "errorClass")) throw new TypeError("Invalid incomplete observation");
    if (["return", "throw"].includes(item.outcome)) {
      const expectedIndexes = request.cases[index].args.flatMap((arg, argIndex) => arg.type === "date" ? [argIndex] : []);
      if (!Array.isArray(item.dateArgsAfter) || item.dateArgsAfter.length !== expectedIndexes.length
        || !Number.isSafeInteger(item.clockReads) || item.clockReads < 0) throw new TypeError("Missing side-effect observation");
      item.dateArgsAfter.forEach((arg, argIndex) => {
        shape(arg, ["index", "value"]);
        if (arg.index !== expectedIndexes[argIndex]) throw new TypeError("Wrong observed argument");
        validateValue({ type: "number", value: arg.value }, false);
      });
    } else if (Object.hasOwn(item, "dateArgsAfter") || Object.hasOwn(item, "clockReads")) throw new TypeError("Unexpected side-effect observation");
  }
  return response;
}

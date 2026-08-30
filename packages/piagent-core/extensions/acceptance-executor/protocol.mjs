import { protocolShape as shape, validateValue } from "./values.mjs";
import { MAX_SOURCE_BYTES, validateModuleGraph } from "./module-graph.mjs";
import { CASE_THREAD_CPU_MICROS } from "./budget.mjs";
import { CASE_CAPABILITY_FIELDS, OBSERVATION_CAPABILITY_FIELDS, callbackIds, validateCaseCapabilities, validateObservedCapabilities } from "./capabilities.mjs";
import { resolveArguments } from "./references.mjs";
export { MAX_STRING_LENGTH, numberValue, validateValue } from "./values.mjs";

export const WORKER_VERSION = "quickjs-contract-worker-v7";
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;
const EXPORT = /^[a-zA-Z_$][\w$]{0,127}$/;

export function parseRequest(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new TypeError("Request size exceeded");
  const request = JSON.parse(text);
  shape(request, ["schemaVersion", "source", "exportName", "cases", "moduleGraph"], ["schemaVersion", "source", "exportName", "cases"]);
  if (request.schemaVersion !== 1 || typeof request.source !== "string" || Buffer.byteLength(request.source) > MAX_SOURCE_BYTES
    || typeof request.exportName !== "string" || !EXPORT.test(request.exportName)
    || !Array.isArray(request.cases) || request.cases.length < 1 || request.cases.length > 256) throw new TypeError("Invalid execution request");
  if (Object.hasOwn(request, "moduleGraph")) validateModuleGraph(request.source, request.moduleGraph);
  const ids = new Map(), closedSequences = new Set();
  let sequence;
  for (const item of request.cases) {
    shape(item, ["id", "args", "clock", "sequence", "exportName", "reset", "observeArgs", ...CASE_CAPABILITY_FIELDS], ["id", "args"]);
    if (typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id)
      || !Array.isArray(item.args) || item.args.length > 16
      || (Object.hasOwn(item, "clock") && (!Number.isSafeInteger(item.clock) || Math.abs(item.clock) > 8.64e15))) {
      throw new TypeError("Invalid execution case");
    }
    if (Object.hasOwn(item, "sequence") && (typeof item.sequence !== "string" || !ID.test(item.sequence))
      || Object.hasOwn(item, "exportName") && (typeof item.exportName !== "string" || !EXPORT.test(item.exportName))
      || Object.hasOwn(item, "reset") && (item.reset !== true || !item.sequence)
      || Object.hasOwn(item, "observeArgs") && typeof item.observeArgs !== "boolean") throw new TypeError("Invalid sequence operation");
    if (sequence !== item.sequence) {
      if (sequence !== undefined) closedSequences.add(sequence);
      if (closedSequences.has(item.sequence)) throw new TypeError("Non-contiguous sequence");
      sequence = item.sequence;
    }
    const callbacks = validateCaseCapabilities(item);
    item.args.forEach((value) => {
      if (!["result", "error-property"].includes(value?.type)) { validateValue(value, true, callbacks); return; }
      shape(value, value.type === "result" ? ["type", "value"] : ["type", "value", "key"]);
      if (typeof value.value !== "string" || !item.sequence || !ids.has(value.value) || ids.get(value.value).sequence !== item.sequence) {
        throw new TypeError("Result references require an earlier case in the same sequence");
      }
      if (value.type === "error-property" && (!ids.get(value.value).observeError || typeof value.key !== "string" || value.key.length > 128)) {
        throw new TypeError("Error property references require an earlier error observation");
      }
    });
    ids.set(item.id, item);
  }
  return request;
}

export function parseResponse(text, request, requestDigest) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new TypeError("Response size exceeded");
  const response = JSON.parse(text);
  shape(response, ["schemaVersion", "workerVersion", "requestDigest", "status", "cases", "timeoutReason"],
    ["schemaVersion", "workerVersion", "requestDigest", "status", "cases"]);
  if (response.schemaVersion !== 1 || response.workerVersion !== WORKER_VERSION || response.requestDigest !== requestDigest
    || !["completed", "timeout", "error"].includes(response.status) || !Array.isArray(response.cases)
    || response.cases.length > request.cases.length
    || (response.status === "completed" && response.cases.length !== request.cases.length)) throw new TypeError("Invalid worker response");
  const observations = new Map();
  for (const [index, item] of response.cases.entries()) {
    shape(item, ["id", "outcome", "value", "errorClass", "reason", "dateArgsAfter", "clockReads", "argsAfter", "resources", ...OBSERVATION_CAPABILITY_FIELDS], ["id", "outcome"]);
    if (item.id !== request.cases[index].id || !["return", "throw", "unsupported", "error"].includes(item.outcome)) throw new TypeError("Invalid case observation");
    if (item.outcome === "return") {
      validateValue(item.value, false);
      if (Object.hasOwn(item, "errorClass") || Object.hasOwn(item, "reason")) throw new TypeError("Conflicting return observation");
    } else if (item.outcome === "throw") {
      if (!["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Error", "non-error"].includes(item.errorClass)
        || Object.hasOwn(item, "value") || Object.hasOwn(item, "reason")) throw new TypeError("Invalid throw observation");
    } else if (typeof item.reason !== "string" || !/^[a-z-]{1,64}$/.test(item.reason)
      || Object.hasOwn(item, "value") || Object.hasOwn(item, "errorClass")) throw new TypeError("Invalid incomplete observation");
    const resourceStop = item.outcome === "error" && ["guest-cpu-budget", "guest-wall-deadline"].includes(item.reason);
    if (resourceStop) {
      shape(item.resources, ["caseCpuMicros", "caseThreadCpuMicros", "caseWallMicros"]);
      if (!Object.values(item.resources).every(value => Number.isSafeInteger(value) && value >= 0)
        || (item.reason === "guest-cpu-budget" && item.resources.caseThreadCpuMicros < CASE_THREAD_CPU_MICROS)) {
        throw new TypeError("Invalid resource stop observation");
      }
    } else if (Object.hasOwn(item, "resources")) throw new TypeError("Unexpected resource stop observation");
    if (["return", "throw"].includes(item.outcome)) {
      const resolved = resolveArguments(request.cases[index].args, observations);
      if (resolved.some(arg => arg === undefined)) throw new TypeError("Unavailable referenced observation");
      const expectedIndexes = resolved.flatMap((arg, argIndex) => arg.type === "date" ? [argIndex] : []);
      if (!Array.isArray(item.dateArgsAfter) || item.dateArgsAfter.length !== expectedIndexes.length
        || !Number.isSafeInteger(item.clockReads) || item.clockReads < 0) throw new TypeError("Missing side-effect observation");
      item.dateArgsAfter.forEach((arg, argIndex) => {
        shape(arg, ["index", "value"]);
        if (arg.index !== expectedIndexes[argIndex]) throw new TypeError("Wrong observed argument");
        validateValue({ type: "number", value: arg.value }, false);
      });
      if (request.cases[index].observeArgs) {
        if (!Array.isArray(item.argsAfter) || item.argsAfter.length !== request.cases[index].args.length) throw new TypeError("Missing argument snapshots");
        item.argsAfter.forEach((arg) => validateValue(arg, true, callbackIds(request.cases[index])));
      } else if (Object.hasOwn(item, "argsAfter")) throw new TypeError("Unexpected argument snapshots");
    } else if (Object.hasOwn(item, "dateArgsAfter") || Object.hasOwn(item, "clockReads") || Object.hasOwn(item, "argsAfter")) throw new TypeError("Unexpected side-effect observation");
    validateObservedCapabilities(item, request.cases[index]);
    observations.set(item.id, item);
  }
  const timeouts = ["guest-cpu-budget", "guest-wall-deadline"];
  const errors = response.cases.filter((item) => item.outcome === "error");
  if (errors.length > 1 || (errors.length && response.cases.at(-1) !== errors[0])) throw new TypeError("Nonterminal worker error");
  if (response.status === "timeout") {
    if (!timeouts.includes(response.timeoutReason)
      || (errors.length && errors[0].reason !== response.timeoutReason)
      || (response.timeoutReason === "guest-cpu-budget" && errors.length !== 1)) throw new TypeError("Invalid timeout cause");
  } else if (Object.hasOwn(response, "timeoutReason") || errors.some((item) => timeouts.includes(item.reason))
    || (response.status === "completed" && errors.length) || (response.status === "error" && errors.length !== 1)) {
    throw new TypeError("Conflicting worker status");
  }
  return response;
}

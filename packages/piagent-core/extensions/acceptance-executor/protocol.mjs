import { protocolShape as shape, validateValue } from "./values.mjs";
import { MAX_SOURCE_BYTES, validateModuleGraph } from "./module-graph.mjs";
import { CASE_THREAD_CPU_MICROS } from "./budget.mjs";
import { CASE_CAPABILITY_FIELDS, OBSERVATION_CAPABILITY_FIELDS, callbackIds, validateCaseCapabilities, validateObservedCapabilities } from "./capabilities.mjs";
import { resolveArguments } from "./references.mjs";
import { expectedNodeProfile, MAX_TIMER_SCHEDULES, NODE_PROFILE_WORKER_VERSION } from "./node-profile.mjs";
import { validateInvocation } from "./invocation.mjs";
export { MAX_STRING_LENGTH, numberValue, validateValue } from "./values.mjs";

export const WORKER_VERSION = "quickjs-contract-worker-v8";
export const NODE_WORKER_VERSION = NODE_PROFILE_WORKER_VERSION;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;
const EXPORT = /^[a-zA-Z_$][\w$]{0,127}$/;

export function parseRequest(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new TypeError("Request size exceeded");
  const request = JSON.parse(text);
  const nodeProfile = request?.schemaVersion === 2;
  shape(request, ["schemaVersion", "profile", "source", "exportName", "cases", "moduleGraph"],
    nodeProfile ? ["schemaVersion", "profile", "source", "exportName", "cases"] : ["schemaVersion", "source", "exportName", "cases"]);
  if (!nodeProfile && request.schemaVersion !== 1 || typeof request.source !== "string" || Buffer.byteLength(request.source) > MAX_SOURCE_BYTES
    || typeof request.exportName !== "string" || !EXPORT.test(request.exportName)
    || !Array.isArray(request.cases) || request.cases.length < 1 || request.cases.length > 256) throw new TypeError("Invalid execution request");
  if (nodeProfile) {
    shape(request.profile, ["id", "digest", "workerVersion"]);
    const expected = expectedNodeProfile();
    if (request.profile.id !== expected.id || request.profile.digest !== expected.digest || request.profile.workerVersion !== expected.workerVersion) {
      throw new TypeError("Invalid Node profile identity");
    }
  } else if (Object.hasOwn(request, "profile")) throw new TypeError("Unexpected execution profile");
  if (Object.hasOwn(request, "moduleGraph")) validateModuleGraph(request.source, request.moduleGraph, { nodeProfile });
  const ids = new Map(), closedSequences = new Set();
  const receivers = new Map();
  let sequence;
  for (const item of request.cases) {
    shape(item, ["id", "args", "clock", "sequence", "exportName", "reset", "observeArgs", "invocation", ...CASE_CAPABILITY_FIELDS],
      nodeProfile ? ["id", "args", "invocation"] : ["id", "args"]);
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
      sequence = item.sequence; receivers.clear();
    }
    if (item.reset) receivers.clear();
    if (nodeProfile) {
      validateInvocation(item.invocation);
      if (item.invocation.kind === "construct") {
        if (!item.sequence || receivers.size || receivers.has(item.invocation.receiverId) || item.awaitResult || item.observeIdentity) {
          throw new TypeError("Invalid receiver construction");
        }
        receivers.set(item.invocation.receiverId, item.sequence);
      } else if (item.invocation.kind === "method") {
        if (!item.sequence || receivers.get(item.invocation.receiverId) !== item.sequence) throw new TypeError("Unknown receiver");
      }
      if (item.invocation.kind === "construct" && item.referencePairs?.some(pair => [pair.left, pair.right].some(selector => selector.root !== "argument"))) {
        throw new TypeError("Constructed receivers are not observable roots");
      }
    } else if (Object.hasOwn(item, "invocation")) throw new TypeError("Unexpected invocation");
    const budget = nodeProfile ? { rawBytes: 0, textBytes: 0 } : undefined;
    const callbacks = validateCaseCapabilities(item, { nodeProfile, budget });
    item.args.forEach((value) => {
      if (!["result", "error-property"].includes(value?.type)) {
        validateValue(value, true, callbacks, { typedBytes: nodeProfile, budget }); return;
      }
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
  if (request.schemaVersion === 2) return parseNodeResponse(response, request, requestDigest);
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

const COUNTER_FIELDS = ["calls", "rawBytes", "textBytes", "decodersCreated", "timersScheduled", "denials"];
function validateServiceCounters(value) {
  shape(value, COUNTER_FIELDS);
  if (COUNTER_FIELDS.some(field => !Number.isSafeInteger(value[field]) || value[field] < 0)) throw new TypeError("Invalid Node service counters");
}

function validateInvocationTrace(value, item, outcome, defaultExport) {
  const invocation = item.invocation;
  const fields = invocation.kind === "call" ? ["kind", "exportName", "outcome"]
    : invocation.kind === "construct" ? ["kind", "receiverId", "outcome"] : ["kind", "receiverId", "method", "outcome"];
  shape(value, fields);
  if (value.kind !== invocation.kind || value.outcome !== outcome
    || invocation.kind === "call" && value.exportName !== (item.exportName ?? defaultExport)
    || invocation.receiverId && value.receiverId !== invocation.receiverId
    || invocation.method && value.method !== invocation.method) throw new TypeError("Invalid invocation trace");
}

function parseNodeResponse(response, request, requestDigest) {
  shape(response, ["schemaVersion", "workerVersion", "profileDigest", "requestDigest", "status", "cases", "timeoutReason", "services", "quiescence", "timerTrace"],
    ["schemaVersion", "workerVersion", "profileDigest", "requestDigest", "status", "cases", "services", "quiescence"]);
  if (response.schemaVersion !== 2 || response.workerVersion !== NODE_WORKER_VERSION || response.profileDigest !== request.profile.digest
    || response.requestDigest !== requestDigest || !["completed", "timeout", "error"].includes(response.status)
    || !Array.isArray(response.cases) || response.cases.length > request.cases.length
    || response.status === "completed" && response.cases.length !== request.cases.length) throw new TypeError("Invalid Node worker response");
  validateServiceCounters(response.services);
  shape(response.quiescence, ["pendingTimers", "liveDecoders", "receivers"]);
  if (Object.values(response.quiescence).some(value => value !== 0)) throw new TypeError("Node worker did not quiesce");
  if (Object.hasOwn(response, "timerTrace")) {
    if (!Array.isArray(response.timerTrace) || response.timerTrace.length > MAX_TIMER_SCHEDULES * 3) throw new TypeError("Invalid timer trace");
    response.timerTrace.forEach((entry, index) => {
      shape(entry, ["sequence", "event", "id", "delay"], entry.event === "cancel" ? ["sequence", "event", "id"] : ["sequence", "event", "id", "delay"]);
      if (entry.sequence !== index || !["schedule", "fire", "cancel"].includes(entry.event)
        || !Number.isSafeInteger(entry.id) || entry.id < 1
        || Object.hasOwn(entry, "delay") && (!Number.isSafeInteger(entry.delay) || entry.delay < 1 || entry.delay > 5000)) throw new TypeError("Invalid timer event");
    });
  }
  const observations = new Map(), aggregate = Object.fromEntries(COUNTER_FIELDS.map(field => [field, 0]));
  const typedOutputBudget = { rawBytes: 0 };
  for (const [index, item] of response.cases.entries()) {
    const requested = request.cases[index];
    shape(item, ["id", "outcome", "value", "errorClass", "reason", "dateArgsAfter", "clockReads", "argsAfter", "resources", "invocationTrace", "services", ...OBSERVATION_CAPABILITY_FIELDS],
      ["id", "outcome", "invocationTrace", "services"]);
    if (item.id !== requested.id || !["return", "throw", "constructed", "unsupported", "error"].includes(item.outcome)) {
      throw new TypeError("Invalid Node case observation");
    }
    validateInvocationTrace(item.invocationTrace, requested, item.outcome, request.exportName);
    validateServiceCounters(item.services);
    COUNTER_FIELDS.forEach(field => { aggregate[field] += item.services[field]; });
    if (item.outcome === "return") {
      validateValue(item.value, false, new Set(), { typedBytes: true, typedOutputBudget });
      if (Object.hasOwn(item, "errorClass") || Object.hasOwn(item, "reason")) throw new TypeError("Conflicting return observation");
    } else if (item.outcome === "throw") {
      if (!["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Error", "non-error"].includes(item.errorClass)
        || Object.hasOwn(item, "value") || Object.hasOwn(item, "reason")) throw new TypeError("Invalid throw observation");
    } else if (item.outcome === "constructed") {
      if (requested.invocation.kind !== "construct" || Object.hasOwn(item, "value") || Object.hasOwn(item, "errorClass") || Object.hasOwn(item, "reason")) {
        throw new TypeError("Invalid construction observation");
      }
    } else if (typeof item.reason !== "string" || !/^[a-z0-9-]{1,64}$/.test(item.reason)
      || Object.hasOwn(item, "value") || Object.hasOwn(item, "errorClass")) throw new TypeError("Invalid incomplete observation");
    const resourceStop = item.outcome === "error" && ["guest-cpu-budget", "guest-wall-deadline"].includes(item.reason);
    if (resourceStop) {
      shape(item.resources, ["caseCpuMicros", "caseThreadCpuMicros", "caseWallMicros"]);
      if (!Object.values(item.resources).every(value => Number.isSafeInteger(value) && value >= 0)
        || item.reason === "guest-cpu-budget" && item.resources.caseThreadCpuMicros < CASE_THREAD_CPU_MICROS) throw new TypeError("Invalid resource stop observation");
    } else if (Object.hasOwn(item, "resources")) throw new TypeError("Unexpected resource stop observation");
    if (["return", "throw", "constructed"].includes(item.outcome)) {
      const resolved = resolveArguments(requested.args, observations, { nodeProfile: true });
      if (resolved.some(arg => arg === undefined)) throw new TypeError("Unavailable referenced observation");
      const expectedIndexes = resolved.flatMap((arg, argIndex) => arg.type === "date" ? [argIndex] : []);
      if (!Array.isArray(item.dateArgsAfter) || item.dateArgsAfter.length !== expectedIndexes.length
        || !Number.isSafeInteger(item.clockReads) || item.clockReads < 0) throw new TypeError("Missing side-effect observation");
      item.dateArgsAfter.forEach((arg, argIndex) => {
        shape(arg, ["index", "value"]);
        if (arg.index !== expectedIndexes[argIndex]) throw new TypeError("Wrong observed argument");
        validateValue({ type: "number", value: arg.value }, false);
      });
      if (requested.observeArgs) {
        if (!Array.isArray(item.argsAfter) || item.argsAfter.length !== requested.args.length) throw new TypeError("Missing argument snapshots");
        item.argsAfter.forEach(arg => validateValue(arg, true, callbackIds(requested), { typedBytes: true, typedOutputBudget }));
      } else if (Object.hasOwn(item, "argsAfter")) throw new TypeError("Unexpected argument snapshots");
    } else if (Object.hasOwn(item, "dateArgsAfter") || Object.hasOwn(item, "clockReads") || Object.hasOwn(item, "argsAfter")) {
      throw new TypeError("Unexpected side-effect observation");
    }
    validateObservedCapabilities(item, requested, { nodeProfile: true, typedOutputBudget });
    observations.set(item.id, item);
  }
  if (COUNTER_FIELDS.some(field => aggregate[field] !== response.services[field])) throw new TypeError("Conflicting Node service totals");
  const timeouts = ["guest-cpu-budget", "guest-wall-deadline"];
  const errors = response.cases.filter(item => item.outcome === "error");
  if (errors.length > 1 || errors.length && response.cases.at(-1) !== errors[0]) throw new TypeError("Nonterminal worker error");
  if (response.status === "timeout") {
    if (!timeouts.includes(response.timeoutReason) || errors.length && errors[0].reason !== response.timeoutReason
      || response.timeoutReason === "guest-cpu-budget" && errors.length !== 1) throw new TypeError("Invalid timeout cause");
  } else if (Object.hasOwn(response, "timeoutReason") || errors.some(item => timeouts.includes(item.reason))
    || response.status === "completed" && errors.length || response.status === "error" && errors.length !== 1) throw new TypeError("Conflicting worker status");
  return response;
}

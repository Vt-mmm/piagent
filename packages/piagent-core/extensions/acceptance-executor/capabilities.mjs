import { protocolShape as shape, validateValue, MAX_STRING_LENGTH } from "./values.mjs";
import { validateReferencePairs, validateReferenceIdentity } from "./reference-identity.mjs";

export const MAX_CALLBACKS = 8;
export const MAX_CALLBACK_STEPS = 64;
export const MAX_CALLBACK_CALLS = 64;
export const MAX_CALLBACK_DELAY_JOBS = 32;
export const MAX_CALLBACK_TRACE_CHARS = 32768;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,79}$/;
export const ERROR_CLASSES = ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Error"];
export const CASE_CAPABILITY_FIELDS = ["awaitResult", "observeIdentity", "observeError", "callbacks", "errors", "referencePairs"];
export const OBSERVATION_CAPABILITY_FIELDS = ["callbackTrace", "returnIdentity", "errorObservation", "referenceIdentity"];
export const callbackIds = item => new Set((item.callbacks ?? []).map(callback => callback.id));

export function validateCaseCapabilities(item) {
  validateReferencePairs(item);
  for (const key of ["awaitResult", "observeIdentity", "observeError"]) {
    if (Object.hasOwn(item, key) && item[key] !== true) throw new TypeError("Invalid case capability");
  }
  const errors = new Set();
  if (Object.hasOwn(item, "errors")) {
    if (!Array.isArray(item.errors) || item.errors.length < 1 || item.errors.length > 32) throw new TypeError("Invalid error inputs");
    for (const error of item.errors) {
      shape(error, ["id", "errorClass", "message", "properties"], ["id", "errorClass", "message"]);
      if (typeof error.id !== "string" || !ID.test(error.id) || errors.has(error.id) || !ERROR_CLASSES.includes(error.errorClass)
        || typeof error.message !== "string" || error.message.length > MAX_STRING_LENGTH) throw new TypeError("Invalid error input");
      errors.add(error.id);
      if (Object.hasOwn(error, "properties")) {
        validateValue(error.properties);
        if (error.properties.type !== "record") throw new TypeError("Error properties must be a record");
      }
    }
  }
  const callbacks = new Set();
  if (Object.hasOwn(item, "callbacks")) {
    if (!Array.isArray(item.callbacks) || item.callbacks.length < 1 || item.callbacks.length > MAX_CALLBACKS) throw new TypeError("Invalid callbacks");
    for (const callback of item.callbacks) {
      shape(callback, ["id", "mode", "repeatLast", "steps", "settleAfterJobs"], ["id", "mode", "repeatLast", "steps"]);
      if (typeof callback.id !== "string" || !ID.test(callback.id) || callbacks.has(callback.id) || !["sync", "promise"].includes(callback.mode)
        || typeof callback.repeatLast !== "boolean" || !Array.isArray(callback.steps)
        || callback.steps.length < 1 || callback.steps.length > MAX_CALLBACK_STEPS) throw new TypeError("Invalid callback input");
      callbacks.add(callback.id);
      if (Object.hasOwn(callback, "settleAfterJobs") && (callback.mode !== "promise" || !Number.isSafeInteger(callback.settleAfterJobs)
        || callback.settleAfterJobs < 1 || callback.settleAfterJobs > MAX_CALLBACK_DELAY_JOBS)) throw new TypeError("Invalid callback settlement delay");
      for (const step of callback.steps) {
        if (step.outcome === "return") { shape(step, ["outcome", "value"]); validateValue(step.value); }
        else if (step.outcome === "throw") {
          shape(step, ["outcome", "error"]);
          if (!errors.has(step.error)) throw new TypeError("Unknown callback error");
        } else throw new TypeError("Invalid callback outcome");
      }
    }
  }
  return callbacks;
}

export function validateCallbackTrace(trace, item) {
  if (!item.callbacks || !Array.isArray(trace) || trace.length > MAX_CALLBACK_CALLS * 2
    || JSON.stringify(trace).length > MAX_CALLBACK_TRACE_CHARS) throw new TypeError("Invalid callback trace");
  const ids = callbackIds(item);
  const calls = new Map(), settled = new Set();
  let total = 0;
  for (const call of trace) {
    if (call?.event === "call") {
      shape(call, ["callback", "call", "event", "args"]);
      if (!ids.has(call.callback) || call.call !== (calls.get(call.callback) ?? 0) || ++total > MAX_CALLBACK_CALLS
        || !Array.isArray(call.args) || call.args.length > 16) throw new TypeError("Invalid callback call");
      for (const value of call.args) validateValue(value, true, ids);
      calls.set(call.callback, call.call + 1);
    } else {
      shape(call, ["callback", "call", "event", "outcome"]);
      const callback = item.callbacks.find(value => value.id === call.callback), key = JSON.stringify([call.callback, call.call]);
      if (call.event !== "settle" || callback?.mode !== "promise" || !Number.isSafeInteger(call.call) || call.call < 0
        || call.call >= (calls.get(call.callback) ?? 0) || settled.has(key)
        || !["return", "throw"].includes(call.outcome)) throw new TypeError("Invalid callback settlement");
      const step = callback.steps[Math.min(call.call, callback.steps.length - 1)];
      if ((!callback.repeatLast && call.call >= callback.steps.length) || call.outcome !== step.outcome) throw new TypeError("Conflicting callback settlement");
      settled.add(key);
    }
  }
  for (const callback of item.callbacks.filter(value => value.mode === "promise")) {
    for (let index = 0; index < (calls.get(callback.id) ?? 0); index += 1) {
      if (!settled.has(JSON.stringify([callback.id, index]))) throw new TypeError("Missing callback settlement");
    }
  }
}

export function validateReturnIdentity(value, item) {
  if (!item.observeIdentity || !Array.isArray(value) || value.length > item.args.length) throw new TypeError("Invalid return identity");
  let previous = -1;
  for (const index of value) {
    if (!Number.isSafeInteger(index) || index <= previous || index >= item.args.length
      || !["array", "record", "date", "result", "error-property"].includes(item.args[index].type)) throw new TypeError("Invalid identity argument");
    previous = index;
  }
}

export function validateErrorObservation(value, item) {
  shape(value, ["identity", "properties"]);
  if (!item.observeError || value.identity !== null && !(item.errors ?? []).some(error => error.id === value.identity)) {
    throw new TypeError("Invalid error identity");
  }
  validateValue(value.properties, true, callbackIds(item));
  if (value.properties.type !== "record") throw new TypeError("Invalid observed error properties");
}

export function validateObservedCapabilities(observation, item) {
  const settled = ["return", "throw"].includes(observation.outcome);
  for (const [field, required, validate] of [
    ["callbackTrace", settled && Boolean(item.callbacks), validateCallbackTrace],
    ["returnIdentity", observation.outcome === "return" && item.observeIdentity, validateReturnIdentity],
    ["errorObservation", observation.outcome === "throw" && item.observeError, validateErrorObservation],
    ["referenceIdentity", settled && Boolean(item.referencePairs), validateReferenceIdentity]
  ]) {
    if (required) validate(observation[field], item);
    else if (Object.hasOwn(observation, field)) throw new TypeError("Unexpected capability observation");
  }
}

import { MAX_CALLBACK_CALLS, MAX_CALLBACK_TRACE_CHARS } from "./capabilities.mjs";

// Spliced only into the worker-owned pre-candidate closure. No host callback,
// expected answer, dynamic code template or globally reachable registry.
export const CALLBACK_INTRINSICS = `
  const WM = WeakMap, wmGet = WM.prototype.get, wmSet = WM.prototype.set;
  const slice = String.prototype.slice, CallbackError = TypeError;
  const NativePromise = Promise, promiseResolve = NativePromise.resolve;
  const errorConstructors = [TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, Error];
  let callbacks = create(null), errorValues = create(null), callbackReferences = new WM();
  let generation = 0, callbackFault = null, trace = '', calls = 0;
  const callbackId = value => value !== null && (typeof value === 'object' || typeof value === 'function')
    ? apply(wmGet, callbackReferences, [value]) : undefined;
  function fault(reason) { callbackFault ??= reason; throw new CallbackError('callback observation unavailable'); }
  function callbackValueText(value) {
    const encoded = observeValue(value, true, true);
    if (apply(slice, encoded, [0, 9]) !== '{"value":') fault('callback-argument-unsupported');
    return apply(slice, encoded, [9, -1]);
  }
  function beginCapabilities() {
    generation += 1; callbacks = create(null); errorValues = create(null); callbackReferences = new WM();
    callbackFault = null; trace = ''; calls = 0;
  }
  function appendTrace(entry) {
    if (trace.length + entry.length + (trace ? 1 : 0) + 2 > ${MAX_CALLBACK_TRACE_CHARS}) fault('callback-trace-limit');
    trace += (trace ? ',' : '') + entry;
  }
  function inertPromiseResponse(value) {
    if (value === null || typeof value !== 'object') return;
    let current = value, depth = 0;
    while (current !== null) {
      if (++depth > 32 || apply(has, proxies, [current])) fault('callback-response-unsupported');
      const property = descriptor(current, 'then');
      if (property) {
        if (!own(property, 'value') || typeof property.value === 'function') fault('callback-response-unsupported');
        return;
      }
      current = prototype(current);
    }
  }
  async function settleCallback(id, call, outcome, value, delay, epoch) {
    for (let i = 0; i < delay; i += 1) await undefined;
    if (epoch !== generation) fault('stale-callback-invocation');
    // No yield occurs between this inertness check and resolution. Otherwise a
    // candidate-installed thenable could make a "settle" event premature.
    if (outcome === 'return') inertPromiseResponse(value);
    appendTrace('{"callback":' + stringify(id) + ',"call":' + call + ',"event":"settle","outcome":' + stringify(outcome) + '}');
    if (outcome === 'throw') throw value;
    return value;
  }
  function makeError(id, errorClass, message, properties) {
    let Constructor;
    for (let i = 0; i < names.length; i += 1) if (names[i] === errorClass) Constructor = errorConstructors[i];
    if (!Constructor) fault('callback-error-class-unsupported');
    const value = new Constructor(message), keys = ownKeys(properties);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i], property = descriptor(properties, key);
      if (!property || !own(property, 'value')) fault('callback-error-properties-unsupported');
      define(value, key, dataDescriptor(property.value, true));
    }
    errorValues[id] = value; return value;
  }
  function makeCallback(id, mode, repeatLast, steps, delay) {
    const epoch = generation; let index = 0;
    const fn = (...args) => {
      if (epoch !== generation) fault('stale-callback-invocation');
      if (calls >= ${MAX_CALLBACK_CALLS}) fault('callback-trace-limit');
      if (args.length > 16) fault('callback-argument-limit');
      const call = index;
      let entry = '{"callback":' + stringify(id) + ',"call":' + call + ',"event":"call","args":[';
      for (let i = 0; i < args.length; i += 1) entry += (i ? ',' : '') + callbackValueText(args[i]);
      entry += ']}';
      appendTrace(entry); calls += 1;
      if (index >= steps.length && !repeatLast) fault('callback-plan-exhausted');
      const step = steps[index < steps.length ? index : steps.length - 1]; index += 1;
      const value = step.outcome === 'throw' ? errorValues[step.error] : step.value;
      if (mode === 'promise') return settleCallback(id, call, step.outcome, value, delay, epoch);
      if (step.outcome === 'throw') throw value;
      return value;
    };
    callbacks[id] = fn; apply(wmSet, callbackReferences, [fn, id]); return fn;
  }
  function errorObservation(value) {
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && apply(has, proxies, [value])) {
      return '{"reason":"error-object-unsupported"}';
    }
    let identity = null;
    const ids = ownKeys(errorValues);
    for (let i = 0; i < ids.length; i += 1) if (same(value, errorValues[ids[i]])) identity = ids[i];
    const properties = create(null);
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      const keys = ownKeys(value);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i], property = descriptor(value, key);
        if (!property?.enumerable) continue;
        if (typeof key !== 'string' || !own(property, 'value')) return '{"reason":"error-properties-unsupported"}';
        define(properties, key, dataDescriptor(property.value, true));
      }
    }
    const encoded = observeValue(properties, true, true);
    if (apply(slice, encoded, [0, 9]) !== '{"value":') return '{"reason":"error-properties-unsupported"}';
    return '{"identity":' + (identity === null ? 'null' : stringify(identity)) + ',"properties":' + apply(slice, encoded, [9, -1]) + '}';
  }
`;

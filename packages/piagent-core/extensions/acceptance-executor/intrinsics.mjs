import { MAX_COLLECTION_LENGTH, MAX_STRING_LENGTH, MAX_VALUE_DEPTH, MAX_VALUE_NODES, MAX_VALUE_TEXT } from "./values.mjs";

// This closure is evaluated before the candidate. Only the worker retains its
// handle; it installs no host callback, oracle, serializer or receipt writer.
export const INTRINSICS = `(() => {
  const D = Date, apply = Reflect.apply, isPrototypeOf = Object.prototype.isPrototypeOf;
  const getTime = D.prototype.getTime, originalNow = D.now, define = Object.defineProperty, create = Object.create;
  const ownKeys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor, own = Object.hasOwn;
  const prototype = Object.getPrototypeOf, objectPrototype = Object.prototype, isArray = Array.isArray;
  const stringify = JSON.stringify, finite = Number.isFinite, same = Object.is, numberString = Number.prototype.toString;
  const WS = WeakSet, add = WS.prototype.add, has = WS.prototype.has, remove = WS.prototype.delete;
  const dataDescriptor = (value, enumerable) => {
    const result = create(null); result.value = value; result.writable = true;
    result.enumerable = enumerable; result.configurable = true; return result;
  };
  const proxies = new WS(), P = Proxy, revoke = P.revocable, construct = Reflect.construct;
  // Proxies may execute normally, but cannot masquerade as inert output data.
  const track = p => { apply(add, proxies, [p]); return p; };
  // A candidate may change Object.prototype; handler trap lookup must never
  // inherit those properties and expose the underlying untracked factory.
  const revocableHandler = create(null), constructorHandler = create(null);
  revocableHandler.apply = (target, receiver, args) => {
    const result = apply(target, receiver, args); track(result.proxy); return result;
  };
  constructorHandler.construct = (target, args, newTarget) => track(construct(target, args, newTarget));
  define(P, 'revocable', dataDescriptor(new P(revoke, revocableHandler), false));
  globalThis.Proxy = new P(P, constructorHandler);
  const internalError = InternalError.prototype;
  const prototypes = [TypeError.prototype, RangeError.prototype, SyntaxError.prototype,
    ReferenceError.prototype, EvalError.prototype, URIError.prototype, Error.prototype];
  const names = ['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'Error'];
  let reads = 0, clockEnabled = false, clockValue = 0;
  // A module may capture Date.now once. Keep that callable live across the
  // complete history, including transitions back to the real clock.
  const observedNow = () => {
    if (!clockEnabled) return apply(originalNow, D, []);
    reads += 1; return clockValue;
  };
  const numeric = value => same(value, -0) ? '"-0"' : finite(value) ? apply(numberString, value, [])
    : value !== value ? '"NaN"' : value < 0 ? '"-Infinity"' : '"Infinity"';
  function observeValue(root, allowDate) {
    let nodes = 0, text = 0;
    const active = new WS();
    function quote(value) {
      text += value.length;
      if (value.length > ${MAX_STRING_LENGTH} || text > ${MAX_VALUE_TEXT}) throw 'value-observation-limit';
      return stringify(value);
    }
    function visit(value, depth) {
      if (++nodes > ${MAX_VALUE_NODES} || depth > ${MAX_VALUE_DEPTH}) throw 'value-observation-limit';
      if (value === null) return '{"type":"null"}';
      const type = typeof value;
      if (type === 'undefined') return '{"type":"undefined"}';
      if (type === 'boolean') return '{"type":"boolean","value":' + (value ? 'true' : 'false') + '}';
      if (type === 'number') return '{"type":"number","value":' + numeric(value) + '}';
      if (type === 'string') return '{"type":"string","value":' + quote(value) + '}';
      if (type !== 'object' || apply(has, proxies, [value])) throw 'return-type-unsupported';
      let timestamp, date = false;
      try { timestamp = apply(getTime, value, []); date = true; } catch {}
      if (date) {
        if (!allowDate) throw 'return-type-unsupported';
        return '{"type":"date","value":' + numeric(timestamp) + '}';
      }
      if (apply(has, active, [value])) throw 'structured-value-unsupported';
      const array = isArray(value), proto = prototype(value);
      if (!array && proto !== objectPrototype && proto !== null) throw 'return-type-unsupported';
      const keys = ownKeys(value);
      let count = keys.length;
      if (array) {
        const length = descriptor(value, 'length').value;
        if (length > ${MAX_COLLECTION_LENGTH} || keys.length !== length + 1) throw 'structured-value-unsupported';
        count = length;
      } else if (count > ${MAX_COLLECTION_LENGTH}) throw 'value-observation-limit';
      apply(add, active, [value]);
      let output = '{"type":"' + (array ? 'array' : 'record') + '","value":[';
      for (let index = 0; index < count; index += 1) {
        const key = array ? apply(numberString, index, []) : keys[index];
        if (typeof key !== 'string') throw 'structured-value-unsupported';
        const property = descriptor(value, key);
        if (!property || !own(property, 'value') || !property.enumerable) throw 'structured-value-unsupported';
        if (index) output += ',';
        output += array ? visit(property.value, depth + 1)
          : '{"key":' + quote(key) + ',"value":' + visit(property.value, depth + 1) + '}';
      }
      apply(remove, active, [value]);
      return output + ']}';
    }
    try { return '{"value":' + visit(root, 0) + '}'; }
    catch (reason) {
      const code = reason === 'value-observation-limit' ? reason
        : reason === 'structured-value-unsupported' ? reason : 'return-type-unsupported';
      return '{"reason":' + stringify(code) + '}';
    }
  }
  return {
    makeDate: value => new D(value), dateTime: value => apply(getTime, value, []),
    defineData: (object, key, value) => { define(object, key, dataDescriptor(value, true)); },
    typeOf: value => typeof value, observeValue, clockReads: () => reads,
    beginCall: (mock, value) => {
      reads = 0; clockEnabled = mock; clockValue = value;
      define(D, 'now', dataDescriptor(observedNow, false));
    },
    errorClass: value => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return 'non-error';
      if (apply(isPrototypeOf, internalError, [value])) return 'InternalError';
      for (let i = 0; i < prototypes.length; i += 1) if (apply(isPrototypeOf, prototypes[i], [value])) return names[i];
      return 'non-error';
    }
  };
})()`;

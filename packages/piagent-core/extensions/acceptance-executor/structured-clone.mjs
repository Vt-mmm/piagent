import { MAX_COLLECTION_LENGTH, MAX_STRING_LENGTH, MAX_VALUE_DEPTH, MAX_VALUE_NODES, MAX_VALUE_TEXT } from "./values.mjs";

// Node-profile support for inert records, arrays, primitives and Dates only.
// The closure shares the worker's private Proxy registry and captured intrinsics.
// Unsupported data latches for the realm, even if candidate code catches it.
export const STRUCTURED_CLONE_INTRINSICS = `
  const CloneMap = WeakMap, cloneGet = CloneMap.prototype.get, cloneSet = CloneMap.prototype.set;
  const cloneHas = CloneMap.prototype.has, CloneError = Error;
  let cloneFailure = null;
  const denyClone = reason => { cloneFailure ??= reason; throw new CloneError(reason); };
  function installStructuredClone() {
    define(globalThis, 'structuredClone', dataDescriptor(function structuredClone(value, options) {
      if (options !== undefined) return denyClone('structured-clone-options-unsupported');
      const seen = new CloneMap(); let nodes = 0, text = 0;
      const boundedText = value => {
        text += value.length;
        if (value.length > ${MAX_STRING_LENGTH} || text > ${MAX_VALUE_TEXT}) denyClone('structured-clone-limit');
      };
      function copy(value, depth) {
        if (++nodes > ${MAX_VALUE_NODES} || depth > ${MAX_VALUE_DEPTH}) return denyClone('structured-clone-limit');
        const type = typeof value;
        if (value === null || type === 'undefined' || type === 'boolean' || type === 'number' || type === 'bigint') return value;
        if (type === 'string') { boundedText(value); return value; }
        if (type !== 'object' || apply(has, proxies, [value])) return denyClone('structured-clone-type-unsupported');
        if (apply(cloneHas, seen, [value])) return apply(cloneGet, seen, [value]);
        let timestamp, date = false;
        try { timestamp = apply(getTime, value, []); date = true; } catch {}
        if (date) { const out = new D(timestamp); apply(cloneSet, seen, [value, out]); return out; }
        const array = isArray(value), proto = prototype(value);
        if (!array && proto !== objectPrototype && proto !== null) return denyClone('structured-clone-type-unsupported');
        const keys = ownKeys(value);
        if (keys.length > ${MAX_COLLECTION_LENGTH} + (array ? 1 : 0)) return denyClone('structured-clone-limit');
        const out = array ? [] : {};
        if (array) {
          const length = descriptor(value, 'length').value;
          if (length > ${MAX_COLLECTION_LENGTH}) return denyClone('structured-clone-limit');
          const lengthDescriptor = create(null); lengthDescriptor.value = length; define(out, 'length', lengthDescriptor);
        }
        apply(cloneSet, seen, [value, out]);
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          if (typeof key !== 'string') continue;
          const property = descriptor(value, key);
          if (!property || !property.enumerable) continue;
          if (!own(property, 'value')) return denyClone('structured-clone-accessor-unsupported');
          boundedText(key); define(out, key, dataDescriptor(copy(property.value, depth + 1), true));
        }
        return out;
      }
      return copy(value, 0);
    }, false));
  }
`;

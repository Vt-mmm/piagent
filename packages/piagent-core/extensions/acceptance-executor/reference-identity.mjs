import { protocolShape as shape } from "./values.mjs";

export function validateReferencePairs(item) {
  if (!Object.hasOwn(item, "referencePairs")) return;
  if (!Array.isArray(item.referencePairs) || item.referencePairs.length < 1 || item.referencePairs.length > 16) throw new TypeError("Invalid reference pairs");
  const ids = new Set();
  for (const pair of item.referencePairs) {
    shape(pair, ["id", "left", "right"]);
    if (typeof pair.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,79}$/.test(pair.id) || ids.has(pair.id)) throw new TypeError("Invalid reference pair id");
    ids.add(pair.id);
    for (const selector of [pair.left, pair.right]) {
      shape(selector, ["root", "index", "path"], ["root", "path"]);
      if (!["argument", "return", "error"].includes(selector.root) || !Array.isArray(selector.path) || selector.path.length > 8
        || selector.path.some(key => typeof key !== "string" || key.length > 128)) throw new TypeError("Invalid reference selector");
      if (selector.root === "argument") {
        if (!Number.isSafeInteger(selector.index) || selector.index < 0 || selector.index >= item.args.length) throw new TypeError("Invalid reference argument");
      } else if (Object.hasOwn(selector, "index") || selector.root === "error" && !item.observeError) throw new TypeError("Unobserved reference root");
    }
  }
}

export function validateReferenceIdentity(values, item) {
  if (!item.referencePairs || !Array.isArray(values) || values.length !== item.referencePairs.length) throw new TypeError("Incomplete reference identities");
  values.forEach((value, index) => {
    shape(value, ["id", "same"]);
    if (value.id !== item.referencePairs[index].id || typeof value.same !== "boolean") throw new TypeError("Invalid reference identity");
  });
}

// Included only in the private pre-candidate intrinsics closure. No property
// lookup can invoke candidate getters, inherited fields or proxy traps.
export const REFERENCE_INTRINSICS = `
  function referenceAt(value, path) {
    for (let i = 0; i < path.length; i += 1) {
      if (value === null || typeof value !== 'object') return undefined;
      if (apply(has, proxies, [value])) throw 'reference-path-unsupported';
      const property = descriptor(value, path[i]);
      if (!property) return undefined;
      if (!own(property, 'value')) throw 'reference-path-unsupported';
      value = property.value;
    }
    if (value !== null && typeof value === 'object' && apply(has, proxies, [value])) throw 'reference-path-unsupported';
    return value;
  }
  function referenceIdentity(left, leftPath, right, rightPath) {
    try {
      const a = referenceAt(left, leftPath), b = referenceAt(right, rightPath);
      return a !== null && typeof a === 'object' && same(a, b) ? '{"same":true}' : '{"same":false}';
    } catch { return '{"reason":"reference-path-unsupported"}'; }
  }
`;

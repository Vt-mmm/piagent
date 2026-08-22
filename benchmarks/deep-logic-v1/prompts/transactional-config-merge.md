Implement `planConfigTransaction(base, layers, schema)` in `src/config-transaction.js`.

`base` and each layer are plain JSON objects. `schema` maps allowed top-level keys to `{ type, required?, default? }`, where type is `string`, `number`, `boolean`, `object`, or `array`. In layers, `{ "$delete": true }` is the only deletion marker.

Requirements:

- Never mutate inputs. Reject prototypes other than `Object.prototype`/`null`, unknown keys, non-JSON values, unsafe keys (`__proto__`, `prototype`, `constructor`), invalid deletion markers, and type mismatches.
- Merge layers in order. Plain objects merge recursively; arrays and scalars replace whole values. A deletion marker removes the key. Defaults are applied only after merging and only when the key is absent. Required keys must then exist.
- Return `{ next, changes, digest }`. `changes` is a lexicographically path-sorted list of `{ path, before, after, kind }`, where kind is `add`, `replace`, or `delete`; use JSON Pointer escaping for path segments.
- `digest` is lowercase SHA-256 of canonical JSON for `next`, with object keys recursively sorted and array order preserved.
- The operation is transactional: any validation failure throws and yields no partial object.

Use Node's standard library only. Add focused tests if useful.

Run `npm test` when complete; it includes a fixed public happy-path contract for this scenario.

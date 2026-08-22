Implement `decideAccess(request, layers)` in `src/policy.js`.

`request` is `{ path, operation }`. `layers` is ordered from least to most authoritative; each is `{ name, rules }`. A rule is `{ pattern, operations, effect, protected? }`, where effect is `allow` or `deny`, and operations is a non-empty array of exact operation names or `*`.

Semantics:

- Accept only POSIX project-relative paths. Invalid requests, layers, rules, operations, and paths must throw before returning a decision. Unsafe paths include absolute paths, empty segments, `.`, `..`, backslashes, NUL, and paths outside the project.
- Support glob segments `*` (one segment) and `**` (zero or more segments). A literal segment may contain only ASCII letters, digits, `.`, `_`, and `-`; reject embedded `*` and other glob syntax such as `[a]`, `?`, or `{a,b}`.
- Within one layer, the last matching rule wins. A match in a more authoritative layer wins over a lower layer.
- A matching `protected: true` deny is permanent and cannot be overridden by any later allow.
- If nothing matches, deny. Invalid layers/rules fail closed by throwing.
- Return `{ allowed, effect, layer, ruleIndex, protected, reason }` without exposing or changing inputs.

Keep matching deterministic and do not use shell or filesystem glob expansion.

Run `npm test` when complete; it includes a fixed public happy-path contract for this scenario.

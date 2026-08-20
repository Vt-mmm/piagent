Resolve the control-plane correctness issue across
`packages/session/src/runtime-route.js`, `packages/session/src/admission.js`, and
`apps/web/src/control-view.js`. The browser must express exactly the same
bounded commands as Terminal while preserving durable revision and replay
semantics.

- [D1] `routeRuntimeCommand(input)` accepts only a non-null, non-array command
  object whose fields are drawn from `idempotencyKey`, `expectedRevision`,
  `kind`, `payload`, and `confirmed`. Supported kinds are `status`, `scout`,
  `compact`, and `abort`. `payload` is always a non-null, non-array object.
  `status`, `compact`, and `abort` require an empty payload. `scout` requires
  exactly one string `objective` containing at least one non-whitespace
  character, trimmed with internal whitespace collapsed. Any unknown kind,
  field, payload field, or invalid value throws `TypeError`.
- [D2] Routing returns exactly `{ terminalCommand, confirmationRequired,
  expectedModelCalls, effect }`. Routes are: `status` → `/status`, no
  confirmation, `0`, `read`; `scout` → `/scout <normalized objective>`,
  confirmation, `bounded`, `model`; `compact` → `/compact`, confirmation,
  `bounded`, `semantic`; `abort` → `/abort`, confirmation, `0`, `state`.
  `admitRuntimeCommand` must reject every confirmation-required command unless
  `confirmed === true`.
- [D3] State is `{ revision, receipts }`, where revision is a non-negative safe
  integer and receipts is an object. A new command requires an exact
  non-negative safe `expectedRevision`. The idempotency key must be a string
  containing at least one non-whitespace character, and the poison names
  `__proto__`, `prototype`, and `constructor` are invalid.
  Check a prior idempotency receipt before revision matching: an identical
  replay succeeds even with a stale expected revision, returns the identical
  state object, and marks only the returned receipt `replayed: true`. Reusing a
  key for a different command throws `TypeError`.
- [D4] Export `runtimeCommandDigest(input)` from `admission.js`. It accepts
  exactly `{ kind, payload }` and returns a SHA-256 digest of recursively
  key-sorted canonical JSON. Canonicalization must reject non-finite or
  non-JSON values. Equivalent object-key ordering must produce the same digest.
  Admission binds idempotency to this digest for only the routed command's
  `{ kind, payload }`.
- [D5] A newly admitted command increments revision exactly once and returns
  `{ state, receipt }`. The stored receipt contains exactly `idempotencyKey`,
  `commandDigest`, `kind`, `terminalCommand`, `effect`, `expectedModelCalls`,
  `revisionBefore`, `revisionAfter`, and `replayed: false`. Do not mutate caller
  state/input, and do not share the separately returned receipt object with the
  stored receipt.
- [D6] `controlSummary(receipt)` rejects non-objects and returns exactly
  `kind=<kind>; command=<JSON string>; revision=<before>-><after>; effect=<effect>; model=<0|bounded>; replayed=<true|false>`.

Preserve exports and add focused integration tests. Change only the declared
source/test scope.

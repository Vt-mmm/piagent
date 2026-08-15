---
plan_id: piagent-webui
decision_id: WUI5-08
title: Durable owner lease and lazy Pi runtime supervisor
status: accepted
date: 2026-08-14
---

# WUI5-08 — Durable owner lease and lazy Pi runtime supervisor

## Decision

The Gateway now has an owner-only, per-session lease store and a bounded lazy
runtime supervisor. Opening an existing durable Pi session follows this order:

1. resolve the opaque `sessionRef` against the current canonical Pi catalog;
2. fsync an HMAC-chained `acquired` lease with fresh owner and runtime epochs;
3. open the exact Pi JSONL through the pinned public Pi SDK;
4. load and bind the Piagent Guard extension stack in RPC mode;
5. expose `gateway-owned/exact` only when the in-memory runtime and durable lease
   still match;
6. dispose the runtime before appending the durable `released` receipt.

No browser mutation is enabled by this work item. Acquire/release/create/send
remain unavailable until WUI5-09 provides schema-valid durable command
admission and idempotent receipts at the hostile-browser boundary.

## Fail-closed recovery

- An acquired lease without the exact live runtime projects
  `recovery-required`; a new Gateway never steals it.
- A corrupt, forged, oversized, symlinked or broken lease chain projects
  `session-lease-unavailable` and cannot open the session.
- Runtime creation or Guard binding failure appends `recovery-required` rather
  than rolling back ownership as if no Pi-side effect were possible.
- Runtime disposal failure also appends `recovery-required`; release is not
  fabricated.
- Concurrent opens for one `sessionRef` share one admission promise. The first
  release is exact and further releases are no-op only after durable release.
- The supervisor allows at most ten warm runtimes. Provider-turn concurrency is
  still disabled until WUI5-09.

## Persistence and privacy

Lease records live under the owner-only Gateway state root in
`leases/<keyed-ref>.jsonl`. Files are `0600`, directories are `0700`, records are
bounded and HMAC chained, and raw Pi session paths never enter the lease or
browser projection. Catalog ownership is derived from lease plus live runtime,
not from process narrative or PID alone.

## Executed evidence

The focused suite proves:

- exact acquire/conflict/release and owner-only modes;
- corruption fails closed;
- concurrent acquisition constructs one runtime;
- a second Gateway sees stale ownership as recovery-only;
- open and dispose failures retain uncertainty;
- the catalog remains schema-valid and contains no raw session path;
- a real persisted Pi `0.84.1` session opens through
  `createAgentSessionServices`, `createAgentSessionFromServices`,
  `createAgentSessionRuntime`, and the production Guard stack;
- acquire/resume/release causes zero provider turns.

WUI5-09 must add a durable admission/receipt journal before advertising any
session action to the browser.

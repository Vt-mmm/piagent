# Harness Next durable evidence checkpoint — 2026-08-30

Status: implemented and tested as a host-only development lane. Not released; production completion admission remains unwired.

## Durable, authenticated observations

`acceptance-evidence-store.js` provides a bounded SQLite event store outside the candidate project. The host explicitly supplies a 256-bit secret KeyObject. The store never generates, exports, logs, or persists that key. Production key provisioning and retention are still an integration requirement; this checkpoint created no production authority key.

Each event is authenticated with HMAC-SHA-256, domain-separated by store version, canonical database path, and canonical project identity. Events bind their sequence, preceding signature, store identity, stable task/criterion scope, attempt number, fixed attempt ceiling, and these current identities:

- Task criterion hash.
- Closed-module source/HEAD snapshot digest.
- Host verifier implementation digest.
- Current project-verification digest.
- Host-owned independent check plan digest.
- Pinned backend/configuration digest.

The API appends reservation and terminal events transactionally. A reservation is persisted before worker launch. Only the originating store handle's live one-shot capability can settle it. Copies, serialized reservation JSON, another handle, wrong keys, cross-project copies, and tampered or gapped histories are rejected. Reads return detached frozen data, not a completion capability.

There is one latest state per stable task/criterion scope. Old passing evidence cannot be selected instead of a newer failure. Changed bindings reserve a new attempt; an explicit retry also consumes an attempt. The caller chooses a finite ceiling of one to eight attempts before the first reservation and cannot change it within that scope. This independent-verifier ceiling does not increase model continuation or benchmark spend limits.

## Interruption behavior

A pending reservation is never interpreted as success or automatically relaunched. Restarting the host does not reset its attempt number. Recording an interruption requires host confirmation that the exact executor has stopped; elapsed time alone is not sufficient. Retrying an interrupted attempt is explicit and consumes the existing ceiling. There is no age-based lock stealing.

The reservation's fresh UUID is also the isolated worker's run identity. A restarted host can therefore inspect that specific worker rather than guess from a broad process/container scan. A colliding existing worker is rejected without starting or deleting it. Automated startup reconciliation still needs runtime integration; the test exercises explicit reconciliation of a known owned worker.

SQLite uses rollback-journal transactions, `synchronous=FULL`, and a bounded busy timeout. New database creation also synchronizes its parent directory. Tests kill a host with an uncommitted transaction and verify rollback while preserving the already committed reservation. This is process-crash testing, not a claim of universal power-loss durability. Filesystem, SQLite, and host storage guarantees still apply. See [SQLite atomic commit](https://sqlite.org/atomiccommit.html).

## Actual execution and reuse

`acceptance-durable-execution.js` connects the approved host plan, source capture, isolated execution, current project-verification callback, and evidence store. It detaches the plan before execution and validates current bindings before reservation, after execution, and before cache reuse. It does not accept a receipt supplied by the model or candidate. Expected outputs still stay on the host.

Only the current authenticated event can be reused. Backend errors are settled, not silently retried. Source/HEAD or project-verifier drift yields unknown, even if the captured old source passed. Concurrent calls share one reservation. Every returned diagnostic explicitly has `completionAllowed: false`; a finite tested pass is not yet runtime completion authority.

The assessment kernel now accepts canonical `counterexampleRef: null` for non-failed checks, allowing an authenticated observation to roundtrip through storage. A failed check still requires a real counterexample hash. Serialized receipts remain untrusted by the live capability kernel; only a future authenticated host admission step may create a fresh live receipt.

## Verification and limits

- Store plus assessment tests passed 29/29 on the host Node 24.11.1 and independently on the minimum supported Node 22.19.0 inside the pinned local image.
- Actual isolated runner plus durable execution tests passed 21/21, with no skips. They include retained run identity, reopen/reuse, a changed clean commit producing a captured counterexample, project-verifier drift, concurrent reservation, and host death during an actual running isolated worker.
- The complete acceptance suite passed 180/180 with zero skips/failures, including actual container execution and the retained 194-case expiry replay. Typecheck passed; architecture passed for 522 source files; whitespace validation passed. Full offline release verification has not yet run for this checkpoint.
- The real host-death test verified that the worker terminates independently, the reservation stays pending, restart does not create a duplicate, and exact owned-worker cleanup plus explicit interruption recording does not refund the attempt.
- SQLite is built into the minimum runtime but its Node API is still marked experimental. No new host dependency was installed, and worker image bytes did not change. See [Node 22.19 SQLite documentation](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html).

The trust boundary is deliberately limited: the isolated guest has no key, database mount, or receipt API. The database parent and host verifier are trusted. POSIX private-file checks are not a sandbox against arbitrary authorized same-UID code. HMAC authentication cannot detect rollback of the entire host-owned database to an earlier valid copy without an independent trusted monotonic anchor. There is no arbitrary receipt import, relocation, or automatic missing-key replacement.

Remaining work: production host-key provisioning, installed verifier fingerprints, approved contract selection, an actually observed and source/HEAD-bound project-verifier callback, authenticated assessment admission, automatic interruption reconciliation, shared completion/recovery/UI wiring, broader contract domains and held-out calibration, full offline release gates, and a new frozen benchmark campaign. These tests are not a completed release or benchmark result. Closed v5/v6 lineages and the user's main workspace remain unchanged.

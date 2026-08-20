Implement `reconcileSession(snapshot, events)` in `src/event-reconcile.js`.

The snapshot is `{ revision, nextSequence, state }`. Each event is `{ id, sequence, baseRevision, revision, patch }`; `patch` is a plain object and a `null` value deletes that top-level key.

Requirements:

- Do not mutate any input.
- Accept events in any order. Exact duplicate IDs with identical event content count once; the same ID with different content is an error.
- Apply only the contiguous sequence beginning at `snapshot.nextSequence`. Stop before the first gap and return all later unique events in `pending`, ordered by sequence then original arrival order.
- At a sequence, two non-identical events are a conflict and must throw. Before applying an event, its `baseRevision` must exactly equal the current revision; otherwise throw without returning a partial result.
- Return `{ revision, nextSequence, state, appliedIds, duplicateIds, pending, gap }`. `gap` is `null` or `{ expected, observed }`.
- Reject malformed objects, unsafe sequence numbers, non-string IDs/revisions, arrays as patches, and prototype-pollution keys (`__proto__`, `prototype`, `constructor`). Fail closed.

Add focused tests if useful. Keep the implementation dependency-free and deterministic.

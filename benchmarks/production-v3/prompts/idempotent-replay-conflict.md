Fix `src/data/versioned-replay.js` without changing
`replayVersionedEvents(initial, events)`.

Return a new state and never mutate either input. Each event has a unique
non-empty string `eventId`, a non-empty string `entityId`, an integer
`expectedVersion`, and `nextValue`.
Previously applied event ids and duplicates within the replay are idempotent
no-ops. A missing entity has version zero; an accepted event must match the
current version and advances it by exactly one. Any non-duplicate version
conflict must throw an error containing `version conflict` without partially
mutating the supplied state. Preserve applied-event order and reject malformed
state or event shapes, including empty IDs, with `TypeError`. Run the
configured verification.

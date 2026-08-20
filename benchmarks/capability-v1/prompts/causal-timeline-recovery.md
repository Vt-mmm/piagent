Resolve the crash/reconnect timeline issue across
`packages/timeline/src/project.js`, `packages/timeline/src/checkpoint.js`, and
`apps/web/src/timeline-view.js`. The projection must remain deterministic when
events arrive out of order, repeat after reconnect, or stop at a capacity
boundary.

- [C1] `normalizeTimelineSnapshot(snapshot)` validates and returns a deep fresh
  `{ cursor, messages, seen }`. Cursor is a non-negative safe integer; messages
  have unique string ids containing at least one non-whitespace character,
  string text, and boolean `complete`; `seen` is an object mapping event ids
  containing at least one non-whitespace character to lowercase SHA-256 hex digests.
  `projectTimeline(snapshot, events, { maxChars })` requires an event array and
  a non-negative safe integer budget. Event `id` and `messageId` must be strings
  containing at least one non-whitespace character; events also require a
  positive safe `cursor`, non-negative safe `offset`, string text, and boolean
  `complete`. Invalid input throws `TypeError` before returning.
- [C2] Event identity is SHA-256 over JSON with fields in this exact order:
  `id`, `cursor`, `messageId`, `offset`, `text`, `complete`. Identical duplicate
  ids are replay evidence; the same id with different content or different
  events at one cursor throw `TypeError`. A historical event
  (`cursor <= snapshot.cursor`) is accepted only when `seen[id]` equals its
  digest; otherwise throw. Report replay ids once in first-observed order.
- [C3] Sort unique future events by cursor and apply only a contiguous prefix
  beginning at `snapshot.cursor + 1`. At the first gap, stop without applying
  later events, set `{ expected, observed }`, and buffer that event plus the
  remainder. Create a new message on first use, preserve message order, require
  `offset === current text length`, and reject appends to a complete message.
- [C4] `maxChars` limits total text across all projected messages. Equality is
  allowed. Before the first event that would exceed it, stop atomically, leave
  cursor/message/seen unchanged for that event, buffer it and the remainder,
  and return `{ eventId, cursor, neededChars, maxChars }` as `backpressure`.
  Return fresh `messages`, `seen`, `appliedIds`, `replayedIds`, and `buffered`
  plus nullable `gap` and `backpressure`; never mutate inputs.
- [C5] `encodeTimelineCheckpoint(state)` revalidates the core snapshot and
  returns JSON containing `{ schemaVersion: 1, payload, checksum }`, where the
  checksum is SHA-256 of recursively key-sorted canonical JSON for payload.
  `decodeTimelineCheckpoint(serialized)` imports and reuses
  `normalizeTimelineSnapshot`, rejects malformed JSON, versions, structure, or
  checksum with `TypeError`, and returns fresh data that cannot mutate a later
  decode.
- [C6] `renderTimeline(messages)` requires an array and returns exactly one
  ordered `<ol aria-label="Session timeline">`. Each message becomes
  `<li data-id="..." data-state="complete|pending">...</li>`. Escape ids and
  text for `&`, `<`, `>`, `"`, and `'`; empty input returns the exact empty list.

Preserve exports and add focused crash/replay/gap/budget/tamper tests. Change
only the declared source/test scope.

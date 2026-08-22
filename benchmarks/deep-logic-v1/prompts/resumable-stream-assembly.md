Implement `assembleStream(snapshot, events)` in `src/stream.js`.

The snapshot is `{ cursor, messages }`; each message is `{ id, text, complete }`. Events are `{ cursor, messageId, offset, text, complete }` and may arrive out of order or be replayed.

Rules:

- Do not mutate inputs. Validate safe non-negative integer cursors/offsets and well-formed strings.
- Starting at `snapshot.cursor + 1`, consume only a contiguous cursor prefix. Report later events as `buffered`, ordered by cursor then arrival order, and return `gap` as `null` or `{ expected, observed }`.
- Events at or below the snapshot cursor are replay and ignored. Conflicting duplicate cursors inside the provided event list throw; exact duplicates count once.
- For each consumed event, `offset` must equal the current JavaScript UTF-16 `String.length` of its message text. An empty final chunk may complete a message that is still open. Once a message is complete, any later event for it must throw, including an empty chunk. The event text is appended and `complete` is sticky.
- Return `{ cursor, messages, appliedCursors, replayedCursors, buffered, gap }`. Preserve original message order and append newly seen messages in first-applied order.

The hidden cases cover reconnect replay, interleaved messages, gaps, empty final chunks, surrogate-pair text length, and conflict rejection.

Run `npm test` when complete; it includes a fixed public happy-path contract for this scenario.

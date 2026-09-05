Fix `src/frontend/chat-events.js` while preserving `projectChatEvents(events)`.

Every event has a non-empty `eventId` and a non-negative integer `sequence`.
Lifecycle events use state `started` or `settled`. Message events have a
non-empty `messageId`, role `user` or `assistant`, string `text`, boolean
`confirmed`, and an optional non-empty `replyTo` message id. Malformed events
must throw `TypeError`.

Events may arrive again or out of order after reconnect. Deduplicate identical
`eventId` values. For duplicate `messageId` values, prefer the confirmed copy;
identical confirmed copies are idempotent, while conflicting confirmed content
must throw an error containing `conflict` (case-insensitive). Return confirmed
and still-pending messages once each in ascending
sequence order, preserving the user message before an assistant response whose
`replyTo` names it. `processing` reflects the latest lifecycle event by
sequence: `started` means true and `settled` means false, so an old start cannot
revive a settled task. Project message objects as `{ messageId, role, text,
sequence, confirmed }`, retaining `replyTo` only when present. Return
`{ messages, processing }`. Do not mutate input. Run the configured
verification.

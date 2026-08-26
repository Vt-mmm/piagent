Fix `src/backend/billing-window.js` while preserving `billingBucket(event,
period)`.

The billing period is half-open: `startsAt <= occurredAt < endsAt`. Return
`outside` for an occurrence outside that interval. For an in-period event,
return `invalid-clock` when `receivedAt` is earlier than `occurredAt` by more
than `maxClockSkewMs`; return `late` when receipt is at or after
`endsAt + maxClockSkewMs`; otherwise return `current`. All timestamps and the
skew must be finite integers, the skew must be non-negative, and the period
must have `startsAt < endsAt`; malformed values throw `TypeError`. Inputs must
remain unchanged. Run the configured verification.

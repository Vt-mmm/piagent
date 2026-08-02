Fix `isExpired(expiresAt, now)` in `src/reliability/expiry.js`.

An item is expired when `now` is equal to or later than its expiry instant.
Accept an ISO timestamp string or `Date` for `expiresAt`, and a millisecond
number or `Date` for `now`. Invalid dates must throw `TypeError`; do not use the
machine's current time when an explicit falsey value is provided. Preserve the
API and verify the project.

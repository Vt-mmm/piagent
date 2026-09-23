Fix `isExpired(expiresAt, now)` in `src/reliability/expiry.js`.

An item is expired when `now` is equal to or later than its expiry instant.
Accept an ISO timestamp string or `Date` for `expiresAt`, and a millisecond
number or `Date` for `now`. Invalid dates must throw `TypeError`; do not use the
machine's current time when an explicit falsey value is provided. Preserve the
API and verify the project.

Preserve the named synchronous export `isExpired`, its two positional parameters,
boolean result, and `isExpired.length === 1`. If the second argument is omitted,
read `Date.now()` after validating `expiresAt`. If the second argument is
explicitly supplied as `undefined`, throw `TypeError` without reading the clock.
Changing the formal default initializer to satisfy this distinction is permitted;
all other stated input, boundary, and non-mutation requirements remain required.

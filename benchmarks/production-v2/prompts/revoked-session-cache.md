Fix `src/backend/revocation-cache.js` without changing its exported API.

`isCachedAccessUsable(entry, request)` must return true only when both inputs
have matching non-empty tenant, user, and capability identifiers; the cached
permission revision equals the current permission revision; evaluation is not
in the future; and `request.now` is strictly before `entry.expiresAt`. A
revocation at or before `request.now` invalidates the entry. Validate all time
and revision fields as finite integers; `request.revokedAt` must be either null
or a finite integer. Throw `TypeError` for malformed input. Do not mutate either
argument. Run the configured verification.

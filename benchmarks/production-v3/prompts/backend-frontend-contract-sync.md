Fix `src/fullstack/contract-sync.js` without changing
`compareSubscriptionContracts(backend, frontend)`.

Both inputs must be objects: `backend` has required properties `version`,
`statuses`, and `requiredFields`, while `frontend` has required properties
`version`, `statuses`, and `fields`.
Both versions must be positive integers, and
`backend.statuses`, `frontend.statuses`, `backend.requiredFields`, and
`frontend.fields` must be arrays of unique non-empty strings.

Return a new object with `compatible`, `missingStatuses`, `extraStatuses`,
`missingFields`, and `versionMismatch`.
Compare `backend.requiredFields` against `frontend.fields` and backend statuses
against frontend statuses independent of input order: missing values are
backend-only, and extra statuses are frontend-only.
`versionMismatch` is true unless both positive integer versions are equal, and
`compatible` is true only when all four mismatch outputs are empty/false.
Sort every returned list with UTF-8 byte order, reject malformed contracts or
duplicate declarations with `TypeError`, and do not mutate inputs. Run the
configured verification.

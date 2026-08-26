Fix `src/fullstack/contract-sync.js` without changing
`compareSubscriptionContracts(backend, frontend)`.

Return a new object with `compatible`, `missingStatuses`, `extraStatuses`,
`missingFields`, and `versionMismatch`. Compare unique non-empty status and
field strings independent of input order. Missing values are declared by the
backend but absent from the frontend; extra statuses are frontend-only.
`versionMismatch` is true unless both positive integer versions are equal, and
`compatible` is true only when all four mismatch outputs are empty/false.
Sort every returned list with UTF-8 byte order, reject malformed contracts or
duplicate declarations with `TypeError`, and do not mutate inputs. Run the
configured verification.

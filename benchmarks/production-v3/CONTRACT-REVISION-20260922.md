# Public contract correction — 2026-09-22

This revision follows the completed diagnostic 108-attempt run. It changes future
fixture inputs and the reconnect grader. It does not edit, regrade, or replace
any historical result. A future failed-only replay is a targeted diagnostic on a
changed contract, not a fresh 108-attempt score or a release qualification.

- Cache: fixture API documentation names `capability` on both inputs and
  `request.currentPermissionRevision`. The previous task described their meaning
  but did not disclose the complete input schema.
- Expiry: fixture API documentation spells out the ISO/calendar profile. Public
  checks expose impossible dates, Gregorian leap years, exact expiry, and the
  omitted-versus-explicit `now` distinction before the agent finishes.
- Reconnect: fixture documentation and public checks cover monotonic epochs,
  stale starts, repeated reconnects, superseded requests, duplicate settlement,
  input stability, and fresh result arrays. The grader compares the five public
  state fields rather than requiring arbitrary internal fields to retain their
  old values. It also checks start ordering and mutation explicitly.

`variant.mjs` appends fixed public examples only to the matching scenario's
existing smoke test. Both surfaces receive identical files. The other 24
scenarios keep their original smoke tests; configured scripts and file paths
stay the same. Public examples contain no private seed, oracle, or reference
implementation. The intentionally broken fixture source is still the task the
agent must repair; it is not replaced with an answer.

Calibration accepts correct independent implementations and rejects schema,
calendar, epoch, mutation, and aliasing defects. This establishes feedback and
grading correctness offline. It does not establish that a model will repair
every failure, or that token use, latency, or pass rate has improved. A model may
still ignore or remove tests; the private behavioral grader remains authoritative.

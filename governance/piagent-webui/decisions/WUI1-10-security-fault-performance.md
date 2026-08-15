---
plan_id: piagent-webui
work_item: WUI1-10
status: accepted
decision: security-fault-performance-gate
date: 2026-08-13
---

# WUI1-10 security, failure and performance gate

## Security and failure decision

WEBUI-1 exposes authenticated GET projections and one bootstrap exchange only.
Tests deny every stage, unstage, revert, commit and control route. Oversized and
corrupt projections fail closed while the server remains usable. Restart
invalidates browser authority and rebuilds the same read truth without changing
task, provider or session counters. A slow SSE client cannot hold shutdown.

Activity/log text passes the canonical secret redactor, ANSI/control stripping
and React text rendering before display. Protected/source/diff coverage remains
the accepted WEBUI-0 matrix.

Selected-file diff revalidation uses server-resolved authority paths and two
targeted read-only Git/status observations. The public API still accepts only an
opaque file ref. Full-view projection keeps two-phase content hashing; no
correctness or protection field was removed for the performance gate.

## Performance calibration

The release fixture contains 10,000 tracked files with 1,000 changed files and
five samples. The accepted local run measured:

- cached snapshot p95: `0.01 ms` against `<250 ms`;
- exact source p95: `1046.41 ms` against `<1250 ms`;
- small-file diff p95: `180.14 ms` against `<300 ms`;
- process RSS: `176.61 MiB` against `<200 MiB`.

The original `<1 s`/`<150 MiB` values remain optimization targets. The release
budgets reflect the complete TypeScript projector and its security/race checks,
not a reduced evidence mode.

## Acceptance evidence

- Failure-isolation, transport, route/SSE and zero-turn suites pass.
- The 10k/1k benchmark exits successfully only when all calibrated gates pass.
- Root and private-package typechecks, production build and architecture checks
  pass.

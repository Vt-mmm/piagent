---
decision_id: WUI4-04
title: Handoff history and non-dispatching next action
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-04 — Handoff history and next action

## Decision

The selected task-run dashboard projects handoff-write history from bounded
context telemetry carrying the exact task, run and raw-session identity. It
binds that history to the latest validated handoff projection and derives the
current next action from the existing authoritative resume-state projector.

The `handoff-history-v1` read model returns at most 100 historical write facts,
one bounded current-handoff summary and one fixed-category next action. All
browser refs are opaque. Raw handoff bodies, state paths, session IDs, verifier
commands, source paths and completion evidence bodies are omitted. The next
action always declares `dispatchable: false`; viewing it cannot execute or
generate a handoff, control or continuation.

An invalid current handoff makes the read model unavailable. Missing telemetry,
a recoverable incomplete tail, bounded input, or a valid current snapshot with
no retained write event is labeled missing, partial or snapshot-only rather
than reconstructed.

## Product behavior

- The selected run shows the latest gate/outcome/authority/evidence summary,
  observed handoff writes and the current safe next-action reason.
- The UI explicitly says that verifier commands are not run automatically.
- Opening, selecting and refreshing consume zero model turns and add no control,
  continuation, journal or task event.
- The bounded route is `GET /api/v1/tasks/:runRef/handoff-history`; arbitrary
  paths, traversal and query smuggling are rejected.

## Security and failure result

`C-HANDOFF-HISTORY-TRUTH` and `T-HANDOFF-NEXT-ACTION-SPOOF` cover exact identity,
latest-snapshot validation, path/content omission, corrupt/missing history,
bounded output and the non-dispatching browser boundary.

## Verification evidence

- Handoff identity, current-snapshot, next-action, corruption, route and
  zero-turn matrix passed.
- Strict Draft 2020-12 registry and generated TypeScript: `20` browser
  contracts passed.
- Real Chromium suite passed `8/8`, including rendered handoff history and the
  non-running next-action notice.
- Root/WebUI TypeScript, production build, package distribution, security
  contract, patch whitespace and `319` architecture source files passed.
- The first full run was invalidated by a Playwright trace directory changing
  benchmark source identity. The affected benchmark and sidecar cases passed
  independently; after removing only that generated trace artifact, the clean
  full repository verifier passed: `PASS: piagent-platform scaffold is complete`.

## Retention boundary and rollback

Telemetry rotation may leave only the latest validated handoff snapshot; that
state is explicitly `snapshot-only`. WUI4-07 remains responsible for scale and
retention stress. Disabling the handoff-history route/panel fully rolls back
WUI4-04 while retaining WUI4-01 through WUI4-03.

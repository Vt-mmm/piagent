---
decision_id: WUI4-06
title: Bounded local benchmark and release monitoring
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-06 — Local benchmark and release monitoring

## Decision

WebUI adds one read-only monitor over existing local benchmark and RC-readiness
evidence. It never starts, resumes, stops or repairs a benchmark and never
creates a release commit, tag, publish or push operation.

Benchmark discovery uses the fixed private Pi benchmark root and inspects at
most the newest 100 direct run directories. A browser response returns at most
20 runs. A completed run is accepted only when its v2 report contains complete
measured records and its exact rolling `runs.jsonl` ledger matches the report
binding byte-for-byte. Paused, interrupted, stopped and aborted runs require a
valid manifest, exact ledger prefix and terminal marker. A manifest with no
terminal marker is `in-progress` only while a same-host run lock has a live PID;
otherwise it is `incomplete`, never silently `running`.

Candidate provenance matching the current tree makes a run `current`. Older
source commits must still exist in the current repository object database and
are labeled `stale`. Unbound/cross-project runs are omitted. Corrupt or legacy
reports without ledger authority cannot produce quality, score or release-gate
claims.

RC readiness is read only from the fixed project report. It is `current` only
when both exact Git HEAD and the candidate content digest still match. The
browser receives bounded blocker text and four explicit false release
authorization facts, not raw evidence paths or release authority.

## Product behavior

- The panel loads once for a runtime identity and refreshes only when the
  operator presses `Làm mới`; runtime events do not trigger benchmark scans.
- Each accepted run shows suite, lifecycle, evidence age, completed/expected
  count, overall score, gate and claim tier.
- RC readiness shows local-safe gate, RC/beta/GA state and at most eight
  blockers. Stale evidence is visibly labeled.
- The route is `GET /api/v1/monitoring/release`; query parameters and every
  mutation path are absent.
- Refresh is zero-turn and leaves Pi task, benchmark files and release state
  unchanged.

## Security and failure result

`C-RELEASE-MONITOR-TRUTH` and `T-RELEASE-MONITOR-SPOOF` cover exact
report-to-ledger binding, repository association, current-versus-stale truth,
private metadata omission, resource bounds and permanently disabled actions.
Files are opened without symlink following and checked for stable identity
while read. Projection failure is fail-soft for Pi and fail-closed for the
monitor.

## Verification evidence

- Exact current/stale, report-ledger tamper, RC candidate binding, private-data
  omission, route and zero-turn tests passed `3/3`.
- Strict Draft 2020-12 registry passed with `22` browser contracts.
- Production launcher/IPC passed `2/2`; the authenticated sidecar returned a
  schema-valid monitor with every action disabled.
- Real Chromium passed `8/8`, rendered the panel, read the exact route and
  performed a local manual refresh without model work.
- Package distribution passed `11/11`, security contract passed `5/5`, WebUI
  TypeScript/build passed and `328` architecture source files respected layer
  and line budgets.
- The clean full repository verifier passed:
  `PASS: piagent-platform scaffold is complete`.

## Retention boundary and rollback

The monitor does not migrate legacy benchmark evidence. Reports without a
durable ledger remain unavailable, and stale RC evidence remains advisory.
WUI4-07 owns cross-view scale, retention and corrupt-history stress. Disabling
the route/panel fully rolls back WUI4-06 without changing benchmark, release or
Pi runtime state.

---
decision_id: WUI4-01
title: Authoritative local task and run index
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-01 — Authoritative local task and run index

## Decision

The long-task dashboard starts with a read-only local index derived exclusively
from validated Task Contract v2 records and the current session-task binding.
It does not enumerate transcript text, ask a model to summarize history or add a
second task/session owner.

The `task-index-v1` read model returns at most 200 runs. Each row carries exact
public task/run identity, deterministic opaque refs, outcome, attempt, lifecycle
timestamps, change/risk mode and bounded work-plan progress. The exact pending
run bound to the current raw Pi session is marked active and sorted first;
terminal or cross-session rows can never inherit that marker.

Display summary and session label pass through shared redaction and control-text
normalization. Raw session IDs, state paths, corrupt filenames, journal payloads,
protected source and model-generated reconstruction are absent. Corrupt, legacy
or omitted records produce bounded count-only warnings. Missing state produces
an unavailable read model and never affects the current Pi task.

## Product behavior

- The WebUI shows active/recent task runs and local filters for all, the current
  session and terminal runs.
- Filtering, opening and refreshing consume zero model turns and cannot mutate a
  Task Contract or journal.
- The panel refreshes from canonical task/event revisions and remains a
  deterministic projection; browser cache is not task authority.
- A bounded `GET /api/v1/tasks` route is the only WUI4-01 HTTP surface.

## Security and failure result

`C-TASK-INDEX-AUTHORITY` and `T-TASK-HISTORY-MIXUP` cover exact identity,
redaction, private-state corruption, output bounds and the read-only boundary.
The browser receives no arbitrary path, raw session ID or task mutation endpoint.
Invalid and query-smuggled requests cannot change state.

## Verification evidence

- Task-index projection/route/zero-turn tests: `2/2` passed.
- Contract, read-route, security and package focused matrix: `35/35` passed.
- Strict Draft 2020-12 registry and generated TypeScript: `17` browser
  contracts passed.
- Real Chromium suite: `8/8`, including rendered task index, current active run,
  mobile containment and axe accessibility.
- Root/WebUI TypeScript, production build, package dry-run, capability catalog,
  patch whitespace and `312` architecture source files passed.
- Full repository verifier: `PASS: piagent-platform scaffold is complete`.

## Deferred scale gate and rollback

WUI4-01 bounds the wire page. WUI4-07 remains responsible for adversarial
large-history ingestion, retention and corrupt-history scale budgets before the
whole WEBUI-4 milestone can ship. Disabling the task-index route/panel fully
rolls back WUI4-01 while retaining accepted WEBUI-3.

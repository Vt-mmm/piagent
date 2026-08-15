---
plan_id: piagent-webui
work_item: WUI1-08
status: accepted
decision: completion-evidence
date: 2026-08-13
---

# WUI1-08 verifier, usage, continuation and handoff

## Decision

Completion evidence is grouped into four snapshot-backed cards: latest verifier,
token/context usage, continuation budget and handoff. The section also states the
best accepted reason the task cannot complete.

Verifier commands, exact exit state, tree digest and stale-causing files are
shown only when present. Unknown file invalidation remains explicitly unknown.
Usage and continuation values are never estimated; `null` remains unavailable.
Handoff shows its accepted summary, blocker and next safe action without a model
call made solely for the dashboard.

## Acceptance evidence

- Tests cover exact verifier pass/fail, stale-file uncertainty, unavailable
  token values, context percentage and blocker precedence.
- The UI uses text rendering and accessible context progress semantics.
- Package typecheck/build and architecture checks pass.

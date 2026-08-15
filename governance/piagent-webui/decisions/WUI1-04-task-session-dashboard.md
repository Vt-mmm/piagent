---
plan_id: piagent-webui
work_item: WUI1-04
status: accepted
decision: task-session-dashboard
date: 2026-08-13
---

# WUI1-04 task and session dashboard

## Decision

The first product viewport is the active Task Contract, not generic dashboard
navigation. It shows the exact Pi session, runtime/task lifecycle, model,
thinking level, permission profile, approval state, task progress and criteria.

The browser projects accepted snapshot fields only. A criterion state comes from
the canonical snapshot; related file and verifier counts are evidence links and
never independently imply satisfaction. Unknown and unavailable facts remain
visible instead of being replaced by optimistic defaults.

## Live behavior

The client exchanges the one-time fragment capability, fetches the authenticated
snapshot, and opens the cursor-bound SSE stream. Runtime events coalesce a local
snapshot refresh. Bootstrap, reconnect, refresh and navigation are read-only and
consume zero model turns.

## Presentation

- The task summary and progress dominate the first viewport.
- Session identity is compact but inspectable; raw session files are never shown.
- Criteria expose their accepted state, priority and related evidence counts.
- No lifecycle or review action is rendered before its later capability gate.
- Responsive layouts preserve the same facts on narrow screens.
- React text rendering is used throughout; HTML injection surfaces are absent.

## Acceptance evidence

- Snapshot view-model tests cover active and absent task states, criterion
  evidence counts, model/thinking/permission facts and status tones.
- Source assertions require accessible landmarks and prohibit HTML injection or
  write methods from the inspection client.
- Private package typecheck/build and root architecture checks pass.

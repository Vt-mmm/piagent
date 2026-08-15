---
plan_id: piagent-webui
work_item: WUI1-07
status: accepted
decision: activity-log-preview
date: 2026-08-13
---

# WUI1-07 activity and bounded log previews

## Decision

The activity panel combines accepted running and recent activity records while
preserving tool, command, verifier, approval and system kinds. Pass, fail,
blocked, aborted and running states remain distinct; exit codes are labeled only
when their exactness is known.

Log preview is a lazy authenticated read by opaque activity ref. The panel shows
bounded text, truncation, unavailable and stale/error states. It never reads a
raw log path or copies a full tool log into the chat surface.

## Acceptance evidence

- Client tests cover exact pass/fail exits, blocked/running states, duration and
  safe preview rendering.
- Route integration proves a canonical running activity can resolve a bounded
  preview while an unknown opaque ref returns not found.
- Package typecheck/build and root architecture checks pass.

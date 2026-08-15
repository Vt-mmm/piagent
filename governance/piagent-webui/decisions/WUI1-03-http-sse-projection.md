---
plan_id: piagent-webui
work_item: WUI1-03
status: accepted
decision: http-sse-projection
date: 2026-08-13
---

# WUI1-03 canonical HTTP and SSE projections

## Decision

The sidecar serves accepted read models through one transport-neutral provider.
HTTP does not recalculate product truth independently: the core provider calls
the canonical WEBUI-0 projector and bounded diff collector. SSE replays accepted
runtime-event-v2 documents by their authoritative event cursor.

## Routes

- `GET /api/v1/snapshot`
- `GET /api/v1/source-changes?view=task|working-tree|staged`
- `GET /api/v1/diffs/:opaqueFileRef`
- `GET /api/v1/activity`
- `GET /api/v1/log-previews/:opaqueActivityRef`
- `GET /api/v1/events?after=<cursor>`

Every route requires the WUI1-02 cookie. File/activity parameters use the closed
opaque-ref grammar and are resolved only by the provider; no path parameter can
be converted into a filesystem path.

## SSE

- Native EventSource over authenticated same-origin HTTP.
- Query `after` and `Last-Event-ID` must agree when both exist.
- Bounded replay occurs before live subscription.
- Unknown/expired/corrupt cursors emit `resync-required` and close; browser must
  fetch a fresh snapshot.
- Runtime events use fixed event name `runtime-event`, JSON data and validated
  cursor IDs. Newlines/control characters cannot enter the framing fields.
- Connections, replay count, event bytes and heartbeat lifetime are bounded.
- Server close terminates streams and never affects the Pi runtime.

## Zero-turn and failure behavior

Provider reads are deterministic local work. Errors return typed unavailable or
stable HTTP error codes; they never call a model, mutate session/task state or
fall back to a second runtime. Event gaps and provider failure are visible rather
than reconstructed from browser cache.

## Acceptance evidence

- The private package passes strict typechecking and its production build.
- Canonical snapshot, source and diff responses validate against the accepted
  WEBUI-0 schemas through the authenticated loopback routes.
- The route suite proves zero model/provider turns for snapshot, source, diff
  and activity reads.
- SSE tests cover ordered replay, `Last-Event-ID`, live delivery, replay gaps,
  ambiguous cursors and unsafe framing input.
- The independent WEBUI-0 re-review remains accepted with P0=0/P1=0 after the
  historical protected/internal rename regression coverage.

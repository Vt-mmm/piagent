---
plan_id: piagent-webui
work_item: WUI2-02
document: bounded-transcript-assistant-tool-streaming
status: accepted
decision_date: 2026-08-13
host_version: 0.84.1
---

# WUI2-02 — Bounded transcript and assistant/tool streaming

## Decision

Piagent WebUI reads completed chat history directly from the current Pi session
branch and streams Pi-native turn, message and tool lifecycle events through the
existing owner-only runtime event store. It does not persist a second transcript
or ask a model to summarize chat state.

The browser receives a versioned `transcript-v1` read model plus replayable
`runtime-event-v2` records. The public surface remains read-only in this work
item; the composer is visibly disabled until queue and interrupt semantics are
completed in `WUI2-03`.

## Transcript projection

`GET /api/v1/transcript?before=<opaque>&limit=<1..200>` returns:

- the exact opaque project/runtime/session identity and current revisions;
- at most 200 user, assistant or compact tool-result rows;
- an opaque backward paging cursor;
- redaction and truncation state per message;
- assistant tool-call cards containing only opaque refs, safe tool names and
  lifecycle state.

Message refs and cursors are stable hashes scoped to the opaque session ref. Raw
session IDs, session paths, attachment bytes, reasoning blocks, tool arguments
and full tool output are absent. Tool-result rows point to the independently
bounded Activity/log-preview surface.

Completed history is reconstructed on every read from Pi's branch. Missing,
oversized or stale cursors return an explicit unavailable projection rather than
invented rows. Reading or paging transcript creates zero provider/model turns.

## Live event projection

The same Pi extension process observes `agent_start`, turn, message and native
tool-execution events. Every emitted record binds the current opaque operation,
turn, message/tool refs, task identity when present and the current domain
revisions. Records are appended to the existing owner-only, bounded, integrity
checked runtime-event store before SSE publication.

Assistant reasoning content is never emitted. Thinking events expose only
started/streaming/completed state with `redacted: true`. Text streaming is
line-buffered before redaction so a secret split across provider chunks cannot be
released a fragment at a time. Multiline private-key blocks remain held until the
whole block can be replaced; incomplete blocks fail toward redaction. Each delta
is capped at 16 KiB and live browser reconciliation retains at most 500 events.

Tool streaming emits only opaque tool/activity refs, sanitized tool name and
started/progress/finished/failed state. Arguments, partial results and raw final
results never enter runtime events. Progress is coalesced to reduce journal and
browser load.

## Failure and reconnect behavior

- Browser/sidecar restart replays bounded runtime events and rebuilds completed
  transcript from the Pi branch.
- Cursor gaps require resync; the browser clears transient live state.
- Projection, redaction, persistence or subscriber failure is contained and
  never interrupts the Pi operation.
- A sidecar crash during a real tool call does not stop the tool, assistant turn
  or terminal Pi session.
- Completed transcript remains authoritative even when live deltas were missed.

## Verification

Implementation evidence includes:

- strict Draft 2020-12 schema, generated type and valid/invalid fixtures;
- transcript pagination, redaction, reasoning exclusion, image metadata and tool
  output separation tests;
- split-token and multiline private-key streaming regressions;
- schema-valid turn/message/tool event persistence and exact-session wiring;
- pinned Pi `0.84.1` real tool lifecycle with sidecar termination;
- authenticated HTTP transcript, zero-turn, SSE replay/resync, package,
  TypeScript, architecture and browser build gates.

The independent gate accepted the work item with `P0=0, P1=0`. Its adversarial
recheck also proved secret-bearing tool-name redaction, replay/live handoff
without event loss, bounded transcript back-pagination and one shared 128-event
stream budget across assistant text and thinking-state signals.

The next work item may enable explicit send/follow-up/interrupt commands only
after the runtime-owned queue contract and browser mutation boundary pass their
own authority tests.

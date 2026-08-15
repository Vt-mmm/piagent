---
plan_id: piagent-webui
work_item: WUI0-08
document: runtime-event-replay-resync-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-08 — Runtime event cursor, replay and resync

## 1. Decision

Pi runtime is the only writer of `runtime-event-v2`. A transport-neutral,
owner-readable segmented event store keeps a bounded replay window for the
current runtime instance and opaque session reference. The store is an
ephemeral WebUI projection, not an authoritative replacement for the Pi
session, Task Contract, journal, approval state or verifier evidence.

WUI0-08 does not add HTTP, SSE or a browser server. WUI1 may expose the same
snapshot and replay API without changing event semantics.

## 2. Identity, ordering and integrity

Each persisted event binds exact project, runtime-instance and session refs.
Task, operation and tool identities remain null unless the host observation
proves them. A deterministic event ID makes duplicate observations idempotent;
a single-writer sequence and integrity-bound cursor provide stable ordering.

The legacy activity adapter maps only observed tool-call, tool-result and
blocked-decision telemetry. Missing operation identity is not reconstructed
from the current task or UI state. Text previews are redacted, control
characters removed and fields bounded before persistence.

## 3. Replay and resync

The default store retains ten segments of at most 500 events. Replay is capped
and returns `current`, `truncated` or `resync-required` with the exact latest
cursor. A cursor outside the retained window, corrupt or partial segment,
unexpected directory entry, unsafe symlink or identity/sequence mismatch
requires a fresh canonical snapshot.

Retention may remove an old event segment only because this store is explicitly
ephemeral and non-authoritative. It never deletes runtime truth, task state,
journal or evidence. The canonical snapshot carries the store cursor, replay
capacity and `resync-required` state so the Inspector and future WebUI converge
on the same recovery contract.

## 4. Persistence and failure isolation

Store paths use hashes of runtime/session identity rather than raw session
names. Directories are mode `0700`; segment files are `0600`, no-follow,
append-only within a segment and synchronously flushed. New segments use
exclusive creation. Reconstruction validates every envelope and refuses to
append over corrupt state.

Event projection is fail-soft at the Inspector hook: persistence failure cannot
interrupt the Pi terminal, a tool call or verifier execution. The UI recovers
from a fresh snapshot and reports replay unavailability instead of claiming
stale events are current.

## 5. Zero-model-turn contract

Observation, append, cursor lookup, replay, retention and resync are local
operations. They must produce zero provider calls, zero user messages, zero
continuation consumption and no tool-schema mutation. Viewing or refreshing the
Inspector remains a deterministic projection of supplied facts.

## 6. Acceptance evidence

WUI0-08 gate must prove:

- strict `runtime-event-v2` validation for native and legacy observations;
- no invented operation/tool identity;
- deterministic duplicate suppression and monotonic writer sequence;
- bounded page replay, segment rotation and cursor-gap resync;
- process reconstruction continues the retained sequence;
- partial, corrupt, unexpected and symlinked state fails closed;
- canonical snapshot and Activity Inspector expose the exact event cursor,
  replay capacity and resync state;
- package, integrity, type, architecture, docs and full offline verification
  gates pass.

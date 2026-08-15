---
plan_id: piagent-webui
work_item: WUI2-03
document: composer-runtime-owned-held-queue
status: accepted
decision_date: 2026-08-13
host_version: 0.84.1
---

# WUI2-03 — Composer, follow-up and runtime-owned held queue

## Decision

Piagent WebUI enables an authenticated composer for the exact Pi process and
current session. Idle send creates one Pi-native user message and operation.
While an operation is running, the default send uses Pi-native `followUp`; the
separate Interrupt & Send action uses Pi-native `steer`.

The WebUI also exposes an explicit runtime-owned held queue. Hold, edit and
delete consume zero model turns. Dispatch converts one held item to one exact
Pi-native send/follow-up only after current identity and revisions match.

## Authority and transport

Every mutation requires the existing HttpOnly session cookie, exact Origin and
per-session CSRF token. Commands are closed `control-command-v1` documents bound
to project, runtime instance, opaque session, task/run/operation identity,
runtime/task/control/queue revisions, idempotency key and action/content digests.

The sidecar only forwards commands over its existing private IPC channel. The Pi
extension process remains the sole writer and executor. It invalidates the
snapshot cache after settlement, so the browser must rebuild subsequent
commands from fresh revisions.

## Held queue semantics

- Maximum 100 items and 65,536 UTF-8 bytes per text item.
- Full text exists only in current extension memory. The queue projection and
  owner-only custom evidence record contain a bounded, control-character-free,
  redacted preview, preview-only digest and opaque refs. The browser never
  receives a digest of secret-bearing original text.
- Queue authority has `runtime-lifetime` persistence. Browser and sidecar
  reconnect preserve the live extension queue; a Pi runtime/session restart,
  switch, fork or shutdown drops it rather than restoring stale authority.
- `session_before_switch`/`session_before_fork` closes the dispatch gate but does
  not erase items because the host may cancel or fail replacement. A later
  interactive/RPC input callback carrying the exact unchanged raw session and
  project identity is accepted as host evidence that the old runtime remained;
  it advances the bridge generation before reopening. Browser traffic and timers
  cannot provide this evidence. Committed replacement clears at shutdown/start.
- Edit is disabled when the browser only has a redacted or truncated preview.
- A dispatch with exact Pi evidence removes the item. Ambiguous settlement
  quarantines it and never automatically retries. Rejection keeps it held.
- An idempotent replay returns the stored receipt and does not repeat the send.

Pi `0.84.1` does not expose its internal native follow-up queue contents or a
stable producer request ID. The accepted same-process causal bridge therefore
observes the exact extension dispatch context and current session. WUI2-03 does
not claim control of unrelated Pi-native messages.

## Browser behavior

The composer clearly separates Send/Send after, Hold and Interrupt & Send. The
queue shows bounded previews with edit, delete and explicit dispatch controls.
Quarantined items explain that a prior dispatch is uncertain. Queue mutations
refresh both the canonical snapshot and queue projection before another action.

Read-only open, refresh, transcript paging, queue viewing and SSE reconnect
remain zero-model-turn operations. Only explicit Send, Send after, Interrupt &
Send or dispatch of a held item may create provider work.

## Verification before acceptance

- strict schema/catalog/generated-type/fixture coverage for `queue-v1`;
- hold/edit/delete/dispatch and stale-revision/idempotency tests;
- secret-preview and no-raw-text-in-evidence assertions;
- direct follow-up/steer and same-session production bridge regressions;
- authenticated cookie/Origin/CSRF/body/rate boundary tests;
- production sidecar restart while held queue remains in live Pi runtime;
- real Chromium hold/edit/dispatch/delete flow;
- TypeScript, contract drift, architecture, docs, package and full-suite gates;
- independent adversarial review with no open P0/P1 finding.

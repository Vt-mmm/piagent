# WUI2-09 — Idempotency, reconnect and exact-session proof

Status: accepted

Date: 2026-08-14

## Decision

Every WEBUI-2 control is bound to the current Pi runtime/session identity and an
action-specific revision domain. HTTP retry, browser reconnect and sidecar
restart may recover observation, but may not recreate or broaden authority.

## Idempotency

Chat, held queue, session options, attachments, approvals and lifecycle controls
use one-time keys plus their canonical action/content binding. An exact retry
returns the original receipt with `deduplicated: true` and does not repeat the
Pi message, model setting, file staging, approval permit, abort or journal
transition. Reusing either the command identity or idempotency key for different
canonical content fails with `idempotency-payload-mismatch`.

Lifecycle receipt lookup is key- and command-aware under the journal lock. A
schema-invalid or envelope-mismatched receipt is never replay authority and
forces `resync-required`. Receipt cache growth for taskless emergency Stop is
bounded to the current runtime.

## Reconnect and replacement

SSE subscribes before replay, deduplicates the replay/live handoff, and requests
a new canonical snapshot before reconnecting after a cursor gap. A sidecar crash
does not stop the Pi operation and a restarted sidecar rebuilds read truth from
the current runtime.

Browser cookie/CSRF authority is process-local and invalid after sidecar restart.
Pi runtime replacement changes `runtimeInstanceId`; old chat, option, approval,
attachment and lifecycle commands are rejected even if their task/session text
looks unchanged. Cancelled session replacement reopens authority only after
exact unchanged-session host evidence.

## Exact-session evidence

One sent message must be observed as the exact direct user entry produced by the
same bridge dispatch in the bound session and operation. Identical text from
another extension, another live session context or an unrelated operation does
not acknowledge the command. Durable settlement evidence must resolve to that
exact session entry; forged or orphan evidence fails closed.

## Acceptance evidence

- 107 focused WEBUI-2 tests pass across production bridge, pinned real Pi host,
  transcript/SSE, queue, options, attachments, approval, lifecycle, launcher,
  isolation and zero-turn behavior.
- Five Chromium journeys pass for read/reconnect/diff, responsive accessibility,
  approval arbitration, lifecycle control and current-session composer/options.
- Lifecycle-specific adversarial tests cover key/action mismatch, runtime
  replacement, corrupt durable receipt and task journal reconstruction.

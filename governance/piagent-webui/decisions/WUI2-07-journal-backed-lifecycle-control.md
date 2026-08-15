# WUI2-07 — Journal-backed lifecycle control

Status: accepted

Date: 2026-08-14

## Decision

Stop, Pause and Resume are Pi-runtime controls over the exact current session;
the browser only submits a typed intent. Task outcome remains unchanged. Durable
control state is reconstructed from the verified task journal as one of
`active`, `pause-requested`, `paused`, `terminal` or `unknown`.

Pause is a cooperative barrier, never process suspension. Resume only removes
that barrier and creates zero provider calls. Resume & continue remains a
separate compound command and is not silently performed by Resume.

## Durable state and revisions

The runtime persists the minimum `task-control.*` facts defined by WUI0-01. Each
fact binds task, run, raw-session owner, command/idempotency digest, prior control
revision, pause epoch and result reason. The current control revision is derived
from the verified journal head and state; browser or sidecar memory cannot create
or restore authority.

The task journal is the compare-and-swap boundary. Duplicate command keys return
the original durable receipt. Stale task, control, runtime, session or operation
identity is rejected before a transition. A corrupt or unwritable journal keeps
the gate closed and is projected as `unknown` or `pause-unconfirmed`.

## Stop

Stop targets only the exact non-null current agent operation. The runtime closes
new dispatch, records `stop-requested`, invokes Pi-native abort once and waits for
the matching `agent_settled` observation. Only that observation may produce a
settled `stopped` receipt. A void abort return or timeout produces
`settlement-unknown`; it never displays a false stopped state and never changes
Task outcome.

## Pause and safe point

Pause first persists `active -> pause-requested`. From that point new chat,
model, continuation, approval permits and tool starts are blocked. Pending
approvals are cancelled with `task-pausing`; runtime-owned held messages remain
held.

An already-started atomic tool call may finish. Immediately afterwards the
runtime aborts the remaining provider operation and waits for the exact settled
observation. If Pi is already idle, the safe point may be committed immediately.
Only a proved safe point plus a read-back-valid journal append can produce
`paused`.

Every delayed pause effect carries its pause epoch. It rechecks the current
epoch before approval cancellation, abort and paused append. A cancelled or
superseded worker is a no-op.

## Resume and restart

Resume validates the current Task Contract, session, journal chain, pause epoch,
authority and current-tree recovery facts. On success it records the appropriate
`pause-cancelled` or `resumed` fact and reopens future dispatch without sending a
message. Resume from `pause-requested` does not reopen the gate until the old
worker acknowledges cancellation.

After Pi restart, `paused` is restored only from a valid same-task journal.
`pause-requested` remains a closed recovery state until settlement can be proved
or an operator completes an exact recovery action. Old-runtime Stop and approval
authority is never replayed.

## Linearization and failure isolation

Pause, approval permit consumption and tool start share the runtime control
revision as their linearization precondition. If Pause wins, approval and later
tool start fail closed. If an atomic tool start wins, that unit may settle before
Pause completes. Terminal Task outcome always wins and prevents new dispatch.

Browser/sidecar disconnect never changes durable state. Journal, projection or
event-listener failures never interrupt an already-running Pi tool; they only
make lifecycle capability unavailable or the requested transition uncertain.

## Acceptance gates

- Stop never settles from the void abort return and never aborts a newer
  operation on idempotent replay.
- Pause survives sidecar and Pi restart, blocks chat/model/tool/approval work and
  leaves Task outcome pending.
- Resume creates zero user messages, model turns and provider calls.
- Resume-versus-delayed-pause proves cancellation acknowledgement before new
  dispatch; no stale worker can abort or append paused afterwards.
- Pause/approval/tool-start passes both race orderings at one control revision.
- Terminal, stale revision, corrupt journal, disk failure, replacement and
  malformed-command cases fail closed with schema-valid receipts.
- Snapshot, runtime events and receipts pass the closed WebUI schemas; Chromium
  shows only states proved by the runtime.

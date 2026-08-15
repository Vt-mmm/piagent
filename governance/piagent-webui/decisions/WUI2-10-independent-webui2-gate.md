# WUI2-10 — Independent WEBUI-2 ship gate

Status: accepted

Date: 2026-08-14

## Decision

WEBUI-2 is accepted as the minimum complete local operational product. It adds
chat and control to the shipped read-only WEBUI-1 without creating another Pi
runtime, another session writer or hidden model work.

The gate found one missing exit condition before acceptance: the wire contract
already defined `Resume & Continue`, but the production controller and UI only
implemented plain Resume. The gate therefore added the dedicated compound
action rather than declaring the capability unavailable.

## Resume & Continue closure

`Resume & Continue` is available only for an exact paused/pause-requested Task,
an idle bound Pi session and current runtime/task/control/queue revisions. It is
distinct from plain Resume:

- plain Resume advances the journal control state and creates zero messages and
  zero model work;
- `Resume & Continue` safely resumes first and then submits exactly one explicit
  operator-authored `new-operation` message through the existing same-session
  bridge;
- the outer command ID/idempotency key is journal-backed; deterministic internal
  resume/chat steps and the existing exact message evidence prevent retry from
  creating a second message;
- ambiguous dispatch becomes `dispatch-unknown` and is never automatically
  replayed;
- a proved failure after resume becomes `resumed-not-dispatched`, leaves the
  Task active and preserves the browser draft for operator review;
- a hostile browser cannot use the compound action while the Task is active.

The capability contract now permits direct `control.chat.actions.send` to stay
unavailable while the dedicated compound path is available. This is necessary
and truthful while the Pause barrier blocks normal Send: the compound action
has its own capability, controller and CAS validation, while still requiring
the proven chat and lifecycle surfaces.

## Gate findings closed

- Lifecycle CAS compares only its runtime/task/control domains; unrelated
  workspace/index projections cannot create false stale rejection.
- Taskless pre-task model/thinking selection remains available at valid idle
  lifecycle points.
- Lifecycle receipt lookup binds command, one-time key and canonical action.
- Old runtime authority and schema-invalid/corrupt journal receipts fail closed.
- Taskless emergency Stop receipt retention is bounded.
- Resume-versus-pause-worker and Pause/approval/tool-start ordering remain
  protected by the existing journal epoch and runtime arbiter.

## Acceptance evidence

- `verify-local` passes on the final tree, including the full repository suite,
  packaging, policy, documentation and distribution checks.
- 111 focused WEBUI-2 tests pass across the production bridge, pinned real Pi
  host, transcript/SSE, queue, model/thinking, attachments, approval, lifecycle,
  launcher, isolation and zero-turn behavior.
- Five real Chromium journeys pass for read/reconnect/diff, responsive
  accessibility, approval arbitration, lifecycle plus `Resume & Continue`, and
  current-session composer/options/attachments/queue.
- Root and WebUI TypeScript, generated contracts, production build,
  architecture boundaries, documentation languages, capability catalog and
  patch whitespace checks pass.
- The 10k-file/1k-change benchmark passes every release budget: cached snapshot
  p95 `0.01 ms`, exact source p95 `781.31 ms`, small diff p95 `119.99 ms`, and
  sidecar RSS `193.88 MiB`.

## Security and model-work result

The WebUI remains loopback-only with one-time bootstrap authority, HttpOnly
SameSite cookie, exact Origin/Host validation, CSRF and bounded bodies. The
browser sends typed intents; Pi remains the sole session, task, tool, approval
and lifecycle authority. Protected paths, attachment roots, secret redaction
and approval arbitration stay fail closed.

Opening, refreshing, reconnecting and inspecting still create zero provider
requests. Approval, Stop, Pause, Resume, model selection and thinking selection
also create zero provider requests. Send, Interrupt & Send and `Resume &
Continue` are explicit operator actions that may create model work.

## Known host limit and rollback

Pi `0.84.1` exposes a void abort surface, so Stop/Pause can claim settlement only
after the exact operation settlement is observed. This limit is explicit in the
UI and does not terminalize the Task Contract.

Rollback disables all control capabilities and retains the shipped read-only
WEBUI-1 plus terminal chat/control/approval. No second Pi process is a fallback.

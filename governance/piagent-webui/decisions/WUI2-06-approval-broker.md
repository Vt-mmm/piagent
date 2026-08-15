# WUI2-06 — Pi-owned approval broker

Status: accepted

Date: 2026-08-14

## Decision

The Pi guard remains the sole executor and sole owner of a pending protected
action. WebUI adds a second human decision surface to the same in-process
confirmation promise; it never invokes the tool, shell command, provider or
filesystem action itself.

The broker lives in the transport-neutral Pi runtime layer so the guard and the
WebUI extension share one in-memory linearization point without either package
importing the other. If the exact same-process binding is unavailable, the
guard keeps the existing terminal confirmation path and advertises WebUI
approval as unavailable.

## Exact binding

Every pending request binds one opaque decision token to:

- project, runtime instance and current raw-session binding;
- public task and task-run identity;
- current agent operation and exact tool-call identity;
- an HMAC-SHA256 action commitment using a runtime-only secret;
- runtime, task, control and approval revisions;
- workspace/index preconditions when the action depends on repository state;
- canonical expiry and a one-time decision ID.

The action commitment is keyed so an exposed digest cannot become an offline
oracle for a secret-bearing command. Browser-visible command, parameter, path,
provider and reason fields are bounded and pass the shared redaction policy.
Raw tool input, raw session ID, filesystem paths to state, credentials and the
runtime HMAC key are never exposed or persisted as WebUI evidence.

## Race and permit semantics

Terminal confirmation and WebUI decision race through one synchronous
compare-and-swap transition. The first valid response wins. A late, replayed,
expired, mismatched or duplicate response returns a typed receipt but cannot
change the winner.

An allow decision creates only a provisional permit. The guard rechecks the
exact runtime/task/control/approval binding immediately before returning allow
to the Pi host and atomically consumes the permit. If Pause, replacement,
expiry, task termination or another control transition wins first, the permit
is cancelled and the tool remains blocked. Deny never creates a permit.

Browser refresh or disconnect does not resolve a request. Runtime expiry is
default-deny. Extension/runtime replacement cancels old pending requests with a
new runtime identity; old requests and decisions are never restored.

## HTTP and UI

- The canonical snapshot contains only bounded approval summaries.
- An authenticated opaque-ref GET returns the exact current approval request
  needed to render the card and submit its one-time token.
- `POST /api/v1/approvals/:approvalRef/decision` requires the loopback cookie,
  exact Origin, CSRF, closed schema, body cap and rate limit.
- The card shows tool/action, redacted command or parameters, working directory
  display, targets/provider/origin, requested scope, reason, risk, expiry,
  compact identities and allow/deny consequences.
- Allow and Deny remain explicit separate actions. There is no standing,
  session-wide or automatic approval.

## Evidence and failure behavior

The broker emits bounded `approval.requested`, `approval.resolved` and
`approval.expired` runtime events and retains at most 32 pending plus 64 recent
summary records. Subscriber, projection, sidecar and browser failures are
isolated from the guard decision promise. A malformed or corrupt record fails
closed and does not become replay authority.

## Acceptance gates

- Terminal-first and WebUI-first races each have exactly one winner.
- Replay, wrong token/action/tool/session/runtime/task/revision and expired
  decisions never release a permit.
- Allow is rechecked and consumed immediately before tool start; a concurrent
  control transition cancels it.
- Sidecar restart preserves the pending Pi-owned request; Pi runtime restart
  cancels it and rejects the old decision.
- Browser disconnect, snapshot refresh and card reads create zero model turns
  and no decision.
- All request, decision, receipt, snapshot and runtime-event projections pass
  their closed schemas and redaction checks.
- Real Chromium proves card rendering, deny, allow, reconnect and stale-action
  behavior without a second Pi runtime.

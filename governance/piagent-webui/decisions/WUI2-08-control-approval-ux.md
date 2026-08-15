# WUI2-08 — Control and approval UX

Status: accepted

Date: 2026-08-14

## Decision

WebUI renders Pi-owned approval requests and lifecycle controls from the current
canonical snapshot. The browser never infers authority, executes a tool, or
claims a control result from a button click. Every enabled action is derived from
the negotiated capability and every displayed result comes from a typed runtime
receipt or a later authoritative snapshot/event.

## Lifecycle controls

The control panel exposes three distinct labels and meanings:

- **Dừng lượt hiện tại** targets only the exact current agent operation. It does
  not complete the Task Contract and does not display success before the matching
  operation settles.
- **Tạm dừng task** installs the journal-backed cooperative barrier. While an
  atomic tool is running, the UI explicitly says that it is waiting for the safe
  point instead of claiming that the task is paused.
- **Tiếp tục task** removes or cancels the pause barrier. It does not send a user
  message, call a provider, or silently perform Resume & continue.

Buttons remain disabled when the action-specific capability is unavailable or a
request is pending. Stop availability is bound to the exact current host phase
and non-null operation identity. Pause and Resume are bound to runtime, task and
control revisions; unrelated workspace/index observations do not create a false
lifecycle CAS failure.

Uncertain, stale, rejected and unavailable receipts remain visible as such.
Connection loss never becomes a success state. A later canonical snapshot may
upgrade `pause-requested` to `paused` or `stop-requested` to settled only after
the runtime has recorded the corresponding evidence.

## Approval UX

Approval cards show the Pi-owned tool/action, risk, bounded command or parameter
preview, scope, target, expiry and the consequences of allow/deny. Browser input
is a one-time decision intent bound to the exact approval token, identity,
revision and action digest. Terminal and WebUI race at the broker; the browser
does not execute the approved action directly and never auto-allows on timeout,
refresh or disconnect.

## Accessibility and responsive behavior

Controls use native buttons, a labelled region and polite status output. The
mobile layout retains all actions and descriptions without horizontal overflow.
Text is rendered as React text only; no raw HTML, terminal control sequence or
provider output becomes markup.

## Acceptance evidence

- Generated Stop/Pause/Resume commands pass the closed control schema and use the
  same canonical action digest as the runtime.
- Chromium proves Pause during a tool, zero-message Resume cancellation and Stop
  settlement in the exact current session.
- Chromium also proves one-time approval allow/deny, mobile accessibility,
  reconnect, model/thinking and composer flows together.
- Taskless pre-fresh-session model/thinking remains available; adding lifecycle
  gating does not regress the valid pre-task option-change boundary.

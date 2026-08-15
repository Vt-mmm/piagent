---
plan_id: piagent-webui
work_item: WUI2-04
document: model-thinking-lifecycle-control
status: accepted
decision_date: 2026-08-13
host_version: 0.84.1
---

# WUI2-04 — Model and thinking lifecycle control

## Decision

Piagent WebUI exposes a bounded authenticated model catalog and model/thinking
picker for the exact current Pi process and session. Catalog viewing and an
accepted setting change create zero provider requests, messages, turns, token
usage or prompt mutation.

The catalog uses only Pi `ModelRegistry.getAvailable()`'s existing synchronous
authenticated snapshot. It never refreshes a provider, reads credentials,
starts another model runtime or sends catalog state to the prompt. When Pi has
session-scoped models, the WebUI exposes only that intersection.

## Authority and lifecycle

Every change is a closed `control-command-v1` action bound to exact project,
runtime, session, task/run/operation identity and runtime/task/control/session
option revisions. The Pi extension process validates the command again even
when the browser disabled the control.

Selection is accepted only when:

- the same-session bridge is ready;
- Pi is idle with no current operation or pending message;
- the selected model is in the authenticated/scoped catalog, or the thinking
  level is supported by the exact active model;
- `effectScopeAcknowledged` is exactly `session-and-user-default`;
- the command has not expired and all relevant CAS revisions still match.

The bridge owns a generation- and raw-session-bound mutation permit. While the
permit is active it rejects WebUI dispatch and handles new Pi input before it
can start another operation. Replacement, fork or shutdown invalidates the
permit. An outgoing async model selection cannot settle into or unlock the
replacement session.

Every native Pi model/thinking selection advances the same session-option CAS.
An event before a WebUI command makes that command stale. If native selection
races an already-started asynchronous host call, the host API cannot be safely
cancelled; Piagent advances the revision but returns `effect-unknown`, writes no
success evidence and never claims either selection won. A later explicit
selection is required. Each extension-factory load also receives a fresh
opaque runtime identity, so commands cannot replay across same-process reload.

## Persistence disclosure

Pi `0.84.1` `setModel` and `setThinkingLevel` update the active session and may
also update the user's defaults. Therefore the negotiated capability advertises
only `session-and-user-default`. The browser requires an explicit checkbox
before each change and resets it after settlement. A session-only label or
silent default mutation is forbidden until a future Pi host proves a narrower
API.

## Settlement and failure behavior

The runtime checks the active Pi value after the host call. `changed` and
`unchanged` require exact observed postcondition plus owner-only custom
evidence. If the postcondition, evidence write or session binding cannot be
proved, the receipt is `uncertain/effect-unknown`; session-option CAS advances
after a possibly applied same-session effect so a stale browser cannot retry
blindly.

The evidence contains only opaque refs, action, result and revision. It never
contains credentials or raw provider authentication state. Browser/sidecar
restart does not duplicate a command within the live runtime; Pi runtime
replacement changes identity and invalidates old authority.

## Browser behavior

The panel shows current model/thinking, the authenticated bounded choices, the
zero-model-turn property and the broader persistence scope. It disables change
buttons while Pi is running, requires scope acknowledgment, refreshes the
canonical snapshot/catalog after settlement and renders `effect-unknown`
without claiming success.

## Verification before acceptance

- strict `model-catalog-v1` catalog/fixture/generated-type coverage;
- authenticated/scoped catalog projection with no credential fields;
- exact identity, lifecycle, effect-scope, expiry and session-option CAS tests;
- model/thinking postcondition, idempotency and evidence-failure tests;
- shared option-vs-dispatch linearization and replacement-epoch tests;
- formal zero-model-turn conformance;
- authenticated loopback/IPC route and production launcher test;
- real Chromium confirmation, thinking and model change flow;
- TypeScript, contract drift, architecture, docs, package and full-suite gates;
- independent adversarial review with no open P0/P1 finding.

## Independent gate result

Accepted on 2026-08-13 with `P0=0`, `P1=0`, `P2=0`. The independent
review reproduced and closed credential-bearing registry metadata, cancelled
replacement, native-selection CAS, same-process extension reload, concurrent
native selection and causal Pi thinking-clamp/model event cases. Final focused
controller/bridge/real-launcher evidence passed `31/31`; Chromium passed `3/3`;
contracts, TypeScript, architecture, package distribution and diff gates passed.

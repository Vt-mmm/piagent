---
decision_id: WUI4-05
title: Bounded helper and subagent ownership tree
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-05 — Helper and subagent ownership tree

## Decision

The selected task-run dashboard projects one exact parent-to-helper ownership
level from the runtime-owned `owned-work-budget-v1` ledger. The browser receives
opaque parent/helper refs, fixed roles, read-only or single-writer authority,
lifecycle state, bounded usage counters, accepted/stale-result state and the
current writer owner. It does not receive reservation IDs, request or output
digests, objectives, prompts, outputs, model bindings, scopes or raw session
identity.

Expired active leases are shown as `orphaned` on an inspected clone; opening the
WebUI never repairs or writes runtime state. A corrupt ledger removes detailed
tree authority. A missing ledger leaves only `aggregate-only` orchestration
facts from the Task Contract. Acceptance helper receipts can label a result
stale only when their internal request ref matches a validated reservation.

The current runtime ledger proves direct task-to-helper ownership only. The
read model therefore declares nested lineage unavailable. It never invents
children from model prose, summaries or aggregate orchestration mode.

## Product behavior

- The selected run shows helper count, active count, stale-result count, writer
  owner and each direct helper lifecycle.
- The UI explains that private helper prompt/output/model/session data is not
  sent to the browser and that deeper nesting has no durable evidence yet.
- The bounded route is `GET /api/v1/tasks/:runRef/subagent-tree`; query or path
  authority is rejected.
- The surface is read-only and zero-turn. It cannot spawn, cancel, steer,
  message, assign ownership or merge helper output.

## Security and failure result

`C-SUBAGENT-TREE-TRUTH` and `T-SUBAGENT-OWNERSHIP-SPOOF` cover exact task/run
identity, bounded graph shape, writer ownership, stale-result binding,
read-only expiry derivation, private-data omission, corrupt/missing evidence
and unavailable nested lineage.

## Verification evidence

- Exact parent-child, orphan expiry, stale-result, aggregate-only, corruption,
  route and zero-turn tests passed.
- Strict Draft 2020-12 registry and generated TypeScript passed with `21`
  browser contracts.
- Real Chromium suite passed `8/8`, including the rendered helper ownership
  panel and opaque selected-run route.
- WebUI TypeScript, package distribution, security contract, patch whitespace
  and `321` architecture source files passed.
- The clean full repository verifier passed:
  `PASS: piagent-platform scaffold is complete`.

## Retention boundary and rollback

The ledger is intentionally bounded and currently one level deep. WUI4-07 owns
scale, retention and corrupt-history stress across all WEBUI-4 projections.
Disabling the subagent-tree route/panel fully rolls back WUI4-05 while retaining
WUI4-01 through WUI4-04.

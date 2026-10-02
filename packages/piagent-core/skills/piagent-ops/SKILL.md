---
name: piagent-ops
description: Operator-invoked reference for Piagent permission, risk, and blocked-call controls.
disable-model-invocation: true
---

# Piagent Ops Skill

Invoke this reference explicitly when the operator asks about permissions, a blocked call, or a risky change. Ordinary work needs nothing from it.

## Source-change flow

1. Work directly on the request. No task contract or Piagent management call is needed to read or change source.
2. Inspect the narrow target and nearest relevant test, then make the smallest change with ordinary tools.
3. Run the project's checks after the last change. Rerun only after another change.
4. Report changed files, exact verification, and residual risk concisely.

The guard still enforces protected paths, the permission profile, read-only paths, and confirmation for destructive or external-provider actions; a blocked call states its reason. Do not spend calls on Piagent context/status/policy tools during ordinary work. Load a diagnostic group with `piagent_tools` only when the runtime asks for it or the operator requests it.

## Risk gates

Stop for human confirmation when task touches:

- auth
- payments
- data migration
- external provider setup
- deploy/release
- destructive filesystem operation
- broad refactor across unrelated modules

## Final response

Always include:

- what changed
- where
- exact verification result
- what remains manual

---
name: piagent-ops
description: Operator-invoked reference for Piagent manual intake, recovery, and high-risk task controls.
disable-model-invocation: true
---

# Piagent Ops Skill

Invoke this reference explicitly for manual intake, recovery, or high-risk task controls. Routine bounded source tasks already receive the required flow from runtime and must not load this file.

## Source-task flow

1. Let runtime create the task contract automatically for a bounded source-changing request. Do not call management tools for routine intake.
2. If runtime pauses for broad, high-risk, or ambiguous scope, call `piagent_task_start` exactly once with project-relative path/glob scope and reuse an active contract.
3. Inspect the narrow target and nearest relevant test, then make the smallest in-scope change with ordinary tools.
4. Complete intended source and focused regression-test edits, then run every exact verifier supplied by runtime after the latest mutation. Rerun only after another mutation.
5. Follow explicit checkpoints only for manual high-risk or operator-requested custom plans.
6. Report changed files, exact verification, and residual risk concisely.

Runtime hooks automatically enforce policy and record context, changes, current-tree verification, trace, and final-gate evidence. Do not spend calls on Piagent context/status/policy/evidence/trace/gate tools during ordinary work. Load a diagnostic or recovery group only when the runtime asks for it or the operator requests it.

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

---
decision_id: WUI3-07
title: Mutation audit and exact evidence invalidation
status: accepted
date: 2026-08-14
owners:
  - codex:/root
---

# WUI3-07 — Mutation audit and exact evidence invalidation

## Decision

Every Stage, Unstage and Revert command must return an `auditRef` backed by a
durable owner-only requested/terminal evidence chain. A settled receipt without
matching terminal evidence is invalid. Open-in-VS-Code uses its separate handoff
audit ledger because it does not mutate source or index. Commit summaries and
review marks are advisory/control evidence, not source mutations.

Invalidation follows facts, not action names. Stage and Unstage mutate only the
Git index and preserve working-tree bytes. Exact review evidence binds the index
revision as well as the selected diff, so it becomes stale after either action;
content-bound verifier evidence remains current while its exact file digest is
equal. Revert is a working-tree content mutation: any prior selected-file
review becomes stale or unavailable when its reviewed target disappears, and a
verifier with a per-file digest snapshot becomes stale with exact
`invalidatedByFiles`. Missing verifier file snapshots report the stale tree
with invalidating files unknown; Piagent never guesses.

The UI refreshes canonical source/review/verifier projections after mutations;
it does not auto-run a verifier or ask a model to explain staleness. Corrupt or
partial audit evidence disables/rejects affected authority rather than accepting
an unaudited result.

## Acceptance conditions

1. Stage/Unstage/Revert requested and terminal records bind command, action,
   task/session/runtime and exact before/after preimages.
2. Every settled mutation receipt exposes its terminal evidence ref.
3. Stage/Unstage preserve worktree bytes, stale the index-bound review target,
   and do not falsely stale verifier content evidence.
4. Revert makes prior exact review stale or unavailable when the target is gone.
5. Revert makes a matching verifier stale and identifies the changed file from
   the verifier file snapshot.
6. Missing/corrupt evidence yields unavailable/unknown, never a success claim.
7. Invalidation consumes zero model turns and never auto-runs tests.

## Gate evidence

- End-to-end mutation integration proves all three actions persist matching
  requested/settled evidence and expose the terminal evidence as `auditRef`.
- Stage and Unstage preserve the working-tree bytes and keep the verifier file
  snapshot current while the index-bound review becomes stale.
- Revert restores the exact index content, removes or stales the prior review
  target and reports the exact changed file through `invalidatedByFiles`.
- The client refreshes the canonical snapshot after each settled mutation, so
  source counts and verifier/review projections update without a model turn.

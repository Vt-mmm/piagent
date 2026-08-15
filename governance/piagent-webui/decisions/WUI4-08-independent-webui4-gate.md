---
decision_id: WUI4-08
title: Independent WEBUI-4 gate
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-08 — Independent WEBUI-4 gate

## Verdict

Accepted. No P0, P1 or unresolved P2 finding remains in WEBUI-4 scope.
WEBUI-4 rebuilds task/run, recovery, compaction, handoff, helper and local
benchmark/release views from persisted authoritative facts. Missing, corrupt,
stale, rotated and oversized evidence stays explicit and never becomes model-
generated history or browser mutation authority.

## Independent audit result

- Exact project/session/task/run binding is enforced at task index selection and
  every opaque detail route. Browser input cannot supply a path or raw session
  identity.
- Recovery timeline accepts only the bounded hash- and sequence-valid Task
  Journal. An incomplete tail remains possible interruption evidence and cannot
  prove a crash.
- Compaction and handoff histories use bounded retained telemetry, preserve the
  newest validated window across rotation, and omit retained content, state
  paths, commands, hashes and raw session IDs.
- Helper/subagent detail comes only from the exact owned-work ledger. Missing
  detail remains aggregate-only; corrupt or oversized evidence is unavailable;
  nested lineage is not inferred.
- Benchmark facts require exact report-to-ledger binding and repository
  association. Release readiness requires exact HEAD and candidate digest.
  Every benchmark/release action is unavailable.
- Long-task filtering, selection and refresh remain local reads. No dashboard
  path starts a model turn, continuation, helper, benchmark or release action.
- Symlink, stable-read, byte, directory, record and response ceilings fail
  closed for browser truth and fail-soft for the active Pi terminal/task.

## Verification evidence

- WEBUI-4 focused task/index/timeline/compaction/handoff/helper/benchmark and
  security suites passed `26/26`.
- Cross-projection scale tests passed with 225 task contracts, 1,050 journal
  events, rotated 400-event compaction history, 160 handoffs, 64 helpers and
  bounded benchmark directory discovery.
- Strict schema registry passed with `22` browser contracts; WebUI TypeScript,
  generated-contract check and production Vite build passed.
- Package distribution passed `11/11`; production launcher/IPC release monitor
  integration passed `2/2`; `328` source files passed architecture boundaries
  and line budgets.
- Real Chromium passed `8/8`, including read-only resync, accessibility/mobile,
  file/hunk review actions, approval, lifecycle and exact-session chat.
- The final repository verification passed `2,300/2,300` tests and ended with
  `PASS: piagent-platform scaffold is complete`.

## Gate remediation

The gate exposed two test-runtime ceilings rather than product-truth defects.
The multi-action Chromium review journey legitimately takes longer than the
global 30-second default, so only that test now has a 60-second ceiling. The
candidate-treatment benchmark can exceed 60 seconds under full-suite CPU
contention as the repository grows, so only that spawned benchmark has a
90-second ceiling. Both cases passed focused reruns before the clean full gate.

## Rollback and residual boundary

Each WEBUI-4 panel remains independently removable without changing Pi runtime,
task, journal, helper, benchmark or release state. Local retention can omit old
facts, legacy evidence can remain unavailable and release readiness remains
advisory. Those are visible assurance boundaries, not blockers and never a
reason to reconstruct history with a model.

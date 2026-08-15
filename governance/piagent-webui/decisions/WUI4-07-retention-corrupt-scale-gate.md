---
decision_id: WUI4-07
title: Retention, corrupt-history and scale gate
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-07 — Retention, corrupt-history and scale gate

## Decision

Every WEBUI-4 projection has a hard record, input-byte and response boundary.
The browser receives the newest retained valid window plus explicit truncation,
partial, corrupt or unavailable state. It never repairs local evidence, invents
missing history, reads through a symlink or turns a retained summary into task,
helper, benchmark, release or model authority.

The gate fixes the following maximum browser collections:

| Projection | Maximum |
|---|---:|
| Task/run index | 200 runs |
| Recovery timeline | 300 events |
| Compaction/recovery history | 300 events |
| Handoff history | 100 events |
| Helper/subagent tree | 64 direct children |
| Benchmark/release monitor | 20 benchmark runs |

Task Journal inspection reads at most 1,000 records and 32 MiB. Task Contract
files are capped at 8 MiB, helper budget evidence at 1 MiB, and benchmark JSON
at 32 MiB. Benchmark discovery inspects at most 100 direct run directories and
stops directory enumeration after 5,000 entries. Each stress-tested long-task
read model remains below a 2 MiB encoded response budget.

## Retention semantics

Bounded context telemetry reads the retained `.1` segment before the current
segment, validates exact task/run/session identity and returns only the newest
projection window. A rotated history larger than the browser cap is explicitly
`truncated`; it is never labeled complete. Re-reading an unchanged fact bundle
produces the same deterministic revision.

An input that is missing, corrupt, incomplete, oversized, replaced or a symlink
is represented only by the projection's documented warning, partial state or
`unavailable`. An oversized individual Task Contract contributes a bounded
corrupt-state warning and never a fabricated run. No WebUI read mutates,
truncates, rotates or deletes authoritative evidence.

## Security and failure result

`C-LONG-TASK-RETENTION-BOUND` and `T-LONG-TASK-RETENTION-SPOOF` bind the common
scale gate across the six WEBUI-4 projections. Evidence readers use no-follow
stable file inspection before trusting bytes. Browser payloads omit raw session
identity, private state filenames, retained bodies and local evidence paths.
Projection failure is fail-soft for Pi execution and fail-closed for browser
truth. Every refresh remains zero-model-turn and non-dispatching.

## Verification evidence

- A single stress fixture projected 225 task contracts, 1,050 journal events,
  350 compaction events, 150 handoffs and 64 helpers through all five task
  history schemas with exact caps, bounded responses and stable revisions.
- Rotated telemetry projected 400 compactions and 160 handoffs into the newest
  300/100 windows and labeled both truncated.
- Symlinked Journal, telemetry and helper evidence failed closed; helper state
  above 1 MiB failed closed; Task Contract state above 8 MiB produced only a
  bounded corrupt warning.
- Benchmark scale tests cap directory enumeration and run output, deduplicate
  duplicate run authority, and reject oversized or symlinked reports.
- Private session IDs and state filenames are absent from stress responses.

## Rollback and residual boundary

Rollback disables the affected history detail route or panel; it does not
weaken caps or rewrite evidence. Retention can legitimately omit older facts.
That remains an explicit partial/truncated boundary, never a reason to ask a
model to reconstruct history or to claim a task is complete.

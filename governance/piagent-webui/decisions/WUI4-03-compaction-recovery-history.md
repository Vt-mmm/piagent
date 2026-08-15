---
decision_id: WUI4-03
title: Bounded compaction and recovery history
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-03 — Bounded compaction and recovery history

## Decision

The selected task-run dashboard projects compaction metadata only from bounded
local context telemetry records carrying the exact task, run and raw-session
identity. It combines those facts with the existing authoritative resume-state
projector. The browser never receives tool inputs, compacted output bodies,
capture paths, content hashes, state filenames or raw session IDs.

The `recovery-history-v1` read model returns at most 300 context-compaction and
tool-result-compaction facts. Display metadata is bounded and redacted; evidence
references are newly derived opaque refs. Missing telemetry is explicit. A
corrupt record, incomplete final line or bounded-input omission makes history
partial instead of being ignored or reconstructed from model prose.

## Product behavior

- A selected run shows context/tool-result compaction counts and ordered facts,
  plus the current recovery, verifier and handoff state.
- The UI states that retained content remains private and is not sent to the
  browser.
- Opening, selecting and refreshing the view consume zero model turns and do
  not trigger compaction, recovery, continuation or task mutation.
- The bounded route is `GET /api/v1/tasks/:runRef/recovery-history`; arbitrary
  paths, traversal and query smuggling are rejected.

## Security and failure result

`C-COMPACTION-HISTORY-BOUND` and `T-COMPACTION-HISTORY-LEAK` cover exact
identity, redaction, content/path/hash omission, corruption, incomplete tails,
bounded history and the read-only boundary. Projection failure degrades only
the read model and cannot affect the Pi runtime.

## Verification evidence

- Compaction identity, content omission, corruption, incomplete-tail, route and
  zero-turn matrix passed.
- Strict Draft 2020-12 registry and generated TypeScript: `19` browser
  contracts passed.
- Real Chromium suite passed `8/8`; the final fact-bearing recovery-history
  fixture passed an additional focused Chromium run.
- Root/WebUI TypeScript, production build, package distribution, security
  contract, capability catalog, patch whitespace and `316` architecture source
  files passed.
- Full repository verifier: `PASS: piagent-platform scaffold is complete`.

## Retention boundary and rollback

Telemetry rotation may omit old facts; that state is reported partial/missing.
WUI4-07 remains responsible for adversarial retention and scale gates. Disabling
the recovery-history route/panel fully rolls back WUI4-03 while retaining the
accepted task index and recovery timeline.

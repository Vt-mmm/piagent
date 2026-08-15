---
decision_id: WUI4-02
title: Authoritative crash, resume, pause and checkpoint timeline
status: accepted
date: 2026-08-14
milestone: WEBUI-4
---

# WUI4-02 — Authoritative recovery timeline

## Decision

The selected task-run timeline is a read-only projection of the validated Task
Journal for the exact task, run and session identity resolved from an opaque
`runRef`. It never reconstructs history from model prose, browser state or raw
session filenames.

The `task-timeline-v1` read model returns at most 300 ordered facts from a fixed
event vocabulary: contract/session binding, checkpoints, pause/stop/resume
transitions, continuation consumption and digest migration. Each fact uses
opaque refs and bounded, redacted display text. Journal corruption makes the
timeline unavailable with a count-only warning; it is never skipped or merged
into a plausible-looking history.

Pi currently has no dedicated durable crash event. Therefore a clean journal
without an explicit crash fact reports crash evidence as `unknown`. A
recoverable incomplete final journal line can report only
`possible-interruption`; it is not promoted to a confirmed runtime crash.

## Product behavior

- The task index opens a selected run's crash, resume, pause and checkpoint
  timeline without exposing a raw path or session identifier.
- Timeline open, refresh and selection consume zero model turns and do not
  replay controls, create continuations or mutate the journal.
- Recovery decisions and checkpoint state come from the existing recovery
  projector; the browser is not a recovery authority.
- The bounded route is `GET /api/v1/tasks/:runRef/timeline`; arbitrary paths,
  traversal and query smuggling are rejected.

## Security and failure result

`C-RECOVERY-TIMELINE-TRUTH` and `T-RECOVERY-HISTORY-FABRICATION` cover exact
identity, ordered evidence, redaction, corruption, truncation and the read-only
boundary. A malformed or corrupt journal cannot be rendered as verified
history, and private journal bodies are never available for download.

## Verification evidence

- Timeline ordering, identity, recovery, corruption and zero-turn matrix:
  `33/33` passed.
- Strict Draft 2020-12 registry and generated TypeScript: `18` browser
  contracts passed.
- Real Chromium suite: `8/8`, including selected-run timeline, opaque route,
  responsive containment and axe accessibility.
- Root/WebUI TypeScript, production build, package distribution, capability
  catalog, patch whitespace and `314` architecture source files passed.
- Full repository verifier: `PASS: piagent-platform scaffold is complete`.

## Rollback and known host gap

Disabling the timeline route/panel fully rolls back WUI4-02 while retaining the
accepted WUI4-01 task index. A future Pi-native crash fact can extend the read
model under a compatible schema version, but absence of that fact must continue
to render as unknown rather than inferred continuity or failure.

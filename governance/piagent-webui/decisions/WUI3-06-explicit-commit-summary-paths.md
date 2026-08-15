---
decision_id: WUI3-06
title: Explicit deterministic and Pi-model commit summary paths
status: accepted
date: 2026-08-14
owners:
  - codex:/root
---

# WUI3-06 — Explicit commit summary paths

## Decision

Commit summary is advisory text derived only from the exact current Staged
Changes projection. It never commits, stages, unstages, pushes or mutates source.
The WebUI exposes two visibly different paths.

The deterministic path is a bounded server projection of staged file statuses,
safe display paths and exact available line counts. It reads no source text,
creates no Pi message/provider call and consumes zero model tokens. Its
`summaryRef` binds task/index revisions and all projected file refs/revisions.
Protected or redacted files contribute only aggregate counts, never names.

The optional model path is not a hidden utility call. After an explicit dialog
states that the action starts one Pi operation and consumes tokens under the
current model/thinking setting, the browser sends one ordinary `chat.send`
command to the same-session bridge. The message contains only the deterministic
summary and its index revision, not source/diff text or UI state. The assistant
result appears in Chat; the source panel claims only that the request was sent.

## Capability and stale behavior

The deterministic generator capability is available for an active task, while
the selected Staged view enables its button only for a current non-empty staged
projection with exact task/index revision. Model rewrite additionally requires
current-session new-operation chat authority. An index change invalidates the
projection and disables stale use. Refreshing or copying deterministic text is
zero-turn; only the confirmed model action can create model work.

## Acceptance conditions

1. Stable staged facts yield one schema-valid bounded deterministic summary.
2. No unstaged/untracked/source content enters either summary path.
3. Protected and secret-bearing metadata is aggregated or redacted.
4. Deterministic generate/copy consumes zero provider turns and messages.
5. Model rewrite is labelled before confirmation and sends exactly one ordinary
   current-session chat operation.
6. Stale index/task/session authority rejects without sending model work.
7. No path performs commit, push, stage, unstage or source mutation.
8. Chromium proves both visible paths and the explicit token warning.

## Gate evidence

- Schema/projection tests prove deterministic stability, staged-only input,
  protected-name omission, secret metadata redaction, bounded output and zero
  model turns.
- Authenticated read-route tests bind the projection to current task/index facts
  and reject query/path smuggling.
- Real Chromium passed 8/8: it generated the 0-token summary, displayed the
  explicit model-operation/token warning and sent exactly one ordinary Chat
  request containing no staged source text.
- WebUI/root TypeScript, 16 generated contracts, schema/security/package suites,
  architecture (310 files), diff hygiene and full `verify-local` all passed.
- Final full verifier result: `PASS: piagent-platform scaffold is complete`.

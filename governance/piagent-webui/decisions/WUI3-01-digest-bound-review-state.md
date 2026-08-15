---
decision_id: WUI3-01
title: Digest-bound reviewed and unreviewed state
status: accepted
date: 2026-08-14
owners:
  - codex:/root
---

# WUI3-01 — Digest-bound reviewed and unreviewed state

## Decision

`Reviewed` is an operator acknowledgement of one exact, currently rendered
file diff. It is not Git staging, source acceptance, verifier evidence or task
completion evidence.

The review target is the canonical tuple:

```text
taskId + taskRunId
+ view (task | working-tree | staged)
+ fileRef + diffRef
+ taskRevision + workspaceRevision + indexRevision
+ viewRevision + fileRevision
+ baseDigest + currentDigest
+ patchPreimage
```

`diffRef`, `contentDigest` and `patchPreimage` are deterministic SHA-256
bindings over that tuple. The runtime derives them from the current canonical
source/diff projection; browser-provided values are only preconditions.

## Authority and stale semantics

- The current Pi runtime is the only writer.
- The browser sends `review.mark` with the exact task/session identity, source
  view, file/diff references and revisions it observed.
- The runtime recomputes the target immediately before recording the mark.
- A mismatch returns a rejected stale receipt and writes no review evidence.
- A prior `reviewed` record is `stale` as soon as any target field changes.
- An explicit `unreviewed` record applies only to the exact target it names.
- A file with no matching record is `unreviewed`; it is never inferred as
  reviewed from chat, Git status, task progress or model text.
- Review is unavailable for protected, unavailable, conflicted, binary,
  truncated or redacted diffs because the operator did not receive the full
  exact text target.

The read projection has four states:

```text
reviewed | unreviewed | stale | unavailable
```

`stale` exposes only opaque references and digests. It does not expose old
paths, old diff text or protected content.

## Storage

Review evidence is local, owner-only and bounded under the existing task-run
source-evidence root. Each record is immutable, integrity-digested and contains
no file content, diff lines or raw session ID. The ledger is fail-closed:

- any corrupt record makes review projection/control unavailable for that run;
- a quota-exhausted or unwritable ledger rejects the mark;
- runtime/session replacement invalidates outstanding browser commands through
  the normal identity and revision checks;
- ledger read/write failure never interrupts Pi terminal execution.

Initial limits are 2,000 records per task run and 64 KiB per record. Retention
follows the task baseline manifest. Missing or expired baseline evidence makes
review state unavailable rather than silently starting a second truth store.

## Wire and UI contract

- Add `review-state-v1` as a selected-file read projection.
- `review.mark.payload.view` is mandatory; `fileRef` alone is not unique across
  the three source tabs.
- `review.mark` may settle as `reviewed` or `unreviewed`.
- The UI shows the state next to the selected diff and offers explicit
  `Mark reviewed` / `Mark unreviewed` actions only when the exact target is
  current and the capability is advertised.
- Refreshing, reading review state, or marking/unmarking review consumes zero
  model turns and never changes Git/index/source content.

## Deferred work

WUI3-01 does not stage, unstage, apply hunks, revert files, open an editor,
generate a model summary, commit, push or claim verifier success. Those remain
separate guarded work items.

## Acceptance conditions

1. Review in one source tab cannot satisfy another tab.
2. Any file/diff/preimage change makes the prior review stale.
3. Stale, foreign-session, taskless and malformed commands write no evidence.
4. Retry with the same command/idempotency key returns the durable receipt and
   does not append a second record.
5. Corrupt, symlinked, oversized or quota-exhausted evidence fails closed.
6. No protected path/content, raw diff text or raw session ID is persisted.
7. Review/unreview and all review reads make zero provider/model calls.

## Gate evidence

Accepted on 2026-08-14.

- Strict wire, authority, source, server, package and security suites: 101/101
  after synchronizing the human and machine threat-model asset IDs.
- Focused review/security rerun: 10/10.
- Real Chromium WebUI suite: 6/6, including mark, unmark and automatic stale
  state after an external file change.
- WebUI TypeScript, production build and 13 generated browser contracts pass.
- Root TypeScript, architecture (289 source files), docs and capability catalog
  checks pass.
- The review controller is exercised through the zero-model-turn conformance
  harness: provider requests, messages, tokens, continuation, prompt, tool
  schema, task contract, journal and Git/source bytes remain unchanged.

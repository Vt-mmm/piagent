---
decision_id: WUI3-02
title: Guarded file stage and unstage
status: accepted
date: 2026-08-14
owners:
  - codex:/root
---

# WUI3-02 — Guarded file stage and unstage

## Decision

`Stage file` and `Unstage file` are explicit Git-index mutations over one
server-resolved opaque `fileRef`. They are separate from `Reviewed`, never run
automatically, and never commit, push, revert worktree content or claim verifier
success.

WUI3-02 supports whole-file actions only:

- `source.stage` resolves the selected file from the current `working-tree`
  projection and copies exactly that file state into a new index image;
- `source.unstage` resolves it from the current `staged` projection and restores
  exactly that index entry to `HEAD`, or removes an added entry when `HEAD` is
  unborn or the path is newly added;
- rename actions bind both old and new aliases as one target;
- `hunkRefs` must be empty until WUI3-03 supplies a proven patch-CAS engine.

The browser never sends a path, repository root or Git command. The runtime
resolves `fileRef`, effective protected-path policy and repository identity from
the canonical source projection.

## Preview and preconditions

Before enabling either action, the server produces a bounded mutation preview
bound to:

```text
runtime/session + task/run
+ action + source view + repoRef + fileRef + diffRef
+ task/workspace/index/view/file revisions
+ selected workspace carrier preimage
+ exact index preimage
+ patch preimage/content digest
+ old/new safe path aliases and Git status
```

`workspacePreimage` is the current selected-path carrier, not a global worktree
lock: unrelated human edits remain possible. `indexPreimage` binds the entire
index because replacing an index image must preserve every unrelated staged
entry. Any mismatch rejects without mutation and tells the browser to refresh.

The selected diff must be current, complete, unredacted, untruncated, conflict
free and allowed by protected-path policy. WUI3-02 initially enables exact text
files; binary/symlink/submodule and incomplete previews remain unavailable.

## Index transaction

The Pi guard remains the sole executor. The WebUI controller cannot call a Git
mutation primitive directly: it must use the guard-owned, exact-session broker.
If that broker is absent, replaced, paused, terminal, non-idle or fails its
protected-path recheck, the capability and preview stay unavailable. A file
action uses a bounded, file-scoped index transaction:

1. validate the closed command, identity, capability, task and all preview CAS;
2. acquire the repository index lock with exclusive creation;
3. re-read and compare the exact index preimage under the lock;
4. build a private temporary index from the current index; Stage hashes exact
   regular-file bytes with `hash-object --no-filters` and writes bounded
   `update-index --index-info` input, while Unstage uses file-scoped
   restore/remove semantics; no shell, clean filter, hooks, pager, external
   diff/textconv or recursive submodules may run;
5. revalidate the selected workspace carrier and preview before commit;
6. atomically replace the index, fsync where supported, release the lock, then
   verify the post-state;
7. append bounded owner-only before/after audit evidence and emit a receipt.

If the process fails before the atomic replace, the real index is unchanged.
An existing lock, malformed/corrupt index, Git race, protected path, changed
worktree target, disk failure or postcondition ambiguity fails closed. Cleanup
never removes a lock that this transaction did not create.

## UI

The selected diff shows a plain-language preview:

- `Stage file` — “Prepare this exact file change for commit.”
- `Unstage file` — “Remove this exact file change from the commit area; keep the
  working file unchanged.”

The click is the explicit operator action; there is no background staging and
no extra model turn. While pending, the action is disabled. A settled receipt
refreshes all three source tabs, review state and verifier freshness. A stale or
failed receipt preserves the current selection and displays the reason.

## Evidence and invalidation

Mutation evidence contains opaque refs, action, safe display aliases, before/
after revisions and digests, result and timestamps. It never stores file bytes,
diff text, raw session ID, absolute path or secret-bearing Git stderr.

Successful stage/unstage changes index truth, so all source projections refresh.
Review acknowledgement for the staged and working-tree target becomes stale by
normal target comparison. Verifier evidence whose tree digest is still current
is not falsely invalidated merely because the index changed; the UI recomputes
freshness from canonical evidence.

## Acceptance conditions

1. A stale, cross-view, foreign-session or malformed command cannot mutate the
   index.
2. A successful file action changes only the intended index entries; worktree
   bytes and unrelated staged entries remain byte-for-byte unchanged.
3. A rename binds both aliases; conflicts and protected/internal paths fail
   closed before content or index mutation.
4. Concurrent index mutation is rejected under an exclusive transaction; a
   concurrent human worktree edit is preserved and never overwritten.
5. Crash/disk/Git failure before commit leaves the original index intact;
   ambiguous post-state is reported, never claimed successful.
6. Retry with the same command/idempotency key cannot repeat the mutation.
7. Preview, stage and unstage consume zero provider/model turns and do not alter
   task journal, prompt or provider-visible tool schema.
8. No auto-stage, commit, push, broad reset/checkout or hunk mutation exists in
   WUI3-02.
9. Removing the guard binding disables Stage/Unstage and no browser/controller
   fallback can mutate Git; repository clean filters are not executed by the
   mutation transaction.

## Gate evidence

Accepted on 2026-08-14.

- Exact source/index/guard tests: 30/30, including whole-file Stage/Unstage,
  stale workspace and whole-index preimages, foreign index lock, rename aliases,
  protected-path denial, unrelated staged-entry preservation and refusal to run
  repository clean filters.
- Package and machine/human security-contract tests: 16/16.
- The real Chromium flow stages and unstages the selected file, keeps worktree
  bytes unchanged and leaves no staged delta after Unstage.
- WebUI and root TypeScript, production bundle, 14 generated contracts and the
  298-file architecture boundary/line-budget check pass.
- The controller runs through the zero-model-turn harness with unchanged model,
  message, continuation, prompt, tool-schema, Task Contract and journal facts.
- Capability advertisement and execution require the exact live Pi guard
  binding; binding removal, terminal/non-idle task state or protected-path
  recheck failure cannot fall back to direct Git mutation.

---
decision_id: WUI3-03
title: Selected-hunk patch CAS
status: accepted
date: 2026-08-14
owners:
  - codex:/root
---

# WUI3-03 — Selected-hunk patch CAS

## Decision

WUI3-03 extends `source.stage` and `source.unstage` with an optional non-empty
`hunkRefs` selection. An empty selection retains WUI3-02 whole-file semantics.
The browser never supplies patch text, line content, path, Git argv or index
entry data.

Initial hunk mutation is deliberately narrow:

- source status is `M` with one exact safe path and no rename alias;
- content and diff are exact text, complete, unredacted and untruncated;
- at most 128 current hunk refs are advertised, and a command selects at most
  128 unique advertised refs;
- add/delete/untracked/rename/conflict/binary/symlink/submodule remain
  whole-file-only.

## Authority and patch derivation

The mutation preview binds the existing WUI3-02 task/workspace/index/view/file
revisions and preimages plus the ordered current hunk-ref set. The command action
digest binds the selected refs. The Pi runtime recomputes the current exact Git
patch and the server-issued refs; a missing, reordered, foreign or stale ref is
rejected before mutation.

Raw patch bytes are runtime-only authority. They never enter browser JSON,
owner evidence, logs or model context. The Pi guard receives a bounded patch
header and exact hunk blocks resolved from the canonical diff. It constructs a
new patch containing only the selected blocks.

## Guarded transaction

Under the WUI3-02 guard binding and exclusive index lock:

1. recheck exact session/task/control authority and protected-path policy;
2. compare the selected-workspace and whole-index preimages;
3. copy the current index to a private temporary index;
4. apply the selected canonical patch to the temporary index (`--cached`) for
   Stage, or apply its exact reverse for Unstage;
5. disable repository filters/hooks/pager/external diff/submodules and bound
   patch bytes, Git output and execution time;
6. recheck authority, workspace and real-index preimages before atomic replace;
7. verify the post-index changed while worktree bytes remained identical;
8. persist the same bounded requested/terminal evidence used by WUI3-02.

A rejected pre-commit effect returns a durable rejected receipt; only ambiguity
after atomic replace returns `uncertain`. Retry cannot repeat a settled or
rejected command.

## UI

Each eligible diff hunk exposes `Stage hunk` or `Unstage hunk`. The whole-file
action remains separate and explicit. While a command is pending all mutation
buttons for that selected file are disabled. A successful receipt refreshes all
three source views; a stale/rejected receipt keeps the diff visible and asks the
operator to refresh.

## Acceptance conditions

1. Selecting one of two hunks changes only that hunk in the index; worktree and
   unrelated staged entries remain unchanged.
2. Unstaging one staged hunk keeps other staged hunks intact.
3. Unknown, duplicate, cross-file, stale or reordered refs cannot mutate.
4. Rename/add/delete/untracked and incomplete/redacted diffs advertise no hunk
   mutation capability.
5. No repository clean filter, hook, external diff, pager or shell is executed.
6. Guard absence/replacement, terminal/non-idle Task, protected path, index lock
   or preimage race fails closed.
7. Hunk preview, Stage and Unstage consume zero model turns.
8. Patch bytes and changed line content never enter mutation evidence.

## Gate evidence

Accepted on 2026-08-14.

- Focused source/index/guard/controller coverage proves whole-file compatibility,
  one-of-two-hunk Stage, one-of-two-hunk Unstage, no-final-newline fidelity,
  stale workspace/index rejection, foreign index lock, protected paths, rename
  fallback, clean-filter refusal and unchanged worktree/unrelated index bytes.
- Unknown, duplicate and reordered refs reject before index mutation. Browser,
  controller and guard each validate their boundary; the Pi guard remains the
  final authority.
- A pre-commit index-lock failure persists requested + rejected evidence. Retry
  deduplicates that receipt without re-entering the mutation executor.
- Mutation evidence contains only opaque selected refs and digests; raw patch
  bytes and changed line content are absent.
- The production Chromium flow stages one of two hunks, stages the remainder,
  then unstages one hunk while preserving the other staged hunk and worktree.
- WebUI/root TypeScript, generated contract drift, production build, security/
  package suites and the architecture line/boundary gate pass. Preview and
  mutations pass the existing zero-model-turn harness.
- The repository-wide `verify-local` gate exits zero after 2,264 Node tests,
  capability-lock regeneration, package checks, TypeScript, architecture,
  catalogs and project doctors; the complete Chromium suite passes 8/8.
